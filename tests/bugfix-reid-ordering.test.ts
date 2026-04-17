import { describe, it, expect } from "vitest";
import { applyCommand } from "../src/reducer.js";
import { createGraphState } from "../src/graph.js";
import { importSlice } from "../src/transplant.js";
import {
  createIntentState,
  applyIntentCommand,
  createIntent,
} from "../src/intent.js";
import { createTaskState, applyTaskCommand, createTask } from "../src/task.js";
import type { MemoryItem } from "../src/types.js";

// ============================================================
// Re-id ordering: cross-references must remap regardless of the order
// entities appear in the slice.
//
// Before the pre-pass fix, the id maps (memIdMap / intentIdMap / taskIdMap)
// were populated during the same loop that consumed them, so a child listed
// BEFORE its parent in the slice kept the parent's original (colliding) id
// even though the parent was about to be re-id'd.
// ============================================================

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

describe("importSlice re-id pre-pass fills cross-reference maps before use", () => {
  it("remaps memory.parents when the parent appears AFTER the child in the slice", () => {
    const parentId = fakeUuid(1);
    const childId = fakeUuid(2);

    let target = createGraphState();
    target = applyCommand(target, {
      type: "memory.create",
      item: makeItem(parentId, { authority: 0.99 }),
    }).state;
    target = applyCommand(target, {
      type: "memory.create",
      item: makeItem(childId, { authority: 0.99 }),
    }).state;

    // Child is listed BEFORE parent — both differ from the target, so both
    // get re-id'd.
    const slice = {
      memories: [
        makeItem(childId, { authority: 0.1, parents: [parentId] }),
        makeItem(parentId, { authority: 0.1 }),
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

    // Find the re-id'd entities (authority 0.1 distinguishes them from the
    // targets which still have authority 0.99).
    const imported = [...result.memState.items.values()].filter(
      (i) => i.authority === 0.1,
    );
    const newParent = imported.find(
      (i) => !i.parents || i.parents.length === 0,
    );
    const newChild = imported.find((i) => i.parents && i.parents.length > 0);

    expect(newParent).toBeDefined();
    expect(newChild).toBeDefined();

    // The critical assertion: the child's parents array must point at the
    // *new* parent id, not the colliding original.
    expect(newChild!.parents).toEqual([newParent!.id]);
    expect(newChild!.parents).not.toEqual([parentId]);

    // Originals in the target are untouched.
    expect(result.memState.items.get(parentId)!.authority).toBe(0.99);
    expect(result.memState.items.get(childId)!.authority).toBe(0.99);
  });

  it("remaps intent.parent_id when the parent appears AFTER the child in the slice", () => {
    const parentId = fakeUuid(1);
    const childId = fakeUuid(2);

    let targetIntents = createIntentState();
    targetIntents = applyIntentCommand(targetIntents, {
      type: "intent.create",
      intent: createIntent({
        id: parentId,
        label: "existing-parent",
        priority: 0.99,
        owner: "user:laz",
      }),
    }).state;
    targetIntents = applyIntentCommand(targetIntents, {
      type: "intent.create",
      intent: createIntent({
        id: childId,
        label: "existing-child",
        priority: 0.99,
        owner: "user:laz",
      }),
    }).state;

    const slice = {
      memories: [],
      edges: [],
      intents: [
        createIntent({
          id: childId,
          parent_id: parentId,
          label: "imported-child",
          priority: 0.1,
          owner: "user:laz",
        }),
        createIntent({
          id: parentId,
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

    const all = [...result.intentState.intents.values()];
    const newParent = all.find((i) => i.label === "imported-parent")!;
    const newChild = all.find((i) => i.label === "imported-child")!;

    expect(newChild.parent_id).toBe(newParent.id);
    expect(newChild.parent_id).not.toBe(parentId);
  });

  it("remaps task.parent_id when the parent appears AFTER the child in the slice", () => {
    const intentId = fakeUuid(1);
    const parentId = fakeUuid(2);
    const childId = fakeUuid(3);

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

    let targetTasks = createTaskState();
    targetTasks = applyTaskCommand(targetTasks, {
      type: "task.create",
      task: createTask({
        id: parentId,
        intent_id: intentId,
        action: "existing-parent",
        priority: 0.99,
      }),
    }).state;
    targetTasks = applyTaskCommand(targetTasks, {
      type: "task.create",
      task: createTask({
        id: childId,
        intent_id: intentId,
        action: "existing-child",
        priority: 0.99,
      }),
    }).state;

    const slice = {
      memories: [],
      edges: [],
      intents: [],
      tasks: [
        createTask({
          id: childId,
          intent_id: intentId,
          parent_id: parentId,
          action: "imported-child",
          priority: 0.1,
        }),
        createTask({
          id: parentId,
          intent_id: intentId,
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

    const all = [...result.taskState.tasks.values()];
    const newParent = all.find((t) => t.action === "imported-parent")!;
    const newChild = all.find((t) => t.action === "imported-child")!;

    expect(newChild.parent_id).toBe(newParent.id);
    expect(newChild.parent_id).not.toBe(parentId);
  });
});
