import { describe, it, expect } from "vitest";
import { applyCommand, mergeItem } from "../src/reducer.js";
import { createGraphState } from "../src/graph.js";
import { createMemoryItem } from "../src/helpers.js";
import { getItems, getScoredItems, extractTimestamp } from "../src/query.js";
import {
  filterContradictions,
} from "../src/retrieval.js";
import { markContradiction } from "../src/integrity.js";
import { importSlice, exportSlice } from "../src/transplant.js";
import {
  createIntentState,
  applyIntentCommand,
  createIntent,
} from "../src/intent.js";
import { createTaskState, applyTaskCommand, createTask } from "../src/task.js";
import type { MemoryItem, Edge, GraphState, ScoredItem } from "../src/types.js";
import type { IntentState } from "../src/intent.js";
import type { TaskState } from "../src/task.js";

// -- helpers --

/** Generate a deterministic UUIDv7-shaped id for testing. */
function fakeUuid(n: number): string {
  const ms = (1700000000000 + n).toString(16).padStart(12, "0");
  return `${ms.slice(0, 8)}-${ms.slice(8, 12)}-7000-8000-${"0".repeat(11)}${n}`;
}

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

const makeEdge = (
  id: string,
  from: string,
  to: string,
  kind: string = "SUPPORTS",
): Edge => ({
  edge_id: id,
  from,
  to,
  kind,
  author: "system:rule",
  source_kind: "derived_deterministic",
  authority: 0.8,
  active: true,
});

function toScored(items: MemoryItem[], scores: number[]): ScoredItem[] {
  return items.map((item, i) => ({ item, score: scores[i] }));
}

// ============================================================
// Bug 4: stripUndefined on content/meta merge
// ============================================================

describe("Bug 4: setting content/meta keys to undefined preserves them", () => {
  it("preserves a content key when set to undefined", () => {
    const existing = makeItem("m1", {
      content: { a: 1, b: 2, c: 3 },
    });
    const merged = mergeItem(existing, {
      content: { a: undefined },
    });
    expect(merged.content).toEqual({ a: 1, b: 2, c: 3 });
    expect(merged.content.a).toBe(1);
  });

  it("preserves a meta key when set to undefined", () => {
    const existing = makeItem("m1", {
      meta: { agent_id: "agent:x", session_id: "s1", custom: "val" },
    });
    const merged = mergeItem(existing, {
      meta: { custom: undefined },
    });
    expect(merged.meta).toEqual({
      agent_id: "agent:x",
      session_id: "s1",
      custom: "val",
    });
    expect(merged.meta!.custom).toBe("val");
  });

  it("keeps all content keys intact when patch has undefined", () => {
    const existing = makeItem("m1", {
      content: { x: 10, y: 20 },
    });
    const merged = mergeItem(existing, {
      content: { x: undefined, z: 30 },
    });
    expect(merged.content).toEqual({ x: 10, y: 20, z: 30 });
  });

  it("works through applyCommand memory.update", () => {
    let state = createGraphState();
    state = applyCommand(state, {
      type: "memory.create",
      item: makeItem("m1", { content: { keep: 1, remove: 2 } }),
    }).state;

    state = applyCommand(state, {
      type: "memory.update",
      item_id: "m1",
      partial: { content: { remove: undefined } },
      author: "test",
    }).state;

    const item = state.items.get("m1")!;
    expect(item.content).toEqual({ keep: 1, remove: 2 });
    expect(item.content.remove).toBe(2);
  });
});

// ============================================================
// Bug 5: created_at field for non-UUIDv7 IDs
// ============================================================

