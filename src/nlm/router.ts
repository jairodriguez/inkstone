/**
 * Inkstone — NLM Query Router
 */

import type { NlmDomain } from "./types.js";

const DOMAIN_KEYWORDS: Record<NlmDomain, string[]> = {
  business: [
    "revenue", "invoice", "client", "customer", "sales", "shipping",
    "manufacturing", "lead", "prospect", "deal", "pipeline",
    "crm", "contract", "pricing", "bookkeeping",
  ],
  content: [
    "newsletter", "tweet", "twitter", "blog", "content", "seo",
    "hook", "title", "audience", "brand", "article", "viral", "thread",
  ],
  system: [
    "inkstone", "mcp", "agent", "gateway",
    "memory", "notebooklm", "nlm", "cron", "config", "tool", "skill", "database",
  ],
};

export function routeNlmQuery(query: string, explicitDomain?: string): NlmDomain {
  if (explicitDomain === "business" || explicitDomain === "content" || explicitDomain === "system") return explicitDomain;

  const lower = query.toLowerCase();
  let best: NlmDomain = "system";
  let bestScore = 0;

  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS) as [NlmDomain, string[]][]) {
    const score = keywords.reduce((sum, keyword) => sum + (lower.includes(keyword) ? 1 : 0), 0);
    if (score > bestScore) {
      best = domain;
      bestScore = score;
    }
  }

  return best;
}
