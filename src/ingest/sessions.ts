/**
 * Inkstone — Session Ingestion Pipeline
 *
 * Reads session JSONL files, summarizes whole sessions via Ollama Gemma 4
 * (local, no chunking), and writes standalone wiki entity markdown files.
 * The wiki indexer (`inkstone index`) then picks them up naturally.
 */

import { createReadStream, readdirSync, statSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { basename, resolve, join } from "node:path";
import { LLMClient } from "../llm/client.js";
import { computeSpecificityScore, detectDomain, hashContent, WIKI_DIR, ensureDir } from "../config.js";
import { OLLAMA_CHAT_MODEL } from "../config.js";

const WIKI_ENTITIES_DIR = join(WIKI_DIR, "entities");
const MANIFEST_PATH = join(WIKI_DIR, ".ingest-manifest.json");

const SESSION_DIRS = process.env.INKSTONE_SESSION_DIRS
  ? process.env.INKSTONE_SESSION_DIRS.split(",")
  : [
      `${process.env.HOME || "/tmp"}/.hermes/sessions`,
      `${process.env.HOME || "/tmp"}/.opencode/sessions`,
      `${process.env.HOME || "/tmp"}/.inkstone/sessions`,
    ];

interface SessionEntry {
  role: "user" | "assistant" | "tool" | "system" | "session_meta" | string;
  content?: string;
  reasoning?: string;
  timestamp?: string;
}

function isNoise(entry: SessionEntry): boolean {
  if (!entry.content || entry.content.length < 3) return true;
  const skipRoles = new Set(["session_meta", "tool", "system", "context_compaction"]);
  if (skipRoles.has(entry.role)) return true;
  if (entry.content.startsWith("[CONTEXT COMPACTION")) return true;
  if (entry.content.startsWith("Summary generation was unavailable")) return true;
  return false;
}

function extractSpeaker(content: string): { speaker: string; text: string } {
  const match = content.match(/^\[([^\]]+)\]\s*(.*)/s);
  if (match) return { speaker: match[1], text: match[2] };
  return { speaker: "unknown", text: content };
}

async function* readJsonl(filePath: string): AsyncGenerator<SessionEntry> {
  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed) as SessionEntry;
    } catch { /* skip malformed */ }
  }
}

function extractSessionText(entries: SessionEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (isNoise(entry)) continue;
    const { speaker, text } = extractSpeaker(entry.content!);
    lines.push(`${speaker}: ${text}`);
  }
  return lines.join("\n");
}

const SUMMARY_PROMPT = `You are a knowledge distiller. Extract lasting, reusable knowledge from a conversation session as a standalone wiki entry — NOT a session log.

CRITICAL RULES:
- Preserve EXACT values: file paths, command names, error messages, IDs, model names, config keys, URLs, version numbers.
- BAD: "the cron job had errors" → GOOD: "Clawver Heartbeat cron (e0806580): 24 consecutive errors, lastStatus: error"
- BAD: "they changed a config file" → GOOD: "Added opencodezen-2 provider to openclaw.json: baseUrl https://opencode.ai/zen/v1, models: big-pickle, glm-5-free"
- Include what FAILED, not just what succeeded.
- Include contradictions found (e.g., "active-tasks.md claims RESOLVED but cron shows 36 consecutive errors").
- Attribute statements to people when it matters.

IGNORE:
- Greetings, pleasantries, tool invocation boilerplate, repeated acknowledgments

Return a markdown wiki entry with these sections. If a section has no content, omit it entirely.

## Summary
2-5 dense sentences: outcome, attempts, current state.

## Critical Findings
Numbered subsections with exact symptom, root cause, status (✅/⚠️/🔴), IDs, paths.

## Actions Taken
- ✅/⚠️/🔴 Action with exact detail

## Decisions Made
- Decision — Reason — Who

## Known Issues (Unresolved)
Exact error messages, missing deps, blockers with task IDs / file paths.

## Next Steps
1. [Owner] Action item — dependency

## Emotional Responses
- "exact words" — emotion — trigger`;

function loadManifest(): Set<string> {
  try {
    if (!existsSync(MANIFEST_PATH)) return new Set();
    const data = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
    return new Set(data.ingested || []);
  } catch {
    return new Set();
  }
}

function saveManifest(manifest: Set<string>): void {
  ensureDir(WIKI_DIR);
  writeFileSync(MANIFEST_PATH, JSON.stringify({ ingested: [...manifest], updatedAt: new Date().toISOString() }, null, 2));
}

