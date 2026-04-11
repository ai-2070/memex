import { uuidv7 } from "uuidv7";
import type {
  GraphState,
  MemoryItem,
  Edge,
  MemoryLifecycleEvent,
} from "./types.js";
import type { IntentState, Intent, IntentLifecycleEvent } from "./intent.js";
import type { TaskState, Task, TaskLifecycleEvent } from "./task.js";
import { getChildren, getEdges } from "./query.js";
import { applyCommand } from "./reducer.js";
import { applyIntentCommand } from "./intent.js";
import { applyTaskCommand } from "./task.js";

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface ExportOptions {
  memory_ids?: string[];
  intent_ids?: string[];
  task_ids?: string[];

  include_parents?: boolean;
  include_children?: boolean;
  include_aliases?: boolean;
  include_related_tasks?: boolean;
  include_related_intents?: boolean;
}

export interface MemexExport {
  memories: MemoryItem[];
  edges: Edge[];
  intents: Intent[];
  tasks: Task[];
}

export function exportSlice(
  memState: GraphState,
  intentState: IntentState,
  taskState: TaskState,
  opts: ExportOptions,
): MemexExport {
  const memoryIds = new Set<string>(opts.memory_ids ?? []);
  const intentIds = new Set<string>(opts.intent_ids ?? []);
  const taskIds = new Set<string>(opts.task_ids ?? []);
  const edgeIds = new Set<string>();

  // walk parents up-graph
  if (opts.include_parents) {
    const queue = [...memoryIds];
    while (queue.length > 0) {
      const id = queue.pop()!;
      const item = memState.items.get(id);
      if (item?.parents) {
        for (const pid of item.parents) {
          if (!memoryIds.has(pid)) {
            memoryIds.add(pid);
            queue.push(pid);
          }
        }
      }
    }
  }

  // walk children down-graph
  if (opts.include_children) {
    const queue = [...memoryIds];
    while (queue.length > 0) {
      const id = queue.pop()!;
      const children = getChildren(memState, id);
      for (const child of children) {
        if (!memoryIds.has(child.id)) {
          memoryIds.add(child.id);
          queue.push(child.id);
        }
      }
    }
  }

  // walk aliases
  if (opts.include_aliases) {
    const queue = [...memoryIds];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const id = queue.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const aliasEdges = getEdges(memState, {
        from: id,
        kind: "ALIAS",
        active_only: true,
      });
      for (const edge of aliasEdges) {
        edgeIds.add(edge.edge_id);
        if (!memoryIds.has(edge.to)) {
          memoryIds.add(edge.to);
          queue.push(edge.to);
        }
      }
    }
  }

  // collect edges between included memories
  for (const edge of memState.edges.values()) {
    if (memoryIds.has(edge.from) && memoryIds.has(edge.to)) {
      edgeIds.add(edge.edge_id);
    }
  }

  // walk related intents
  if (opts.include_related_intents) {
    for (const intent of intentState.intents.values()) {
      if (intent.root_memory_ids) {
        for (const mid of intent.root_memory_ids) {
          if (memoryIds.has(mid)) {
            intentIds.add(intent.id);
            break;
          }
        }
      }
    }
    // also check memory meta for creation_intent_id
    for (const mid of memoryIds) {
      const item = memState.items.get(mid);
      if (item?.meta?.creation_intent_id) {
        intentIds.add(item.meta.creation_intent_id as string);
      }
    }
  }

  // walk related tasks
  if (opts.include_related_tasks) {
    for (const task of taskState.tasks.values()) {
      if (intentIds.has(task.intent_id)) {
        taskIds.add(task.id);
        continue;
      }
      const inputMatch = task.input_memory_ids?.some((id) => memoryIds.has(id));
      const outputMatch = task.output_memory_ids?.some((id) =>
        memoryIds.has(id),
      );
      if (inputMatch || outputMatch) {
        taskIds.add(task.id);
      }
    }
    // also check memory meta for creation_task_id
    for (const mid of memoryIds) {
      const item = memState.items.get(mid);
      if (item?.meta?.creation_task_id) {
        taskIds.add(item.meta.creation_task_id as string);
      }
    }
  }

  // collect entities
  const memories: MemoryItem[] = [];
  for (const id of memoryIds) {
    const item = memState.items.get(id);
    if (item) memories.push(item);
  }

  const edges: Edge[] = [];
  for (const id of edgeIds) {
    const edge = memState.edges.get(id);
    if (edge) edges.push(edge);
  }

  const intents: Intent[] = [];
  for (const id of intentIds) {
    const intent = intentState.intents.get(id);
    if (intent) intents.push(intent);
  }

  const tasks: Task[] = [];
  for (const id of taskIds) {
    const task = taskState.tasks.get(id);
    if (task) tasks.push(task);
  }

  return { memories, edges, intents, tasks };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface ImportOptions {
  skipExistingIds?: boolean; // default true
  shallowCompareExisting?: boolean; // default false
  reIdOnDifference?: boolean; // default false
}

export interface ImportReport {
  created: {
    memories: string[];
    intents: string[];
    tasks: string[];
    edges: string[];
  };
  skipped: {
    memories: string[];
    intents: string[];
    tasks: string[];
    edges: string[];
  };
  conflicts: {
    memories: string[];
    intents: string[];
    tasks: string[];
    edges: string[];
  };
}

function shallowEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

function rewriteId(id: string, idMap: Map<string, string>): string {
  return idMap.get(id) ?? id;
}

function rewriteIds(
  ids: string[] | undefined,
  idMap: Map<string, string>,
): string[] | undefined {
  if (!ids) return ids;
  return ids.map((id) => rewriteId(id, idMap));
}

