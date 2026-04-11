import { describe, it, expect } from "vitest";
import { applyMany, bulkAdjustScores } from "../src/bulk.js";
import type { MemoryItem, GraphState } from "../src/types.js";

function buildState(items: MemoryItem[]): GraphState {
  const state: GraphState = { items: new Map(), edges: new Map() };
  for (const i of items) state.items.set(i.id, i);
  return state;
}

const baseItem = (
  id: string,
  overrides: Partial<MemoryItem> = {},
): MemoryItem => ({
  id,
  scope: "test",
  kind: "observation",
  content: {},
  author: "user:laz",
  source_kind: "observed",
  authority: 0.5,
  ...overrides,
});

// -- applyMany --

describe("applyMany", () => {
  it("updates matching items with a transform", () => {
    const state = buildState([
      baseItem("m1", { authority: 0.5 }),
      baseItem("m2", { authority: 0.6 }),
    ]);
    const { state: next, events } = applyMany(
      state,
      {},
      () => ({ authority: 0.9 }),
      "system:eval",
    );
    expect(next.items.get("m1")!.authority).toBe(0.9);
    expect(next.items.get("m2")!.authority).toBe(0.9);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.type === "memory.updated")).toBe(true);
  });

  it("retracts items when transform returns null", () => {
    const state = buildState([
      baseItem("m1", { authority: 0.1 }),
      baseItem("m2", { authority: 0.8 }),
    ]);
    const { state: next, events } = applyMany(
      state,
      {},
      (item) => (item.authority < 0.5 ? null : {}),
      "system:cleanup",
    );
    expect(next.items.has("m1")).toBe(false);
    expect(next.items.has("m2")).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("memory.retracted");
  });

  it("skips items when transform returns empty object", () => {
    const state = buildState([baseItem("m1"), baseItem("m2")]);
    const { state: next, events } = applyMany(
      state,
      {},
      () => ({}),
      "system:noop",
    );
    expect(next).toBe(state); // no changes, same reference
    expect(events).toHaveLength(0);
  });

  it("uses item-dependent transform (decay)", () => {
    const state = buildState([
      baseItem("m1", { authority: 0.8 }),
      baseItem("m2", { authority: 0.4 }),
    ]);
    const { state: next } = applyMany(
      state,
      {},
      (item) => ({ authority: item.authority * 0.5 }),
      "system:decay",
    );
    expect(next.items.get("m1")!.authority).toBeCloseTo(0.4);
    expect(next.items.get("m2")!.authority).toBeCloseTo(0.2);
  });

  it("conditional: retract low, boost high", () => {
    const state = buildState([
      baseItem("m1", { authority: 0.1 }),
      baseItem("m2", { authority: 0.7 }),
      baseItem("m3", { authority: 0.3 }),
    ]);
    const { state: next, events } = applyMany(
      state,
      {},
      (item) => (item.authority < 0.3 ? null : { authority: 1.0 }),
      "system:evaluator",
    );
    expect(next.items.has("m1")).toBe(false); // retracted
    expect(next.items.get("m2")!.authority).toBe(1.0); // boosted
    expect(next.items.get("m3")!.authority).toBe(1.0); // boosted
    expect(events).toHaveLength(3);
  });

  it("skips items already retracted by a prior transform in the same batch", () => {
    // m1 and m2 both match. Transform retracts m1, then when processing m2
    // it tries to also reference m1 — but m1 is gone. Should not crash.
    const state = buildState([
      baseItem("m1", { authority: 0.1 }),
      baseItem("m2", { authority: 0.1 }),
    ]);
    // First pass retracts both; second one should be skipped, not crash
    const { state: next, events } = applyMany(
      state,
      {},
      (item) => null, // retract all
      "system:cleanup",
    );
    expect(next.items.size).toBe(0);
    expect(events).toHaveLength(2);
  });

  it("shallow-merges meta without losing existing fields", () => {
    const state = buildState([
      baseItem("m1", { meta: { agent_id: "agent:x", session_id: "s1" } }),
    ]);
    const { state: next } = applyMany(
      state,
      {},
      () => ({ meta: { hot: true } }),
      "system:tagger",
    );
    const meta = next.items.get("m1")!.meta!;
    expect(meta.hot).toBe(true);
    expect(meta.agent_id).toBe("agent:x");
    expect(meta.session_id).toBe("s1");
  });

  it("applies filter before transform", () => {
    const state = buildState([
      baseItem("m1", { scope: "a" }),
      baseItem("m2", { scope: "b" }),
    ]);
    const { state: next } = applyMany(
      state,
      { scope: "a" },
      () => ({ authority: 1.0 }),
      "system:eval",
    );
    expect(next.items.get("m1")!.authority).toBe(1.0);
    expect(next.items.get("m2")!.authority).toBe(0.5); // untouched
  });

  it("respects QueryOptions sort + limit", () => {
    const state = buildState([
      baseItem("m1", { authority: 0.3 }),
      baseItem("m2", { authority: 0.9 }),
      baseItem("m3", { authority: 0.6 }),
    ]);
    const { state: next, events } = applyMany(
      state,
      {},
      () => ({ meta: { top: true } }),
      "system:tagger",
      undefined,
      { sort: { field: "authority", order: "desc" }, limit: 2 },
    );
    // only top 2 by authority (m2, m3) should be tagged
    expect(next.items.get("m2")!.meta?.top).toBe(true);
    expect(next.items.get("m3")!.meta?.top).toBe(true);
    expect(next.items.get("m1")!.meta?.top).toBeUndefined();
    expect(events).toHaveLength(2);
  });

  it("does not mutate original state", () => {
    const state = buildState([baseItem("m1", { authority: 0.5 })]);
    applyMany(state, {}, () => ({ authority: 1.0 }), "test");
    expect(state.items.get("m1")!.authority).toBe(0.5);
  });
});