describe("Bug 5: created_at on MemoryItem", () => {
  it("auto-populates created_at from UUIDv7 id", () => {
    const now = Date.now();
    const item = createMemoryItem({
      scope: "test",
      kind: "observation",
      content: {},
      author: "agent:a",
      source_kind: "observed",
      authority: 0.5,
    });
    expect(item.created_at).toBeDefined();
    // should be within 1 second of now
    expect(Math.abs(item.created_at! - now)).toBeLessThan(1000);
  });

  it("uses Date.now() for non-UUIDv7 custom ids", () => {
    const now = Date.now();
    const item = createMemoryItem({
      id: "custom-non-uuid",
      scope: "test",
      kind: "observation",
      content: {},
      author: "agent:a",
      source_kind: "observed",
      authority: 0.5,
    });
    expect(item.created_at).toBeDefined();
    expect(Math.abs(item.created_at! - now)).toBeLessThan(1000);
  });

  it("preserves explicitly provided created_at", () => {
    const item = createMemoryItem({
      id: "custom-id",
      scope: "test",
      kind: "observation",
      content: {},
      author: "agent:a",
      source_kind: "observed",
      authority: 0.5,
      created_at: 1000000,
    });
    expect(item.created_at).toBe(1000000);
  });

  it("recency sort uses created_at for non-UUIDv7 ids", () => {
    let state = createGraphState();
    // Items with custom IDs but explicit created_at
    const older = makeItem("item-old", { created_at: 1000 });
    const newer = makeItem("item-new", { created_at: 2000 });

    state = applyCommand(state, { type: "memory.create", item: older }).state;
    state = applyCommand(state, { type: "memory.create", item: newer }).state;

    const results = getItems(state, undefined, {
      sort: { field: "recency", order: "desc" },
    });
    expect(results[0].id).toBe("item-new");
    expect(results[1].id).toBe("item-old");
  });

  it("decay uses created_at instead of extracting garbage from non-UUIDv7 id", () => {
    const twoDaysAgo = Date.now() - 2 * 86_400_000;
    let state = createGraphState();
    const item = makeItem("custom-id", {
      authority: 1.0,
      created_at: twoDaysAgo,
    });
    state = applyCommand(state, { type: "memory.create", item }).state;

    const scored = getScoredItems(state, {
      authority: 1,
      decay: { rate: 0.5, interval: "day", type: "exponential" },
    });

    expect(scored).toHaveLength(1);
    // After 2 days at 0.5 rate: 0.25
    expect(scored[0].score).toBeCloseTo(0.25, 1);
  });
});

// ============================================================
// Bug 3: filterContradictions order-dependence
// ============================================================

describe("Bug 3: filterContradictions determinism with chains", () => {
  it("produces consistent results regardless of contradiction edge insertion order", () => {
    const a = makeItem("a", { authority: 0.9 });
    const b = makeItem("b", { authority: 0.7 });
    const c = makeItem("c", { authority: 0.5 });

    // Build state with edges in order: B-C first, then A-B
    let state1 = createGraphState();
    for (const item of [a, b, c]) {
      state1 = applyCommand(state1, { type: "memory.create", item }).state;
    }
    state1 = applyCommand(state1, {
      type: "edge.create",
      edge: makeEdge("e-bc", "b", "c", "CONTRADICTS"),
    }).state;
    state1 = applyCommand(state1, {
      type: "edge.create",
      edge: makeEdge("e-ab", "a", "b", "CONTRADICTS"),
    }).state;

    // Build state with edges in opposite order: A-B first, then B-C
    let state2 = createGraphState();
    for (const item of [a, b, c]) {
      state2 = applyCommand(state2, { type: "memory.create", item }).state;
    }
    state2 = applyCommand(state2, {
      type: "edge.create",
      edge: makeEdge("e-ab", "a", "b", "CONTRADICTS"),
    }).state;
    state2 = applyCommand(state2, {
      type: "edge.create",
      edge: makeEdge("e-bc", "b", "c", "CONTRADICTS"),
    }).state;

    const scored = toScored([a, b, c], [0.9, 0.7, 0.5]);

    const result1 = filterContradictions(state1, scored);
    const result2 = filterContradictions(state2, scored);

    const ids1 = result1.map((s) => s.item.id).sort();
    const ids2 = result2.map((s) => s.item.id).sort();

    expect(ids1).toEqual(ids2);
  });

  it("resolves highest-scoring contradictions first in a chain", () => {
    // A(0.9) contradicts B(0.7) contradicts C(0.5)
    // A-B resolved first: B excluded. Then B-C skipped (B already out). C survives.
    const a = makeItem("a", { authority: 0.9 });
    const b = makeItem("b", { authority: 0.7 });
    const c = makeItem("c", { authority: 0.5 });

    let state = createGraphState();
    for (const item of [a, b, c]) {
      state = applyCommand(state, { type: "memory.create", item }).state;
    }
    state = applyCommand(state, {
      type: "edge.create",
      edge: makeEdge("e-ab", "a", "b", "CONTRADICTS"),
    }).state;
    state = applyCommand(state, {
      type: "edge.create",
      edge: makeEdge("e-bc", "b", "c", "CONTRADICTS"),
    }).state;

    const scored = toScored([a, b, c], [0.9, 0.7, 0.5]);
    const result = filterContradictions(state, scored);
    const ids = result.map((s) => s.item.id).sort();

    // A wins over B (B excluded), C survives because B-C skipped
    expect(ids).toEqual(["a", "c"]);
  });
});

