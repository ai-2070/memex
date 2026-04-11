import { describe, it, expect, beforeEach } from "vitest";
import {
  createTaskState,
  createTask,
  applyTaskCommand,
  getTasks,
  getTaskById,
  getTasksByIntent,
  TaskNotFoundError,
  DuplicateTaskError,
  InvalidTaskTransitionError,
} from "../src/task.js";
import type { Task, TaskState } from "../src/task.js";

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: "t1",
  intent_id: "i1",
  action: "search_linkedin",
  status: "pending",
  priority: 0.7,
  attempt: 0,
  ...overrides,
});

describe("task.create", () => {
  it("creates a task", () => {
    const task = makeTask();
    const { state, events } = applyTaskCommand(createTaskState(), {
      type: "task.create",
      task,
    });
    expect(state.tasks.get("t1")).toEqual(task);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("task.created");
    expect(events[0].namespace).toBe("task");
  });

  it("throws DuplicateTaskError", () => {
    let state = createTaskState();
    state = applyTaskCommand(state, {
      type: "task.create",
      task: makeTask(),
    }).state;
    expect(() =>
      applyTaskCommand(state, { type: "task.create", task: makeTask() }),
    ).toThrow(DuplicateTaskError);
  });

  it("does not mutate original state", () => {
    const state = createTaskState();
    applyTaskCommand(state, { type: "task.create", task: makeTask() });
    expect(state.tasks.size).toBe(0);
  });
});

describe("task.update", () => {
  it("updates priority", () => {
    let state = createTaskState();
    state = applyTaskCommand(state, {
      type: "task.create",
      task: makeTask(),
    }).state;
    const { state: next } = applyTaskCommand(state, {
      type: "task.update",
      task_id: "t1",
      partial: { priority: 0.2 },
      author: "test",
    });
    expect(next.tasks.get("t1")!.priority).toBe(0.2);
  });

  it("throws TaskNotFoundError", () => {
    expect(() =>
      applyTaskCommand(createTaskState(), {
        type: "task.update",
        task_id: "nope",
        partial: {},
        author: "test",
      }),
    ).toThrow(TaskNotFoundError);
  });
});

describe("task lifecycle", () => {
  let state: TaskState;
  beforeEach(() => {
    state = applyTaskCommand(createTaskState(), {
      type: "task.create",
      task: makeTask(),
    }).state;
  });

  it("pending -> running (start)", () => {
    const { state: next, events } = applyTaskCommand(state, {
      type: "task.start",
      task_id: "t1",
      agent_id: "agent:worker",
    });
    expect(next.tasks.get("t1")!.status).toBe("running");
    expect(next.tasks.get("t1")!.agent_id).toBe("agent:worker");
    expect(next.tasks.get("t1")!.attempt).toBe(1);
    expect(events[0].type).toBe("task.started");
  });

  it("running -> completed", () => {
    state = applyTaskCommand(state, {
      type: "task.start",
      task_id: "t1",
    }).state;
    const { state: next, events } = applyTaskCommand(state, {
      type: "task.complete",
      task_id: "t1",
      result: { found: true },
      output_memory_ids: ["m5"],
    });
    expect(next.tasks.get("t1")!.status).toBe("completed");
    expect(next.tasks.get("t1")!.result).toEqual({ found: true });
    expect(next.tasks.get("t1")!.output_memory_ids).toEqual(["m5"]);
    expect(events[0].type).toBe("task.completed");
  });

  it("running -> failed", () => {
    state = applyTaskCommand(state, {
      type: "task.start",
      task_id: "t1",
    }).state;
    const { state: next, events } = applyTaskCommand(state, {
      type: "task.fail",
      task_id: "t1",
      error: "timeout",
    });
    expect(next.tasks.get("t1")!.status).toBe("failed");
    expect(next.tasks.get("t1")!.error).toBe("timeout");
    expect(events[0].type).toBe("task.failed");
  });

  it("failed -> running (retry)", () => {
    state = applyTaskCommand(state, {
      type: "task.start",
      task_id: "t1",
    }).state;
    state = applyTaskCommand(state, {
      type: "task.fail",
      task_id: "t1",
      error: "timeout",
    }).state;
    const { state: next } = applyTaskCommand(state, {
      type: "task.start",
      task_id: "t1",
    });
    expect(next.tasks.get("t1")!.status).toBe("running");
    expect(next.tasks.get("t1")!.attempt).toBe(2);
  });

  it("pending -> cancelled", () => {
    const { state: next, events } = applyTaskCommand(state, {
      type: "task.cancel",
      task_id: "t1",
      reason: "no longer needed",
    });
    expect(next.tasks.get("t1")!.status).toBe("cancelled");
    expect(events[0].type).toBe("task.cancelled");
  });

  it("running -> cancelled", () => {
    state = applyTaskCommand(state, {
      type: "task.start",
      task_id: "t1",
    }).state;
    const { state: next } = applyTaskCommand(state, {
      type: "task.cancel",
      task_id: "t1",
    });
    expect(next.tasks.get("t1")!.status).toBe("cancelled");
  });

  it("completed -> start throws InvalidTaskTransitionError", () => {
    state = applyTaskCommand(state, {
      type: "task.start",
      task_id: "t1",
    }).state;
    state = applyTaskCommand(state, {
      type: "task.complete",
      task_id: "t1",
    }).state;
    expect(() =>
      applyTaskCommand(state, { type: "task.start", task_id: "t1" }),
    ).toThrow(InvalidTaskTransitionError);
  });

  it("completed -> cancel throws InvalidTaskTransitionError", () => {
    state = applyTaskCommand(state, {
      type: "task.start",
      task_id: "t1",
    }).state;
    state = applyTaskCommand(state, {
      type: "task.complete",
      task_id: "t1",
    }).state;
    expect(() =>
      applyTaskCommand(state, { type: "task.cancel", task_id: "t1" }),
    ).toThrow(InvalidTaskTransitionError);
  });

  it("pending -> complete throws InvalidTaskTransitionError", () => {
    expect(() =>
      applyTaskCommand(state, { type: "task.complete", task_id: "t1" }),
    ).toThrow(InvalidTaskTransitionError);
  });
});

