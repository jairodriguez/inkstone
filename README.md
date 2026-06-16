# Inkstone — AI Memory That Manages Itself

[![CI](https://github.com/jairodriguez/inkstone/actions/workflows/ci.yml/badge.svg)](https://github.com/jairodriguez/inkstone/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-Compatible-blue.svg)](https://modelcontextprotocol.io)
[![npm](https://img.shields.io/npm/v/inkstone-mcp)](https://www.npmjs.com/package/inkstone-mcp)

Every AI session starts from zero. Your agent doesn't remember what you discussed yesterday, the decision you made last week, or the infrastructure detail you confirmed last month. You repeat yourself. It wastes time.

Memory servers fix this. But most are just save-and-return key-value stores. They don't know what's important, what's outdated, or what contradicts itself. They accumulate noise until search breaks.

**Inkstone is different.** It's a self-maintaining knowledge base for AI agents with hybrid search (FTS + vectors + graph), exponential decay scoring, and a 14-step dream cycle that automatically maintains itself. You write memories. Inkstone handles the rest.

```bash
# Start the memory server
inkstone

# Write a memory
inkstone write "We use PostgreSQL on AWS RDS — primary db is app-prod-us-east-1" --ns=/system/infrastructure

# Search
inkstone search "RDS"

# Tell your agent: "check your memory before answering."
# The agent calls memory_search automatically.
```

## Why Inkstone Over Other MCP Memory Servers?

There are dozens of MCP memory servers. Most do one thing: save and return text. Inkstone is different in kind, not degree.

**Every other memory server:** flat key-value storage with keyword search. Write a note, get it back verbatim. No ranking, no decay, no maintenance.

**Inkstone:** a knowledge base that manages itself.

| Feature | Other memory servers | Inkstone |
|---------|-------------------|---------|
| **Search** | Keyword match only | FTS (Porter stemmer + BM25) + vector embeddings + graph, fused with score weights |
| **Decay** | None — old memories rank same as new | Exponential decay per type (corrections last 10yr, emotions fade in 3 days) |
| **Lifecycle** | None | active → validated → stale → archived → pruned (auto-promoted by access) |
| **Maintenance** | None | 14-step dream cycle: decay recalc, contradiction detection, goal inference, failure patterns, cluster distillation, self-model updates |
| **Graph** | None | Entity relations, neighbors, shortest path, centrality, contradiction traversal |
| **SQL engine** | sql.js WASM (13s load, in-memory export) | better-sqlite3 native (71ms load, direct disk writes) |
| **Multi-user** | None | Namespace-level RBAC with API keys |
| **Backups** | Manual | Auto-rotation (3 .bak files on every schema change) |
| **LLM enrichment** | None | Auto-summarize, type detection, contradiction scanning, causal linking |

**The headline features:**

- **Decay scoring** — A decision from today ranks above a random fact from 6 months ago. Configurable half-lives per memory type (corrections: 10 years. Emotions: 3 days.)
- **14-step dream cycle** — Run it nightly via cron. Inkstone automatically recalculates decay, promotes/archives chunks, detects contradictions, infers goals, identifies failure patterns, and distills clusters. Zero manual maintenance.
- **Hybrid search** — Full-text (custom Porter stemmer + BM25 inverted index) + vector cosine similarity (Ollama or OpenAI) + graph edge boosts. All three fused into a composite score.
- **71 ms startup** — Native better-sqlite3 binding. No WASM overhead, no 1.13 GB export step, no corruption risk.

## Quick Start

### Install

```bash
npm install -g inkstone-mcp
```

Or install from source:

```bash
git clone https://github.com/jairodriguez/inkstone.git
cd inkstone
npm install && npm run build
npm install -g .
```

### Configure

Inkstone works out of the box. The default database lives at `~/.inkstone/inkstone.db`. Override with environment variables:

```bash
export INKSTONE_DB="$HOME/.inkstone/inkstone.db"
```

### Run

```bash
# Start the MCP server (stdio transport) — connects to any MCP client
inkstone

# Write your first memory
inkstone write "Our primary database is PostgreSQL running on AWS RDS" --ns=/system/infrastructure

# Search
inkstone search "database"

# Check status
inkstone status

# Run the full dream cycle (do this nightly)
inkstone dream
```

## Using Inkstone with AI Agents

### Claude Code

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "inkstone": {
      "command": "inkstone",
      "args": []
    }
  }
}
```

### opencode

Add to `.opencode.json` in your project root:

```json
{
  "mcpServers": {
    "inkstone": {
      "command": "inkstone",
      "args": []
    }
  }
}
```

### Cline / Roo Code

Add to `cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "inkstone": {
      "command": "inkstone",
      "args": []
    }
  }
}
```

### Continue.dev

Add to `config.json`:

```json
{
  "experimental": {
    "mcpServers": {
      "inkstone": {
        "command": "inkstone",
        "args": []
      }
    }
  }
}
```

## MCP Tools

Once connected, your agent can use these tools:

| Tool | What it does |
|------|-------------|
| `memory_search` | Search everything — text, vector, graph, decay-ranked |
| `memory_write` | Save a memory with namespace, type, confidence |
| `memory_get` | Read one chunk by ID |
| `memory_hybrid_answer` | Answer a question using local memory first, deep archive as fallback |
| `memory_deep_query` | Same as hybrid_answer but returns citations |
| `memory_summarize` | Have the LLM condense text into structured memory |
| `memory_goals` | Track goals — list, create, complete, abandon |
| `memory_hypotheses` | Track hypotheses — create, confirm, reject |
| `memory_failures` | Log and query known failure patterns (don't repeat mistakes) |
| `memory_contradictions` | Find conflicting memories |
| `memory_dream` | Trigger the 14-step maintenance cycle |
| `memory_consolidate` | Merge related chunks by ID |
| `memory_self_model` | Read the agent's stored self-knowledge (capabilities, limits) |
| `memory_graph_context` | Get the full graph neighborhood around a chunk |
| `memory_graph_neighbors` | Direct neighbors of a chunk |
| `memory_graph_path` | Shortest path between two chunks |
| `memory_graph_centrality` | Most connected chunks |
| `memory_graph_contradictions` | Find chunks that contradict a specific chunk |
| `memory_gemini_query` | Query with Gemini File Search fallback |
| `memory_gemini_sync` | Upload chunks to Gemini File Search |
| `memory_nlm_query` | Query Google NotebookLM notebooks |
| `memory_nlm_status` | Show configured NotebookLM routes |
| `memory_global_search` | Cross-agent search (admin) |

## Architecture

```
                    ┌──────────────────────────┐
                    │    MCP Client (Claude)    │
                    └──────────┬───────────────┘
                               │ stdio
                    ┌──────────▼───────────────┐
                    │  MCP Server (server.ts)   │
                    │  19+ tools: search, write │
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
```

### Search Pipeline

```
Query "huckleberry"
    ↓
