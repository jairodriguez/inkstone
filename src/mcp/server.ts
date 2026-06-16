/**
 * Inkstone — MCP Server
 *
 * Stdio MCP server exposing all 14 memory tools.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Database as SqlJsDatabase } from "../db/schema.js";
import { initDb, searchWiki, searchWikiHybrid, writeChunk, writeChunkWithEmbedding, getChunk, embedAndStore, embedAll, type SearchOptions, type WriteOptions } from "../db/schema.js";
import { runDreamCycle } from "../dream/cycle.js";
import { LLMClient, EmbeddingClient } from "../llm/client.js";
import { traverseGraph, getNeighbors, findPath, getContradictions, getContextGraph, getCentralityScores } from "../graph/traversal.js";
import { GeminiFileSearchClient } from "../gemini/client.js";
import { syncInkstoneToGemini } from "../gemini/sync.js";
import { queryInkstoneWithGeminiFallback } from "../gemini/query.js";
import {
 DB_PATH, detectMemoryType, detectDomain, computeSpecificityScore, hashContent,
 type MemoryType, type LifecycleState,
} from "../config.js";
import {
 authenticate, hasPermission, readableNamespaces, isMultiUserMode,
 type User,
} from "../auth/auth.js";
import { deepQuery } from "../nlm/deep-query.js";
import { listNlmDomainRoutes } from "../nlm/state.js";

// ── Tool Definitions ───────────────────────────────────────────────

const TOOLS: Tool[] = [
 {
 name: "memory_search",
 description: "Search memories using hybrid FTS5 + vector + graph search with decay-aware ranking",
 inputSchema: {
 type: "object" as const,
 properties: {
 query: { type: "string", description: "Search query" },
 namespace: { type: "string", description: "Namespace filter (e.g. /business, /agents/myagent)" },
 knowledgeType: { type: "string", description: "Memory type filter" },
 lifecycle: { type: "string", description: "Lifecycle state filter" },
 limit: { type: "number", description: "Max results (default 10)" },
 _apiKey: { type: "string", description: "API key (required in multi-user mode)" },
 },
 required: ["query"],
 },
 },
 {
 name: "memory_deep_query",
 description: "Ask the deep NotebookLM/NLM archive with domain routing, citations, and cache. Use for broad historical/business questions.",
 inputSchema: {
 type: "object" as const,
 properties: {
 query: { type: "string", description: "Question to ask the deep memory archive" },
 domain: { type: "string", description: "Optional route: business, content, or system" },
 forceRefresh: { type: "boolean", description: "Bypass local cache and query NLM again" },
 maxAgeDays: { type: "number", description: "Cache TTL in days (default 7)" },
 _apiKey: { type: "string", description: "API key (required in multi-user mode)" },
 },
 required: ["query"],
 },
 },
 {
 name: "memory_hybrid_answer",
 description: "Answer with local Inkstone search first, then NLM deep archive fallback when local recall is weak.",
 inputSchema: {
 type: "object" as const,
 properties: {
 query: { type: "string", description: "Question to answer" },
 namespace: { type: "string", description: "Local namespace filter" },
 domain: { type: "string", description: "Optional NLM route: business, content, or system" },
 localLimit: { type: "number", description: "Local search result count (default 5)" },
 forceRefresh: { type: "boolean", description: "Bypass NLM cache" },
 _apiKey: { type: "string", description: "API key (required in multi-user mode)" },
 },
 required: ["query"],
 },
 },
 {
 name: "memory_nlm_status",
 description: "Show configured NotebookLM/NLM domain routes and active notebooks",
 inputSchema: {
 type: "object" as const,
 properties: {
 _apiKey: { type: "string", description: "API key (required in multi-user mode)" },
 },
 },
 },
 {
 name: "memory_write",
 description: "Write a new memory entry with namespace, lifecycle, tags, and confidence",
 inputSchema: {
 type: "object" as const,
 properties: {
 text: { type: "string", description: "Memory content" },
 namespace: { type: "string", description: "Namespace (e.g. /business/decisions)" },
 knowledgeType: { type: "string", description: "Auto-detected if omitted" },
 path: { type: "string", description: "Source path" },
  source: { type: "string", description: "Source identifier" },
  confidence: { type: "number", description: "0-1 (default 1.0)" },
  replaces: { type: "string", description: "Chunk ID this entry supersedes. Old chunk is marked stale." },
  _apiKey: { type: "string", description: "API key (required in multi-user mode)" },
 },
 required: ["text"],
 },
 },
 {
 name: "memory_get",
 description: "Read a specific memory by ID",
 inputSchema: {
 type: "object" as const,
 properties: {
 id: { type: "string", description: "Chunk ID" },
 _apiKey: { type: "string", description: "API key (required in multi-user mode)" },
 },
 required: ["id"],
 },
 },
 {
 name: "memory_dream",
 description: "Run the dream cycle (decay, consolidate, prune, extract, detect contradictions, etc)",
 inputSchema: {
 type: "object" as const,
 properties: {
 steps: { type: "array", items: { type: "number" }, description: "Step numbers 1-14. All if omitted." },
 _apiKey: { type: "string", description: "API key (required in multi-user mode)" },
 },
 },
 },
 {
 name: "memory_goals",
 description: "List, complete, or abandon tracked goals",
 inputSchema: {
 type: "object" as const,
 properties: {
 action: { type: "string", enum: ["list", "complete", "abandon"], description: "Action" },
 goalId: { type: "number", description: "Goal ID" },
 status: { type: "string", enum: ["active", "complete", "abandoned"], description: "Filter status" },
 _apiKey: { type: "string", description: "API key (required in multi-user mode)" },
 },
 required: ["action"],
 },
 },
 {
 name: "memory_failures",
 description: "Query known failure patterns to avoid repeating mistakes",
 inputSchema: {
 type: "object" as const,
 properties: {
 query: { type: "string", description: "Search keyword" },
 namespace: { type: "string", description: "Filter namespace" },
 _apiKey: { type: "string", description: "API key (required in multi-user mode)" },
 },
 },
 },
 {
 name: "memory_contradictions",
 description: "List unresolved contradictions across memories",
 inputSchema: {
 type: "object" as const,
 properties: {
 limit: { type: "number", description: "Max results (default 10)" },
 _apiKey: { type: "string", description: "API key (required in multi-user mode)" },
 },
 },
 },
 {
 name: "memory_hypotheses",
 description: "Track hypotheses: list, create, confirm, or reject",
 inputSchema: {
 type: "object" as const,
 properties: {
 action: { type: "string", enum: ["list", "create", "confirm", "reject"] },
 statement: { type: "string", description: "Hypothesis statement (create)" },
 hypothesisId: { type: "number", description: "ID (confirm/reject)" },
 status: { type: "string", enum: ["open", "confirmed", "rejected"], description: "Filter" },
 _apiKey: { type: "string", description: "API key (required in multi-user mode)" },
 },
 required: ["action"],
 },
 },
 {
 name: "memory_self_model",
 description: "Read agent self-knowledge (capabilities, limits, preferences)",
 inputSchema: {
 type: "object" as const,
 properties: {
 agentId: { type: "string", description: "Agent identifier" },
 category: { type: "string", enum: ["capabilities", "limits", "preferences", "all"] },
 _apiKey: { type: "string", description: "API key (required in multi-user mode)" },
 },
 },
 },
 {
 name: "memory_consolidate",
 description: "Manually consolidate specific memories by ID",
 inputSchema: {
 type: "object" as const,
 properties: {
 chunkIds: { type: "array", items: { type: "string" }, description: "Chunk IDs to merge" },
 _apiKey: { type: "string", description: "API key (required in multi-user mode)" },
 },
 required: ["chunkIds"],
 },
 },
 {
 name: "memory_global_search",
 description: "Cross-agent search across all namespaces (admin only in multi-user mode)",
 inputSchema: {
 type: "object" as const,
 properties: {
 query: { type: "string" },
 limit: { type: "number" },
 _apiKey: { type: "string", description: "API key (required in multi-user mode)" },
 },
 required: ["query"],
 },
 },
 {
 name: "memory_summarize",
 description: "Summarize text into a structured memory entry",
 inputSchema: {
 type: "object" as const,
 properties: {
 text: { type: "string", description: "Raw text to summarize" },
 namespace: { type: "string", description: "Target namespace" },
 _apiKey: { type: "string", description: "API key (required in multi-user mode)" },
 },
 },
 },
 {
 name: "memory_nlm_sync",
 description: "Sync to NotebookLM (optional, requires nlm CLI)",
 inputSchema: {
 type: "object" as const,
 properties: { sessionId: { type: "string" }, notebookId: { type: "string" } },
 required: ["sessionId"],
 },
 },
 {
 name: "memory_nlm_query",
 description: "Query NotebookLM notebooks (optional)",
 inputSchema: {
 type: "object" as const,
 properties: { query: { type: "string" }, notebookId: { type: "string" } },
 required: ["query"],
 },
 },
 {
 name: "user_create",
 description: "Create a new user with API key (admin only, or single-user setup)",
 inputSchema: {
 type: "object" as const,
 properties: {
 name: { type: "string", description: "User name" },
 role: { type: "string", enum: ["admin", "user"], description: "Role (default: user)" },
 _apiKey: { type: "string", description: "Admin API key (required in multi-user mode)" },
 },
 required: ["name"],
 },
 },
 {
 name: "user_list",
 description: "List all users",
 inputSchema: {
 type: "object" as const,
 properties: {
 _apiKey: { type: "string", description: "Admin API key (required in multi-user mode)" },
 },
 },
 },
 {
 name: "user_remove",
 description: "Remove a user and revoke all permissions",
 inputSchema: {
 type: "object" as const,
 properties: {
 userId: { type: "string", description: "User ID to remove" },
 _apiKey: { type: "string", description: "Admin API key" },
 },
 required: ["userId"],
 },
 },
 {
 name: "namespace_grant",
 description: "Grant a user permission on a namespace",
 inputSchema: {
 type: "object" as const,
 properties: {
 namespace: { type: "string", description: "Namespace path" },
 userId: { type: "string", description: "User ID" },
 permission: { type: "string", enum: ["read", "write", "admin"], description: "Permission level" },
 _apiKey: { type: "string", description: "Admin API key" },
 },
 required: ["namespace", "userId", "permission"],
 },
 },
 {
    name: "namespace_revoke",
    description: "Revoke a user's permission on a namespace",
    inputSchema: {
    type: "object" as const,
    properties: {
    namespace: { type: "string", description: "Namespace path" },
    userId: { type: "string", description: "User ID" },
    _apiKey: { type: "string", description: "Admin API key" },
    },
    required: ["namespace", "userId"],
    },
    },
    {
    name: "memory_graph_neighbors",
    description: "Get neighboring chunks connected by graph edges",
    inputSchema: {
    type: "object" as const,
    properties: {
    chunkId: { type: "string", description: "Starting chunk ID" },
    relationTypes: { type: "array", items: { type: "string" }, description: "Filter by relation types" },
    minWeight: { type: "number", description: "Minimum edge weight (default 0)" },
    limit: { type: "number", description: "Max results (default 20)" },
    _apiKey: { type: "string", description: "API key (required in multi-user mode)" },
    },
    required: ["chunkId"],
    },
    },
    {
    name: "memory_graph_path",
    description: "Find shortest path between two chunks through the graph",
    inputSchema: {
    type: "object" as const,
    properties: {
    fromId: { type: "string", description: "Starting chunk ID" },
    toId: { type: "string", description: "Target chunk ID" },
    maxDepth: { type: "number", description: "Maximum search depth (default 5)" },
    _apiKey: { type: "string", description: "API key (required in multi-user mode)" },
    },
    required: ["fromId", "toId"],
    },
    },
    {
    name: "memory_graph_contradictions",
    description: "Find chunks that contradict or supersede a given chunk",
    inputSchema: {
    type: "object" as const,
    properties: {
    chunkId: { type: "string", description: "Chunk ID to find contradictions for" },
    limit: { type: "number", description: "Max results (default 10)" },
    _apiKey: { type: "string", description: "API key (required in multi-user mode)" },
    },
    required: ["chunkId"],
    },
    },
    {
    name: "memory_graph_context",
    description: "Get full context graph around a chunk (neighbors up to depth N)",
    inputSchema: {
    type: "object" as const,
    properties: {
    chunkId: { type: "string", description: "Center chunk ID" },
    maxDepth: { type: "number", description: "Traversal depth (default 2)" },
    relationTypes: { type: "array", items: { type: "string" }, description: "Filter by relation types" },
    limit: { type: "number", description: "Max results (default 50)" },
    _apiKey: { type: "string", description: "API key (required in multi-user mode)" },
    },
    required: ["chunkId"],
    },
    },
    {
    name: "memory_graph_centrality",
    description: "Get most connected chunks (by graph edge count)",
    inputSchema: {
    type: "object" as const,
    properties: {
    limit: { type: "number", description: "Number of top chunks (default 20)" },
    _apiKey: { type: "string", description: "API key (required in multi-user mode)" },
    },
    },
    },
    {
    name: "memory_gemini_sync",
    description: "Sync Inkstone summary chunks to Gemini File Search deep archive",
    inputSchema: {
    type: "object" as const,
    properties: {
    storeName: { type: "string", description: "Gemini File Search store name" },
    dryRun: { type: "boolean", description: "Preview without uploading (default false)" },
    force: { type: "boolean", description: "Re-upload already-synced chunks (default false)" },
    batchSize: { type: "number", description: "Max chunks per call (default 50)" },
    _apiKey: { type: "string", description: "API key (required in multi-user mode)" },
    },
    required: ["storeName"],
    },
    },
    {
    name: "memory_gemini_query",
    description: "Query Inkstone + Gemini deep archive with automatic fallback",
    inputSchema: {
    type: "object" as const,
    properties: {
    query: { type: "string", description: "Search text" },
    storeName: { type: "string", description: "Gemini File Search store name" },
    localLimit: { type: "number", description: "Max Inkstone results (default 10)" },
    geminiLimit: { type: "number", description: "Max Gemini fallback results (default 5)" },
    minimumLocal: { type: "number", description: "Minimum local results before hitting Gemini (default 3)" },
    metadataFilter: { type: "string", description: "AIP-160 metadata filter (e.g. date=2026-05-10)" },
    namespace: { type: "string", description: "Inkstone namespace filter" },
    _apiKey: { type: "string", description: "API key (required in multi-user mode)" },
    },
    required: ["query", "storeName"],
    },
    },
];

// ── Helper: query sql.js rows ──────────────────────────────────────

function queryRows(db: SqlJsDatabase, sql: string, params: Array<string | number | null> = []): Record<string, unknown>[] {
  return db.prepare(sql).all(...params) as Record<string, unknown>[];
}

// ── Server ─────────────────────────────────────────────────────────

export async function startServer(dbPath?: string): Promise<void> {
  const db = await initDb(dbPath);
  const llm = new LLMClient();
  const now = () => new Date().toISOString();

  const server = new Server(
    { name: "inkstone", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

 server.setRequestHandler(CallToolRequestSchema, async (request) => {
 const { name, arguments: args } = request.params;
 const a = args || {};

 try {
 // ── Auth gate ────────────────────────────────────────────────
 const apiKey = (a._apiKey as string) || process.env.INKSTONE_API_KEY || undefined;
 const auth = authenticate(db, apiKey);
 if (auth.error) {
 return { content: [{ type: "text", text: `Auth error: ${auth.error}` }], isError: true };
 }
 const user = auth.user;
 const multiUser = auth.isMultiUser;

 // Helper: check namespace permission
 const checkPerm = (ns: string, perm: "read" | "write" | "admin"): boolean => hasPermission(db, user, ns, perm);
 const authError = (action: string, ns: string) => `Permission denied: ${action} on ${ns}`;

switch (name) {
case "memory_deep_query": {
 const result = await deepQuery(db, {
 query: String(a.query),
 domain: a.domain as string | undefined,
 forceRefresh: Boolean(a.forceRefresh),
 maxAgeDays: a.maxAgeDays ? Number(a.maxAgeDays) : undefined,
 });
 return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

case "memory_hybrid_answer": {
 const query = String(a.query);
 const ns = (a.namespace as string) || "/general";
 const localLimit = Number(a.localLimit) || 5;
 const localResults = await searchWikiHybrid(db, { query, namespace: ns, limit: localLimit });
 const bestLocalScore = localResults[0]?.score || 0;
 const useNlm = localResults.length < 3 || bestLocalScore < 0.55;
 const nlmResult = useNlm ? await deepQuery(db, {
 query,
 domain: a.domain as string | undefined,
 forceRefresh: Boolean(a.forceRefresh),
 }) : null;
 const result = {
 answer_backend: useNlm ? "hybrid:nlm_fallback" : "hybrid:local",
 used_local: localResults.length > 0,
 used_nlm: Boolean(nlmResult),
 local_confidence_proxy: Number(bestLocalScore.toFixed(3)),
 local_results: localResults.map((r) => ({
 id: r.id, ns: r.namespace, type: r.knowledgeType, score: Number(r.score.toFixed(3)), text: r.text.slice(0, 700),
 })),
 nlm: nlmResult,
 answer: nlmResult?.answer || localResults.map((r) => r.text).join("\n\n---\n\n"),
 };
 return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

case "memory_nlm_status": {
 return { content: [{ type: "text", text: JSON.stringify(listNlmDomainRoutes(), null, 2) }] };
}

  case "memory_search": {
   const userNs = a.namespace as string | undefined;
   const permNs = userNs || "/general";
   if (!checkPerm(permNs, "read")) return { content: [{ type: "text", text: authError("read", permNs) }], isError: true };

   const readableNs = readableNamespaces(db, user);
   const results = await searchWikiHybrid(db, {
   query: String(a.query),
   namespace: userNs,
   knowledgeType: a.knowledgeType as MemoryType | undefined,
   lifecycle: a.lifecycle as LifecycleState | undefined,
   limit: Number(a.limit) || 10,
   });

 // Filter results to readable namespaces in multi-user mode
 const filtered = readableNs
 ? results.filter((r) => readableNs!.some((rns) => r.namespace.startsWith(rns)))
 : results;

 return { content: [{ type: "text", text: JSON.stringify(filtered.map((r) => ({
 id: r.id, ns: r.namespace, type: r.knowledgeType, lifecycle: r.lifecycle,
 score: r.score.toFixed(3), text: r.text.slice(0, 500),
 })), null, 2) }] };
 }

  case "memory_write": {
  const ns = (a.namespace as string) || "/general";
  if (!checkPerm(ns, "write")) return { content: [{ type: "text", text: authError("write", ns) }], isError: true };

   const id = await writeChunkWithEmbedding(db, {
            text: String(a.text),
            namespace: (a.namespace as string) || "/general",
            knowledgeType: a.knowledgeType as MemoryType | undefined,
            path: a.path as string | undefined,
            source: a.source as string | undefined,
            confidence: Number(a.confidence) || 1.0,
            replaces: a.replaces as string | undefined,
           });
           return { content: [{ type: "text", text: JSON.stringify({ id, status: "written" }) }] };
         }

        case "memory_get": {
          const chunk = getChunk(db, String(a.id));
          if (!chunk) return { content: [{ type: "text", text: "Not found" }], isError: true };
          return { content: [{ type: "text", text: JSON.stringify(chunk, null, 2) }] };
        }

        case "memory_dream": {
          const steps = a.steps as number[] | undefined;
          const results = await runDreamCycle(db, llm, steps);
          return { content: [{ type: "text", text: results.map((r) =>
            `${r.step}: ${r.status}${r.detail ? ` (${r.detail})` : ""}${r.error ? ` ERROR: ${r.error}` : ""}`
          ).join("\n") }] };
        }

        case "memory_goals": {
          const action = String(a.action);
          if (action === "list") {
            const goals = queryRows(db, "SELECT * FROM goals WHERE status = ? ORDER BY updated_at DESC", [String(a.status || "active")]);
            return { content: [{ type: "text", text: JSON.stringify(goals, null, 2) }] };
          }
          db.prepare(`UPDATE goals SET status = ?, updated_at = ? WHERE id = ?`).run(
            action === "complete" ? "complete" : "abandoned", now(), Number(a.goalId));
          return { content: [{ type: "text", text: `Goal ${a.goalId} ${action}d` }] };
        }

        case "memory_failures": {
          const failures = queryRows(db,
            `SELECT * FROM failure_patterns WHERE pattern_text LIKE ? ORDER BY occurrence_count DESC LIMIT 10`,
            [`%${a.query || ""}%`]);
          return { content: [{ type: "text", text: JSON.stringify(failures, null, 2) }] };
        }

        case "memory_contradictions": {
          const contra = queryRows(db, `
            SELECT r.from_chunk_id, r.to_chunk_id, r.weight, r.created_at
            FROM memory_relations r
            WHERE r.relation_type = 'supersedes' AND r.weight >= 2.0
            ORDER BY r.created_at DESC LIMIT ?
          `, [Number(a.limit) || 10]);
          return { content: [{ type: "text", text: JSON.stringify(contra, null, 2) }] };
        }

        case "memory_hypotheses": {
          const action = String(a.action);
          if (action === "list") {
            const hyps = queryRows(db, "SELECT * FROM hypotheses WHERE status = ? ORDER BY created_at DESC", [String(a.status || "open")]);
            return { content: [{ type: "text", text: JSON.stringify(hyps, null, 2) }] };
          }
          if (action === "create") {
             db.prepare("INSERT INTO hypotheses (statement, namespace) VALUES (?, ?)").run(String(a.statement), (a.namespace as string) || "/general");
            return { content: [{ type: "text", text: "Hypothesis created" }] };
          }
          const newStatus = action === "confirm" ? "confirmed" : "rejected";
          db.prepare("UPDATE hypotheses SET status = ?, resolved_at = ? WHERE id = ?").run(newStatus, now(), Number(a.hypothesisId));
          return { content: [{ type: "text", text: `Hypothesis ${a.hypothesisId} ${newStatus}` }] };
        }

        case "memory_self_model": {
          const agentId = String(a.agentId || "default");
          const category = String(a.category || "all");
          const ns = `/agents/${agentId}/self`;
          const entries = category === "all"
            ? queryRows(db, "SELECT id, namespace, text FROM chunks WHERE namespace LIKE ? LIMIT 50", [`${ns}%`])
            : queryRows(db, "SELECT id, text FROM chunks WHERE namespace = ? LIMIT 20", [`${ns}/${category}`]);
          return { content: [{ type: "text", text: JSON.stringify(entries, null, 2) }] };
        }

        case "memory_consolidate": {
          const chunkIds = (a.chunkIds as string[]) || [];
          if (chunkIds.length < 2) return { content: [{ type: "text", text: "Need at least 2 chunk IDs" }], isError: true };

          const placeholders = chunkIds.map(() => "?").join(",");
          const chunks = queryRows(db, `SELECT id, text FROM chunks WHERE id IN (${placeholders})`, chunkIds);
          if (chunks.length < 2) return { content: [{ type: "text", text: "Chunks not found" }], isError: true };

          const texts = chunks.map((c) => String(c.text)).join("\n---\n");
          const response = await llm.chat([
            { role: "system", content: "Merge these related memories into one concise summary. Preserve unique facts. Remove redundancy. Return text only." },
            { role: "user", content: texts },
          ]);

          const newId = writeChunk(db, { text: response.text, source: "consolidate", path: "consolidated" });
          for (const id of chunkIds) {
            db.prepare("UPDATE chunks SET lifecycle = 'stale', updated_at = ? WHERE id = ?").run(now(), id);
          }
          return { content: [{ type: "text", text: JSON.stringify({ merged_id: newId, source_ids: chunkIds }) }] };
        }

 case "memory_global_search": {
 // Admin only in multi-user mode
 if (multiUser && user?.role !== "admin") {
 return { content: [{ type: "text", text: "Admin only: global search requires admin role" }], isError: true };
 }
 const results = await searchWikiHybrid(db, { query: String(a.query), limit: Number(a.limit) || 20 });
 return { content: [{ type: "text", text: JSON.stringify(results.map((r) => ({
 id: r.id, ns: r.namespace, type: r.knowledgeType,
 score: r.score.toFixed(3), text: r.text.slice(0, 300),
 })), null, 2) }] };
 }

        case "memory_summarize": {
          const text = String(a.text || "");
          if (!text) return { content: [{ type: "text", text: "Provide text to summarize" }], isError: true };

          const domain = detectDomain(text);
          const namespace = (a.namespace as string) || `/${domain}`;
          const specificity = computeSpecificityScore(text);
          if (specificity < 0.5) return { content: [{ type: "text", text: `Skipped: specificity ${specificity.toFixed(2)} below threshold` }] };

          const response = await llm.chat([
            { role: "system", content: `You are a knowledge distiller. Extract durable knowledge. Ignore trivia. Focus on: Goal, Constraints, Decisions, Context, Files. First line: TYPE: <type>` },
            { role: "user", content: text.slice(0, 100000) },
          ]);

          const memType = detectMemoryType(response.text);
          const id = writeChunk(db, {
            text: response.text, namespace, knowledgeType: memType,
            source: "summarize", path: `summary:${hashContent(text)}`,
          });
          return { content: [{ type: "text", text: JSON.stringify({ id, namespace, type: memType, specificity: specificity.toFixed(2) }) }] };
        }

 case "memory_nlm_sync":
 case "memory_nlm_query":
 return { content: [{ type: "text", text: "NLM integration not yet configured" }] };

 // ── User Management ──────────────────────────────────────────────

 case "user_create": {
 // In single-user mode, first user creation is open
 // In multi-user mode, requires admin
 if (multiUser && user?.role !== "admin") {
 return { content: [{ type: "text", text: "Admin only: creating users requires admin role" }], isError: true };
 }
 const { createUser } = await import("../auth/auth.js");
 const result = createUser(db, String(a.name), (a.role as "admin" | "user") || "user");
 return { content: [{ type: "text", text: JSON.stringify({
 id: result.id,
 apiKey: result.apiKey,
 name: result.name,
 role: result.role,
 _warning: "Save the API key now. It cannot be recovered.",
 }, null, 2) }] };
 }

 case "user_list": {
 if (multiUser && user?.role !== "admin") {
 return { content: [{ type: "text", text: "Admin only" }], isError: true };
 }
 const { listUsers } = await import("../auth/auth.js");
 const users = listUsers(db);
 return { content: [{ type: "text", text: JSON.stringify(users, null, 2) }] };
 }

 case "user_remove": {
 if (multiUser && user?.role !== "admin") {
 return { content: [{ type: "text", text: "Admin only" }], isError: true };
 }
 const { removeUser } = await import("../auth/auth.js");
 const removed = removeUser(db, String(a.userId));
 return { content: [{ type: "text", text: removed ? `User ${a.userId} removed` : `User ${a.userId} not found` }] };
 }

 case "namespace_grant": {
 if (multiUser && user?.role !== "admin") {
 return { content: [{ type: "text", text: "Admin only" }], isError: true };
 }
 const { grantPermission } = await import("../auth/auth.js");
 grantPermission(db, String(a.namespace), String(a.userId), String(a.permission) as "read" | "write" | "admin", user?.id);
 return { content: [{ type: "text", text: `Granted ${a.permission} on ${a.namespace} to user ${a.userId}` }] };
 }

 case "namespace_revoke": {
 if (multiUser && user?.role !== "admin") {
 return { content: [{ type: "text", text: "Admin only" }], isError: true };
 }
 const { revokePermission } = await import("../auth/auth.js");
 revokePermission(db, String(a.namespace), String(a.userId));
 return { content: [{ type: "text", text: `Revoked access on ${a.namespace} from user ${a.userId}` }] };
 }

        // ── Graph Traversal (Agent-Native) ──────────────────────────────

        case "memory_graph_neighbors": {
          const edges = getNeighbors(db, String(a.chunkId), {
            relationTypes: (a.relationTypes as string[]) || undefined,
            minWeight: Number(a.minWeight) || 0,
            limit: Number(a.limit) || 20,
          });
          return { content: [{ type: "text", text: JSON.stringify(edges, null, 2) }] };
        }

        case "memory_graph_path": {
          const path = findPath(db, String(a.fromId), String(a.toId), {
            maxDepth: Number(a.maxDepth) || 5,
          });
          return { content: [{ type: "text", text: JSON.stringify(path ? { path, depth: path.length - 1 } : null, null, 2) }] };
        }

        case "memory_graph_contradictions": {
          const contra = getContradictions(db, String(a.chunkId), Number(a.limit) || 10);
          return { content: [{ type: "text", text: JSON.stringify(contra, null, 2) }] };
        }

        case "memory_graph_context": {
          const contextNodes = getContextGraph(db, String(a.chunkId), {
            maxDepth: Number(a.maxDepth) || 2,
            relationTypes: (a.relationTypes as string[]) || undefined,
            limit: Number(a.limit) || 50,
          });
          return { content: [{ type: "text", text: JSON.stringify(contextNodes, null, 2) }] };
        }

        case "memory_graph_centrality": {
          const scores = getCentralityScores(db);
          const sorted = Array.from(scores.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, Number(a.limit) || 20);
          return { content: [{ type: "text", text: JSON.stringify(sorted.map(([id, score]) => ({ id, connections: score })), null, 2) }] };
        }

        // ── Gemini Deep Archive ──────────────────────────────────────────

        case "memory_gemini_sync": {
          const storeName = String(a.storeName);
          const geminiKey = process.env.GEMINI_API_KEY;
          if (!geminiKey) {
            return { content: [{ type: "text", text: "Gemini API key not set (GEMINI_API_KEY)" }], isError: true };
          }
          const client = new GeminiFileSearchClient({ apiKey: geminiKey });
          const result = await syncInkstoneToGemini(db, client, storeName, {
            dryRun: Boolean(a.dryRun),
            force: Boolean(a.force),
            batchSize: Number(a.batchSize) || 50,
          });
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }

        case "memory_gemini_query": {
          const storeName = String(a.storeName);
          const geminiKey = process.env.GEMINI_API_KEY;
          if (!geminiKey) {
            return { content: [{ type: "text", text: "Gemini API key not set (GEMINI_API_KEY)" }], isError: true };
          }
          const client = new GeminiFileSearchClient({ apiKey: geminiKey });
          const results = await queryInkstoneWithGeminiFallback(db, client, storeName, String(a.query), {
            localLimit: Number(a.localLimit) || 10,
            geminiLimit: Number(a.geminiLimit) || 5,
            minimumLocal: Number(a.minimumLocal) || 3,
            metadataFilter: a.metadataFilter as string | undefined,
            namespace: a.namespace as string | undefined,
          });
          return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
        }

        default:
          return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      }
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Inkstone MCP server running on stdio");
}

// ── CLI Entry ──────────────────────────────────────────────────────

if (process.argv[1]?.endsWith("server.js") || process.argv[1]?.endsWith("server.ts")) {
  startServer().catch((err) => { console.error("Fatal:", err); process.exit(1); });
}
