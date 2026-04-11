import type {
  GraphState,
  MemoryItem,
  Edge,
  MemoryLifecycleEvent,
  ScoreWeights,
  ScoredItem,
} from "./types.js";
import { applyCommand } from "./reducer.js";
import { getEdges, getChildren, getScoredItems } from "./query.js";
import { uuidv7 } from "uuidv7";

// ---------------------------------------------------------------------------
// 1. Temporal forking — conflict detection & resolution
// ---------------------------------------------------------------------------

export interface Contradiction {
  a: MemoryItem;
  b: MemoryItem;
  edge?: Edge;
}

/**
 * Find all active CONTRADICTS edges and return the item pairs.
 */
export function getContradictions(state: GraphState): Contradiction[] {
  const contradictEdges = getEdges(state, {
    kind: "CONTRADICTS",
    active_only: true,
  });
  const results: Contradiction[] = [];
  for (const edge of contradictEdges) {
    const a = state.items.get(edge.from);
    const b = state.items.get(edge.to);
    if (a && b) results.push({ a, b, edge });
  }
  return results;
}

/**
 * Mark two items as contradicting each other.
 * Creates a CONTRADICTS edge between them.
 */
export function markContradiction(
  state: GraphState,
  itemIdA: string,
  itemIdB: string,
  author: string,
  meta?: Record<string, unknown>,
): { state: GraphState; events: MemoryLifecycleEvent[] } {
  return applyCommand(state, {
    type: "edge.create",
    edge: {
      edge_id: uuidv7(),
      from: itemIdA,
      to: itemIdB,
      kind: "CONTRADICTS",
      author,
      source_kind: "derived_deterministic",
      authority: 1,
      active: true,
      meta,
    },
  });
}

/**
 * Resolve a contradiction by marking the winner as superseding the loser.
 * - Creates a SUPERSEDES edge (winner -> loser)
 * - Lowers the loser's authority
 * - Retracts the CONTRADICTS edge
 */
export function resolveContradiction(
  state: GraphState,
  winnerId: string,
  loserId: string,
  author: string,
  reason?: string,
): { state: GraphState; events: MemoryLifecycleEvent[] } {
  let current = state;
  const allEvents: MemoryLifecycleEvent[] = [];

  // find and retract the CONTRADICTS edge between them
  for (const edge of current.edges.values()) {
    if (
      edge.kind === "CONTRADICTS" &&
      edge.active &&
      ((edge.from === winnerId && edge.to === loserId) ||
        (edge.from === loserId && edge.to === winnerId))
    ) {
      const r = applyCommand(current, {
        type: "edge.retract",
        edge_id: edge.edge_id,
        author,
        reason,
      });
      current = r.state;
      allEvents.push(...r.events);
    }
  }

  // create SUPERSEDES edge
  const r1 = applyCommand(current, {
    type: "edge.create",
    edge: {
      edge_id: uuidv7(),
      from: winnerId,
      to: loserId,
      kind: "SUPERSEDES",
      author,
      source_kind: "derived_deterministic",
      authority: 1,
      active: true,
      meta: reason ? { reason } : undefined,
    },
  });
  current = r1.state;
  allEvents.push(...r1.events);

  // lower loser's authority
  const loser = current.items.get(loserId);
  if (loser) {
    const r2 = applyCommand(current, {
      type: "memory.update",
      item_id: loserId,
      partial: { authority: loser.authority * 0.1 },
      author,
      reason,
    });
    current = r2.state;
    allEvents.push(...r2.events);
  }

  return { state: current, events: allEvents };
}

// ---------------------------------------------------------------------------
// 2. Observational continuity — stale detection & cascade
// ---------------------------------------------------------------------------

export interface StaleItem {
  item: MemoryItem;
  missing_parents: string[];
}

/**
 * Find items whose parents have been retracted (missing from state).
 */
export function getStaleItems(state: GraphState): StaleItem[] {
  const results: StaleItem[] = [];
  for (const item of state.items.values()) {
    if (!item.parents || item.parents.length === 0) continue;
    const missing = item.parents.filter((pid) => !state.items.has(pid));
    if (missing.length > 0) {
      results.push({ item, missing_parents: missing });
    }
  }
  return results;
}

/**
 * Find items that depend on a specific item (directly or transitively).
 */
export function getDependents(
  state: GraphState,
  itemId: string,
  transitive = false,
): MemoryItem[] {
  const direct = getChildren(state, itemId);
  if (!transitive) return direct;

  const visited = new Set<string>();
  const result: MemoryItem[] = [];
  const queue = [...direct];

  while (queue.length > 0) {
    const item = queue.pop()!;
    if (visited.has(item.id)) continue;
    visited.add(item.id);
    result.push(item);
    queue.push(...getChildren(state, item.id));
  }

  return result;
}

