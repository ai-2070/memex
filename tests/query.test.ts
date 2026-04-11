import { describe, it, expect } from "vitest";
import {
  getItems,
  getEdges,
  getItemById,
  getEdgeById,
  getRelatedItems,
  getParents,
  getChildren,
  getScoredItems,
} from "../src/query.js";
import type { MemoryItem, Edge, GraphState } from "../src/types.js";

// -- test fixtures --

const items: MemoryItem[] = [
  {
    id: "m1",
    scope: "user:laz/general",
    kind: "assertion",
    content: { key: "theme", value: "dark" },
    author: "user:laz",
    source_kind: "user_explicit",
    authority: 0.95,
    importance: 0.8,
    conviction: 0.9,
    meta: { agent_id: "agent:x", tags: { primary: "preference", env: "prod" } },
  },
  {
    id: "m2",
    scope: "user:laz/general",
    kind: "observation",
    content: { key: "login_count", value: 42 },
    author: "agent:reasoner",
    source_kind: "observed",
    authority: 0.7,
    importance: 0.5,
    conviction: 0.6,
    meta: { agent_id: "agent:y", tags: { primary: "metric", env: "prod" } },
  },
  {
    id: "m3",
    scope: "project:cyberdeck",
    kind: "derivation",
    content: { key: "active_user", value: true },
    author: "system:rule",
    source_kind: "derived_deterministic",
    parents: ["m1", "m2"],
    authority: 0.6,
  },
  {
    id: "m4",
    scope: "user:laz/general",
    kind: "hypothesis",
    content: { key: "will_churn", value: false },
    author: "agent:reasoner",
    source_kind: "agent_inferred",
    parents: ["m2"],
    authority: 0.3,
    importance: 0.9,
    conviction: 0.4,
    meta: {
      agent_id: "agent:x",
      tags: { primary: "prediction", env: "staging" },
    },
  },
  {
    id: "m5",
    scope: "project:cyberdeck",
    kind: "simulation",
    content: { key: "scenario", value: "outage" },
    author: "agent:reasoner",
    source_kind: "simulated",
    authority: 0.2,
    importance: 0.4,
  },
];

const edges: Edge[] = [
  {
    edge_id: "e1",
    from: "m1",
    to: "m2",
    kind: "SUPPORTS",
    author: "system:rule",
    source_kind: "derived_deterministic",
    authority: 0.8,
    active: true,
  },
  {
    edge_id: "e2",
    from: "m3",
    to: "m4",
    kind: "DERIVED_FROM",
    author: "system:rule",
    source_kind: "derived_deterministic",
    authority: 0.9,
    active: true,
    weight: 0.7,
  },
  {
    edge_id: "e3",
    from: "m2",
    to: "m3",
    kind: "ABOUT",
    author: "agent:reasoner",
    source_kind: "agent_inferred",
    authority: 0.5,
    active: false,
  },
];

function buildState(): GraphState {
  const state: GraphState = { items: new Map(), edges: new Map() };
  for (const i of items) state.items.set(i.id, i);
  for (const e of edges) state.edges.set(e.edge_id, e);
  return state;
}

// -- getItems basic filters --

