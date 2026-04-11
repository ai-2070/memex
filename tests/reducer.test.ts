import { describe, it, expect } from "vitest";
import { applyCommand } from "../src/reducer.js";
import { createGraphState } from "../src/graph.js";
import {
  DuplicateMemoryError,
  MemoryNotFoundError,
  DuplicateEdgeError,
  EdgeNotFoundError,
} from "../src/errors.js";
import type { MemoryItem, Edge, GraphState } from "../src/types.js";

const makeItem = (overrides: Partial<MemoryItem> = {}): MemoryItem => ({
  id: "m1",
  scope: "test",
  kind: "observation",
  content: { key: "value", nested: 1 },
  author: "user:laz",
  source_kind: "observed",
  authority: 0.9,
  ...overrides,
});

const makeEdge = (overrides: Partial<Edge> = {}): Edge => ({
  edge_id: "e1",
  from: "m1",
  to: "m2",
  kind: "SUPPORTS",
  author: "system:rule",
  source_kind: "derived_deterministic",
  authority: 0.8,
  active: true,
  ...overrides,
});

function stateWith(items: MemoryItem[] = [], edges: Edge[] = []): GraphState {
  const s = createGraphState();
  for (const i of items) s.items.set(i.id, i);
  for (const e of edges) s.edges.set(e.edge_id, e);
  return s;
}

describe("memory.create", () => {
  it("creates an item in empty state", () => {
    const item = makeItem();
    const { state, events } = applyCommand(createGraphState(), {
      type: "memory.create",
      item,
    });
    expect(state.items.get("m1")).toEqual(item);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      namespace: "memory",
      type: "memory.created",
      item,
      cause_type: "memory.create",
    });
  });

  it("returns a new state object", () => {
    const original = createGraphState();
    const { state } = applyCommand(original, {
      type: "memory.create",
      item: makeItem(),
    });
    expect(state).not.toBe(original);
  });

  it("does not mutate original state", () => {
    const original = createGraphState();
    applyCommand(original, { type: "memory.create", item: makeItem() });
    expect(original.items.size).toBe(0);
  });

  it("throws DuplicateMemoryError on duplicate id", () => {
    const state = stateWith([makeItem()]);
    expect(() =>
      applyCommand(state, { type: "memory.create", item: makeItem() }),
    ).toThrow(DuplicateMemoryError);
  });
});

describe("memory.update", () => {
  it("updates authority on an existing item", () => {
    const state = stateWith([makeItem()]);
    const { state: next, events } = applyCommand(state, {
      type: "memory.update",
      item_id: "m1",
      partial: { authority: 0.5 },
      author: "system:tuner",
    });
    expect(next.items.get("m1")!.authority).toBe(0.5);
    expect(events[0].type).toBe("memory.updated");
  });

  it("shallow-merges content", () => {
    const state = stateWith([makeItem()]);
    const { state: next } = applyCommand(state, {
      type: "memory.update",
      item_id: "m1",
      partial: { content: { newKey: "added" } },
      author: "test",
    });
    expect(next.items.get("m1")!.content).toEqual({
      key: "value",
      nested: 1,
      newKey: "added",
    });
  });

  it("overwrites existing content keys", () => {
    const state = stateWith([makeItem()]);
    const { state: next } = applyCommand(state, {
      type: "memory.update",
      item_id: "m1",
      partial: { content: { key: "updated" } },
      author: "test",
    });
    expect(next.items.get("m1")!.content.key).toBe("updated");
    expect(next.items.get("m1")!.content.nested).toBe(1);
  });

  it("ignores id in partial (cannot change item id)", () => {
    const state = stateWith([makeItem()]);
    const { state: next } = applyCommand(state, {
      type: "memory.update",
      item_id: "m1",
      partial: { id: "sneaky-new-id" } as any,
      author: "test",
    });
    expect(next.items.get("m1")!.id).toBe("m1");
    expect(next.items.has("sneaky-new-id")).toBe(false);
  });

  it("shallow-merges meta without losing existing fields", () => {
    const state = stateWith([
      makeItem({ meta: { agent_id: "agent:x", session_id: "s1" } }),
    ]);
    const { state: next } = applyCommand(state, {
      type: "memory.update",
      item_id: "m1",
      partial: { meta: { tagged: true } },
      author: "test",
    });
    const meta = next.items.get("m1")!.meta!;
    expect(meta.tagged).toBe(true);
    expect(meta.agent_id).toBe("agent:x");
    expect(meta.session_id).toBe("s1");
  });

  it("throws MemoryNotFoundError for non-existent item_id", () => {
    expect(() =>
      applyCommand(createGraphState(), {
        type: "memory.update",
        item_id: "nope",
        partial: { authority: 0.1 },
        author: "test",
      }),
    ).toThrow(MemoryNotFoundError);
  });

  it("emits memory.updated with fully merged item", () => {
    const state = stateWith([makeItem()]);
    const { events } = applyCommand(state, {
      type: "memory.update",
      item_id: "m1",
      partial: { authority: 0.3, importance: 0.7 },
      author: "test",
    });
    expect(events[0].item!.authority).toBe(0.3);
    expect(events[0].item!.importance).toBe(0.7);
  });

  it("does not mutate original state", () => {
    const state = stateWith([makeItem()]);
    applyCommand(state, {
      type: "memory.update",
      item_id: "m1",
      partial: { authority: 0.1 },
      author: "test",
    });
    expect(state.items.get("m1")!.authority).toBe(0.9);
  });
});