/**
 * Cascade retraction: retract an item and all its transitive dependents.
 */
export function cascadeRetract(
  state: GraphState,
  itemId: string,
  author: string,
  reason?: string,
): { state: GraphState; events: MemoryLifecycleEvent[]; retracted: string[] } {
  const dependents = getDependents(state, itemId, true);
  let current = state;
  const allEvents: MemoryLifecycleEvent[] = [];
  const retracted: string[] = [];

  // retract dependents first (leaves before roots)
  for (const dep of dependents.reverse()) {
    if (!current.items.has(dep.id)) continue;
    const r = applyCommand(current, {
      type: "memory.retract",
      item_id: dep.id,
      author,
      reason: reason ?? `parent ${itemId} retracted`,
    });
    current = r.state;
    allEvents.push(...r.events);
    retracted.push(dep.id);
  }

  // retract the item itself
  if (current.items.has(itemId)) {
    const r = applyCommand(current, {
      type: "memory.retract",
      item_id: itemId,
      author,
      reason,
    });
    current = r.state;
    allEvents.push(...r.events);
    retracted.push(itemId);
  }

  return { state: current, events: allEvents, retracted };
}

// ---------------------------------------------------------------------------
// 3. Recognition vs discovery — identity / aliasing
// ---------------------------------------------------------------------------

/**
 * Mark two items as referring to the same entity.
 * Creates bidirectional ALIAS edges.
 */
export function markAlias(
  state: GraphState,
  itemIdA: string,
  itemIdB: string,
  author: string,
  meta?: Record<string, unknown>,
): { state: GraphState; events: MemoryLifecycleEvent[] } {
  let current = state;
  const allEvents: MemoryLifecycleEvent[] = [];

  const r1 = applyCommand(current, {
    type: "edge.create",
    edge: {
      edge_id: uuidv7(),
      from: itemIdA,
      to: itemIdB,
      kind: "ALIAS",
      author,
      source_kind: "derived_deterministic",
      authority: 1,
      active: true,
      meta,
    },
  });
  current = r1.state;
  allEvents.push(...r1.events);

  const r2 = applyCommand(current, {
    type: "edge.create",
    edge: {
      edge_id: uuidv7(),
      from: itemIdB,
      to: itemIdA,
      kind: "ALIAS",
      author,
      source_kind: "derived_deterministic",
      authority: 1,
      active: true,
      meta,
    },
  });
  current = r2.state;
  allEvents.push(...r2.events);

  return { state: current, events: allEvents };
}

/**
 * Get all items that are aliased to a given item (directly).
 */
export function getAliases(state: GraphState, itemId: string): MemoryItem[] {
  const aliasEdges = getEdges(state, {
    from: itemId,
    kind: "ALIAS",
    active_only: true,
  });
  const results: MemoryItem[] = [];
  for (const edge of aliasEdges) {
    const item = state.items.get(edge.to);
    if (item) results.push(item);
  }
  return results;
}

/**
 * Get the full alias group for an item (transitive closure).
 */
export function getAliasGroup(state: GraphState, itemId: string): MemoryItem[] {
  const visited = new Set<string>();
  const result: MemoryItem[] = [];
  const queue = [itemId];

  while (queue.length > 0) {
    const id = queue.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const item = state.items.get(id);
    if (item) result.push(item);
    const aliases = getEdges(state, {
      from: id,
      kind: "ALIAS",
      active_only: true,
    });
    for (const edge of aliases) {
      queue.push(edge.to);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// 4. Budget-aware probabilistic retrieval
// ---------------------------------------------------------------------------

export interface BudgetOptions {
  budget: number; // total budget (e.g. token count, cost units)
  costFn: (item: MemoryItem) => number; // cost per item
  weights: ScoreWeights; // scoring weights
  filter?: import("./types.js").MemoryFilter;
}

/**
 * Retrieve the highest-scoring items that fit within a budget.
 * Items are ranked by weighted score, then greedily packed.
 */
export function getItemsByBudget(
  state: GraphState,
  options: BudgetOptions,
): ScoredItem[] {
  const scored = getScoredItems(state, options.weights, {
    pre: options.filter,
  });

  const results: ScoredItem[] = [];
  let remaining = options.budget;

  for (const entry of scored) {
    const cost = options.costFn(entry.item);
    if (cost <= remaining) {
      results.push(entry);
      remaining -= cost;
    }
    if (remaining <= 0) break;
  }

  return results;
}
