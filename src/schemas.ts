import { z } from "zod";
import type {
  KnownMemoryKind,
  MemoryItem,
  KnownEdgeKind,
  Edge,
  KnownNamespace,
  EventEnvelope,
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
import type {
  IntentStatus,
  Intent,
  IntentCommand,
  IntentLifecycleEvent,
  IntentFilter,
} from "./intent.js";
import type {
  TaskStatus,
  Task,
  TaskCommand,
  TaskLifecycleEvent,
  TaskFilter,
} from "./task.js";
import type { MemexExport } from "./transplant.js";

// ---------------------------------------------------------------------------
// Memory Item Kind
// ---------------------------------------------------------------------------

export const KnownMemoryKindSchema: z.ZodType<KnownMemoryKind> = z.enum([
  "observation",
  "assertion",
  "assumption",
  "hypothesis",
  "derivation",
  "simulation",
  "policy",
  "trait",
]);

export const MemoryKindSchema = z.string();

// ---------------------------------------------------------------------------
// Source Kind
// ---------------------------------------------------------------------------

export const KnownSourceKindSchema = z.enum([
  "user_explicit",
  "observed",
  "derived_deterministic",
  "agent_inferred",
  "simulated",
  "imported",
]);

export const SourceKindSchema = z.string();

// ---------------------------------------------------------------------------
// MemoryItem
// ---------------------------------------------------------------------------

export const MemoryItemSchema: z.ZodType<MemoryItem> = z.object({
  id: z.string(),
  scope: z.string(),
  kind: MemoryKindSchema,
  content: z.record(z.string(), z.unknown()),

  author: z.string(),
  source_kind: SourceKindSchema,
  parents: z.array(z.string()).optional(),

  authority: z.number().min(0).max(1),
  conviction: z.number().min(0).max(1).optional(),
  importance: z.number().min(0).max(1).optional(),

  created_at: z.number().optional(),

  intent_id: z.string().optional(),
  task_id: z.string().optional(),

  meta: z
    .object({
      agent_id: z.string().optional(),
      session_id: z.string().optional(),
    })
    .catchall(z.unknown())
    .optional(),
});

// ---------------------------------------------------------------------------
// Edge
// ---------------------------------------------------------------------------

export const KnownEdgeKindSchema: z.ZodType<KnownEdgeKind> = z.enum([
  "DERIVED_FROM",
  "CONTRADICTS",
  "SUPPORTS",
  "ABOUT",
  "SUPERSEDES",
  "ALIAS",
]);

export const EdgeKindSchema = z.string();

export const EdgeSchema: z.ZodType<Edge> = z.object({
  edge_id: z.string(),
  from: z.string(),
  to: z.string(),
  kind: EdgeKindSchema,

  weight: z.number().min(0).max(1).optional(),

  author: z.string(),
  source_kind: SourceKindSchema,
  authority: z.number().min(0).max(1),
  active: z.boolean(),

  meta: z.record(z.string(), z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// Event Envelope
// ---------------------------------------------------------------------------

export const KnownNamespaceSchema: z.ZodType<KnownNamespace> = z.enum([
  "memory",
  "task",
  "agent",
  "tool",
  "net",
  "app",
  "chat",
  "system",
  "debug",
]);

export const NamespaceSchema = z.string();

export const EventEnvelopeSchema: z.ZodType<EventEnvelope> = z.object({
  id: z.string(),
  namespace: NamespaceSchema,
  type: z.string(),
  ts: z.string(),
  trace_id: z.string().optional(),
  payload: z.unknown(),
});

// ---------------------------------------------------------------------------
// Memory Commands
// ---------------------------------------------------------------------------

export const MemoryCommandSchema: z.ZodType<MemoryCommand> =
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("memory.create"),
      item: MemoryItemSchema,
    }),
    z.object({
      type: z.literal("memory.update"),
      item_id: z.string(),
      partial: z.record(z.string(), z.unknown()) as z.ZodType<
        Partial<MemoryItem>
      >,
      author: z.string(),
      reason: z.string().optional(),
      basis: z.record(z.string(), z.unknown()).optional(),
    }),
    z.object({
      type: z.literal("memory.retract"),
      item_id: z.string(),
      author: z.string(),
      reason: z.string().optional(),
    }),
    z.object({
      type: z.literal("edge.create"),
      edge: EdgeSchema,
    }),
    z.object({
      type: z.literal("edge.update"),
      edge_id: z.string(),
      partial: z.record(z.string(), z.unknown()) as z.ZodType<Partial<Edge>>,
      author: z.string(),
      reason: z.string().optional(),
    }),
    z.object({
      type: z.literal("edge.retract"),
      edge_id: z.string(),
      author: z.string(),
      reason: z.string().optional(),
    }),
  ]);