export function importSlice(
  memState: GraphState,
  intentState: IntentState,
  taskState: TaskState,
  slice: MemexExport,
  opts?: ImportOptions,
): {
  memState: GraphState;
  intentState: IntentState;
  taskState: TaskState;
  report: ImportReport;
} {
  const skipExisting = opts?.skipExistingIds ?? true;
  const shallowCompare = opts?.shallowCompareExisting ?? false;
  const reId = opts?.reIdOnDifference ?? false;

  const report: ImportReport = {
    created: { memories: [], intents: [], tasks: [], edges: [] },
    skipped: { memories: [], intents: [], tasks: [], edges: [] },
    conflicts: { memories: [], intents: [], tasks: [], edges: [] },
  };

  // id remapping (only used when reIdOnDifference = true)
  const memIdMap = new Map<string, string>();
  const intentIdMap = new Map<string, string>();
  const taskIdMap = new Map<string, string>();

  let currentMem = memState;
  let currentIntent = intentState;
  let currentTask = taskState;

  // --- import memories ---
  for (const item of slice.memories) {
    const existing = currentMem.items.get(item.id);
    if (existing) {
      if (skipExisting) {
        if (shallowCompare && !shallowEqual(existing as any, item as any)) {
          if (reId) {
            const newId = uuidv7();
            memIdMap.set(item.id, newId);
            const remapped: MemoryItem = {
              ...item,
              id: newId,
              parents: rewriteIds(item.parents, memIdMap),
            };
            const result = applyCommand(currentMem, {
              type: "memory.create",
              item: remapped,
            });
            currentMem = result.state;
            report.created.memories.push(newId);
          } else {
            report.conflicts.memories.push(item.id);
          }
        } else {
          report.skipped.memories.push(item.id);
        }
        continue;
      }
    }
    // no collision — create
    const remapped: MemoryItem = {
      ...item,
      parents: rewriteIds(item.parents, memIdMap),
    };
    const result = applyCommand(currentMem, {
      type: "memory.create",
      item: remapped,
    });
    currentMem = result.state;
    report.created.memories.push(item.id);
  }

  // --- import edges ---
  for (const edge of slice.edges) {
    const existing = currentMem.edges.get(edge.edge_id);
    if (existing && skipExisting) {
      report.skipped.edges.push(edge.edge_id);
      continue;
    }
    const remapped: Edge = {
      ...edge,
      from: rewriteId(edge.from, memIdMap),
      to: rewriteId(edge.to, memIdMap),
    };
    if (existing) {
      // edge id collision — skip
      report.skipped.edges.push(edge.edge_id);
      continue;
    }
    const result = applyCommand(currentMem, {
      type: "edge.create",
      edge: remapped,
    });
    currentMem = result.state;
    report.created.edges.push(edge.edge_id);
  }

  // --- import intents ---
  for (const intent of slice.intents) {
    const existing = currentIntent.intents.get(intent.id);
    if (existing) {
      if (skipExisting) {
        if (
          shallowCompare &&
          !shallowEqual(existing as any, intent as any)
        ) {
          if (reId) {
            const newId = uuidv7();
            intentIdMap.set(intent.id, newId);
            const remapped: Intent = {
              ...intent,
              id: newId,
              root_memory_ids: rewriteIds(
                intent.root_memory_ids,
                memIdMap,
              ),
            };
            const result = applyIntentCommand(currentIntent, {
              type: "intent.create",
              intent: remapped,
            });
            currentIntent = result.state;
            report.created.intents.push(newId);
          } else {
            report.conflicts.intents.push(intent.id);
          }
        } else {
          report.skipped.intents.push(intent.id);
        }
        continue;
      }
    }
    const remapped: Intent = {
      ...intent,
      root_memory_ids: rewriteIds(intent.root_memory_ids, memIdMap),
    };
    const result = applyIntentCommand(currentIntent, {
      type: "intent.create",
      intent: remapped,
    });
    currentIntent = result.state;
    report.created.intents.push(intent.id);
  }

  // --- import tasks ---
  for (const task of slice.tasks) {
    const existing = currentTask.tasks.get(task.id);
    if (existing) {
      if (skipExisting) {
        if (
          shallowCompare &&
          !shallowEqual(existing as any, task as any)
        ) {
          if (reId) {
            const newId = uuidv7();
            taskIdMap.set(task.id, newId);
            const remapped: Task = {
              ...task,
              id: newId,
              intent_id: rewriteId(task.intent_id, intentIdMap),
              input_memory_ids: rewriteIds(
                task.input_memory_ids,
                memIdMap,
              ),
              output_memory_ids: rewriteIds(
                task.output_memory_ids,
                memIdMap,
              ),
            };
            const result = applyTaskCommand(currentTask, {
              type: "task.create",
              task: remapped,
            });
            currentTask = result.state;
            report.created.tasks.push(newId);
          } else {
            report.conflicts.tasks.push(task.id);
          }
        } else {
          report.skipped.tasks.push(task.id);
        }
        continue;
      }
    }
    const remapped: Task = {
      ...task,
      intent_id: rewriteId(task.intent_id, intentIdMap),
      input_memory_ids: rewriteIds(task.input_memory_ids, memIdMap),
      output_memory_ids: rewriteIds(task.output_memory_ids, memIdMap),
    };
    const result = applyTaskCommand(currentTask, {
      type: "task.create",
      task: remapped,
    });
    currentTask = result.state;
    report.created.tasks.push(task.id);
  }

  return {
    memState: currentMem,
    intentState: currentIntent,
    taskState: currentTask,
    report,
  };
}
