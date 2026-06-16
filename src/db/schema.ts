/**
 * Inkstone — Database Layer (better-sqlite3)
 *
 * Native SQLite via better-sqlite3. Direct disk I/O, no WASM export needed.
 * Writes are instant, reads are memory-mapped, no corruption risk.
 *
 * Provides: schema, write, search, decay, lifecycle, graph edges, wiki indexing.
 */

import Database, { type Database as BetterSqlite3Database } from "better-sqlite3";
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, renameSync, copyFileSync, unlinkSync, statSync } from "node:fs";
import { join, relative, extname, dirname, basename } from "node:path";
import {
 DB_PATH, WIKI_DIR, WIKI_NAMESPACES, CHUNK_SIZE_LINES,
 hashContent, ensureDir, ARCHIVE_DIR, INKSTONE_ROOT,
 decayScore, getHalfLife, SOURCE_TRUST, KNOWLEDGE_TYPE_WEIGHT,
 DECAY_PRUNE_THRESHOLD, VALIDATED_ACCESS_THRESHOLD,
 STALE_DAYS, ARCHIVED_DAYS, detectMemoryType,
  detectDomain, type MemoryType, type LifecycleState, EMBEDDING_DIMS,
} from "../config.js";
import { randomUUID } from "node:crypto";
import { ensureFtsTable, indexChunk, searchFts, removeChunkFromIndex, rebuildFtsIndex, type FtsResult } from "./fts.js";
import { AUTH_SCHEMA_SQL } from "../auth/auth.js";
import { QUERY_CACHE_SCHEMA_SQL } from "../nlm/types.js";
import { EmbeddingClient } from "../llm/client.js";

export type SqlJsDatabase = BetterSqlite3Database;
export type { BetterSqlite3Database as Database };

// ── Connection ─────────────────────────────────────────────────────

let _db: SqlJsDatabase | null = null;
let _dbPath: string = DB_PATH;
let _lastSaveTime = 0;
let schemaChanged = false;
let _dirty = false;
const SAVE_DEBOUNCE_MS = 30_000;
const MAX_BACKUPS = 3;

function rotateBackups(dbPath: string): void {
  const dir = dirname(dbPath);
  const base = basename(dbPath);

  // Delete oldest backup
  const oldest = join(dir, `${base}.bak.${MAX_BACKUPS}`);
  if (existsSync(oldest)) {
    try { unlinkSync(oldest); } catch { /* ignore */ }
  }

  // Shift existing backups: .bak.2 → .bak.3, .bak.1 → .bak.2, .bak → .bak.1
  for (let i = MAX_BACKUPS - 1; i >= 1; i--) {
    const from = join(dir, `${base}.bak${i > 1 ? `.${i}` : ''}`);
    const to = join(dir, `${base}.bak.${i + 1}`);
    if (existsSync(from)) {
      try { renameSync(from, to); } catch { /* ignore */ }
    }
  }

  // Current → .bak
  if (existsSync(dbPath)) {
    try { copyFileSync(dbPath, join(dir, `${base}.bak`)); } catch { /* ignore */ }
  }
}

export async function getDb(path = DB_PATH): Promise<SqlJsDatabase> {
  if (_db) return _db;
  _dbPath = path;
  ensureDir(dirname(path));

  _db = new Database(path);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  _db.pragma("busy_timeout = 5000");
  _db.pragma("synchronous = NORMAL");
  _db.pragma("mmap_size = 268435456");
  _db.pragma("cache_size = -65536");

  return _db;
}

export function saveDb(_dbArg?: SqlJsDatabase, _force = false): void {
  // better-sqlite3 writes directly to disk — no export needed.
  // This function is kept as a no-op for API compatibility.
}

export function markDirty(): void { _dirty = true; }

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
    _dirty = false;
  }
}

// ── Helpers for better-sqlite3 sync API ────────────────────────────

/** Run a query that returns rows */
function queryAll(db: SqlJsDatabase, sql: string, params: unknown[] = []): Record<string, unknown>[] {
  if (params.length > 0) {
    return db.prepare(sql).all(...params) as Record<string, unknown>[];
  }
  return db.prepare(sql).all() as Record<string, unknown>[];
}

/** Run a query that returns one row */
function queryOne(db: SqlJsDatabase, sql: string, params: unknown[] = []): Record<string, unknown> | null {
  if (params.length > 0) {
    return db.prepare(sql).get(...params) as Record<string, unknown> | undefined ?? null;
  }
  return db.prepare(sql).get() as Record<string, unknown> | undefined ?? null;
}

/** Run a statement (INSERT/UPDATE/DELETE) */
function runStmt(db: SqlJsDatabase, sql: string, params: unknown[] = []): void {
  if (params.length > 0) {
    db.prepare(sql).run(...params);
  } else {
    db.prepare(sql).run();
  }
}

// ── Schema ─────────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  path   TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'wiki',
  hash   TEXT,
  mtime  TEXT,
  size   INTEGER
);

