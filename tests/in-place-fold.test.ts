// Tests for the in-place fold paths introduced to keep replay / import /
// cascade linear instead of O(N^2):
//   - applyCommand stays immutable (input untouched, untouched map shared)
//   - applyCommandInPlace matches applyCommand, and replay matches an
//     immutable per-command fold (the two code paths must not diverge)
//   - retractItemsInPlace cascades edges and de-dupes batch retracts
//   - buildChildrenIndex matches getChildren
//   - replay scales linearly (a regression guard against reintroducing the
//     per-command clone)

import { describe, it, expect } from "vitest";
import {
  applyCommand,
  applyCommandInPlace,
  retractItemsInPlace,
} from "../src/reducer.js";
import { createGraphState } from "../src/graph.js";
import { createMemoryItem, createEdge } from "../src/helpers.js";
import { buildChildrenIndex, getChildren } from "../src/query.js";
import { replayCommands } from "../src/replay.js";
import type {
  GraphState,
  MemoryItem,
  MemoryCommand,
  Edge,
} from "../src/types.js";

const mkItem = (id: string, overrides: Partial<MemoryItem> = {}): MemoryItem =>
  createMemoryItem({
    id,
    scope: "test",
    kind: "observation",
    content: {},
    author: "agent:a",
    source_kind: "observed",
    authority: 0.5,
    created_at: 1_700_000_000_000,
    ...overrides,
  });

const mkEdge = (id: string, from: string, to: string): Edge =>
  createEdge({
    edge_id: id,
    from,
    to,
    kind: "SUPPORTS",
    author: "agent:a",
    source_kind: "observed",
    authority: 0.5,
  });

const itemsObj = (s: GraphState) => Object.fromEntries(s.items);
const edgesObj = (s: GraphState) => Object.fromEntries(s.edges);

describe("applyCommand immutability", () => {
  it("never mutates the input state and shares the untouched map", () => {
    let state = createGraphState();
    state = applyCommand(state, {
      type: "memory.create",
      item: mkItem("a"),
    }).state;
    state = applyCommand(state, {
      type: "edge.create",
      edge: mkEdge("e1", "a", "a"),
    }).state;

    const itemsRef = state.items;
    const edgesRef = state.edges;
    const itemKeys = [...state.items.keys()];
    const edgeKeys = [...state.edges.keys()];

    // memory.create: clones items, shares edges
    const created = applyCommand(state, {
      type: "memory.create",
      item: mkItem("b"),
    });
    expect(created.state).not.toBe(state);
    expect(created.state.items).not.toBe(itemsRef);
    expect(created.state.edges).toBe(edgesRef); // structural sharing
    expect(state.items.has("b")).toBe(false); // input untouched
    expect([...state.items.keys()]).toEqual(itemKeys);

    // edge.create: clones edges, shares items
    const linked = applyCommand(state, {
      type: "edge.create",
      edge: mkEdge("e2", "a", "a"),
    });
    expect(linked.state.edges).not.toBe(edgesRef);
    expect(linked.state.items).toBe(itemsRef); // structural sharing
    expect(state.edges.has("e2")).toBe(false);

    // memory.retract: clones both and cascades incident edges
    const retracted = applyCommand(state, {
      type: "memory.retract",
      item_id: "a",
      author: "x",
    });
    expect(retracted.state.items).not.toBe(itemsRef);
    expect(retracted.state.edges).not.toBe(edgesRef);
    expect(retracted.state.items.has("a")).toBe(false);
    expect(retracted.state.edges.has("e1")).toBe(false); // cascaded
    // input still fully intact
    expect(state.items.has("a")).toBe(true);
    expect(state.edges.has("e1")).toBe(true);
    expect([...state.items.keys()]).toEqual(itemKeys);
    expect([...state.edges.keys()]).toEqual(edgeKeys);
  });
});

describe("applyCommandInPlace matches applyCommand", () => {
  const commands: MemoryCommand[] = [
    { type: "memory.create", item: mkItem("a", { authority: 0.4 }) },
    { type: "memory.create", item: mkItem("b", { authority: 0.6 }) },
    { type: "edge.create", edge: mkEdge("e1", "a", "b") },
    {
      type: "memory.update",
      item_id: "a",
      partial: { importance: 0.9 },
      author: "x",
    },
    {
      type: "edge.update",
      edge_id: "e1",
      partial: { weight: 0.2 },
      author: "x",
    },
    { type: "memory.retract", item_id: "b", author: "x" },
  ];

  it("produces identical state and events for each command", () => {
    let immState = createGraphState();
    const items = new Map<string, MemoryItem>();
    const edges = new Map<string, Edge>();

    for (const cmd of commands) {
      const imm = applyCommand(immState, cmd);
      const events = applyCommandInPlace(items, edges, cmd);
      immState = imm.state;
      expect(events).toEqual(imm.events);
      expect(itemsObj({ items, edges })).toEqual(itemsObj(imm.state));
      expect(edgesObj({ items, edges })).toEqual(edgesObj(imm.state));
    }
  });
});

