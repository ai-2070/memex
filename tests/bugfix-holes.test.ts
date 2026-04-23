import { describe, it, expect } from "vitest";
import { createGraphState } from "../src/graph.js";
import { applyCommand } from "../src/reducer.js";
import {
  getEdges,
  getItems,
  getScoredItems,
  extractTimestamp,
  getRelatedItems,
} from "../src/query.js";
import {
  filterContradictions,
  surfaceContradictions,
  smartRetrieve,
  applyDiversity,
} from "../src/retrieval.js";
import {
  markContradiction,
  resolveContradiction,
  getContradictions,
  getItemsByBudget,
} from "../src/integrity.js";
import { applyMany, decayImportance } from "../src/bulk.js";
import {
  createIntentState,
  createIntent,
  applyIntentCommand,
} from "../src/intent.js";
import { createTaskState, createTask, applyTaskCommand } from "../src/task.js";
import { exportSlice, importSlice } from "../src/transplant.js";
import { replayFromEnvelopes } from "../src/replay.js";
import type { MemoryItem, Edge, GraphState, ScoredItem } from "../src/types.js";
import type { Intent } from "../src/intent.js";
import type { Task } from "../src/task.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a deterministic UUIDv7-shaped id for testing. */
function fakeUuid(n: number): string {
  const ms = (1700000000000 + n).toString(16).padStart(12, "0");
  return `${ms.slice(0, 8)}-${ms.slice(8, 12)}-7000-8000-${"0".repeat(11)}${n}`;
}

let counter = 0;

function fakeId(tsMs: number): string {
  counter++;
  const hex = tsMs.toString(16).padStart(12, "0");
  const pad = counter.toString(16).padStart(20, "0");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    "7" + pad.slice(0, 3),
    "8" + pad.slice(3, 6),
    pad.slice(6, 18),
  ].join("-");
}

function makeItem(id: string, overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id,
    scope: "test",
    kind: "observation",
    content: { text: `item ${id}` },
    author: "agent:test",
    source_kind: "observed",
    authority: 0.8,
    ...overrides,
  };
}

function makeEdge(
  edgeId: string,
  from: string,
  to: string,
  kind: Edge["kind"] = "SUPPORTS",
  overrides: Partial<Edge> = {},
): Edge {
  return {
    edge_id: edgeId,
    from,
    to,
    kind,
    author: "agent:test",
    source_kind: "derived_deterministic",
    authority: 1,
    active: true,
    ...overrides,
  };
}

function stateWith(items: MemoryItem[], edges: Edge[] = []): GraphState {
  let state = createGraphState();
  for (const item of items) {
    state = applyCommand(state, { type: "memory.create", item }).state;
  }
  for (const edge of edges) {
    state = applyCommand(state, { type: "edge.create", edge }).state;
  }
  return state;
}

// =========================================================================
// 1. intent.update / task.update with undefined in partial
// =========================================================================

describe("intent.update strips undefined values", () => {
  it("does not overwrite existing fields with undefined", () => {
    let state = createIntentState();
    const intent = createIntent({
      id: "i1",
      label: "find target",
      description: "locate the target entity",
      priority: 0.9,
      owner: "user:laz",
    });
    state = applyIntentCommand(state, {
      type: "intent.create",
      intent,
    }).state;

    // update with undefined description — should NOT wipe it
    state = applyIntentCommand(state, {
      type: "intent.update",
      intent_id: "i1",
      partial: { description: undefined, label: "renamed" },
      author: "user:laz",
    }).state;

    const updated = state.intents.get("i1")!;
    expect(updated.label).toBe("renamed");
    expect(updated.description).toBe("locate the target entity");
  });

  it("does not overwrite context with undefined", () => {
    let state = createIntentState();
    const intent = createIntent({
      id: "i2",
      label: "test",
      priority: 0.5,
      owner: "user:laz",
      context: { key: "value" },
    });
    state = applyIntentCommand(state, {
      type: "intent.create",
      intent,
    }).state;

    state = applyIntentCommand(state, {
      type: "intent.update",
      intent_id: "i2",
      partial: { context: undefined },
      author: "user:laz",
    }).state;

    const updated = state.intents.get("i2")!;
    expect(updated.context).toEqual({ key: "value" });
  });
});