describe("getItems", () => {
  const state = buildState();

  it("returns all items with no filter", () => {
    expect(getItems(state)).toHaveLength(5);
  });

  it("filters by scope", () => {
    const result = getItems(state, { scope: "project:cyberdeck" });
    expect(result).toHaveLength(2);
    expect(result.every((i) => i.scope === "project:cyberdeck")).toBe(true);
  });

  it("filters by kind", () => {
    const result = getItems(state, { kind: "observation" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("m2");
  });

  it("filters by source_kind", () => {
    const result = getItems(state, { source_kind: "observed" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("m2");
  });

  it("filters by author", () => {
    const result = getItems(state, { author: "agent:reasoner" });
    expect(result).toHaveLength(3);
  });

  it("excludes items matching not filter", () => {
    const result = getItems(state, {
      not: { or: [{ kind: "hypothesis" }, { kind: "simulation" }] },
    });
    expect(result).toHaveLength(3);
    expect(
      result.every((i) => i.kind !== "hypothesis" && i.kind !== "simulation"),
    ).toBe(true);
  });

  it("excludes by single kind with not", () => {
    const result = getItems(state, { not: { kind: "simulation" } });
    expect(result).toHaveLength(4);
    expect(result.every((i) => i.kind !== "simulation")).toBe(true);
  });

  it("excludes by non-kind fields with not", () => {
    const result = getItems(state, { not: { author: "agent:reasoner" } });
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.id).sort()).toEqual(["m1", "m3"]);
  });

  it("combines not with other filters", () => {
    const result = getItems(state, {
      scope: "user:laz/general",
      not: { range: { authority: { max: 0.5 } } },
    });
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.id).sort()).toEqual(["m1", "m2"]);
  });

  it("filters by meta", () => {
    const result = getItems(state, { meta: { agent_id: "agent:x" } });
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.id).sort()).toEqual(["m1", "m4"]);
  });

  it("combines filters with AND logic", () => {
    const result = getItems(state, {
      scope: "user:laz/general",
      range: { authority: { min: 0.5 } },
    });
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.id).sort()).toEqual(["m1", "m2"]);
  });

  // -- range filters --

  it("filters by authority min", () => {
    const result = getItems(state, { range: { authority: { min: 0.6 } } });
    expect(result).toHaveLength(3);
    expect(result.every((i) => i.authority >= 0.6)).toBe(true);
  });

  it("filters by authority max", () => {
    const result = getItems(state, { range: { authority: { max: 0.3 } } });
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.id).sort()).toEqual(["m4", "m5"]);
  });

  it("filters by authority range (min + max)", () => {
    const result = getItems(state, {
      range: { authority: { min: 0.3, max: 0.7 } },
    });
    expect(result).toHaveLength(3);
    expect(result.map((i) => i.id).sort()).toEqual(["m2", "m3", "m4"]);
  });

  it("filters by importance min (excludes undefined)", () => {
    const result = getItems(state, { range: { importance: { min: 0.7 } } });
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.id).sort()).toEqual(["m1", "m4"]);
  });

  it("filters by conviction range", () => {
    const result = getItems(state, {
      range: { conviction: { min: 0.5, max: 0.8 } },
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("m2");
  });

  it("filters by multiple ranges simultaneously", () => {
    const result = getItems(state, {
      range: { authority: { min: 0.5 }, importance: { min: 0.5 } },
    });
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.id).sort()).toEqual(["m1", "m2"]);
  });

  // -- nested meta (dot-path) --

  it("filters by nested meta with dot-path", () => {
    const result = getItems(state, { meta: { "tags.primary": "preference" } });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("m1");
  });

  it("filters by multiple nested meta paths", () => {
    const result = getItems(state, {
      meta: { "tags.env": "prod", agent_id: "agent:x" },
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("m1");
  });

  it("returns empty when nested meta path does not exist", () => {
    const result = getItems(state, { meta: { "tags.nonexistent": "foo" } });
    expect(result).toHaveLength(0);
  });

  it("handles items with no meta gracefully for nested paths", () => {
    const result = getItems(state, { meta: { "tags.primary": "metric" } });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("m2");
  });

  // -- meta_has (existence) --

  it("filters by meta_has — field must exist", () => {
    const result = getItems(state, { meta_has: ["tags"] });
    expect(result).toHaveLength(3); // m1, m2, m4 have tags
    expect(result.map((i) => i.id).sort()).toEqual(["m1", "m2", "m4"]);
  });

  it("filters by meta_has with dot-path", () => {
    const result = getItems(state, { meta_has: ["tags.primary"] });
    expect(result).toHaveLength(3);
  });

  it("meta_has excludes items without meta", () => {
    const result = getItems(state, { meta_has: ["agent_id"] });
    expect(result).toHaveLength(3); // m3 and m5 have no meta
  });

  it("meta_has with multiple paths requires all", () => {
    const result = getItems(state, { meta_has: ["agent_id", "tags.env"] });
    expect(result).toHaveLength(3);
    expect(result.map((i) => i.id).sort()).toEqual(["m1", "m2", "m4"]);
  });

  it("meta_has returns empty when path does not exist on any item", () => {
    const result = getItems(state, { meta_has: ["nonexistent.deep.path"] });
    expect(result).toHaveLength(0);
  });

  it("combines meta_has with not for 'field exists but not this value'", () => {
    const result = getItems(state, {
      meta_has: ["agent_id"],
      not: { meta: { agent_id: "agent:x" } },
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("m2");
  });

  // -- OR queries --

  it("matches any sub-filter in or array", () => {
    const result = getItems(state, {
      or: [{ kind: "observation" }, { kind: "assertion" }],
    });
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.id).sort()).toEqual(["m1", "m2"]);
  });

  it("AND-combines top-level fields with or", () => {
    const result = getItems(state, {
      scope: "user:laz/general",
      or: [{ kind: "observation" }, { kind: "hypothesis" }],
    });
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.id).sort()).toEqual(["m2", "m4"]);
  });

  it("or with no matches returns empty", () => {
    const result = getItems(state, {
      or: [{ kind: "policy" }, { kind: "trait" }],
    });
    expect(result).toHaveLength(0);
  });

  it("nested or filters work recursively", () => {
    const result = getItems(state, {
      or: [
        { kind: "simulation" },
        { kind: "derivation", scope: "project:cyberdeck" },
      ],
    });
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.id).sort()).toEqual(["m3", "m5"]);
  });

  it("or combined with meta dot-path", () => {
    const result = getItems(state, {
      or: [
        { meta: { "tags.primary": "preference" } },
        { meta: { "tags.primary": "prediction" } },
      ],
    });
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.id).sort()).toEqual(["m1", "m4"]);
  });

  it("empty or array matches all (no or constraint)", () => {
    const result = getItems(state, { or: [] });
    expect(result).toHaveLength(5);
  });
});

