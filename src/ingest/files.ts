/**
 * Inkstone — File Ingestion Pipeline
 *
 * Walks workspace tree, detects new/modified files via content hash,
 * ingests into wiki + DB with optional Gemma 4 LLM enrichment.
 * Change-tracked via .file-manifest.json so only deltas are processed.
 */

import {
  readdirSync, statSync, writeFileSync, mkdirSync, existsSync, readFileSync,
} from "node:fs";
import { join, relative, extname, basename, dirname } from "node:path";
import { LLMClient } from "../llm/client.js";
import {
  hashContent, WIKI_DIR, ensureDir, detectDomain, detectMemoryType,
  FILE_INGEST_EXCLUDE_DIRS, FILE_INGEST_EXCLUDE_EXTENSIONS,
  OLLAMA_CHAT_MODEL, computeSpecificityScore, CHUNK_SIZE_LINES,
  getHalfLife,
} from "../config.js";
import type { Database as SqlJsDatabase } from "../db/schema.js";
import { initDb, closeDb, saveDb } from "../db/schema.js";
import { indexChunk } from "../db/fts.js";
import { randomUUID } from "node:crypto";

const MANIFEST_PATH = join(WIKI_DIR, ".file-manifest.json");

interface ManifestEntry {
  hash: string;
  mtime: string;
  lastIngested: string;
}

interface FileIngestResult {
  scanned: number;
  ingested: number;
  skipped: number;
  enriched: number;
  errors: string[];
}

const ENRICHMENT_PROMPT = `You are a knowledge distiller. Analyze this file and extract structured, reusable knowledge as a wiki entry.

CRITICAL RULES:
- Preserve EXACT values: file paths, command names, error messages, IDs, model names, config keys, URLs, version numbers.
- BAD: "they have a shipping process" → GOOD: "Shipping via FedEx Ground, tracked in ERP system, warehouse: Newark NJ"
- Include relationships to other projects, brands, or systems mentioned.
- If the file contains decisions, list them with reasoning.
- If the file contains contacts or leads, preserve all details.

Return a markdown wiki entry with these sections (omit empty sections):

## Summary
2-5 dense sentences: what this file contains, its purpose, key facts.

## Key Facts
Numbered list of specific, verifiable facts with exact values.

## Entities Mentioned
List of people, companies, tools, or projects referenced (with details).

## Decisions
- Decision — Reason — Context

## Relationships
How this content connects to other business areas, projects, or systems.`;

function loadManifest(): Map<string, ManifestEntry> {
  try {
    if (!existsSync(MANIFEST_PATH)) return new Map();
    const data = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
    const map = new Map<string, ManifestEntry>();
    for (const [k, v] of Object.entries(data.entries || {})) {
      map.set(k, v as ManifestEntry);
    }
    return map;
  } catch {
    return new Map();
  }
}

function saveManifest(manifest: Map<string, ManifestEntry>): void {
  ensureDir(WIKI_DIR);
  const entries: Record<string, ManifestEntry> = {};
  for (const [k, v] of manifest) {
    entries[k] = v;
  }
  writeFileSync(MANIFEST_PATH, JSON.stringify({
    entries,
    updatedAt: new Date().toISOString(),
    totalEntries: manifest.size,
  }, null, 2));
}

function shouldExcludeDir(dirName: string): boolean {
  if (dirName.startsWith(".")) return true;
  return FILE_INGEST_EXCLUDE_DIRS.has(dirName);
}

function shouldExcludeFile(fileName: string): boolean {
  if (fileName.startsWith(".")) return true;
  const ext = extname(fileName).toLowerCase();
  if (FILE_INGEST_EXCLUDE_EXTENSIONS.has(ext)) return true;
  return false;
}

function isBinary(content: string): boolean {
  for (let i = 0; i < Math.min(content.length, 8000); i++) {
    const code = content.charCodeAt(i);
    if (code === 0) return true;
    if (code < 8 && code !== 0) return true;
  }
  return false;
}

interface DiscoveredFile {
  absolutePath: string;
  relativePath: string;
  size: number;
  mtime: Date;
}

