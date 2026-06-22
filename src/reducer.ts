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

/**
 * Apply a command by mutating the given maps in place, returning the lifecycle
 * events. Every case validates fully before performing any mutation, so a
 * thrown command leaves both maps untouched (atomic per command). That
 * atomicity is what lets callers that share working maps across many commands —
 * replay, bulk import — skip a failed command and keep going.
 *
 * This is the single source of truth for command semantics. The immutable
 * `applyCommand` is a thin wrapper that clones first; bulk callers reuse one set
 * of maps to avoid the per-command clone that makes folding O(N^2).
 */
export function applyCommandInPlace(
  items: Map<string, MemoryItem>,
  edges: Map<string, Edge>,
  cmd: MemoryCommand,
): MemoryLifecycleEvent[] {
  switch (cmd.type) {
    case "memory.create": {
      if (items.has(cmd.item.id)) {
        throw new DuplicateMemoryError(cmd.item.id);
      }
      items.set(cmd.item.id, cmd.item);
      return [
        {
          namespace: "memory",
          type: "memory.created",
          item: cmd.item,
          cause_type: cmd.type,
        },
      ];
    }

    case "memory.update": {
      const existing = items.get(cmd.item_id);
      if (!existing) {
        throw new MemoryNotFoundError(cmd.item_id);
      }
      const merged = mergeItem(existing, cmd.partial);
      items.set(cmd.item_id, merged);
      return [
        {
          namespace: "memory",
          type: "memory.updated",
          item: merged,
          cause_type: cmd.type,
        },
      ];
    }

    case "memory.retract": {
      const existing = items.get(cmd.item_id);
      if (!existing) {
        throw new MemoryNotFoundError(cmd.item_id);
      }
      items.delete(cmd.item_id);
      const events: MemoryLifecycleEvent[] = [
        {
          namespace: "memory",
          type: "memory.retracted",
          item: existing,
          cause_type: cmd.type,
        },
      ];
      // Deleting the currently-yielded key during Map iteration is well-defined
      // and visits every other entry exactly once.
      for (const [edgeId, edge] of edges) {
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
      return events;
    }

    case "edge.create": {
      if (edges.has(cmd.edge.edge_id)) {
        throw new DuplicateEdgeError(cmd.edge.edge_id);
      }
      edges.set(cmd.edge.edge_id, cmd.edge);
      return [
        {
          namespace: "memory",
          type: "edge.created",
          edge: cmd.edge,
          cause_type: cmd.type,
        },
      ];
    }

    case "edge.update": {
      const existing = edges.get(cmd.edge_id);
      if (!existing) {
        throw new EdgeNotFoundError(cmd.edge_id);
      }
      const merged = mergeEdge(existing, cmd.partial);
      edges.set(cmd.edge_id, merged);
      return [
        {
          namespace: "memory",
          type: "edge.updated",
          edge: merged,
          cause_type: cmd.type,
        },
      ];
    }

    case "edge.retract": {
      const existing = edges.get(cmd.edge_id);
      if (!existing) {
        throw new EdgeNotFoundError(cmd.edge_id);
      }
      edges.delete(cmd.edge_id);
      return [
        {
          namespace: "memory",
          type: "edge.retracted",
          edge: existing,
          cause_type: cmd.type,
        },
      ];
    }
  }
}

/**
 * Retract many items from the given maps in place, in the order supplied,
 * cascading edge cleanup exactly as a sequence of `memory.retract` commands
 * would. Returns the lifecycle events and the ids actually retracted (ids not
 * present are silently skipped).
 *
 * A naive loop of per-item retracts rescans every edge per item — O(retracted x
 * edges). This builds the endpoint -> incident-edges index once (lazily, only
 * when edges exist) so the cascade is O(items-touched + edges). The index is
 * built from the live edge set on first use; edges removed by earlier retracts
 * in the same batch are skipped via the membership check.
 */
export function retractItemsInPlace(
  items: Map<string, MemoryItem>,
  edges: Map<string, Edge>,
  itemIds: Iterable<string>,
  causeType: string,
): { events: MemoryLifecycleEvent[]; retracted: string[] } {
  const events: MemoryLifecycleEvent[] = [];
  const retracted: string[] = [];
  let edgesByEndpoint: Map<string, string[]> | null = null;

  for (const id of itemIds) {
    const existing = items.get(id);
    if (!existing) continue;
    items.delete(id);
    events.push({
      namespace: "memory",
      type: "memory.retracted",
      item: existing,
      cause_type: causeType,
    });
    retracted.push(id);

    if (edges.size === 0) continue;
    if (edgesByEndpoint === null) {
      edgesByEndpoint = new Map<string, string[]>();
      for (const [edgeId, edge] of edges) {
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
    const incidentIds = edgesByEndpoint.get(id);
    if (!incidentIds) continue;
    for (const edgeId of incidentIds) {
      const edge = edges.get(edgeId);
      if (!edge) continue; // already removed by a prior retract in this batch
      edges.delete(edgeId);
      events.push({
        namespace: "memory",
        type: "edge.retracted",
        edge,
        cause_type: causeType,
      });
    }
  }

  return { events, retracted };
}

export function applyCommand(
  state: GraphState,
  cmd: MemoryCommand,
): { state: GraphState; events: MemoryLifecycleEvent[] } {
  // Clone only the map(s) this command can touch, preserving structural sharing
  // of the untouched map — a memory.* command keeps the same edges Map, and
  // vice versa. memory.retract is the lone command that mutates both.
  let items = state.items;
  let edges = state.edges;
  switch (cmd.type) {
    case "memory.create":
    case "memory.update":
      items = new Map(items);
      break;
    case "memory.retract":
      items = new Map(items);
      edges = new Map(edges);
      break;
    case "edge.create":
    case "edge.update":
    case "edge.retract":
      edges = new Map(edges);
      break;
  }
  const events = applyCommandInPlace(items, edges, cmd);
  return { state: { items, edges }, events };
}
