import { describe, it, expect } from "vitest";
import { applyCommand } from "../src/reducer.js";
import { createGraphState } from "../src/graph.js";
import { createMemoryItem, createEdge } from "../src/helpers.js";
import {
  getItems,
  getRelatedItems,
  getEdges,
  getScoredItems,
  extractTimestamp,
} from "../src/query.js";
import {
  getStaleItems,
  getAliasGroup,
  markAlias,
  markContradiction,
} from "../src/integrity.js";
import {
  getSupportTree,
  getSupportSet,
  filterContradictions,
  applyDiversity,
} from "../src/retrieval.js";
import { applyMany, bulkAdjustScores, decayImportance } from "../src/bulk.js";
import { replayFromEnvelopes } from "../src/replay.js";
import type { MemoryItem, Edge, GraphState, ScoredItem } from "../src/types.js";

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

function stateWith(items: MemoryItem[], edges: Edge[] = []): GraphState {
  const s = createGraphState();
  for (const i of items) s.items.set(i.id, i);
  for (const e of edges) s.edges.set(e.edge_id, e);
  return s;
}

// ============================================================
// Reducer edge cases
// ============================================================

describe("reducer edge cases", () => {
  it("update with null authority sets it to null (not ignored)", () => {
    const state = stateWith([makeItem("m1", { authority: 0.9 })]);
    const { state: next } = applyCommand(state, {
      type: "memory.update",
      item_id: "m1",
      partial: { authority: null as any },
      author: "test",
    });
    // null overwrites the field
    expect(next.items.get("m1")!.authority).toBeNull();
  });

  it("update with undefined in partial does not overwrite existing value", () => {
    const state = stateWith([
      makeItem("m1", { authority: 0.9, importance: 0.7 }),
    ]);
    const { state: next } = applyCommand(state, {
      type: "memory.update",
      item_id: "m1",
      partial: { importance: undefined },
      author: "test",
    });
    // undefined values are stripped — "I'm not changing this field"
    expect(next.items.get("m1")!.importance).toBe(0.7);
  });

  it("update with empty partial is a no-op (item unchanged)", () => {
    const state = stateWith([makeItem("m1", { authority: 0.9 })]);
    const { state: next, events } = applyCommand(state, {
      type: "memory.update",
      item_id: "m1",
      partial: {},
      author: "test",
    });
    expect(next.items.get("m1")!.authority).toBe(0.9);
    expect(events).toHaveLength(1); // still emits event
  });

  it("update all three scores simultaneously", () => {
    const state = stateWith([makeItem("m1", { authority: 0.5 })]);
    const { state: next } = applyCommand(state, {
      type: "memory.update",
      item_id: "m1",
      partial: { authority: 0.1, conviction: 0.2, importance: 0.3 },
      author: "test",
    });
    expect(next.items.get("m1")!.authority).toBe(0.1);
    expect(next.items.get("m1")!.conviction).toBe(0.2);
    expect(next.items.get("m1")!.importance).toBe(0.3);
  });
});

// ============================================================
// Helpers boundary values
// ============================================================

describe("score validation boundaries", () => {
  it("accepts exactly 0", () => {
    expect(() =>
      createMemoryItem({
        scope: "t",
        kind: "observation",
        content: {},
        author: "t",
        source_kind: "observed",
        authority: 0,
      }),
    ).not.toThrow();
  });

  it("accepts exactly 1", () => {
    expect(() =>
      createMemoryItem({
        scope: "t",
        kind: "observation",
        content: {},
        author: "t",
        source_kind: "observed",
        authority: 1,
      }),
    ).not.toThrow();
  });

  it("rejects just below 0", () => {
    expect(() =>
      createMemoryItem({
        scope: "t",
        kind: "observation",
        content: {},
        author: "t",
        source_kind: "observed",
        authority: -0.00001,
      }),
    ).toThrow(RangeError);
  });

  it("rejects just above 1", () => {
    expect(() =>
      createMemoryItem({
        scope: "t",
        kind: "observation",
        content: {},
        author: "t",
        source_kind: "observed",
        authority: 1.00001,
      }),
    ).toThrow(RangeError);
  });
});

