import { uuidv7 } from "uuidv7";
import type { MemoryItem, Edge, EventEnvelope } from "./types.js";

function validateScore(value: number | undefined, name: string): void {
  if (value !== undefined && (value < 0 || value > 1)) {
    throw new RangeError(`${name} must be between 0 and 1, got ${value}`);
  }
}

/**
 * Extract a millisecond timestamp from a UUIDv7 id, if valid.
 * Returns null for non-UUIDv7 ids.
 */
function safeExtractTimestamp(id: string): number | null {
  const stripped = id.replace(/-/g, "");
  if (stripped.length < 16 || stripped[12] !== "7") return null;
  const ts = parseInt(stripped.slice(0, 12), 16);
  if (isNaN(ts) || ts <= 0) return null;
  return ts;
}

export function createMemoryItem(
  input: Omit<MemoryItem, "id"> & { id?: string; created_at?: number },
): MemoryItem {
  validateScore(input.authority, "authority");
  validateScore(input.conviction, "conviction");
  validateScore(input.importance, "importance");

  const id = input.id ?? uuidv7();
  return {
    ...input,
    id,
    created_at: input.created_at ?? safeExtractTimestamp(id) ?? Date.now(),
  };
}

export function createEdge(
  input: Omit<Edge, "edge_id" | "active"> & {
    edge_id?: string;
    active?: boolean;
  },
): Edge {
  if (input.from === input.to) {
    throw new Error(
      `Self-referencing edge not allowed: from and to are both "${input.from}"`,
    );
  }
  validateScore(input.authority, "authority");
  validateScore(input.weight, "weight");

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
