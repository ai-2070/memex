import { describe, it, expect } from "vitest";
import {
  getSupportTree,
  getSupportSet,
  filterContradictions,
  surfaceContradictions,
  applyDiversity,
  smartRetrieve,
} from "../src/retrieval.js";
import { extractTimestamp, getItems, getScoredItems } from "../src/query.js";
import { markContradiction, resolveContradiction } from "../src/integrity.js";
import { createGraphState } from "../src/graph.js";
import { createMemoryItem } from "../src/helpers.js";
import { applyCommand } from "../src/reducer.js";
import type { MemoryItem, GraphState, ScoredItem } from "../src/types.js";

// -- helpers --

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
  const s = createGraphState();
  for (const i of items) s.items.set(i.id, i);
  return s;
}

function toScored(items: MemoryItem[], scores: number[]): ScoredItem[] {
  return items.map((item, i) => ({ item, score: scores[i] }));
}

// ============================================================
// 1. Support tree & support set
// ============================================================

describe("getSupportTree", () => {
  it("returns null for non-existent item", () => {
    const state = stateWith([]);
    expect(getSupportTree(state, "nope")).toBeNull();
  });

  it("returns leaf node for item with no parents", () => {
    const state = stateWith([makeItem("m1")]);
    const tree = getSupportTree(state, "m1")!;
    expect(tree.item.id).toBe("m1");
    expect(tree.parents).toHaveLength(0);
  });

  it("builds a simple chain", () => {
    const state = stateWith([
      makeItem("m1"),
      makeItem("m2", { parents: ["m1"] }),
      makeItem("m3", { parents: ["m2"] }),
    ]);
    const tree = getSupportTree(state, "m3")!;
    expect(tree.item.id).toBe("m3");
    expect(tree.parents).toHaveLength(1);
    expect(tree.parents[0].item.id).toBe("m2");
    expect(tree.parents[0].parents).toHaveLength(1);
    expect(tree.parents[0].parents[0].item.id).toBe("m1");
    expect(tree.parents[0].parents[0].parents).toHaveLength(0);
  });

  it("builds a diamond (two parents, shared grandparent)", () => {
    const state = stateWith([
      makeItem("m1"),
      makeItem("m2", { parents: ["m1"] }),
      makeItem("m3", { parents: ["m1"] }),
      makeItem("m4", { parents: ["m2", "m3"] }),
    ]);
    const tree = getSupportTree(state, "m4")!;
    expect(tree.parents).toHaveLength(2);
    // m1 appears in both branches but visited set prevents infinite recursion
    const allIds = new Set<string>();
    function collect(node: typeof tree): void {
      allIds.add(node.item.id);
      node.parents.forEach(collect);
    }
    collect(tree);
    expect(allIds).toEqual(new Set(["m1", "m2", "m3", "m4"]));
  });

  it("handles missing parents gracefully", () => {
    const state = stateWith([
      makeItem("m2", { parents: ["m1"] }), // m1 doesn't exist
    ]);
    const tree = getSupportTree(state, "m2")!;
    expect(tree.item.id).toBe("m2");
    expect(tree.parents).toHaveLength(0); // m1 missing, skipped
  });
});

describe("getSupportSet", () => {
  it("returns empty for non-existent item", () => {
    expect(getSupportSet(stateWith([]), "nope")).toHaveLength(0);
  });

  it("returns the item itself for root items", () => {
    const state = stateWith([makeItem("m1")]);
    const set = getSupportSet(state, "m1");
    expect(set).toHaveLength(1);
    expect(set[0].id).toBe("m1");
  });

  it("returns full provenance chain (deduplicated)", () => {
    const state = stateWith([
      makeItem("m1"),
      makeItem("m2", { parents: ["m1"] }),
      makeItem("m3", { parents: ["m1"] }),
      makeItem("m4", { parents: ["m2", "m3"] }),
    ]);
    const set = getSupportSet(state, "m4");
    expect(set).toHaveLength(4);
    expect(set.map((i) => i.id).sort()).toEqual(["m1", "m2", "m3", "m4"]);
  });
});

// ============================================================
// 2. Contradiction-aware packing
// ============================================================

