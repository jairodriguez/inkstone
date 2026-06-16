/**
 * Inkstone — NLM (NotebookLM) Types
 *
 * Type definitions for interacting with NotebookLM via the nlm CLI.
 */

export type NlmDomain = "business" | "content" | "system";

export interface NlmNotebook {
  id: string;
  title: string;
  source_count?: number;
  updated_at?: string;
}

export interface NlmQueryResult {
  answer: string;
  conversation_id?: string;
  sources_used: string[];
  citations: Record<string, string>;
  references: Array<{
    source_id: string;
    citation_number: number;
    cited_text: string;
  }>;
  raw: unknown;
}

export interface NlmState {
  version: number;
  domains: Record<string, NlmDomainConfig>;
  pipeline: {
    last_daily_run: string | null;
    last_weekly_run: string | null;
    last_dream_cycle: string | null;
    last_quarterly_dream: string | null;
    sessions_processed: number;
  };
}

export interface NlmDomainConfig {
  label: string;
  tags_match: string[];
  active_notebook: {
    id: string;
    name: string;
    created: string;
    month: string;
  };
  archive_notebooks: Array<{
    id: string;
    name: string;
    month: string;
  }>;
  long_term_notebook?: {
    id: string;
    name: string;
    created: string;
    quarterly_sources: number;
  };
}

export interface DeepQueryCacheRow {
  query_hash: string;
  query: string;
  domain: string | null;
  backend: string;
  notebook_id: string | null;
  answer: string;
  citations_json: string | null;
  references_json: string | null;
  created_at: string;
  updated_at: string;
}

export const DEEP_QUERY_CACHE_TTL_DAYS = 7;

export const QUERY_CACHE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS deep_query_cache (
  query_hash       TEXT PRIMARY KEY,
  query            TEXT NOT NULL,
  domain           TEXT,
  backend          TEXT NOT NULL DEFAULT 'nlm',
  notebook_id      TEXT,
  answer           TEXT NOT NULL,
  citations_json   TEXT,
  references_json  TEXT,
  raw_json         TEXT,
  created_at       TEXT DEFAULT (datetime('now')),
  updated_at       TEXT DEFAULT (datetime('now'))
);
`;