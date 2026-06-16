# Inkstone — Your AI Work Becomes Searchable Knowledge. Automatically.

[![CI](https://github.com/jairodriguez/inkstone/actions/workflows/ci.yml/badge.svg)](https://github.com/jairodriguez/inkstone/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-Compatible-blue.svg)](https://modelcontextprotocol.io)
[![npm](https://img.shields.io/npm/v/inkstone-mcp)](https://www.npmjs.com/package/inkstone-mcp)

You run 20+ AI sessions a day. Decisions happen in them. Infrastructure details, deployment preferences, bug root causes, design choices — all discussed, none captured. Next session starts from zero. You repeat yourself.

Most "memory servers" are flat key-value stores — you manually write notes and they return them verbatim. That's not memory, that's a text file with search.

**Inkstone is different.** It's an automatic knowledge extraction pipeline:

```
Your AI sessions  ──►  Gemma 4 summarizes each session
                          │
                    Extracts decisions, preferences, context
                          │
                     ──►  Writes structured wiki entities
                          │
                     ──►  Indexes into searchable database
                          │
                     ──►  Dream cycle (14 steps)
                          │
                    Maintains itself nightly
```

Run the nightly pipeline. That's it. Your session history becomes a self-maintaining knowledge graph with hybrid search, exponential decay, and zero manual entry.

```bash
# Start the MCP server for your AI agent
inkstone

# Or run the full pipeline manually:
inkstone ingest-sessions   # Summarize today's sessions → wiki entities
inkstone index             # Sync wiki → database
inkstone dream             # 14-step maintenance cycle

# Search everything that was automatically captured
inkstone search "RDS decision"
```

## Prerequisites

Inkstone uses **Ollama** with **Gemma 4** for session summarization and **nomic-embed-text** for vector embeddings.

```bash
# 1. Install Ollama (macOS / Linux)
# macOS:
brew install --cask ollama
# Linux:
curl -fsSL https://ollama.ai/install.sh | sh

# 2. Pull required models
ollama pull gemma4:e4b     # Main summarization model (5.5 GB)
ollama pull nomic-embed-text  # Embedding model (274 MB)

# 3. Verify everything works
inkstone setup
```

All models run locally on your machine. No cloud API keys needed. If you prefer cloud LLMs, set `OPENROUTER_API_KEY` and Inkstone falls back to OpenRouter automatically.

## What Makes Inkstone Different?

Most "memory servers" are passive storage — you write a note, it saves it. Inkstone is an active extraction pipeline. It reads your session history, distills knowledge, and maintains itself.

### Automatic Ingestion (No Manual Entry)

```bash
# Nightly pipeline — runs this every day via cron:
inkstone nightly --root=~/projects
```

The pipeline does all of this automatically:

| Step | What Happens |
|------|-------------|
| `ingest-sessions` | Reads session JSONL (OpenCode, Claude Code), filters noise (tool calls, system msgs, compactions), summarizes dialogue via **Ollama Gemma 4**, writes wiki entity markdown files |
| `ingest-files` | Walks workspace directories, detects new/modified files via hash manifest, feeds each through **Gemma 4** for enrichment — extracts key facts, decisions, entities, relationships |
| `index-wiki` | Syncs wiki markdown → database chunks with embeddings |
| `dream-fast` | Steps 1-7: decay recalc, lifecycle promotion, entity extraction, trivia pruning, wiki reindex, prune expired, graph edges |
| `dream-llm` | Steps 8-14: contradiction detection, goal inference, failure patterns, causal links, hypotheses, self-model updates, cluster distillation |

The pipeline is **resumable** — state saves after every step. A crash doesn't lose progress.

### What You Get vs Other Memory Servers

| Feature | Other servers | Inkstone |
|---------|--------------|----------|
| **Data capture** | Manual writes | Auto-ingest from sessions + files via Gemma 4 |
| **Search** | Keyword match | FTS (Porter + BM25) + vector cosine + graph fusion |
| **Decay** | None | Exponential per type (corrections 10yr, emotions 3d) |
| **Maintenance** | None | 14-step dream cycle (automated nightly) |
| **Lifecycle** | None | active → validated → stale → archived → pruned |
| **Graph** | None | Entity relations, neighbors, paths, centrality, contradiction traversal |
| **SQL engine** | sql.js WASM (13s load, 1.13GB export) | better-sqlite3 native (71ms load, direct WAL writes) |
| **Multi-user** | None | Namespace RBAC with API keys |

### Three Things No Other Memory Server Does

**1. Session-to-Knowledge Pipeline**
Your AI sessions are the richest source of context — decisions made, infrastructure confirmed, bugs root-caused. Inkstone reads session JSONL from OpenCode/Claude Code, filters out tool noise and system messages, feeds the clean dialogue to Gemma 4 (local Ollama), and writes structured wiki entity files. No manual entry.

**2. Decay Scoring That Matches Reality**
Not all knowledge is equally important. A decision from today ranks above a random fact from 6 months ago. Configurable half-lives per type:

| Type | Half-life | Example |
|------|-----------|---------|
| Correction | 10 years | "Root cause was a race condition in the auth module" |
| Preference | 10 years | "We prefer DHL Express for international shipping" |
| Decision | 90 days | "Switched from Postgres to DynamoDB for session store" |
| Emotion | 3 days | "Frustrated with the CI pipeline speed" |
| Financial | 7 days | "AWS bill was $4,200 this month" |

**3. Self-Maintaining Dream Cycle**
Run `inkstone dream` (or let the nightly pipeline do it) and Inkstone runs 14 maintenance steps — decay recalculation, lifecycle promotion, entity extraction, trivia pruning, contradiction detection, goal inference, failure patterns, causal links, hypothesis generation, self-model updates, and cluster distillation. Steps 1-7 require zero external calls. Steps 8-14 use your local LLM (Ollama or OpenRouter).

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
# 1. Start the MCP server for your AI agent
inkstone

# 2. Ingest today's AI sessions (auto-summarizes via Gemma 4 → wiki)
inkstone ingest-sessions

# 3. Ingest your project files
inkstone ingest-files --root=~/my-project

# 4. Sync wiki → database
inkstone index

# 5. Run maintenance (do this nightly via cron)
inkstone dream

# 6. Search everything that was captured
inkstone search "database"

# Or run the whole thing as one resumable pipeline:
inkstone nightly --root=~/my-project
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
inkstone setup                   Check prerequisites (Ollama, models)
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

## Ingestion Pipeline

Inkstone captures knowledge automatically. You don't write memories — Inkstone extracts them from your AI sessions and project files.

### Session Ingestion (Gemma 4 → Wiki Entities)

```bash
inkstone ingest-sessions               # Summarize today's sessions
inkstone ingest-sessions --days=3      # Last 3 days
inkstone ingest-sessions --force       # Re-process already-ingested
inkstone ingest-sessions --dry-run     # Preview without writing
```

**What happens:** Reads session JSONL files from `~/.hermes/sessions/` and `~/.opencode/sessions/`, filters out noise (tool calls, system messages, context compactions, session metadata), extracts clean user + assistant dialogue, sends the full session to **Ollama Gemma 4** for summarization, and writes structured wiki entity markdown files to `~/.inkstone/wiki/entities/`.

Each wiki entity captures decisions made, infrastructure details confirmed, blockers encountered, preferences stated. The wiki indexer (`inkstone index`) syncs these into the database automatically.

**Dedup:** Manifest at `.ingest-manifest.json` tracks processed sessions. Changed sessions are re-summarized, old entities are marked superseded.

### File Ingestion (Workspace → Gemma 4 → Wiki + DB)

```bash
inkstone ingest-files --root=/path/to/project    # Index project directory
inkstone ingest-files --root=. --skip-enriched    # Skip already-enriched files
inkstone ingest-files --root=. --dry-run          # Preview only
inkstone ingest-files --root=. --force            # Re-process everything
inkstone ingest-files --root=. --limit=50         # Cap at 50 files
inkstone ingest-files --root=. --no-llm           # Skip LLM (not recommended)
```

**What happens:** Walks a workspace directory, detects new/modified files via content hash manifest (`.file-manifest.json`), feeds each changed file through **Gemma 4** with a structured enrichment prompt that extracts: summary, key facts, entities mentioned, decisions recorded, and cross-project relationships. Delta tracking means repeated runs are fast.

### Nightly Pipeline (Orchestrator)

```bash
inkstone nightly --root=~/projects                # Full pipeline (resumable)
inkstone nightly --root=~/projects --resume       # Resume from last saved state
inkstone nightly --root=~/projects --dry-run      # Preview steps
inkstone nightly status                           # Show last run state
```

Runs 5 sequential steps with individual timeouts. State saves after each step — a crash doesn't lose progress:

| # | Step | Timeout | What It Does |
|---|------|---------|-------------|
| 1 | `ingest-sessions --days=1` | 10 min | Summarize today's sessions via Gemma 4 → wiki |
| 2 | `ingest-files` | 60 min | Enrich new/changed workspace files → wiki + DB |
| 3 | `index` | 30 min | Sync wiki → database with embeddings |
| 4 | `dream --steps=1-7` | 15 min | Decay, lifecycle, entity extraction, pruning, graph edges (no LLM) |
| 5 | `dream --steps=8-14` | 60 min | Contradictions, goals, failures, causal links, clusters (LLM) |

## Automation

Inkstone is designed to run unattended. Set up the cron once; it captures and maintains itself nightly.

### Install Nightly Cron

```bash
# One command — adds "inkstone nightly --root=~/projects" at 2 AM
inkstone cron-install

# Or manually:
crontab -e
# Add:
0 2 * * * cd ~ && inkstone nightly --root=~/projects 2>&1 | logger -t inkstone-nightly
```

The nightly pipeline runs 5 steps: ingest sessions (Gemma 4 → wiki), ingest files (workspace → wiki), index wiki → DB, dream fast (steps 1-7, no LLM), dream LLM (steps 8-14). Each step has a timeout. State saves between steps — a crash doesn't lose progress.

### What to Tell Your AI Agent

Add this to your project's `CLAUD.md`, `AGENTS.md`, or agent instructions:

```markdown
## Inkstone Memory

Inkstone is a persistent memory server running on this machine.
It auto-ingests AI sessions nightly and maintains a searchable knowledge graph.

### Setup (one-time)
1. Install: `npm install -g inkstone-mcp`
2. Pull models: `ollama pull gemma4:e4b && ollama pull nomic-embed-text`
3. Verify: `inkstone setup`
4. Install cron: `inkstone cron-install` (or `crontab -e`)
5. Connect: add the MCP server config to your client

### Daily use
- Before answering, call `memory_search` for relevant context.
- After making a decision or confirming a fact, call `memory_write` to persist it immediately (don't wait for nightly ingest).
- The nightly pipeline auto-ingests session logs, so repeated context won't be needed tomorrow.

### Commands
inkstone                          Start MCP server (stdio)
inkstone status                   DB statistics
inkstone search <query>           Search memories
inkstone write <text>             Write a memory (use for immediate persistence)
inkstone ingest-sessions          Summarize today's sessions
inkstone nightly --root=.         Full pipeline
inkstone cron-install             Install nightly cron
```

### MCP Client Setup

Connect Inkstone to your AI agent via MCP:

**Claude Code** — add to `~/.claude.json`:
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

**OpenCode** — add to `opencode.json`:
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

**Cline / Continue.dev / any MCP client** — same pattern: command `inkstone`, no args.

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
