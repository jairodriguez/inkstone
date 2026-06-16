/**
 * Inkstone — Graph Traversal Layer (Agent-Native)
 *
 * Provides graph-native queries for agent reasoning:
 * - BFS/DFS traversal with relation type filtering
 * - Path finding between entities
 * - Neighborhood exploration with scoring
 * - Contradiction/consequence chains
 */

import type { Database as SqlJsDatabase } from "../db/schema.js";

// ── Types ────────────────────────────────────────────────────────────

export interface TraversalOptions {
  /** Starting chunk ID */
  startId: string;
  /** Relation types to follow (default: all) */
  relationTypes?: string[];
  /** Maximum traversal depth */
  maxDepth?: number;
  /** Minimum edge weight to follow */
  minWeight?: number;
  /** Stop conditions */
  stopAt?: string[];
}

export interface TraversalResult {
  chunkId: string;
  path: string[]; // IDs from start to this chunk
  depth: number;
  totalWeight: number;
  relationTypes: string[];
}

export interface RelationEdge {
  fromChunkId: string;
  toChunkId: string;
  relationType: string;
  weight: number;
}

// ── Core Traversal ───────────────────────────────────────────────────

/** BFS traversal of the memory graph */
export function traverseGraph(
  db: SqlJsDatabase,
  opts: TraversalOptions
): TraversalResult[] {
  const { startId, relationTypes, maxDepth = 3, minWeight = 0 } = opts;

  const results: TraversalResult[] = [];
  const visited = new Set<string>();
  const queue: Array<{ id: string; path: string[]; depth: number; weight: number; types: string[] }> = [
    { id: startId, path: [startId], depth: 0, weight: 0, types: [] },
  ];

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (current.depth > maxDepth) continue;
    if (visited.has(current.id)) continue;
    visited.add(current.id);

    // Skip start in results (we want neighbors, not self)
    if (current.id !== startId) {
      results.push({
        chunkId: current.id,
        path: current.path,
        depth: current.depth,
        totalWeight: current.weight,
        relationTypes: current.types,
      });
    }

    // Get outgoing edges from this chunk
    const edges = getEdgesFrom(db, current.id, relationTypes, minWeight);

    for (const edge of edges) {
      const targetId = edge.toChunkId;
      if (visited.has(targetId) || current.path.includes(targetId)) continue;

      queue.push({
        id: targetId,
        path: [...current.path, targetId],
        depth: current.depth + 1,
        weight: current.weight + edge.weight,
        types: [...current.types, edge.relationType],
      });
    }
  }

  // Sort by: depth asc, totalWeight desc
  results.sort((a, b) => (a.depth - b.depth) || (b.totalWeight - a.totalWeight));
  return results;
}

/** Get immediate neighbors of a chunk */
export function getNeighbors(
  db: SqlJsDatabase,
  chunkId: string,
  opts: {
    relationTypes?: string[];
    minWeight?: number;
    limit?: number;
  } = {}
): RelationEdge[] {
  const { relationTypes, minWeight = 0, limit = 50 } = opts;

  let sql = `
    SELECT from_chunk_id, to_chunk_id, relation_type, weight
    FROM memory_relations
    WHERE (from_chunk_id = ? OR to_chunk_id = ?)
      AND weight >= ?
  `;
  const params: unknown[] = [chunkId, chunkId, minWeight];

  if (relationTypes && relationTypes.length > 0) {
    sql += ` AND relation_type IN (${relationTypes.map(() => "?").join(",")})`;
    params.push(...relationTypes);
  }

  sql += ` ORDER BY weight DESC LIMIT ${limit}`;

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];

  const edges: RelationEdge[] = [];
  for (const row of rows) {
    edges.push({
      fromChunkId: String(row.from_chunk_id),
      toChunkId: String(row.to_chunk_id),
      relationType: String(row.relation_type),
      weight: Number(row.weight),
    });
  }

  return edges;
}

/** Find shortest path between two chunks (if any) */
export function findPath(
  db: SqlJsDatabase,
  fromId: string,
  toId: string,
  opts: {
    relationTypes?: string[];
    maxDepth?: number;
  } = {}
): string[] | null {
  const { relationTypes, maxDepth = 5 } = opts;

  const visited = new Set<string>();
  const queue: Array<{ id: string; path: string[] }> = [
    { id: fromId, path: [fromId] },
  ];

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (current.id === toId) {
      return current.path;
    }

    if (current.path.length > maxDepth) continue;
    if (visited.has(current.id)) continue;
    visited.add(current.id);

    const edges = getEdgesFrom(db, current.id, relationTypes, 0);
    for (const edge of edges) {
      if (!visited.has(edge.toChunkId) && !current.path.includes(edge.toChunkId)) {
        queue.push({
          id: edge.toChunkId,
          path: [...current.path, edge.toChunkId],
        });
      }
    }
  }

  return null;
}

/** Get centrality scores for all chunks (number of connections) */
export function getCentralityScores(db: SqlJsDatabase): Map<string, number> {
  const scores = new Map<string, number>();

  const rows = db.prepare(`
    SELECT from_chunk_id, to_chunk_id
    FROM memory_relations
  `).all() as Record<string, unknown>[];

  for (const row of rows) {
    const fromId = String(row.from_chunk_id);
    const toId = String(row.to_chunk_id);

    scores.set(fromId, (scores.get(fromId) || 0) + 1);
    scores.set(toId, (scores.get(toId) || 0) + 1);
  }

  return scores;
}

// ── Agent-Native Queries ─────────────────────────────────────────────

