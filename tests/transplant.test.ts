import { describe, it, expect } from "vitest";
import { exportSlice, importSlice } from "../src/transplant.js";
import { createGraphState } from "../src/graph.js";
import { applyCommand } from "../src/reducer.js";
import {
  createIntentState,
  applyIntentCommand,
  createIntent,
} from "../src/intent.js";
import { createTaskState, applyTaskCommand, createTask } from "../src/task.js";
import type { MemoryItem, Edge, GraphState } from "../src/types.js";
import type { IntentState } from "../src/intent.js";
import type { TaskState } from "../src/task.js";

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

function buildState(): {
  mem: GraphState;
  intents: IntentState;
  tasks: TaskState;
} {
  let mem = createGraphState();
  mem = applyCommand(mem, {
    type: "memory.create",
    item: makeItem("m1"),
  }).state;
  mem = applyCommand(mem, {
    type: "memory.create",
    item: makeItem("m2", { parents: ["m1"] }),
  }).state;
  mem = applyCommand(mem, {
    type: "memory.create",
    item: makeItem("m3", { parents: ["m2"] }),
  }).state;
  mem = applyCommand(mem, {
    type: "memory.create",
    item: makeItem("m4"),
  }).state;
  mem = applyCommand(mem, {
    type: "edge.create",
    edge: makeEdge("e1", "m1", "m2"),
  }).state;
  mem = applyCommand(mem, {
    type: "edge.create",
    edge: makeEdge("e2", "m2", "m3"),
  }).state;

  let intents = createIntentState();
  intents = applyIntentCommand(intents, {
    type: "intent.create",
    intent: createIntent({
      id: "i1",
      label: "find_kati",
      priority: 0.9,
      owner: "user:laz",
      root_memory_ids: ["m1"],
    }),
  }).state;

  let tasks = createTaskState();
  tasks = applyTaskCommand(tasks, {
    type: "task.create",
    task: createTask({
      id: "t1",
      intent_id: "i1",
      action: "search",
      priority: 0.8,
      input_memory_ids: ["m1"],
      output_memory_ids: ["m2"],
    }),
  }).state;

  return { mem, intents, tasks };
}

// ============================================================
// Export
// ============================================================

describe("exportSlice", () => {
  it("exports specific memory ids", () => {
    const { mem, intents, tasks } = buildState();
    const slice = exportSlice(mem, intents, tasks, {
      memory_ids: ["m1"],
    });
    expect(slice.memories).toHaveLength(1);
    expect(slice.memories[0].id).toBe("m1");
    expect(slice.edges).toHaveLength(0); // no edges with both ends in slice
    expect(slice.intents).toHaveLength(0);
    expect(slice.tasks).toHaveLength(0);
  });

  it("exports with parents", () => {
    const { mem, intents, tasks } = buildState();
    const slice = exportSlice(mem, intents, tasks, {
      memory_ids: ["m3"],
      include_parents: true,
    });
    expect(slice.memories.map((m) => m.id).sort()).toEqual(["m1", "m2", "m3"]);
    // edges between included items
    expect(slice.edges.length).toBeGreaterThanOrEqual(2);
  });

  it("exports with children", () => {
    const { mem, intents, tasks } = buildState();
    const slice = exportSlice(mem, intents, tasks, {
      memory_ids: ["m1"],
      include_children: true,
    });
    expect(slice.memories.map((m) => m.id).sort()).toEqual(["m1", "m2", "m3"]);
  });

  it("exports related intents and tasks", () => {
    const { mem, intents, tasks } = buildState();
    const slice = exportSlice(mem, intents, tasks, {
      memory_ids: ["m1"],
      include_related_intents: true,
      include_related_tasks: true,
    });
    expect(slice.intents).toHaveLength(1);
    expect(slice.intents[0].id).toBe("i1");
    expect(slice.tasks).toHaveLength(1);
    expect(slice.tasks[0].id).toBe("t1");
  });

  it("exports by intent id with related tasks", () => {
    const { mem, intents, tasks } = buildState();
    const slice = exportSlice(mem, intents, tasks, {
      intent_ids: ["i1"],
      include_related_tasks: true,
    });
    expect(slice.intents).toHaveLength(1);
    expect(slice.tasks).toHaveLength(1);
  });

  it("empty export returns empty slice", () => {
    const { mem, intents, tasks } = buildState();
    const slice = exportSlice(mem, intents, tasks, {});
    expect(slice.memories).toHaveLength(0);
    expect(slice.edges).toHaveLength(0);
    expect(slice.intents).toHaveLength(0);
    expect(slice.tasks).toHaveLength(0);
  });
});

// ============================================================
// Import — default (skip existing ids)
// ============================================================