// ============================================================
// Query edge cases
// ============================================================

describe("query edge cases", () => {
  it("resolvePath handles deeply nested paths (4+ levels)", () => {
    const state = stateWith([
      makeItem("m1", { meta: { a: { b: { c: { d: "deep" } } } } as any }),
    ]);
    const result = getItems(state, { meta: { "a.b.c.d": "deep" } });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("m1");
  });

  it("getRelatedItems does not return self for self-edges", () => {
    const state = stateWith(
      [makeItem("m1")],
      [
        {
          edge_id: "e1",
          from: "m1",
          to: "m1",
          kind: "ABOUT",
          author: "test",
          source_kind: "observed",
          authority: 1,
          active: true,
        },
      ],
    );
    const related = getRelatedItems(state, "m1");
    expect(related).toHaveLength(0);
  });

  it("range filter min === max works as exact match", () => {
    const state = stateWith([
      makeItem("m1", { authority: 0.5 }),
      makeItem("m2", { authority: 0.6 }),
    ]);
    const result = getItems(state, {
      range: { authority: { min: 0.5, max: 0.5 } },
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("m1");
  });

  it("getScoredItems min_score at exact threshold includes item", () => {
    const state = stateWith([makeItem("m1", { authority: 0.5 })]);
    const result = getScoredItems(state, { authority: 1 }, { min_score: 0.5 });
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(0.5);
  });
});

// ============================================================
// Integrity edge cases
// ============================================================

describe("integrity edge cases", () => {
  it("getStaleItems with partial staleness (one parent missing, one present)", () => {
    const state = stateWith([
      makeItem("m2"),
      makeItem("m3", { parents: ["m1", "m2"] }), // m1 missing, m2 present
    ]);
    const stale = getStaleItems(state);
    expect(stale).toHaveLength(1);
    expect(stale[0].missing_parents).toEqual(["m1"]);
  });

  it("getStaleItems with multiple missing parents", () => {
    const state = stateWith([
      makeItem("m3", { parents: ["m1", "m2"] }), // both missing
    ]);
    const stale = getStaleItems(state);
    expect(stale[0].missing_parents.sort()).toEqual(["m1", "m2"]);
  });

  it("getAliasGroup handles cycles (A→B→C→A)", () => {
    const state = stateWith([makeItem("m1"), makeItem("m2"), makeItem("m3")]);
    let next = markAlias(state, "m1", "m2", "test").state;
    next = markAlias(next, "m2", "m3", "test").state;
    next = markAlias(next, "m3", "m1", "test").state;
    const group = getAliasGroup(next, "m1");
    expect(group).toHaveLength(3);
    expect(group.map((i) => i.id).sort()).toEqual(["m1", "m2", "m3"]);
  });
});

// ============================================================
// Retrieval edge cases
// ============================================================

describe("retrieval edge cases", () => {
  it("getSupportTree handles cycles in parents", () => {
    // m1 parents [m2], m2 parents [m1] — cycle
    const state = stateWith([
      makeItem("m1", { parents: ["m2"] }),
      makeItem("m2", { parents: ["m1"] }),
    ]);
    const tree = getSupportTree(state, "m1")!;
    expect(tree.item.id).toBe("m1");
    expect(tree.parents).toHaveLength(1);
    expect(tree.parents[0].item.id).toBe("m2");
    // m2's parent is m1, already visited — should have empty parents
    expect(tree.parents[0].parents).toHaveLength(1);
    expect(tree.parents[0].parents[0].parents).toHaveLength(0); // cycle broken
  });

  it("getSupportSet handles cycles without duplicates", () => {
    const state = stateWith([
      makeItem("m1", { parents: ["m2"] }),
      makeItem("m2", { parents: ["m1"] }),
    ]);
    const set = getSupportSet(state, "m1");
    expect(set).toHaveLength(2);
    expect(set.map((i) => i.id).sort()).toEqual(["m1", "m2"]);
  });

  it("getSupportSet with partial chain (middle node missing)", () => {
    const state = stateWith([
      makeItem("m1"),
      // m2 missing
      makeItem("m3", { parents: ["m2"] }),
      makeItem("m4", { parents: ["m3", "m1"] }),
    ]);
    const set = getSupportSet(state, "m4");
    // m2 is missing, so chain through m3 stops at m3
    expect(set.map((i) => i.id).sort()).toEqual(["m1", "m3", "m4"]);
  });

  it("filterContradictions when neither contradicting item is in scored list", () => {
    const state = stateWith([makeItem("m1"), makeItem("m2"), makeItem("m3")]);
    const { state: marked } = markContradiction(state, "m1", "m2", "test");
    // scored list only has m3
    const scored: ScoredItem[] = [
      { item: marked.items.get("m3")!, score: 0.8 },
    ];
    const filtered = filterContradictions(marked, scored);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].item.id).toBe("m3");
  });

  it("applyDiversity with empty scored array", () => {
    const result = applyDiversity([], { author_penalty: 0.5 });
    expect(result).toHaveLength(0);
  });
});

