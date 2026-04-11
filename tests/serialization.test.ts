import { describe, it, expect } from "vitest";
import { toJSON, fromJSON, stringify, parse } from "../src/serialization.js";
import { createGraphState } from "../src/graph.js";
import { applyCommand } from "../src/reducer.js";
import type { MemoryItem, Edge } from "../src/types.js";

const makeItem = (id: string): MemoryItem => ({
  id,
  scope: "test",
  kind: "observation",
  content: { key: "value" },
  author: "user:laz",
  source_kind: "observed",
  authority: 0.9,
  conviction: 0.8,
  importance: 0.7,
  meta: { agent_id: "agent:x" },
});

const makeEdge = (id: string): Edge => ({
  edge_id: id,
  from: "m1",
  to: "m2",
  kind: "SUPPORTS",
  author: "system:rule",
  source_kind: "derived_deterministic",
  authority: 0.8,
  active: true,
  weight: 0.5,
});

function buildState() {
  let state = createGraphState();
  state = applyCommand(state, {
    type: "memory.create",
    item: makeItem("m1"),
  }).state;
  state = applyCommand(state, {
    type: "memory.create",
    item: makeItem("m2"),
  }).state;
  state = applyCommand(state, {
    type: "edge.create",
    edge: makeEdge("e1"),
  }).state;
  return state;
}

describe("toJSON / fromJSON", () => {
  it("round-trips a graph state", () => {
    const state = buildState();
    const json = toJSON(state);
    const restored = fromJSON(json);

    expect(restored.items.size).toBe(2);
    expect(restored.edges.size).toBe(1);
    expect(restored.items.get("m1")!.content).toEqual({ key: "value" });
    expect(restored.items.get("m1")!.meta?.agent_id).toBe("agent:x");
    expect(restored.edges.get("e1")!.kind).toBe("SUPPORTS");
  });

  it("serialized format has items and edges as arrays", () => {
    const state = buildState();
    const json = toJSON(state);
    expect(Array.isArray(json.items)).toBe(true);
    expect(Array.isArray(json.edges)).toBe(true);
    expect(json.items).toHaveLength(2);
    expect(json.edges).toHaveLength(1);
    expect(json.items[0][0]).toBe("m1"); // [key, value] tuple
  });

  it("empty state round-trips", () => {
    const state = createGraphState();
    const restored = fromJSON(toJSON(state));
    expect(restored.items.size).toBe(0);
    expect(restored.edges.size).toBe(0);
  });
});

describe("stringify / parse", () => {
  it("round-trips through JSON string", () => {
    const state = buildState();
    const jsonStr = stringify(state);
    const restored = parse(jsonStr);

    expect(restored.items.size).toBe(2);
    expect(restored.edges.size).toBe(1);
    expect(restored.items.get("m2")!.authority).toBe(0.9);
  });

  it("produces valid JSON", () => {
    const state = buildState();
    const jsonStr = stringify(state);
    expect(() => JSON.parse(jsonStr)).not.toThrow();
  });

  it("pretty mode produces formatted output", () => {
    const state = buildState();
    const compact = stringify(state);
    const pretty = stringify(state, true);
    expect(pretty.length).toBeGreaterThan(compact.length);
    expect(pretty).toContain("\n");
  });

  it("preserves all fields through stringify/parse", () => {
    const state = buildState();
    const restored = parse(stringify(state));
    const item = restored.items.get("m1")!;
    expect(item.scope).toBe("test");
    expect(item.kind).toBe("observation");
    expect(item.conviction).toBe(0.8);
    expect(item.importance).toBe(0.7);
    expect(item.meta?.agent_id).toBe("agent:x");
    const edge = restored.edges.get("e1")!;
    expect(edge.weight).toBe(0.5);
    expect(edge.active).toBe(true);
  });
});
