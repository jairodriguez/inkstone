/**
 * Inkstone — Graph Traversal (public exports)
 */

export {
  traverseGraph,
  getNeighbors,
  findPath,
  getContradictions,
  getCauses,
  getConsequences,
  getContextGraph,
  getCentralityScores,
  computeGraphBoost,
} from "./traversal.js";

export type {
  TraversalOptions,
  TraversalResult,
  RelationEdge,
  ContextNode,
} from "./traversal.js";
