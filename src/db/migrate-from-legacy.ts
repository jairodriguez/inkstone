/**
 * Inkstone — Migration from Legacy Databases
 *
 * Migrates from hippocampus.db (Hermes plugin) and memex.sqlite (Memex project)
 * into the Inkstone unified schema.
 *
 * Usage:
 *   node dist/db/migrate-from-legacy.js --from=hippocampus --db=/path/to/hippocampus.db
 *   node dist/db/migrate-from-legacy.js --from=memex --db=/path/to/memex.sqlite
 *   node dist/db/migrate-from-legacy.js --from=hippocampus  # defaults to ~/.hermes/hippocampus.db
 */

import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { ensureDir, hashContent, detectMemoryType, DB_PATH } from "../config.js";
import { initDb, writeChunk, closeDb, saveDb } from "./schema.js";
import { indexChunk } from "./fts.js";

// ── Helpers ────────────────────────────────────────────────────────

function openSourceDb(path: string): SqlJsDatabase {
  if (!existsSync(path)) {
    console.error(`Source DB not found: ${path}`);
    process.exit(1);
  }
  const buf = readFileSync(path);
  const SQL = initSqlJs;  // loaded synchronously below
  // sql.js needs async init, but we handle it in main
  throw new Error("Use openSourceDbAsync instead");
}

async function openSourceDbAsync(path: string): Promise<SqlJsDatabase> {
  if (!existsSync(path)) {
    console.error(`Source DB not found: ${path}`);
    process.exit(1);
  }
  const SQL = await initSqlJs();
  const buf = readFileSync(path);
  return new SQL.Database(buf);
}

function queryRows(db: SqlJsDatabase, sql: string): unknown[][] {
  const result = db.exec(sql);
  if (!result[0]) return [];
  return result[0].values;
}

function queryRowObjects(db: SqlJsDatabase, sql: string): Record<string, unknown>[] {
  const result = db.exec(sql);
  if (!result[0]) return [];
  const columns = result[0].columns;
  return result[0].values.map((v: unknown[]) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((c: string, i: number) => { obj[c] = v[i]; });
    return obj;
  });
}

// ── Hippocampus Migration ──────────────────────────────────────────

interface HippocampusChunk {
  id: string;
  path: string;
  source: string;
  start_line: number;
  end_line: number;
  hash: string;
  model: string;
  text: string;
  embedding: string | null;
  updated_at: number;
}

interface HippocampusRelation {
  id: string;
  from_chunk_id: string;
  to_chunk_id: string;
  relation_type: string;
  weight: number;
  created_at: number;
}

interface HippocampusDecay {
  chunk_id: string;
  decay_score: number;
  access_count: number;
  last_access: number;
  created_at: number;
}

