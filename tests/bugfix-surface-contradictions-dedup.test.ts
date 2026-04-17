import { describe, it, expect } from "vitest";
import { applyCommand } from "../src/reducer.js";
import { createGraphState } from "../src/graph.js";
import { markContradiction } from "../src/integrity.js";
import { surfaceContradictions } from "../src/retrieval.js";
import type { MemoryItem, GraphState, ScoredItem } from "../src/types.js";

// ============================================================
// Dedup contradicted_by when multiple CONTRADICTS edges connect the same pair
//
// surfaceContradictions iterates every CONTRADICTS edge and pushes into each
// side's contradicted_by list. Before the fix, callers that ended up with
// more than one edge per pair — bidirectional (A→B plus B→A), multi-edge
// with different reasons, or a self-edge — got duplicate entries.
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

function stateWith(items: MemoryItem[]): GraphState {
  let state = createGraphState();
  for (const item of items) {
    state = applyCommand(state, { type: "memory.create", item }).state;
  }
  return state;
}

function toScored(items: MemoryItem[], scores: number[]): ScoredItem[] {
  return items.map((item, i) => ({ item, score: scores[i] }));
}

describe("surfaceContradictions dedupes contradicted_by by item id", () => {
  it("returns a single entry when two CONTRADICTS edges connect the same pair bidirectionally", () => {
    const m1 = makeItem("m1");
    const m2 = makeItem("m2");
    let state = stateWith([m1, m2]);
    state = markContradiction(state, "m1", "m2", "system:detector-a").state;
    state = markContradiction(state, "m2", "m1", "system:detector-b").state;

    const scored = toScored([m1, m2], [0.5, 0.5]);
    const result = surfaceContradictions(state, scored);

    const r1 = result.find((s) => s.item.id === "m1")!;
    const r2 = result.find((s) => s.item.id === "m2")!;
    expect(r1.contradicted_by).toHaveLength(1);
    expect(r1.contradicted_by![0].id).toBe("m2");
    expect(r2.contradicted_by).toHaveLength(1);
    expect(r2.contradicted_by![0].id).toBe("m1");
  });

  it("returns a single entry when two CONTRADICTS edges point the same direction with different reasons", () => {
    const m1 = makeItem("m1");
    const m2 = makeItem("m2");
    let state = stateWith([m1, m2]);
    // Two edges in the same direction — e.g. two detectors flagging the same
    // pair independently.
    state = markContradiction(state, "m1", "m2", "system:detector-a", {
      reason: "a",
    }).state;
    state = markContradiction(state, "m1", "m2", "system:detector-b", {
      reason: "b",
    }).state;

    const scored = toScored([m1, m2], [0.5, 0.5]);
    const result = surfaceContradictions(state, scored);

    const r1 = result.find((s) => s.item.id === "m1")!;
    const r2 = result.find((s) => s.item.id === "m2")!;
    expect(r1.contradicted_by).toHaveLength(1);
    expect(r2.contradicted_by).toHaveLength(1);
  });

  it("does not annotate self-contradicting items", () => {
    const m1 = makeItem("m1");
    let state = stateWith([m1]);
    // A self-edge can sneak in via applyCommand (the createEdge helper rejects
    // it but the reducer path doesn't). Ensure it doesn't land in the item's
    // own contradicted_by list.
    state = markContradiction(state, "m1", "m1", "system:detector").state;

    const scored = toScored([m1], [0.5]);
    const result = surfaceContradictions(state, scored);

    const r1 = result.find((s) => s.item.id === "m1")!;
    expect(r1.contradicted_by ?? []).toHaveLength(0);
  });

  it("still works for a normal single-edge contradiction", () => {
    const m1 = makeItem("m1");
    const m2 = makeItem("m2");
    let state = stateWith([m1, m2]);
    state = markContradiction(state, "m1", "m2", "system:detector").state;

    const scored = toScored([m1, m2], [0.9, 0.5]);
    const result = surfaceContradictions(state, scored);

    const r1 = result.find((s) => s.item.id === "m1")!;
    const r2 = result.find((s) => s.item.id === "m2")!;
    expect(r1.contradicted_by).toHaveLength(1);
    expect(r1.contradicted_by![0].id).toBe("m2");
    expect(r2.contradicted_by).toHaveLength(1);
    expect(r2.contradicted_by![0].id).toBe("m1");
  });
});