// ============================================================
// Bulk edge cases
// ============================================================

describe("bulk edge cases", () => {
  it("applyMany with empty partial returns no events", () => {
    const state = stateWith([makeItem("m1"), makeItem("m2")]);
    const { state: next, events } = applyMany(state, {}, () => ({}), "test");
    expect(events).toHaveLength(0);
    // state reference should be the same (no changes)
    expect(next).toBe(state);
  });

  it("bulkAdjustScores with only authority delta leaves conviction/importance unchanged", () => {
    const state = stateWith([
      makeItem("m1", { authority: 0.5, conviction: 0.8, importance: 0.6 }),
    ]);
    const { state: next } = bulkAdjustScores(
      state,
      {},
      { authority: 0.1 },
      "test",
    );
    expect(next.items.get("m1")!.authority).toBeCloseTo(0.6);
    expect(next.items.get("m1")!.conviction).toBe(0.8);
    expect(next.items.get("m1")!.importance).toBe(0.6);
  });
});

// ============================================================
// Replay edge cases
// ============================================================

// ============================================================
// Created filter & importance decay
// ============================================================

describe("created filter", () => {
  it("filters items created before a timestamp", () => {
    const old = createMemoryItem({
      scope: "test",
      kind: "observation",
      content: { v: 1 },
      author: "test",
      source_kind: "observed",
      authority: 0.5,
    });
    // items created just now are "after" any past cutoff
    const state = stateWith([old]);
    const cutoff = Date.now() + 1000; // 1s in the future
    const result = getItems(state, { created: { before: cutoff } });
    expect(result).toHaveLength(1);
  });

  it("filters items created after a timestamp", () => {
    const item = createMemoryItem({
      scope: "test",
      kind: "observation",
      content: {},
      author: "test",
      source_kind: "observed",
      authority: 0.5,
    });
    const state = stateWith([item]);
    const past = Date.now() - 10000; // 10s ago
    const result = getItems(state, { created: { after: past } });
    expect(result).toHaveLength(1);
  });

  it("excludes items outside the created range", () => {
    const item = createMemoryItem({
      scope: "test",
      kind: "observation",
      content: {},
      author: "test",
      source_kind: "observed",
      authority: 0.5,
    });
    const state = stateWith([item]);
    const future = Date.now() + 60000;
    const result = getItems(state, { created: { after: future } });
    expect(result).toHaveLength(0);
  });

  it("combines created with other filters", () => {
    const item = createMemoryItem({
      scope: "a",
      kind: "observation",
      content: {},
      author: "test",
      source_kind: "observed",
      authority: 0.5,
    });
    const state = stateWith([item]);
    const past = Date.now() - 10000;
    const result = getItems(state, { scope: "a", created: { after: past } });
    expect(result).toHaveLength(1);

    const result2 = getItems(state, { scope: "b", created: { after: past } });
    expect(result2).toHaveLength(0);
  });
});