describe("filterContradictions", () => {
  it("removes superseded items", () => {
    const state = stateWith([
      makeItem("m1", { authority: 0.9 }),
      makeItem("m2", { authority: 0.3 }),
    ]);
    const { state: marked } = markContradiction(
      state,
      "m1",
      "m2",
      "system:detector",
    );
    const { state: resolved } = resolveContradiction(
      marked,
      "m1",
      "m2",
      "system:resolver",
    );

    const scored = toScored(
      [resolved.items.get("m1")!, resolved.items.get("m2")!],
      [0.9, 0.03],
    );
    const filtered = filterContradictions(resolved, scored);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].item.id).toBe("m1");
  });

  it("keeps higher-scoring side of unresolved contradiction", () => {
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

    const scored = toScored(
      [marked.items.get("m1")!, marked.items.get("m2")!],
      [0.9, 0.7],
    );
    const filtered = filterContradictions(marked, scored);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].item.id).toBe("m1");
  });

  it("passes through items with no contradictions", () => {
    const state = stateWith([makeItem("m1"), makeItem("m2")]);
    const scored = toScored(
      [state.items.get("m1")!, state.items.get("m2")!],
      [0.9, 0.7],
    );
    const filtered = filterContradictions(state, scored);
    expect(filtered).toHaveLength(2);
  });
});

describe("surfaceContradictions", () => {
  it("keeps both sides and flags them", () => {
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

    const scored = toScored(
      [marked.items.get("m1")!, marked.items.get("m2")!],
      [0.9, 0.7],
    );
    const result = surfaceContradictions(marked, scored);
    expect(result).toHaveLength(2);
    expect(
      result.find((s) => s.item.id === "m1")!.contradicted_by,
    ).toHaveLength(1);
    expect(result.find((s) => s.item.id === "m1")!.contradicted_by![0].id).toBe(
      "m2",
    );
    expect(
      result.find((s) => s.item.id === "m2")!.contradicted_by,
    ).toHaveLength(1);
    expect(result.find((s) => s.item.id === "m2")!.contradicted_by![0].id).toBe(
      "m1",
    );
  });

  it("still removes superseded items", () => {
    const state = stateWith([
      makeItem("m1", { authority: 0.9 }),
      makeItem("m2", { authority: 0.3 }),
    ]);
    const { state: marked } = markContradiction(
      state,
      "m1",
      "m2",
      "system:detector",
    );
    const { state: resolved } = resolveContradiction(
      marked,
      "m1",
      "m2",
      "system:resolver",
    );

    const scored = toScored(
      [resolved.items.get("m1")!, resolved.items.get("m2")!],
      [0.9, 0.03],
    );
    const result = surfaceContradictions(resolved, scored);
    expect(result).toHaveLength(1);
    expect(result[0].item.id).toBe("m1");
    expect(result[0].contradicted_by).toBeUndefined();
  });

  it("no contradictions means no flags", () => {
    const state = stateWith([makeItem("m1"), makeItem("m2")]);
    const scored = toScored(
      [state.items.get("m1")!, state.items.get("m2")!],
      [0.9, 0.7],
    );
    const result = surfaceContradictions(state, scored);
    expect(result).toHaveLength(2);
    expect(result[0].contradicted_by).toBeUndefined();
    expect(result[1].contradicted_by).toBeUndefined();
  });
});

describe("smartRetrieve with contradictions: surface", () => {
  it("surfaces both sides with flags in the pipeline", () => {
    const state = stateWith([
      makeItem("m1", { authority: 0.9 }),
      makeItem("m2", { authority: 0.7 }),
      makeItem("m3", { authority: 0.5 }),
    ]);
    const { state: marked } = markContradiction(
      state,
      "m1",
      "m2",
      "system:detector",
    );

    const result = smartRetrieve(marked, {
      budget: 100,
      costFn: () => 1,
      weights: { authority: 1 },
      contradictions: "surface",
    });

    expect(result).toHaveLength(3);
    const m1 = result.find((s) => s.item.id === "m1")!;
    const m2 = result.find((s) => s.item.id === "m2")!;
    const m3 = result.find((s) => s.item.id === "m3")!;
    expect(m1.contradicted_by).toHaveLength(1);
    expect(m2.contradicted_by).toHaveLength(1);
    expect(m3.contradicted_by).toBeUndefined();
  });
});

// ============================================================
// 3. Diversity scoring
// ============================================================