describe("task.update strips undefined values", () => {
  it("does not overwrite existing fields with undefined", () => {
    let state = createTaskState();
    const task = createTask({
      id: "t1",
      intent_id: "i1",
      action: "search",
      label: "search linkedin",
      priority: 0.7,
      context: { query: "test" },
    });
    state = applyTaskCommand(state, { type: "task.create", task }).state;

    state = applyTaskCommand(state, {
      type: "task.update",
      task_id: "t1",
      partial: { label: undefined, context: undefined, action: "search_v2" },
      author: "agent:test",
    }).state;

    const updated = state.tasks.get("t1")!;
    expect(updated.action).toBe("search_v2");
    expect(updated.label).toBe("search linkedin");
    expect(updated.context).toEqual({ query: "test" });
  });
});

// =========================================================================
// 2. Edge re-id on import conflict
// =========================================================================

describe("importSlice edge re-id on conflict", () => {
  it("re-ids edges when reIdOnDifference is true and edge data differs", () => {
    const edgeId = fakeUuid(1);
    const memState = stateWith([makeItem("m1"), makeItem("m2")]);
    const intentState = createIntentState();
    const taskState = createTaskState();

    // add an edge to the existing state
    const existingEdge = makeEdge(edgeId, "m1", "m2", "SUPPORTS", {
      weight: 0.5,
    });
    const stateWithEdge = applyCommand(memState, {
      type: "edge.create",
      edge: existingEdge,
    }).state;

    // slice with same edge_id but different data
    const slice = {
      memories: [],
      edges: [makeEdge(edgeId, "m1", "m2", "SUPPORTS", { weight: 0.9 })],
      intents: [],
      tasks: [],
    };

    const result = importSlice(stateWithEdge, intentState, taskState, slice, {
      skipExistingIds: true,
      shallowCompareExisting: true,
      reIdOnDifference: true,
    });

    // original edge should still exist
    expect(result.memState.edges.has(edgeId)).toBe(true);
    // a new edge should have been created
    expect(result.report.created.edges.length).toBe(1);
    const newEdgeId = result.report.created.edges[0];
    expect(newEdgeId).not.toBe(edgeId);
    const newEdge = result.memState.edges.get(newEdgeId)!;
    expect(newEdge.weight).toBe(0.9);
    expect(newEdge.from).toBe("m1");
    expect(newEdge.to).toBe("m2");
  });

  it("reports conflict when shallowCompare detects difference but reId is false", () => {
    const memState = stateWith([makeItem("m1"), makeItem("m2")]);
    const intentState = createIntentState();
    const taskState = createTaskState();

    const existingEdge = makeEdge("e1", "m1", "m2", "SUPPORTS", {
      weight: 0.5,
    });
    const stateWithEdge = applyCommand(memState, {
      type: "edge.create",
      edge: existingEdge,
    }).state;

    const slice = {
      memories: [],
      edges: [makeEdge("e1", "m1", "m2", "SUPPORTS", { weight: 0.9 })],
      intents: [],
      tasks: [],
    };

    const result = importSlice(stateWithEdge, intentState, taskState, slice, {
      skipExistingIds: true,
      shallowCompareExisting: true,
      reIdOnDifference: false,
    });

    expect(result.report.conflicts.edges).toEqual(["e1"]);
    expect(result.report.created.edges).toEqual([]);
  });

  it("skips identical edges without conflict", () => {
    const memState = stateWith([makeItem("m1"), makeItem("m2")]);
    const intentState = createIntentState();
    const taskState = createTaskState();

    const edge = makeEdge("e1", "m1", "m2", "SUPPORTS");
    const stateWithEdge = applyCommand(memState, {
      type: "edge.create",
      edge,
    }).state;

    const slice = {
      memories: [],
      edges: [{ ...edge }],
      intents: [],
      tasks: [],
    };

    const result = importSlice(stateWithEdge, intentState, taskState, slice, {
      skipExistingIds: true,
      shallowCompareExisting: true,
      reIdOnDifference: true,
    });

    expect(result.report.skipped.edges).toEqual(["e1"]);
    expect(result.report.created.edges).toEqual([]);
    expect(result.report.conflicts.edges).toEqual([]);
  });
});

// =========================================================================
// 3. filterContradictions with chained contradictions
// =========================================================================