function walkFiles(rootDir: string, prefix = ""): DiscoveredFile[] {
  const results: DiscoveredFile[] = [];
  let entries;
  try {
    entries = readdirSync(join(rootDir, prefix), { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = join(rootDir, prefix, entry.name);
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      if (shouldExcludeDir(entry.name)) continue;
      results.push(...walkFiles(rootDir, relPath));
    } else if (entry.isFile()) {
      if (shouldExcludeFile(entry.name)) continue;
      try {
        const stat = statSync(fullPath);
        if (stat.size > 2_000_000) continue;
        results.push({
          absolutePath: fullPath,
          relativePath: relPath,
          size: stat.size,
          mtime: stat.mtime,
        });
      } catch { /* skip unreadable */ }
    }
  }

  return results;
}

function pathToNamespace(relPath: string): string {
  const parts = relPath.split("/");

  if (parts[0] === "businesses" && parts.length >= 2) {
    if (parts.length === 2) return `/business/workspace`;
    const businessDir = parts[1];
    if (parts.length === 3) return `/business/${businessDir}/${parts[2].replace(/\.[^.]+$/, "")}`;
    const subPath = parts.slice(2, -1).join("/");
    return `/business/${businessDir}/${subPath}`;
  }

  if (parts[0] === "memory") return `/system/memory`;
  if (parts[0] === "agents") return `/system/agents`;
  if (parts[0] === "scripts") return `/system/scripts`;
  if (parts[0] === "wiki") return `/system/wiki`;

  const fileName = parts[parts.length - 1];
  if (fileName === "tasks.md") return `/system/operations`;
  if (fileName === "AGENTS.md" || fileName === "SOUL.md" || fileName === "IDENTITY.md"
    || fileName === "TOOLS.md" || fileName === "ORG.md" || fileName === "USER.md"
    || fileName === "MEMORY.md" || fileName === "HEARTBEAT.md") return `/system/workspace`;

  return `/workspace`;
}

function pathToSourceTrust(relPath: string): string {
  const fileName = basename(relPath);
  if (fileName === "evergreen.md") return "evergreen";
  if (relPath.startsWith("data/") || relPath.startsWith("businesses/")) return "business";
  if (relPath.startsWith("memory/")) return "memory";
  if (fileName === "tasks.md") return "tasks";
  return "summary";
}

function pathToWikiPagePath(relPath: string): string {
  const ns = pathToNamespace(relPath);
  const sanitized = ns.replace(/^\//, "").replace(/\//g, "--");
  return join(WIKI_DIR, "business", `${sanitized}.md`);
}

function formatWikiFilePage(
  relPath: string,
  content: string,
  enrichment: string | null,
  hash: string,
): string {
  const now = new Date().toISOString();
  const namespace = pathToNamespace(relPath);
  const source = pathToSourceTrust(relPath);
  const domain = detectDomain(content);

  return `---
title: ${relPath}
created: ${now}
updated: ${now}
type: file-ingestion
source: ${source}
domain: ${domain}
namespace: ${namespace}
hash: ${hash}
model: ${OLLAMA_CHAT_MODEL}
source_path: ${relPath}
---

${enrichment || ""}
`;
}

function chunkFileContent(content: string, chunkSize = CHUNK_SIZE_LINES): string[] {
  const lines = content.split("\n");
  if (lines.length <= chunkSize) return [content];

  const chunks: string[] = [];
  for (let i = 0; i < lines.length; i += chunkSize) {
    const chunk = lines.slice(i, i + chunkSize).join("\n");
    if (chunk.trim().length > 0) chunks.push(chunk);
  }
  return chunks;
}

function writeChunkBulk(db: SqlJsDatabase, opts: {
  text: string;
  path: string;
  namespace: string;
  source: string;
  confidence: number;
}): string | null {
  const { text, path, namespace, source, confidence } = opts;
  const knowledgeType = detectMemoryType(text);
  const halfLife = getHalfLife(knowledgeType);
  const id = randomUUID();
  const now = new Date().toISOString();

  try {
    db.prepare(
      `INSERT INTO chunks (id, path, source, namespace, knowledge_type, lifecycle,
                           text, half_life_days, confidence, valid_from, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
    ).run(id, path, source, namespace, knowledgeType, text, halfLife, confidence, now, now, now);
  } catch {
    return null;
  }

  try {
    db.prepare(
      `INSERT INTO memory_decay (chunk_id, decay_score, access_count, last_access, created_at)
       VALUES (?, 1.0, 0, ?, ?)`,
    ).run(id, now, now);
  } catch { /* already exists */ }

  indexChunk(db, id, text);
  return id;
}

function escapeLike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function linkNewChunks(
  db: SqlJsDatabase,
  newChunkIds: string[],
  enrichment: string | null,
): number {
  if (!enrichment || newChunkIds.length === 0) return 0;
  const wikiLinkRe = /\[\[([^\]]+)\]\]/g;
  const entities = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = wikiLinkRe.exec(enrichment)) !== null) {
    const e = m[1].toLowerCase().trim();
    if (e.length >= 2) entities.add(e);
  }
  if (entities.size === 0) return 0;

  let edgesCreated = 0;
  for (const entity of entities) {
    const existingRows = db.prepare(`
      SELECT id FROM chunks
      WHERE text LIKE '%[[${escapeLike(entity)}]]%' ESCAPE '\\'
        AND lifecycle NOT IN ('archived') AND valid_to IS NULL
    `).all() as Record<string, unknown>[];

    const existingIds = existingRows
      .map((row) => String(row.id))
      .filter((id) => !newChunkIds.includes(id));

    if (existingIds.length === 0) continue;

    for (const fromId of newChunkIds) {
      for (const toId of existingIds) {
        const a = fromId < toId ? fromId : toId;
        const b = fromId < toId ? toId : fromId;
        const edgeId = `edge:entity:${a}:${b}`;
        try {
          db.prepare(
            "INSERT OR IGNORE INTO memory_relations (id, from_chunk_id, to_chunk_id, relation_type, weight) VALUES (?, ?, ?, 'related_by_entity', ?)",
          ).run(edgeId, a, b, 1.0);
          edgesCreated++;
        } catch { /* ignore */ }
      }
    }
  }
  return edgesCreated;
}

export interface FileIngestOptions {
  rootDir: string;
  dryRun?: boolean;
  force?: boolean;
  noLLM?: boolean;
  limit?: number;
  skipEnriched?: boolean;
}

function isWikiPageEnriched(relPath: string): boolean {
  const wikiPath = pathToWikiPagePath(relPath);
  if (!existsSync(wikiPath)) return false;
  try {
    const content = readFileSync(wikiPath, "utf-8");
    const enrichmentIdx = content.indexOf("## Enrichment");
    if (enrichmentIdx === -1) {
      const rawIdx = content.indexOf("## Raw Content");
      if (rawIdx === -1) return false;
      const before = content.substring(0, rawIdx);
      const lines = before.split("\n").filter(l => l.trim() && !l.startsWith("---") && !l.startsWith("title:") && !l.startsWith("created:") && !l.startsWith("updated:") && !l.startsWith("type:") && !l.startsWith("source:") && !l.startsWith("domain:") && !l.startsWith("namespace:") && !l.startsWith("hash:") && !l.startsWith("model:"));
      return lines.length > 3;
    }
    const afterEnrichment = content.substring(enrichmentIdx);
    const nextSection = afterEnrichment.indexOf("\n## ", 1);
    const section = nextSection > 0 ? afterEnrichment.substring(0, nextSection) : afterEnrichment;
    const lines = section.split("\n").filter(l => l.trim() && !l.startsWith("##"));
    return lines.length > 3;
  } catch {
    return false;
  }
}

const FLUSH_INTERVAL = 20;
const LLM_CONCURRENCY = 5;

async function enrichFile(
  llm: LLMClient,
  relPath: string,
  content: string,
): Promise<{ enrichment: string | null; enriched: boolean }> {
  if (content.length < 100) return { enrichment: null, enriched: false };
  try {
    const response = await llm.chat([
      { role: "system", content: ENRICHMENT_PROMPT },
      { role: "user", content: content.slice(0, 60000) },
    ]);
    const specificity = computeSpecificityScore(response.text);
    if (specificity >= 0.2) {
      return { enrichment: response.text, enriched: true };
    }
    return { enrichment: null, enriched: false };
  } catch (err) {
    console.log(`    ⚠ LLM enrichment failed for ${relPath}: ${err}`);
    return { enrichment: null, enriched: false };
  }
}

async function parallelEnrich(
  llm: LLMClient,
  batch: Array<{ relPath: string; content: string }>,
): Promise<Array<{ relPath: string; enrichment: string | null; enriched: boolean }>> {
  const results: Array<{ relPath: string; enrichment: string | null; enriched: boolean }> = [];
  const queue = [...batch];

  const workers = Array.from({ length: Math.min(LLM_CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      const result = await enrichFile(llm, item.relPath, item.content);
      results.push({ relPath: item.relPath, ...result });
    }
  });

  await Promise.all(workers);
  return results;
}

interface QueuedFile {
  file: DiscoveredFile;
  content: string;
  hash: string;
}

export async function ingestFiles(
  db: SqlJsDatabase,
  opts: FileIngestOptions,
): Promise<FileIngestResult> {
  const { rootDir, dryRun = false, force = false, noLLM = false, limit, skipEnriched = false } = opts;
  const manifest = loadManifest();
  const errors: string[] = [];
  let scanned = 0;
  let ingested = 0;
  let skipped = 0;
  let enriched = 0;
  let filesSinceLastFlush = 0;

  const llm = noLLM ? null : new LLMClient();

  ensureDir(join(WIKI_DIR, "business"));

  console.log(`Scanning ${rootDir} for files to ingest...`);
  const files = walkFiles(rootDir);
  console.log(`Found ${files.length} candidate files${limit ? ` (limit: ${limit})` : ""}`);

  const toIngest: QueuedFile[] = [];

  for (const file of files) {
    if (limit && toIngest.length >= limit) {
      console.log(`  Limit reached (${limit}), stopping. ${files.length - scanned} files remaining.`);
      break;
    }
    scanned++;

    try {
      let content: string;
      try {
        content = readFileSync(file.absolutePath, "utf-8");
      } catch {
        skipped++;
        continue;
      }

      if (content.trim().length < 10) {
        skipped++;
        continue;
      }

      if (isBinary(content)) {
        skipped++;
        continue;
      }

      const h = hashContent(content);
      const existing = manifest.get(file.relativePath);

      if (!force && existing && existing.hash === h) {
        skipped++;
        continue;
      }

      if (skipEnriched && existing && existing.hash !== h) {
        const wikiPath = pathToWikiPagePath(file.relativePath);
        if (existsSync(wikiPath)) {
          const wikiContent = readFileSync(wikiPath, "utf-8");
          if (wikiContent.includes("## Summary") || wikiContent.includes("## Key Facts")) {
            skipped++;
            continue;
          }
        }
      }

      if (dryRun) {
        console.log(`  [DRY RUN] ${file.relativePath} (${content.length} chars, ns: ${pathToNamespace(file.relativePath)})`);
        ingested++;
        toIngest.push({ file, content, hash: h });
        continue;
      }

      toIngest.push({ file, content, hash: h });
    } catch (err) {
      const msg = `${file.relativePath}: ${err}`;
      console.error(`    ✗ ${msg}`);
      errors.push(msg);
    }
  }

  console.log(`  ${toIngest.length} files to ingest, ${skipped} skipped`);

  if (dryRun) {
    saveManifest(manifest);
    return { scanned, ingested, skipped, enriched, errors };
  }

  if (llm && toIngest.length > 0) {
    console.log(`  Enriching ${toIngest.length} files (concurrency: ${LLM_CONCURRENCY})...`);
    const batch: Array<{ relPath: string; content: string }> = toIngest.map((q) => ({
      relPath: q.file.relativePath,
      content: q.content,
    }));
    const enrichmentResults = await parallelEnrich(llm, batch);
    const enrichmentMap = new Map(enrichmentResults.map((r) => [r.relPath, r]));

    for (const q of toIngest) {
      try {
        const er = enrichmentMap.get(q.file.relativePath);
        const enrichment = er?.enrichment ?? null;
        if (er?.enriched) enriched++;

        console.log(`  → Ingesting: ${q.file.relativePath} (${q.content.length} chars)${enrichment ? " +enriched" : ""}`);

        const wikiPagePath = pathToWikiPagePath(q.file.relativePath);
        ensureDir(dirname(wikiPagePath));
        const wikiContent = formatWikiFilePage(q.file.relativePath, q.content, enrichment, q.hash);
        writeFileSync(wikiPagePath, wikiContent, "utf-8");

        const namespace = pathToNamespace(q.file.relativePath);
        const sourceTrust = pathToSourceTrust(q.file.relativePath);
        const chunks = chunkFileContent(q.content);

        const newChunkIds: string[] = [];
        for (let i = 0; i < chunks.length; i++) {
          const chunkPath = `${q.file.relativePath}::${i}`;
          const id = writeChunkBulk(db, {
            text: chunks[i],
            path: chunkPath,
            namespace,
            source: sourceTrust,
            confidence: sourceTrust === "evergreen" ? 1.0 : 0.9,
          });
          if (id) newChunkIds.push(id);
        }

        const links = linkNewChunks(db, newChunkIds, enrichment);
        if (links > 0) console.log(`    → Created ${links} entity edges`);

        manifest.set(q.file.relativePath, {
          hash: q.hash,
          mtime: q.file.mtime.toISOString(),
          lastIngested: new Date().toISOString(),
        });

        ingested++;
        filesSinceLastFlush++;

        if (filesSinceLastFlush >= FLUSH_INTERVAL) {
          saveDb(db, true);
          saveManifest(manifest);
          filesSinceLastFlush = 0;
        }
      } catch (err) {
        const msg = `${q.file.relativePath}: ${err}`;
        console.error(`    ✗ ${msg}`);
        errors.push(msg);
      }
    }
  } else {
    for (const q of toIngest) {
      try {
        console.log(`  → Ingesting: ${q.file.relativePath} (${q.content.length} chars)`);

        const wikiPagePath = pathToWikiPagePath(q.file.relativePath);
        ensureDir(dirname(wikiPagePath));
        const wikiContent = formatWikiFilePage(q.file.relativePath, q.content, null, q.hash);
        writeFileSync(wikiPagePath, wikiContent, "utf-8");

        const namespace = pathToNamespace(q.file.relativePath);
        const sourceTrust = pathToSourceTrust(q.file.relativePath);
        const chunks = chunkFileContent(q.content);

        const newChunkIds: string[] = [];
        for (let i = 0; i < chunks.length; i++) {
          const chunkPath = `${q.file.relativePath}::${i}`;
          const id = writeChunkBulk(db, {
            text: chunks[i],
            path: chunkPath,
            namespace,
            source: sourceTrust,
            confidence: sourceTrust === "evergreen" ? 1.0 : 0.9,
          });
          if (id) newChunkIds.push(id);
        }

        const links = linkNewChunks(db, newChunkIds, null);
        if (links > 0) console.log(`    → Created ${links} entity edges`);

        manifest.set(q.file.relativePath, {
          hash: q.hash,
          mtime: q.file.mtime.toISOString(),
          lastIngested: new Date().toISOString(),
        });

        ingested++;
        filesSinceLastFlush++;

        if (filesSinceLastFlush >= FLUSH_INTERVAL) {
          saveDb(db, true);
          saveManifest(manifest);
          filesSinceLastFlush = 0;
        }
      } catch (err) {
        const msg = `${q.file.relativePath}: ${err}`;
        console.error(`    ✗ ${msg}`);
        errors.push(msg);
      }
    }
  }

  if (filesSinceLastFlush > 0) {
    saveDb(db, true);
  }
  saveManifest(manifest);

  return { scanned, ingested, skipped, enriched, errors };
}