// ---------------------------------------------------------------------------
// Memory Lifecycle Events
// ---------------------------------------------------------------------------

export const LifecycleEventTypeSchema: z.ZodType<LifecycleEventType> = z.enum([
  "memory.created",
  "memory.updated",
  "memory.retracted",
  "edge.created",
  "edge.updated",
  "edge.retracted",
]);

export const MemoryLifecycleEventSchema: z.ZodType<MemoryLifecycleEvent> =
  z.object({
    namespace: z.literal("memory"),
    type: LifecycleEventTypeSchema,
    item: MemoryItemSchema.optional(),
    edge: EdgeSchema.optional(),
    cause_type: z.string().optional(),
  });

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export const DecayIntervalSchema: z.ZodType<DecayInterval> = z.enum([
  "hour",
  "day",
  "week",
]);

export const DecayTypeSchema: z.ZodType<DecayType> = z.enum([
  "exponential",
  "linear",
  "step",
]);

export const DecayConfigSchema: z.ZodType<DecayConfig> = z.object({
  rate: z.number().min(0).max(1),
  interval: DecayIntervalSchema,
  type: DecayTypeSchema,
});

const RangeSchema = z.object({
  min: z.number().optional(),
  max: z.number().optional(),
});

export const MemoryFilterSchema: z.ZodType<MemoryFilter> = z.lazy(() =>
  z.object({
    ids: z.array(z.string()).optional(),
    scope: z.string().optional(),
    scope_prefix: z.string().optional(),
    author: z.string().optional(),
    kind: MemoryKindSchema.optional(),
    source_kind: SourceKindSchema.optional(),

    range: z
      .object({
        authority: RangeSchema.optional(),
        conviction: RangeSchema.optional(),
        importance: RangeSchema.optional(),
      })
      .optional(),

    intent_id: z.string().optional(),
    intent_ids: z.array(z.string()).optional(),
    task_id: z.string().optional(),
    task_ids: z.array(z.string()).optional(),

    has_parent: z.string().optional(),
    is_root: z.boolean().optional(),
    parents: z
      .object({
        includes: z.string().optional(),
        includes_any: z.array(z.string()).optional(),
        includes_all: z.array(z.string()).optional(),
        count: RangeSchema.optional(),
      })
      .optional(),

    decay: z
      .object({
        config: DecayConfigSchema,
        min: z.number().min(0).max(1),
      })
      .optional(),
    created: z
      .object({
        before: z.number().optional(),
        after: z.number().optional(),
      })
      .optional(),

    not: z.lazy(() => MemoryFilterSchema).optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
    meta_has: z.array(z.string()).optional(),
    or: z.array(z.lazy(() => MemoryFilterSchema)).optional(),
  }),
);

export const SortFieldSchema: z.ZodType<SortField> = z.enum([
  "authority",
  "conviction",
  "importance",
  "recency",
]);

export const SortOptionSchema: z.ZodType<SortOption> = z.object({
  field: SortFieldSchema,
  order: z.enum(["asc", "desc"]),
});

export const QueryOptionsSchema: z.ZodType<QueryOptions> = z.object({
  sort: z.union([SortOptionSchema, z.array(SortOptionSchema)]).optional(),
  limit: z.number().int().nonnegative().optional(),
  offset: z.number().int().nonnegative().optional(),
});

export const ScoreWeightsSchema: z.ZodType<ScoreWeights> = z.object({
  authority: z.number().optional(),
  conviction: z.number().optional(),
  importance: z.number().optional(),
  decay: DecayConfigSchema.optional(),
});

export const ScoredItemSchema: z.ZodType<ScoredItem> = z.object({
  item: MemoryItemSchema,
  score: z.number(),
  contradicted_by: z.array(MemoryItemSchema).optional(),
});

export const EdgeFilterSchema: z.ZodType<EdgeFilter> = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  kind: EdgeKindSchema.optional(),
  min_weight: z.number().optional(),
  active_only: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Intent
// ---------------------------------------------------------------------------

export const IntentStatusSchema: z.ZodType<IntentStatus> = z.enum([
  "active",
  "paused",
  "completed",
  "cancelled",
]);

export const IntentSchema: z.ZodType<Intent> = z.object({
  id: z.string(),
  parent_id: z.string().optional(),
  label: z.string(),
  description: z.string().optional(),

  priority: z.number().min(0).max(1),
  owner: z.string(),
  status: IntentStatusSchema,

  context: z.record(z.string(), z.unknown()).optional(),
  root_memory_ids: z.array(z.string()).optional(),

  meta: z.record(z.string(), z.unknown()).optional(),
});