describe("filterContradictions chained contradictions", () => {
  it("item C survives when B is excluded from A↔B but B↔C also exists", () => {
    const state = stateWith(
      [
        makeItem("a", { authority: 0.9 }),
        makeItem("b", { authority: 0.5 }),
        makeItem("c", { authority: 0.7 }),
      ],
      [
        makeEdge("e1", "a", "b", "CONTRADICTS"),
        makeEdge("e2", "b", "c", "CONTRADICTS"),
      ],
    );

    const scored: ScoredItem[] = [
      { item: state.items.get("a")!, score: 0.9 },
      { item: state.items.get("c")!, score: 0.7 },
      { item: state.items.get("b")!, score: 0.5 },
    ];

    const result = filterContradictions(state, scored);
    const ids = result.map((s) => s.item.id);

    expect(ids).toContain("a"); // winner of A↔B
    expect(ids).not.toContain("b"); // loser of A↔B
    expect(ids).toContain("c"); // B already excluded, so B↔C skipped — C survives
  });
});

// =========================================================================
// 4. filterContradictions equal-score tiebreak
// =========================================================================

describe("filterContradictions equal-score tiebreak", () => {
  it("uses lexicographic id comparison for equal scores", () => {
    const state = stateWith(
      [
        makeItem("aaa", { authority: 0.8 }),
        makeItem("zzz", { authority: 0.8 }),
      ],
      [makeEdge("e1", "aaa", "zzz", "CONTRADICTS")],
    );

    const scored: ScoredItem[] = [
      { item: state.items.get("aaa")!, score: 0.5 },
      { item: state.items.get("zzz")!, score: 0.5 },
    ];

    const result = filterContradictions(state, scored);
    const ids = result.map((s) => s.item.id);

    // lexicographically "aaa" < "zzz", so "zzz" is excluded
    expect(ids).toContain("aaa");
    expect(ids).not.toContain("zzz");
  });

  it("tiebreak is deterministic regardless of input order", () => {
    const state = stateWith(
      [
        makeItem("aaa", { authority: 0.8 }),
        makeItem("zzz", { authority: 0.8 }),
      ],
      [makeEdge("e1", "aaa", "zzz", "CONTRADICTS")],
    );

    // reverse the scored input order
    const scored: ScoredItem[] = [
      { item: state.items.get("zzz")!, score: 0.5 },
      { item: state.items.get("aaa")!, score: 0.5 },
    ];

    const result = filterContradictions(state, scored);
    const ids = result.map((s) => s.item.id);

    expect(ids).toContain("aaa");
    expect(ids).not.toContain("zzz");
  });
});

// =========================================================================
// 5. smartRetrieve with contradictions: "surface"
// =========================================================================

describe("smartRetrieve with contradictions: surface", () => {
  it("keeps both sides and annotates contradicted_by", () => {
    const state = stateWith(
      [
        makeItem("m1", { authority: 0.9 }),
        makeItem("m2", { authority: 0.6 }),
        makeItem("m3", { authority: 0.3 }),
      ],
      [makeEdge("e1", "m1", "m2", "CONTRADICTS")],
    );

    const result = smartRetrieve(state, {
      budget: 1000,
      costFn: () => 1,
      weights: { authority: 1 },
      contradictions: "surface",
    });

    const ids = result.map((s) => s.item.id);
    expect(ids).toContain("m1");
    expect(ids).toContain("m2");
    expect(ids).toContain("m3");

    const m1Entry = result.find((s) => s.item.id === "m1")!;
    const m2Entry = result.find((s) => s.item.id === "m2")!;
    expect(m1Entry.contradicted_by).toBeDefined();
    expect(m1Entry.contradicted_by!.map((i) => i.id)).toContain("m2");
    expect(m2Entry.contradicted_by).toBeDefined();
    expect(m2Entry.contradicted_by!.map((i) => i.id)).toContain("m1");
  });

  it("still removes superseded items when surfacing", () => {
    let state = stateWith([
      makeItem("m1", { authority: 0.9 }),
      makeItem("m2", { authority: 0.4 }),
    ]);
    // mark contradiction then resolve it
    state = markContradiction(state, "m1", "m2", "agent:test").state;
    state = resolveContradiction(state, "m1", "m2", "agent:test").state;

    const result = smartRetrieve(state, {
      budget: 1000,
      costFn: () => 1,
      weights: { authority: 1 },
      contradictions: "surface",
    });

    const ids = result.map((s) => s.item.id);
    expect(ids).toContain("m1");
    expect(ids).not.toContain("m2"); // superseded
  });
});

