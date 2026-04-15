import type {
  GraphState,
  MemoryItem,
  MemoryFilter,
  ScoreWeights,
  ScoredItem,
} from "./types.js";
import { getEdges, getScoredItems } from "./query.js";

// ---------------------------------------------------------------------------
// 1. Support tree — provenance walk
// ---------------------------------------------------------------------------

export interface SupportNode {
  item: MemoryItem;
  parents: SupportNode[];
}

/**
 * Build the full provenance tree for an item.
 * Recursively walks `parents`, deduplicating on cycles.
 */
export function getSupportTree(
  state: GraphState,
  itemId: string,
): SupportNode | null {
  const item = state.items.get(itemId);
  if (!item) return null;

  const visited = new Set<string>();

  function walk(id: string): SupportNode | null {
    const current = state.items.get(id);
    if (!current) return null;
    if (visited.has(id)) return { item: current, parents: [] };
    visited.add(id);

    const parentNodes: SupportNode[] = [];
    if (current.parents) {
      for (const pid of current.parents) {
        const node = walk(pid);
        if (node) parentNodes.push(node);
      }
    }
    return { item: current, parents: parentNodes };
  }

  return walk(itemId);
}

/**
 * Flatten a support tree into the minimal set of items that justify a claim.
 * Returns all unique items in the provenance chain (including the root).
 */
export function getSupportSet(state: GraphState, itemId: string): MemoryItem[] {
  const item = state.items.get(itemId);
  if (!item) return [];

  const visited = new Set<string>();
  const result: MemoryItem[] = [];

  function walk(id: string): void {
    if (visited.has(id)) return;
    visited.add(id);
    const current = state.items.get(id);
    if (!current) return;
    result.push(current);
    if (current.parents) {
      for (const pid of current.parents) {
        walk(pid);
      }
    }
  }

  walk(itemId);
  return result;
}

// ---------------------------------------------------------------------------
// 2. Contradiction-aware packing
// ---------------------------------------------------------------------------

/**
 * Get the set of item ids that have been superseded (losers of resolved contradictions).
 */
function getSupersededIds(state: GraphState): Set<string> {
  const superseded = new Set<string>();
  for (const edge of state.edges.values()) {
    if (edge.kind === "SUPERSEDES" && edge.active) {
      superseded.add(edge.to);
    }
  }
  return superseded;
}

/**
 * Given a set of scored items, remove items that are the losing side of
 * a resolved contradiction (SUPERSEDES), and for unresolved contradictions
 * (CONTRADICTS), keep only the higher-scoring item.
 */
export function filterContradictions(
  state: GraphState,
  scored: ScoredItem[],
): ScoredItem[] {
  const superseded = getSupersededIds(state);

  // remove superseded items
  let filtered = scored.filter((s) => !superseded.has(s.item.id));

  // for unresolved contradictions, keep the higher-scoring side
  const contradictEdges = getEdges(state, {
    kind: "CONTRADICTS",
    active_only: true,
  });
  if (contradictEdges.length > 0) {
    const scoreMap = new Map<string, number>();
    for (const entry of filtered) {
      scoreMap.set(entry.item.id, entry.score);
    }

    // Sort contradiction edges deterministically: highest max-score pair first,
    // then by min-score descending, then by edge_id for absolute stability.
    contradictEdges.sort((a, b) => {
      const maxA = Math.max(scoreMap.get(a.from) ?? -1, scoreMap.get(a.to) ?? -1);
      const maxB = Math.max(scoreMap.get(b.from) ?? -1, scoreMap.get(b.to) ?? -1);
      if (maxA !== maxB) return maxB - maxA;
      const minA = Math.min(scoreMap.get(a.from) ?? -1, scoreMap.get(a.to) ?? -1);
      const minB = Math.min(scoreMap.get(b.from) ?? -1, scoreMap.get(b.to) ?? -1);
      if (minA !== minB) return minB - minA;
      return a.edge_id < b.edge_id ? -1 : 1;
    });

    const excluded = new Set<string>();
    for (const edge of contradictEdges) {
      if (excluded.has(edge.from) || excluded.has(edge.to)) continue;

      const scoreA = scoreMap.get(edge.from) ?? -1;
      const scoreB = scoreMap.get(edge.to) ?? -1;

      if (scoreA >= 0 && scoreB >= 0) {
        if (scoreA !== scoreB) {
          excluded.add(scoreA > scoreB ? edge.to : edge.from);
        } else {
          // deterministic tiebreak: exclude the lexicographically larger id
          excluded.add(
            edge.from < edge.to ? edge.to : edge.from,
          );
        }
      }
    }

    if (excluded.size > 0) {
      filtered = filtered.filter((s) => !excluded.has(s.item.id));
    }
  }

  return filtered;
}

