/**
 * Inkstone — Gemini File Search Types
 */

/** Gemini custom_metadata entry */
export interface GeminiMetadata {
  key: string;
  string_val?: string;
  int_val?: number;
}

/** Gemini File resource (returned after upload) */
export interface GeminiFile {
  /** Full resource name: file_search_stores/{store}/files/{id} */
  name: string;
  /** Download URL (temporary) */
  downloadUri?: string;
  customMetadata: GeminiMetadata[];
}

/** Individual grounding chunk from search */
export interface GeminiGroundingChunk {
  content: string;
  pageNumber?: number;
  chunkId?: string;
}

/** Search result from Gemini File Search */
export interface GeminiSearchResult {
  sourceName: string;
  downloadUri: string;
  customMetadata: GeminiMetadata[];
  groundingChunks: GeminiGroundingChunk[];
}

/** File Search Store resource */
export interface GeminiStore {
  name: string;
  createTime?: string;
  updateTime?: string;
}