// -- bulkAdjustScores (now wraps applyMany) --

describe("bulkAdjustScores", () => {
  it("adjusts authority on matching items", () => {
    const state = buildState([
      baseItem("m1", { authority: 0.5 }),
      baseItem("m2", { authority: 0.6 }),
      baseItem("m3", { authority: 0.7 }),
    ]);
    const { state: next, events } = bulkAdjustScores(
      state,
      { range: { authority: { min: 0.5 } } },
      { authority: -0.2 },
      "system:tuner",
      "decay",
    );
    expect(next.items.get("m1")!.authority).toBeCloseTo(0.3);
    expect(next.items.get("m2")!.authority).toBeCloseTo(0.4);
    expect(next.items.get("m3")!.authority).toBeCloseTo(0.5);
    expect(events).toHaveLength(3);
  });

  it("clamps to 0 (no negative)", () => {
    const state = buildState([baseItem("m1", { authority: 0.1 })]);
    const { state: next } = bulkAdjustScores(
      state,
      {},
      { authority: -0.5 },
      "system:tuner",
    );
    expect(next.items.get("m1")!.authority).toBe(0);
  });

  it("clamps to 1 (no overflow)", () => {
    const state = buildState([baseItem("m1", { authority: 0.9 })]);
    const { state: next } = bulkAdjustScores(
      state,
      {},
      { authority: 0.5 },
      "system:tuner",
    );
    expect(next.items.get("m1")!.authority).toBe(1);
  });

  it("treats undefined importance as 0 when adding delta", () => {
    const state = buildState([baseItem("m1")]);
    const { state: next } = bulkAdjustScores(
      state,
      {},
      { importance: 0.7 },
      "system:tuner",
    );
    expect(next.items.get("m1")!.importance).toBe(0.7);
  });

  it("returns unchanged state and empty events when no matches", () => {
    const state = buildState([baseItem("m1", { scope: "other" })]);
    const { state: next, events } = bulkAdjustScores(
      state,
      { scope: "nonexistent" },
      { authority: 0.1 },
      "system:tuner",
    );
    expect(next).toBe(state);
    expect(events).toHaveLength(0);
  });

  it("does not mutate original state", () => {
    const state = buildState([baseItem("m1", { authority: 0.5 })]);
    bulkAdjustScores(state, {}, { authority: 0.3 }, "system:tuner");
    expect(state.items.get("m1")!.authority).toBe(0.5);
  });
});
