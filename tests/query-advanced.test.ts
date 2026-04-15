import { describe, it, expect } from "vitest";
import { getItems } from "../src/query.js";
import { createGraphState } from "../src/graph.js";
import type { MemoryItem, GraphState } from "../src/types.js";

const makeItem = (
  id: string,
  overrides: Partial<MemoryItem> = {},
): MemoryItem => ({
  id,
  scope: "project:cyberdeck",
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

// ============================================================
// ids filter
// ============================================================

describe("ids filter", () => {
  const state = stateWith([
    makeItem("m1"),
    makeItem("m2"),
    makeItem("m3"),
    makeItem("m4"),
  ]);

  it("returns only items with matching ids", () => {
    const result = getItems(state, { ids: ["m1", "m3"] });
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.id).sort()).toEqual(["m1", "m3"]);
  });

  it("ignores ids that don't exist", () => {
    const result = getItems(state, { ids: ["m1", "nonexistent"] });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("m1");
  });

  it("empty ids array returns nothing", () => {
    const result = getItems(state, { ids: [] });
    expect(result).toHaveLength(0);
  });

  it("combines ids with other filters", () => {
    const state2 = stateWith([
      makeItem("m1", { authority: 0.9 }),
      makeItem("m2", { authority: 0.3 }),
      makeItem("m3", { authority: 0.8 }),
    ]);
    const result = getItems(state2, {
      ids: ["m1", "m2", "m3"],
      range: { authority: { min: 0.5 } },
    });
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.id).sort()).toEqual(["m1", "m3"]);
  });
});

// ============================================================
// scope_prefix filter
// ============================================================

describe("scope_prefix filter", () => {
  const state = stateWith([
    makeItem("m1", { scope: "project:cyberdeck" }),
    makeItem("m2", { scope: "project:memex" }),
    makeItem("m3", { scope: "user:laz/general" }),
    makeItem("m4", { scope: "user:laz/settings" }),
  ]);

  it("matches scopes starting with prefix", () => {
    const result = getItems(state, { scope_prefix: "project:" });
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.id).sort()).toEqual(["m1", "m2"]);
  });

  it("matches user scopes", () => {
    const result = getItems(state, { scope_prefix: "user:laz/" });
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.id).sort()).toEqual(["m3", "m4"]);
  });

  it("no match returns empty", () => {
    const result = getItems(state, { scope_prefix: "system:" });
    expect(result).toHaveLength(0);
  });

  it("combines with other filters", () => {
    const result = getItems(state, {
      scope_prefix: "project:",
      not: { scope: "project:memex" },
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("m1");
  });
});

// ============================================================
// parents (advanced)
// ============================================================

describe("parents filter (advanced)", () => {
  const state = stateWith([
    makeItem("m1"),
    makeItem("m2"),
    makeItem("m3", { parents: ["m1"] }),
    makeItem("m4", { parents: ["m1", "m2"] }),
    makeItem("m5", { parents: ["m2"] }),
  ]);

  it("includes: matches single parent", () => {
    const result = getItems(state, { parents: { includes: "m1" } });
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.id).sort()).toEqual(["m3", "m4"]);
  });

  it("includes_any: matches any of the listed parents", () => {
    const result = getItems(state, {
      parents: { includes_any: ["m1", "m2"] },
    });
    expect(result).toHaveLength(3);
    expect(result.map((i) => i.id).sort()).toEqual(["m3", "m4", "m5"]);
  });

  it("includes_all: requires all listed parents", () => {
    const result = getItems(state, {
      parents: { includes_all: ["m1", "m2"] },
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("m4");
  });

  it("count min: items with at least N parents", () => {
    const result = getItems(state, { parents: { count: { min: 2 } } });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("m4");
  });

  it("count max: items with at most N parents", () => {
    const result = getItems(state, { parents: { count: { max: 0 } } });
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.id).sort()).toEqual(["m1", "m2"]);
  });

  it("count range: items with 1 parent", () => {
    const result = getItems(state, {
      parents: { count: { min: 1, max: 1 } },
    });
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.id).sort()).toEqual(["m3", "m5"]);
  });

  it("combines includes with count", () => {
    const result = getItems(state, {
      parents: { includes: "m1", count: { min: 2 } },
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("m4");
  });

  it("has_parent sugar still works", () => {
    const result = getItems(state, { has_parent: "m2" });
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.id).sort()).toEqual(["m4", "m5"]);
  });

  it("is_root sugar still works", () => {
    const result = getItems(state, { is_root: true });
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.id).sort()).toEqual(["m1", "m2"]);
  });
});

// ============================================================
// multi-sort
// ============================================================

describe("multi-sort", () => {
  const now = Date.now();
  const state = stateWith([
    makeItem("m1", { authority: 0.5, importance: 0.9, created_at: now - 30 }),
    makeItem("m2", { authority: 0.5, importance: 0.3, created_at: now - 20 }),
    makeItem("m3", { authority: 0.9, importance: 0.1, created_at: now - 10 }),
    makeItem("m4", { authority: 0.5, importance: 0.6, created_at: now }),
  ]);

  it("single sort still works (backwards compat)", () => {
    const result = getItems(
      state,
      {},
      { sort: { field: "authority", order: "desc" } },
    );
    expect(result[0].id).toBe("m3");
  });

  it("multi-sort: primary authority desc, secondary importance desc", () => {
    const result = getItems(
      state,
      {},
      {
        sort: [
          { field: "authority", order: "desc" },
          { field: "importance", order: "desc" },
        ],
      },
    );
    // m3 (authority 0.9) first
    // then m1, m4, m2 (all authority 0.5, sorted by importance desc: 0.9, 0.6, 0.3)
    expect(result.map((i) => i.id)).toEqual(["m3", "m1", "m4", "m2"]);
  });

  it("multi-sort: primary importance asc, secondary authority desc", () => {
    const result = getItems(
      state,
      {},
      {
        sort: [
          { field: "importance", order: "asc" },
          { field: "authority", order: "desc" },
        ],
      },
    );
    // importance asc: m3(0.1), m2(0.3), m4(0.6), m1(0.9)
    expect(result.map((i) => i.id)).toEqual(["m3", "m2", "m4", "m1"]);
  });

  it("multi-sort with recency as tiebreaker", () => {
    // items with same authority, recency breaks the tie
    const result = getItems(
      state,
      {},
      {
        sort: [
          { field: "authority", order: "desc" },
          { field: "recency", order: "desc" },
        ],
      },
    );
    // m3 first (highest authority), then m1/m4/m2 by recency (creation order)
    expect(result[0].id).toBe("m3");
  });
});
