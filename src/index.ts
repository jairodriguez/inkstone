#!/usr/bin/env node
/**
 * Inkstone — CLI Entry Point
 *
 * Usage:
 * inkstone Start MCP server (stdio)
 * inkstone dream Run dream cycle
 * inkstone dream --steps 1,3,5 Run specific dream steps
 * inkstone search <query> Search memories
 * inkstone write <text> Write a memory
 * inkstone status Show DB stats
 * inkstone migrate Run migration from legacy DBs
 * inkstone index Re-index wiki directory
 * inkstone user add <name> Create a user (enables multi-user mode)
 * inkstone user list List users
 * inkstone user remove <id> Remove a user
 * inkstone user grant <ns> <uid> <perm> Grant namespace permission
 * inkstone user revoke <ns> <uid> Revoke namespace permission
 */

import { initDb, searchWiki, searchWikiHybrid, writeChunk, writeChunkWithEmbedding, syncWikiIndex, closeDb, embedAll, type SearchOptions, type WriteOptions } from "./db/schema.js";
import { runDreamCycle } from "./dream/cycle.js";
import { LLMClient } from "./llm/client.js";
import { DB_PATH, type MemoryType } from "./config.js";
import { startServer } from "./mcp/server.js";
import { ingestSessions } from "./ingest/sessions.js";
import { ingestFiles } from "./ingest/files.js";
import { deepQuery } from "./nlm/deep-query.js";
import { listNlmDomainRoutes } from "./nlm/state.js";