describe("decayImportance", () => {
  it("decays importance on old items", () => {
    // create items with real uuidv7 ids (created now)
    const item = createMemoryItem({
      scope: "test",
      kind: "observation",
      content: {},
      author: "test",
      source_kind: "observed",
      authority: 0.5,
      importance: 0.8,
    });
    const state = stateWith([item]);

    // olderThanMs = -1000 means cutoff = now + 1s → everything created before that matches
    const { state: next, events } = decayImportance(
      state,
      -1000,
      0.5,
      "system:decay",
    );
    expect(next.items.get(item.id)!.importance).toBeCloseTo(0.4);
    expect(events).toHaveLength(1);
  });

  it("skips items with zero importance", () => {
    const item = createMemoryItem({
      scope: "test",
      kind: "observation",
      content: {},
      author: "test",
      source_kind: "observed",
      authority: 0.5,
      importance: 0,
    });
    const state = stateWith([item]);
    const { events } = decayImportance(state, 0, 0.5, "system:decay");
    expect(events).toHaveLength(0);
  });

  it("skips items with undefined importance", () => {
    const item = createMemoryItem({
      scope: "test",
      kind: "observation",
      content: {},
      author: "test",
      source_kind: "observed",
      authority: 0.5,
    });
    const state = stateWith([item]);
    const { events } = decayImportance(state, 0, 0.5, "system:decay");
    expect(events).toHaveLength(0);
  });

  it("does not decay recent items", () => {
    const item = createMemoryItem({
      scope: "test",
      kind: "observation",
      content: {},
      author: "test",
      source_kind: "observed",
      authority: 0.5,
      importance: 0.9,
    });
    const state = stateWith([item]);
    // olderThanMs = very large → cutoff is far in the past → nothing matches
    const { state: next, events } = decayImportance(
      state,
      999999999,
      0.5,
      "system:decay",
    );
    expect(events).toHaveLength(0);
    expect(next.items.get(item.id)!.importance).toBe(0.9);
  });
});

// ============================================================
// Decay filter on getItems
// ============================================================