// =========================================================================
// 6. surfaceContradictions bidirectional annotation
// =========================================================================

describe("surfaceContradictions", () => {
  it("annotates both sides of each contradiction", () => {
    const state = stateWith(
      [
        makeItem("a", { authority: 0.8 }),
        makeItem("b", { authority: 0.6 }),
        makeItem("c", { authority: 0.4 }),
      ],
      [
        makeEdge("e1", "a", "b", "CONTRADICTS"),
        makeEdge("e2", "b", "c", "CONTRADICTS"),
      ],
    );

    const scored: ScoredItem[] = [
      { item: state.items.get("a")!, score: 0.8 },
      { item: state.items.get("b")!, score: 0.6 },
      { item: state.items.get("c")!, score: 0.4 },
    ];

    const result = surfaceContradictions(state, scored);

    const a = result.find((s) => s.item.id === "a")!;
    const b = result.find((s) => s.item.id === "b")!;
    const c = result.find((s) => s.item.id === "c")!;

    // a contradicts b
    expect(a.contradicted_by!.map((i) => i.id)).toEqual(["b"]);
    // b contradicts a AND c
    expect(b.contradicted_by!.map((i) => i.id).sort()).toEqual(["a", "c"]);
    // c contradicts b
    expect(c.contradicted_by!.map((i) => i.id)).toEqual(["b"]);
  });

  it("does not mutate the input array", () => {
    const state = stateWith(
      [makeItem("a"), makeItem("b")],
      [makeEdge("e1", "a", "b", "CONTRADICTS")],
    );

    const scored: ScoredItem[] = [
      { item: state.items.get("a")!, score: 0.8 },
      { item: state.items.get("b")!, score: 0.6 },
    ];

    surfaceContradictions(state, scored);

    // original entries should not have contradicted_by
    expect(scored[0].contradicted_by).toBeUndefined();
    expect(scored[1].contradicted_by).toBeUndefined();
  });
});

// =========================================================================
// 7. getItemsByBudget with zero-cost items
// =========================================================================

describe("getItemsByBudget with zero-cost items", () => {
  it("includes all zero-cost items without exhausting budget", () => {
    const state = stateWith([
      makeItem("m1", { authority: 0.9 }),
      makeItem("m2", { authority: 0.8 }),
      makeItem("m3", { authority: 0.7 }),
    ]);

    const result = getItemsByBudget(state, {
      budget: 5,
      costFn: () => 0,
      weights: { authority: 1 },
    });
    expect(result).toHaveLength(3);
  });

  it("mixes zero-cost and positive-cost items correctly", () => {
    const state = stateWith([
      makeItem("m1", { authority: 0.9 }),
      makeItem("m2", { authority: 0.8 }),
      makeItem("m3", { authority: 0.7 }),
    ]);

    const result = getItemsByBudget(state, {
      budget: 2,
      costFn: (item) => (item.id === "m2" ? 0 : 1),
      weights: { authority: 1 },
    });
    const ids = result.map((r) => r.item.id).sort();
    // m1 (cost 1), m2 (cost 0), m3 (cost 1) — all fit within budget 2.
    expect(ids).toEqual(["m1", "m2", "m3"]);
  });

  it("rejects negative cost", () => {
    const state = stateWith([makeItem("m1", { authority: 0.9 })]);
    expect(() =>
      getItemsByBudget(state, {
        budget: 5,
        costFn: () => -1,
        weights: { authority: 1 },
      }),
    ).toThrow(RangeError);
  });
});

// =========================================================================
// 8. applyMany transform returning empty object (skip path)
// =========================================================================

describe("applyMany transform returning empty object", () => {
  it("skips items when transform returns {}", () => {
    const state = stateWith([
      makeItem("m1", { authority: 0.5 }),
      makeItem("m2", { authority: 0.8 }),
    ]);

    const result = applyMany(
      state,
      {}, // match all
      () => ({}), // skip all
      "agent:test",
    );

    // no changes — should return original state
    expect(result.state).toBe(state);
    expect(result.events).toEqual([]);
  });

  it("applies to some and skips others", () => {
    const state = stateWith([
      makeItem("m1", { authority: 0.5 }),
      makeItem("m2", { authority: 0.8 }),
    ]);

    const result = applyMany(
      state,
      {},
      (item) => {
        if (item.id === "m1") return { authority: 0.9 };
        return {}; // skip m2
      },
      "agent:test",
    );

    expect(result.events.length).toBe(1);
    expect(result.state.items.get("m1")!.authority).toBe(0.9);
    expect(result.state.items.get("m2")!.authority).toBe(0.8);
  });
});

