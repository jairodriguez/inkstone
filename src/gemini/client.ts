/**
 * Inkstone — Gemini File Search REST Client
 *
 * NOTE: API paths below are based on Google REST conventions.
 * They may need adjustment once tested against the live API.
 * Endpoint constants are defined at the top for easy patching.
 */

import { GeminiFile, GeminiMetadata, GeminiSearchResult, GeminiStore } from "./types.js";

// ── Configuration ──────────────────────────────────────────────────

const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";

/** API endpoint patterns (adjust if they change) */
const ENDPOINTS = {
  /** List stores: GET /file_search_stores */
  listStores: () => "/file_search_stores",

  /** Create store: POST /file_search_stores */
  createStore: () => "/file_search_stores",

  /** List files: GET /file_search_stores/{store}/files */
  listFiles: (store: string) => `/file_search_stores/${store}/files`,

  /** Import inline file: POST /file_search_stores/{store}/files */
  importFile: (store: string) => `/file_search_stores/${store}/files`,

  /** Search store: POST /file_search_stores/{store}:query
   *  Alternative (unconfirmed): /file_search_stores/{store}/files:search
   */
  search: (store: string) => `/file_search_stores/${store}:query`,
} as const;

// ── Client ───────────────────────────────────────────────────────────

export interface GeminiConfig {
  /** API key. Falls back to GEMINI_API_KEY env var. */
  apiKey?: string;
  /** Base URL. Falls back to GEMINI_BASE_URL env var. */
  baseUrl?: string;
  /** Minimum delay between requests (ms) */
  minDelay?: number;
}

/** HTTP error with status code for retry decisions */
class GeminiAPIError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class GeminiFileSearchClient {
  private apiKey: string;
  private baseUrl: string;
  private lastRequestTime: number = 0;
  private minDelay: number;

  constructor(config: GeminiConfig = {}) {
    const key = config.apiKey ?? GEMINI_API_KEY;
    if (!key) throw new Error("Gemini API key required (GEMINI_API_KEY env var or config.apiKey)");
    this.apiKey = key;
    this.baseUrl = config.baseUrl ?? GEMINI_BASE_URL;
    this.minDelay = config.minDelay ?? 300;
  }

  // ── Low-level request ───────────────────────────────────────────

  private async request(path: string, method: string, body?: unknown): Promise<unknown> {
    // Simple in-memory rate limiter
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.minDelay) {
      await new Promise((r) => setTimeout(r, this.minDelay - elapsed));
    }
    this.lastRequestTime = Date.now();

    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        "x-goog-api-key": this.apiKey,
        "Content-Type": "application/json",
      } as Record<string, string>,
      body: body ? JSON.stringify(body) : undefined,
    });

    // Handle 429 with retry header
    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get("Retry-After") ?? "30", 10);
      await new Promise((r) => setTimeout(r, Math.min(retryAfter, 60) * 1000));
      return this.request(path, method, body); // retry once
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new GeminiAPIError(response.status, `Gemini API ${response.status}: ${text?.slice(0, 500) ?? ""}`);
    }

    return response.json();
  }

  // ── Stores ──────────────────────────────────────────────────────

  /** List available file search stores */
  async listStores(): Promise<GeminiStore[]> {
    const result = (await this.request(ENDPOINTS.listStores(), "GET")) as any;
    return (result?.file_search_stores ?? []).map((s: any) => ({
      name: String(s.name),
      createTime: s.create_time,
      updateTime: s.update_time,
    }));
  }

  /** Create a new store (returns the created store name, caller must be admin on the project) */
  async createStore(name: string): Promise<GeminiStore> {
    const result = (await this.request(ENDPOINTS.createStore(), "POST", { name })) as any;
    return {
      name: String(result?.name ?? name),
      createTime: result?.create_time,
      updateTime: result?.update_time,
    };
  }

  /** List files in a store */
  async listFiles(storeName: string): Promise<GeminiFile[]> {
    const result = (await this.request(ENDPOINTS.listFiles(storeName), "GET")) as any;
    return (result?.files ?? []).map((f: any) => this.toFile(f));
  }

  // ── Upload ──────────────────────────────────────────────────────

  /** Upload inline text with custom metadata.
   *  @returns Gemini file resource name (e.g. "file_search_stores/.../files/abc123") */
  async uploadFile(storeName: string, text: string, metadata: GeminiMetadata[]): Promise<string> {
    const body = {
      inline_source: {
        mime_type: "text/plain",
        data: this.toBase64(text),
      },
      custom_metadata: metadata,
    };
    const result = (await this.request(ENDPOINTS.importFile(storeName), "POST", body)) as any;
    const fileName = result?.name ?? result?.file?.name;
    if (!fileName) {
      throw new GeminiAPIError(500, "Upload response missing file name");
    }
    return fileName;
  }

  // ── Search ──────────────────────────────────────────────────────

  /** Search a store. metadata_filter is a simple AIP-160 equality filter (e.g. "date=2026-05-10") */
  async search(storeName: string, query: string, metadataFilter?: string): Promise<GeminiSearchResult[]> {
    const body: any = { query };
    if (metadataFilter) body.metadata_filter = metadataFilter;
    const result = (await this.request(ENDPOINTS.search(storeName), "POST", body)) as any;
    const results = result?.retrieval_results ?? result?.results ?? [];
    return results.map((r: any) => this.toSearchResult(r));
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private toBase64(text: string): string {
    // Node.js Buffer supports base64 natively
    return Buffer.from(text, "utf-8").toString("base64");
  }

  private toFile(f: any): GeminiFile {
    return {
      name: String(f.name),
      downloadUri: f.download_uri as string | undefined,
      customMetadata: (f.custom_metadata ?? []).map((m: any) => ({
        key: String(m.key),
        string_val: m.string_val as string | undefined,
        int_val: m.int_val as number | undefined,
      })),
    };
  }

  private toSearchResult(r: any): GeminiSearchResult {
    return {
      sourceName: String(r.source?.name ?? r.name ?? ""),
      downloadUri: String(r.source?.download_uri ?? r.download_uri ?? ""),
      customMetadata: (r.source?.custom_metadata ?? r.custom_metadata ?? []).map((m: any) => ({
        key: String(m.key),
        string_val: m.string_val as string | undefined,
        int_val: m.int_val as number | undefined,
      })),
      groundingChunks: (r.grounding_chunks ?? []).map((c: any) => ({
        content: String(c.content ?? ""),
        pageNumber: c.page_number as number | undefined,
        chunkId: c.chunk_id as string | undefined,
      })),
    };
  }
}

// ── Retry wrapper for rate limits ──────────────────────────────────

export async function withRetry<T>(
  fn: () => Promise<T>,
  { maxRetries = 3, baseDelay = 1000 }: { maxRetries?: number; baseDelay?: number } = {}
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const isLast = attempt === maxRetries;
      const is429 = err instanceof GeminiAPIError && err.status === 429;
      if (!is429 || isLast) throw err;
      // Exponential backoff
      const delay = baseDelay * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("Retry exhausted");
}
