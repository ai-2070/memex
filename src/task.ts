import { uuidv7 } from "uuidv7";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface Task {
  id: string;
  intent_id: string;
  parent_id?: string; // parent task for subtask hierarchies

  action: string; // "search_linkedin", "summarize_case"
  label?: string;

  status: TaskStatus;
  priority: number; // 0..1

  context?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;

  input_memory_ids?: string[];
  output_memory_ids?: string[];

  agent_id?: string;
  attempt?: number;

  meta?: Record<string, unknown>;
}

export interface TaskState {
  tasks: Map<string, Task>;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export function createTaskState(): TaskState {
  return { tasks: new Map() };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTask(
  input: Omit<Task, "id" | "status" | "attempt"> & {
    id?: string;
    status?: TaskStatus;
    attempt?: number;
  },
): Task {
  return {
    ...input,
    id: input.id ?? uuidv7(),
    status: input.status ?? "pending",
    attempt: input.attempt ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export type TaskCommand =
  | { type: "task.create"; task: Task }
  | {
      type: "task.update";
      task_id: string;
      partial: Partial<Task>;
      author: string;
    }
  | { type: "task.start"; task_id: string; agent_id?: string }
  | {
      type: "task.complete";
      task_id: string;
      result?: Record<string, unknown>;
      output_memory_ids?: string[];
    }
  | { type: "task.fail"; task_id: string; error: string; retryable?: boolean }
  | { type: "task.cancel"; task_id: string; reason?: string };

// ---------------------------------------------------------------------------
// Lifecycle events
// ---------------------------------------------------------------------------

export interface TaskLifecycleEvent {
  namespace: "task";
  type:
    | "task.created"
    | "task.updated"
    | "task.started"
    | "task.completed"
    | "task.failed"
    | "task.cancelled";
  task: Task;
  cause_type: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class TaskNotFoundError extends Error {
  constructor(id: string) {
    super(`Task not found: ${id}`);
    this.name = "TaskNotFoundError";
  }
}

export class DuplicateTaskError extends Error {
  constructor(id: string) {
    super(`Task already exists: ${id}`);
    this.name = "DuplicateTaskError";
  }
}

export class InvalidTaskTransitionError extends Error {
  constructor(id: string, from: TaskStatus, to: string) {
    super(`Invalid task transition: ${id} from ${from} to ${to}`);
    this.name = "InvalidTaskTransitionError";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) result[key] = value;
  }
  return result as Partial<T>;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function applyTaskCommand(
  state: TaskState,
  cmd: TaskCommand,
): { state: TaskState; events: TaskLifecycleEvent[] } {
  switch (cmd.type) {
    case "task.create": {
      if (state.tasks.has(cmd.task.id)) {
        throw new DuplicateTaskError(cmd.task.id);
      }
      const tasks = new Map(state.tasks);
      tasks.set(cmd.task.id, cmd.task);
      return {
        state: { tasks },
        events: [
          {
            namespace: "task",
            type: "task.created",
            task: cmd.task,
            cause_type: cmd.type,
          },
        ],
      };
    }

    case "task.update": {
      const existing = state.tasks.get(cmd.task_id);
      if (!existing) throw new TaskNotFoundError(cmd.task_id);
      const { id: _id, status: _status, ...rest } = cmd.partial;
      const updated: Task = { ...existing, ...stripUndefined(rest) };
      const tasks = new Map(state.tasks);
      tasks.set(cmd.task_id, updated);
      return {
        state: { tasks },
        events: [
          {
            namespace: "task",
            type: "task.updated",
            task: updated,
            cause_type: cmd.type,
          },
        ],
      };
    }

    case "task.start": {
      const existing = state.tasks.get(cmd.task_id);
      if (!existing) throw new TaskNotFoundError(cmd.task_id);
      if (existing.status !== "pending" && existing.status !== "failed") {
        throw new InvalidTaskTransitionError(
          cmd.task_id,
          existing.status,
          "running",
        );
      }
      const updated: Task = {
        ...existing,
        status: "running",
        agent_id: cmd.agent_id ?? existing.agent_id,
        attempt: (existing.attempt ?? 0) + 1,
      };
      const tasks = new Map(state.tasks);
      tasks.set(cmd.task_id, updated);
      return {
        state: { tasks },
        events: [
          {
            namespace: "task",
            type: "task.started",
            task: updated,
            cause_type: cmd.type,
          },
        ],
      };
    }

    case "task.complete": {
      const existing = state.tasks.get(cmd.task_id);
      if (!existing) throw new TaskNotFoundError(cmd.task_id);
      if (existing.status !== "running") {
        throw new InvalidTaskTransitionError(
          cmd.task_id,
          existing.status,
          "completed",
        );
      }
      const updated: Task = {
        ...existing,
        status: "completed",
        result: cmd.result ?? existing.result,
        output_memory_ids: cmd.output_memory_ids ?? existing.output_memory_ids,
      };
      const tasks = new Map(state.tasks);
      tasks.set(cmd.task_id, updated);
      return {
        state: { tasks },
        events: [
          {
            namespace: "task",
            type: "task.completed",
            task: updated,
            cause_type: cmd.type,
          },
        ],
      };
    }

    case "task.fail": {
      const existing = state.tasks.get(cmd.task_id);
      if (!existing) throw new TaskNotFoundError(cmd.task_id);
      if (existing.status !== "running") {
        throw new InvalidTaskTransitionError(
          cmd.task_id,
          existing.status,
          "failed",
        );
      }
      const updated: Task = {
        ...existing,
        status: "failed",
        error: cmd.error,
      };
      const tasks = new Map(state.tasks);
      tasks.set(cmd.task_id, updated);
      return {
        state: { tasks },
        events: [
          {
            namespace: "task",
            type: "task.failed",
            task: updated,
            cause_type: cmd.type,
          },
        ],
      };
    }

    case "task.cancel": {
      const existing = state.tasks.get(cmd.task_id);
      if (!existing) throw new TaskNotFoundError(cmd.task_id);
      if (existing.status === "completed" || existing.status === "cancelled") {
        throw new InvalidTaskTransitionError(
          cmd.task_id,
          existing.status,
          "cancelled",
        );
      }
      const updated: Task = {
        ...existing,
        status: "cancelled",
      };
      const tasks = new Map(state.tasks);
      tasks.set(cmd.task_id, updated);
      return {
        state: { tasks },
        events: [
          {
            namespace: "task",
            type: "task.cancelled",
            task: updated,
            cause_type: cmd.type,
          },
        ],
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export interface TaskFilter {
  intent_id?: string;
  action?: string;
  status?: TaskStatus;
  statuses?: TaskStatus[];
  agent_id?: string;
  min_priority?: number;
  has_input_memory_id?: string;
  has_output_memory_id?: string;
  parent_id?: string;
  is_root?: boolean; // true = no parent, false = has parent
}

export function getTasks(state: TaskState, filter?: TaskFilter): Task[] {
  if (!filter) return [...state.tasks.values()];

  const results: Task[] = [];
  for (const task of state.tasks.values()) {
    if (filter.intent_id !== undefined && task.intent_id !== filter.intent_id)
      continue;
    if (filter.action !== undefined && task.action !== filter.action) continue;
    if (filter.status !== undefined && task.status !== filter.status) continue;
    if (filter.statuses !== undefined && !filter.statuses.includes(task.status))
      continue;
    if (filter.agent_id !== undefined && task.agent_id !== filter.agent_id)
      continue;
    if (
      filter.min_priority !== undefined &&
      task.priority < filter.min_priority
    )
      continue;
    if (filter.has_input_memory_id !== undefined) {
      if (
        !task.input_memory_ids ||
        !task.input_memory_ids.includes(filter.has_input_memory_id)
      )
        continue;
    }
    if (filter.has_output_memory_id !== undefined) {
      if (
        !task.output_memory_ids ||
        !task.output_memory_ids.includes(filter.has_output_memory_id)
      )
        continue;
    }
    if (filter.parent_id !== undefined && task.parent_id !== filter.parent_id)
      continue;
    if (filter.is_root !== undefined) {
      const hasParent = task.parent_id !== undefined;
      if (filter.is_root && hasParent) continue;
      if (!filter.is_root && !hasParent) continue;
    }
    results.push(task);
  }
  return results;
}

export function getTaskById(state: TaskState, id: string): Task | undefined {
  return state.tasks.get(id);
}

export function getTasksByIntent(state: TaskState, intentId: string): Task[] {
  return getTasks(state, { intent_id: intentId });
}

export function getChildTasks(
  state: TaskState,
  parentId: string,
): Task[] {
  return getTasks(state, { parent_id: parentId });
}
