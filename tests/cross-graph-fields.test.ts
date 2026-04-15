import { describe, it, expect } from "vitest";
import { createGraphState } from "../src/graph.js";
import { applyCommand } from "../src/reducer.js";
import { getItems } from "../src/query.js";
import {
  createIntentState,
  createIntent,
  applyIntentCommand,
  getIntents,
  getIntentById,
  getChildIntents,
} from "../src/intent.js";
import {
  createTaskState,
  createTask,
  applyTaskCommand,
  getTasks,
  getTaskById,
  getChildTasks,
} from "../src/task.js";
import { exportSlice, importSlice } from "../src/transplant.js";
import type { MemoryItem, GraphState } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a deterministic UUIDv7-shaped id for testing. */
function fakeUuid(n: number): string {
  const ms = (1700000000000 + n).toString(16).padStart(12, "0");
  return `${ms.slice(0, 8)}-${ms.slice(8, 12)}-7000-8000-${"0".repeat(11)}${n}`;
}

function makeItem(
  id: string,
  overrides: Partial<MemoryItem> = {},
): MemoryItem {
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

function stateWith(items: MemoryItem[]): GraphState {
  let state = createGraphState();
  for (const item of items) {
    state = applyCommand(state, { type: "memory.create", item }).state;
  }
  return state;
}

// =========================================================================
// MemoryFilter: intent_id / task_id exact match
// =========================================================================

describe("MemoryFilter intent_id and task_id", () => {
  it("filters by exact intent_id", () => {
    const state = stateWith([
      makeItem("m1", { intent_id: "i1" }),
      makeItem("m2", { intent_id: "i2" }),
      makeItem("m3"),
    ]);

    const results = getItems(state, { intent_id: "i1" });
    expect(results.map((i) => i.id)).toEqual(["m1"]);
  });

  it("filters by exact task_id", () => {
    const state = stateWith([
      makeItem("m1", { task_id: "t1" }),
      makeItem("m2", { task_id: "t2" }),
      makeItem("m3"),
    ]);

    const results = getItems(state, { task_id: "t1" });
    expect(results.map((i) => i.id)).toEqual(["m1"]);
  });

  it("excludes items without intent_id when filtering", () => {
    const state = stateWith([
      makeItem("m1"),
      makeItem("m2", { intent_id: "i1" }),
    ]);

    const results = getItems(state, { intent_id: "i1" });
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("m2");
  });
});

// =========================================================================
// MemoryFilter: intent_ids / task_ids (any-of)
// =========================================================================

describe("MemoryFilter intent_ids and task_ids", () => {
  it("filters by any of intent_ids", () => {
    const state = stateWith([
      makeItem("m1", { intent_id: "i1" }),
      makeItem("m2", { intent_id: "i2" }),
      makeItem("m3", { intent_id: "i3" }),
      makeItem("m4"),
    ]);

    const results = getItems(state, { intent_ids: ["i1", "i3"] });
    expect(results.map((i) => i.id).sort()).toEqual(["m1", "m3"]);
  });

  it("filters by any of task_ids", () => {
    const state = stateWith([
      makeItem("m1", { task_id: "t1" }),
      makeItem("m2", { task_id: "t2" }),
      makeItem("m3", { task_id: "t3" }),
    ]);

    const results = getItems(state, { task_ids: ["t2", "t3"] });
    expect(results.map((i) => i.id).sort()).toEqual(["m2", "m3"]);
  });

  it("excludes items without task_id when using task_ids filter", () => {
    const state = stateWith([
      makeItem("m1"),
      makeItem("m2", { task_id: "t1" }),
    ]);

    const results = getItems(state, { task_ids: ["t1"] });
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("m2");
  });

  it("combines intent_id and task_id filters (AND)", () => {
    const state = stateWith([
      makeItem("m1", { intent_id: "i1", task_id: "t1" }),
      makeItem("m2", { intent_id: "i1", task_id: "t2" }),
      makeItem("m3", { intent_id: "i2", task_id: "t1" }),
    ]);

    const results = getItems(state, { intent_id: "i1", task_id: "t1" });
    expect(results.map((i) => i.id)).toEqual(["m1"]);
  });
});

// =========================================================================
// IntentFilter: parent_id / is_root
// =========================================================================

describe("IntentFilter parent_id and is_root", () => {
  function setupIntents() {
    let state = createIntentState();
    const root = createIntent({
      id: "i1",
      label: "investigate",
      priority: 0.9,
      owner: "user:laz",
    });
    const child1 = createIntent({
      id: "i2",
      parent_id: "i1",
      label: "find associates",
      priority: 0.7,
      owner: "user:laz",
    });
    const child2 = createIntent({
      id: "i3",
      parent_id: "i1",
      label: "map finances",
      priority: 0.8,
      owner: "user:laz",
    });
    state = applyIntentCommand(state, { type: "intent.create", intent: root }).state;
    state = applyIntentCommand(state, { type: "intent.create", intent: child1 }).state;
    state = applyIntentCommand(state, { type: "intent.create", intent: child2 }).state;
    return state;
  }

  it("filters by parent_id", () => {
    const state = setupIntents();
    const children = getIntents(state, { parent_id: "i1" });
    expect(children.map((i) => i.id).sort()).toEqual(["i2", "i3"]);
  });

  it("is_root: true returns only root intents", () => {
    const state = setupIntents();
    const roots = getIntents(state, { is_root: true });
    expect(roots.map((i) => i.id)).toEqual(["i1"]);
  });

  it("is_root: false returns only child intents", () => {
    const state = setupIntents();
    const children = getIntents(state, { is_root: false });
    expect(children.map((i) => i.id).sort()).toEqual(["i2", "i3"]);
  });

  it("getChildIntents returns children of a parent", () => {
    const state = setupIntents();
    const children = getChildIntents(state, "i1");
    expect(children.map((i) => i.id).sort()).toEqual(["i2", "i3"]);
  });

  it("getChildIntents returns empty for leaf intents", () => {
    const state = setupIntents();
    const children = getChildIntents(state, "i2");
    expect(children).toEqual([]);
  });
});

// =========================================================================
// TaskFilter: parent_id / is_root
// =========================================================================

describe("TaskFilter parent_id and is_root", () => {
  function setupTasks() {
    let state = createTaskState();
    const root = createTask({
      id: "t1",
      intent_id: "i1",
      action: "search",
      priority: 0.9,
    });
    const sub1 = createTask({
      id: "t2",
      intent_id: "i1",
      parent_id: "t1",
      action: "parse_profile",
      priority: 0.7,
    });
    const sub2 = createTask({
      id: "t3",
      intent_id: "i1",
      parent_id: "t1",
      action: "extract_contacts",
      priority: 0.6,
    });
    state = applyTaskCommand(state, { type: "task.create", task: root }).state;
    state = applyTaskCommand(state, { type: "task.create", task: sub1 }).state;
    state = applyTaskCommand(state, { type: "task.create", task: sub2 }).state;
    return state;
  }

  it("filters by parent_id", () => {
    const state = setupTasks();
    const subs = getTasks(state, { parent_id: "t1" });
    expect(subs.map((t) => t.id).sort()).toEqual(["t2", "t3"]);
  });

  it("is_root: true returns only root tasks", () => {
    const state = setupTasks();
    const roots = getTasks(state, { is_root: true });
    expect(roots.map((t) => t.id)).toEqual(["t1"]);
  });

  it("is_root: false returns only subtasks", () => {
    const state = setupTasks();
    const subs = getTasks(state, { is_root: false });
    expect(subs.map((t) => t.id).sort()).toEqual(["t2", "t3"]);
  });

  it("getChildTasks returns children of a parent", () => {
    const state = setupTasks();
    const subs = getChildTasks(state, "t1");
    expect(subs.map((t) => t.id).sort()).toEqual(["t2", "t3"]);
  });

  it("getChildTasks returns empty for leaf tasks", () => {
    const state = setupTasks();
    const subs = getChildTasks(state, "t3");
    expect(subs).toEqual([]);
  });
});

// =========================================================================
// Transplant: parent_id rewriting
// =========================================================================

describe("transplant rewrites parent_id", () => {
  it("rewrites intent parent_id on re-id", () => {
    const parentIntentId = fakeUuid(1);
    const childIntentId = fakeUuid(2);
    const memState = createGraphState();
    let intentState = createIntentState();
    const taskState = createTaskState();

    // create parent intent in destination
    const existing = createIntent({
      id: parentIntentId,
      label: "existing",
      priority: 0.5,
      owner: "user:laz",
    });
    intentState = applyIntentCommand(intentState, {
      type: "intent.create",
      intent: existing,
    }).state;

    // slice has same id but different data, plus a child
    const sliceParent = createIntent({
      id: parentIntentId,
      label: "different",
      priority: 0.9,
      owner: "user:laz",
    });
    const sliceChild = createIntent({
      id: childIntentId,
      parent_id: parentIntentId,
      label: "child",
      priority: 0.7,
      owner: "user:laz",
    });

    const result = importSlice(memState, intentState, taskState, {
      memories: [],
      edges: [],
      intents: [sliceParent, sliceChild],
      tasks: [],
    }, {
      skipExistingIds: true,
      shallowCompareExisting: true,
      reIdOnDifference: true,
    });

    // parent got re-id'd
    const newParentId = result.report.created.intents[0];
    expect(newParentId).not.toBe(parentIntentId);

    // child should reference the new parent id
    const child = result.intentState.intents.get(childIntentId)!;
    expect(child.parent_id).toBe(newParentId);
  });

  it("rewrites task parent_id on re-id", () => {
    const parentTaskId = fakeUuid(1);
    const childTaskId = fakeUuid(2);
    const intentId = fakeUuid(3);
    const memState = createGraphState();
    const intentState = createIntentState();
    let taskState = createTaskState();

    // create parent task in destination
    const existing = createTask({
      id: parentTaskId,
      intent_id: intentId,
      action: "search",
      priority: 0.5,
    });
    taskState = applyTaskCommand(taskState, {
      type: "task.create",
      task: existing,
    }).state;

    // slice has same id but different data, plus a child
    const sliceParent = createTask({
      id: parentTaskId,
      intent_id: intentId,
      action: "different_search",
      priority: 0.9,
    });
    const sliceChild = createTask({
      id: childTaskId,
      intent_id: intentId,
      parent_id: parentTaskId,
      action: "parse",
      priority: 0.7,
    });

    const result = importSlice(memState, intentState, taskState, {
      memories: [],
      edges: [],
      intents: [],
      tasks: [sliceParent, sliceChild],
    }, {
      skipExistingIds: true,
      shallowCompareExisting: true,
      reIdOnDifference: true,
    });

    // parent got re-id'd
    const newParentId = result.report.created.tasks[0];
    expect(newParentId).not.toBe(parentTaskId);

    // child should reference the new parent id
    const child = result.taskState.tasks.get(childTaskId)!;
    expect(child.parent_id).toBe(newParentId);
  });
});