// -- sorting & pagination --

describe("getItems with QueryOptions", () => {
  const state = buildState();

  it("sorts by authority ascending", () => {
    const result = getItems(
      state,
      {},
      { sort: { field: "authority", order: "asc" } },
    );
    const authorities = result.map((i) => i.authority);
    expect(authorities).toEqual([...authorities].sort((a, b) => a - b));
  });

  it("sorts by authority descending", () => {
    const result = getItems(
      state,
      {},
      { sort: { field: "authority", order: "desc" } },
    );
    const authorities = result.map((i) => i.authority);
    expect(authorities).toEqual([...authorities].sort((a, b) => b - a));
  });

  it("sorts by importance descending (undefined treated as 0)", () => {
    const result = getItems(
      state,
      {},
      { sort: { field: "importance", order: "desc" } },
    );
    expect(result[0].id).toBe("m4"); // importance 0.9
    expect(result[1].id).toBe("m1"); // importance 0.8
  });

  it("sorts by conviction ascending", () => {
    const result = getItems(
      state,
      {},
      { sort: { field: "conviction", order: "asc" } },
    );
    const convictions = result.map((i) => i.conviction ?? 0);
    expect(convictions).toEqual([...convictions].sort((a, b) => a - b));
  });

  it("limits results", () => {
    const result = getItems(
      state,
      {},
      { sort: { field: "authority", order: "desc" }, limit: 2 },
    );
    expect(result).toHaveLength(2);
    expect(result[0].authority).toBe(0.95);
    expect(result[1].authority).toBe(0.7);
  });

  it("offsets results", () => {
    const result = getItems(
      state,
      {},
      { sort: { field: "authority", order: "desc" }, offset: 3 },
    );
    expect(result).toHaveLength(2);
  });

  it("combines offset and limit", () => {
    const result = getItems(
      state,
      {},
      { sort: { field: "authority", order: "desc" }, offset: 1, limit: 2 },
    );
    expect(result).toHaveLength(2);
    expect(result[0].authority).toBe(0.7);
    expect(result[1].authority).toBe(0.6);
  });

  it("combines filter with sort and limit", () => {
    const result = getItems(
      state,
      { scope: "user:laz/general" },
      { sort: { field: "authority", order: "desc" }, limit: 2 },
    );
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("m1");
    expect(result[1].id).toBe("m2");
  });
});

// -- getEdges --

