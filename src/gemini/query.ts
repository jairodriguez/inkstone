/**
 * Inkstone — Local + Deep Archive Query
 *
 * Searches Inkstone first, falls back to Gemini deep archive
 * if local results are sparse.
 */

import type { Database as SqlJsDatabase } from "../db/schema.js";
import { searchWiki } from "../db/schema.js";
import { GeminiFileSearchClient, withRetry } from "./client.js";
import { GeminiMetadata, GeminiSearchResult } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────

export interface CombinedResult {
  /** Which layer returned this */
  source: "inkstone" | "gemini";
  /** Chunk / file ID */
  id: string;
  /** Text content */
  text: string;
  /** Relevance score (Inkstone or Gemini) */
  score: number;
  /** Gemini-specific: file name, chunk ID */
  geminiMeta?: {
    fileName: string;
    customMetadata: Record<string, string>;
  };
}

export interface QueryOptions {
  /** Max Inkstone results (default 10) */
  localLimit?: number;
  /** Max Gemini results (default 5) */
  geminiLimit?: number;
  /** Minimum local results before hitting Gemini (default 3) */
  minimumLocal?: number;
  /** AIP-160 metadata filter for Gemini (e.g. "date=2026-05-10") */
  metadataFilter?: string;
  /** Namespace filter for Inkstone local search */
  namespace?: string;
}

// ── Query ────────────────────────────────────────────────────────────

/**
 * Search Inkstone locally, fall back to Gemini deep archive if sparse.
 *
 * @returns Combined results sorted by score.
 */
export async function queryInkstoneWithGeminiFallback(
  db: SqlJsDatabase,
  client: GeminiFileSearchClient,
  storeName: string,
  query: string,
  opts: QueryOptions = {}
): Promise<CombinedResult[]> {
  const {
    localLimit = 10,
    geminiLimit = 5,
    minimumLocal = 3,
    metadataFilter,
    namespace,
  } = opts;

  const results: CombinedResult[] = [];

  // ── 1. Local Inkstone search ────────────────────────────────────
  const inkstoneResults = searchWiki(db, {
    query,
    namespace,
    limit: localLimit,
  });

  for (const r of inkstoneResults) {
    results.push({
      source: "inkstone",
      id: r.id,
      text: r.text,
      score: r.score,
    });
  }

  // ── 2. Gemini fallback ──────────────────────────────────────────
  if (results.length < minimumLocal) {
    const geminiResults = await withRetry(() =>
      client.search(storeName, query, metadataFilter)
    );

    let count = 0;
    for (const gr of geminiResults) {
      if (count >= geminiLimit) break;

      for (const chunk of gr.groundingChunks) {
        if (count >= geminiLimit) break;

        const meta = metadataToRecord(gr.customMetadata);
        results.push({
          source: "gemini",
          id: chunk.chunkId ?? gr.sourceName,
          text: chunk.content,
          score: 0.5, // Gemini doesn't expose scores; use neutral
          geminiMeta: {
            fileName: gr.sourceName,
            customMetadata: meta,
          },
        });
        count++;
      }
    }
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);
  return results;
}

// ── Helpers ─────────────────────────────────────────────────────────

function metadataToRecord(meta: GeminiMetadata[]): Record<string, string> {
  const rec: Record<string, string> = {};
  for (const m of meta) {
    if (m.string_val !== undefined) {
      rec[m.key] = String(m.string_val);
    } else if (m.int_val !== undefined) {
      rec[m.key] = String(m.int_val);
    }
  }
  return rec;
}
