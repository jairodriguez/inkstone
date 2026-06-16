/**
 * Inkstone — Dream Cycle
 *
 * The maintenance/consolidation pipeline. 14 steps, each independent.
 */

import type { Database as SqlJsDatabase } from "../db/schema.js";
import {
  MIN_SPECIFICITY_SCORE, DECAY_PRUNE_THRESHOLD,
  hashContent, detectDomain, detectMemoryType, type MemoryType,
  WIKI_NAMESPACES, ARCHIVE_DIR, ensureDir,
} from "../config.js";
import {
  applyExponentialDecay, pruneExpired, transitionLifecycle,
  buildEntityCooccurrenceGraph, buildGraphEdges, syncWikiIndex, writeChunk,
  yieldToEventLoop, saveDb,
} from "../db/schema.js";
import { LLMClient, type LLMMessage } from "../llm/client.js";

export interface DreamResult {
  step: string;
  status: "ok" | "error" | "skipped";
  detail?: string;
  count?: number;
  error?: string;
}

export interface DreamCycleOptions {
  steps?: number[];
  stepTimeoutMs?: number;
}

const DEFAULT_STEP_TIMEOUT_MS = 20 * 60 * 1000;

export async function runDreamCycle(
  db: SqlJsDatabase,
  llm: LLMClient,
  stepsOrOptions?: number[] | DreamCycleOptions,
): Promise<DreamResult[]> {
  const options: DreamCycleOptions = Array.isArray(stepsOrOptions)
    ? { steps: stepsOrOptions }
    : stepsOrOptions ?? {};
  const stepTimeout = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;

  const allSteps: Array<{ n: number; name: string; fn: () => Promise<string> }> = [
    { n: 1, name: "exponential_decay", fn: async () => `updated=${await applyExponentialDecay(db)}` },
    { n: 2, name: "lifecycle_transitions", fn: async () => `transitions=${await transitionLifecycle(db)}` },
    { n: 3, name: "entity_extraction", fn: () => extractEntities(db) },
    { n: 4, name: "trivia_pruning", fn: () => triviaPrune(db) },
    { n: 5, name: "wiki_reindex", fn: async () => { const r = await syncWikiIndex(db); return `indexed=${r.indexed}, deleted=${r.deleted}`; } },
    { n: 6, name: "prune_expired", fn: async () => `pruned=${await pruneExpired(db)}` },
    { n: 7, name: "graph_edges", fn: async () => `edges=${await buildGraphEdges(db, 2)}` },
    { n: 8, name: "contradiction_detection", fn: () => detectContradictions(db, llm) },
    { n: 9, name: "goal_inference", fn: () => inferGoals(db, llm) },
    { n: 10, name: "failure_patterns", fn: () => detectFailurePatterns(db, llm) },
    { n: 11, name: "causal_links", fn: () => extractCausalLinks(db, llm) },
    { n: 12, name: "hypothesis_scan", fn: () => scanHypotheses(db, llm) },
    { n: 13, name: "self_model_update", fn: () => updateSelfModel(db, llm) },
    { n: 14, name: "distill_clusters", fn: () => distillClusters(db, llm) },
  ];

  const toRun = options.steps ? allSteps.filter((s) => options.steps!.includes(s.n)) : allSteps;
  const results: DreamResult[] = [];

  for (const step of toRun) {
    const controller = new AbortController();
    llm.currentSignal = controller.signal;

    try {
      const detail = await withTimeout(
        step.fn(),
        stepTimeout,
        step.name,
        () => controller.abort(),
      );
      results.push({ step: `${step.n}. ${step.name}`, status: "ok", detail });
    } catch (err) {
      const msg = String(err);
      if (msg.startsWith("TIMEOUT:")) {
        results.push({ step: `${step.n}. ${step.name}`, status: "skipped", detail: msg });
      } else {
        results.push({ step: `${step.n}. ${step.name}`, status: "error", error: msg });
      }
    } finally {
      llm.currentSignal = undefined;
    }
  }

  // Flush pending DB changes to disk
  await yieldToEventLoop();
  saveDb(db, true);
  return results;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string, onAbort?: () => void): Promise<T> {
  let settled = false;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      onAbort?.();
      console.log(`  ⊘ ${label}: TIMEOUT (exceeded ${Math.round(ms / 1000)}s), aborting...`);
      reject(new Error(`TIMEOUT: ${label} exceeded ${Math.round(ms / 1000)}s`));
    }, ms);

    promise.then(
      (val) => { if (!settled) { settled = true; clearTimeout(timer); resolve(val); } },
      (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } },
    );
  });
}

