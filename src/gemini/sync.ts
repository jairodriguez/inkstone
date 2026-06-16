/**
 * Inkstone → Gemini Deep Archive Sync Pipeline
 *
 * Uploads Inkstone summary chunks to Gemini File Search,
 * tracking upload status in a local `gemini_sync` table.
 *
 * Usage:
 *   import { syncInkstoneToGemini } from "./sync.js";
 *   const client = new GeminiFileSearchClient();
 *   const result = await syncInkstoneToGemini(db, client, "inkstone-archive");
 */

import type { Database as SqlJsDatabase } from "../db/schema.js";
import { GeminiFileSearchClient, withRetry } from "./client.js";
import { GeminiMetadata } from "./types.js";
import { searchWiki } from "../db/schema.js";

// ── Types ────────────────────────────────────────────────────────────

export interface SyncResult {
  /** Number of chunks successfully uploaded */
  uploaded: number;
  /** Error messages */
  errors: string[];
  /** Chunks skipped (already uploaded or failed) */
  skipped: number;
}

export interface SyncOptions {
  /** Max chunks to process per call (default 50) */
  batchSize?: number;
  /** Preview mode — no uploads */
  dryRun?: boolean;
  /** Force re-upload of already-synced chunks */
  force?: boolean;
}

// ── Schema ───────────────────────────────────────────────────────────

const CREATE_GEMINI_SYNC_TABLE = `
  CREATE TABLE IF NOT EXISTS gemini_sync (
    chunk_id     TEXT PRIMARY KEY,
    store_name   TEXT NOT NULL,
    source_id    TEXT,
    uploaded_at  TEXT NOT NULL DEFAULT (datetime('now')),
    status       TEXT NOT NULL DEFAULT 'uploaded',
    error        TEXT
  )`;

// ── Sync ─────────────────────────────────────────────────────────────

/** Upload Inkstone summary chunks to Gemini File Search */
export async function syncInkstoneToGemini(
  db: SqlJsDatabase,
  client: GeminiFileSearchClient,
  storeName: string,
  opts: SyncOptions = {}
): Promise<SyncResult> {
  const { batchSize = 50, dryRun = false, force = false } = opts;
  const errors: string[] = [];
  let uploaded = 0;
  let skipped = 0;

  // Ensure tracking table exists
  db.exec(CREATE_GEMINI_SYNC_TABLE);

  // Find chunks to upload
  let sql: string;
  let params: unknown[];

  if (force) {
    // Re-upload everything
    sql = `SELECT c.id, c.text, c.path, c.namespace, c.knowledge_type, c.created_at
           FROM chunks c
           WHERE c.source = 'summary' AND c.lifecycle NOT IN ('archived')
           ORDER BY c.created_at DESC
           LIMIT ?`;
    params = [batchSize];
  } else {
    // Exclude already uploaded
    sql = `SELECT c.id, c.text, c.path, c.namespace, c.knowledge_type, c.created_at
           FROM chunks c
           WHERE c.source = 'summary' AND c.lifecycle NOT IN ('archived')
             AND c.id NOT IN (
               SELECT chunk_id FROM gemini_sync WHERE status = 'uploaded'
             )
           ORDER BY c.created_at DESC
           LIMIT ?`;
    params = [batchSize];
  }

  const chunks = queryChunks(db, sql, params);

  if (dryRun) {
    return { uploaded: chunks.length, errors, skipped: 0 };
  }

  for (const chunk of chunks) {
    try {
      const metadata: GeminiMetadata[] = buildChunkMetadata(chunk);
      const sourceName = await withRetry(() => client.uploadFile(storeName, chunk.text, metadata));
      const sourceId = sourceName.split("/").pop() ?? sourceName;

      db.prepare(
        `INSERT INTO gemini_sync (chunk_id, store_name, source_id, status, uploaded_at)
         VALUES (?, ?, ?, 'uploaded', datetime('now'))
         ON CONFLICT(chunk_id) DO UPDATE SET
           store_name = excluded.store_name,
           source_id = excluded.source_id,
           status = 'uploaded',
           uploaded_at = datetime('now'),
           error = NULL`,
      ).run(chunk.id, storeName, sourceId);
      uploaded++;
    } catch (err) {
      const msg = `Upload ${chunk.id}: ${formatError(err)}`;
      errors.push(msg);
      db.prepare(
        `INSERT INTO gemini_sync (chunk_id, store_name, source_id, status, error, uploaded_at)
         VALUES (?, ?, NULL, 'failed', ?, datetime('now'))
         ON CONFLICT(chunk_id) DO UPDATE SET
           status = 'failed',
           error = excluded.error,
           uploaded_at = datetime('now')`,
      ).run(chunk.id, storeName, msg);
    }
  }

  return { uploaded, errors, skipped };
}

// ── Chunk to metadata ───────────────────────────────────────────────

function buildChunkMetadata(chunk: ChunkRow): GeminiMetadata[] {
  const date = chunk.created_at?.slice(0, 10) ?? "unknown";
  const domain = chunk.namespace.split("/")[1] ?? "general";

  return [
    { key: "chunk_id", string_val: chunk.id },
    { key: "path", string_val: chunk.path },
    { key: "date", string_val: date },
    { key: "domain", string_val: domain },
    { key: "namespace", string_val: chunk.namespace },
    { key: "knowledge_type", string_val: chunk.knowledge_type },
  ];
}

// ── Helpers ─────────────────────────────────────────────────────────

interface ChunkRow {
  id: string;
  text: string;
  path: string;
  namespace: string;
  knowledge_type: string;
  created_at: string;
}

function queryChunks(db: SqlJsDatabase, sql: string, params: unknown[]): ChunkRow[] {
  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map((obj) => ({
    id: String(obj.id),
    text: String(obj.text),
    path: String(obj.path),
    namespace: String(obj.namespace),
    knowledge_type: String(obj.knowledge_type),
    created_at: String(obj.created_at),
  }));
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
