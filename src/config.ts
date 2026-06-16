/**
 * Inkstone — Configuration
 *
 * All paths, weights, decay params, memory types, and shared utilities.
 * Configuration is fully environment-variable driven.
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// ── Paths ──────────────────────────────────────────────────────────

export const INKSTONE_ROOT = process.env.INKSTONE_ROOT ||
  join(process.env.HOME || "/tmp", ".inkstone");

export const DB_PATH = process.env.INKSTONE_DB || join(INKSTONE_ROOT, "inkstone-full.db");
export const WIKI_DIR = process.env.INKSTONE_WIKI || join(INKSTONE_ROOT, "wiki");
export const ARCHIVE_DIR = join(INKSTONE_ROOT, "archive");

export const FILE_INGEST_EXCLUDE_DIRS = new Set([
  "node_modules", "dist", "build", ".git", ".next", "coverage",
  ".DS_Store", ".cache", ".turso", ".opencode", ".inkstone",
  ".claude", ".hermes", ".config", "uploads", "__pycache__",
  ".venv", "venv", ".tox", ".mypy_cache",
  "wiki", "vector_memory",
  ".firecrawl", "logs",
]);

export const FILE_INGEST_EXCLUDE_EXTENSIONS = new Set([
  ".lock", ".log", ".db", ".sqlite", ".sqlite3",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg", ".webp",
  ".mp3", ".mp4", ".wav", ".ogg", ".flac",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".wasm", ".so", ".dylib", ".dll", ".exe",
  ".pyc", ".pyo", ".class", ".o", ".obj",
  ".cpuprofile", ".heapsnapshot",
]);

export const WIKI_NAMESPACES = {
  business: join(WIKI_DIR, "business"),
  content: join(WIKI_DIR, "content"),
  system: join(WIKI_DIR, "system"),
  entities: join(WIKI_DIR, "entities"),
  concepts: join(WIKI_DIR, "concepts"),
  decisions: join(WIKI_DIR, "decisions"),
  agents: join(WIKI_DIR, "agents"),
  summaries: join(WIKI_DIR, "summaries"),
} as const;

export function ensureDir(p: string): void {
  mkdirSync(p, { recursive: true });
}

// ── Memory Types ───────────────────────────────────────────────────

export const MEMORY_TYPES = [
  "fact",
  "preference",
  "event",
  "context",
  "procedural",
  "decision",
  "correction",
  "lesson",
  "contact",
  "financial",
  "blocker",
  "milestone",
  "emotion",
] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

/** Regex patterns for heuristic memory type detection */
const TYPE_PATTERNS: Array<[RegExp, MemoryType]> = [
  [/prefer|like|want|always|never|should/i, "preference"],
  [/decided|chose|switched|went with|adopted/i, "decision"],
  [/fix|fixed|bug|error|issue|root cause/i, "correction"],
  [/lesson|learned|takeaway|insight/i, "lesson"],
  [/contact|email|phone|reach|dm|slack/i, "contact"],
  [/\$\d|cost|price|revenue|budget|invoice/i, "financial"],
  [/blocked|stuck|can't|failed|won't work/i, "blocker"],
  [/launched|shipped|released|milestone|completed/i, "milestone"],
  [/feel|frustrat|excit|worri|happy|annoy/i, "emotion"],
  [/how to|steps|process|procedure|run|execute/i, "procedural"],
  [/happened|occurred|event|incident| outage/i, "event"],
  [/context|background|situation|currently/i, "context"],
];

export function detectMemoryType(text: string): MemoryType {
  for (const [re, type] of TYPE_PATTERNS) {
    if (re.test(text)) return type;
  }
  return "fact";
}

// ── Decay System ───────────────────────────────────────────────────

/** Half-life in days per memory type */
export const MEMORY_TYPE_HALF_LIVES: Record<MemoryType, number> = {
  correction: 3650,
  preference: 3650,
  milestone: 3650,
  procedural: 180,
  decision: 90,
  lesson: 90,
  fact: 30,
  event: 14,
  context: 14,
  contact: 365,
  financial: 7,
  blocker: 7,
  emotion: 3,
};

export function getHalfLife(type: MemoryType): number {
  return MEMORY_TYPE_HALF_LIVES[type] ?? 30;
}

/**
 * Exponential decay score.
 * @param baseScore  Starting score (default 1.0)
 * @param ageDays    Days since creation / last access
 * @param halfLife   Half-life in days for this memory type
 */
export function decayScore(baseScore: number, ageDays: number, halfLife: number): number {
  if (halfLife <= 0) return baseScore;
  return baseScore * Math.pow(0.5, ageDays / halfLife);
}

// ── Scoring Weights ────────────────────────────────────────────────

/** Source trust multipliers */
export const SOURCE_TRUST: Record<string, number> = {
  evergreen: 2.0,
  business: 1.5,
  correction: 1.5,
  decision: 1.3,
  entity: 1.2,
  concept: 1.1,
  memory: 1.0,
  summary: 1.0,
  tasks: 1.0,
  chatgpt_import: 0.8,
  raw: 0.6,
};