describe("memory.retract", () => {
  it("removes item from state", () => {
    const state = stateWith([makeItem()]);
    const { state: next, events } = applyCommand(state, {
      type: "memory.retract",
      item_id: "m1",
      author: "user:laz",
    });
    expect(next.items.has("m1")).toBe(false);
    expect(events[0].type).toBe("memory.retracted");
  });

  it("throws MemoryNotFoundError for non-existent item_id", () => {
    expect(() =>
      applyCommand(createGraphState(), {
        type: "memory.retract",
        item_id: "nope",
        author: "test",
      }),
    ).toThrow(MemoryNotFoundError);
  });

  it("does not mutate original state", () => {
    const state = stateWith([makeItem()]);
    applyCommand(state, {
      type: "memory.retract",
      item_id: "m1",
      author: "test",
    });
    expect(state.items.has("m1")).toBe(true);
  });
});

describe("edge.create", () => {
  it("creates an edge", () => {
    const edge = makeEdge();
    const { state, events } = applyCommand(createGraphState(), {
      type: "edge.create",
      edge,
    });
    expect(state.edges.get("e1")).toEqual(edge);
    expect(events[0]).toEqual({
      namespace: "memory",
      type: "edge.created",
      edge,
      cause_type: "edge.create",
    });
  });

  it("throws DuplicateEdgeError on duplicate edge_id", () => {
    const state = stateWith([], [makeEdge()]);
    expect(() =>
      applyCommand(state, { type: "edge.create", edge: makeEdge() }),
    ).toThrow(DuplicateEdgeError);
  });
});

describe("edge.update", () => {
  it("updates weight on existing edge", () => {
    const state = stateWith([], [makeEdge()]);
    const { state: next, events } = applyCommand(state, {
      type: "edge.update",
      edge_id: "e1",
      partial: { weight: 0.5 },
      author: "test",
    });
    expect(next.edges.get("e1")!.weight).toBe(0.5);
    expect(events[0].type).toBe("edge.updated");
  });

  it("throws EdgeNotFoundError for non-existent edge_id", () => {
    expect(() =>
      applyCommand(createGraphState(), {
        type: "edge.update",
        edge_id: "nope",
        partial: { weight: 0.5 },
        author: "test",
      }),
    ).toThrow(EdgeNotFoundError);
  });
});

describe("edge.retract", () => {
  it("removes edge from state", () => {
    const state = stateWith([], [makeEdge()]);
    const { state: next, events } = applyCommand(state, {
      type: "edge.retract",
      edge_id: "e1",
      author: "test",
    });
    expect(next.edges.has("e1")).toBe(false);
    expect(events[0].type).toBe("edge.retracted");
  });

  it("throws EdgeNotFoundError for non-existent edge_id", () => {
    expect(() =>
      applyCommand(createGraphState(), {
        type: "edge.retract",
        edge_id: "nope",
        author: "test",
      }),
    ).toThrow(EdgeNotFoundError);
  });
});

describe("sequential operations", () => {
  it("create -> update -> retract produces empty state with 3 events", () => {
    const allEvents: unknown[] = [];
    let state: GraphState = createGraphState();
    let result = applyCommand(state, {
      type: "memory.create",
      item: makeItem(),
    });
    state = result.state;
    allEvents.push(...result.events);
    result = applyCommand(state, {
      type: "memory.update",
      item_id: "m1",
      partial: { authority: 0.5 },
      author: "test",
    });
    state = result.state;
    allEvents.push(...result.events);
    result = applyCommand(state, {
      type: "memory.retract",
      item_id: "m1",
      author: "test",
    });
    state = result.state;
    allEvents.push(...result.events);
    expect(state.items.size).toBe(0);
    expect(allEvents).toHaveLength(3);
  });

  it("two items + edge; retract one; edge and other item remain", () => {
    let state: GraphState = createGraphState();
    state = applyCommand(state, {
      type: "memory.create",
      item: makeItem({ id: "m1" }),
    }).state;
    state = applyCommand(state, {
      type: "memory.create",
      item: makeItem({ id: "m2", scope: "other" }),
    }).state;
    state = applyCommand(state, {
      type: "edge.create",
      edge: makeEdge({ edge_id: "e1", from: "m1", to: "m2" }),
    }).state;
    state = applyCommand(state, {
      type: "memory.retract",
      item_id: "m1",
      author: "test",
    }).state;
    expect(state.items.size).toBe(1);
    expect(state.items.has("m2")).toBe(true);
    expect(state.edges.size).toBe(1);
  });
});