// ── Helpers ────────────────────────────────────────────────────────

/** Clean LLM JSON output */
function parseJsonResponse(text: string): unknown {
  let cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  if (!cleaned.startsWith("[")) cleaned = "[" + cleaned;
  if (!cleaned.endsWith("]")) cleaned = cleaned + "]";
  cleaned = cleaned.replace(/\}\s*\{/g, "},{");
  cleaned = cleaned.replace(/,\s*\]/g, "]");
  try {
    return JSON.parse(cleaned);
  } catch (e1) {
    const m = cleaned.match(/\[[\s\S]*?\]/);
    if (m) {
      let candidate = m[0].replace(/,\s*\]/g, "]");
      try { return JSON.parse(candidate); } catch {}
      try { return JSON.parse(candidate + "]"); } catch {}
    }
    const objMatch = cleaned.match(/\{[\s\S]*?\}/g);
    if (objMatch && objMatch.length > 0) {
      const arr = "[" + objMatch.join(",") + "]";
      try { return JSON.parse(arr); } catch {}
    }
    throw new Error(`No JSON array found (first 200): ${text.slice(0, 200)}`);
  }
}

// ── Step 3: Entity Extraction ──────────────────────────────────────

const SKIP_ENTITY = new Set([
  "the", "a", "an", "this", "that", "it", "we", "they", "you", "i",
  "our", "their", "your", "my", "is", "was", "are", "were", "be",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "not", "no", "but", "and", "or", "if", "then", "so", "for",
]);

async function extractEntities(db: SqlJsDatabase): Promise<string> {
  const { writeFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");

  const chunks = db.prepare(`
    SELECT id, text, namespace FROM chunks
    WHERE source = 'summary' AND lifecycle NOT IN ('archived')
  `).all() as Array<{ id: string; text: string; namespace: string }>;

  const wikiLinkPattern = /\[\[([^|\]]+)(?:\|[^\]]+)?\]\]/g;
  const entitiesMentioned = new Map<string, number>();

  for (const chunk of chunks) {
    let match: RegExpExecArray | null;
    wikiLinkPattern.lastIndex = 0;
    while ((match = wikiLinkPattern.exec(chunk.text)) !== null) {
      const entity = match[1].trim().toLowerCase();
      if (entity && !SKIP_ENTITY.has(entity)) {
        entitiesMentioned.set(entity, (entitiesMentioned.get(entity) || 0) + 1);
      }
    }
  }

  const entityDir = WIKI_NAMESPACES.entities;
  ensureDir(entityDir);
  let created = 0;

  let ei = 0;
  for (const [entity, count] of entitiesMentioned) {
    if (count < 2) continue;
    const slug = entity.replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    const entityPath = join(entityDir, `${slug}.md`);
    if (!existsSync(entityPath)) {
      writeFileSync(entityPath, [
        `---\ntitle: "${entity}"\ntype: entity\nmentions: ${count}\ncreated: ${new Date().toISOString()}\n---\n`,
        `# ${entity.charAt(0).toUpperCase() + entity.slice(1)}\n`,
        `*Auto-extracted entity. Mentioned in ${count} sources.*\n`,
      ].join("\n"), "utf-8");
      created++;
    }
    ei++;
    if (ei % 200 === 0) await yieldToEventLoop();
  }

  return `entities_created=${created}, tracked=${entitiesMentioned.size}`;
}

// ── Step 4: Trivia Pruning ─────────────────────────────────────────

async function triviaPrune(db: SqlJsDatabase): Promise<string> {
  const rows = db.prepare(`
    SELECT id, text, specificity_score FROM chunks
    WHERE lifecycle NOT IN ('archived') AND source = 'summary' AND valid_to IS NULL
  `).all() as Array<{ id: string; text: string; specificity_score: number | null }>;
  let pruned = 0;
  const updateStmt = db.prepare("UPDATE chunks SET valid_to = ? WHERE id = ? AND valid_to IS NULL");
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const score = Number(row.specificity_score) || 0;
    const isGeoTrivia = /\b(?:capital|population|area|continent|river|mountain)\b/i.test(row.text);
    if (score < MIN_SPECIFICITY_SCORE || (isGeoTrivia && score < 0.7)) {
      updateStmt.run(new Date().toISOString(), row.id);
      pruned++;
    }
    if (i % 500 === 0 && i > 0) await yieldToEventLoop();
  }
  return `pruned=${pruned}`;
}

