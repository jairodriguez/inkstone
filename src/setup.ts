import { execSync } from "node:child_process";
import { OLLAMA_URL, OLLAMA_CHAT_MODEL, OLLAMA_EMBED_MODEL } from "./config.js";

interface CheckResult {
  name: string;
  status: "ok" | "missing" | "error";
  detail: string;
}

async function checkOllama(): Promise<CheckResult> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { name: "Ollama", status: "error", detail: `HTTP ${res.status}` };
    const data = await res.json() as { models: { name: string }[] };
    return { name: "Ollama", status: "ok", detail: `Running at ${OLLAMA_URL}` };
  } catch (e) {
    return { name: "Ollama", status: "missing", detail: `Not reachable at ${OLLAMA_URL}. Install from https://ollama.ai` };
  }
}

async function checkModel(tag: string): Promise<CheckResult> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { name: tag, status: "error", detail: `Ollama not reachable` };
    const data = await res.json() as { models: { name: string }[] };
    const found = data.models?.some((m) => m.name === tag);
    return found
      ? { name: tag, status: "ok", detail: "Pulled" }
      : { name: tag, status: "missing", detail: `Not pulled. Run: ollama pull ${tag}` };
  } catch (e) {
    return { name: tag, status: "error", detail: String(e) };
  }
}

function pullModel(tag: string): boolean {
  console.log(`\nPulling ${tag} (this may take a while)...`);
  try {
    execSync(`ollama pull ${tag}`, { stdio: "inherit", timeout: 600_000 });
    return true;
  } catch {
    return false;
  }
}

function installOllama(): void {
  const platform = process.platform;
  console.log("\nInstall Ollama manually:");
  if (platform === "darwin") {
    console.log("  brew install --cask ollama");
  } else if (platform === "linux") {
    console.log("  curl -fsSL https://ollama.ai/install.sh | sh");
  } else {
    console.log("  Download from https://ollama.ai");
  }
  console.log("  Then start Ollama and run: inkstone setup");
}

export async function runSetup(): Promise<void> {
  console.log("Inkstone Setup — Checking Prerequisites\n");

  const ollama = await checkOllama();
  console.log(`  ${ollama.status === "ok" ? "✓" : "✗"} ${ollama.name}: ${ollama.detail}`);

  let modelsOk = false;
  if (ollama.status === "ok") {
    const chat = await checkModel(OLLAMA_CHAT_MODEL);
    console.log(`  ${chat.status === "ok" ? "✓" : "✗"} Model ${OLLAMA_CHAT_MODEL}: ${chat.detail}`);

    const embed = await checkModel(OLLAMA_EMBED_MODEL);
    console.log(`  ${embed.status === "ok" ? "✓" : "✗"} Model ${OLLAMA_EMBED_MODEL}: ${embed.detail}`);

    modelsOk = chat.status === "ok" && embed.status === "ok";
  }

  console.log("\n");

  if (ollama.status === "missing") {
    installOllama();
    return;
  }

  if (modelsOk) {
    console.log("All prerequisites satisfied. Ready to run.");
    console.log("  inkstone              Start MCP server");
    console.log(`  inkstone nightly      Full pipeline (requires --root)`);
    return;
  }

  if (ollama.status === "ok") {
    const chat = await checkModel(OLLAMA_CHAT_MODEL);
    const embed = await checkModel(OLLAMA_EMBED_MODEL);

    if (chat.status === "missing") {
      console.log(`Pull ${OLLAMA_CHAT_MODEL} now? This is the main summarization model (required for session ingestion).`);
      if (pullModel(OLLAMA_CHAT_MODEL)) {
        console.log(`  ✓ ${OLLAMA_CHAT_MODEL} pulled`);
      } else {
        console.log(`  ✗ Failed to pull ${OLLAMA_CHAT_MODEL}. Try: ollama pull ${OLLAMA_CHAT_MODEL}`);
      }
    }

    if (embed.status === "missing") {
      console.log(`\nPull ${OLLAMA_EMBED_MODEL} now? This is the embedding model (required for hybrid search).`);
      if (pullModel(OLLAMA_EMBED_MODEL)) {
        console.log(`  ✓ ${OLLAMA_EMBED_MODEL} pulled`);
      } else {
        console.log(`  ✗ Failed to pull ${OLLAMA_EMBED_MODEL}. Try: ollama pull ${OLLAMA_EMBED_MODEL}`);
      }
    }
  }

  console.log("\nDone. Run `inkstone` to start the server.");
}
