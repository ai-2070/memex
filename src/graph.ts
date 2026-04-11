import type { GraphState } from "./types.js";

export function createGraphState(): GraphState {
  return {
    items: new Map(),
    edges: new Map(),
  };
}

export function cloneGraphState(state: GraphState): GraphState {
  return {
    items: new Map(state.items),
    edges: new Map(state.edges),
  };
}