// ── Step 8: Contradiction Detection ────────────────────────────────

async function detectContradictions(db: SqlJsDatabase, llm: LLMClient): Promise<string> {
  const rows = db.prepare(`
    SELECT r.from_chunk_id, r.to_chunk_id, c1.text AS text_a, c2.text AS text_b
    FROM memory_relations r
    JOIN chunks c1 ON r.from_chunk_id = c1.id
    JOIN chunks c2 ON r.to_chunk_id = c2.id
    WHERE r.relation_type = 'related_by_topic'
      AND c1.lifecycle NOT IN ('archived')
      AND c2.lifecycle NOT IN ('archived')
    ORDER BY r.weight DESC LIMIT 200
  `).all() as Array<{ from_chunk_id: string; to_chunk_id: string; text_a: string; text_b: string }>;

  if (rows.length === 0) return "no_pairs_found";

  const pairs = rows.map((r) => ({ fromId: r.from_chunk_id, toId: r.to_chunk_id, textA: r.text_a, textB: r.text_b }));

  let contradictionsFound = 0, duplicatesMerged = 0;
  const batchSize = 10;

  for (let i = 0; i < pairs.length && contradictionsFound + duplicatesMerged < 20; i += batchSize) {
    if (llm.currentSignal?.aborted) break;

    const batch = pairs.slice(i, i + batchSize);
    const pairTexts = batch.map((p, idx) =>
      `PAIR ${idx + 1}:\nA: ${p.textA.slice(0, 500)}\nB: ${p.textB.slice(0, 500)}`
    ).join("\n\n");

    try {
      const response = await llm.chat([
        { role: "system", content: `Classify each pair: "contradicts", "duplicate", or "distinct". JSON array only: [{"pair": N, "relation": "contradicts"|"duplicate"|"distinct"}]` },
        { role: "user", content: pairTexts },
      ]);
      const classifications = parseJsonResponse(response.text) as Array<{ pair: number; relation: string }>;

      for (const cls of classifications) {
        const pair = batch[cls.pair - 1];
        if (!pair) continue;
        const edgeId = `edge:${pair.toId}:${pair.fromId}:supersedes`;
        try {
          db.prepare(
            "INSERT INTO memory_relations (id, from_chunk_id, to_chunk_id, relation_type, weight) VALUES (?, ?, ?, 'supersedes', ?)"
          ).run(edgeId, pair.toId, pair.fromId, cls.relation === "contradicts" ? 2.0 : 1.5);
          if (cls.relation === "contradicts") contradictionsFound++;
          else if (cls.relation === "duplicate") duplicatesMerged++;
        } catch { /* duplicate edge */ }
      }
    } catch { /* LLM failed */ }
  }

  return `contradictions=${contradictionsFound}, duplicates=${duplicatesMerged}`;
}

// ── Step 9: Goal Inference ─────────────────────────────────────────

async function inferGoals(db: SqlJsDatabase, llm: LLMClient): Promise<string> {
  const chunks = db.prepare(
    `SELECT id, text, namespace FROM chunks WHERE lifecycle NOT IN ('archived') ORDER BY created_at DESC LIMIT 20`
  ).all() as Array<{ id: string; text: string; namespace: string }>;

  if (chunks.length === 0) return "no_chunks";

  const texts = chunks.map((c, i) => `[${i + 1}] ${c.text.slice(0, 400)}`).join("\n\n");

  try {
    const response = await llm.chat([
      { role: "system", content: `Output ONLY a JSON array. No prose. No markdown. Format: [{"chunk_index": N, "goal": "description"}]. Empty: [].` },
      { role: "user", content: texts },
      { role: "assistant", content: "[" },
    ]);
    const raw = response.text.trim();
    const goals = parseJsonResponse(raw) as Array<{ chunk_index: number; goal: string }>;

    const insertStmt = db.prepare("INSERT INTO goals (title, source_chunk_id, namespace) VALUES (?, ?, ?)");
    for (const g of goals) {
      const chunk = chunks[g.chunk_index - 1];
      if (chunk) {
        try { insertStmt.run(g.goal, chunk.id, chunk.namespace); }
        catch { /* duplicate */ }
      }
    }
    return `goals_inferred=${goals.length}`;
  } catch (err) { return `error: ${err}`; }
}

