/**
 * Inkstone — LLM Client
 *
 * Abstraction over Ollama (local, default) and Gemini CLI (fallback).
 * Retry logic, rate limit handling, and fallback chain.
 */

import { execSync } from "node:child_process";
import {
  OLLAMA_URL, OLLAMA_CHAT_MODEL,
  OPENROUTER_API_KEY, OPENROUTER_URL, OPENROUTER_MODEL, OPENROUTER_FALLBACK,
} from "../config.js";

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMResponse {
  text: string;
  model: string;
  provider: string;
  tokens?: { prompt: number; completion: number };
}

export interface LLMProvider {
  name: string;
  chat(messages: LLMMessage[], model?: string, signal?: AbortSignal): Promise<LLMResponse>;
}

// ── Ollama Provider ────────────────────────────────────────────────

export const ollamaProvider: LLMProvider = {
  name: "ollama",

  async chat(messages: LLMMessage[], model = OLLAMA_CHAT_MODEL, signal?: AbortSignal): Promise<LLMResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);
    if (signal) signal.addEventListener("abort", () => controller.abort());

    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        options: { temperature: 0.3, num_predict: 4096 },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Ollama ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = await res.json() as {
      message: { content: string };
      model: string;
      prompt_eval_count?: number;
      eval_count?: number;
    };

    return {
      text: data.message?.content || "",
      model: data.model || model,
      provider: "ollama",
      tokens: {
        prompt: data.prompt_eval_count ?? 0,
        completion: data.eval_count ?? 0,
      },
    };
  },
};

// ── Gemini CLI Provider ─────────────────────────────────────────────

export const geminiCliProvider: LLMProvider = {
  name: "gemini-cli",

  async chat(messages: LLMMessage[], _model?: string, _signal?: AbortSignal): Promise<LLMResponse> {
    const prompt = messages
      .map(m => m.role === "system" ? `[System]\n${m.content}` : m.content)
      .join("\n\n");

    const child = execSync("gemini -y --prompt -", {
      encoding: "utf-8",
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      input: prompt.slice(0, 50000),
      stdio: ["pipe", "pipe", "pipe"],
    });

    const text = child.trim();
    if (!text) throw new Error("Gemini CLI returned empty response");

    return {
      text,
      model: "gemini-cli",
      provider: "gemini-cli",
    };
  },
};

// ── OpenRouter Provider ────────────────────────────────────────────

export const openrouterProvider: LLMProvider = {
  name: "openrouter",

  async chat(messages: LLMMessage[], model = OPENROUTER_MODEL, signal?: AbortSignal): Promise<LLMResponse> {
    if (!OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY not set");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    if (signal) signal.addEventListener("abort", () => controller.abort());

    const res = await fetch(`${OPENROUTER_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://inkstone.ai",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.3,
        max_tokens: 4096,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") || "30", 10);
      throw new LLMRateLimitError(retryAfter);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = await res.json() as {
      choices: Array<{ message: { content: string } }>;
      model: string;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    return {
      text: data.choices?.[0]?.message?.content || "",
      model: data.model || model,
      provider: "openrouter",
      tokens: data.usage
        ? { prompt: data.usage.prompt_tokens, completion: data.usage.completion_tokens }
        : undefined,
    };
  },
};

// ── Error Types ────────────────────────────────────────────────────

export class LLMRateLimitError extends Error {
  retryAfter: number;
  constructor(retryAfter: number) {
    super(`Rate limited, retry after ${retryAfter}s`);
    this.retryAfter = retryAfter;
  }
}

// ── Client with Retry + Fallback ───────────────────────────────────

export interface LLMClientConfig {
  providers?: LLMProvider[];
  fallbackModels?: string[];
  maxRetries?: number;
  baseDelay?: number;
}

export class LLMClient {
  private providers: LLMProvider[];
  private fallbackModels: string[];
  private maxRetries: number;
  private baseDelay: number;
  currentSignal?: AbortSignal;

  constructor(config: LLMClientConfig = {}) {
    this.providers = config.providers || [ollamaProvider, geminiCliProvider];
    this.fallbackModels = config.fallbackModels || [];
    this.maxRetries = config.maxRetries ?? 2;
    this.baseDelay = config.baseDelay ?? 5;
  }

  async chat(messages: LLMMessage[], preferredModel?: string, signal?: AbortSignal): Promise<LLMResponse> {
    const effectiveSignal = signal ?? this.currentSignal;
    let lastError: Error | null = null;

    for (const provider of this.providers) {
      const models = preferredModel
        ? [preferredModel, ...this.fallbackModels]
        : [undefined, ...this.fallbackModels];

      for (const model of models) {
        for (let attempt = 0; attempt < this.maxRetries; attempt++) {
          try {
            return await provider.chat(messages, model, effectiveSignal);
          } catch (err: unknown) {
            lastError = err instanceof Error ? err : new Error(String(err));
            // Signal aborted → bail immediately, don't retry or sleep
            if (effectiveSignal?.aborted) {
              break;
            }
            if (err instanceof LLMRateLimitError) {
              const delay = err.retryAfter * 1000;
              await sleep(delay);
              continue;
            }
            // Model not found → skip to next provider
            if (lastError.message?.includes("not found")) {
              break;
            }
            // Connection refused → skip to next provider
            if (lastError.message?.includes("ECONNREFUSED") || lastError.message?.includes("fetch failed")) {
              break;
            }
            // Retry with backoff
            if (attempt < this.maxRetries - 1) {
              const delay = this.baseDelay * Math.pow(2, attempt) * 1000;
              await sleep(delay);
            }
          }
        }
      }
    }

    throw lastError || new Error("All LLM providers failed");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Embedding ──────────────────────────────────────────────────────

export interface EmbeddingProvider {
  name: string;
  embed(text: string): Promise<number[]>;
}

export const ollamaEmbed: EmbeddingProvider = {
  name: "ollama",

  async embed(text: string): Promise<number[]> {
    const { OLLAMA_EMBED_MODEL } = await import("../config.js");
    const truncated = text.slice(0, 2048);

    const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, prompt: truncated }),
      signal: AbortSignal.timeout(3_000),
    });

    if (!res.ok) throw new Error(`Ollama embed ${res.status}`);
    const data = await res.json() as { embedding: number[] };
    return data.embedding || [];
  },
};

export const openrouterEmbed: EmbeddingProvider = {
  name: "openrouter",

  async embed(text: string): Promise<number[]> {
    if (!OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY not set");
    const { OPENAI_EMBED_MODEL } = await import("../config.js");
    const truncated = text.slice(0, 2048);

    const res = await fetch(`${OPENROUTER_URL}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({ model: OPENAI_EMBED_MODEL, input: truncated }),
      signal: AbortSignal.timeout(3_000),
    });

    if (!res.ok) throw new Error(`OpenRouter embed ${res.status}`);
    const data = await res.json() as {
      data: Array<{ embedding: number[] }>;
    };
    return data.data?.[0]?.embedding || [];
  },
};

export class EmbeddingClient {
  private providers: EmbeddingProvider[];
  private skipUntil = new Map<string, number>();

  constructor(providers?: EmbeddingProvider[]) {
    this.providers = providers || [ollamaEmbed, openrouterEmbed];
  }

  async embed(text: string): Promise<number[]> {
    const now = Date.now();
    for (const provider of this.providers) {
      const skip = this.skipUntil.get(provider.name);
      if (skip && now < skip) continue;
      try {
        const vec = await provider.embed(text);
        if (vec.length > 0) return vec;
      } catch {
        this.skipUntil.set(provider.name, now + 60_000);
      }
    }
    return [];
  }
}