async function migrateHippocampus(sourcePath: string, targetDb: SqlJsDatabase): Promise<void> {
  console.log(`Migrating from hippocampus: ${sourcePath}`);

  const source = await openSourceDbAsync(sourcePath);

  // Count
  const chunkCount = queryRows(source, "SELECT COUNT(*) FROM chunks")[0][0];
  const relationCount = queryRows(source, "SELECT COUNT(*) FROM memory_relations")[0][0];
  const decayCount = queryRows(source, "SELECT COUNT(*) FROM memory_decay")[0][0];
  console.log(`  Source: ${chunkCount} chunks, ${relationCount} relations, ${decayCount} decay entries`);

  // Migrate chunks
  const chunks = queryRowObjects(source, "SELECT * FROM chunks") as unknown as HippocampusChunk[];
  let migrated = 0, skipped = 0;

  for (const chunk of chunks) {
    // Skip empty chunks
    if (!chunk.text || chunk.text.trim().length < 10) {
      skipped++;
      continue;
    }

    // Derive namespace from path
    const namespace = deriveNamespace(chunk.path, chunk.source);
    const knowledgeType = detectMemoryType(chunk.text);
    const now = new Date(chunk.updated_at * 1000).toISOString();

    try {
      targetDb.run(
        `INSERT OR IGNORE INTO chunks
         (id, path, source, namespace, knowledge_type, lifecycle,
          start_line, end_line, hash, model, text, specificity_score,
          half_life_days, confidence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, 1.0, 30, 1.0, ?, ?)`,
        [chunk.id, chunk.path, chunk.source, namespace, knowledgeType,
         chunk.start_line, chunk.end_line, chunk.hash, chunk.model || null,
         chunk.text, now, now]
      );

      // Index for FTS
      indexChunk(targetDb, chunk.id, chunk.text);

      // Ensure decay row
      try {
        targetDb.run(
          "INSERT OR IGNORE INTO memory_decay (chunk_id, decay_score, access_count, last_access, created_at) VALUES (?, 1.0, 0, ?, ?)",
          [chunk.id, now, now]
        );
      } catch { /* already exists */ }

      migrated++;
    } catch {
      skipped++;
    }
  }

  console.log(`  Chunks: ${migrated} migrated, ${skipped} skipped`);

  // Migrate decay data (overwrite defaults with actual values)
  const decays = queryRowObjects(source, "SELECT * FROM memory_decay") as unknown as HippocampusDecay[];
  let decayMigrated = 0;

  for (const decay of decays) {
    const now = new Date(decay.last_access * 1000).toISOString();
    const created = new Date(decay.created_at * 1000).toISOString();
    try {
      targetDb.run(
        "UPDATE memory_decay SET decay_score = ?, access_count = ?, last_access = ?, created_at = ? WHERE chunk_id = ?",
        [decay.decay_score, decay.access_count, now, created, decay.chunk_id]
      );
      decayMigrated++;
    } catch { /* chunk might not exist */ }
  }

  console.log(`  Decay: ${decayMigrated} entries migrated`);

  // Migrate relations
  const relations = queryRowObjects(source, "SELECT * FROM memory_relations") as unknown as HippocampusRelation[];
  let relMigrated = 0;

  for (const rel of relations) {
    const now = new Date(rel.created_at * 1000).toISOString();
    try {
      targetDb.run(
        "INSERT OR IGNORE INTO memory_relations (id, from_chunk_id, to_chunk_id, relation_type, weight, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [rel.id, rel.from_chunk_id, rel.to_chunk_id, rel.relation_type, rel.weight, now]
      );
      relMigrated++;
    } catch { /* duplicate */ }
  }

  console.log(`  Relations: ${relMigrated} migrated`);

  // Migrate files
  const files = queryRowObjects(source, "SELECT * FROM files");
  let fileMigrated = 0;

  for (const file of files) {
    const mtime = new Date(Number(file.mtime) * 1000).toISOString();
    try {
      targetDb.run(
        "INSERT OR IGNORE INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
        [String(file.path), String(file.source), String(file.hash), mtime, Number(file.size)]
      );
      fileMigrated++;
    } catch { /* duplicate */ }
  }

  console.log(`  Files: ${fileMigrated} migrated`);

  // Migrate embedding cache
  const embeddings = queryRowObjects(source, "SELECT * FROM embedding_cache");
  let embMigrated = 0;

  for (const emb of embeddings) {
    try {
      targetDb.run(
        "INSERT OR IGNORE INTO embedding_cache (provider, model, hash, embedding, dims, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        [String(emb.provider), String(emb.model), String(emb.hash),
         String(emb.embedding), Number(emb.dims), new Date(Number(emb.updated_at) * 1000).toISOString()]
      );
      embMigrated++;
    } catch { /* duplicate */ }
  }

  console.log(`  Embedding cache: ${embMigrated} migrated`);

  saveDb(targetDb);
  source.close();
}

// ── Memex Migration ────────────────────────────────────────────────