describe("applyDiversity", () => {
  it("penalizes duplicate authors", () => {
    const items = [
      makeItem("m1", { author: "agent:a" }),
      makeItem("m2", { author: "agent:a" }),
      makeItem("m3", { author: "agent:b" }),
    ];
    const scored = toScored(items, [0.9, 0.8, 0.7]);
    const diversified = applyDiversity(scored, { author_penalty: 0.3 });

    // m1: 0.9 (first from agent:a, no penalty)
    // m3: 0.7 (first from agent:b, no penalty)
    // m2: 0.8 - 0.3 = 0.5 (second from agent:a)
    expect(diversified[0].item.id).toBe("m1");
    expect(diversified[1].item.id).toBe("m3");
    expect(diversified[2].item.id).toBe("m2");
    expect(diversified[2].score).toBeCloseTo(0.5);
  });

  it("penalizes shared parents", () => {
    const items = [
      makeItem("m2", { parents: ["m1"] }),
      makeItem("m3", { parents: ["m1"] }),
      makeItem("m4", { parents: ["m5"] }),
    ];
    const scored = toScored(items, [0.9, 0.8, 0.7]);
    const diversified = applyDiversity(scored, { parent_penalty: 0.4 });

    // m2: 0.9 (first from parent m1)
    // m4: 0.7 (first from parent m5)
    // m3: 0.8 - 0.4 = 0.4 (second from parent m1)
    expect(diversified[0].item.id).toBe("m2");
    expect(diversified[1].item.id).toBe("m4");
    expect(diversified[2].item.id).toBe("m3");
  });

  it("penalizes duplicate source_kind", () => {
    const items = [
      makeItem("m1", { source_kind: "observed" }),
      makeItem("m2", { source_kind: "observed" }),
      makeItem("m3", { source_kind: "agent_inferred" }),
    ];
    const scored = toScored(items, [0.9, 0.85, 0.7]);
    const diversified = applyDiversity(scored, { source_penalty: 0.2 });

    expect(diversified[0].item.id).toBe("m1");
    expect(diversified[1].item.id).toBe("m3"); // different source, no penalty
    expect(diversified[2].item.id).toBe("m2"); // 0.85 - 0.2 = 0.65
  });

  it("combines multiple penalties", () => {
    const items = [
      makeItem("m1", { author: "agent:a", source_kind: "observed" }),
      makeItem("m2", { author: "agent:a", source_kind: "observed" }),
    ];
    const scored = toScored(items, [0.9, 0.9]);
    const diversified = applyDiversity(scored, {
      author_penalty: 0.1,
      source_penalty: 0.1,
    });

    // m1: 0.9, m2: 0.9 - 0.1 - 0.1 = 0.7
    expect(diversified[0].score).toBeCloseTo(0.9);
    expect(diversified[1].score).toBeCloseTo(0.7);
  });

  it("clamps score to 0", () => {
    const items = [makeItem("m1"), makeItem("m2", { author: "agent:a" })];
    // m1 first with author agent:a, m2 second with same author
    items[0].author = "agent:a";
    const scored = toScored(items, [0.5, 0.1]);
    const diversified = applyDiversity(scored, { author_penalty: 0.5 });
    expect(diversified[1].score).toBe(0); // 0.1 - 0.5, clamped to 0
  });
});

// ============================================================
// 4. Temporal sort (recency)
// ============================================================

describe("extractTimestamp", () => {
  it("extracts milliseconds from a uuidv7", () => {
    const item = createMemoryItem({
      scope: "test",
      kind: "observation",
      content: {},
      author: "test",
      source_kind: "observed",
      authority: 1,
    });
    const ts = extractTimestamp(item.id);
    const now = Date.now();
    // should be within 1 second of now
    expect(Math.abs(ts - now)).toBeLessThan(1000);
  });

  it("throws for non-UUIDv7 id", () => {
    expect(() => extractTimestamp("not-a-uuid")).toThrow(
      "not a valid UUIDv7",
    );
  });

  it("throws for custom id without UUIDv7 format", () => {
    expect(() => extractTimestamp("custom-id-12345")).toThrow(
      "not a valid UUIDv7",
    );
  });

  it("preserves ordering between items created sequentially", () => {
    const item1 = createMemoryItem({
      scope: "test",
      kind: "observation",
      content: {},
      author: "test",
      source_kind: "observed",
      authority: 1,
    });
    const item2 = createMemoryItem({
      scope: "test",
      kind: "observation",
      content: {},
      author: "test",
      source_kind: "observed",
      authority: 1,
    });
    expect(extractTimestamp(item2.id)).toBeGreaterThanOrEqual(
      extractTimestamp(item1.id),
    );
  });
});

