/**
 * Inkstone — Gemini Deep Archive Module
 *
 * Provides:
 * - GeminiFileSearchClient — REST API client for Gemini File Search
 * - syncInkstoneToGemini — batch upload pipeline
 * - queryInkstoneWithGeminiFallback — local + deep archive query
 */

export { GeminiFileSearchClient, withRetry } from "./client.js";
export type { GeminiConfig } from "./client.js";
export { syncInkstoneToGemini } from "./sync.js";
export type { SyncResult, SyncOptions } from "./sync.js";
export { queryInkstoneWithGeminiFallback } from "./query.js";
export type { CombinedResult, QueryOptions } from "./query.js";
export type { GeminiFile, GeminiMetadata, GeminiSearchResult, GeminiStore } from "./types.js";
