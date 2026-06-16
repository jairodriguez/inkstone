/**
 * Inkstone — NLM State
 *
 * Reads the NotebookLM routing state for domain-specific deep queries.
 */

import { existsSync, readFileSync } from "node:fs";
import type { NlmDomain, NlmState } from "./types.js";

export const DEFAULT_NLM_STATE_PATH = process.env.INKSTONE_NLM_STATE || `${process.env.HOME || "/tmp"}/.inkstone/nlm-state.json`;

const FALLBACK_NOTEBOOKS: Record<NlmDomain, { id: string; label: string; name: string }> = {
  business: {
    id: "bba45c24-6b0c-419d-b415-fc143d75ab94",
    label: "Business Ops",
    name: "Clawver Memory — Business Ops 2026-05",
  },
  content: {
    id: "f0a389a0-9ae7-4f85-bc46-eb460afd164e",
    label: "Content & Brand",
    name: "Clawver Memory — Content & Brand 2026-05",
  },
  system: {
    id: "1edb9c3c-4ede-4b80-bf94-784379eefef4",
    label: "System & Agent Ops",
    name: "Clawver Memory — System & Agent Ops 2026-05",
  },
};

export function readNlmState(path = DEFAULT_NLM_STATE_PATH): NlmState | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as NlmState;
}

export function getNlmNotebookForDomain(domain: string, statePath?: string): { domain: NlmDomain; id: string; label: string; name: string } {
  const normalized = normalizeDomain(domain);
  const state = readNlmState(statePath);
  const cfg = state?.domains?.[normalized];
  if (cfg?.active_notebook?.id) {
    return {
      domain: normalized,
      id: cfg.active_notebook.id,
      label: cfg.label,
      name: cfg.active_notebook.name,
    };
  }
  return { domain: normalized, ...FALLBACK_NOTEBOOKS[normalized] };
}

export function listNlmDomainRoutes(statePath?: string): Array<{ domain: string; label: string; active_notebook_id: string; active_notebook_name: string; source: string }> {
  const state = readNlmState(statePath);
  if (!state) {
    return Object.entries(FALLBACK_NOTEBOOKS).map(([domain, nb]) => ({
      domain,
      label: nb.label,
      active_notebook_id: nb.id,
      active_notebook_name: nb.name,
      source: "fallback",
    }));
  }
  return Object.entries(state.domains).map(([domain, cfg]) => ({
    domain,
    label: cfg.label,
    active_notebook_id: cfg.active_notebook.id,
    active_notebook_name: cfg.active_notebook.name,
    source: "state",
  }));
}

export function normalizeDomain(domain?: string): NlmDomain {
  if (domain === "business" || domain === "content" || domain === "system") return domain;
  return "system";
}