describe("recency sort", () => {
  it("sorts by creation time descending", () => {
    const items = [
      makeItem("older", { authority: 0.5 }),
      makeItem("newer", { authority: 0.5 }),
    ];
    // manually set ids with known time ordering
    // use createMemoryItem to get real uuidv7 ids
    const older = createMemoryItem({
      scope: "test",
      kind: "observation",
      content: { order: 1 },
      author: "test",
      source_kind: "observed",
      authority: 0.5,
    });
    const newer = createMemoryItem({
      scope: "test",
      kind: "observation",
      content: { order: 2 },
      author: "test",
      source_kind: "observed",
      authority: 0.5,
    });
    const state = stateWith([older, newer]);

    const result = getItems(
      state,
      {},
      { sort: { field: "recency", order: "desc" } },
    );
    expect(extractTimestamp(result[0].id)).toBeGreaterThanOrEqual(
      extractTimestamp(result[1].id),
    );
  });
});

// ============================================================
// 5. Decay scoring
// ============================================================

describe("decay scoring", () => {
  it("exponential decay reduces score for older items", () => {
    // items with synthetic ids — use real uuidv7 so they have "now" timestamps
    const item = createMemoryItem({
      scope: "test",
      kind: "observation",
      content: {},
      author: "test",
      source_kind: "observed",
      authority: 1.0,
      importance: 1.0,
    });
    const state = stateWith([item]);

    // no decay — full score
    const noDecay = getScoredItems(state, { authority: 0.5, importance: 0.5 });
    expect(noDecay[0].score).toBeCloseTo(1.0);

    // with decay — item created just now, so decay multiplier is ~1.0
    const withDecay = getScoredItems(state, {
      authority: 0.5,
      importance: 0.5,
      decay: { rate: 0.1, interval: "day", type: "exponential" },
    });
    // age is ~0ms, so multiplier is ~1.0
    expect(withDecay[0].score).toBeCloseTo(1.0, 1);
  });

  it("exponential decay formula is correct", () => {
    // manually construct an item with a known old timestamp
    // uuidv7 encodes ms in first 48 bits — we can fake it
    const now = Date.now();
    const twoDaysAgo = now - 2 * 86400000;
    const hex = twoDaysAgo.toString(16).padStart(12, "0");
    const fakeId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000000`;

    const item: MemoryItem = {
      id: fakeId,
      scope: "test",
      kind: "observation",
      content: {},
      author: "test",
      source_kind: "observed",
      authority: 1.0,
    };
    const state = stateWith([item]);

    const result = getScoredItems(state, {
      authority: 1.0,
      decay: { rate: 0.5, interval: "day", type: "exponential" },
    });
    // 2 days old, 50% decay per day exponential: (1 - 0.5)^2 = 0.25
    expect(result[0].score).toBeCloseTo(0.25, 1);
  });

  it("linear decay reaches zero", () => {
    const now = Date.now();
    const fiveDaysAgo = now - 5 * 86400000;
    const hex = fiveDaysAgo.toString(16).padStart(12, "0");
    const fakeId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000000`;

    const item: MemoryItem = {
      id: fakeId,
      scope: "test",
      kind: "observation",
      content: {},
      author: "test",
      source_kind: "observed",
      authority: 1.0,
    };
    const state = stateWith([item]);

    const result = getScoredItems(state, {
      authority: 1.0,
      decay: { rate: 0.3, interval: "day", type: "linear" },
    });
    // 5 days * 0.3/day = 1.5 → clamped to 0 → multiplier = 0
    expect(result[0].score).toBe(0);
  });

  it("step decay drops at interval boundaries", () => {
    const now = Date.now();
    const oneAndHalfDays = now - 1.5 * 86400000;
    const hex = oneAndHalfDays.toString(16).padStart(12, "0");
    const fakeId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000000`;

    const item: MemoryItem = {
      id: fakeId,
      scope: "test",
      kind: "observation",
      content: {},
      author: "test",
      source_kind: "observed",
      authority: 1.0,
    };
    const state = stateWith([item]);

    const result = getScoredItems(state, {
      authority: 1.0,
      decay: { rate: 0.5, interval: "day", type: "step" },
    });
    // floor(1.5) = 1 interval, step: (1-0.5)^1 = 0.5
    expect(result[0].score).toBeCloseTo(0.5, 1);
  });

  it("hourly interval works", () => {
    const now = Date.now();
    const threeHoursAgo = now - 3 * 3600000;
    const hex = threeHoursAgo.toString(16).padStart(12, "0");
    const fakeId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000000`;

    const item: MemoryItem = {
      id: fakeId,
      scope: "test",
      kind: "observation",
      content: {},
      author: "test",
      source_kind: "observed",
      authority: 1.0,
    };
    const state = stateWith([item]);

    const result = getScoredItems(state, {
      authority: 1.0,
      decay: { rate: 0.2, interval: "hour", type: "exponential" },
    });
    // 3 hours, 20%/hour: (0.8)^3 = 0.512
    expect(result[0].score).toBeCloseTo(0.512, 1);
  });

  it("no decay config means no decay applied", () => {
    const item = makeItem("m1", { authority: 0.8 });
    const state = stateWith([item]);
    const result = getScoredItems(state, { authority: 1.0 });
    expect(result[0].score).toBeCloseTo(0.8);
  });
});