Porter Stemmer → "huckleberri"
    ↓
FTS Index lookup (BM25)
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
| **Source trust** | `evergreen` 2.0, `business` 1.5, `correction` 1.5, `raw` 0.6 |
| **Knowledge type** | `correction` 3.0, `preference` 2.0, `fact` 1.0, `emotion` 0.5 |
| **Decay** | Exponential: `score × 0.5^(age / halfLifeDays)` |
| **Graph** | +5% per edge, capped at +30% |
| **Superseded** | ×0.1 penalty (old version of something) |

### Memory Types (auto-detected)

| Type | Detected From | Half-life | TTL |
|------|--------------|-----------|-----|
| correction | fix, bug, root cause | 10 years | 10 years |
| preference | prefer, like, always | 10 years | 10 years |
| milestone | launched, shipped, released | 10 years | 10 years |
| decision | decided, chose, switched | 90 days | 1 year |
| lesson | lesson, learned, takeaway | 90 days | 1 year |
| procedural | how to, steps, process | 180 days | 180 days |
| contact | email, phone, dm | 365 days | 365 days |
| financial | $, cost, revenue | 7 days | 7 days |
| blocker | blocked, can't, failed | 7 days | 7 days |
| event | happened, occurred | 14 days | 30 days |
| context | background, situation | 14 days | 14 days |
| emotion | feel, frustrated, happy | 3 days | 7 days |
| fact | (default) | 30 days | 90 days |

