import { describe, it, expect } from "vitest";
import { applyCommand } from "../src/reducer.js";
import { createGraphState } from "../src/graph.js";
import { getItems, getScoredItems, extractTimestamp } from "../src/query.js";
import { exportSlice, importSlice } from "../src/transplant.js";
import {
  createIntentState,
  applyIntentCommand,
  createIntent,
  InvalidIntentTransitionError,
} from "../src/intent.js";
import {
  createTaskState,
  applyTaskCommand,
  createTask,
  InvalidTaskTransitionError,
} from "../src/task.js";
import { surfaceContradictions } from "../src/retrieval.js";
import { markContradiction } from "../src/integrity.js";
import type { MemoryItem, Edge, GraphState, ScoredItem } from "../src/types.js";

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

function stateWith(items: MemoryItem[], edges: Edge[] = []): GraphState {
  const s = createGraphState();
  for (const i of items) s.items.set(i.id, i);
  for (const e of edges) s.edges.set(e.edge_id, e);
  return s;
}

function fakeIdAtMs(ms: number): string {
  const hex = ms.toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000000`;
}

// ============================================================
// 1. Export with circular parents
// ============================================================

describe("exportSlice with circular parents", () => {
  it("does not infinite loop on circular parent chain", () => {
    const state = stateWith([
      makeItem("m1", { parents: ["m2"] }),
      makeItem("m2", { parents: ["m1"] }),
    ]);
    const slice = exportSlice(state, createIntentState(), createTaskState(), {
      memory_ids: ["m1"],
      include_parents: true,
    });
    expect(slice.memories.map((m) => m.id).sort()).toEqual(["m1", "m2"]);
  });

  it("does not infinite loop on circular children", () => {
    const state = stateWith([
      makeItem("m1", { parents: ["m2"] }),
      makeItem("m2", { parents: ["m1"] }),
    ]);
    const slice = exportSlice(state, createIntentState(), createTaskState(), {
      memory_ids: ["m1"],
      include_children: true,
    });
    expect(slice.memories.map((m) => m.id).sort()).toEqual(["m1", "m2"]);
  });
});

// ============================================================
// 2. Transplant reIdFor produces valid ids
// ============================================================

describe("transplant reIdFor validity", () => {
  it("re-id'd item has a valid extractable timestamp = original + 1ms", () => {
    const originalMs = Date.now() - 5000; // 5 seconds ago
    const originalId = fakeIdAtMs(originalMs);
    const originalItem = makeItem(originalId, { authority: 0.9 });

    let targetMem = createGraphState();
    targetMem = applyCommand(targetMem, {
      type: "memory.create",
      item: makeItem(originalId, { authority: 0.1 }), // same id, different content
    }).state;

    const slice = {
      memories: [originalItem],
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

    const newId = result.report.created.memories[0];
    const newTs = extractTimestamp(newId);
    expect(newTs).toBe(originalMs + 1);
  });
});

// ============================================================
// 3. Intent: update on completed/cancelled
// ============================================================

describe("intent update on terminal states", () => {
  it("allows updating a completed intent (no status guard on update)", () => {
    let state = createIntentState();
    state = applyIntentCommand(state, {
      type: "intent.create",
      intent: createIntent({
        id: "i1",
        label: "test",
        priority: 0.5,
        owner: "user:laz",
      }),
    }).state;
    state = applyIntentCommand(state, {
      type: "intent.complete",
      intent_id: "i1",
      author: "test",
    }).state;
    // update should work — it's a field update, not a status transition
    const { state: next } = applyIntentCommand(state, {
      type: "intent.update",
      intent_id: "i1",
      partial: { description: "added after completion" },
      author: "test",
    });
    expect(next.intents.get("i1")!.description).toBe("added after completion");
    expect(next.intents.get("i1")!.status).toBe("completed");
  });

  it("allows updating a cancelled intent", () => {
    let state = createIntentState();
    state = applyIntentCommand(state, {
      type: "intent.create",
      intent: createIntent({
        id: "i1",
        label: "test",
        priority: 0.5,
        owner: "user:laz",
      }),
    }).state;
    state = applyIntentCommand(state, {
      type: "intent.cancel",
      intent_id: "i1",
      author: "test",
    }).state;
    const { state: next } = applyIntentCommand(state, {
      type: "intent.update",
      intent_id: "i1",
      partial: { meta: { reason: "post-mortem note" } },
      author: "test",
    });
    expect(next.intents.get("i1")!.meta?.reason).toBe("post-mortem note");
  });
});

// ============================================================
// 4. Task: fail/cancel on invalid states
// ============================================================

describe("task state machine edge cases", () => {
  it("task.fail on pending throws InvalidTaskTransitionError", () => {
    let state = createTaskState();
    state = applyTaskCommand(state, {
      type: "task.create",
      task: createTask({
        id: "t1",
        intent_id: "i1",
        action: "test",
        priority: 0.5,
      }),
    }).state;
    expect(() =>
      applyTaskCommand(state, {
        type: "task.fail",
        task_id: "t1",
        error: "oops",
      }),
    ).toThrow(InvalidTaskTransitionError);
  });

  it("task.fail on cancelled throws InvalidTaskTransitionError", () => {
    let state = createTaskState();
    state = applyTaskCommand(state, {
      type: "task.create",
      task: createTask({
        id: "t1",
        intent_id: "i1",
        action: "test",
        priority: 0.5,
      }),
    }).state;
    state = applyTaskCommand(state, {
      type: "task.cancel",
      task_id: "t1",
    }).state;
    expect(() =>
      applyTaskCommand(state, {
        type: "task.fail",
        task_id: "t1",
        error: "oops",
      }),
    ).toThrow(InvalidTaskTransitionError);
  });

  it("task.update on cancelled task works (field update, not transition)", () => {
    let state = createTaskState();
    state = applyTaskCommand(state, {
      type: "task.create",
      task: createTask({
        id: "t1",
        intent_id: "i1",
        action: "test",
        priority: 0.5,
      }),
    }).state;
    state = applyTaskCommand(state, {
      type: "task.cancel",
      task_id: "t1",
    }).state;
    const { state: next } = applyTaskCommand(state, {
      type: "task.update",
      task_id: "t1",
      partial: { meta: { cancelled_reason: "no longer needed" } },
      author: "test",
    });
    expect(next.tasks.get("t1")!.meta?.cancelled_reason).toBe(
      "no longer needed",
    );
  });
});

// ============================================================
// 5. Reducer: nested undefined in content/meta
// ============================================================

describe("reducer nested undefined handling", () => {
  it("setting content key to undefined preserves it", () => {
    const state = stateWith([makeItem("m1", { content: { a: 1, b: 2 } })]);
    const { state: next } = applyCommand(state, {
      type: "memory.update",
      item_id: "m1",
      partial: { content: { a: undefined, c: 3 } },
      author: "test",
    });
    const content = next.items.get("m1")!.content;
    // setting a to undefined preserves it (no-op)
    expect(content.a).toBe(1);
    expect(content.b).toBe(2);
    expect(content.c).toBe(3);
  });

  it("setting meta key to undefined preserves it", () => {
    const state = stateWith([
      makeItem("m1", { meta: { agent_id: "agent:x", session_id: "s1" } }),
    ]);
    const { state: next } = applyCommand(state, {
      type: "memory.update",
      item_id: "m1",
      partial: { meta: { agent_id: undefined, tag: "new" } },
      author: "test",
    });
    const meta = next.items.get("m1")!.meta!;
    expect(meta.agent_id).toBe("agent:x"); // preserved
    expect(meta.session_id).toBe("s1");
    expect(meta.tag).toBe("new");
  });
});

// ============================================================
// 6. Decay with future items (clock skew)
// ============================================================

describe("decay with future items", () => {
  it("future item gets multiplier of 1 (no decay boost)", () => {
    const futureMs = Date.now() + 60000; // 1 minute in the future
    const futureId = fakeIdAtMs(futureMs);
    const state = stateWith([makeItem(futureId, { authority: 1.0 })]);

    const result = getScoredItems(state, {
      authority: 1.0,
      decay: { rate: 0.5, interval: "day", type: "exponential" },
    });

    // should be exactly 1.0, not boosted above 1.0
    expect(result[0].score).toBe(1.0);
  });

  it("future item passes decay filter (not excluded)", () => {
    const futureMs = Date.now() + 60000;
    const futureId = fakeIdAtMs(futureMs);
    const state = stateWith([makeItem(futureId)]);

    const result = getItems(state, {
      decay: {
        config: { rate: 0.5, interval: "day", type: "exponential" },
        min: 0.5,
      },
    });
    expect(result).toHaveLength(1);
  });
});

// ============================================================
// 7. surfaceContradictions does not mutate input
// ============================================================

describe("surfaceContradictions immutability", () => {
  it("does not mutate the input scored array", () => {
    const state = stateWith([
      makeItem("m1", { authority: 0.9 }),
      makeItem("m2", { authority: 0.7 }),
    ]);
    const { state: marked } = markContradiction(
      state,
      "m1",
      "m2",
      "system:detector",
    );

    const original: ScoredItem[] = [
      { item: marked.items.get("m1")!, score: 0.9 },
      { item: marked.items.get("m2")!, score: 0.7 },
    ];

    // save original state
    const m1Before = { ...original[0] };

    surfaceContradictions(marked, original);

    // original entries should NOT have contradicted_by
    expect(original[0].contradicted_by).toBeUndefined();
    expect(original[1].contradicted_by).toBeUndefined();
    expect(original[0].score).toBe(m1Before.score);
  });
});

// ============================================================
// 8. Export/import with circular parents round-trip
// ============================================================

describe("transplant with circular parents", () => {
  it("exports and imports circular parent chain", () => {
    const state = stateWith([
      makeItem("m1", { parents: ["m2"] }),
      makeItem("m2", { parents: ["m1"] }),
    ]);

    const slice = exportSlice(state, createIntentState(), createTaskState(), {
      memory_ids: ["m1"],
      include_parents: true,
    });

    const result = importSlice(
      createGraphState(),
      createIntentState(),
      createTaskState(),
      slice,
    );

    expect(result.memState.items.size).toBe(2);
    expect(result.memState.items.get("m1")!.parents).toEqual(["m2"]);
    expect(result.memState.items.get("m2")!.parents).toEqual(["m1"]);
  });
});