async function migrateMemex(sourcePath: string, targetDb: SqlJsDatabase): Promise<void> {
  console.log(`Migrating from memex: ${sourcePath}`);

  const source = await openSourceDbAsync(sourcePath);

  // Detect schema
  const tables = queryRows(source, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .map((v) => String(v[0]));
  console.log(`  Tables: ${tables.join(", ")}`);

  // Try to migrate chunks if they exist
  const hasChunks = tables.includes("chunks");
  if (hasChunks) {
    const count = queryRows(source, "SELECT COUNT(*) FROM chunks")[0][0];
    console.log(`  Found ${count} chunks in memex`);

    const chunks = queryRowObjects(source, "SELECT * FROM chunks");
    let migrated = 0;

    for (const chunk of chunks) {
      const text = String(chunk.text || "");
      if (text.trim().length < 10) continue;

      const id = String(chunk.id);
      const namespace = deriveNamespace(String(chunk.path || ""), String(chunk.source || "memex"));
      const knowledgeType = detectMemoryType(text);

      try {
        targetDb.run(
          `INSERT OR IGNORE INTO chunks
           (id, path, source, namespace, knowledge_type, lifecycle, text,
            half_life_days, confidence, created_at, updated_at)
           VALUES (?, ?, 'memex', ?, ?, 'active', ?, 30, 1.0, ?, ?)`,
          [id, String(chunk.path || "memex"), namespace, knowledgeType, text,
           new Date().toISOString(), new Date().toISOString()]
        );
        indexChunk(targetDb, id, text);
        migrated++;
      } catch { /* skip */ }
    }

    console.log(`  Migrated ${migrated} chunks from memex`);
  }

  // Try to migrate relations if they exist
  const hasRelations = tables.includes("memory_relations");
  if (hasRelations) {
    const rels = queryRowObjects(source, "SELECT * FROM memory_relations");
    let migrated = 0;
    for (const rel of rels) {
      try {
        targetDb.run(
          "INSERT OR IGNORE INTO memory_relations (id, from_chunk_id, to_chunk_id, relation_type, weight, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          [String(rel.id), String(rel.from_chunk_id), String(rel.to_chunk_id),
           String(rel.relation_type || "related_by_topic"), Number(rel.weight || 1.0),
           new Date().toISOString()]
        );
        migrated++;
      } catch { /* skip */ }
    }
    console.log(`  Migrated ${migrated} relations from memex`);
  }

  saveDb(targetDb);
  source.close();
}

// ── Namespace Derivation ───────────────────────────────────────────

function deriveNamespace(path: string, source: string): string {
  // Derive a namespace from the source path
  if (source === "memory" || source === "direct") return "/memory";
  if (source === "wiki") return "/wiki";
  if (source === "summary") return "/summaries";
  if (source === "dream") return "/dream";
  if (source === "session") return "/sessions";

  // Path-based derivation
  if (path.includes("MEMORY.md")) return "/memory";
  if (path.includes("business/")) return "/business";
  if (path.includes("agents/")) return "/agents";
  if (path.includes("projects/")) return "/projects";

  return `/${source}`;
}

// ── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  let from = "";
  let dbPath = "";

  for (const arg of args) {
    if (arg.startsWith("--from=")) from = arg.split("=")[1];
    else if (arg.startsWith("--db=")) dbPath = arg.split("=")[1];
  }

  if (!from) {
    console.error("Usage: migrate-from-legacy --from=hippocampus|memex [--db=/path/to/source.db]");
    console.error("");
    console.error("Sources:");
    console.error("  hippocampus  Migrate from Hermes Hippocampus plugin DB");
    console.error("  memex        Migrate from Memex SQLite DB");
    console.error("");
    console.error("Defaults:");
    console.error("  --from=hippocampus → ~/.hermes/hippocampus.db");
    process.exit(1);
  }

  // Default paths
  if (from === "hippocampus" && !dbPath) {
    dbPath = join(homedir(), ".hermes", "hippocampus.db");
  }

  if (!dbPath) {
    console.error("Please specify --db=/path/to/source.db");
    process.exit(1);
  }

  console.log(`Inkstone Migration`);
  console.log(`════════════════════`);
  console.log(`  Source: ${from} (${dbPath})`);
  console.log(`  Target: ${DB_PATH}`);
  console.log("");

  ensureDir(dirname(DB_PATH));
  const targetDb = await initDb();

  switch (from) {
    case "hippocampus":
      await migrateHippocampus(dbPath, targetDb);
      break;
    case "memex":
      await migrateMemex(dbPath, targetDb);
      break;
    default:
      console.error(`Unknown source: ${from}. Use 'hippocampus' or 'memex'.`);
      process.exit(1);
  }

  // Verify
  const result = targetDb.exec("SELECT COUNT(*) as cnt FROM chunks");
  const count = Number(result[0]?.values[0]?.[0] || 0);
  console.log(`\nDone. Total chunks in Inkstone: ${count}`);

  closeDb();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
