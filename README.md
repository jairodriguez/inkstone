# Inkstone — Agentic MCP Memory Server

[![CI](https://github.com/jairodriguez/inkstone/actions/workflows/ci.yml/badge.svg)](https://github.com/jairodriguez/inkstone/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-Compatible-blue.svg)](https://modelcontextprotocol.io)

Inkstone is a SQLite-based memory system for AI agents. It stores knowledge as versioned chunks with full-text search (custom Porter stemmer + BM25), vector embeddings (Ollama/OpenAI), exponential decay scoring, lifecycle management (active→validated→stale→archived), graph-based entity relations, and a 14-step "dream cycle" maintenance pipeline. Exposed via MCP (Model Context Protocol) for use by any AI agent.

**Engine:** better-sqlite3 (native SQLite, ~73ms startup vs 13s with sql.js WASM). Writes are direct to disk — no 1.13 GB export needed.

## Quick Start

```bash
# Database location
export INKSTONE_DB="$HOME/.inkstone/inkstone-full.db"

# Start MCP server (stdio transport)
inkstone

# Write a memory
inkstone write "DHL Express is the preferred carrier" --ns=/business/logistics

# Search
inkstone search "DHL shipping"

# Check DB status
inkstone status

# Run full dream cycle (14 maintenance steps)
inkstone dream
```

## Architecture

```
                    ┌──────────────────────────┐
                    │    MCP Client (Claude)    │
                    └──────────┬───────────────┘
                               │ stdio
                    ┌──────────▼───────────────┐
                    │  MCP Server (server.ts)   │
                    │  19 tools: search, write, │
                    │  dream, graph, goals, ... │
                    └──────────┬───────────────┘
                               │
                    ┌──────────▼───────────────┐
                    │    DB Layer (schema.ts)   │
                    │  better-sqlite3 (native)  │
                    │  WAL mode, no export      │
                    └──────────┬───────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          ▼                    ▼                    ▼
┌─────────────────┐ ┌─────────────────┐ ┌──────────────────┐
│ FTS Index (fts) │ │ LLM Client      │ │ Graph Traversal  │
│ Porter stemmer  │ │ Ollama OpenRouter│ │ neighbors, paths │
│ BM25 scoring    │ │ fallback chain   │ │ centrality, edges│
│ stop words      │ │ 3s timeout       │ └──────────────────┘
└─────────────────┘ └─────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────┐
│  Disk (~/.inkstone/inkstone-full.db, 768 MB)    │
│  67,045 chunks · 5.5M FTS entries · WAL journal │
└─────────────────────────────────────────────────┘
```

### Performance (sql.js → better-sqlite3 migration)

| Operation | Before (sql.js) | After (better-sqlite3) |
|-----------|-----------------|----------------------|
| DB open | 13,000 ms | 73 ms |
| Save/export | 30+ s (1.13 GB fsync) | 0 ms (WAL writes as you go) |
| FTS search | 42 s | 741 ms |
| Integrity check | timed out | 2 s |

### Key Design Decisions

- **better-sqlite3 over sql.js** — Native SQLite binding. Direct disk I/O, no WASM overhead, no corruption risk. `saveDb()` is a no-op — WAL journal auto-persists.
- **Custom FTS** — Porter stemmer + stop words + BM25 scoring stored in `fts_index` table. Not SQLite FTS5 — incompatible with `better-sqlite3` approach in use.
- **Hybrid search** — FTS (text match) + vector cosine similarity (Ollama/OpenAI embeddings). Score fusion: FTS 50% → vector fusion 40% FTS + 40% vector + 10% decay + 10% graph.
- **`isMain` guard** — ESM has no `require.main === module`. CLI uses `import.meta.filename` to prevent MCP server from starting on library import.

## File Structure

```
src/
├── config.ts          — Paths, weights, decay params, memory types, domain detection
├── index.ts           — CLI entry point (all commands, ~45 lines per command)
├── db/
│   ├── schema.ts      — DB layer: better-sqlite3, write, search, decay, lifecycle, wiki
│   └── fts.ts         — Full-text search: Porter stemmer, inverted index, BM25
├── ingest/
│   ├── files.ts       — File walker + Ollama enrichment pipeline
│   └── sessions.ts    — Session summarization → wiki
├── mcp/
│   └── server.ts      — MCP server (stdio, 19 tools, auth middleware)
├── llm/
│   └── client.ts      — LLM abstraction: Ollama (default) → OpenRouter (fallback)
├── dream/
│   └── cycle.ts       — 14-step dream cycle with AbortController timeouts
├── graph/
│   └── traversal.ts   — BFS/Dijkstra, neighbors, path, contradictions, centrality
├── nlm/
│   ├── client.ts      — NotebookLM API wrapper
│   ├── deep-query.ts  — Cached deep-archive queries
│   ├── router.ts      — Domain-based notebook routing
│   └── state.ts       — Active notebook state
├── gemini/
│   ├── client.ts      — Gemini File Search API
│   ├── query.ts       — Hybrid Inkstone + Gemini search
│   └── sync.ts        — Upload chunks to Gemini
└── auth/
    └── auth.ts        — API key auth + namespace RBAC
```

## Database

**Default location:** `~/.inkstone/inkstone-full.db`

**Engine:** better-sqlite3 (native). WAL journal mode. Direct disk writes — no in-memory export, no corruption risk.

### Schema

| Table | Purpose |
|-------|---------|
| `chunks` | Knowledge entries with text, namespace, type, lifecycle, embeddings |
| `fts_index` | Custom inverted index (term → chunk_id → positions) with BM25 |
| `files` | File tracking (path, hash, mtime) for delta detection |
| `memory_decay` | Per-chunk exponential decay scores |
| `memory_relations` | Graph edges between chunks (`related_by_entity`, `related_by_namespace`, `supersedes`) |
| `embedding_cache` | LLM embedding cache (provider + model + hash) |
| `manifest` | Session ingestion tracking with dedup and supersession |
| `goals` | Tracked goals (active/complete/abandoned) |
| `hypotheses` | Hypotheses (open/confirmed/rejected) with evidence |
| `failure_patterns` | Recurring failure patterns with occurrence counts |
| `nlm_sync` | NotebookLM sync state tracking |
| `users` | Multi-user auth table |
| `namespace_permissions` | Per-user RBAC grants |

### Chunk ID Scheme

| Source | ID Pattern |
|--------|------------|
| Direct write | `direct::<sha256-prefix>` |
| Wiki file | `wiki::<relative-path>::<line>` |
| Session ingest | `session::<session-id>::<hash>` |
| Graph edge | `edge:entity:<from>:<to>` or `edge:ns:<ns>:<from>:<to>` |

### Chunk Lifecycle

```
  active ──► validated ──► stale ──► archived ──► pruned (deleted)
   │           │              │            │
   │ 3+        │ 14 days      │ 28 days    │ decay < 0.05
   │ accesses  │ no access    │ stale      │ AND expired
```

Backups are automatic: up to 3 `.bak` files rotated on every schema change. Verify with `inkstone check`.

## Search Pipeline

```
Query "huckleberry"
    ↓
Porter Stemmer → "huckleberri"
    ↓
FTS Index lookup (fts_index table, BM25)
    ↓
Fetch chunks + decay scores + graph edges
    ↓
Score fusion:
  composite = (ftsScore × 0.5 + 0.5) × sourceTrust × typeWeight
              × (1 + decayBoost) × (1 + graphBoost) × supersededPenalty
    ↓
If hybrid: rerank with cosine similarity
  fused = ftsScore × 0.4 + vectorScore × 0.4 + decayBoost × 0.1 + graphBoost × 0.1
    ↓
Return top N (default 10)
```

### Scoring Weights

| Factor | Effect |
|--------|--------|
| **Source trust** | evergreen 2.0, business 1.5, raw 0.6 |
| **Knowledge type** | correction 3.0, preference 2.0, factual 1.0, emotion 0.5 |
| **Decay** | Exponential: `score × 0.5^(age / halfLifeDays)` |
| **Graph** | +5% per edge, capped at +30% |
| **Superseded** | ×0.1 penalty (old version of something) |

### Memory Types (auto-detected from text patterns)

| Type | Pattern Examples | Half-life | TTL |
|------|-----------------|-----------|-----|
| correction | fix, bug, root cause | 10 years | 10 years |
| preference | prefer, like, always | 10 years | 10 years |
| milestone | launched, shipped, released | 10 years | 10 years |
| decision | decided, chose, switched | 90 days | 1 year |
| lesson | lesson, learned, takeaway | 90 days | 1 year |
| procedural | how to, steps, process | 180 days | 180 days |
| fact | (default) | 30 days | 90 days |
| contact | email, phone, dm | 365 days | 365 days |
| financial | $, cost, revenue | 7 days | 7 days |
| blocker | blocked, can't, failed | 7 days | 7 days |
| event | happened, occurred | 14 days | 30 days |
| context | background, situation | 14 days | 14 days |
| emotion | feel, frustrated, happy | 3 days | 7 days |

## Dream Cycle

The dream cycle is a 14-step maintenance pipeline. Run it periodically (e.g., via cron) to keep the knowledge base healthy. Each step has its own `AbortController` timeout (default 20 min).

```bash
# Full cycle
inkstone dream

# Specific steps
inkstone dream --steps=1,3,5

# With per-step timeout
inkstone dream --step-timeout=600
```

| Step | Name | What It Does |
|------|------|-------------|
| 1 | `exponential_decay` | Recalculates decay scores for all chunks based on age and half-life |
| 2 | `lifecycle_transitions` | Promotes/demotes chunks: active→validated (3+ accesses), validated→stale (14d), stale→archived (28d) |
| 3 | `entity_extraction` | Scans for `[[wiki-link]]` patterns, auto-extracts entity pages |
| 4 | `trivia_pruning` | Lowers specificity score for generic/trivial content |
| 5 | `wiki_reindex` | Syncs wiki directory → DB (detects new/changed/deleted files via hash) |
| 6 | `prune_expired` | Archives chunks with decay < 0.05 AND expired valid_to, writes archive files |
| 7 | `graph_edges` | Builds entity co-occurrence + namespace-based graph edges (`memory_relations`) |
| 8 | `contradiction_detection` | Uses LLM to find contradictions between chunks |
| 9 | `goal_inference` | Extracts tracked goals from memory content |
| 10 | `failure_patterns` | Identifies recurring failure patterns |
| 11 | `causal_links` | LLM-extracts causal relationships between chunks |
| 12 | `hypothesis_scan` | LLM generates open hypotheses from conflicting data |
| 13 | `self_model_update` | LLM updates agent's self-knowledge (capabilities, limits) |
| 14 | `distill_clusters` | LLM finds thematic clusters and distills summaries |

Steps 8-14 require an LLM provider (Ollama or OpenRouter). Steps 1-7 run with zero external calls.

## CLI Commands

```bash
# ── Server ─────────────────────────────────────────────────────────
inkstone [-h]                 Start MCP server on stdio transport

# ── Search & Query ─────────────────────────────────────────────────
inkstone search <query>       Hybrid FTS + vector + graph search
inkstone deep-query <q>       Local + NLM deep archive (cached)
  --domain=business|content|system
  --force                     Bypass cache

# ── Write ──────────────────────────────────────────────────────────
inkstone write <text>         Write a memory chunk (with embedding)
  --ns=       Namespace       (default: /general)
  --source=   Source label    (default: cli)

# ── Maintenance ────────────────────────────────────────────────────
inkstone dream                Full 14-step dream cycle
  --steps=1,3,5              Specific steps only
  --step-timeout=600          Per-step timeout in seconds
inkstone embed-all             Generate embeddings for missing vectors
  --batch=50                  Commit batch size
inkstone index                Re-index wiki directory

# ── Ingestion ──────────────────────────────────────────────────────
inkstone ingest-files         Ingest files from workspace
  --root=DIR    Root to scan  (default: cwd)
  --force       Re-ingest unchanged
  --no-llm      Skip LLM enrichment
  --dry-run     Preview only
  --limit=N     Max files
  --skip-enriched             Skip already-enriched files
inkstone ingest-sessions       Summarize today's Claude sessions
  --days=N      Look back     (default: 1)
  --force       Re-process
  --dry-run     Preview only

# ── Diagnostics ────────────────────────────────────────────────────
inkstone status               DB statistics (chunks, types, decays)
inkstone check                Integrity check (PRAGMA integrity_check)
inkstone nlm-status            Show NLM notebook domain routes

# ── User Management ────────────────────────────────────────────────
inkstone user add <name>      Create user (first = enable multi-user)
  --role=admin                Admin role
inkstone user list             List all users
inkstone user remove <id>      Delete a user
inkstone user grant <ns> <uid> <perm>  Grant namespace access
inkstone user revoke <ns> <uid>        Revoke namespace access

# ── Migration ──────────────────────────────────────────────────────
inkstone migrate               Migrate from legacy (hippocampus/memex)

# ── Help ───────────────────────────────────────────────────────────
inkstone help                 This page
```

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `INKSTONE_DB` | `~/.inkstone/inkstone-full.db` | Database path |
| `INKSTONE_ROOT` | `~/.inkstone` | Root directory |
| `INKSTONE_WIKI` | `~/.inkstone/wiki` | Wiki directory |
| `INKSTONE_API_KEY` | — | Default MCP API key |
| `INKSTONE_OLLAMA_MODEL` | `gemma4:e4b` | Ollama chat model |
| `INKSTONE_EMBED_MODEL` | `nomic-embed-text` | Embedding model |
| `INKSTONE_EMBEDDING_PROVIDER` | `local` | `local` (Ollama) or `openai` |
| `INKSTONE_OR_MODEL` | `google/gemini-2.0-flash-001` | OpenRouter chat model |
| `INKSTONE_OR_FALLBACK` | `minimax/minimax-m2.5:free` | OpenRouter fallback |
| `OPENROUTER_API_KEY` | — | Required for OpenRouter LLM |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama endpoint |

## MCP Tools

| Tool | Description |
|------|-------------|
| `memory_search` | Hybrid FTS + vector + graph search with decay-aware ranking |
| `memory_write` | Write a new memory (namespace, type, confidence, supersession) |
| `memory_get` | Read a specific chunk by ID |
| `memory_deep_query` | Local search + NLM deep archive fallback |
| `memory_hybrid_answer` | Answer with local first, NLM fallback when weak |
| `memory_summarize` | LLM-summarize text into structured memory |
| `memory_dream` | Run the 14-step dream cycle |
| `memory_consolidate` | Manually merge specific chunks |
| `memory_goals` | List, complete, or abandon tracked goals |
| `memory_hypotheses` | List, create, confirm, or reject hypotheses |
| `memory_failures` | Query known failure patterns |
| `memory_contradictions` | List unresolved contradictions |
| `memory_graph_context` | Get graph neighbors up to depth N |
| `memory_graph_neighbors` | Get direct neighboring chunks |
| `memory_graph_path` | Find shortest path between chunks |
| `memory_graph_centrality` | Most connected chunks by edge count |
| `memory_graph_contradictions` | Find chunks contradicting a given chunk |
| `memory_self_model` | Read agent self-knowledge (capabilities, limits) |
| `memory_gemini_query` | Local + Gemini File Search |
| `memory_gemini_sync` | Sync chunks to Gemini |
| `memory_nlm_query` | Query NotebookLM |
| `memory_nlm_status` | Show NLM domain routes |
| `memory_global_search` | Cross-agent search across all namespaces |

## Multi-User Mode

By default, Inkstone runs in single-user mode (no auth). The first `user add` call enables multi-user mode:

```bash
inkstone user add jairo --role=admin
# → User created. API Key: isk_abc123...
```

After that, all MCP requests require `_apiKey`. Users see only namespaces they've been granted. Admins see everything.

## Ingestion

### Session Ingestion

```bash
# Summarize today's Claude sessions into wiki
inkstone ingest-sessions

# Last 3 days, force re-process
inkstone ingest-sessions --days=3 --force
```

Reads from `~/.claude/sessions/`, extracts key decisions, lessons, and context, writes summarized markdown files to `~/.inkstone/wiki/summaries/`.

### File Ingestion

```bash
# Walk a directory, LLM-enrich each file, index into DB
inkstone ingest-files --root=/path/to/project

# Skip LLM enrichment (raw dump — NOT recommended for production)
inkstone ingest-files --root=/path/to/dir --no-llm
```

The `--no-llm` flag produces raw, barely-searchable chunks. Always use LLM enrichment for production ingestion.

## Backup & Recovery

Automatic backups are rotated on every schema change:

```
~/.inkstone/inkstone-full.db           ← Live database
~/.inkstone/inkstone-full.db.bak       ← Most recent backup
~/.inkstone/inkstone-full.db.bak.2     ← Second backup
~/.inkstone/inkstone-full.db.bak.3     ← Third backup
```

**If the main DB is corrupted or you need to revert:**

```bash
# Check integrity
inkstone check

# Restore from backup
cp ~/.inkstone/inkstone-full.db.bak ~/.inkstone/inkstone-full.db

# Verify
inkstone check
```

## Development

```bash
# TypeScript build
npm run build        # → dist/

# Watch mode
npm run dev          # tsc --watch

# Full clean rebuild (excludes test/ and migrate-from-legacy.ts)
npx tsc

# Test (only versioning tests run)
npm test
```

### Architecture Constraints

- **Never override INKSTONE_DB for cron jobs** — the MCP server always uses the default `~/.inkstone/inkstone-full.db`. Cron jobs with a different `INKSTONE_DB` write to a separate DB that nothing reads from.
- **DB queries: always alias duplicate column names** — better-sqlite3 returns objects; duplicate column names silently overwrite. Use `AS` aliases.
- **`saveDb()` is a no-op** — kept for API compatibility. better-sqlite3 writes directly to disk.
- **`isMain` guard** — prevents MCP server startup on library import. This was the cause of the "CLI hangs" bug when running `inkstone search` from the same directory.
- **FTS vs sqlite-vec** — FTS index is a custom inverted index (`fts_index` table). Vectors are stored as raw BLOBs (`embedding` column on `chunks`). Cosine similarity is computed in JavaScript, not via sqlite-vec extension.
