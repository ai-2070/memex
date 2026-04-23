import { describe, it, expect } from "vitest";
import {
  getContradictions,
  markContradiction,
  resolveContradiction,
  getStaleItems,
  getDependents,
  cascadeRetract,
  markAlias,
  getAliases,
  getAliasGroup,
  getItemsByBudget,
} from "../src/integrity.js";
import { applyCommand } from "../src/reducer.js";
import { createGraphState } from "../src/graph.js";
import type { MemoryItem, Edge, GraphState } from "../src/types.js";

// -- helpers --

const makeItem = (
  id: string,
  overrides: Partial<MemoryItem> = {},
): MemoryItem => ({
  id,
  scope: "test",
  kind: "observation",
  content: {},
  author: "user:laz",
  source_kind: "observed",
  authority: 0.8,
  ...overrides,
});

function stateWith(items: MemoryItem[], edges: Edge[] = []): GraphState {
  const s = createGraphState();
  for (const i of items) s.items.set(i.id, i);
  for (const e of edges) s.edges.set(e.edge_id, e);
  return s;
}

function addItem(state: GraphState, item: MemoryItem): GraphState {
  return applyCommand(state, { type: "memory.create", item }).state;
}

// ============================================================
// 1. Temporal forking — contradiction detection & resolution
// ============================================================

describe("contradictions", () => {
  it("markContradiction creates a CONTRADICTS edge", () => {
    const state = stateWith([makeItem("m1"), makeItem("m2")]);
    const { state: next, events } = markContradiction(
      state,
      "m1",
      "m2",
      "system:detector",
    );
    const edges = [...next.edges.values()];
    expect(edges).toHaveLength(1);
    expect(edges[0].kind).toBe("CONTRADICTS");
    expect(edges[0].from).toBe("m1");
    expect(edges[0].to).toBe("m2");
    expect(events[0].type).toBe("edge.created");
  });

  it("getContradictions finds contradiction pairs", () => {
    const state = stateWith([makeItem("m1"), makeItem("m2")]);
    const { state: next } = markContradiction(
      state,
      "m1",
      "m2",
      "system:detector",
    );
    const contradictions = getContradictions(next);
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0].a.id).toBe("m1");
    expect(contradictions[0].b.id).toBe("m2");
    expect(contradictions[0].edge).toBeDefined();
  });

  it("getContradictions returns empty when none exist", () => {
    const state = stateWith([makeItem("m1"), makeItem("m2")]);
    expect(getContradictions(state)).toHaveLength(0);
  });

  it("resolveContradiction supersedes loser and lowers authority", () => {
    const state = stateWith([
      makeItem("m1", { authority: 0.9 }),
      makeItem("m2", { authority: 0.7 }),
    ]);
    const { state: marked } = markContradiction(
      state,
      "m1",
      "m2",
      "system:detector",
    );
    const { state: resolved, events } = resolveContradiction(
      marked,
      "m1",
      "m2",
      "system:resolver",
      "m1 has more evidence",
    );

    // CONTRADICTS edge retracted
    const contradicts = [...resolved.edges.values()].filter(
      (e) => e.kind === "CONTRADICTS" && e.active,
    );
    expect(contradicts).toHaveLength(0);

    // SUPERSEDES edge created
    const supersedes = [...resolved.edges.values()].filter(
      (e) => e.kind === "SUPERSEDES",
    );
    expect(supersedes).toHaveLength(1);
    expect(supersedes[0].from).toBe("m1");
    expect(supersedes[0].to).toBe("m2");

    // loser authority lowered
    expect(resolved.items.get("m2")!.authority).toBeCloseTo(0.07);

    expect(events.length).toBeGreaterThanOrEqual(3);
  });
});

// ============================================================
// 2. Observational continuity — stale detection & cascade
// ============================================================

