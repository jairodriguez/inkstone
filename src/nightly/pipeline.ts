/**
 * Inkstone — Nightly Pipeline Orchestrator
 *
 * Long-running process that runs each pipeline step as a child process.
 * Saves state after each step so it can resume on restart.
 * A step crash doesn't kill the orchestrator.
 */

import { spawnSync, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DB_PATH, WIKI_DIR } from "../config.js";

const INKSTONE_ROOT = join(import.meta.dirname, "../..");
const CLI_PATH = join(INKSTONE_ROOT, "dist/index.js");
const STATE_DIR = join(import.meta.dirname, "../../../..", ".inkstone");
const STATE_PATH = join(STATE_DIR, "nightly-state.json");
const WIKI_GIT_DIR = join(INKSTONE_ROOT, "../../..");

interface StepResult {
  step: string;
  status: "ok" | "fail" | "skip" | "timeout";
  exitCode?: number;
  durationSec: number;
  error?: string;
  timestamp: string;
}

interface PipelineState {
  runId: string;
  startedAt: string;
  completedAt?: string;
  steps: StepResult[];
  currentStep?: string;
  failures: number;
}

function loadState(runId: string): PipelineState {
  try {
    if (!existsSync(STATE_PATH)) return freshState(runId);
    const data = JSON.parse(readFileSync(STATE_PATH, "utf-8"));
    if (data.runId === runId) return data;
    return freshState(runId);
  } catch {
    return freshState(runId);
  }
}

function freshState(runId: string): PipelineState {
  return {
    runId,
    startedAt: new Date().toISOString(),
    steps: [],
    failures: 0,
  };
}

function saveState(state: PipelineState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function isStepDone(state: PipelineState, stepName: string): boolean {
  return state.steps.some(
    (s) => s.step === stepName && (s.status === "ok" || s.status === "skip"),
  );
}

interface StepDef {
  name: string;
  args: string[];
  timeoutSec: number;
  critical?: boolean;
}

function getSteps(businessRoot: string): StepDef[] {
  return [
    {
      name: "ingest-sessions",
      args: ["ingest-sessions", "--days=1"],
      timeoutSec: 600,
    },
    {
      name: "ingest-files",
      args: ["ingest-files", `--root=${businessRoot}`, "--skip-enriched"],
      timeoutSec: 3600,
    },
    {
      name: "index-wiki",
      args: ["index"],
      timeoutSec: 1800,
    },
    {
      name: "dream-fast",
      args: ["dream", "--steps=1,2,3,4,5,6,7", "--step-timeout=120"],
      timeoutSec: 900,
    },
    {
      name: "dream-llm",
      args: ["dream", "--steps=8,9,10,11,12,13,14", "--step-timeout=300"],
      timeoutSec: 3600,
    },
  ];
}

function runStep(step: StepDef): StepResult {
  const start = Date.now();
  const timestamp = new Date().toISOString();

  console.log(`\n--- STEP: ${step.name} ---`);
  console.log(`  command: node ${CLI_PATH} ${step.args.join(" ")}`);
  console.log(`  timeout: ${step.timeoutSec}s`);

  const result = spawnSync("node", [CLI_PATH, ...step.args], {
    timeout: step.timeoutSec * 1000,
    killSignal: "SIGKILL",
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      INKSTONE_DB: DB_PATH,
      INKSTONE_WIKI: WIKI_DIR,
    },
  });

  const durationSec = Math.round((Date.now() - start) / 1000);

  if (result.error) {
    const msg = result.error.message;
    console.log(`  FAIL: ${step.name} (${msg}, ${durationSec}s)`);
    return { step: step.name, status: "fail", durationSec, error: msg, timestamp };
  }

  if (result.status === null) {
    console.log(`  TIMEOUT: ${step.name} (killed after ${step.timeoutSec}s)`);
    return { step: step.name, status: "timeout", durationSec, error: "SIGKILL", timestamp };
  }

  if (result.status !== 0) {
    const err = result.stderr?.slice(-500) || `exit ${result.status}`;
    console.log(`  FAIL: ${step.name} (exit ${result.status}, ${durationSec}s)`);
    return {
      step: step.name,
      status: "fail",
      exitCode: result.status,
      durationSec,
      error: err,
      timestamp,
    };
  }

  console.log(`  OK: ${step.name} (${durationSec}s)`);
  return { step: step.name, status: "ok", exitCode: 0, durationSec, timestamp };
}

function runGitPush(): StepResult {
  const start = Date.now();
  const timestamp = new Date().toISOString();

  console.log(`\n--- STEP: git-push ---`);

  const addResult = spawnSync("git", ["add", "wiki/"], {
    cwd: WIKI_GIT_DIR,
    encoding: "utf-8",
  });

  const diffResult = spawnSync("git", ["diff", "--cached", "--quiet"], {
    cwd: WIKI_GIT_DIR,
    encoding: "utf-8",
  });

  if (diffResult.status === 0) {
    const durationSec = Math.round((Date.now() - start) / 1000);
    console.log(`  OK: git-push (nothing to commit, ${durationSec}s)`);
    return { step: "git-push", status: "skip", durationSec, timestamp };
  }

  const commitResult = spawnSync(
    "git",
    ["commit", "-m", "inkstone nightly wiki update"],
    { cwd: WIKI_GIT_DIR, encoding: "utf-8" },
  );

  if (commitResult.status !== 0) {
    const durationSec = Math.round((Date.now() - start) / 1000);
    const err = commitResult.stderr?.slice(-300) || "commit failed";
    console.log(`  FAIL: git-push commit (${err})`);
    return { step: "git-push", status: "fail", durationSec, error: err, timestamp };
  }

  const pushResult = spawnSync("git", ["push"], {
    cwd: WIKI_GIT_DIR,
    encoding: "utf-8",
    timeout: 120_000,
  });

  const durationSec = Math.round((Date.now() - start) / 1000);

  if (pushResult.status !== 0) {
    const err = pushResult.stderr?.slice(-300) || "push failed";
    console.log(`  FAIL: git-push push (${err})`);
    return { step: "git-push", status: "fail", durationSec, error: err, timestamp };
  }

  console.log(`  OK: git-push (${durationSec}s)`);
  return { step: "git-push", status: "ok", exitCode: 0, durationSec, timestamp };
}

