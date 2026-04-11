import { describe, it, expect } from "vitest";
import { createGraphState, cloneGraphState } from "../src/graph.js";
import type { MemoryItem } from "../src/types.js";

describe("createGraphState", () => {
  it("returns empty Maps", () => {
    const state = createGraphState();
    expect(state.items).toBeInstanceOf(Map);
    expect(state.edges).toBeInstanceOf(Map);
    expect(state.items.size).toBe(0);
    expect(state.edges.size).toBe(0);
  });
});

describe("cloneGraphState", () => {
  it("returns a new object with new Map references", () => {
    const original = createGraphState();
    const cloned = cloneGraphState(original);
    expect(cloned).not.toBe(original);
    expect(cloned.items).not.toBe(original.items);
    expect(cloned.edges).not.toBe(original.edges);
  });

  it("mutation of clone does not affect original", () => {
    const original = createGraphState();
    const item: MemoryItem = {
      id: "m1",
      scope: "test",
      kind: "observation",
      content: {},
      author: "test",
      source_kind: "observed",
      authority: 1,
    };
    original.items.set("m1", item);
    const cloned = cloneGraphState(original);
    cloned.items.delete("m1");
    expect(original.items.has("m1")).toBe(true);
    expect(cloned.items.has("m1")).toBe(false);
  });
});
