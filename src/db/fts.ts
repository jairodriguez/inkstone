/**
 * Inkstone — Full-Text Search Index
 *
 * Custom inverted index with Porter stemmer + unicode61 tokenizer.
 * Backed by a SQLite table for persistence.
 */

import type { Database as SqlJsDatabase } from "../db/schema.js";

// ── Simple Porter Stemmer ───────────────────────────────────────────

const STEP2A = /(?:ational|tional|enci|anci|izer|bli|alli|entli|eli|ousli|ization|ation|ator|alism|iveness|fulness|ousness|aliti|iviti|biliti|logi)$/;
const STEP2B = /(?:e|ed|ing)$/;
const STEP3 = /(?:icate|ative|alize|iciti|ical|ful|ness)$/;
const STEP4 = /(?:al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ion|ou|ism|ate|iti|ous|ive|ize)$/;

const STOP_WORDS = new Set([
  "the","a","an","and","or","but","is","was","are","were","be","been","being",
  "have","has","had","do","does","did","will","would","could","should","may",
  "might","shall","can","not","no","this","that","these","those","it","its",
  "we","they","them","their","our","your","my","his","her","from","with",
  "for","into","over","after","before","under","about","between","through",
  "during","without","than","then","also","just","very","often","most",
  "some","any","all","each","every","both","few","more","many","much",
  "such","only","own","same","other","when","where","how","what","which",
  "who","whom","there","here","if","so","up","out","on","off","in","by",
  "at","to","of","as","via","per","etc","eg","ie","vs","via",
]);

function porterStem(word: string): string {
  if (word.length < 3) return word;
  let s = word.toLowerCase();

  s = s.replace(/sses$/, "ss").replace(/ies$/, "i").replace(/ss$/, "ss").replace(/s$/, "");

  if (STEP2B.test(s)) {
    const stem = s.replace(STEP2B, "");
    if (/eed$/.test(s) && stem.length > 0) {
      s = s.replace(/eed$/, "ee");
    } else if (/(at|bl|iz)$/.test(stem)) {
      s = stem + "e";
    } else if (/(.)\1$/.test(stem) && !/(l|s|z)$/.test(stem)) {
      s = stem.slice(0, -1);
    } else if (stem.length > 2 && stem.length < 5) {
      s = stem + "e";
    } else {
      s = stem;
    }
  }

  s = s.replace(/y$/, "i");

  s = s.replace(STEP2A, (m) => {
    if (m === "ational") return "ate";
    if (m === "tional") return "tion";
    if (m === "enci") return "ence";
    if (m === "anci") return "ance";
    if (m === "izer") return "ize";
    if (m === "bli") return "ble";
    if (m === "alli") return "al";
    if (m === "entli") return "ent";
    if (m === "eli") return "e";
    if (m === "ousli") return "ous";
    if (m === "ization") return "ize";
    if (m === "ation") return "ate";
    if (m === "ator") return "ate";
    if (m === "alism") return "al";
    if (m === "iveness") return "ive";
    if (m === "fulness") return "ful";
    if (m === "ousness") return "ous";
    if (m === "aliti") return "al";
    if (m === "iviti") return "ive";
    if (m === "biliti") return "ble";
    if (m === "logi") return "log";
    return m;
  });

  s = s.replace(STEP3, (m) => {
    if (m === "icate") return "ic";
    if (m === "ative") return "";
    if (m === "alize") return "al";
    if (m === "iciti") return "ic";
    if (m === "ical") return "ic";
    if (m === "ful") return "";
    if (m === "ness") return "";
    return m;
  });

  s = s.replace(STEP4, (m) => {
    if (m.startsWith("ion") && s.length > 4 && /[st]$/.test(s[s.length - 4])) return "ion";
    return "";
  });

  if (s.endsWith("e") && s.length > 3) {
    const stem = s.slice(0, -1);
    const cvc = /[^aeiou][aeiouy][^aeiouy]/.test(stem.slice(-3));
    if (!cvc || stem.length > 3) s = stem;
  }

  if (s.endsWith("ll") && s.length > 4) s = s.slice(0, -1);

  return s;
}