/**
 * Surface contradictions: keep both sides, annotate each with what contradicts it.
 * Superseded items are still removed. Unresolved contradictions are preserved
 * and flagged via `contradicted_by`.
 */
export function surfaceContradictions(
  state: GraphState,
  scored: ScoredItem[],
): ScoredItem[] {
  const superseded = getSupersededIds(state);
  // clone each entry to avoid mutating the input array
  let result = scored
    .filter((s) => !superseded.has(s.item.id))
    .map((s) => ({ ...s }));

  const contradictEdges = getEdges(state, {
    kind: "CONTRADICTS",
    active_only: true,
  });
  if (contradictEdges.length === 0) return result;

  const itemMap = new Map<string, ScoredItem>();
  for (const entry of result) {
    itemMap.set(entry.item.id, entry);
  }

  for (const edge of contradictEdges) {
    const a = itemMap.get(edge.from);
    const b = itemMap.get(edge.to);
    if (a && b) {
      a.contradicted_by = a.contradicted_by ?? [];
      a.contradicted_by.push(b.item);
      b.contradicted_by = b.contradicted_by ?? [];
      b.contradicted_by.push(a.item);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// 3. Diversity scoring
// ---------------------------------------------------------------------------

export interface DiversityOptions {
  /** Penalty per duplicate author (0..1). Default 0. */
  author_penalty?: number;
  /** Penalty per shared parent (0..1). Default 0. */
  parent_penalty?: number;
  /** Penalty per duplicate source_kind (0..1). Default 0. */
  source_penalty?: number;
}

/**
 * Re-rank scored items with diversity penalties.
 * Items are processed in score order. Each subsequent item from the same
 * author / parent / source_kind gets its score reduced by the penalty amount.
 */
export function applyDiversity(
  scored: ScoredItem[],
  options: DiversityOptions,
): ScoredItem[] {
  const authorCounts = options.author_penalty
    ? new Map<string, number>()
    : null;
  const parentCounts = options.parent_penalty
    ? new Map<string, number>()
    : null;
  const sourceCounts = options.source_penalty
    ? new Map<string, number>()
    : null;

  const diversified = scored.map((entry) => {
    let penalty = 0;

    if (authorCounts) {
      const count = authorCounts.get(entry.item.author) ?? 0;
      penalty += count * options.author_penalty!;
      authorCounts.set(entry.item.author, count + 1);
    }

    if (parentCounts && entry.item.parents) {
      for (const pid of entry.item.parents) {
        const count = parentCounts.get(pid) ?? 0;
        penalty += count * options.parent_penalty!;
        parentCounts.set(pid, count + 1);
      }
    }

    if (sourceCounts) {
      const count = sourceCounts.get(entry.item.source_kind) ?? 0;
      penalty += count * options.source_penalty!;
      sourceCounts.set(entry.item.source_kind, count + 1);
    }

    return {
      ...entry,
      score: Math.max(0, entry.score - penalty),
    };
  });

  diversified.sort((a, b) => b.score - a.score);
  return diversified;
}

// ---------------------------------------------------------------------------
// 4. Combined smart retrieval
// ---------------------------------------------------------------------------

export interface SmartRetrievalOptions {
  budget: number;
  costFn: (item: MemoryItem) => number;
  weights: ScoreWeights;
  filter?: MemoryFilter;
  contradictions?: "filter" | "surface"; // "filter" = collapse, "surface" = keep both + flag
  diversity?: DiversityOptions;
}

/**
 * Smart retrieval: score → contradiction filter → diversity → budget pack.
 *
 * Pipeline:
 * 1. Score all items matching filter
 * 2. Optionally remove contradicted/superseded items
 * 3. Optionally apply diversity penalties and re-rank
 * 4. Greedily pack within budget
 */
export function smartRetrieve(
  state: GraphState,
  options: SmartRetrievalOptions,
): ScoredItem[] {
  let scored = getScoredItems(state, options.weights, {
    pre: options.filter,
  });

  if (options.contradictions === "filter") {
    scored = filterContradictions(state, scored);
  } else if (options.contradictions === "surface") {
    scored = surfaceContradictions(state, scored);
  }

  if (options.diversity) {
    scored = applyDiversity(scored, options.diversity);
  }

  const results: ScoredItem[] = [];
  let remaining = options.budget;

  for (const entry of scored) {
    const cost = options.costFn(entry.item);
    if (!(cost > 0)) {
      throw new RangeError(`costFn must return a positive number, got ${cost}`);
    }
    if (cost <= remaining) {
      results.push(entry);
      remaining -= cost;
    }
    if (remaining <= 0) break;
  }

  return results;
}