// ============================================================
// Bug 2: skipExistingIds:false crash
// ============================================================

describe("Bug 2: skipExistingIds: false updates instead of crashing", () => {
  it("updates existing memory instead of throwing", () => {
    let targetMem = createGraphState();
    targetMem = applyCommand(targetMem, {
      type: "memory.create",
      item: makeItem("m1", { authority: 0.5 }),
    }).state;

    const slice = {
      memories: [makeItem("m1", { authority: 0.9 })],
      edges: [],
      intents: [],
      tasks: [],
    };

    const result = importSlice(
      targetMem,
      createIntentState(),
      createTaskState(),
      slice,
      { skipExistingIds: false },
    );

    expect(result.memState.items.get("m1")!.authority).toBe(0.9);
    expect(result.report.updated.memories).toEqual(["m1"]);
    expect(result.report.created.memories).toHaveLength(0);
  });

  it("updates existing edge instead of throwing", () => {
    let targetMem = createGraphState();
    targetMem = applyCommand(targetMem, {
      type: "memory.create",
      item: makeItem("m1"),
    }).state;
    targetMem = applyCommand(targetMem, {
      type: "memory.create",
      item: makeItem("m2"),
    }).state;
    targetMem = applyCommand(targetMem, {
      type: "edge.create",
      edge: makeEdge("e1", "m1", "m2", "SUPPORTS"),
    }).state;

    const slice = {
      memories: [],
      edges: [{ ...makeEdge("e1", "m1", "m2", "SUPPORTS"), weight: 0.99 }],
      intents: [],
      tasks: [],
    };

    const result = importSlice(
      targetMem,
      createIntentState(),
      createTaskState(),
      slice,
      { skipExistingIds: false },
    );

    expect(result.memState.edges.get("e1")!.weight).toBe(0.99);
    expect(result.report.updated.edges).toEqual(["e1"]);
  });

  it("updates existing intent instead of throwing", () => {
    let targetIntents = createIntentState();
    targetIntents = applyIntentCommand(targetIntents, {
      type: "intent.create",
      intent: createIntent({
        id: "i1",
        label: "old_label",
        priority: 0.5,
        owner: "user:laz",
      }),
    }).state;

    const slice = {
      memories: [],
      edges: [],
      intents: [
        createIntent({
          id: "i1",
          label: "new_label",
          priority: 0.9,
          owner: "user:laz",
        }),
      ],
      tasks: [],
    };

    const result = importSlice(
      createGraphState(),
      targetIntents,
      createTaskState(),
      slice,
      { skipExistingIds: false },
    );

    expect(result.intentState.intents.get("i1")!.label).toBe("new_label");
    expect(result.intentState.intents.get("i1")!.priority).toBe(0.9);
    expect(result.report.updated.intents).toEqual(["i1"]);
  });

  it("updates existing task instead of throwing", () => {
    let targetTasks = createTaskState();
    targetTasks = applyTaskCommand(targetTasks, {
      type: "task.create",
      task: createTask({
        id: "t1",
        intent_id: "i1",
        action: "old_action",
        priority: 0.5,
      }),
    }).state;

    const slice = {
      memories: [],
      edges: [],
      intents: [],
      tasks: [
        createTask({
          id: "t1",
          intent_id: "i1",
          action: "new_action",
          priority: 0.9,
        }),
      ],
    };

    const result = importSlice(
      createGraphState(),
      createIntentState(),
      targetTasks,
      slice,
      { skipExistingIds: false },
    );

    expect(result.taskState.tasks.get("t1")!.action).toBe("new_action");
    expect(result.taskState.tasks.get("t1")!.priority).toBe(0.9);
    expect(result.report.updated.tasks).toEqual(["t1"]);
  });
});

// ============================================================
// Bug 1: intent_id/task_id remapping in importSlice
// ============================================================