// ── Step 10: Failure Patterns ──────────────────────────────────────

async function detectFailurePatterns(db: SqlJsDatabase, llm: LLMClient): Promise<string> {
  const chunks = db.prepare(
    `SELECT id, text, namespace FROM chunks WHERE lifecycle NOT IN ('archived')
     AND (text LIKE '%failed%' OR text LIKE '%error%' OR text LIKE '%bug%' OR text LIKE '%blocked%')
     ORDER BY created_at DESC LIMIT 15`
  ).all() as Array<{ id: string; text: string; namespace: string }>;

  if (chunks.length < 2) return "too_few_failures";

  const texts = chunks.map((c, i) => `[${i + 1}] ${c.text.slice(0, 300)}`).join("\n\n");

  try {
    const response = await llm.chat([
      { role: "system", content: `Output ONLY a JSON array. No prose. No markdown. Format: [{"pattern": "description", "chunk_indices": [N, M]}]. Empty: [].` },
      { role: "user", content: texts },
      { role: "assistant", content: "[" },
    ]);
    const patterns = parseJsonResponse(response.text.trim()) as Array<{ pattern: string; chunk_indices: number[] }>;

    let found = 0;
    const insertStmt = db.prepare("INSERT INTO failure_patterns (pattern_text, namespace, source_chunk_ids, occurrence_count) VALUES (?, ?, ?, ?)");
    for (const p of patterns) {
      const ids = p.chunk_indices?.filter((idx: number) => idx >= 1 && idx <= chunks.length).map((idx: number) => chunks[idx - 1].id) || [];
      if (ids.length > 1) {
        try {
          insertStmt.run(p.pattern, chunks[0].namespace, JSON.stringify(ids), ids.length);
          found++;
        } catch { /* duplicate */ }
      }
    }
    return `patterns=${found}`;
  } catch (err) { return `error: ${err}`; }
}

// ── Step 11: Causal Links ──────────────────────────────────────────

async function extractCausalLinks(db: SqlJsDatabase, llm: LLMClient): Promise<string> {
  const chunks = db.prepare(
    `SELECT id, text FROM chunks WHERE lifecycle NOT IN ('archived') ORDER BY created_at DESC LIMIT 15`
  ).all() as Array<{ id: string; text: string }>;

  if (chunks.length < 2) return "too_few_chunks";

  const texts = chunks.map((c, i) => `[${i + 1}] ${c.text.slice(0, 300)}`).join("\n\n");

  try {
    const response = await llm.chat([
      { role: "system", content: `Output ONLY a JSON array. No prose. No markdown. Format: [{"cause_index": N, "effect_index": M, "description": "brief"}]. Empty: [].` },
      { role: "user", content: texts },
      { role: "assistant", content: "[" },
    ]);
    const links = parseJsonResponse(response.text.trim()) as Array<{ cause_index: number; effect_index: number }>;

    let created = 0;
    const insertStmt = db.prepare("INSERT INTO memory_relations (id, from_chunk_id, to_chunk_id, relation_type, weight) VALUES (?, ?, ?, 'causes', 1.5)");
    for (const link of links) {
      const cause = chunks[link.cause_index - 1];
      const effect = chunks[link.effect_index - 1];
      if (cause && effect && cause.id !== effect.id) {
        try {
          insertStmt.run(`causal:${cause.id}:${effect.id}`, cause.id, effect.id);
          created++;
        } catch { /* duplicate */ }
      }
    }
    return `causal_links=${created}`;
  } catch (err) { return `error: ${err}`; }
}

// ── Step 12: Hypothesis Scan ───────────────────────────────────────

