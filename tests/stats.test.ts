import { describe, it, expect } from "vitest";
import { getStats } from "../src/stats.js";
import { createGraphState } from "../src/graph.js";
import type { MemoryItem, Edge, GraphState } from "../src/types.js";

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

function buildState(): GraphState {
  const state: GraphState = { items: new Map(), edges: new Map() };
  const items: MemoryItem[] = [
    makeItem("m1", {
      kind: "observation",
      source_kind: "observed",
      author: "agent:a",
      scope: "project:x",
    }),
    makeItem("m2", {
      kind: "observation",
      source_kind: "observed",
      author: "agent:a",
      scope: "project:x",
    }),
    makeItem("m3", {
      kind: "assertion",
      source_kind: "user_explicit",
      author: "user:laz",
      scope: "project:x",
    }),
    makeItem("m4", {
      kind: "hypothesis",
      source_kind: "agent_inferred",
      author: "agent:b",
      scope: "project:y",
      parents: ["m1"],
    }),
    makeItem("m5", {
      kind: "derivation",
      source_kind: "derived_deterministic",
      author: "system:rule",
      scope: "project:y",
      parents: ["m2", "m3"],
    }),
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
      kind: "CONTRADICTS",
      author: "system:detector",
      source_kind: "derived_deterministic",
      authority: 1,
      active: true,
    },
    {
      edge_id: "e3",
      from: "m1",
      to: "m3",
      kind: "ABOUT",
      author: "agent:a",
      source_kind: "agent_inferred",
      authority: 0.5,
      active: false,
    },
  ];
  for (const i of items) state.items.set(i.id, i);
  for (const e of edges) state.edges.set(e.edge_id, e);
  return state;
}

describe("getStats", () => {
  it("returns correct item totals", () => {
    const stats = getStats(buildState());
    expect(stats.items.total).toBe(5);
    expect(stats.items.root).toBe(3);
    expect(stats.items.with_parents).toBe(2);
  });

  it("counts items by kind", () => {
    const stats = getStats(buildState());
    expect(stats.items.by_kind).toEqual({
      observation: 2,
      assertion: 1,
      hypothesis: 1,
      derivation: 1,
    });
  });

  it("counts items by source_kind", () => {
    const stats = getStats(buildState());
    expect(stats.items.by_source_kind).toEqual({
      observed: 2,
      user_explicit: 1,
      agent_inferred: 1,
      derived_deterministic: 1,
    });
  });

  it("counts items by author", () => {
    const stats = getStats(buildState());
    expect(stats.items.by_author).toEqual({
      "agent:a": 2,
      "user:laz": 1,
      "agent:b": 1,
      "system:rule": 1,
    });
  });

  it("counts items by scope", () => {
    const stats = getStats(buildState());
    expect(stats.items.by_scope).toEqual({
      "project:x": 3,
      "project:y": 2,
    });
  });

  it("returns correct edge totals", () => {
    const stats = getStats(buildState());
    expect(stats.edges.total).toBe(3);
    expect(stats.edges.active).toBe(2);
  });

  it("counts edges by kind", () => {
    const stats = getStats(buildState());
    expect(stats.edges.by_kind).toEqual({
      SUPPORTS: 1,
      CONTRADICTS: 1,
      ABOUT: 1,
    });
  });

  it("handles empty state", () => {
    const stats = getStats(createGraphState());
    expect(stats.items.total).toBe(0);
    expect(stats.items.root).toBe(0);
    expect(stats.items.with_parents).toBe(0);
    expect(stats.items.by_kind).toEqual({});
    expect(stats.edges.total).toBe(0);
    expect(stats.edges.active).toBe(0);
  });
});