// ── Tokenizer ──────────────────────────────────────────────────────

export function tokenize(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));

  const stemmed = new Set(tokens.map(porterStem));
  return Array.from(stemmed);
}

// ── Inverted Index ─────────────────────────────────────────────────

const FTS_TABLE = "fts_index";

export function ensureFtsTable(db: SqlJsDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${FTS_TABLE} (
      term       TEXT NOT NULL,
      chunk_id   TEXT NOT NULL,
      tf         REAL NOT NULL DEFAULT 1.0,
      PRIMARY KEY (term, chunk_id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_fts_term ON ${FTS_TABLE}(term)`);
}

export function indexChunk(db: SqlJsDatabase, chunkId: string, text: string): void {
  const tokens = tokenize(text);
  if (tokens.length === 0) return;

  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);

  const isReindex = db.prepare(`SELECT 1 FROM ${FTS_TABLE} WHERE chunk_id = ? LIMIT 1`).get(chunkId);
  db.prepare(`DELETE FROM ${FTS_TABLE} WHERE chunk_id = ?`).run(chunkId);

  const insertStmt = db.prepare(`INSERT OR REPLACE INTO ${FTS_TABLE} (term, chunk_id, tf) VALUES (?, ?, ?)`);
  for (const [term, count] of tf) {
    insertStmt.run(term, chunkId, count / tokens.length);
  }

  if (!isReindex) {
    try { db.prepare("DELETE FROM meta WHERE key = 'total_doc_count'").run(); } catch {}
  }
}

export function removeChunkFromIndex(db: SqlJsDatabase, chunkId: string): void {
  db.prepare(`DELETE FROM ${FTS_TABLE} WHERE chunk_id = ?`).run(chunkId);
  try { db.prepare("DELETE FROM meta WHERE key = 'total_doc_count'").run(); } catch {}
}

export interface FtsResult {
  chunkId: string;
  score: number;
}

export function getTotalDocCount(db: SqlJsDatabase): number {
  const cached = db.prepare("SELECT value FROM meta WHERE key = 'total_doc_count'").get() as { value: string } | undefined;
  if (cached?.value) return Number(cached.value);
  const row = db.prepare(`SELECT COUNT(DISTINCT chunk_id) as cnt FROM ${FTS_TABLE}`).get() as { cnt: number };
  const N = row?.cnt || 1;
  try { db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('total_doc_count', ?)").run(String(N)); } catch {}
  return N;
}

export function invalidateDocCountCache(db: SqlJsDatabase): void {
  try { db.prepare("DELETE FROM meta WHERE key = 'total_doc_count'").run(); } catch {}
}

export function searchFts(db: SqlJsDatabase, query: string, limit = 50): FtsResult[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  const N = getTotalDocCount(db);

  const scores = new Map<string, number>();
  const placeholders = terms.map(() => "?").join(",");

  const rows = db.prepare(
    `SELECT term, chunk_id, tf FROM ${FTS_TABLE} WHERE term IN (${placeholders})`
  ).all(...terms) as Array<{ term: string; chunk_id: string; tf: number }>;

  if (rows.length === 0) return [];

  const df = new Map<string, number>();
  for (const r of rows) df.set(r.term, (df.get(r.term) || 0) + 1);

  const k1 = 1.2, b = 0.75;
  for (const r of rows) {
    const docFreq = df.get(r.term) || 1;
    const idf = Math.log((N - docFreq + 0.5) / (docFreq + 0.5) + 1);
    const tfNorm = (r.tf * (k1 + 1)) / (r.tf + k1 * (1 - b + b));
    const score = idf * tfNorm;
    scores.set(r.chunk_id, (scores.get(r.chunk_id) || 0) + score);
  }

  return Array.from(scores.entries())
    .map(([chunkId, score]) => ({ chunkId, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function rebuildFtsIndex(db: SqlJsDatabase): number {
  db.exec(`DELETE FROM ${FTS_TABLE}`);

  const rows = db.prepare("SELECT id, text FROM chunks").all() as Array<{ id: string; text: string }>;
  let count = 0;
  for (const r of rows) {
    indexChunk(db, r.id, r.text);
    count++;
  }

  return count;
}
