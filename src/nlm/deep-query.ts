/**
 * Inkstone — Deep Query via NLM with SQLite cache
 */

import type { Database as SqlJsDatabase } from "../db/schema.js";
import { createHash } from "node:crypto";
import { saveDb } from "../db/schema.js";
import { NlmClient } from "./client.js";
import { getNlmNotebookForDomain } from "./state.js";
import { routeNlmQuery } from "./router.js";
import { DEEP_QUERY_CACHE_TTL_DAYS, QUERY_CACHE_SCHEMA_SQL, type NlmQueryResult } from "./types.js";

export interface DeepQueryOptions {
  query: string;
  domain?: string;
  forceRefresh?: boolean;
  maxAgeDays?: number;
}

export interface DeepQueryResponse {
  backend: "nlm";
  cached: boolean;
  domain: string;
  notebook_id: string;
  notebook_name: string;
  answer: string;
  sources_used: string[];
  citations: Record<string, string>;
  references: NlmQueryResult["references"];
  raw?: unknown;
}

export function ensureDeepQueryCache(db: SqlJsDatabase): void {
  db.exec(QUERY_CACHE_SCHEMA_SQL);
  saveDb(db);
}

export async function deepQuery(db: SqlJsDatabase, opts: DeepQueryOptions): Promise<DeepQueryResponse> {
  ensureDeepQueryCache(db);
  const domain = routeNlmQuery(opts.query, opts.domain);
  const notebook = getNlmNotebookForDomain(domain);
  const queryHash = hashQuery(opts.query, domain, notebook.id);
  const ttlDays = opts.maxAgeDays ?? DEEP_QUERY_CACHE_TTL_DAYS;

  if (!opts.forceRefresh) {
    const cached = getCached(db, queryHash, ttlDays);
    if (cached) {
      return {
        backend: "nlm",
        cached: true,
        domain,
        notebook_id: notebook.id,
        notebook_name: notebook.name,
        answer: String(cached.answer),
        sources_used: parseJsonArray(cached.raw_json, "sources_used"),
        citations: parseJsonObject(cached.citations_json),
        references: parseJsonArrayValue(cached.references_json),
      };
    }
  }

  const client = new NlmClient();
  const result = await client.queryNotebook(notebook.id, opts.query);
  db.prepare(
    `INSERT OR REPLACE INTO deep_query_cache
      (query_hash, query, domain, backend, notebook_id, answer, citations_json, references_json, raw_json, updated_at)
     VALUES (?, ?, ?, 'nlm', ?, ?, ?, ?, ?, datetime('now'))`
  ).run(
    queryHash,
    opts.query,
    domain,
    notebook.id,
    result.answer,
    JSON.stringify(result.citations),
    JSON.stringify(result.references),
    JSON.stringify(result.raw),
  );
  saveDb(db);

  return {
    backend: "nlm",
    cached: false,
    domain,
    notebook_id: notebook.id,
    notebook_name: notebook.name,
    answer: result.answer,
    sources_used: result.sources_used,
    citations: result.citations,
    references: result.references,
    raw: result.raw,
  };
}

function hashQuery(query: string, domain: string, notebookId: string): string {
  return createHash("sha256").update(`${domain}\n${notebookId}\n${query}`).digest("hex");
}

function getCached(db: SqlJsDatabase, queryHash: string, ttlDays: number): Record<string, unknown> | null {
  const result = db.prepare(
    `SELECT * FROM deep_query_cache
     WHERE query_hash = ? AND updated_at >= datetime('now', ?)
     LIMIT 1`
  ).get(queryHash, `-${ttlDays} days`) as Record<string, unknown> | undefined;
  return result || null;
}

function parseJsonObject(value: unknown): Record<string, string> {
  if (typeof value !== "string" || !value) return {};
  try { return JSON.parse(value) as Record<string, string>; } catch { return {}; }
}

function parseJsonArrayValue<T = unknown>(value: unknown): T[] {
  if (typeof value !== "string" || !value) return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed as T[] : []; } catch { return []; }
}

function parseJsonArray(rawJson: unknown, key: string): string[] {
  if (typeof rawJson !== "string" || !rawJson) return [];
  try {
    const parsed = JSON.parse(rawJson) as Record<string, unknown>;
    const value = parsed.value && typeof parsed.value === "object" ? (parsed.value as Record<string, unknown>)[key] : parsed[key];
    return Array.isArray(value) ? value.map(String) : [];
  } catch { return []; }
}