// ============================================================
// 6. Smart retrieval (combined pipeline)
// ============================================================

describe("smartRetrieve", () => {
  it("basic budget packing", () => {
    const state = stateWith([
      makeItem("m1", { authority: 0.9 }),
      makeItem("m2", { authority: 0.5 }),
      makeItem("m3", { authority: 0.3 }),
    ]);
    const result = smartRetrieve(state, {
      budget: 20,
      costFn: () => 10,
      weights: { authority: 1 },
    });
    expect(result).toHaveLength(2);
    expect(result[0].item.id).toBe("m1");
    expect(result[1].item.id).toBe("m2");
  });

  it("excludes superseded items with contradictions: filter", () => {
    const state = stateWith([
      makeItem("m1", { authority: 0.9 }),
      makeItem("m2", { authority: 0.7 }),
      makeItem("m3", { authority: 0.5 }),
    ]);
    const { state: marked } = markContradiction(
      state,
      "m1",
      "m2",
      "system:detector",
    );
    const { state: resolved } = resolveContradiction(
      marked,
      "m1",
      "m2",
      "system:resolver",
    );

    const result = smartRetrieve(resolved, {
      budget: 100,
      costFn: () => 1,
      weights: { authority: 1 },
      contradictions: "filter",
    });

    const ids = result.map((r) => r.item.id);
    expect(ids).toContain("m1");
    expect(ids).not.toContain("m2"); // superseded
    expect(ids).toContain("m3");
  });

  it("applies diversity to spread authors", () => {
    const state = stateWith([
      makeItem("m1", { author: "agent:a", authority: 0.9 }),
      makeItem("m2", { author: "agent:a", authority: 0.85 }),
      makeItem("m3", { author: "agent:b", authority: 0.8 }),
    ]);
    const result = smartRetrieve(state, {
      budget: 20,
      costFn: () => 10,
      weights: { authority: 1 },
      diversity: { author_penalty: 0.5 },
    });
    // m1 (0.9) and m3 (0.8) should be picked over m2 (0.85 - 0.5 = 0.35)
    expect(result).toHaveLength(2);
    expect(result[0].item.id).toBe("m1");
    expect(result[1].item.id).toBe("m3");
  });

  it("throws RangeError when costFn returns 0", () => {
    const state = stateWith([makeItem("m1", { authority: 0.9 })]);
    expect(() =>
      smartRetrieve(state, {
        budget: 100,
        costFn: () => 0,
        weights: { authority: 1 },
      }),
    ).toThrow(RangeError);
  });

  it("throws RangeError when costFn returns negative value", () => {
    const state = stateWith([makeItem("m1", { authority: 0.9 })]);
    expect(() =>
      smartRetrieve(state, {
        budget: 100,
        costFn: () => -5,
        weights: { authority: 1 },
      }),
    ).toThrow(RangeError);
  });

  it("throws RangeError when costFn returns NaN", () => {
    const state = stateWith([makeItem("m1", { authority: 0.9 })]);
    expect(() =>
      smartRetrieve(state, {
        budget: 100,
        costFn: () => NaN,
        weights: { authority: 1 },
      }),
    ).toThrow(RangeError);
  });

  it("full pipeline: filter + contradictions + diversity + budget", () => {
    const state = stateWith([
      makeItem("m1", { scope: "a", author: "agent:x", authority: 0.9 }),
      makeItem("m2", { scope: "a", author: "agent:x", authority: 0.85 }),
      makeItem("m3", { scope: "a", author: "agent:y", authority: 0.8 }),
      makeItem("m4", { scope: "b", author: "agent:z", authority: 0.95 }),
    ]);
    const result = smartRetrieve(state, {
      budget: 20,
      costFn: () => 10,
      weights: { authority: 1 },
      filter: { scope: "a" },
      diversity: { author_penalty: 0.3 },
    });
    // scope "a" only: m1 (0.9), m2 (0.85-0.3=0.55), m3 (0.8)
    // budget 20, cost 10: picks m1 and m3
    expect(result).toHaveLength(2);
    expect(result[0].item.id).toBe("m1");
    expect(result[1].item.id).toBe("m3");
  });
});