describe("observational continuity", () => {
  it("getStaleItems finds items with missing parents", () => {
    // m2 has parent m1, but m1 is not in state
    const state = stateWith([
      makeItem("m2", { parents: ["m1"] }),
      makeItem("m3"),
    ]);
    const stale = getStaleItems(state);
    expect(stale).toHaveLength(1);
    expect(stale[0].item.id).toBe("m2");
    expect(stale[0].missing_parents).toEqual(["m1"]);
  });

  it("getStaleItems returns empty when all parents exist", () => {
    const state = stateWith([
      makeItem("m1"),
      makeItem("m2", { parents: ["m1"] }),
    ]);
    expect(getStaleItems(state)).toHaveLength(0);
  });

  it("getDependents returns direct children", () => {
    const state = stateWith([
      makeItem("m1"),
      makeItem("m2", { parents: ["m1"] }),
      makeItem("m3", { parents: ["m1"] }),
      makeItem("m4"),
    ]);
    const deps = getDependents(state, "m1");
    expect(deps).toHaveLength(2);
    expect(deps.map((d) => d.id).sort()).toEqual(["m2", "m3"]);
  });

  it("getDependents with transitive finds full chain", () => {
    const state = stateWith([
      makeItem("m1"),
      makeItem("m2", { parents: ["m1"] }),
      makeItem("m3", { parents: ["m2"] }),
      makeItem("m4", { parents: ["m3"] }),
    ]);
    const deps = getDependents(state, "m1", true);
    expect(deps).toHaveLength(3);
    expect(deps.map((d) => d.id).sort()).toEqual(["m2", "m3", "m4"]);
  });

  it("cascadeRetract retracts item and all transitive dependents", () => {
    const state = stateWith([
      makeItem("m1"),
      makeItem("m2", { parents: ["m1"] }),
      makeItem("m3", { parents: ["m2"] }),
      makeItem("m4"),
    ]);
    const { state: next, retracted } = cascadeRetract(
      state,
      "m1",
      "system:cleanup",
      "invalid source",
    );
    expect(next.items.has("m1")).toBe(false);
    expect(next.items.has("m2")).toBe(false);
    expect(next.items.has("m3")).toBe(false);
    expect(next.items.has("m4")).toBe(true); // unrelated
    expect(retracted.sort()).toEqual(["m1", "m2", "m3"]);
  });

  it("cascadeRetract handles diamond dependencies", () => {
    // m1 → m2, m1 → m3, m2 → m4, m3 → m4
    const state = stateWith([
      makeItem("m1"),
      makeItem("m2", { parents: ["m1"] }),
      makeItem("m3", { parents: ["m1"] }),
      makeItem("m4", { parents: ["m2", "m3"] }),
    ]);
    const { state: next, retracted } = cascadeRetract(
      state,
      "m1",
      "system:cleanup",
    );
    expect(next.items.size).toBe(0);
    expect(retracted.sort()).toEqual(["m1", "m2", "m3", "m4"]);
  });
});

// ============================================================
// 3. Recognition vs discovery — identity / aliasing
// ============================================================

describe("aliasing", () => {
  it("markAlias creates bidirectional ALIAS edges", () => {
    const state = stateWith([makeItem("m1"), makeItem("m2")]);
    const { state: next, events } = markAlias(
      state,
      "m1",
      "m2",
      "system:dedup",
    );
    const aliasEdges = [...next.edges.values()].filter(
      (e) => e.kind === "ALIAS",
    );
    expect(aliasEdges).toHaveLength(2);
    expect(aliasEdges.some((e) => e.from === "m1" && e.to === "m2")).toBe(true);
    expect(aliasEdges.some((e) => e.from === "m2" && e.to === "m1")).toBe(true);
    expect(events).toHaveLength(2);
  });

  it("getAliases returns direct aliases", () => {
    const state = stateWith([makeItem("m1"), makeItem("m2"), makeItem("m3")]);
    let next = markAlias(state, "m1", "m2", "system:dedup").state;
    const aliases = getAliases(next, "m1");
    expect(aliases).toHaveLength(1);
    expect(aliases[0].id).toBe("m2");
  });

  it("getAliases returns empty when none exist", () => {
    const state = stateWith([makeItem("m1")]);
    expect(getAliases(state, "m1")).toHaveLength(0);
  });

  it("getAliasGroup returns transitive closure", () => {
    const state = stateWith([makeItem("m1"), makeItem("m2"), makeItem("m3")]);
    let next = markAlias(state, "m1", "m2", "system:dedup").state;
    next = markAlias(next, "m2", "m3", "system:dedup").state;
    const group = getAliasGroup(next, "m1");
    expect(group).toHaveLength(3);
    expect(group.map((i) => i.id).sort()).toEqual(["m1", "m2", "m3"]);
  });

  it("getAliasGroup from any member returns same group", () => {
    const state = stateWith([makeItem("m1"), makeItem("m2"), makeItem("m3")]);
    let next = markAlias(state, "m1", "m2", "system:dedup").state;
    next = markAlias(next, "m2", "m3", "system:dedup").state;
    const fromM3 = getAliasGroup(next, "m3");
    expect(fromM3.map((i) => i.id).sort()).toEqual(["m1", "m2", "m3"]);
  });
});

