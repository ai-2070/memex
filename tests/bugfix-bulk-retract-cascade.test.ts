import { describe, it, expect } from "vitest";
import { applyMany } from "../src/bulk.js";
import { applyCommand } from "../src/reducer.js";
import { createGraphState } from "../src/graph.js";
import type { MemoryItem, Edge } from "../src/types.js";

// ============================================================
// applyMany retraction must cascade to edges.
//
// The reducer's memory.retract command deletes all edges referencing the
// retracted item (and emits edge.retracted events). Before this fix, the
// bulk applyMany path retracted the item but left referencing edges
// dangling, producing divergent state depending on which API the caller
// used.
// ============================================================

const makeItem = (
  id: string,
  overrides: Partial<MemoryItem> = {},
): MemoryItem => ({
  id,
  scope: "test",
  kind: "observation",
  content: {},
  author: "agent:a",
  source_kind: "observed",
  authority: 0.5,
  ...overrides,
});

const makeEdge = (
  id: string,
  from: string,
  to: string,
  overrides: Partial<Edge> = {},
): Edge => ({
  edge_id: id,
  from,
  to,
  kind: "SUPPORTS",
  author: "system:rule",
  source_kind: "derived_deterministic",
  authority: 0.8,
  active: true,
  ...overrides,
});

function buildState(items: MemoryItem[], edges: Edge[] = []) {
  let state = createGraphState();
  for (const item of items) {
    state = applyCommand(state, { type: "memory.create", item }).state;
  }
  for (const edge of edges) {
    state = applyCommand(state, { type: "edge.create", edge }).state;
  }
  return state;
}

describe("applyMany cascades edge cleanup on retract", () => {
  it("removes edges where the retracted item is 'from'", () => {
    const state = buildState(
      [makeItem("m1"), makeItem("m2")],
      [makeEdge("e1", "m1", "m2")],
    );
    const { state: next } = applyMany(
      state,
      { ids: ["m1"] },
      () => null,
      "system:cleanup",
    );
    expect(next.items.has("m1")).toBe(false);
    expect(next.edges.has("e1")).toBe(false);
    expect(next.edges.size).toBe(0);
  });

  it("removes edges where the retracted item is 'to'", () => {
    const state = buildState(
      [makeItem("m1"), makeItem("m2")],
      [makeEdge("e1", "m2", "m1")],
    );
    const { state: next } = applyMany(
      state,
      { ids: ["m1"] },
      () => null,
      "system:cleanup",
    );
    expect(next.edges.has("e1")).toBe(false);
  });

  it("emits an edge.retracted event for each cleaned-up edge", () => {
    const state = buildState(
      [makeItem("m1"), makeItem("m2"), makeItem("m3")],
      [makeEdge("e1", "m1", "m2"), makeEdge("e2", "m3", "m1")],
    );
    const { events } = applyMany(
      state,
      { ids: ["m1"] },
      () => null,
      "system:cleanup",
    );
    const types = events.map((e) => e.type);
    expect(types).toContain("memory.retracted");
    expect(types.filter((t) => t === "edge.retracted")).toHaveLength(2);
  });

  it("leaves unrelated edges intact", () => {
    const state = buildState(
      [makeItem("m1"), makeItem("m2"), makeItem("m3")],
      [makeEdge("e1", "m2", "m3")],
    );
    const { state: next } = applyMany(
      state,
      { ids: ["m1"] },
      () => null,
      "system:cleanup",
    );
    expect(next.edges.has("e1")).toBe(true);
  });

  it("handles retracting multiple items connected to each other", () => {
    // m1 <-> m2 edge. Retract both in one batch. The shared edge must be
    // cleaned up exactly once.
    const state = buildState(
      [makeItem("m1"), makeItem("m2")],
      [makeEdge("e1", "m1", "m2")],
    );
    const { state: next, events } = applyMany(
      state,
      {},
      () => null,
      "system:cleanup",
    );
    expect(next.items.size).toBe(0);
    expect(next.edges.size).toBe(0);
    expect(events.filter((e) => e.type === "edge.retracted")).toHaveLength(1);
  });

  it("emits each item's edge.retracted events immediately after its memory.retracted", () => {
    // Locks in the per-item interleaving the reducer's memory.retract
    // produces when called in a loop. Callers concatenating events from
    // multiple applyCommand(...)s get this ordering; applyMany should match.
    const state = buildState(
      [makeItem("m1"), makeItem("m2"), makeItem("m3"), makeItem("m4")],
      [makeEdge("e1", "m1", "m2"), makeEdge("e2", "m3", "m4")],
    );
    const { events } = applyMany(
      state,
      { ids: ["m1", "m3"] },
      () => null,
      "system:cleanup",
    );
    // Expect [mem.retracted(m1), edge.retracted(e1), mem.retracted(m3), edge.retracted(e2)]
    // — NOT [mem.retracted, mem.retracted, edge.retracted, edge.retracted].
    expect(events).toHaveLength(4);
    expect(events[0].type).toBe("memory.retracted");
    expect(events[0].item!.id).toBe("m1");
    expect(events[1].type).toBe("edge.retracted");
    expect(events[1].edge!.edge_id).toBe("e1");
    expect(events[2].type).toBe("memory.retracted");
    expect(events[2].item!.id).toBe("m3");
    expect(events[3].type).toBe("edge.retracted");
    expect(events[3].edge!.edge_id).toBe("e2");
  });

  it("does not clone edges when the batch has no retractions", () => {
    // Guard against a regression where we unconditionally clone edges,
    // defeating the lazy-clone optimization. We test observable behavior:
    // the returned edges map should be the same reference as the input.
    const state = buildState([makeItem("m1")], []);
    const { state: next } = applyMany(
      state,
      { ids: ["m1"] },
      () => ({ authority: 0.9 }),
      "system:update",
    );
    expect(next.edges).toBe(state.edges);
  });
});
