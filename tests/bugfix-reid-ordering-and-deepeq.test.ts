import { describe, it, expect } from "vitest";
import { applyCommand } from "../src/reducer.js";
import { createGraphState } from "../src/graph.js";
import { extractTimestamp } from "../src/query.js";
import { importSlice } from "../src/transplant.js";
import {
  createIntentState,
  applyIntentCommand,
  createIntent,
} from "../src/intent.js";
import { createTaskState, applyTaskCommand, createTask } from "../src/task.js";
import type { MemoryItem, Edge } from "../src/types.js";

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

// ============================================================
// Re-id ordering: child-before-parent in the slice
// ============================================================

describe("re-id pre-pass: child-before-parent ordering", () => {
  it("remaps memory.parents when the parent appears AFTER the child in the slice", () => {
    // Target has colliding memories "m-parent" and "m-child", both different
    // content — both will be re-id'd.
    let target = createGraphState();
    target = applyCommand(target, {
      type: "memory.create",
      item: makeItem("m-parent", { authority: 0.99 }),
    }).state;
    target = applyCommand(target, {
      type: "memory.create",
      item: makeItem("m-child", { authority: 0.99 }),
    }).state;

    // Slice lists child BEFORE parent — the bug made the child's parents
    // array still point at the original "m-parent" id.
    const slice = {
      memories: [
        makeItem("m-child", { authority: 0.1, parents: ["m-parent"] }),
        makeItem("m-parent", { authority: 0.1 }),
      ],
      edges: [],
      intents: [],
      tasks: [],
    };

    const result = importSlice(
      target,
      createIntentState(),
      createTaskState(),
      slice,
      { shallowCompareExisting: true, reIdOnDifference: true },
    );

    expect(result.report.created.memories).toHaveLength(2);
    const createdIds = new Set(result.report.created.memories);

    // Find the re-id'd child and its parent. The new ids must be the
    // re-id'd ones, not "m-parent".
    const newParent = [...result.memState.items.values()].find(
      (i) => i.authority === 0.1 && (!i.parents || i.parents.length === 0),
    )!;
    const newChild = [...result.memState.items.values()].find(
      (i) => i.authority === 0.1 && i.parents && i.parents.length > 0,
    )!;

    expect(createdIds.has(newParent.id)).toBe(true);
    expect(createdIds.has(newChild.id)).toBe(true);
    expect(newChild.parents).toEqual([newParent.id]);
    // The originals in the target are untouched.
    expect(result.memState.items.get("m-parent")!.authority).toBe(0.99);
    expect(result.memState.items.get("m-child")!.authority).toBe(0.99);
  });

  it("remaps intent.parent_id when the parent appears AFTER the child in the slice", () => {
    let targetIntents = createIntentState();
    targetIntents = applyIntentCommand(targetIntents, {
      type: "intent.create",
      intent: createIntent({
        id: "i-parent",
        label: "existing-parent",
        priority: 0.99,
        owner: "user:laz",
      }),
    }).state;
    targetIntents = applyIntentCommand(targetIntents, {
      type: "intent.create",
      intent: createIntent({
        id: "i-child",
        label: "existing-child",
        priority: 0.99,
        owner: "user:laz",
      }),
    }).state;

    // Child listed first, parent second.
    const slice = {
      memories: [],
      edges: [],
      intents: [
        createIntent({
          id: "i-child",
          parent_id: "i-parent",
          label: "imported-child",
          priority: 0.1,
          owner: "user:laz",
        }),
        createIntent({
          id: "i-parent",
          label: "imported-parent",
          priority: 0.1,
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

    expect(result.report.created.intents).toHaveLength(2);

    const allIntents = [...result.intentState.intents.values()];
    const newParent = allIntents.find((i) => i.label === "imported-parent")!;
    const newChild = allIntents.find((i) => i.label === "imported-child")!;

    expect(newChild.parent_id).toBe(newParent.id);
    expect(newChild.parent_id).not.toBe("i-parent");
  });

  it("remaps task.parent_id when the parent appears AFTER the child in the slice", () => {
    let targetIntents = createIntentState();
    targetIntents = applyIntentCommand(targetIntents, {
      type: "intent.create",
      intent: createIntent({
        id: "i1",
        label: "intent",
        priority: 0.5,
        owner: "user:laz",
      }),
    }).state;

    let targetTasks = createTaskState();
    targetTasks = applyTaskCommand(targetTasks, {
      type: "task.create",
      task: createTask({
        id: "t-parent",
        intent_id: "i1",
        action: "existing-parent",
        priority: 0.99,
      }),
    }).state;
    targetTasks = applyTaskCommand(targetTasks, {
      type: "task.create",
      task: createTask({
        id: "t-child",
        intent_id: "i1",
        action: "existing-child",
        priority: 0.99,
      }),
    }).state;

    // Child listed first, parent second.
    const slice = {
      memories: [],
      edges: [],
      intents: [],
      tasks: [
        createTask({
          id: "t-child",
          intent_id: "i1",
          parent_id: "t-parent",
          action: "imported-child",
          priority: 0.1,
        }),
        createTask({
          id: "t-parent",
          intent_id: "i1",
          action: "imported-parent",
          priority: 0.1,
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

    expect(result.report.created.tasks).toHaveLength(2);

    const allTasks = [...result.taskState.tasks.values()];
    const newParent = allTasks.find((t) => t.action === "imported-parent")!;
    const newChild = allTasks.find((t) => t.action === "imported-child")!;

    expect(newChild.parent_id).toBe(newParent.id);
    expect(newChild.parent_id).not.toBe("t-parent");
  });
});

// ============================================================
// shallowCompareExisting via deep value equality
// ============================================================

describe("shallowCompareExisting works on deserialized slices", () => {
  it("skips silently when the slice is JSON-identical but has new object refs", () => {
    // Build a target with a memory that has nested content + meta + parents.
    const stored = makeItem("m1", {
      content: { text: "hello", tags: ["a", "b"] },
      meta: { agent_id: "x", session_id: "s1" },
      parents: ["p1"],
    });
    let target = createGraphState();
    target = applyCommand(target, {
      type: "memory.create",
      item: stored,
    }).state;

    // Simulate a JSON round-trip: the incoming slice has fresh object refs
    // but the same values.
    const roundTripped: MemoryItem = JSON.parse(JSON.stringify(stored));
    expect(roundTripped).not.toBe(stored); // different reference
    expect(roundTripped.content).not.toBe(stored.content); // different nested ref

    const slice = {
      memories: [roundTripped],
      edges: [],
      intents: [],
      tasks: [],
    };

    const result = importSlice(
      target,
      createIntentState(),
      createTaskState(),
      slice,
      { shallowCompareExisting: true },
    );

    // Before the fix, nested-object ref inequality would have produced a
    // conflict (or a re-id under reIdOnDifference).
    expect(result.report.skipped.memories).toEqual(["m1"]);
    expect(result.report.conflicts.memories).toEqual([]);
    expect(result.report.created.memories).toEqual([]);
  });

  it("still detects real content differences in nested fields", () => {
    const stored = makeItem("m1", {
      content: { text: "hello" },
    });
    let target = createGraphState();
    target = applyCommand(target, {
      type: "memory.create",
      item: stored,
    }).state;

    // Same id, different nested content.
    const slice = {
      memories: [makeItem("m1", { content: { text: "world" } })],
      edges: [],
      intents: [],
      tasks: [],
    };

    const result = importSlice(
      target,
      createIntentState(),
      createTaskState(),
      slice,
      { shallowCompareExisting: true },
    );

    expect(result.report.conflicts.memories).toEqual(["m1"]);
    expect(result.report.skipped.memories).toEqual([]);
  });

  it("still detects a change in an array-valued field (parents)", () => {
    const stored = makeItem("m1", { parents: ["p1", "p2"] });
    let target = createGraphState();
    target = applyCommand(target, {
      type: "memory.create",
      item: stored,
    }).state;

    const slice = {
      memories: [makeItem("m1", { parents: ["p1", "p3"] })],
      edges: [],
      intents: [],
      tasks: [],
    };

    const result = importSlice(
      target,
      createIntentState(),
      createTaskState(),
      slice,
      { shallowCompareExisting: true },
    );

    expect(result.report.conflicts.memories).toEqual(["m1"]);
  });

  it("skips an edge whose meta object is structurally identical across refs", () => {
    const edge: Edge = {
      edge_id: "e1",
      from: "m1",
      to: "m2",
      kind: "SUPPORTS",
      author: "agent:a",
      source_kind: "observed",
      authority: 0.8,
      active: true,
      meta: { reason: "because", score: 0.9 },
    };
    let target = createGraphState();
    target = applyCommand(target, {
      type: "memory.create",
      item: makeItem("m1"),
    }).state;
    target = applyCommand(target, {
      type: "memory.create",
      item: makeItem("m2"),
    }).state;
    target = applyCommand(target, {
      type: "edge.create",
      edge,
    }).state;

    const roundTripped: Edge = JSON.parse(JSON.stringify(edge));
    const slice = {
      memories: [],
      edges: [roundTripped],
      intents: [],
      tasks: [],
    };

    const result = importSlice(
      target,
      createIntentState(),
      createTaskState(),
      slice,
      { shallowCompareExisting: true },
    );

    expect(result.report.skipped.edges).toEqual(["e1"]);
    expect(result.report.conflicts.edges).toEqual([]);
  });
});

// ============================================================
// extractTimestamp validates the input
// ============================================================

describe("extractTimestamp validates input", () => {
  it("returns NaN for a short hex-only string that parseInt would accept", () => {
    // Before the fix, "abc" would return 2748 from parseInt.
    expect(Number.isNaN(extractTimestamp("abc"))).toBe(true);
  });

  it("returns NaN for a 32-char hex string whose version nibble is not '7'", () => {
    // Version nibble is at stripped-index 12 (first char of the 3rd group).
    const fakeV4 = "00000000-0000-4000-8000-000000000000";
    expect(Number.isNaN(extractTimestamp(fakeV4))).toBe(true);
  });

  it("returns NaN for the empty string", () => {
    expect(Number.isNaN(extractTimestamp(""))).toBe(true);
  });

  it("still parses a valid uuidv7 timestamp", () => {
    const ms = 0x0123456789ab;
    const hex = ms.toString(16).padStart(12, "0");
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000000`;
    expect(extractTimestamp(id)).toBe(ms);
  });
});
