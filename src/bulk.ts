import type {
  GraphState,
  MemoryItem,
  MemoryFilter,
  MemoryLifecycleEvent,
  QueryOptions,
  Edge,
} from "./types.js";
import { getItems } from "./query.js";
import { mergeItem } from "./reducer.js";

export interface ScoreAdjustment {
  authority?: number;
  conviction?: number;
  importance?: number;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export type ItemTransform = (item: MemoryItem) => Partial<MemoryItem> | null;

/**
 * Apply a transform to all matching items in a single pass.
 * Clones the items Map once, not per item.
 */
export function applyMany(
  state: GraphState,
  filter: MemoryFilter,
  transform: ItemTransform,
  author: string,
  reason?: string,
  options?: QueryOptions,
): { state: GraphState; events: MemoryLifecycleEvent[] } {
  const matched = getItems(state, filter, options);

  if (matched.length === 0) {
    return { state, events: [] };
  }

  const items = new Map(state.items);
  // Cloned lazily: only pay for it if we actually retract something and
  // need to cascade edge cleanup.
  let edges: Map<string, Edge> | null = null;
  // Reverse index (endpoint item id -> edge ids touching it), built lazily
  // on first retract so we don't pay O(edges) up front for batches that are
  // all updates, and we don't pay O(edges) per retract for large graphs.
  let edgesByEndpoint: Map<string, string[]> | null = null;
  const allEvents: MemoryLifecycleEvent[] = [];
  let changed = false;

  for (const item of matched) {
    if (!items.has(item.id)) continue;

    const partial = transform(item);

    if (partial === null) {
      items.delete(item.id);
      allEvents.push({
        namespace: "memory",
        type: "memory.retracted",
        item,
        cause_type: "memory.retract",
      });
      changed = true;
      // Mirror the reducer's memory.retract behavior: clean up edges that
      // reference the retracted item so bulk retraction doesn't leave dangling
      // edges behind.
      if (state.edges.size > 0) {
        if (edges === null) edges = new Map(state.edges);
        if (edgesByEndpoint === null) {
          edgesByEndpoint = new Map<string, string[]>();
          for (const [edgeId, edge] of state.edges) {
            let list = edgesByEndpoint.get(edge.from);
            if (!list) edgesByEndpoint.set(edge.from, (list = []));
            list.push(edgeId);
            if (edge.from !== edge.to) {
              list = edgesByEndpoint.get(edge.to);
              if (!list) edgesByEndpoint.set(edge.to, (list = []));
              list.push(edgeId);
            }
          }
        }
        const incidentIds = edgesByEndpoint.get(item.id);
        if (incidentIds) {
          for (const edgeId of incidentIds) {
            const edge = edges.get(edgeId);
            if (!edge) continue; // already cleaned up by a prior retract
            edges.delete(edgeId);
            allEvents.push({
              namespace: "memory",
              type: "edge.retracted",
              edge,
              cause_type: "memory.retract",
            });
          }
        }
      }
    } else if (Object.keys(partial).length > 0) {
      const merged = mergeItem(item, partial);
      items.set(item.id, merged);
      allEvents.push({
        namespace: "memory",
        type: "memory.updated",
        item: merged,
        cause_type: "memory.update",
      });
      changed = true;
    }
  }

  if (!changed) return { state, events: [] };

  return { state: { items, edges: edges ?? state.edges }, events: allEvents };
}

export function bulkAdjustScores(
  state: GraphState,
  criteria: MemoryFilter,
  delta: ScoreAdjustment,
  author: string,
  reason?: string,
): { state: GraphState; events: MemoryLifecycleEvent[] } {
  return applyMany(
    state,
    criteria,
    (item) => {
      const partial: Record<string, unknown> = {};
      if (delta.authority !== undefined) {
        partial.authority = clamp((item.authority ?? 0) + delta.authority);
      }
      if (delta.conviction !== undefined) {
        partial.conviction = clamp((item.conviction ?? 0) + delta.conviction);
      }
      if (delta.importance !== undefined) {
        partial.importance = clamp((item.importance ?? 0) + delta.importance);
      }
      return partial;
    },
    author,
    reason,
  );
}

/**
 * Decay importance on items created before a cutoff time.
 */
export function decayImportance(
  state: GraphState,
  olderThanMs: number,
  factor: number,
  author: string,
  reason?: string,
): { state: GraphState; events: MemoryLifecycleEvent[] } {
  const cutoff = Date.now() - olderThanMs;
  return applyMany(
    state,
    { created: { before: cutoff } },
    (item) => {
      const current = item.importance ?? 0;
      if (current === 0) return {};
      return { importance: clamp(current * factor) };
    },
    author,
    reason ?? "time-based importance decay",
  );
}