CREATE TABLE IF NOT EXISTS chunks (
  id               TEXT PRIMARY KEY,
  path             TEXT NOT NULL,
  source           TEXT NOT NULL DEFAULT 'wiki',
  namespace        TEXT NOT NULL DEFAULT '/general',
  knowledge_type   TEXT NOT NULL DEFAULT 'fact',
  lifecycle        TEXT NOT NULL DEFAULT 'active',
  start_line       INTEGER,
  end_line         INTEGER,
  hash             TEXT,
  model            TEXT,
  text             TEXT NOT NULL,
  embedding        BLOB,
  specificity_score REAL DEFAULT 1.0,
  half_life_days   REAL DEFAULT 30,
  confidence       REAL DEFAULT 1.0,
  valid_from       TEXT,
  valid_to         TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  last_verified    TEXT
);

CREATE TABLE IF NOT EXISTS embedding_cache (
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL,
  hash        TEXT NOT NULL,
  embedding   TEXT NOT NULL,
  dims        INTEGER NOT NULL DEFAULT ${EMBEDDING_DIMS},
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (provider, model, hash)
);

CREATE TABLE IF NOT EXISTS memory_relations (
  id             TEXT PRIMARY KEY,
  from_chunk_id  TEXT NOT NULL,
  to_chunk_id    TEXT NOT NULL,
  relation_type  TEXT NOT NULL DEFAULT 'related_by_topic',
  weight         REAL NOT NULL DEFAULT 1.0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memory_decay (
  chunk_id    TEXT PRIMARY KEY,
  decay_score REAL NOT NULL DEFAULT 1.0,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_access TEXT NOT NULL DEFAULT (datetime('now')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS nlm_sync (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT,
  notebook_id TEXT,
  source_id   TEXT,
  wiki_path   TEXT,
  status      TEXT NOT NULL DEFAULT 'uploaded',
  error       TEXT,
  synced_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS goals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  title           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  source_chunk_id TEXT,
  namespace       TEXT NOT NULL DEFAULT '/general',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS failure_patterns (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern_text     TEXT NOT NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  first_seen       TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen        TEXT NOT NULL DEFAULT (datetime('now')),
  namespace        TEXT NOT NULL DEFAULT '/general',
  source_chunk_ids TEXT
);

CREATE TABLE IF NOT EXISTS hypotheses (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  statement        TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open',
  confidence       REAL NOT NULL DEFAULT 0.5,
  namespace        TEXT NOT NULL DEFAULT '/general',
  evidence_for     TEXT,
  evidence_against TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at      TEXT
);

CREATE TABLE IF NOT EXISTS manifest (
  session_id       TEXT PRIMARY KEY,
  hash             TEXT NOT NULL,
  wiki_path        TEXT,
  date             TEXT NOT NULL DEFAULT (datetime('now')),
  domain           TEXT,
  namespace        TEXT NOT NULL DEFAULT '/general',
  char_count       INTEGER,
  model            TEXT,
  provider         TEXT,
  nlm_source_id    TEXT,
  retries          INTEGER DEFAULT 0,
  superseded       INTEGER DEFAULT 0,
  superseded_by    TEXT,
  superseded_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
CREATE INDEX IF NOT EXISTS idx_chunks_namespace ON chunks(namespace);
CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);
CREATE INDEX IF NOT EXISTS idx_chunks_type ON chunks(knowledge_type);
CREATE INDEX IF NOT EXISTS idx_chunks_lifecycle ON chunks(lifecycle);
CREATE INDEX IF NOT EXISTS idx_chunks_valid_to ON chunks(valid_to);
CREATE INDEX IF NOT EXISTS idx_chunks_logical_id ON chunks(logical_id);
CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(hash);
CREATE INDEX IF NOT EXISTS idx_relations_from ON memory_relations(from_chunk_id);
CREATE INDEX IF NOT EXISTS idx_relations_to ON memory_relations(to_chunk_id);
CREATE INDEX IF NOT EXISTS idx_relations_type ON memory_relations(relation_type);
CREATE INDEX IF NOT EXISTS idx_decay_score ON memory_decay(decay_score);
CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);
CREATE INDEX IF NOT EXISTS idx_hypotheses_status ON hypotheses(status);
CREATE INDEX IF NOT EXISTS idx_nlm_sync_session ON nlm_sync(session_id);
CREATE INDEX IF NOT EXISTS idx_nlm_sync_notebook ON nlm_sync(notebook_id);
CREATE INDEX IF NOT EXISTS idx_manifest_date ON manifest(date);

INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1');
`;

export async function ensureSchema(db: SqlJsDatabase): Promise<void> {
 migrateSchema(db);
 db.exec(SCHEMA_SQL);
 db.exec(AUTH_SCHEMA_SQL);
 db.exec(QUERY_CACHE_SCHEMA_SQL);
  ensureFtsTable(db);
  // Only persist schema changes — no export when schema is already up to date
  if (schemaChanged) saveDb(db);
  schemaChanged = false;
}

function migrateSchema(db: SqlJsDatabase): void {
 const tables = new Set(
   queryAll(db, "SELECT name FROM sqlite_master WHERE type='table'")
     .map((r) => String(r.name))
 );
 if (!tables.has("chunks")) return;

 const columns = new Set(
   queryAll(db, "PRAGMA table_info(chunks)")
     .map((r) => String(r.name))
 );
  const addIfMissing = (col: string, def: string) => {
    if (!columns.has(col)) {
      console.log(`  Migrating schema: adding ${col} column...`);
      db.exec(`ALTER TABLE chunks ADD COLUMN ${col} ${def}`);
      schemaChanged = true;
    }
  };
  addIfMissing("valid_to", "TEXT");
  addIfMissing("valid_from", "TEXT");
  addIfMissing("logical_id", "TEXT");
  addIfMissing("version", "INTEGER DEFAULT 1");
  addIfMissing("start_line", "INTEGER");
  addIfMissing("end_line", "INTEGER");
  const sv = queryOne(db, "SELECT value FROM meta WHERE key = 'schema_version'");
  if (!sv || Number(sv.value) < 2) {
    db.exec("UPDATE meta SET value = '2' WHERE key = 'schema_version'");
    schemaChanged = true;
  }
}

// ── Write Operations ───────────────────────────────────────────────

export interface WriteOptions {
  text: string;
  path?: string;
  namespace?: string;
  knowledgeType?: MemoryType;
  source?: string;
  tags?: string[];
  confidence?: number;
  model?: string;
  replaces?: string;
}

export function writeChunk(db: SqlJsDatabase, opts: WriteOptions): string {
  const {
    text, path = "direct", namespace = "/general",
    knowledgeType = detectMemoryType(text),
    source = "direct", confidence = 1.0, model, replaces,
  } = opts;

  const id = `${path}::${hashContent(text)}`;
  const halfLife = getHalfLife(knowledgeType);
  const now = new Date().toISOString();

  // Handle explicit supersession
  if (replaces) {
    const oldChunk = queryOne(db, "SELECT id, lifecycle FROM chunks WHERE id = ?", [replaces]);
    if (oldChunk) {
      runStmt(db, "UPDATE chunks SET lifecycle = 'stale', valid_to = ?, updated_at = ? WHERE id = ?",
        [now, now, replaces]);
      removeChunkFromIndex(db, replaces);
      try {
        runStmt(db, "INSERT INTO memory_relations (id, from_chunk_id, to_chunk_id, relation_type, weight) VALUES (?, ?, ?, 'supersedes', 2.0)",
    [`supersedes:${id}:${replaces}`, id, replaces]);
      } catch { /* duplicate edge */ }
    }
  }

  try {
    runStmt(db, `INSERT INTO chunks (id, path, source, namespace, knowledge_type, lifecycle,
                           text, half_life_days, confidence, model, valid_from, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
        [id, path, source, namespace, knowledgeType, text, halfLife, confidence, model || null, now, now, now]);
  } catch {
    // ON CONFLICT — update existing
    runStmt(db, `UPDATE chunks SET text = ?, namespace = ?, knowledge_type = ?,
              confidence = ?, updated_at = ?,
              lifecycle = CASE WHEN lifecycle = 'archived' THEN 'active' ELSE lifecycle END
       WHERE id = ?`,
        [text, namespace, knowledgeType, confidence, now, id]);
  }

  // Ensure decay row
  try {
    runStmt(db, `INSERT INTO memory_decay (chunk_id, decay_score, access_count, last_access, created_at)
       VALUES (?, 1.0, 0, ?, ?)`,
        [id, now, now]);
  } catch {
    runStmt(db, `UPDATE memory_decay SET last_access = ? WHERE chunk_id = ?`, [now, id]);
  }

  // Index for full-text search
  indexChunk(db, id, text);

  saveDb(db);
  return id;
}

export async function writeChunkWithEmbedding(db: SqlJsDatabase, opts: WriteOptions): Promise<string> {
  const id = writeChunk(db, opts);
  await embedAndStore(db, id, opts.text);
  return id;
}

export function getChunk(db: SqlJsDatabase, id: string): Record<string, unknown> | null {
  const row = queryOne(db, "SELECT * FROM chunks WHERE id = ?", [id]);
  if (row) {
    // Increment access count
    runStmt(db, "UPDATE memory_decay SET access_count = access_count + 1, last_access = ? WHERE chunk_id = ?",
    [new Date().toISOString(), id]);
    saveDb(db);
  }
  return row;
}

// ── Lifecycle ──────────────────────────────────────────────────────

export async function transitionLifecycle(db: SqlJsDatabase): Promise<number> {
  const now = new Date();
  let transitions = 0;

  const toValidate = queryAll(db, `
    SELECT c.id as id FROM chunks c
    JOIN memory_decay d ON c.id = d.chunk_id
    WHERE c.lifecycle = 'active' AND c.valid_to IS NULL AND d.access_count >= ?
  `, [VALIDATED_ACCESS_THRESHOLD]);

  batchedWrite(db, toValidate, TX_BATCH_SIZE, (item) => {
    runStmt(db, "UPDATE chunks SET lifecycle = 'validated', updated_at = ? WHERE id = ?", [now.toISOString(), String((item as any).id)]);
    transitions++;
  });
  await yieldToEventLoop();

  const staleCutoff = new Date(now.getTime() - STALE_DAYS * 86400000).toISOString();
  const toStale = queryAll(db, `
    SELECT c.id as id FROM chunks c
    JOIN memory_decay d ON c.id = d.chunk_id
    WHERE c.lifecycle = 'validated' AND c.valid_to IS NULL AND d.last_access < ?
  `, [staleCutoff]);

  batchedWrite(db, toStale, TX_BATCH_SIZE, (item) => {
    runStmt(db, "UPDATE chunks SET lifecycle = 'stale', updated_at = ? WHERE id = ?", [now.toISOString(), String((item as any).id)]);
    transitions++;
  });
  await yieldToEventLoop();

  const archiveCutoff = new Date(now.getTime() - ARCHIVED_DAYS * 86400000).toISOString();
  const toArchive = queryAll(db, `
    SELECT c.id as id FROM chunks c
    WHERE c.lifecycle = 'stale' AND c.valid_to IS NULL AND c.updated_at < ?
  `, [archiveCutoff]);

  batchedWrite(db, toArchive, TX_BATCH_SIZE, (item) => {
    runStmt(db, "UPDATE chunks SET lifecycle = 'archived', updated_at = ? WHERE id = ?", [now.toISOString(), String((item as any).id)]);
    transitions++;
  });

  if (transitions > 0) saveDb(db);
  return transitions;
}

// ── Event Loop Yield ────────────────────────────────────────────────

export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ── Vector Embedding ────────────────────────────────────────────────

const _embeddingClient = new EmbeddingClient();

export function serializeVector(vec: number[]): Buffer {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}

export function deserializeVector(blob: unknown): number[] | null {
  if (!blob || !(blob instanceof Uint8Array || Buffer.isBuffer(blob))) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob as Uint8Array);
  if (buf.length < 4) return null;
  const vec = new Array<number>(buf.length / 4);
  for (let i = 0; i < vec.length; i++) vec[i] = buf.readFloatLE(i * 4);
  return vec;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

export async function embedAndStore(db: SqlJsDatabase, chunkId: string, text: string): Promise<boolean> {
  try {
    if (!text || text.trim().length === 0) return false;
    const truncated = text.length > 2048 ? text.slice(0, 2048) : text;
    const vec = await _embeddingClient.embed(truncated);
    if (vec.length === 0) return false;
    const blob = serializeVector(vec);
    runStmt(db, "UPDATE chunks SET embedding = ? WHERE id = ?", [blob, chunkId]);
    return true;
  } catch {
    return false;
  }
}

export async function embedAll(db: SqlJsDatabase, batchSize = 50, maxConcurrency = 1): Promise<{ embedded: number; failed: number; skipped: number }> {
  const rows = queryAll(db, `
    SELECT id, text FROM chunks
    WHERE embedding IS NULL AND lifecycle NOT IN ('archived') AND valid_to IS NULL
  `);

  if (rows.length === 0) return { embedded: 0, failed: 0, skipped: 0 };

  console.log(`Embedding ${rows.length} chunks...`);
  let embedded = 0, failed = 0;

  for (let i = 0; i < rows.length; i++) {
    const id = String(rows[i].id);
    const text = String(rows[i].text);
    const ok = await embedAndStore(db, id, text);
    if (ok) embedded++;
    else failed++;

    if ((i + 1) % batchSize === 0) {
      console.log(`  [${i + 1}/${rows.length}] embedded: ${embedded}, failed: ${failed}`);
    }
    if (i % 100 === 0) await yieldToEventLoop();
  }

  saveDb(db);
  return { embedded, failed, skipped: 0 };
}

// ── Transaction Helpers ─────────────────────────────────────────────

const TX_BATCH_SIZE = 500;

function batchedWrite(db: SqlJsDatabase, items: unknown[], batchSize: number, fn: (item: unknown, idx: number) => void): void {
  const tx = (db as any).transaction(() => {
    for (let i = 0; i < items.length; i++) {
      fn(items[i], i);
    }
  });
  for (let start = 0; start < items.length; start += batchSize) {
    const batch = items.slice(start, start + batchSize);
    const batchTx = (db as any).transaction(() => {
      for (let i = 0; i < batch.length; i++) {
        fn(batch[i], start + i);
      }
    });
    batchTx();
  }
}

// ── Decay ──────────────────────────────────────────────────────────

export async function applyExponentialDecay(db: SqlJsDatabase): Promise<number> {
  const rows = queryAll(db, `
    SELECT c.id, c.knowledge_type, c.half_life_days, d.decay_score, d.last_access
    FROM chunks c
    JOIN memory_decay d ON c.id = d.chunk_id
    WHERE c.lifecycle NOT IN ('archived') AND c.valid_to IS NULL
  `);

  const now = Date.now();
  let updated = 0;
  const toUpdate: unknown[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const ageDays = (now - new Date(String(row.last_access)).getTime()) / 86400000;
    const newScore = decayScore(1.0, ageDays, Number(row.half_life_days));
    const oldScore = Number(row.decay_score);
    if (Math.abs(newScore - oldScore) > 0.001) {
      toUpdate.push({ id: String(row.id), score: newScore });
    }
  }

  batchedWrite(db, toUpdate, TX_BATCH_SIZE, (item) => {
    const el = item as { id: string; score: number };
    runStmt(db, "UPDATE memory_decay SET decay_score = ? WHERE chunk_id = ?", [el.score, el.id]);
    updated++;
  });

  if (updated > 0) saveDb(db);
  return updated;
}

export async function pruneExpired(db: SqlJsDatabase): Promise<number> {
  const toPrune = queryAll(db, `
    SELECT c.id, c.text, c.path, c.namespace, c.knowledge_type, c.valid_to
    FROM chunks c
    JOIN memory_decay d ON c.id = d.chunk_id
    WHERE c.valid_to IS NOT NULL
      AND d.decay_score <= ?
      AND c.valid_to < datetime('now', '-90 day')
  `, [DECAY_PRUNE_THRESHOLD]);

  if (toPrune.length === 0) return 0;

  ensureDir(ARCHIVE_DIR);
  for (let i = 0; i < toPrune.length; i++) {
    const chunk = toPrune[i];
    const archivePath = join(ARCHIVE_DIR, `${String(chunk.id).replace(/[:/]/g, "_")}.md`);
    try {
      writeFileSync(archivePath, [
        `---`,
        `id: ${chunk.id}`,
        `path: ${chunk.path}`,
        `namespace: ${chunk.namespace}`,
        `type: ${chunk.knowledge_type}`,
        `valid_to: ${chunk.valid_to}`,
        `pruned: ${new Date().toISOString()}`,
        `---`,
        chunk.text as string,
      ].join("\n"));
    } catch { /* best effort */ }
    if (i % 200 === 0 && i > 0) await yieldToEventLoop();
  }

  batchedWrite(db, toPrune, TX_BATCH_SIZE, (item) => {
    const id = String((item as any).id);
    removeChunkFromIndex(db, id);
    runStmt(db, "DELETE FROM memory_decay WHERE chunk_id = ?", [id]);
    runStmt(db, "DELETE FROM chunks WHERE id = ?", [id]);
  });

  saveDb(db);
  return toPrune.length;
}

// ── Hybrid Search ──────────────────────────────────────────────────

export interface SearchOptions {
  query: string;
  namespace?: string;
  knowledgeType?: MemoryType;
  lifecycle?: LifecycleState;
  limit?: number;
  threshold?: number;
}

export interface SearchResult {
  id: string;
  path: string;
  namespace: string;
  knowledgeType: string;
  lifecycle: string;
  text: string;
  score: number;
  ftsScore: number;
  vectorScore: number;
  decayBoost: number;
  sourceTrust: number;
  typeWeight: number;
  graphBoost: number;
}

export function searchWiki(db: SqlJsDatabase, opts: SearchOptions): SearchResult[] {
  const { query, namespace, knowledgeType, lifecycle, limit = 10, threshold = 0.3 } = opts;

  // Use our custom FTS (BM25-like scoring)
  const ftsHits = searchFts(db, query, limit * 3);
  if (ftsHits.length === 0) return [];

  const candidateIds = new Set(ftsHits.map((r) => r.chunkId));

  // Fetch full chunk data
  const idList = Array.from(candidateIds);
  const placeholders = idList.map(() => "?").join(",");

  let chunkSql = `SELECT * FROM chunks WHERE id IN (${placeholders}) AND (valid_to IS NULL OR lifecycle != 'stale')`;
  const chunkParams: unknown[] = [...idList];
  if (namespace) { chunkSql += " AND namespace LIKE ? || '%'"; chunkParams.push(namespace); }
  if (knowledgeType) { chunkSql += " AND knowledge_type = ?"; chunkParams.push(knowledgeType); }
  if (lifecycle) { chunkSql += " AND lifecycle = ?"; chunkParams.push(lifecycle); }

  const chunks = queryAll(db, chunkSql, chunkParams);
  const chunkMap = new Map(chunks.map((c) => [String(c.id), c]));

  // FTS score map
  const maxFts = Math.max(...ftsHits.map((r) => r.score), 0.001);
  const ftsMap = new Map(ftsHits.map((r) => [r.chunkId, r.score / maxFts]));

  // Decay scores
  const decays = queryAll(db, `
    SELECT chunk_id as cid, decay_score as ds, access_count as ac FROM memory_decay
    WHERE chunk_id IN (${placeholders})
  `, idList);
  const decayMap = new Map(decays.map((d) => [String(d.cid), { decay_score: Number(d.ds), access_count: Number(d.ac) }]));

  // Graph edges
  const relations = queryAll(db, `
    SELECT from_chunk_id as fc, to_chunk_id as tc FROM memory_relations
    WHERE from_chunk_id IN (${placeholders}) OR to_chunk_id IN (${placeholders})
  `, [...idList, ...idList]);
  const relationCounts = new Map<string, number>();
  for (const r of relations) {
    const fc = String(r.fc), tc = String(r.tc);
    if (candidateIds.has(fc)) relationCounts.set(fc, (relationCounts.get(fc) || 0) + 1);
    if (candidateIds.has(tc)) relationCounts.set(tc, (relationCounts.get(tc) || 0) + 1);
  }

  // Score fusion
  const results: SearchResult[] = [];

  for (const [id, chunk] of chunkMap) {
    const ftsScore = ftsMap.get(id) || 0;
    const decay = decayMap.get(id);
    const decayBoost = decay ? decay.decay_score * 0.2 : 0;
    const sourceTrust = SOURCE_TRUST[String(chunk.source)] || 1.0;
    const typeWeight = KNOWLEDGE_TYPE_WEIGHT[String(chunk.knowledge_type)] || 1.0;
    const graphBoost = Math.min(0.3, (relationCounts.get(id) || 0) * 0.05);

    const supersedes = queryOne(db,
      "SELECT 1 as x FROM memory_relations WHERE to_chunk_id = ? AND relation_type = 'supersedes' LIMIT 1", [id]
    );
    const superseded = supersedes ? 0.1 : 1.0;

    const compositeScore = (ftsScore * 0.5 + 0.5) *
      sourceTrust * typeWeight * (1 + decayBoost) * (1 + graphBoost) * superseded;

    if (compositeScore >= threshold) {
      results.push({
        id,
        path: String(chunk.path),
        namespace: String(chunk.namespace),
        knowledgeType: String(chunk.knowledge_type),
        lifecycle: String(chunk.lifecycle),
        text: String(chunk.text),
        score: compositeScore,
        ftsScore,
        vectorScore: 0,
        decayBoost,
        sourceTrust,
        typeWeight,
        graphBoost,
      });
    }
  }

  results.sort((a, b) => b.score - a.score);

  // Increment access count for returned results (best-effort, no full DB export)
  const now = new Date().toISOString();
  for (const r of results.slice(0, limit)) {
    runStmt(db, "UPDATE memory_decay SET access_count = access_count + 1, last_access = ? WHERE chunk_id = ?", [now, r.id]);
  }
  return results.slice(0, limit);
}

export async function searchWikiHybrid(db: SqlJsDatabase, opts: SearchOptions): Promise<SearchResult[]> {
  const { query, limit = 10 } = opts;

  const ftsResults = searchWiki(db, { ...opts, limit: limit * 3 });
  if (ftsResults.length === 0) return [];

  const queryVec = await _embeddingClient.embed(query);
  if (queryVec.length === 0) return ftsResults.slice(0, limit);

  const candidateIds = ftsResults.map((r) => r.id);
  const placeholders = candidateIds.map(() => "?").join(",");
  const rows = queryAll(db, `SELECT id, embedding FROM chunks WHERE id IN (${placeholders})`, candidateIds);

  const vecMap = new Map<string, number[]>();
  for (const row of rows) {
    const v = deserializeVector(row.embedding);
    if (v) vecMap.set(String(row.id), v);
  }

  const withVector = ftsResults.map((r) => {
    const storedVec = vecMap.get(r.id);
    const vectorScore = storedVec ? cosineSimilarity(queryVec, storedVec) : 0;
    const fusedScore = r.ftsScore * 0.4 + vectorScore * 0.4 +
      r.decayBoost * 0.1 + r.graphBoost * 0.1;
    return { ...r, vectorScore, score: fusedScore * r.sourceTrust * r.typeWeight };
  });

  withVector.sort((a, b) => b.score - a.score);

  const now = new Date().toISOString();
  for (const r of withVector.slice(0, limit)) {
    runStmt(db, "UPDATE memory_decay SET access_count = access_count + 1, last_access = ? WHERE chunk_id = ?", [now, r.id]);
  }
  return withVector.slice(0, limit);
}

// ── Graph Edges ────────────────────────────────────────────────────
export async function buildEntityCooccurrenceGraph(db: SqlJsDatabase, minOverlap = 1): Promise<number> {
  const chunks = queryAll(db, `
    SELECT id, text, namespace FROM chunks
    WHERE lifecycle NOT IN ('archived') AND valid_to IS NULL
  `);

  const WIKI_LINK_RE = /\[\[([^\]]+)\]\]/g;
  const entityToChunks = new Map<string, string[]>();
  const chunkEntities = new Map<string, Set<string>>();

  for (let ci = 0; ci < chunks.length; ci++) {
    const text = chunks[ci].text as string;
    const chunkId = chunks[ci].id as string;
    const entities = new Set<string>();
    let m: RegExpExecArray | null;
    const re = new RegExp(WIKI_LINK_RE.source, WIKI_LINK_RE.flags);
    while ((m = re.exec(text)) !== null) {
      const entity = m[1].toLowerCase().trim();
      if (entity.length >= 2) entities.add(entity);
    }
    if (entities.size > 0) {
      chunkEntities.set(chunkId, entities);
      for (const e of entities) {
        if (!entityToChunks.has(e)) entityToChunks.set(e, []);
        entityToChunks.get(e)!.push(chunkId);
      }
    }
    if (ci % 2000 === 0 && ci > 0) await yieldToEventLoop();
  }

  const pairWeights = new Map<string, number>();
  let entityCount = 0;
  for (const [entity, cids] of entityToChunks) {
    if (cids.length < 2) continue;
    for (let i = 0; i < cids.length; i++) {
      for (let j = i + 1; j < cids.length; j++) {
        const a = cids[i] < cids[j] ? cids[i] : cids[j];
        const b = cids[i] < cids[j] ? cids[j] : cids[i];
        const key = `${a}::${b}`;
        pairWeights.set(key, (pairWeights.get(key) || 0) + 1);
      }
    }
    entityCount++;
    if (entityCount % 5000 === 0) await yieldToEventLoop();
  }

  const existingEdges = new Set(
    queryAll(db, "SELECT id FROM memory_relations WHERE relation_type IN ('related_by_entity', 'related_by_namespace')")
      .map((r) => String(r.id))
  );

  let edgesCreated = 0;
  for (const [key, weight] of pairWeights) {
    if (weight < minOverlap) continue;
    const [a, b] = key.split("::");
    const edgeId = `edge:entity:${a}:${b}`;
    if (existingEdges.has(edgeId)) continue;
    try {
      runStmt(db, "INSERT INTO memory_relations (id, from_chunk_id, to_chunk_id, relation_type, weight) VALUES (?, ?, ?, 'related_by_entity', ?)",
    [edgeId, a, b, weight]);
      edgesCreated++;
      if (edgesCreated % TX_BATCH_SIZE === 0) await yieldToEventLoop();
    } catch { /* duplicate */ }
  }

  const nsMap = new Map<string, string[]>();
  for (const ch of chunks) {
    const ns = ch.namespace as string;
    if (!ns) continue;
    if (!nsMap.has(ns)) nsMap.set(ns, []);
    nsMap.get(ns)!.push(ch.id as string);
  }
  for (const [ns, cids] of nsMap) {
    if (cids.length < 2 || cids.length > 200) continue;
    for (let i = 0; i < cids.length; i++) {
      for (let j = i + 1; j < cids.length; j++) {
        const edgeId = `edge:ns:${ns}:${cids[i]}:${cids[j]}`;
        if (existingEdges.has(edgeId)) continue;
        try {
          runStmt(db,
            "INSERT INTO memory_relations (id, from_chunk_id, to_chunk_id, relation_type, weight) VALUES (?, ?, ?, 'related_by_namespace', 0.5)",
            [edgeId, cids[i], cids[j]]
          );
          edgesCreated++;
          if (edgesCreated % TX_BATCH_SIZE === 0) await yieldToEventLoop();
        } catch { /* duplicate */ }
      }
    }
  }

  if (edgesCreated > 0) saveDb(db);
  return edgesCreated;
}