## CLI Commands

```bash
# ── Server ─────────────────────────────────────────────────────────
inkstone                         Start MCP server (stdio transport)

# ── Search & Query ─────────────────────────────────────────────────
inkstone search <query>          Hybrid FTS + vector + graph search
inkstone deep-query <q>          Local + NLM deep archive (cached)
  --domain=business|content|system
  --force                        Bypass cache

# ── Write ──────────────────────────────────────────────────────────
inkstone write <text>            Write a memory chunk (with embedding)
  --ns=       Namespace          (default: /general)
  --source=   Source label       (default: cli)

# ── Maintenance ────────────────────────────────────────────────────
inkstone dream                   Full 14-step dream cycle
  --steps=1,3,5                  Specific steps only
  --step-timeout=600             Per-step timeout in seconds
inkstone embed-all               Generate embeddings for missing vectors
  --batch=50                     Commit batch size
inkstone index                   Re-index wiki directory

# ── Ingestion ──────────────────────────────────────────────────────
inkstone ingest-files            Ingest files from workspace
  --root=DIR    Root to scan     (default: cwd)
  --force       Re-ingest unchanged
  --no-llm      Skip LLM enrichment
  --dry-run     Preview only
  --limit=N     Max files
  --skip-enriched                Skip already-enriched files
inkstone ingest-sessions         Summarize Claude sessions
  --days=N      Look back        (default: 1)
  --force       Re-process
  --dry-run     Preview only

# ── Diagnostics ────────────────────────────────────────────────────
inkstone status                  DB stats (chunks, types, decays)
inkstone check                   Integrity check
inkstone nlm-status              Show NLM notebook domain routes

# ── Users (multi-user mode) ────────────────────────────────────────
inkstone user add <name>         Create user (first = enables auth)
  --role=admin
inkstone user list               List all users
inkstone user remove <id>        Delete a user
inkstone user grant <ns> <uid> <perm>   Grant namespace access
inkstone user revoke <ns> <uid>        Revoke namespace access

# ── Migration ──────────────────────────────────────────────────────
inkstone migrate                 Migrate from legacy systems

# ── Help ───────────────────────────────────────────────────────────
inkstone help                    This page
```

## Dream Cycle (Automated Maintenance)

The dream cycle is a 14-step pipeline that keeps Inkstone healthy. Run it nightly:

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
| 1 | `exponential_decay` | Recalculates decay scores for all chunks |
| 2 | `lifecycle_transitions` | Promotes/demotes chunks based on access patterns |
| 3 | `entity_extraction` | Scans for `[[wiki-link]]` patterns, extracts entities |
| 4 | `trivia_pruning` | Lowers score for generic/trivial content |
| 5 | `wiki_reindex` | Syncs wiki directory changes to DB |
| 6 | `prune_expired` | Archives chunks below decay threshold |
| 7 | `graph_edges` | Builds entity co-occurrence graph |
| 8 | `contradiction_detection` | Finds conflicting memories (requires LLM) |
| 9 | `goal_inference` | Extracts tracked goals from content (requires LLM) |
| 10 | `failure_patterns` | Identifies recurring failures (requires LLM) |
| 11 | `causal_links` | Links cause and effect between chunks (requires LLM) |
| 12 | `hypothesis_scan` | Generates open hypotheses (requires LLM) |
| 13 | `self_model_update` | Updates agent self-knowledge (requires LLM) |
| 14 | `distill_clusters` | Distills thematic summaries (requires LLM) |