describe("createTask factory", () => {
  it("generates id and defaults status/attempt", () => {
    const task = createTask({
      intent_id: "i1",
      action: "search",
      priority: 0.5,
    });
    expect(task.id).toBeDefined();
    expect(task.status).toBe("pending");
    expect(task.attempt).toBe(0);
  });
});

describe("task queries", () => {
  let state: TaskState;
  beforeEach(() => {
    state = createTaskState();
    state = applyTaskCommand(state, {
      type: "task.create",
      task: makeTask({
        id: "t1",
        intent_id: "i1",
        action: "search",
        status: "pending",
        priority: 0.9,
        agent_id: "agent:a",
        input_memory_ids: ["m1"],
      }),
    }).state;
    state = applyTaskCommand(state, {
      type: "task.create",
      task: makeTask({
        id: "t2",
        intent_id: "i1",
        action: "summarize",
        status: "running",
        priority: 0.5,
        agent_id: "agent:b",
      }),
    }).state;
    state = applyTaskCommand(state, {
      type: "task.create",
      task: makeTask({
        id: "t3",
        intent_id: "i2",
        action: "search",
        status: "completed",
        priority: 0.3,
        output_memory_ids: ["m5"],
      }),
    }).state;
  });

  it("returns all tasks with no filter", () => {
    expect(getTasks(state)).toHaveLength(3);
  });

  it("filters by intent_id", () => {
    const result = getTasks(state, { intent_id: "i1" });
    expect(result).toHaveLength(2);
  });

  it("filters by action", () => {
    const result = getTasks(state, { action: "search" });
    expect(result).toHaveLength(2);
  });

  it("filters by status", () => {
    const result = getTasks(state, { status: "running" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("t2");
  });

  it("filters by statuses array", () => {
    const result = getTasks(state, { statuses: ["pending", "running"] });
    expect(result).toHaveLength(2);
  });

  it("filters by agent_id", () => {
    const result = getTasks(state, { agent_id: "agent:a" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("t1");
  });

  it("filters by min_priority", () => {
    const result = getTasks(state, { min_priority: 0.5 });
    expect(result).toHaveLength(2);
  });

  it("filters by has_input_memory_id", () => {
    const result = getTasks(state, { has_input_memory_id: "m1" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("t1");
  });

  it("filters by has_output_memory_id", () => {
    const result = getTasks(state, { has_output_memory_id: "m5" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("t3");
  });

  it("getTaskById works", () => {
    expect(getTaskById(state, "t2")?.action).toBe("summarize");
    expect(getTaskById(state, "nope")).toBeUndefined();
  });

  it("getTasksByIntent works", () => {
    const result = getTasksByIntent(state, "i1");
    expect(result).toHaveLength(2);
  });
});