// ============================================================
// 4. Budget-aware probabilistic retrieval
// ============================================================

describe("getItemsByBudget", () => {
  it("packs highest-scoring items within budget", () => {
    const state = stateWith([
      makeItem("m1", {
        authority: 0.9,
        importance: 0.8,
        content: { text: "short" },
      }),
      makeItem("m2", {
        authority: 0.3,
        importance: 0.2,
        content: { text: "short" },
      }),
      makeItem("m3", {
        authority: 0.7,
        importance: 0.6,
        content: { text: "short" },
      }),
    ]);
    const result = getItemsByBudget(state, {
      budget: 20,
      costFn: () => 10, // each item costs 10
      weights: { authority: 1 },
    });
    // budget 20, cost 10 each → 2 items, highest authority first
    expect(result).toHaveLength(2);
    expect(result[0].item.id).toBe("m1"); // 0.9
    expect(result[1].item.id).toBe("m3"); // 0.7
  });

  it("respects variable cost per item", () => {
    const state = stateWith([
      makeItem("m1", { authority: 0.9, content: { text: "a".repeat(100) } }),
      makeItem("m2", { authority: 0.8, content: { text: "b".repeat(10) } }),
      makeItem("m3", { authority: 0.7, content: { text: "c".repeat(10) } }),
    ]);
    const result = getItemsByBudget(state, {
      budget: 50,
      costFn: (item) => JSON.stringify(item.content).length,
      weights: { authority: 1 },
    });
    // m1 costs ~106 (too expensive), m2 and m3 cost ~16 each → both fit in 50
    expect(result.map((r) => r.item.id)).toEqual(["m2", "m3"]);
  });

  it("returns empty when budget is 0", () => {
    const state = stateWith([makeItem("m1")]);
    const result = getItemsByBudget(state, {
      budget: 0,
      costFn: () => 1,
      weights: { authority: 1 },
    });
    expect(result).toHaveLength(0);
  });

  it("applies filter before scoring", () => {
    const state = stateWith([
      makeItem("m1", { scope: "a", authority: 0.9 }),
      makeItem("m2", { scope: "b", authority: 0.8 }),
      makeItem("m3", { scope: "a", authority: 0.7 }),
    ]);
    const result = getItemsByBudget(state, {
      budget: 100,
      costFn: () => 1,
      weights: { authority: 1 },
      filter: { scope: "a" },
    });
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.item.scope === "a")).toBe(true);
  });

  it("uses weighted scores for ranking", () => {
    const state = stateWith([
      makeItem("m1", { authority: 0.9, importance: 0.1 }),
      makeItem("m2", { authority: 0.3, importance: 0.9 }),
    ]);
    // importance-heavy weighting should rank m2 first
    const result = getItemsByBudget(state, {
      budget: 100,
      costFn: () => 1,
      weights: { authority: 0.1, importance: 0.9 },
    });
    expect(result[0].item.id).toBe("m2");
  });

  it("skips expensive items and takes cheaper ones", () => {
    const state = stateWith([
      makeItem("m1", { authority: 0.9 }),
      makeItem("m2", { authority: 0.5 }),
      makeItem("m3", { authority: 0.3 }),
    ]);
    const result = getItemsByBudget(state, {
      budget: 5,
      costFn: (item) => (item.id === "m1" ? 100 : 2), // m1 is too expensive
      weights: { authority: 1 },
    });
    // m1 skipped (too expensive), m2 and m3 fit
    expect(result).toHaveLength(2);
    expect(result[0].item.id).toBe("m2");
    expect(result[1].item.id).toBe("m3");
  });

  it("accepts zero-cost items (free/cached entries)", () => {
    const state = stateWith([makeItem("m1", { authority: 0.9 })]);
    const result = getItemsByBudget(state, {
      budget: 100,
      costFn: () => 0,
      weights: { authority: 1 },
    });
    expect(result).toHaveLength(1);
  });

  it("throws RangeError when costFn returns negative value", () => {
    const state = stateWith([makeItem("m1", { authority: 0.9 })]);
    expect(() =>
      getItemsByBudget(state, {
        budget: 100,
        costFn: () => -1,
        weights: { authority: 1 },
      }),
    ).toThrow(RangeError);
  });

  it("throws RangeError when costFn returns NaN", () => {
    const state = stateWith([makeItem("m1", { authority: 0.9 })]);
    expect(() =>
      getItemsByBudget(state, {
        budget: 100,
        costFn: () => NaN,
        weights: { authority: 1 },
      }),
    ).toThrow(RangeError);
  });
});