export async function buildGraphEdges(db: SqlJsDatabase, minOverlap = 2, _maxChunks = 2000, _maxComparisons = 100_000): Promise<number> {
  return buildEntityCooccurrenceGraph(db, minOverlap);
}
// ── Wiki Indexing ──────────────────────────────────────────────────

export interface WikiSource {
  path: string;
  source: string;
  content: string;
  mtime: number;
}

const WIKI_INDEX_MTYPES_PATH = join(WIKI_DIR, ".index-mtimes.json");

function loadIndexMtimes(): Record<string, number> {
  try {
    if (!existsSync(WIKI_INDEX_MTYPES_PATH)) return {};
    return JSON.parse(readFileSync(WIKI_INDEX_MTYPES_PATH, "utf-8"));
  } catch { return {}; }
}

function saveIndexMtimes(mtimes: Record<string, number>): void {
  ensureDir(WIKI_DIR);
  writeFileSync(WIKI_INDEX_MTYPES_PATH, JSON.stringify(mtimes, null, 0));
}

export function discoverWikiSources(): WikiSource[] {
  const sources: WikiSource[] = [];
  for (const dir of Object.values(WIKI_NAMESPACES)) {
    if (!existsSync(dir)) continue;
    walkDir(dir, (filePath) => {
      if (extname(filePath) !== ".md") return;
      try {
        const stat = statSync(filePath);
        const relPath = relative(WIKI_DIR, filePath);
        sources.push({ path: relPath, source: "wiki", content: "", mtime: stat.mtimeMs });
      } catch { /* skip */ }
    });
  }
  return sources;
}