function killStaleMcpProcesses(): { killed: number; kept: number } {
  try {
    const output = execSync(
      "ps aux | grep 'inkstone.*mcp\\|inkstone.*server' | grep -v grep | grep -v nightly",
      { encoding: "utf-8", timeout: 10_000 },
    ).trim();
    if (!output) return { killed: 0, kept: 0 };

    const lines = output.split("\n");
    if (lines.length <= 1) return { killed: 0, kept: lines.length };

    const pids: number[] = [];
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[1], 10);
      if (pid && pid !== process.pid) pids.push(pid);
    }

    let killed = 0;
    for (const pid of pids.slice(1)) {
      try {
        process.kill(pid, "SIGTERM");
        killed++;
      } catch {}
    }

    return { killed, kept: pids.length - killed };
  } catch {
    return { killed: 0, kept: 0 };
  }
}

export async function runNightlyPipeline(
  businessRoot: string,
  opts: { resume?: boolean; dryRun?: boolean } = {},
): Promise<void> {
  const runId = new Date().toISOString().slice(0, 10);
  const state = opts.resume ? loadState(runId) : freshState(runId);

  if (!opts.dryRun) {
    const cleanup = killStaleMcpProcesses();
    if (cleanup.killed > 0) {
      console.log(`Pre-run cleanup: killed ${cleanup.killed} stale MCP process(es), kept ${cleanup.kept}`);
    }
  }

  if (opts.resume) {
    const done = state.steps.filter((s) => s.status === "ok" || s.status === "skip").map((s) => s.step);
    console.log(`Resuming pipeline run ${state.runId}`);
    console.log(`Completed steps: ${done.join(", ") || "none"}`);
    console.log(`Failures so far: ${state.failures}`);
  } else {
    console.log(`=== Inkstone Nightly Pipeline ===`);
    console.log(`Run ID: ${runId}`);
  }

  saveState(state);

  const steps = getSteps(businessRoot);

  for (const step of steps) {
    if (isStepDone(state, step.name)) {
      console.log(`  SKIP: ${step.name} (already done)`);
      continue;
    }

    if (opts.dryRun) {
      console.log(`  [DRY RUN] ${step.name}: node ${step.args.join(" ")}`);
      state.steps.push({ step: step.name, status: "skip", durationSec: 0, timestamp: new Date().toISOString() });
      saveState(state);
      continue;
    }

    state.currentStep = step.name;
    saveState(state);

    const result = runStep(step);
    state.steps.push(result);
    state.currentStep = undefined;

    if (result.status === "fail" || result.status === "timeout") {
      state.failures++;
      if (step.critical) {
        console.log(`\n  CRITICAL step ${step.name} failed — aborting pipeline.`);
        saveState(state);
        process.exit(1);
      }
    }

    saveState(state);
  }

  if (!isStepDone(state, "git-push")) {
    if (opts.dryRun) {
      console.log(`  [DRY RUN] git-push`);
    } else {
      state.currentStep = "git-push";
      saveState(state);
      const gitResult = runGitPush();
      state.steps.push(gitResult);
      state.currentStep = undefined;
      if (gitResult.status === "fail") state.failures++;
      saveState(state);
    }
  }

  state.completedAt = new Date().toISOString();
  saveState(state);

  const ok = state.steps.filter((s) => s.status === "ok").length;
  const skipped = state.steps.filter((s) => s.status === "skip").length;
  const failed = state.steps.filter((s) => s.status === "fail" || s.status === "timeout").length;
  const totalSec = state.steps.reduce((sum, s) => sum + s.durationSec, 0);

  console.log(`\n=== Pipeline Complete ===`);
  console.log(`  OK: ${ok}  Skip: ${skipped}  Fail: ${failed}  Total: ${totalSec}s`);
  console.log(`  State: ${STATE_PATH}`);

  if (state.failures > 0) process.exit(1);
}

export function showNightlyStatus(): void {
  if (!existsSync(STATE_PATH)) {
    console.log("No nightly pipeline state found.");
    return;
  }
  const state: PipelineState = JSON.parse(readFileSync(STATE_PATH, "utf-8"));
  console.log(`Run: ${state.runId}`);
  console.log(`Started: ${state.startedAt}`);
  if (state.completedAt) console.log(`Completed: ${state.completedAt}`);
  if (state.currentStep) console.log(`Current: ${state.currentStep}`);
  console.log(`Failures: ${state.failures}`);
  console.log(`\nSteps:`);
  for (const s of state.steps) {
    const icon = s.status === "ok" ? "✓" : s.status === "skip" ? "○" : s.status === "timeout" ? "⏱" : "✗";
    console.log(`  ${icon} ${s.step} (${s.durationSec}s) ${s.error ? "— " + s.error.slice(0, 80) : ""}`);
  }
}