export const IntentCommandSchema: z.ZodType<IntentCommand> =
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("intent.create"), intent: IntentSchema }),
    z.object({
      type: z.literal("intent.update"),
      intent_id: z.string(),
      partial: z.record(z.string(), z.unknown()) as z.ZodType<Partial<Intent>>,
      author: z.string(),
      reason: z.string().optional(),
    }),
    z.object({
      type: z.literal("intent.complete"),
      intent_id: z.string(),
      author: z.string(),
      reason: z.string().optional(),
    }),
    z.object({
      type: z.literal("intent.cancel"),
      intent_id: z.string(),
      author: z.string(),
      reason: z.string().optional(),
    }),
    z.object({
      type: z.literal("intent.pause"),
      intent_id: z.string(),
      author: z.string(),
      reason: z.string().optional(),
    }),
    z.object({
      type: z.literal("intent.resume"),
      intent_id: z.string(),
      author: z.string(),
      reason: z.string().optional(),
    }),
  ]);

export const IntentLifecycleEventSchema: z.ZodType<IntentLifecycleEvent> =
  z.object({
    namespace: z.literal("intent"),
    type: z.enum([
      "intent.created",
      "intent.updated",
      "intent.completed",
      "intent.cancelled",
      "intent.paused",
      "intent.resumed",
    ]),
    intent: IntentSchema,
    cause_type: z.string(),
  });

export const IntentFilterSchema: z.ZodType<IntentFilter> = z.object({
  owner: z.string().optional(),
  status: IntentStatusSchema.optional(),
  statuses: z.array(IntentStatusSchema).optional(),
  min_priority: z.number().optional(),
  has_memory_id: z.string().optional(),
  parent_id: z.string().optional(),
  is_root: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

export const TaskStatusSchema: z.ZodType<TaskStatus> = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export const TaskSchema: z.ZodType<Task> = z.object({
  id: z.string(),
  intent_id: z.string(),
  parent_id: z.string().optional(),

  action: z.string(),
  label: z.string().optional(),

  status: TaskStatusSchema,
  priority: z.number().min(0).max(1),

  context: z.record(z.string(), z.unknown()).optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),

  input_memory_ids: z.array(z.string()).optional(),
  output_memory_ids: z.array(z.string()).optional(),

  agent_id: z.string().optional(),
  attempt: z.number().int().nonnegative().optional(),

  meta: z.record(z.string(), z.unknown()).optional(),
});

export const TaskCommandSchema: z.ZodType<TaskCommand> = z.discriminatedUnion(
  "type",
  [
    z.object({ type: z.literal("task.create"), task: TaskSchema }),
    z.object({
      type: z.literal("task.update"),
      task_id: z.string(),
      partial: z.record(z.string(), z.unknown()) as z.ZodType<Partial<Task>>,
      author: z.string(),
    }),
    z.object({
      type: z.literal("task.start"),
      task_id: z.string(),
      agent_id: z.string().optional(),
    }),
    z.object({
      type: z.literal("task.complete"),
      task_id: z.string(),
      result: z.record(z.string(), z.unknown()).optional(),
      output_memory_ids: z.array(z.string()).optional(),
    }),
    z.object({
      type: z.literal("task.fail"),
      task_id: z.string(),
      error: z.string(),
      retryable: z.boolean().optional(),
    }),
    z.object({
      type: z.literal("task.cancel"),
      task_id: z.string(),
      reason: z.string().optional(),
    }),
  ],
);

export const TaskLifecycleEventSchema: z.ZodType<TaskLifecycleEvent> = z.object(
  {
    namespace: z.literal("task"),
    type: z.enum([
      "task.created",
      "task.updated",
      "task.started",
      "task.completed",
      "task.failed",
      "task.cancelled",
    ]),
    task: TaskSchema,
    cause_type: z.string(),
  },
);

export const TaskFilterSchema: z.ZodType<TaskFilter> = z.object({
  intent_id: z.string().optional(),
  action: z.string().optional(),
  status: TaskStatusSchema.optional(),
  statuses: z.array(TaskStatusSchema).optional(),
  agent_id: z.string().optional(),
  min_priority: z.number().optional(),
  has_input_memory_id: z.string().optional(),
  has_output_memory_id: z.string().optional(),
  parent_id: z.string().optional(),
  is_root: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Transplant
// ---------------------------------------------------------------------------

export const MemexExportSchema: z.ZodType<MemexExport> = z.object({
  memories: z.array(MemoryItemSchema),
  edges: z.array(EdgeSchema),
  intents: z.array(IntentSchema),
  tasks: z.array(TaskSchema),
});
