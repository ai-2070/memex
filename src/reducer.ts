import type {
  GraphState,
  MemoryCommand,
  MemoryLifecycleEvent,
  MemoryItem,
  Edge,
} from "./types.js";
import {
  MemoryNotFoundError,
  EdgeNotFoundError,
  DuplicateMemoryError,
  DuplicateEdgeError,
} from "./errors.js";

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) result[key] = value;
  }
  return result as Partial<T>;
}

function mergeAndPrune<T extends Record<string, unknown>>(
  base: T,
  patch: Record<string, unknown>,
): T {
  const merged = { ...base, ...patch };
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) delete merged[key];
  }
  return merged as T;
}

export function mergeItem(
  existing: MemoryItem,
  partial: Partial<MemoryItem>,
): MemoryItem {
  const {
    content: partialContent,
    meta: partialMeta,
    id: _id,
    created_at: _createdAt,
    ...rest
  } = partial;
  return {
    ...existing,
    ...stripUndefined(rest),
    content:
      partialContent !== undefined
        ? mergeAndPrune(
            existing.content,
            stripUndefined(partialContent) as Record<string, unknown>,
          )
        : existing.content,
    meta:
      partialMeta !== undefined
        ? mergeAndPrune(
            existing.meta ?? {},
            stripUndefined(partialMeta) as Record<string, unknown>,
          )
        : existing.meta,
  };
}

function mergeEdge(existing: Edge, partial: Partial<Edge>): Edge {
  const { edge_id: _eid, from: _from, to: _to, ...rest } = partial;
  return { ...existing, ...stripUndefined(rest) };
}

export function applyCommand(
  state: GraphState,
  cmd: MemoryCommand,
): { state: GraphState; events: MemoryLifecycleEvent[] } {
  switch (cmd.type) {
    case "memory.create": {
      if (state.items.has(cmd.item.id)) {
        throw new DuplicateMemoryError(cmd.item.id);
      }
      const items = new Map(state.items);
      items.set(cmd.item.id, cmd.item);
      return {
        state: { items, edges: state.edges },
        events: [
          {
            namespace: "memory",
            type: "memory.created",
            item: cmd.item,
            cause_type: cmd.type,
          },
        ],
      };
    }

    case "memory.update": {
      const existing = state.items.get(cmd.item_id);
      if (!existing) {
        throw new MemoryNotFoundError(cmd.item_id);
      }
      const merged = mergeItem(existing, cmd.partial);
      const items = new Map(state.items);
      items.set(cmd.item_id, merged);
      return {
        state: { items, edges: state.edges },
        events: [
          {
            namespace: "memory",
            type: "memory.updated",
            item: merged,
            cause_type: cmd.type,
          },
        ],
      };
    }

    case "memory.retract": {
      const existing = state.items.get(cmd.item_id);
      if (!existing) {
        throw new MemoryNotFoundError(cmd.item_id);
      }
      const items = new Map(state.items);
      items.delete(cmd.item_id);
      const edges = new Map(state.edges);
      const events: MemoryLifecycleEvent[] = [
        {
          namespace: "memory",
          type: "memory.retracted",
          item: existing,
          cause_type: cmd.type,
        },
      ];
      for (const [edgeId, edge] of state.edges) {
        if (edge.from === cmd.item_id || edge.to === cmd.item_id) {
          edges.delete(edgeId);
          events.push({
            namespace: "memory",
            type: "edge.retracted",
            edge,
            cause_type: cmd.type,
          });
        }
      }
      return { state: { items, edges }, events };
    }

    case "edge.create": {
      if (state.edges.has(cmd.edge.edge_id)) {
        throw new DuplicateEdgeError(cmd.edge.edge_id);
      }
      const edges = new Map(state.edges);
      edges.set(cmd.edge.edge_id, cmd.edge);
      return {
        state: { items: state.items, edges },
        events: [
          {
            namespace: "memory",
            type: "edge.created",
            edge: cmd.edge,
            cause_type: cmd.type,
          },
        ],
      };
    }

    case "edge.update": {
      const existing = state.edges.get(cmd.edge_id);
      if (!existing) {
        throw new EdgeNotFoundError(cmd.edge_id);
      }
      const merged = mergeEdge(existing, cmd.partial);
      const edges = new Map(state.edges);
      edges.set(cmd.edge_id, merged);
      return {
        state: { items: state.items, edges },
        events: [
          {
            namespace: "memory",
            type: "edge.updated",
            edge: merged,
            cause_type: cmd.type,
          },
        ],
      };
    }

    case "edge.retract": {
      const existing = state.edges.get(cmd.edge_id);
      if (!existing) {
        throw new EdgeNotFoundError(cmd.edge_id);
      }
      const edges = new Map(state.edges);
      edges.delete(cmd.edge_id);
      return {
        state: { items: state.items, edges },
        events: [
          {
            namespace: "memory",
            type: "edge.retracted",
            edge: existing,
            cause_type: cmd.type,
          },
        ],
      };
    }
  }
}
