/**
 * Inkstone — NLM CLI Client
 *
 * Safe wrapper around the existing `nlm` NotebookLM CLI. Uses execFile so
 * user queries are passed as argv, not interpolated into shell strings.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { NlmNotebook, NlmQueryResult } from "./types.js";

const execFileAsync = promisify(execFile);

export class NlmClient {
  constructor(private bin = process.env.NLM || "nlm") {}

  async listNotebooks(): Promise<NlmNotebook[]> {
    const stdout = await this.run(["notebook", "list"]);
    const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
    return parsed.map((n) => ({
      id: String(n.id),
      title: String(n.title || n.name || "Untitled"),
      source_count: typeof n.source_count === "number" ? n.source_count : undefined,
      updated_at: typeof n.updated_at === "string" ? n.updated_at : undefined,
    }));
  }

  async queryNotebook(notebookId: string, question: string): Promise<NlmQueryResult> {
    const stdout = await this.run(["notebook", "query", notebookId, question]);
    return parseQueryResult(stdout);
  }

  async addSource(notebookId: string, title: string, content: string): Promise<{ ok: boolean; raw: string }> {
    const stdout = await this.run(["source", "add", notebookId, "--text", content, "--title", title, "--wait"], 300_000);
    return { ok: stdout.includes("✓") || /added|created|success/i.test(stdout), raw: stdout };
  }

  private async run(args: string[], timeout = 180_000): Promise<string> {
    try {
      const { stdout, stderr } = await execFileAsync(this.bin, args, {
        timeout,
        maxBuffer: 50 * 1024 * 1024,
        env: {
          ...process.env,
          PATH: process.env.PATH || "",
        },
      });
      return stdout || stderr;
    } catch (err) {
      const e = err as Error & { stdout?: string; stderr?: string };
      const output = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n");
      throw new Error(`nlm ${args.join(" ")} failed: ${output}`);
    }
  }
}

export function parseQueryResult(raw: string): NlmQueryResult {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const value = (parsed.value && typeof parsed.value === "object" ? parsed.value : parsed) as Record<string, unknown>;
    const refs = Array.isArray(value.references) ? value.references : [];
    return {
      answer: String(value.answer || ""),
      conversation_id: typeof value.conversation_id === "string" ? value.conversation_id : undefined,
      sources_used: Array.isArray(value.sources_used) ? value.sources_used.map(String) : [],
      citations: value.citations && typeof value.citations === "object" ? value.citations as Record<string, string> : {},
      references: refs.map((r) => {
        const ref = r as Record<string, unknown>;
        return {
          source_id: String(ref.source_id || ""),
          citation_number: Number(ref.citation_number || 0),
          cited_text: String(ref.cited_text || ""),
        };
      }),
      raw: parsed,
    };
  } catch {
    return {
      answer: raw.trim(),
      sources_used: [],
      citations: {},
      references: [],
      raw,
    };
  }
}