async function scanHypotheses(db: SqlJsDatabase, llm: LLMClient): Promise<string> {
  const hRows = db.prepare(`SELECT id, statement, confidence FROM hypotheses WHERE status = 'open'`).all() as Array<{ id: string; statement: string; confidence: number }>;
  if (hRows.length === 0) return "no_open_hypotheses";

  const cRows = db.prepare(`SELECT text FROM chunks WHERE lifecycle NOT IN ('archived') ORDER BY created_at DESC LIMIT 50`).all() as Array<{ text: string }>;
  const evidence = cRows.map((r) => r.text.slice(0, 400)).join("\n---\n");

  const hypotheses = hRows.map((h, i) =>
    `[${i + 1}] "${h.statement}" (confidence: ${h.confidence})`
  ).join("\n");

  try {
    const response = await llm.chat([
      { role: "system", content: `Confirm or reject hypotheses based on evidence? JSON array: [{"hypothesis_index": N, "verdict": "confirm"|"reject"|"unchanged"}]` },
      { role: "user", content: `HYPOTHESES:\n${hypotheses}\n\nEVIDENCE:\n${evidence}` },
    ]);
    const results = parseJsonResponse(response.text) as Array<{ hypothesis_index: number; verdict: string }>;

    let confirmed = 0, rejected = 0;
    const confirmStmt = db.prepare("UPDATE hypotheses SET status = 'confirmed', confidence = 0.9, resolved_at = ? WHERE id = ?");
    const rejectStmt = db.prepare("UPDATE hypotheses SET status = 'rejected', confidence = 0.1, resolved_at = ? WHERE id = ?");
    for (const r of results) {
      const h = hRows[r.hypothesis_index - 1];
      if (!h) continue;
      const now = new Date().toISOString();
      if (r.verdict === "confirm") {
        confirmStmt.run(now, h.id);
        confirmed++;
      } else if (r.verdict === "reject") {
        rejectStmt.run(now, h.id);
        rejected++;
      }
    }
    return `confirmed=${confirmed}, rejected=${rejected}`;
  } catch (err) { return `error: ${err}`; }
}

// ── Step 13: Self-Model Update ─────────────────────────────────────

async function updateSelfModel(db: SqlJsDatabase, llm: LLMClient): Promise<string> {
  const rows = db.prepare(`SELECT id, text FROM chunks WHERE namespace LIKE '/agents/%' AND lifecycle NOT IN ('archived') ORDER BY created_at DESC LIMIT 30`).all() as Array<{ id: string; text: string }>;
  if (rows.length === 0) return "no_agent_chunks";

  const texts = rows.map((r) => r.text.slice(0, 400)).join("\n---\n");

  try {
    const response = await llm.chat([
      { role: "system", content: `Extract agent capabilities, limits, preferences. JSON only: {"capabilities": ["..."], "limits": ["..."], "preferences": ["..."]}` },
      { role: "user", content: texts },
    ]);
    const model = parseJsonResponse(response.text) as Record<string, string[]>;
    const now = new Date().toISOString();
    let total = 0;

    const insertStmt = db.prepare(
      `INSERT INTO chunks (id, path, source, namespace, knowledge_type, lifecycle, text, created_at, updated_at)
       VALUES (?, 'self-model', 'dream', ?, 'fact', 'active', ?, ?, ?)`
    );
    for (const [type, items] of Object.entries(model)) {
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        const id = `self-model:${hashContent(item)}`;
        try {
          insertStmt.run(id, `/agents/self/${type}s`, `Self-model ${type.slice(0, -1)}: ${item}`, now, now);
          total++;
        } catch { /* duplicate */ }
      }
    }
    return `self_model_entries=${total}`;
  } catch (err) { return `error: ${err}`; }
}

// ── Step 14: Cluster Distillation ──────────────────────────────────

async function distillClusters(db: SqlJsDatabase, llm: LLMClient): Promise<string> {
  const rows = db.prepare(`
    SELECT c.id, c.text, c.namespace, c.knowledge_type
    FROM chunks c
    JOIN memory_relations r ON c.id = r.from_chunk_id
    WHERE c.lifecycle = 'active' AND r.relation_type = 'related_by_topic'
    GROUP BY c.id HAVING COUNT(r.id) >= 2 LIMIT 20
  `).all() as Array<{ id: string; text: string; namespace: string; knowledge_type: string }>;

  if (rows.length === 0) return "no_clusters";

  let distilled = 0;
  const updateStmt = db.prepare("UPDATE chunks SET lifecycle = 'stale', updated_at = ? WHERE id = ?");
  for (const row of rows.slice(0, 5)) {
    try {
      const response = await llm.chat([
        { role: "system", content: "Merge into one concise summary preserving all unique facts. Return text only." },
        { role: "user", content: row.text.slice(0, 8000) },
      ]);

      if (response.text.length < 50) continue;

      const newId = writeChunk(db, {
        text: response.text, namespace: row.namespace,
        knowledgeType: row.knowledge_type as MemoryType,
        source: "dream", path: `distilled:${row.id}`,
      });

      updateStmt.run(new Date().toISOString(), row.id);
      distilled++;
    } catch { /* skip */ }
  }

  return `distilled=${distilled}`;
}