function sessionToEntityFilename(filePath: string): string {
  const base = basename(filePath, ".jsonl");
  const sanitized = base.replace(/[^a-z0-9_-]/gi, "-").replace(/-+/g, "-").slice(0, 120);
  return `${sanitized}.md`;
}

function formatWikiEntity(sessionText: string, summary: string, filePath: string, platform: string): string {
  const now = new Date().toISOString();
  const dateMatch = basename(filePath).match(/^(\d{4})(\d{2})(\d{2})/);
  const sessionDate = dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : now.slice(0, 10);
  const domain = detectDomain(sessionText);

  return `---
title: Session ${basename(filePath, ".jsonl")}
created: ${now}
updated: ${now}
type: session-summary
platform: ${platform}
domain: ${domain}
session_date: ${sessionDate}
source: inkstone-ingest
model: ${OLLAMA_CHAT_MODEL}
---

${summary}
`;
}

export interface IngestOptions {
  daysBack?: number;
  dryRun?: boolean;
  force?: boolean;
}

export async function ingestSessions(opts: IngestOptions = {}): Promise<{
  filesProcessed: number;
  summariesWritten: number;
  skipped: number;
  errors: string[];
}> {
  const { daysBack = 1, dryRun = false, force = false } = opts;
  const since = new Date();
  since.setDate(since.getDate() - daysBack);

  const llm = new LLMClient();
  const manifest = loadManifest();
  const errors: string[] = [];
  let filesProcessed = 0;
  let summariesWritten = 0;
  let skipped = 0;

  ensureDir(WIKI_ENTITIES_DIR);

  const candidateFiles: string[] = [];
  for (const dir of SESSION_DIRS) {
    try {
      const files = readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => resolve(dir, f));
      candidateFiles.push(...files);
    } catch { /* dir doesn't exist */ }
  }

  for (const filePath of candidateFiles) {
    try {
      const stat = statSync(filePath);
      if (stat.mtime < since) continue;

      const hash = hashContent(filePath + stat.mtime.toISOString());
      if (!force && manifest.has(hash)) {
        console.log(`  ⊘ Skipping (already ingested): ${basename(filePath)}`);
        skipped++;
        continue;
      }

      console.log(`  → Processing: ${basename(filePath)}`);
      filesProcessed++;

      const entries: SessionEntry[] = [];
      for await (const entry of readJsonl(filePath)) {
        entries.push(entry);
      }

      const sessionText = extractSessionText(entries);
      if (sessionText.trim().length < 50) {
        console.log(`    ⊘ Skipped: too short (${sessionText.length} chars)`);
        skipped++;
        continue;
      }

      const platform = filePath.toLowerCase().includes("hermes") ? "hermes"
        : filePath.toLowerCase().includes("opencode") ? "opencode"
        : filePath.toLowerCase().includes("discord") ? "discord"
        : filePath.toLowerCase().includes("kimaki") ? "kimaki"
        : "unknown";

      if (dryRun) {
        console.log(`    [DRY RUN] ${basename(filePath)} → ${sessionToEntityFilename(filePath)} (${sessionText.length} chars, ${platform})`);
        continue;
      }

      const response = await llm.chat([
        { role: "system", content: SUMMARY_PROMPT },
        { role: "user", content: sessionText.slice(0, 60000) },
      ]);

      const summary = response.text;
      const specificity = computeSpecificityScore(summary);
      if (specificity < 0.3) {
        console.log(`    ⊘ Skipped low-specificity (${specificity.toFixed(2)}): ${basename(filePath)}`);
        skipped++;
        continue;
      }

      const entityFilename = sessionToEntityFilename(filePath);
      const entityPath = join(WIKI_ENTITIES_DIR, entityFilename);
      const wikiContent = formatWikiEntity(sessionText, summary, filePath, platform);

      writeFileSync(entityPath, wikiContent, "utf-8");
      manifest.add(hash);
      saveManifest(manifest);

      console.log(`    ✓ Written: ${entityFilename} (${platform}, ${response.provider}/${response.model}, specificity ${specificity.toFixed(2)})`);
      summariesWritten++;
    } catch (err) {
      const msg = `${basename(filePath)}: ${err}`;
      console.error(`    ✗ ${msg}`);
      errors.push(msg);
    }
  }

  return { filesProcessed, summariesWritten, skipped, errors };
}