async function main(): Promise<void> {
  let shuttingDown = false;

  const gracefulShutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${signal}, saving DB and exiting...`);
    try { closeDb(); } catch { /* best effort */ }
    process.exit(0);
  };

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));

  const args = process.argv.slice(2);
  const command = args[0] || "serve";

  switch (command) {
    case "serve":
    case "mcp": {
      await startServer();
      break;
    }

    case "dream": {
      const stepArg = args.find((a) => a.startsWith("--steps"));
      const steps = stepArg
        ? (stepArg.includes("=") ? stepArg.split("=")[1] : args[args.indexOf(stepArg) + 1])
          ?.split(",").map(Number).filter((n) => n >= 1 && n <= 14)
        : undefined;
      const timeoutArg = args.find((a) => a.startsWith("--step-timeout"));
      const stepTimeoutSec = timeoutArg
        ? parseInt(timeoutArg.includes("=") ? timeoutArg.split("=")[1] : args[args.indexOf(timeoutArg) + 1], 10)
        : undefined;

      console.log(`Running dream cycle${steps ? ` (steps: ${steps.join(", ")})` : ""}${stepTimeoutSec ? ` (${stepTimeoutSec}s per step)` : ""}...`);
      const db = await initDb();
      const llm = new LLMClient();

      let results: import("./dream/cycle.js").DreamResult[];
      const dreamPromise = runDreamCycle(db, llm, {
        steps,
        stepTimeoutMs: stepTimeoutSec ? stepTimeoutSec * 1000 : undefined,
      });

      dreamPromise.then((r) => { results = r; }).catch((err) => {
        results = [{ step: "dream_cycle", status: "error", error: String(err) }];
      }).finally(() => {
        for (const r of results!) {
          const icon = r.status === "ok" ? "✓" : r.status === "error" ? "✗" : "⊘";
          console.log(`  ${icon} ${r.step}: ${r.detail || r.error || "done"}`);
        }
        closeDb();
        process.exit(0);
      });
      return;
    }

    case "search":
    case "query": {
      const query = args.slice(1).join(" ");
      if (!query) { console.error("Usage: inkstone search <query>"); process.exit(1); }

      const db = await initDb();
      const results = await searchWikiHybrid(db, { query, limit: 10 });

      if (results.length === 0) {
        console.log("No results found.");
      } else {
        for (const r of results) {
          console.log(`\n── ${r.id} ──`);
          console.log(`  ns: ${r.namespace}  type: ${r.knowledgeType}  lifecycle: ${r.lifecycle}`);
          console.log(`  score: ${r.score.toFixed(3)} (fts=${r.ftsScore.toFixed(3)} vec=${r.vectorScore.toFixed(3)} decay=${r.decayBoost.toFixed(3)} trust=${r.sourceTrust} type=${r.typeWeight} graph=${r.graphBoost.toFixed(3)})`);
          console.log(`  ${r.text.slice(0, 200).replace(/\n/g, " ")}...`);
        }
        console.log(`\n${results.length} result(s)`);
      }

      closeDb();
      break;
    }

    case "deep-query": {
      let domain: string | undefined;
      const queryParts: string[] = [];
      const forceRefresh = args.includes("--force") || args.includes("--refresh");
      for (const arg of args.slice(1)) {
        if (arg.startsWith("--domain=")) domain = arg.split("=")[1];
        else if (arg !== "--force" && arg !== "--refresh") queryParts.push(arg);
      }
      const query = queryParts.join(" ").trim();
      if (!query) { console.error("Usage: inkstone deep-query [--domain=business|content|system] <query>"); process.exit(1); }

      const db = await initDb();
      const result = await deepQuery(db, { query, domain, forceRefresh });
      console.log(JSON.stringify(result, null, 2));
      closeDb();
      break;
    }

    case "nlm-status": {
      console.log(JSON.stringify(listNlmDomainRoutes(), null, 2));
      break;
    }

    case "write":
    case "add": {
      // Parse flags and collect text
      let namespace = "/general";
      let source = "cli";
      const textParts: string[] = [];
      for (const arg of args.slice(1)) {
        if (arg.startsWith("--ns=")) namespace = arg.split("=")[1];
        else if (arg.startsWith("--source=")) source = arg.split("=")[1];
        else textParts.push(arg);
      }
      const text = textParts.join(" ");
      if (!text) { console.error("Usage: inkstone write <text> [--ns=/namespace] [--source=source]"); process.exit(1); }

      const db = await initDb();
      const id = await writeChunkWithEmbedding(db, { text, namespace, source });
      console.log(`Written: ${id}`);

      closeDb();
      break;
    }

    case "status":
    case "stats": {
      const db = await initDb();

      const cnt = (sql: string) => Number((db.prepare(sql).get() as Record<string, unknown>)?.["COUNT(*)"] ?? 0);

      const chunkCount = cnt("SELECT COUNT(*) FROM chunks");
      const decayCount = cnt("SELECT COUNT(*) FROM memory_decay");
      const relationCount = cnt("SELECT COUNT(*) FROM memory_relations");
      const goalCount = cnt("SELECT COUNT(*) FROM goals WHERE status = 'active'");
      const hypothesisCount = cnt("SELECT COUNT(*) FROM hypotheses WHERE status = 'open'");
      const failureCount = cnt("SELECT COUNT(*) FROM failure_patterns");
      const lifecycleDist = db.prepare("SELECT lifecycle, COUNT(*) as cnt FROM chunks GROUP BY lifecycle").all() as Record<string, unknown>[];
      const typeDist = db.prepare("SELECT knowledge_type, COUNT(*) as cnt FROM chunks GROUP BY knowledge_type").all() as Record<string, unknown>[];

      console.log("Inkstone Memory Status");
      console.log("═══════════════════════");
      console.log(`  DB:        ${DB_PATH}`);
      console.log(`  Chunks:    ${chunkCount}`);
      console.log(`  Decays:    ${decayCount}`);
      console.log(`  Relations: ${relationCount}`);
      console.log(`  Goals:     ${goalCount} active`);
      console.log(`  Hypotheses: ${hypothesisCount} open`);
      console.log(`  Failures:  ${failureCount} patterns`);

      if (lifecycleDist.length > 0) {
        console.log("\n  Lifecycle distribution:");
        for (const row of lifecycleDist) {
          console.log(`    ${row.lifecycle}: ${row.cnt}`);
        }
      }

      if (typeDist.length > 0) {
        console.log("\n  Knowledge type distribution:");
        for (const row of typeDist) {
          console.log(`    ${row.knowledge_type}: ${row.cnt}`);
        }
      }

      closeDb();
      break;
    }

    case "index": {
      console.log("Re-indexing wiki directory...");
      const db = await initDb();
      const result = await syncWikiIndex(db);
      console.log(`  Indexed: ${result.indexed}  Deleted: ${result.deleted}`);
      closeDb();
      break;
    }

    case "check":
    case "integrity": {
      console.log("Checking database integrity...");
      const db = await initDb();
      const checkResult = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
      const status = checkResult[0]?.integrity_check || "unknown";
      if (status === "ok") {
        console.log("  ✓ Database integrity: OK");
      } else {
        console.error(`  ✗ Database integrity: FAILED`);
        console.error(`  ${status}`);
        process.exit(1);
      }
      const cnt = (sql: string) => Number((db.prepare(sql).get() as Record<string, unknown>)?.["COUNT(*)"] ?? 0);
      console.log(`  Chunks: ${cnt("SELECT COUNT(*) FROM chunks")}`);
      console.log(`  FTS entries: ${cnt("SELECT COUNT(*) FROM fts_index")}`);
      console.log(`  DB path: ${DB_PATH}`);
      closeDb();
      break;
    }

    case "embed-all": {
      const batchSize = Number(args.find((a) => a.startsWith("--batch="))?.split("=")[1]) || 50;
      console.log("Embedding all chunks without vectors...");
      const db = await initDb();
      const result = await embedAll(db, batchSize);
      console.log(`  Embedded: ${result.embedded}  Failed: ${result.failed}  Skipped: ${result.skipped}`);
      closeDb();
      break;
    }

    case "setup": {
      const { runSetup } = await import("./setup.js");
      await runSetup();
      break;
    }

    case "migrate": {
 console.log("Migration from legacy databases...");
 console.log(" (Use: inkstone-migrate --from hippocampus --db /path/to/hippocampus.db)");
 console.log(" (Use: inkstone-migrate --from memex --db /path/to/memex.sqlite)");
 console.log(" See src/db/migrate-from-legacy.ts");
 break;
 }

    case "ingest-sessions": {
      const daysArg = args.find((a) => a.startsWith("--days"));
      const days = daysArg ? Number(daysArg.split("=")[1]) : 1;
      const dryRun = args.includes("--dry-run");
      const force = args.includes("--force");

      console.log(`Ingesting sessions into wiki (last ${days} day${days > 1 ? "s" : ""})...`);
      const result = await ingestSessions({ daysBack: days, dryRun, force });
      console.log(`  Files processed: ${result.filesProcessed}`);
      console.log(`  Summaries written: ${result.summariesWritten}`);
      console.log(`  Skipped: ${result.skipped}`);
      if (result.errors.length > 0) {
        console.log(`  Errors: ${result.errors.length}`);
        for (const e of result.errors) console.log(`    ✗ ${e}`);
      }
      break;
    }

  case "ingest-files": {
    const rootArg = args.find((a) => a.startsWith("--root") || a.startsWith("--dir"));
    const rootDir = rootArg ? rootArg.split("=")[1] : process.cwd();
    const dryRun = args.includes("--dry-run");
    const force = args.includes("--force");
    const noLLM = args.includes("--no-llm");
    const limitArg = args.find((a) => a.startsWith("--limit"));
    const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : undefined;
    const skipEnriched = args.includes("--skip-enriched");

    console.log(`Ingesting files from ${rootDir}...`);
    const db = await initDb();
    const result = await ingestFiles(db, { rootDir, dryRun, force, noLLM, limit, skipEnriched });
      console.log(`  Scanned: ${result.scanned}`);
      console.log(`  Ingested: ${result.ingested}`);
      console.log(`  Enriched: ${result.enriched}`);
      console.log(`  Skipped: ${result.skipped}`);
      if (result.errors.length > 0) {
        console.log(`  Errors: ${result.errors.length}`);
        for (const e of result.errors) console.log(`    ✗ ${e}`);
      }
      closeDb();
      break;
    }

  // ── User Management ────────────────────────────────────────────

 case "user": {
 const subcmd = args[1];
 const db = await initDb();
 const { createUser, listUsers, removeUser, grantPermission, revokePermission, isMultiUserMode } = await import("./auth/auth.js");

 switch (subcmd) {
 case "add":
 case "create": {
 const name = args[2];
 const role = args.find((a) => a.startsWith("--role="))?.split("=")[1] as "admin" | "user" || "user";
 if (!name) { console.error("Usage: inkstone user add <name> [--role=admin|user]"); process.exit(1); }

 const result = createUser(db, name, role);
 console.log(`User created:`);
 console.log(` ID: ${result.id}`);
 console.log(` Name: ${result.name}`);
 console.log(` Role: ${result.role}`);
 console.log(` API Key: ${result.apiKey}`);
 console.log(`\n⚠ Save the API key now. It cannot be recovered.`);
 break;
 }

 case "list":
 case "ls": {
 const users = listUsers(db);
 if (users.length === 0) {
 console.log("No users. Server is in single-user mode (open access).");
 } else {
 console.log(`Users (${users.length}):`);
 for (const u of users) {
 console.log(` ${u.id} ${u.name} [${u.role}] created ${u.created_at}`);
 }
 console.log(`\nMode: multi-user (API key required for all requests)`);
 }
 break;
 }

 case "remove":
 case "rm": {
 const userId = args[2];
 if (!userId) { console.error("Usage: inkstone user remove <userId>"); process.exit(1); }
 const removed = removeUser(db, userId);
 console.log(removed ? `User ${userId} removed` : `User ${userId} not found`);
 break;
 }

 case "grant": {
 const ns = args[2];
 const userId = args[3];
 const perm = args[4] as "read" | "write" | "admin";
 if (!ns || !userId || !perm) {
 console.error("Usage: inkstone user grant <namespace> <userId> <read|write|admin>");
 process.exit(1);
 }
 grantPermission(db, ns, userId, perm);
 console.log(`Granted ${perm} on ${ns} to user ${userId}`);
 break;
 }

 case "revoke": {
 const ns = args[2];
 const userId = args[3];
 if (!ns || !userId) {
 console.error("Usage: inkstone user revoke <namespace> <userId>");
 process.exit(1);
 }
 revokePermission(db, ns, userId);
 console.log(`Revoked access on ${ns} from user ${userId}`);
 break;
 }

 default:
 console.error(`Unknown user subcommand: ${subcmd}`);
 console.error("Usage: inkstone user <add|list|remove|grant|revoke>");
 process.exit(1);
 }

 closeDb();
 break;
 }

    case "nightly": {
  const subcmd = args[1] || "run";
  const businessRoot = args.find((a) => a.startsWith("--root="))?.split("=")[1] || `${process.env.HOME || "."}/data`;

  if (subcmd === "status") {
    const { showNightlyStatus } = await import("./nightly/pipeline.js");
    showNightlyStatus();
    break;
  }

  const resume = args.includes("--resume");
  const dryRun = args.includes("--dry-run");
  const { runNightlyPipeline } = await import("./nightly/pipeline.js");
  await runNightlyPipeline(businessRoot, { resume, dryRun });
  break;
}

case "help":
    case "--help":
    case "-h": {
 console.log(`
Inkstone — Agentic MCP Memory Server with Dream Cycle
Native SQLite (better-sqlite3) · 67K chunks · 5.5M FTS entries

Commands:
  inkstone                          Start MCP server (stdio transport)
  inkstone help                     Show this help

  Search:
  inkstone search <query>           Hybrid FTS + vector + graph search
  inkstone deep-query <query>       Local + NLM deep archive (cached)
    --domain=business|content|system
    --force                         Bypass NLM cache
  inkstone nlm-status               Show NotebookLM domain routes

  Write:
  inkstone write <text>             Write a memory (with embedding)
    --ns=/namespace                 Namespace (default: /general)
    --source=label                  Source (default: cli)

Pipeline:
  inkstone nightly            Run full nightly pipeline (persistent orchestrator)
    --root=DIR                Data root (default: ~/data)
    --resume                  Resume from last saved state
    --dry-run                 Preview steps without executing
  inkstone nightly status     Show last pipeline run state

Maintenance:
  inkstone dream              Full 14-step dream cycle
    --steps=1,3,5                   Specific steps only
    --step-timeout=600              Per-step timeout in seconds
  inkstone embed-all                Generate embeddings for missing vectors
    --batch=N                       Commit batch size (default: 50)
  inkstone index                    Re-index wiki directory

  Diagnostics:
  inkstone status                   DB statistics (chunks, types, decays)
  inkstone check                    Integrity check (PRAGMA integrity_check)
  inkstone setup                    Check prerequisites (Ollama, models)

  Ingestion:
  inkstone ingest-files             Ingest workspace files
    --root=DIR                      Root to scan (default: cwd)
    --force                         Re-ingest unchanged files
    --no-llm                        Skip LLM enrichment (NOT recommended)
    --dry-run                       Preview without writing
    --limit=N                       Max files to process
    --skip-enriched                 Skip already-enriched files
  inkstone ingest-sessions          Summarize Claude sessions into wiki
    --days=N                        Look back (default: 1)
    --force                         Re-process already-ingested sessions
    --dry-run                       Preview without writing

  User Management:
  inkstone user add <name>          Create user (first = enable multi-user)
    --role=admin                    Admin role
  inkstone user list                List all users
  inkstone user remove <userId>     Delete a user
  inkstone user grant <ns> <uid> <perm>  Grant namespace permission
  inkstone user revoke <ns> <uid>   Revoke namespace permission

  Migration:
  inkstone migrate                  Migrate from legacy (hippocampus/memex)

Configuration (env vars):
  INKSTONE_DB              DB path (default: ~/.inkstone/inkstone.db)
  INKSTONE_ROOT            Root dir (default: ~/.inkstone)
  INKSTONE_WIKI            Wiki dir (default: ~/.inkstone/wiki)
  OPENROUTER_API_KEY       For cloud LLM/embeddings
  INKSTONE_OR_MODEL        OpenRouter model (default: google/gemini-2.0-flash-001)
  INKSTONE_OLLAMA_MODEL    Ollama model (default: gemma4:e4b)
  INKSTONE_EMBED_MODEL     Embedding model (default: nomic-embed-text)

Multi-user mode:
  No users = single-user (open access, no API key needed)
  First "inkstone user add" → multi-user mode (API key required)
  Admins see all namespaces; users see only granted + personal

  ─ 19 MCP tools: memory_search, memory_write, memory_get,
     memory_dream, memory_goals, memory_hypotheses, memory_failures,
     memory_graph_*, memory_self_model, memory_gemini_*, memory_nlm_*
`);
      break;
    }

    default:
      console.error(`Unknown command: ${command}. Run 'inkstone help' for usage.`);
      process.exit(1);
  }
}

const isMain = process.argv[1] && (
  process.argv[1] === import.meta.filename ||
  process.argv[1].replace(/\\/g, "/").endsWith(import.meta.filename?.replace(/\\/g, "/").split("/").pop() ?? "")
);

if (isMain) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