Steps 1-7 run with zero external calls. Steps 8-14 need Ollama or OpenRouter.

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `INKSTONE_DB` | `~/.inkstone/inkstone.db` | Database path |
| `INKSTONE_ROOT` | `~/.inkstone` | Root directory |
| `INKSTONE_WIKI` | `~/.inkstone/wiki` | Wiki directory |
| `INKSTONE_API_KEY` | — | Default MCP API key |
| `INKSTONE_OLLAMA_MODEL` | `gemma4:e4b` | Ollama chat model |
| `INKSTONE_EMBED_MODEL` | `nomic-embed-text` | Embedding model |
| `INKSTONE_EMBEDDING_PROVIDER` | `local` | `local` (Ollama) or `openai` |
| `INKSTONE_OR_MODEL` | `google/gemini-2.0-flash-001` | OpenRouter chat model |
| `INKSTONE_OR_FALLBACK` | `minimax/minimax-m2.5:free` | OpenRouter fallback |
| `OPENROUTER_API_KEY` | — | Required for OpenRouter |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama endpoint |

## Multi-User Mode

By default, Inkstone runs without auth. Create your first user to enable multi-user mode:

```bash
inkstone user add jairo --role=admin
# → User created. API Key: isk_abc123...
```

After that, all MCP requests require `_apiKey`. Users see only their granted namespaces. Admins see everything.

## File Structure

```
src/
├── config.ts          — Paths, weights, decay params, memory types, domain detection
├── index.ts           — CLI entry point (all commands)
├── db/
│   ├── schema.ts      — DB layer: better-sqlite3, write, search, decay, lifecycle, wiki
│   └── fts.ts         — Full-text search: Porter stemmer, inverted index, BM25
├── ingest/
│   ├── files.ts       — File walker + LLM enrichment pipeline
│   └── sessions.ts    — Session summarization → wiki
├── mcp/
│   └── server.ts      — MCP server (stdio, 19+ tools, auth middleware)
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

## Ingestion

### File Ingestion

Walk a directory, extract knowledge, enrich with LLM:

```bash
inkstone ingest-files --root=/path/to/project

# Skip LLM enrichment (raw dump — use for testing only)
inkstone ingest-files --root=/path/to/dir --no-llm
```

### Session Ingestion

Summarize Claude Code sessions into wiki entries:

```bash
# Today's sessions
inkstone ingest-sessions

# Last 3 days, force re-process
inkstone ingest-sessions --days=3 --force
```

## Backup & Recovery

Automatic backups rotate on every schema change:

```
~/.inkstone/inkstone.db         ← Live database
~/.inkstone/inkstone.db.bak     ← Most recent backup
~/.inkstone/inkstone.db.bak.2   ← Second backup
~/.inkstone/inkstone.db.bak.3   ← Third backup
```

**If the DB is corrupted or you need to revert:**

```bash
inkstone check                          # Check integrity
cp ~/.inkstone/inkstone.db.bak ~/.inkstone/inkstone.db   # Restore
inkstone check                          # Verify
```

## Development

```bash
npm run build        # TypeScript → dist/
npm run dev          # tsc --watch
npm test             # Run tests
```

## Database Schema

| Table | Purpose |
|-------|---------|
| `chunks` | Knowledge entries with text, namespace, type, lifecycle, embeddings |
| `fts_index` | Custom inverted index (term → chunk_id → positions) with BM25 |
| `files` | File tracking (path, hash, mtime) for delta detection |
| `memory_decay` | Per-chunk exponential decay scores |
| `memory_relations` | Graph edges between chunks |
| `embedding_cache` | LLM embedding cache |
| `manifest` | Session ingestion tracking |
| `goals` | Tracked goals (active/complete/abandoned) |
| `hypotheses` | Hypotheses with evidence |
| `failure_patterns` | Recurring failure patterns |
| `nlm_sync` | NotebookLM sync state |
| `users` | Multi-user auth |
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
   │ accesses  │ no access    │ stale       │ AND expired
```

## License

MIT