describe("getEdges", () => {
  const state = buildState();

  it("returns only active edges by default", () => {
    const result = getEdges(state);
    expect(result).toHaveLength(2);
    expect(result.every((e) => e.active)).toBe(true);
  });

  it("returns all edges with active_only: false", () => {
    const result = getEdges(state, { active_only: false });
    expect(result).toHaveLength(3);
  });

  it("filters by from", () => {
    const result = getEdges(state, { from: "m1" });
    expect(result).toHaveLength(1);
    expect(result[0].edge_id).toBe("e1");
  });

  it("filters by kind", () => {
    const result = getEdges(state, { kind: "DERIVED_FROM" });
    expect(result).toHaveLength(1);
    expect(result[0].edge_id).toBe("e2");
  });

  it("filters by min_weight", () => {
    const result = getEdges(state, { min_weight: 0.5 });
    expect(result).toHaveLength(1);
    expect(result[0].edge_id).toBe("e2");
  });
});

// -- getItemById / getEdgeById --

describe("getItemById", () => {
  const state = buildState();

  it("returns the item", () => {
    expect(getItemById(state, "m1")?.id).toBe("m1");
  });

  it("returns undefined for non-existent id", () => {
    expect(getItemById(state, "nope")).toBeUndefined();
  });
});

describe("getEdgeById", () => {
  const state = buildState();

  it("returns the edge", () => {
    expect(getEdgeById(state, "e1")?.edge_id).toBe("e1");
  });

  it("returns undefined for non-existent id", () => {
    expect(getEdgeById(state, "nope")).toBeUndefined();
  });
});

// -- getRelatedItems --

describe("getRelatedItems", () => {
  const state = buildState();

  it("returns items connected in both directions", () => {
    const result = getRelatedItems(state, "m2");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("m1");
  });

  it("returns items in 'from' direction only", () => {
    const result = getRelatedItems(state, "m1", "from");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("m2");
  });

  it("returns items in 'to' direction only", () => {
    const result = getRelatedItems(state, "m2", "to");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("m1");
  });

  it("returns empty for unconnected item", () => {
    expect(getRelatedItems(state, "m5")).toHaveLength(0);
  });
});

// -- parents & children --

describe("parents and children", () => {
  const state = buildState();

  it("getParents returns parent items", () => {
    const result = getParents(state, "m3");
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.id).sort()).toEqual(["m1", "m2"]);
  });

  it("getParents returns single parent", () => {
    const result = getParents(state, "m4");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("m2");
  });

  it("getParents returns empty for root items", () => {
    expect(getParents(state, "m1")).toHaveLength(0);
    expect(getParents(state, "m2")).toHaveLength(0);
  });

  it("getParents returns empty for non-existent item", () => {
    expect(getParents(state, "nope")).toHaveLength(0);
  });

  it("getChildren returns items derived from a parent", () => {
    const result = getChildren(state, "m2");
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.id).sort()).toEqual(["m3", "m4"]);
  });

  it("getChildren returns single child", () => {
    const result = getChildren(state, "m1");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("m3");
  });

  it("getChildren returns empty for leaf items", () => {
    expect(getChildren(state, "m5")).toHaveLength(0);
  });
});

// -- filter by parents --

describe("getItems parent filters", () => {
  const state = buildState();

  it("has_parent filters items with a specific parent", () => {
    const result = getItems(state, { has_parent: "m2" });
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.id).sort()).toEqual(["m3", "m4"]);
  });

  it("has_parent returns empty when no items have that parent", () => {
    const result = getItems(state, { has_parent: "m5" });
    expect(result).toHaveLength(0);
  });

  it("is_root: true returns items without parents", () => {
    const result = getItems(state, { is_root: true });
    expect(result).toHaveLength(3);
    expect(result.map((i) => i.id).sort()).toEqual(["m1", "m2", "m5"]);
  });

  it("is_root: false returns items with parents", () => {
    const result = getItems(state, { is_root: false });
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.id).sort()).toEqual(["m3", "m4"]);
  });

  it("combines has_parent with other filters", () => {
    const result = getItems(state, { has_parent: "m2", kind: "hypothesis" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("m4");
  });

  it("not with has_parent excludes items derived from a specific parent", () => {
    const result = getItems(state, {
      is_root: false,
      not: { has_parent: "m1" },
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("m4");
  });
});