function fakeIdAtAge(daysAgo: number): string {
  const ms = Date.now() - daysAgo * 86400000;
  const hex = ms.toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000000`;
}

describe("decay filter", () => {
  it("excludes items that have decayed below min (exponential)", () => {
    const state = stateWith([
      makeItem(fakeIdAtAge(0), { authority: 0.9 }), // just created — multiplier ~1.0
      makeItem(fakeIdAtAge(1), { authority: 0.9 }), // 1 day old — multiplier 0.5
      makeItem(fakeIdAtAge(3), { authority: 0.9 }), // 3 days old — multiplier 0.125
    ]);
    const result = getItems(state, {
      decay: {
        config: { rate: 0.5, interval: "day", type: "exponential" },
        min: 0.4, // keep items with multiplier >= 0.4
      },
    });
    // 0-day: ~1.0 (pass), 1-day: 0.5 (pass), 3-day: 0.125 (fail)
    expect(result).toHaveLength(2);
  });

  it("excludes all old items with aggressive decay", () => {
    const state = stateWith([
      makeItem(fakeIdAtAge(2), { authority: 0.9 }),
      makeItem(fakeIdAtAge(5), { authority: 0.9 }),
    ]);
    const result = getItems(state, {
      decay: {
        config: { rate: 0.9, interval: "day", type: "exponential" },
        min: 0.5,
      },
    });
    // 2 days at 90%/day: (0.1)^2 = 0.01, 5 days: (0.1)^5 = 0.00001
    expect(result).toHaveLength(0);
  });

  it("keeps all recent items with gentle decay", () => {
    const state = stateWith([
      makeItem(fakeIdAtAge(0), { authority: 0.5 }),
      makeItem(fakeIdAtAge(0.5), { authority: 0.5 }),
    ]);
    const result = getItems(state, {
      decay: {
        config: { rate: 0.1, interval: "day", type: "exponential" },
        min: 0.5,
      },
    });
    // < 1 day at 10%/day → multiplier > 0.9 for both
    expect(result).toHaveLength(2);
  });

  it("linear decay excludes items past zero point", () => {
    const state = stateWith([
      makeItem(fakeIdAtAge(0), { authority: 0.9 }),
      makeItem(fakeIdAtAge(2), { authority: 0.9 }),
      makeItem(fakeIdAtAge(5), { authority: 0.9 }),
    ]);
    const result = getItems(state, {
      decay: {
        config: { rate: 0.3, interval: "day", type: "linear" },
        min: 0.1,
      },
    });
    // 0-day: 1.0, 2-day: 0.4, 5-day: max(0, 1-1.5) = 0
    expect(result).toHaveLength(2);
  });

  it("step decay drops at interval boundaries", () => {
    const state = stateWith([
      makeItem(fakeIdAtAge(0.5), { authority: 0.9 }), // floor(0.5) = 0 intervals
      makeItem(fakeIdAtAge(1.5), { authority: 0.9 }), // floor(1.5) = 1 interval
      makeItem(fakeIdAtAge(2.5), { authority: 0.9 }), // floor(2.5) = 2 intervals
    ]);
    const result = getItems(state, {
      decay: {
        config: { rate: 0.5, interval: "day", type: "step" },
        min: 0.3,
      },
    });
    // 0 intervals: 1.0, 1 interval: 0.5, 2 intervals: 0.25
    // min 0.3 → keeps first two, excludes third
    expect(result).toHaveLength(2);
  });

  it("combines decay filter with other filters", () => {
    const recent1 = createMemoryItem({
      scope: "a",
      kind: "observation",
      content: {},
      author: "test",
      source_kind: "observed",
      authority: 0.9,
    });
    const old = makeItem(fakeIdAtAge(5), { authority: 0.9, scope: "a" });
    const recent2 = createMemoryItem({
      scope: "b",
      kind: "observation",
      content: {},
      author: "test",
      source_kind: "observed",
      authority: 0.9,
    });
    const state = stateWith([recent1, old, recent2]);
    const result = getItems(state, {
      scope: "a",
      decay: {
        config: { rate: 0.5, interval: "day", type: "exponential" },
        min: 0.1,
      },
    });
    // scope "a": recent1 (pass) + old (0.5^5 = 0.03, fail)
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(recent1.id);
  });

  it("decay filter works with hourly interval", () => {
    const hourId = (hoursAgo: number): string => {
      const ms = Date.now() - hoursAgo * 3600000;
      const hex = ms.toString(16).padStart(12, "0");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000000`;
    };
    const state = stateWith([
      makeItem(hourId(1), { authority: 0.9 }),
      makeItem(hourId(10), { authority: 0.9 }),
    ]);
    const result = getItems(state, {
      decay: {
        config: { rate: 0.2, interval: "hour", type: "exponential" },
        min: 0.5,
      },
    });
    // 1hr: (0.8)^1 = 0.8 (pass), 10hr: (0.8)^10 = 0.107 (fail)
    expect(result).toHaveLength(1);
  });
});

describe("replay edge cases", () => {
  it("replayFromEnvelopes with duplicate timestamps maintains stable order", () => {
    const item1 = makeItem("m1");
    const item2 = makeItem("m2");
    const envelopes = [
      {
        id: "ev1",
        namespace: "memory",
        type: "memory.create",
        ts: "2026-01-01T00:00:00.000Z",
        payload: { type: "memory.create", item: item1 },
      },
      {
        id: "ev2",
        namespace: "memory",
        type: "memory.create",
        ts: "2026-01-01T00:00:00.000Z",
        payload: { type: "memory.create", item: item2 },
      },
    ];
    const { state } = replayFromEnvelopes(envelopes);
    expect(state.items.size).toBe(2);
    expect(state.items.has("m1")).toBe(true);
    expect(state.items.has("m2")).toBe(true);
  });
});