// =========================================================================
// 9. resolveContradiction with multiple CONTRADICTS edges between same pair
// =========================================================================

describe("resolveContradiction with multiple CONTRADICTS edges", () => {
  it("retracts all CONTRADICTS edges between the pair", () => {
    let state = stateWith([
      makeItem("m1", { authority: 0.9 }),
      makeItem("m2", { authority: 0.5 }),
    ]);

    // create two CONTRADICTS edges between same pair (different directions)
    state = applyCommand(state, {
      type: "edge.create",
      edge: makeEdge("c1", "m1", "m2", "CONTRADICTS"),
    }).state;
    state = applyCommand(state, {
      type: "edge.create",
      edge: makeEdge("c2", "m2", "m1", "CONTRADICTS"),
    }).state;

    expect(getContradictions(state).length).toBe(2);

    const result = resolveContradiction(state, "m1", "m2", "agent:test");
    state = result.state;

    // both CONTRADICTS edges should be retracted
    const remainingContradicts = getEdges(state, {
      kind: "CONTRADICTS",
      active_only: true,
    });
    expect(remainingContradicts.length).toBe(0);

    // SUPERSEDES edge should exist
    const supersedes = getEdges(state, {
      kind: "SUPERSEDES",
      active_only: true,
    });
    expect(supersedes.length).toBe(1);
    expect(supersedes[0].from).toBe("m1");
    expect(supersedes[0].to).toBe("m2");
  });
});

// =========================================================================
// 10. exportSlice with include_related_intents via intent_id
// =========================================================================

describe("exportSlice walks intent_id", () => {
  it("includes intents referenced by memory intent_id", () => {
    const memState = stateWith([makeItem("m1", { intent_id: "i1" })]);
    let intentState = createIntentState();
    const intent = createIntent({
      id: "i1",
      label: "test intent",
      priority: 0.5,
      owner: "agent:test",
    });
    intentState = applyIntentCommand(intentState, {
      type: "intent.create",
      intent,
    }).state;
    const taskState = createTaskState();

    const slice = exportSlice(memState, intentState, taskState, {
      memory_ids: ["m1"],
      include_related_intents: true,
    });

    expect(slice.intents.length).toBe(1);
    expect(slice.intents[0].id).toBe("i1");
  });
});

// =========================================================================
// 11. exportSlice with include_related_tasks via task_id
// =========================================================================

describe("exportSlice walks task_id", () => {
  it("includes tasks referenced by memory task_id", () => {
    const memState = stateWith([makeItem("m1", { task_id: "t1" })]);
    const intentState = createIntentState();
    let taskState = createTaskState();
    const task = createTask({
      id: "t1",
      intent_id: "i1",
      action: "search",
      priority: 0.5,
    });
    taskState = applyTaskCommand(taskState, {
      type: "task.create",
      task,
    }).state;

    const slice = exportSlice(memState, intentState, taskState, {
      memory_ids: ["m1"],
      include_related_tasks: true,
    });

    expect(slice.tasks.length).toBe(1);
    expect(slice.tasks[0].id).toBe("t1");
  });
});

// =========================================================================
// 12. getEdges with active_only: false
// =========================================================================

describe("getEdges with active_only: false", () => {
  it("returns inactive edges", () => {
    let state = stateWith(
      [makeItem("m1"), makeItem("m2")],
      [
        makeEdge("e1", "m1", "m2", "SUPPORTS", { active: true }),
        makeEdge("e2", "m1", "m2", "ABOUT", { active: false }),
      ],
    );

    const allEdges = getEdges(state, { active_only: false });
    expect(allEdges.length).toBe(2);

    const activeOnly = getEdges(state, { active_only: true });
    expect(activeOnly.length).toBe(1);
    expect(activeOnly[0].edge_id).toBe("e1");
  });

  it("defaults to active_only: true", () => {
    let state = stateWith(
      [makeItem("m1"), makeItem("m2")],
      [
        makeEdge("e1", "m1", "m2", "SUPPORTS", { active: true }),
        makeEdge("e2", "m1", "m2", "ABOUT", { active: false }),
      ],
    );

    const defaultEdges = getEdges(state);
    expect(defaultEdges.length).toBe(1);
    expect(defaultEdges[0].edge_id).toBe("e1");
  });
});