describe("Bug 1: importSlice remaps intent_id/task_id on memories", () => {
  it("remaps memory intent_id when intent is re-id'd", () => {
    const intentId = fakeUuid(1);
    const memId = fakeUuid(2);
    // Target already has a different intent
    let targetIntents = createIntentState();
    targetIntents = applyIntentCommand(targetIntents, {
      type: "intent.create",
      intent: createIntent({
        id: intentId,
        label: "existing_intent",
        priority: 0.5,
        owner: "user:laz",
      }),
    }).state;

    // Slice has a memory referencing the intent and a different intent with same id
    const slice = {
      memories: [makeItem(memId, { intent_id: intentId })],
      edges: [],
      intents: [
        createIntent({
          id: intentId,
          label: "imported_intent",
          priority: 0.9,
          owner: "user:laz",
        }),
      ],
      tasks: [],
    };

    const result = importSlice(
      createGraphState(),
      targetIntents,
      createTaskState(),
      slice,
      { shallowCompareExisting: true, reIdOnDifference: true },
    );

    // The intent should have been re-id'd
    expect(result.report.created.intents).toHaveLength(1);
    const newIntentId = result.report.created.intents[0];
    expect(newIntentId).not.toBe(intentId);

    // The memory's intent_id should now point to the new intent id
    const mem = result.memState.items.get(memId)!;
    expect(mem.intent_id).toBe(newIntentId);
  });

  it("remaps memory task_id when task is re-id'd", () => {
    const taskId = fakeUuid(1);
    const intentId = fakeUuid(2);
    const memId = fakeUuid(3);
    // Target already has a different task
    let targetTasks = createTaskState();
    targetTasks = applyTaskCommand(targetTasks, {
      type: "task.create",
      task: createTask({
        id: taskId,
        intent_id: intentId,
        action: "existing_action",
        priority: 0.5,
      }),
    }).state;

    let targetIntents = createIntentState();
    targetIntents = applyIntentCommand(targetIntents, {
      type: "intent.create",
      intent: createIntent({
        id: intentId,
        label: "intent",
        priority: 0.5,
        owner: "user:laz",
      }),
    }).state;

    const slice = {
      memories: [makeItem(memId, { task_id: taskId })],
      edges: [],
      intents: [],
      tasks: [
        createTask({
          id: taskId,
          intent_id: intentId,
          action: "imported_action",
          priority: 0.9,
        }),
      ],
    };

    const result = importSlice(
      createGraphState(),
      targetIntents,
      targetTasks,
      slice,
      { shallowCompareExisting: true, reIdOnDifference: true },
    );

    // The task should have been re-id'd
    expect(result.report.created.tasks).toHaveLength(1);
    const newTaskId = result.report.created.tasks[0];
    expect(newTaskId).not.toBe(taskId);

    // The memory's task_id should now point to the new task id
    const mem = result.memState.items.get(memId)!;
    expect(mem.task_id).toBe(newTaskId);
  });

  it("remaps both intent_id and task_id when both are re-id'd", () => {
    const intentId = fakeUuid(1);
    const taskId = fakeUuid(2);
    const memId = fakeUuid(3);
    let targetIntents = createIntentState();
    targetIntents = applyIntentCommand(targetIntents, {
      type: "intent.create",
      intent: createIntent({
        id: intentId,
        label: "existing",
        priority: 0.1,
        owner: "user:laz",
      }),
    }).state;

    let targetTasks = createTaskState();
    targetTasks = applyTaskCommand(targetTasks, {
      type: "task.create",
      task: createTask({
        id: taskId,
        intent_id: intentId,
        action: "existing",
        priority: 0.1,
      }),
    }).state;

    const slice = {
      memories: [makeItem(memId, { intent_id: intentId, task_id: taskId })],
      edges: [],
      intents: [
        createIntent({
          id: intentId,
          label: "imported",
          priority: 0.9,
          owner: "user:laz",
        }),
      ],
      tasks: [
        createTask({
          id: taskId,
          intent_id: intentId,
          action: "imported",
          priority: 0.9,
        }),
      ],
    };

    const result = importSlice(
      createGraphState(),
      targetIntents,
      targetTasks,
      slice,
      { shallowCompareExisting: true, reIdOnDifference: true },
    );

    const newIntentId = result.report.created.intents[0];
    const newTaskId = result.report.created.tasks[0];
    const mem = result.memState.items.get(memId)!;

    expect(mem.intent_id).toBe(newIntentId);
    expect(mem.task_id).toBe(newTaskId);
  });
});
