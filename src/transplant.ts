import { uuidv7 } from "uuidv7";
import type {
  GraphState,
  MemoryItem,
  Edge,
  MemoryLifecycleEvent,
} from "./types.js";
import type { IntentState, Intent, IntentLifecycleEvent } from "./intent.js";
import type { TaskState, Task, TaskLifecycleEvent } from "./task.js";
import { getChildren, getEdges, extractTimestamp } from "./query.js";
import { applyCommand } from "./reducer.js";
import { applyIntentCommand } from "./intent.js";
import { applyTaskCommand } from "./task.js";

/**
 * Build a uuidv7-shaped id from a given ms timestamp + random suffix.
 */
function uuidFromMs(ms: number): string {
  const hex = ms.toString(16).padStart(12, "0");
  const rand = uuidv7().replace(/-/g, "");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    "7" + rand.slice(13, 16),
    rand.slice(16, 20),
    rand.slice(20, 32),
  ].join("-");
}

/**
 * Generate a new id 1ms after the original, incrementing until no collision.
 * Accepts an optional created_at timestamp to use when the id is not a valid UUIDv7.
 */
function reIdFor(
  originalId: string,
  existingIds: Set<string>,
  createdAt?: number,
): string {
  let ms = createdAt ?? extractTimestamp(originalId);
  ms += 1;
  let newId = uuidFromMs(ms);
  while (existingIds.has(newId)) {
    ms++;
    newId = uuidFromMs(ms);
  }
  return newId;
}

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
      const forwardAliases = getEdges(memState, {
        from: id,
        kind: "ALIAS",
        active_only: true,
      });
      for (const edge of forwardAliases) {
        edgeIds.add(edge.edge_id);
        if (!memoryIds.has(edge.to)) {
          memoryIds.add(edge.to);
          queue.push(edge.to);
        }
      }
      const reverseAliases = getEdges(memState, {
        to: id,
        kind: "ALIAS",
        active_only: true,
      });
      for (const edge of reverseAliases) {
        edgeIds.add(edge.edge_id);
        if (!memoryIds.has(edge.from)) {
          memoryIds.add(edge.from);
          queue.push(edge.from);
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
    // also check memory items for linked intent
    for (const mid of memoryIds) {
      const item = memState.items.get(mid);
      if (item?.intent_id) intentIds.add(item.intent_id);
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
    // also check memory items for linked task
    for (const mid of memoryIds) {
      const item = memState.items.get(mid);
      if (item?.task_id) taskIds.add(item.task_id);
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
  updated: {
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
  const doReId = opts?.reIdOnDifference ?? false;

  const report: ImportReport = {
    created: { memories: [], intents: [], tasks: [], edges: [] },
    updated: { memories: [], intents: [], tasks: [], edges: [] },
    skipped: { memories: [], intents: [], tasks: [], edges: [] },
    conflicts: { memories: [], intents: [], tasks: [], edges: [] },
  };

  // id remapping (only used when reIdOnDifference = true)
  const memIdMap = new Map<string, string>();
  const intentIdMap = new Map<string, string>();
  const taskIdMap = new Map<string, string>();

  // track all known ids for collision-free re-id generation
  const allMemIds = new Set(memState.items.keys());
  const allIntentIds = new Set(intentState.intents.keys());
  const allTaskIds = new Set(taskState.tasks.keys());

  let currentMem = memState;
  let currentIntent = intentState;
  let currentTask = taskState;

  // --- import memories ---
  for (const item of slice.memories) {
    const existing = currentMem.items.get(item.id);
    if (existing) {
      if (skipExisting) {
        if (shallowCompare && !shallowEqual(existing as any, item as any)) {
          if (doReId) {
            const newId = reIdFor(item.id, allMemIds, item.created_at);
            allMemIds.add(newId);
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
      // skipExisting is false — update existing item
      const { id: _id, ...rest } = item;
      const result = applyCommand(currentMem, {
        type: "memory.update",
        item_id: item.id,
        partial: { ...rest, parents: rewriteIds(item.parents, memIdMap) },
        author: item.author,
      });
      currentMem = result.state;
      report.updated.memories.push(item.id);
      continue;
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

  // track all known edge ids for collision-free re-id generation
  const allEdgeIds = new Set(currentMem.edges.keys());

  // --- import edges ---
  for (const edge of slice.edges) {
    const existing = currentMem.edges.get(edge.edge_id);
    if (existing) {
      if (skipExisting) {
        if (shallowCompare && !shallowEqual(existing as any, edge as any)) {
          if (doReId) {
            const newId = reIdFor(edge.edge_id, allEdgeIds);
            allEdgeIds.add(newId);
            const remapped: Edge = {
              ...edge,
              edge_id: newId,
              from: rewriteId(edge.from, memIdMap),
              to: rewriteId(edge.to, memIdMap),
            };
            const result = applyCommand(currentMem, {
              type: "edge.create",
              edge: remapped,
            });
            currentMem = result.state;
            report.created.edges.push(newId);
          } else {
            report.conflicts.edges.push(edge.edge_id);
          }
        } else {
          report.skipped.edges.push(edge.edge_id);
        }
        continue;
      }
      // skipExisting is false — update existing edge
      const { edge_id: _eid, from: _from, to: _to, ...edgeRest } = edge;
      const result = applyCommand(currentMem, {
        type: "edge.update",
        edge_id: edge.edge_id,
        partial: edgeRest,
        author: edge.author,
      });
      currentMem = result.state;
      report.updated.edges.push(edge.edge_id);
      continue;
    }
    // no collision — create
    const remapped: Edge = {
      ...edge,
      from: rewriteId(edge.from, memIdMap),
      to: rewriteId(edge.to, memIdMap),
    };
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
        if (shallowCompare && !shallowEqual(existing as any, intent as any)) {
          if (doReId) {
            const newId = reIdFor(intent.id, allIntentIds);
            allIntentIds.add(newId);
            intentIdMap.set(intent.id, newId);
            const remapped: Intent = {
              ...intent,
              id: newId,
              parent_id: intent.parent_id
                ? rewriteId(intent.parent_id, intentIdMap)
                : undefined,
              root_memory_ids: rewriteIds(intent.root_memory_ids, memIdMap),
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
      // skipExisting is false — update existing intent
      const { id: _iid, status: _istatus, ...intentRest } = intent;
      const result = applyIntentCommand(currentIntent, {
        type: "intent.update",
        intent_id: intent.id,
        partial: {
          ...intentRest,
          parent_id: intent.parent_id
            ? rewriteId(intent.parent_id, intentIdMap)
            : undefined,
          root_memory_ids: rewriteIds(intent.root_memory_ids, memIdMap),
        },
        author: intent.owner,
      });
      currentIntent = result.state;
      report.updated.intents.push(intent.id);
      continue;
    }
    const remapped: Intent = {
      ...intent,
      parent_id: intent.parent_id
        ? rewriteId(intent.parent_id, intentIdMap)
        : undefined,
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
        if (shallowCompare && !shallowEqual(existing as any, task as any)) {
          if (doReId) {
            const newId = reIdFor(task.id, allTaskIds);
            allTaskIds.add(newId);
            taskIdMap.set(task.id, newId);
            const remapped: Task = {
              ...task,
              id: newId,
              intent_id: rewriteId(task.intent_id, intentIdMap),
              parent_id: task.parent_id
                ? rewriteId(task.parent_id, taskIdMap)
                : undefined,
              input_memory_ids: rewriteIds(task.input_memory_ids, memIdMap),
              output_memory_ids: rewriteIds(task.output_memory_ids, memIdMap),
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
      // skipExisting is false — update existing task
      const { id: _tid, status: _tstatus, ...taskRest } = task;
      const result = applyTaskCommand(currentTask, {
        type: "task.update",
        task_id: task.id,
        partial: {
          ...taskRest,
          intent_id: rewriteId(task.intent_id, intentIdMap),
          parent_id: task.parent_id
            ? rewriteId(task.parent_id, taskIdMap)
            : undefined,
          input_memory_ids: rewriteIds(task.input_memory_ids, memIdMap),
          output_memory_ids: rewriteIds(task.output_memory_ids, memIdMap),
        },
        author: task.agent_id ?? "system:import",
      });
      currentTask = result.state;
      report.updated.tasks.push(task.id);
      continue;
    }
    const remapped: Task = {
      ...task,
      intent_id: rewriteId(task.intent_id, intentIdMap),
      parent_id: task.parent_id
        ? rewriteId(task.parent_id, taskIdMap)
        : undefined,
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

  // --- second pass: remap intent_id / task_id on imported memories ---
  if (intentIdMap.size > 0 || taskIdMap.size > 0) {
    const importedMemIds = [
      ...report.created.memories,
      ...report.updated.memories,
    ];
    for (const memId of importedMemIds) {
      const item = currentMem.items.get(memId);
      if (!item) continue;
      const newIntentId = item.intent_id
        ? intentIdMap.get(item.intent_id)
        : undefined;
      const newTaskId = item.task_id
        ? taskIdMap.get(item.task_id)
        : undefined;
      if (newIntentId || newTaskId) {
        const partial: Partial<MemoryItem> = {};
        if (newIntentId) partial.intent_id = newIntentId;
        if (newTaskId) partial.task_id = newTaskId;
        const result = applyCommand(currentMem, {
          type: "memory.update",
          item_id: memId,
          partial,
          author: "system:import",
        });
        currentMem = result.state;
      }
    }
  }

  return {
    memState: currentMem,
    intentState: currentIntent,
    taskState: currentTask,
    report,
  };
}