describe("replayCommands matches an immutable per-command fold", () => {
  // Includes commands that throw so the skip-on-error path is exercised too.
  const commands: MemoryCommand[] = [
    { type: "memory.create", item: mkItem("a") },
    { type: "memory.create", item: mkItem("a") }, // duplicate -> skipped
    { type: "memory.create", item: mkItem("b") },
    { type: "edge.create", edge: mkEdge("e1", "a", "b") },
    {
      type: "memory.update",
      item_id: "ghost",
      partial: { authority: 0.1 },
      author: "x",
    }, // not found -> skipped
    {
      type: "memory.update",
      item_id: "b",
      partial: { conviction: 0.8 },
      author: "x",
    },
    { type: "edge.retract", edge_id: "missing", author: "x" }, // not found -> skipped
    { type: "memory.retract", item_id: "a", author: "x" }, // cascades e1
  ];

  function foldImmutable(cmds: MemoryCommand[]) {
    let state = createGraphState();
    const events = [];
    const skipped: number[] = [];
    for (let i = 0; i < cmds.length; i++) {
      try {
        const r = applyCommand(state, cmds[i]);
        state = r.state;
        for (const e of r.events) events.push(e);
      } catch {
        skipped.push(i);
      }
    }
    return { state, events, skipped };
  }

  it("matches on state, events, and skipped indices", () => {
    const expected = foldImmutable(commands);
    const actual = replayCommands(commands);

    expect(itemsObj(actual.state)).toEqual(itemsObj(expected.state));
    expect(edgesObj(actual.state)).toEqual(edgesObj(expected.state));
    expect(actual.events).toEqual(expected.events);
    expect(actual.skipped.map((s) => s.index)).toEqual(expected.skipped);
    // the three intentionally-bad commands were skipped, not applied
    expect(actual.skipped.map((s) => s.index)).toEqual([1, 4, 6]);
  });
});

describe("retractItemsInPlace", () => {
  function seed() {
    const items = new Map<string, MemoryItem>();
    const edges = new Map<string, Edge>();
    for (const id of ["A", "B", "C", "D"]) items.set(id, mkItem(id));
    edges.set("ab", mkEdge("ab", "A", "B"));
    edges.set("bc", mkEdge("bc", "B", "C"));
    edges.set("cd", mkEdge("cd", "C", "D"));
    return { items, edges };
  }

  it("retracts in the given order and cascades incident edges", () => {
    const { items, edges } = seed();
    const { events, retracted } = retractItemsInPlace(
      items,
      edges,
      ["B", "C"],
      "memory.retract",
    );

    expect(retracted).toEqual(["B", "C"]);
    expect(items.has("B")).toBe(false);
    expect(items.has("C")).toBe(false);
    expect(items.has("A")).toBe(true);
    // ab (A-B), bc (B-C), cd (C-D) all touch a retracted endpoint
    expect(edges.size).toBe(0);
    expect(events[0]).toMatchObject({ type: "memory.retracted" });
  });

  it("counts an edge between two batch-retracted items only once", () => {
    const { items, edges } = seed();
    const { events } = retractItemsInPlace(
      items,
      edges,
      ["B", "C"],
      "memory.retract",
    );
    const bcEvents = events.filter(
      (e) => e.type === "edge.retracted" && e.edge.edge_id === "bc",
    );
    expect(bcEvents).toHaveLength(1);
  });

  it("counts a self-edge only once", () => {
    const items = new Map<string, MemoryItem>([["X", mkItem("X")]]);
    const edges = new Map<string, Edge>([["xx", mkEdge("xx", "X", "X")]]);
    const { events } = retractItemsInPlace(
      items,
      edges,
      ["X"],
      "memory.retract",
    );
    const edgeEvents = events.filter((e) => e.type === "edge.retracted");
    expect(edgeEvents).toHaveLength(1);
    expect(edges.size).toBe(0);
  });

  it("skips ids that are not present", () => {
    const { items, edges } = seed();
    const { retracted } = retractItemsInPlace(
      items,
      edges,
      ["nope", "A"],
      "memory.retract",
    );
    expect(retracted).toEqual(["A"]);
  });
});

describe("buildChildrenIndex", () => {
  it("groups children by parent and matches getChildren", () => {
    let state = createGraphState();
    const rels: Array<[string, string[] | undefined]> = [
      ["p", undefined],
      ["c1", ["p"]],
      ["c2", ["p"]],
      ["g", ["c1"]],
    ];
    for (const [id, parents] of rels) {
      state = applyCommand(state, {
        type: "memory.create",
        item: mkItem(id, parents ? { parents } : {}),
      }).state;
    }

    const index = buildChildrenIndex(state);
    for (const id of ["p", "c1", "c2", "g"]) {
      const fromIndex = (index.get(id) ?? []).map((i) => i.id).sort();
      const fromScan = getChildren(state, id)
        .map((i) => i.id)
        .sort();
      expect(fromIndex).toEqual(fromScan);
    }
    expect((index.get("p") ?? []).map((i) => i.id).sort()).toEqual([
      "c1",
      "c2",
    ]);
    // items with no children are absent as keys
    expect(index.has("g")).toBe(false);
  });

  it("de-dupes a duplicated parent id (matches getChildren's includes)", () => {
    let state = createGraphState();
    state = applyCommand(state, {
      type: "memory.create",
      item: mkItem("p"),
    }).state;
    state = applyCommand(state, {
      type: "memory.create",
      item: mkItem("c", { parents: ["p", "p"] }),
    }).state;

    const index = buildChildrenIndex(state);
    expect((index.get("p") ?? []).filter((i) => i.id === "c")).toHaveLength(1);
    expect(getChildren(state, "p")).toHaveLength(1);
  });
});

describe("replay scales linearly (O(N^2) regression guard)", () => {
  // The pre-fix implementation cloned the whole graph per command, so a fold of
  // 50k creates was ~(50000/16000)^2 of a 6s run — minutes, far past this
  // timeout. The in-place fold does it in tens of milliseconds.
  it(
    "replays 50k commands well within a linear-time budget",
    { timeout: 10_000 },
    () => {
      const commands: MemoryCommand[] = [];
      for (let i = 0; i < 50_000; i++) {
        commands.push({
          type: "memory.create",
          item: mkItem(`m-${i.toString().padStart(8, "0")}`),
        });
      }
      const result = replayCommands(commands);
      expect(result.state.items.size).toBe(50_000);
      expect(result.skipped).toHaveLength(0);
    },
  );
});
