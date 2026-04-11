import type { GraphState, MemoryItem, Edge } from "./types.js";

export interface SerializedGraphState {
  items: [string, MemoryItem][];
  edges: [string, Edge][];
}

export function toJSON(state: GraphState): SerializedGraphState {
  return {
    items: [...state.items.entries()],
    edges: [...state.edges.entries()],
  };
}

export function fromJSON(data: SerializedGraphState): GraphState {
  return {
    items: new Map(data.items),
    edges: new Map(data.edges),
  };
}

/**
 * Stringify a GraphState to a JSON string.
 */
export function stringify(state: GraphState, pretty = false): string {
  return JSON.stringify(toJSON(state), null, pretty ? 2 : undefined);
}

/**
 * Parse a JSON string back into a GraphState.
 */
export function parse(json: string): GraphState {
  return fromJSON(JSON.parse(json));
}
