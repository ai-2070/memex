import { uuidv7 } from "uuidv7";
import type { MemoryItem, Edge, EventEnvelope } from "./types.js";

function validateScore(value: number | undefined, name: string): void {
  if (value !== undefined && (value < 0 || value > 1)) {
    throw new RangeError(`${name} must be between 0 and 1, got ${value}`);
  }
}

export function createMemoryItem(
  input: Omit<MemoryItem, "id"> & { id?: string },
): MemoryItem {
  validateScore(input.authority, "authority");
  validateScore(input.conviction, "conviction");
  validateScore(input.importance, "importance");

  return {
    ...input,
    id: input.id ?? uuidv7(),
  };
}

export function createEdge(
  input: Omit<Edge, "edge_id" | "active"> & {
    edge_id?: string;
    active?: boolean;
  },
): Edge {
  validateScore(input.authority, "authority");

  return {
    ...input,
    edge_id: input.edge_id ?? uuidv7(),
    active: input.active ?? true,
  };
}

export function createEventEnvelope<T>(
  type: string,
  payload: T,
  opts?: { trace_id?: string },
): EventEnvelope<T> {
  return {
    id: uuidv7(),
    namespace: "memory",
    type,
    ts: new Date().toISOString(),
    payload,
    ...(opts?.trace_id ? { trace_id: opts.trace_id } : {}),
  };
}