// =========================================================================
// 13. decayImportance with all items at importance: 0
// =========================================================================

describe("decayImportance with zero importance", () => {
  it("is a no-op when all items have importance 0", () => {
    // use fake ids with old timestamps so they match the cutoff
    const oldId1 = fakeId(1000);
    const oldId2 = fakeId(1001);

    const state = stateWith([
      makeItem(oldId1, { importance: 0 }),
      makeItem(oldId2, { importance: 0 }),
    ]);

    const result = decayImportance(state, 1, 0.5, "agent:test");

    // no changes — should return original state
    expect(result.state).toBe(state);
    expect(result.events).toEqual([]);
  });
});

// =========================================================================
// 14. replayFromEnvelopes with duplicate/out-of-order timestamps
// =========================================================================

describe("replayFromEnvelopes ordering", () => {
  it("sorts by timestamp before replaying", () => {
    const id1 = fakeId(1000);
    const id2 = fakeId(2000);

    const item1 = makeItem(id1, { authority: 0.5 });
    const item2 = makeItem(id2, { authority: 0.9 });

    // envelopes in reverse chronological order
    const envelopes = [
      {
        id: "env2",
        namespace: "memory" as const,
        type: "memory.create",
        ts: "2026-01-01T00:00:02.000Z",
        payload: { type: "memory.create" as const, item: item2 },
      },
      {
        id: "env1",
        namespace: "memory" as const,
        type: "memory.create",
        ts: "2026-01-01T00:00:01.000Z",
        payload: { type: "memory.create" as const, item: item1 },
      },
    ];

    const result = replayFromEnvelopes(envelopes);
    expect(result.state.items.size).toBe(2);
    expect(result.state.items.has(id1)).toBe(true);
    expect(result.state.items.has(id2)).toBe(true);
    // events should be in chronological order
    expect(result.events[0].item!.id).toBe(id1);
    expect(result.events[1].item!.id).toBe(id2);
  });

  it("handles envelopes with identical timestamps", () => {
    const id1 = fakeId(3000);
    const id2 = fakeId(3001);

    const item1 = makeItem(id1);
    const item2 = makeItem(id2);

    const envelopes = [
      {
        id: "env1",
        namespace: "memory" as const,
        type: "memory.create",
        ts: "2026-01-01T00:00:01.000Z",
        payload: { type: "memory.create" as const, item: item1 },
      },
      {
        id: "env2",
        namespace: "memory" as const,
        type: "memory.create",
        ts: "2026-01-01T00:00:01.000Z",
        payload: { type: "memory.create" as const, item: item2 },
      },
    ];

    const result = replayFromEnvelopes(envelopes);
    expect(result.state.items.size).toBe(2);
  });
});

// =========================================================================
// 15. getRelatedItems with inactive edges
// =========================================================================

describe("getRelatedItems with inactive edges", () => {
  it("excludes items connected only via inactive edges", () => {
    const state = stateWith(
      [makeItem("m1"), makeItem("m2"), makeItem("m3")],
      [
        makeEdge("e1", "m1", "m2", "SUPPORTS", { active: true }),
        makeEdge("e2", "m1", "m3", "SUPPORTS", { active: false }),
      ],
    );

    const related = getRelatedItems(state, "m1");
    const ids = related.map((i) => i.id);

    expect(ids).toContain("m2");
    expect(ids).not.toContain("m3"); // inactive edge
  });

  it("returns empty when all edges are inactive", () => {
    const state = stateWith(
      [makeItem("m1"), makeItem("m2")],
      [makeEdge("e1", "m1", "m2", "SUPPORTS", { active: false })],
    );

    const related = getRelatedItems(state, "m1");
    expect(related).toEqual([]);
  });
});

// =========================================================================
// Bonus: applyDiversity with empty input
// =========================================================================

describe("applyDiversity edge cases", () => {
  it("handles empty scored array", () => {
    const result = applyDiversity([], { author_penalty: 0.1 });
    expect(result).toEqual([]);
  });
});