describe("importSlice (default: skip existing)", () => {
  it("imports into empty state", () => {
    const { mem, intents, tasks } = buildState();
    const slice = exportSlice(mem, intents, tasks, {
      memory_ids: ["m1", "m2"],
      include_related_intents: true,
      include_related_tasks: true,
    });

    const result = importSlice(
      createGraphState(),
      createIntentState(),
      createTaskState(),
      slice,
    );

    expect(result.memState.items.size).toBe(2);
    expect(result.intentState.intents.size).toBe(1);
    expect(result.taskState.tasks.size).toBe(1);
    expect(result.report.created.memories).toHaveLength(2);
    expect(result.report.skipped.memories).toHaveLength(0);
  });

  it("skips existing ids without overwriting", () => {
    const { mem, intents, tasks } = buildState();
    const slice = exportSlice(mem, intents, tasks, {
      memory_ids: ["m1", "m2"],
    });

    // import into state that already has m1
    let targetMem = createGraphState();
    targetMem = applyCommand(targetMem, {
      type: "memory.create",
      item: makeItem("m1", { authority: 0.99 }),
    }).state;

    const result = importSlice(
      targetMem,
      createIntentState(),
      createTaskState(),
      slice,
    );

    expect(result.memState.items.size).toBe(2);
    expect(result.memState.items.get("m1")!.authority).toBe(0.99); // not overwritten
    expect(result.report.created.memories).toEqual(["m2"]);
    expect(result.report.skipped.memories).toEqual(["m1"]);
  });

  it("does not mutate original states", () => {
    const empty = createGraphState();
    const emptyIntents = createIntentState();
    const emptyTasks = createTaskState();
    const slice = {
      memories: [makeItem("m1")],
      edges: [],
      intents: [],
      tasks: [],
    };

    importSlice(empty, emptyIntents, emptyTasks, slice);

    expect(empty.items.size).toBe(0);
  });
});

// ============================================================
// Import — shallow compare + re-id
// ============================================================

describe("importSlice (shallow compare + re-id)", () => {
  it("detects conflicts without re-id", () => {
    let targetMem = createGraphState();
    targetMem = applyCommand(targetMem, {
      type: "memory.create",
      item: makeItem("m1", { authority: 0.99 }),
    }).state;

    const slice = {
      memories: [makeItem("m1", { authority: 0.1 })], // different
      edges: [],
      intents: [],
      tasks: [],
    };

    const result = importSlice(
      targetMem,
      createIntentState(),
      createTaskState(),
      slice,
      { shallowCompareExisting: true },
    );

    expect(result.report.conflicts.memories).toEqual(["m1"]);
    expect(result.report.created.memories).toHaveLength(0);
    expect(result.memState.items.get("m1")!.authority).toBe(0.99); // unchanged
  });

  it("skips silently when shallow-equal", () => {
    const item = makeItem("m1");
    let targetMem = createGraphState();
    targetMem = applyCommand(targetMem, {
      type: "memory.create",
      item,
    }).state;

    const slice = {
      memories: [item], // identical
      edges: [],
      intents: [],
      tasks: [],
    };

    const result = importSlice(
      targetMem,
      createIntentState(),
      createTaskState(),
      slice,
      { shallowCompareExisting: true },
    );

    expect(result.report.skipped.memories).toEqual(["m1"]);
    expect(result.report.conflicts.memories).toHaveLength(0);
  });

  it("re-ids on difference when enabled", () => {
    let targetMem = createGraphState();
    targetMem = applyCommand(targetMem, {
      type: "memory.create",
      item: makeItem("m1", { authority: 0.99 }),
    }).state;

    const slice = {
      memories: [makeItem("m1", { authority: 0.1 })],
      edges: [],
      intents: [],
      tasks: [],
    };

    const result = importSlice(
      targetMem,
      createIntentState(),
      createTaskState(),
      slice,
      { shallowCompareExisting: true, reIdOnDifference: true },
    );

    expect(result.memState.items.size).toBe(2); // original + re-id'd
    expect(result.memState.items.get("m1")!.authority).toBe(0.99); // original untouched
    expect(result.report.created.memories).toHaveLength(1);
    const newId = result.report.created.memories[0];
    expect(newId).not.toBe("m1");
    expect(result.memState.items.get(newId)!.authority).toBe(0.1);
  });
});

// ============================================================
// Round-trip
// ============================================================

describe("export + import round-trip", () => {
  it("round-trips a full chain into empty state", () => {
    const { mem, intents, tasks } = buildState();
    const slice = exportSlice(mem, intents, tasks, {
      memory_ids: ["m1"],
      include_children: true,
      include_related_intents: true,
      include_related_tasks: true,
    });

    const result = importSlice(
      createGraphState(),
      createIntentState(),
      createTaskState(),
      slice,
    );

    expect(result.memState.items.size).toBe(3); // m1, m2, m3
    expect(result.memState.edges.size).toBe(2); // e1, e2
    expect(result.intentState.intents.size).toBe(1);
    expect(result.taskState.tasks.size).toBe(1);
    expect(result.report.created.memories.sort()).toEqual(["m1", "m2", "m3"]);
  });

  it("JSON serializable round-trip", () => {
    const { mem, intents, tasks } = buildState();
    const slice = exportSlice(mem, intents, tasks, {
      memory_ids: ["m1", "m2"],
      include_related_intents: true,
      include_related_tasks: true,
    });

    const json = JSON.stringify(slice);
    const parsed = JSON.parse(json);

    const result = importSlice(
      createGraphState(),
      createIntentState(),
      createTaskState(),
      parsed,
    );

    expect(result.memState.items.size).toBe(2);
    expect(result.intentState.intents.size).toBe(1);
  });
});
