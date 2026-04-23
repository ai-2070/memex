// @ai2070/memex — Memory Layer
// Graph of memory items and edges over an append-only event log

export type {
  KnownMemoryKind,
  MemoryKind,
  MemoryItem,
  KnownEdgeKind,
  EdgeKind,
  Edge,
  KnownNamespace,
  Namespace,
  EventEnvelope,
  GraphState,
  MemoryCommand,
  LifecycleEventType,
  MemoryLifecycleEvent,
  MemoryFilter,
  EdgeFilter,
  SortField,
  SortOption,
  QueryOptions,
  DecayInterval,
  DecayType,
  DecayConfig,
  ScoreWeights,
  ScoredItem,
} from "./types.js";

export {
  createMemoryItem,
  createEdge,
  createEventEnvelope,
} from "./helpers.js";
export { createGraphState, cloneGraphState } from "./graph.js";
export {
  MemoryNotFoundError,
  EdgeNotFoundError,
  DuplicateMemoryError,
  DuplicateEdgeError,
  InvalidTimestampError,
} from "./errors.js";
export { applyCommand } from "./reducer.js";
export {
  getItems,
  getEdges,
  getItemById,
  getEdgeById,
  getRelatedItems,
  getParents,
  getChildren,
  getScoredItems,
  extractTimestamp,
} from "./query.js";
export type { ScoredQueryOptions } from "./query.js";
export { applyMany, bulkAdjustScores, decayImportance } from "./bulk.js";
export type { ItemTransform, ScoreAdjustment } from "./bulk.js";
export {
  wrapLifecycleEvent,
  wrapStateEvent,
  wrapEdgeStateEvent,
} from "./envelope.js";
export { replayCommands, replayFromEnvelopes } from "./replay.js";
export type { ReplayFailure } from "./replay.js";
export {
  getContradictions,
  markContradiction,
  resolveContradiction,
  getStaleItems,
  getDependents,
  cascadeRetract,
  markAlias,
  getAliases,
  getAliasGroup,
  getItemsByBudget,
} from "./integrity.js";
export type { Contradiction, StaleItem, BudgetOptions } from "./integrity.js";
export {
  getSupportTree,
  getSupportSet,
  filterContradictions,
  surfaceContradictions,
  applyDiversity,
  smartRetrieve,
} from "./retrieval.js";
export type {
  SupportNode,
  DiversityOptions,
  SmartRetrievalOptions,
} from "./retrieval.js";
export { toJSON, fromJSON, stringify, parse } from "./serialization.js";
export type { SerializedGraphState } from "./serialization.js";
export { getStats } from "./stats.js";
export type { GraphStats } from "./stats.js";

// Intent graph
export {
  createIntentState,
  createIntent,
  applyIntentCommand,
  getIntents,
  getIntentById,
  getChildIntents,
  IntentNotFoundError,
  DuplicateIntentError,
  InvalidIntentTransitionError,
} from "./intent.js";
export type {
  IntentStatus,
  Intent,
  IntentState,
  IntentCommand,
  IntentLifecycleEvent,
  IntentFilter,
} from "./intent.js";

// Task graph
export {
  createTaskState,
  createTask,
  applyTaskCommand,
  getTasks,
  getTaskById,
  getTasksByIntent,
  getChildTasks,
  TaskNotFoundError,
  DuplicateTaskError,
  InvalidTaskTransitionError,
} from "./task.js";
export type {
  TaskStatus,
  Task,
  TaskState,
  TaskCommand,
  TaskLifecycleEvent,
  TaskFilter,
} from "./task.js";

// Transplant (export/import slices)
export { exportSlice, importSlice } from "./transplant.js";
export type {
  ExportOptions,
  MemexExport,
  ImportOptions,
  ImportReport,
} from "./transplant.js";