function walkDir(dir: string, fn: (path: string) => void, depth = 0): void {
  if (depth > 4) return;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walkDir(full, fn, depth + 1);
      else fn(full);
    }
  } catch { /* skip */ }
}

export function chunkText(text: string, chunkSize = CHUNK_SIZE_LINES): string[] {
  const lines = text.split("\n");
  const chunks: string[] = [];
  for (let i = 0; i < lines.length; i += chunkSize) {
    chunks.push(lines.slice(i, i + chunkSize).join("\n"));
  }
  return chunks.length === 0 ? [text] : chunks;
}

export async function syncWikiIndex(db: SqlJsDatabase): Promise<{ indexed: number; deleted: number }> {
  const sources = discoverWikiSources();
  const prevMtimes = loadIndexMtimes();
  const newMtimes: Record<string, number> = {};
  let indexed = 0, deleted = 0;
  let skippedUnchanged = 0;
  const currentPaths = new Set<string>();
  const changedChunks: Array<{ id: string; text: string }> = [];
  const pendingWrites: Array<{
    expireId?: string;
    newId: string;
    logicalId: string;
    newVersion: number;
    now: string;
    path: string;
    source: string;
    namespace: string;
    knowledgeType: string;
    halfLife: number;
    startLine: number;
    endLine: number;
    h: string;
    text: string;
  }> = [];

  for (const source of sources) {
    currentPaths.add(source.path);
    newMtimes[source.path] = source.mtime;

    if (prevMtimes[source.path] === source.mtime) {
      skippedUnchanged++;
      continue;
    }

    let content: string;
    try {
      content = readFileSync(join(WIKI_DIR, source.path), "utf-8");
    } catch { continue; }

    const textChunks = chunkText(content);
    const domain = detectDomain(content);
    const namespace = `/${domain}/${source.path.replace(/\.md$/, "").replace(/\\/g, "/")}`;

    for (let i = 0; i < textChunks.length; i++) {
      const chunkText_ = textChunks[i];
      const logicalId = `${source.path}::${i}`;
      const h = hashContent(chunkText_);
      const knowledgeType = detectMemoryType(chunkText_);
      const halfLife = getHalfLife(knowledgeType);
      const now = new Date().toISOString();

      const current = queryOne(db,
        "SELECT id, hash, version FROM chunks WHERE logical_id = ? AND valid_to IS NULL",
        [logicalId]
      );

      if (current) {
        if ((current.hash as string) === h) continue;
      }

      const prevVersion = current ? Number(current.version) : 0;
      const newId = randomUUID();
      const newVersion = prevVersion + 1;

      pendingWrites.push({
        expireId: current ? String(current.id) : undefined,
        newId, logicalId, newVersion, now,
        path: source.path, source: source.source, namespace,
        knowledgeType, halfLife,
        startLine: i * CHUNK_SIZE_LINES + 1,
        endLine: (i + 1) * CHUNK_SIZE_LINES,
        h, text: chunkText_
      });
      changedChunks.push({ id: newId, text: chunkText_ });
    }
  }

  if (skippedUnchanged > 0) {
    console.log(`  Skipped ${skippedUnchanged} unchanged files (mtime match)`);
  }

  for (let start = 0; start < pendingWrites.length; start += TX_BATCH_SIZE) {
    const batch = pendingWrites.slice(start, start + TX_BATCH_SIZE);
    (db as any).transaction(() => {
      for (const w of batch) {
        if (w.expireId) {
          runStmt(db, "UPDATE chunks SET valid_to = ?, updated_at = ? WHERE id = ?", [w.now, w.now, w.expireId]);
        }
        runStmt(db, `INSERT INTO chunks (id, logical_id, version, valid_from, path, source, namespace,
                               knowledge_type, lifecycle, start_line, end_line,
                               hash, text, half_life_days, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
            [w.newId, w.logicalId, w.newVersion, w.now, w.path, w.source, w.namespace,
           w.knowledgeType, w.startLine, w.endLine,
           w.h, w.text, w.halfLife, w.now, w.now]);
        try {
          runStmt(db, "INSERT INTO memory_decay (chunk_id, decay_score, access_count, last_access, created_at) VALUES (?, 1.0, 0, ?, ?)",
      [w.newId, w.now, w.now]);
        } catch {}
        try {
          runStmt(db, "INSERT INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, mtime = excluded.mtime, size = excluded.size",
      [w.path, w.source, w.h, w.now, w.text.length]);
        } catch {
          runStmt(db, "UPDATE files SET hash = ?, mtime = ?, size = ? WHERE path = ?", [w.h, w.now, w.text.length, w.path]);
        }
        indexed++;
      }
    })();
    await yieldToEventLoop();
  }

  batchedWrite(db, changedChunks, TX_BATCH_SIZE, (item) => {
    const el = item as { id: string; text: string };
    indexChunk(db, el.id, el.text);
  });
  await yieldToEventLoop();

  const dbFiles = queryAll(db, "SELECT path as path FROM files");
  const orphanPaths = dbFiles.filter(f => !currentPaths.has(String(f.path)));
  batchedWrite(db, orphanPaths, TX_BATCH_SIZE, (item) => {
    const p = String((item as any).path);
    runStmt(db, "DELETE FROM chunks WHERE path = ?", [p]);
    runStmt(db, "DELETE FROM files WHERE path = ?", [p]);
    deleted++;
  });

  saveDb(db);
  saveIndexMtimes(newMtimes);
  return { indexed, deleted };
}

// ── Init ───────────────────────────────────────────────────────────

export async function initDb(dbPath?: string): Promise<SqlJsDatabase> {
  const db = await getDb(dbPath);
  await ensureSchema(db);
  return db;
}