/** Knowledge type weight multipliers */
export const KNOWLEDGE_TYPE_WEIGHT: Record<string, number> = {
  correction: 3.0,
  preference: 2.0,
  decision: 1.5,
  lesson: 1.5,
  milestone: 1.3,
  procedural: 1.2,
  fact: 1.0,
  event: 0.8,
  context: 0.7,
  contact: 1.0,
  financial: 2.0,
  blocker: 1.5,
  emotion: 0.5,
};

/** TTL-based recency weight (days) */
export const KNOWLEDGE_TYPE_TTL: Record<string, number> = {
  correction: 3650,
  preference: 3650,
  decision: 365,
  lesson: 365,
  milestone: 3650,
  procedural: 180,
  fact: 90,
  event: 30,
  context: 14,
  contact: 365,
  financial: 7,
  blocker: 7,
  emotion: 7,
};

// ── Domain / Namespace Detection ───────────────────────────────────

export type Domain = "business" | "content" | "system";

const DOMAIN_KEYWORDS: Record<Domain, string[]> = {
  business: [
    "revenue", "invoice", "client", "customer", "crm", "sales", "shipping",
    "bookkeeping", "outreach", "brand", "seo",
    "lead", "pipeline", "deal", "contract", "pricing",
  ],
  content: [
    "tweet", "thread", "newsletter", "blog", "video", "youtube", "podcast",
    "content", "social", "audience", "engagement", "hook",
    "title",
  ],
  system: [
    "agent", "plugin", "mcp", "config",
    "database", "migration", "deploy", "docker", "server", "api", "token",
    "memory", "inkstone", "dream",
  ],
};

export function detectDomain(text: string): Domain {
  const lower = text.toLowerCase();
  let best: Domain = "system";
  let bestCount = 0;
  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS) as [Domain, string[]][]) {
    const count = keywords.filter((k) => lower.includes(k)).length;
    if (count > bestCount) {
      bestCount = count;
      best = domain;
    }
  }
  return best;
}

// ── LLM Config ─────────────────────────────────────────────────────

export const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
export const OLLAMA_CHAT_MODEL = process.env.INKSTONE_OLLAMA_MODEL || "gemma4:e4b";
export const OLLAMA_EMBED_MODEL = process.env.INKSTONE_EMBED_MODEL || "nomic-embed-text";

export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
export const OPENROUTER_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_MODEL = process.env.INKSTONE_OR_MODEL || "google/gemini-2.0-flash-001";
export const OPENROUTER_FALLBACK = process.env.INKSTONE_OR_FALLBACK || "minimax/minimax-m2.5:free";

export const OPENAI_EMBED_MODEL = "text-embedding-3-small";
export const OPENAI_EMBEDDING_DIMS = 1536;
export const OLLAMA_EMBEDDING_DIMS = 768;
export const EMBEDDING_DIMS = process.env.INKSTONE_EMBEDDING_PROVIDER === "openai"
  ? OPENAI_EMBEDDING_DIMS
  : OLLAMA_EMBEDDING_DIMS;

// ── Embedding + Chunking ───────────────────────────────────────────

export const CHUNK_SIZE_LINES = 40;
export const EMBED_MAX_CHARS = 8000;

// ── Trivia Detection ───────────────────────────────────────────────

export const TRIVIA_PATTERNS: RegExp[] = [
  /\b(?:capital|population|area|currency|language|continent)\s+(?:of|is)\b/i,
  /\b(?:born|died|founded|established)\s+(?:in|on)\s+\d{4}\b/i,
  /\b(?:located|situated)\s+in\s+(?:the|a|an)\b/i,
  /\b(?:known|famous)\s+for\b/i,
  /\b(?:river|mountain|lake|ocean|sea)\s+(?:of|in)\b/i,
];

export const MIN_SPECIFICITY_SCORE = 0.5;
export const DEDUP_THRESHOLD = 0.88;
export const MIN_SUMMARY_CHARS = 500;
export const DECAY_PRUNE_THRESHOLD = 0.05;

// ── Utility ────────────────────────────────────────────────────────

export function hashContent(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function isTrivia(text: string): boolean {
  return TRIVIA_PATTERNS.some((p) => p.test(text));
}

export function computeSpecificityScore(text: string): number {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return 0;

  let nonTrivia = 0;
  let bonus = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!isTrivia(trimmed)) nonTrivia++;
    if (/\/[\w.-]+(?:\.\w+)+/.test(trimmed)) bonus += 0.15; // file paths
    if (/decided|chose|switched|went with/i.test(trimmed)) bonus += 0.15; // decisions
    if (/\b\d{1,3}(?:\.\d{1,3}){3}\b|\b0x[0-9a-f]+\b/.test(trimmed)) bonus += 0.15; // specifics
  }

  const ratio = nonTrivia / lines.length;
  return Math.min(1.0, ratio + bonus);
}

// ── Lifecycle ──────────────────────────────────────────────────────

export const LIFECYCLE_STATES = ["active", "validated", "stale", "archived"] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

/** Accesses required to promote active → validated */
export const VALIDATED_ACCESS_THRESHOLD = 3;
/** Days without access before stale */
export const STALE_DAYS = 14;
/** Days stale before archived */
export const ARCHIVED_DAYS = 28;