/** "What contradicts this chunk?" — traverse contradicts edges */
export function getContradictions(db: SqlJsDatabase, chunkId: string, limit = 10): RelationEdge[] {
  return getNeighbors(db, chunkId, {
    relationTypes: ["contradicts", "supersedes"],
    limit,
  });
}

/** "What caused this?" — traverse causes edges backwards */
export function getCauses(db: SqlJsDatabase, chunkId: string, limit = 10): RelationEdge[] {
  const rows = db.prepare(`
    SELECT from_chunk_id, to_chunk_id, relation_type, weight
    FROM memory_relations
    WHERE to_chunk_id = ? AND relation_type IN ('causes', 'caused_by')
    ORDER BY weight DESC LIMIT ?
  `).all(chunkId, limit) as Record<string, unknown>[];

  const edges: RelationEdge[] = [];
  for (const row of rows) {
    edges.push({
      fromChunkId: String(row.from_chunk_id),
      toChunkId: String(row.to_chunk_id),
      relationType: String(row.relation_type),
      weight: Number(row.weight),
    });
  }

  return edges;
}

/** "What follows from this?" — traverse causes edges forward */
export function getConsequences(db: SqlJsDatabase, chunkId: string, limit = 10): RelationEdge[] {
  const rows = db.prepare(`
    SELECT from_chunk_id, to_chunk_id, relation_type, weight
    FROM memory_relations
    WHERE from_chunk_id = ? AND relation_type IN ('causes', 'caused_by')
    ORDER BY weight DESC LIMIT ?
  `).all(chunkId, limit) as Record<string, unknown>[];

  const edges: RelationEdge[] = [];
  for (const row of rows) {
    edges.push({
      fromChunkId: String(row.from_chunk_id),
      toChunkId: String(row.to_chunk_id),
      relationType: String(row.relation_type),
      weight: Number(row.weight),
    });
  }

  return edges;
}

/** "What's the context around this chunk?" — full neighborhood with texts */
export function getContextGraph(
  db: SqlJsDatabase,
  chunkId: string,
  opts: {
    maxDepth?: number;
    relationTypes?: string[];
    limit?: number;
  } = {}
): ContextNode[] {
  const { maxDepth = 2, relationTypes, limit = 50 } = opts;

  const results: ContextNode[] = [];
  const visited = new Set<string>();
  const queue: Array<{ id: string; depth: number; path: string[] }> = [
    { id: chunkId, depth: 0, path: [] },
  ];

  while (queue.length > 0 && results.length < limit) {
    const current = queue.shift()!;
    if (visited.has(current.id)) continue;
    visited.add(current.id);

    // Fetch chunk text
    const row = db.prepare("SELECT text, knowledge_type, namespace, lifecycle FROM chunks WHERE id = ?").get(current.id) as Record<string, unknown> | undefined;
    let chunkText = "", chunkType = "", chunkNs = "", chunkLifecycle = "";
    if (row) {
      chunkText = String(row.text) || "";
      chunkType = String(row.knowledge_type) || "";
      chunkNs = String(row.namespace) || "";
      chunkLifecycle = String(row.lifecycle) || "";
    }

    if (current.id !== chunkId) {
      results.push({
        chunkId: current.id,
        text: chunkText.slice(0, 500),
        knowledgeType: chunkType,
        namespace: chunkNs,
        lifecycle: chunkLifecycle,
        depth: current.depth,
        relationPath: [...current.path],
      });
    }

    if (current.depth < maxDepth) {
      const edges = getEdgesFrom(db, current.id, relationTypes, 0);
      for (const edge of edges) {
        if (!visited.has(edge.toChunkId)) {
          queue.push({
            id: edge.toChunkId,
            depth: current.depth + 1,
            path: [...current.path, edge.relationType],
          });
        }
      }
    }
  }

  return results;
}

export interface ContextNode {
  chunkId: string;
  text: string;
  knowledgeType: string;
  namespace: string;
  lifecycle: string;
  depth: number;
  relationPath: string[];
}

// ── Helpers ───────────────────────────────────────────────────────────

function getEdgesFrom(
  db: SqlJsDatabase,
  fromId: string,
  relationTypes?: string[],
  minWeight: number = 0
): RelationEdge[] {
  let sql = `
    SELECT from_chunk_id, to_chunk_id, relation_type, weight
    FROM memory_relations
    WHERE from_chunk_id = ? AND weight >= ?
  `;
  const params: unknown[] = [fromId, minWeight];

  if (relationTypes && relationTypes.length > 0) {
    sql += ` AND relation_type IN (${relationTypes.map(() => "?").join(",")})`;
    params.push(...relationTypes);
  }

  sql += ` ORDER BY weight DESC`;

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];

  const edges: RelationEdge[] = [];
  for (const row of rows) {
    edges.push({
      fromChunkId: String(row.from_chunk_id),
      toChunkId: String(row.to_chunk_id),
      relationType: String(row.relation_type),
      weight: Number(row.weight),
    });
  }

  return edges;
}

// ── Graph-Aware Search Boost ───────────────────────────────────────────

/** Enhanced search that boosts by graph connections to recent/active chunks */
export function computeGraphBoost(
  db: SqlJsDatabase,
  candidateIds: Set<string>,
  activeIds: Set<string>
): Map<string, number> {
  const boosts = new Map<string, number>();

  for (const candidateId of candidateIds) {
    let boost = 0;
    const edges = getEdgesFrom(db, candidateId, undefined, 0);
    for (const edge of edges) {
      if (activeIds.has(edge.toChunkId)) {
        boost += edge.weight * 0.1;
      }
    }
    if (boost > 0) {
      boosts.set(candidateId, Math.min(0.3, boost));
    }
  }

  return boosts;
}
