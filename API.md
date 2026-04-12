# API Reference

## Types

### MemoryItem

The core node in the graph.

```ts
interface MemoryItem {
  id: string;                    // uuidv7
  scope: string;                 // e.g. "user:laz/general", "project:cyberdeck"
  kind: MemoryKind;              // what it is
  content: Record<string, unknown>;

  author: string;                // "user:laz", "agent:reasoner", "system:rule_x"
  source_kind: SourceKind;       // how it got here
  parents?: string[];            // item ids this was derived/inferred from

  authority: number;             // 0..1 -- how much should the system trust this?
  conviction?: number;           // 0..1 -- how sure was the author?
  importance?: number;           // 0..1 -- how much attention does this need right now? (salience)

  intent_id?: string;            // intent that produced this item
  task_id?: string;              // task that produced this item

  meta?: {
    agent_id?: string;
    session_id?: string;
    [key: string]: unknown;
  };
}
```

**`kind`** -- what the item is:

| Kind | Meaning |
|------|---------|
| `observation` | Directly witnessed / sensed |
| `assertion` | Stated as true by an author |
| `assumption` | Believed but not verified |
| `hypothesis` | Proposed explanation, testable |
| `derivation` | Deterministically computed from other items |
| `simulation` | Output of a hypothetical scenario |
| `policy` | A rule or guideline |
| `trait` | A persistent characteristic |

Accepts arbitrary strings beyond the known set.

**`source_kind`** -- how the item got here:

| Source Kind | Meaning |
|-------------|---------|
| `user_explicit` | User directly stated it |
| `observed` | System observed it |
| `derived_deterministic` | Computed from other items via rules |
| `agent_inferred` | Agent reasoned it |
| `simulated` | Produced by simulation |
| `imported` | Imported from external source |

### Edge

Typed relationship between items.

```ts
interface Edge {
  edge_id: string;
  from: string;                  // item id
  to: string;                   // item id
  kind: EdgeKind;                // relationship type
  weight?: number;
  author: string;
  source_kind: SourceKind;
  authority: number;
  active: boolean;
  meta?: Record<string, unknown>;
}
```

**Edge kinds:**

| Kind | Meaning |
|------|---------|
| `DERIVED_FROM` | Source was derived from target (external/after-the-fact) |
| `CONTRADICTS` | Two items assert conflicting things |
| `SUPPORTS` | Source provides evidence for target |
| `ABOUT` | Source is about / references target |
| `SUPERSEDES` | Source replaces target (conflict resolution) |
| `ALIAS` | Both items refer to the same entity |

**`parents` vs `DERIVED_FROM`:**

- **`parents`** (on MemoryItem) is the source of truth for provenance. It means "this item was created from these inputs." It's structural — set at creation time, used by `getParents`, `getChildren`, `getSupportTree`, `cascadeRetract`, and the `has_parent`/`is_root` filters.
- **`DERIVED_FROM`** (edge) is for relationships added after the fact — "we later discovered that item A was influenced by item B." It's relational, not structural.

Use `parents` when creating derived items. Use `DERIVED_FROM` edges when annotating relationships between existing items that weren't captured at creation time.

### EventEnvelope

Common wrapper for all events on the bus.

```ts
interface EventEnvelope<T = unknown> {
  id: string;                    // uuidv7
  namespace: Namespace;          // "memory", "task", "agent", "tool", "net", "app", "chat", "system", "debug"
  type: string;
  ts: string;                   // ISO-8601
  trace_id?: string;
  payload: T;
}
```

### GraphState

```ts
interface GraphState {
  items: Map<string, MemoryItem>;
  edges: Map<string, Edge>;
}
```

---

## Factories

### createMemoryItem(input)

Creates a `MemoryItem` with auto-generated `id` (uuidv7). Validates scores are in [0, 1].

```ts
const item = createMemoryItem({
  scope: "user:laz/general",
  kind: "observation",
  content: { key: "theme", value: "dark" },
  author: "user:laz",
  source_kind: "user_explicit",
  authority: 0.9,
});
```

### createEdge(input)

Creates an `Edge` with auto-generated `edge_id`. Defaults `active` to `true`.

### createEventEnvelope(type, payload, opts?)

Creates an `EventEnvelope` with `namespace: "memory"`, auto-generated id and timestamp.

### createGraphState()

Returns an empty `GraphState`.

### cloneGraphState(state)

Shallow-clones a `GraphState` (new Maps, same entries).

---

## Reducer

### applyCommand(state, cmd)

Pure function. Takes a `GraphState` and a `MemoryCommand`, returns a new state and lifecycle events.

```ts
const { state, events } = applyCommand(state, {
  type: "memory.create",
  item: myItem,
});
```

**Commands:**

| Command | Fields | Lifecycle Event |
|---------|--------|-----------------|
| `memory.create` | `item: MemoryItem` | `memory.created` |
| `memory.update` | `item_id`, `partial`, `author`, `reason?`, `basis?` | `memory.updated` |
| `memory.retract` | `item_id`, `author`, `reason?` | `memory.retracted` |
| `edge.create` | `edge: Edge` | `edge.created` |
| `edge.update` | `edge_id`, `partial`, `author`, `reason?` | `edge.updated` |
| `edge.retract` | `edge_id`, `author`, `reason?` | `edge.retracted` |

**Merge behavior:**
- `content` is shallow-merged (`{ ...existing.content, ...partial.content }`)
- `meta` is shallow-merged (`{ ...existing.meta, ...partial.meta }`)
- `undefined` values in partials are ignored (field is not changed)
- `id` in partials is ignored (cannot change item identity)
- All other fields are replaced

**Errors:** `DuplicateMemoryError`, `MemoryNotFoundError`, `DuplicateEdgeError`, `EdgeNotFoundError`.

---

## Queries

### getItems(state, filter?, options?)

Returns items matching a filter, with optional sort/limit/offset.

```ts
const items = getItems(state, {
  scope_prefix: "user:laz/",
  or: [{ kind: "observation" }, { kind: "assertion" }],
  range: { authority: { min: 0.5 } },
}, {
  sort: [
    { field: "authority", order: "desc" },
    { field: "recency", order: "desc" },
  ],
  limit: 10,
});
```

### MemoryFilter

All fields are optional and AND-combined.

```ts
interface MemoryFilter {
  ids?: string[];                // match any of these item ids
  scope?: string;                // exact match
  scope_prefix?: string;         // starts with, e.g. "project:"
  author?: string;
  kind?: MemoryKind;
  source_kind?: SourceKind;

  intent_id?: string;            // exact match on intent_id
  intent_ids?: string[];         // match any of these intent_ids
  task_id?: string;              // exact match on task_id
  task_ids?: string[];           // match any of these task_ids

  range?: {
    authority?: { min?: number; max?: number };
    conviction?: { min?: number; max?: number };
    importance?: { min?: number; max?: number };
  };

  has_parent?: string;           // sugar for parents.includes
  is_root?: boolean;             // sugar for parents.count.max = 0
  parents?: {                    // advanced parent query
    includes?: string;           // has this parent
    includes_any?: string[];     // has at least one of these parents
    includes_all?: string[];     // has all of these parents
    count?: { min?: number; max?: number };
  };

  decay?: {                      // exclude items that have decayed too much
    config: DecayConfig;
    min: number;                 // 0..1 — minimum decay multiplier to keep
  };

  created?: {                    // filter by creation time (from uuidv7 id)
    before?: number;             // unix ms
    after?: number;              // unix ms
  };

  not?: MemoryFilter;            // exclude items matching this filter
  meta?: Record<string, unknown>;// dot-path exact match
  meta_has?: string[];           // dot-paths that must exist
  or?: MemoryFilter[];           // match if ANY sub-filter matches
}
```

### DecayConfig

Used in both filters (exclude decayed items) and scoring (decay-adjusted ranking).

```ts
interface DecayConfig {
  rate: number;                  // 0..1 — how much to decay per interval
  interval: "hour" | "day" | "week";
  type: "exponential" | "linear" | "step";
}
```

**Examples:**

```ts
// filter by specific ids (e.g. from vector search results)
{ ids: ["m1", "m3", "m5"] }

// all project scopes
{ scope_prefix: "project:" }

// observations OR assertions
{ or: [{ kind: "observation" }, { kind: "assertion" }] }

// authority between 0.3 and 0.9
{ range: { authority: { min: 0.3, max: 0.9 } } }

// items derived from m1 AND m2
{ parents: { includes_all: ["m1", "m2"] } }

// items with at least 2 parents
{ parents: { count: { min: 2 } } }

// exclude items that have decayed below 50%
// (older than ~1 day at 50%/day exponential)
{ decay: { config: { rate: 0.5, interval: "day", type: "exponential" }, min: 0.5 } }

// exclude hypotheses and simulations
{ not: { or: [{ kind: "hypothesis" }, { kind: "simulation" }] } }

// nested meta dot-path
{ meta: { "tags.env": "prod" } }

// field must exist, but not be this value
{ meta_has: ["agent_id"], not: { meta: { agent_id: "agent:bad" } } }

// items derived from a specific parent
{ has_parent: "m1" }

// root items only (no parents)
{ is_root: true }

// items older than 24 hours
{ created: { before: Date.now() - 86400000 } }

// items created in the last hour
{ created: { after: Date.now() - 3600000 } }
```

### QueryOptions

```ts
interface SortOption {
  field: "authority" | "conviction" | "importance" | "recency";
  order: "asc" | "desc";
}

interface QueryOptions {
  sort?: SortOption | SortOption[];  // single or multi-sort (first = primary)
  limit?: number;
  offset?: number;
}
```

`"recency"` sorts by creation time, extracted from the uuidv7 id.

```ts
// single sort
{ sort: { field: "authority", order: "desc" } }

// multi-sort: authority desc, then recency as tiebreaker
{ sort: [
  { field: "authority", order: "desc" },
  { field: "recency", order: "desc" },
] }
```

### getEdges(state, filter?)

Returns edges. Defaults to `active_only: true`.

```ts
interface EdgeFilter {
  from?: string;
  to?: string;
  kind?: EdgeKind;
  min_weight?: number;
  active_only?: boolean;         // default: true
}
```

### getItemById(state, id) / getEdgeById(state, edgeId)

Direct lookup by id.

### getRelatedItems(state, itemId, direction?)

Items connected via active edges. `direction`: `"from"`, `"to"`, or `"both"` (default).

### getParents(state, itemId)

Returns items listed in `parents` of the given item.

### getChildren(state, itemId)

Returns items that have the given item in their `parents`.

### extractTimestamp(uuidv7Id)

Extracts millisecond unix timestamp from a uuidv7 id.

```ts
const ms = extractTimestamp(item.id);
const date = new Date(ms);
```

---

## Scored Retrieval

### getScoredItems(state, weights, options?)

Scores items by a weighted combination of authority, conviction, and importance, with optional time-based decay. Returns `{ item, score }[]` sorted by score descending.

```ts
interface ScoreWeights {
  authority?: number;            // multiplier
  conviction?: number;
  importance?: number;
  decay?: DecayConfig;           // time-based score decay (applied at query time)
}

interface ScoredQueryOptions {
  pre?: MemoryFilter;            // filter before scoring
  post?: MemoryFilter;           // filter after scoring
  min_score?: number;            // drop items below threshold
  limit?: number;
  offset?: number;
}
```

**Pipeline:** `pre-filter -> score (with decay) -> min_score -> post-filter -> offset/limit`

```ts
// scored retrieval with time decay
const ranked = getScoredItems(
  state,
  {
    authority: 0.5,
    conviction: 0.3,
    importance: 0.2,
    decay: { rate: 0.1, interval: "day", type: "exponential" },
  },
  {
    pre: { scope: "user:laz/general" },
    min_score: 0.3,
    post: { not: { kind: "simulation" } },
    limit: 10,
  },
);
```

**Decay types:**

| Type | Formula | Behavior |
|------|---------|----------|
| `exponential` | `(1 - rate) ^ intervals` | Smooth curve, never reaches zero |
| `linear` | `max(0, 1 - rate * intervals)` | Straight line to zero |
| `step` | `(1 - rate) ^ floor(intervals)` | Drops at each interval boundary |

Decay is computed at query time from the uuidv7 id timestamp. Stored `importance` is not mutated.

### getItemsByBudget(state, options)

Greedy knapsack: pack the highest-scoring items that fit within a cost budget.

```ts
interface BudgetOptions {
  budget: number;                // total budget
  costFn: (item: MemoryItem) => number;
  weights: ScoreWeights;         // supports decay
  filter?: MemoryFilter;
}

const context = getItemsByBudget(state, {
  budget: 4096,
  costFn: (item) => JSON.stringify(item.content).length,
  weights: { authority: 0.5, importance: 0.5 },
  filter: { scope: "user:laz/general" },
});
```

---

## Smart Retrieval

### smartRetrieve(state, options)

Combined pipeline: score (with decay), filter contradictions, apply diversity, pack within budget.

```ts
interface SmartRetrievalOptions {
  budget: number;
  costFn: (item: MemoryItem) => number;
  weights: ScoreWeights;         // supports decay
  filter?: MemoryFilter;
  contradictions?: "filter" | "surface";  // "filter" = keep winner, "surface" = keep both + flag
  diversity?: DiversityOptions;   // penalize duplicate authors/parents/sources
}
```

**Pipeline:** `filter -> score (with decay) -> contradiction filter -> diversity re-rank -> budget pack`

```ts
const context = smartRetrieve(state, {
  budget: 4096,
  costFn: (item) => JSON.stringify(item.content).length,
  weights: {
    authority: 0.5,
    importance: 0.5,
    decay: { rate: 0.1, interval: "day", type: "exponential" },
  },
  filter: { scope: "user:laz/general" },
  contradictions: "surface",
  diversity: { author_penalty: 0.3, parent_penalty: 0.2 },
});
```

### filterContradictions(state, scored)

Removes superseded items (losers of resolved contradictions). For unresolved contradictions, keeps only the higher-scoring side. Use when you want a clean, non-contradictory result set.

### surfaceContradictions(state, scored)

Removes superseded items but **keeps both sides** of unresolved contradictions. Each item involved in a contradiction gets a `contradicted_by` array listing the opposing items.

```ts
const result = surfaceContradictions(state, scored);
// result[0].contradicted_by -> [opposingItem]  (if contradicted)
// result[1].contradicted_by -> [opposingItem]
// result[2].contradicted_by -> undefined        (no contradiction)
```

Use when the consumer needs to see the tension rather than have it resolved for them.

### applyDiversity(scored, options)

Re-ranks scored items with diversity penalties. Items are processed in score order; each subsequent item from the same author/parent/source gets penalized.

```ts
interface DiversityOptions {
  author_penalty?: number;       // penalty per duplicate author (0..1)
  parent_penalty?: number;       // penalty per shared parent (0..1)
  source_penalty?: number;       // penalty per duplicate source_kind (0..1)
}
```

---

## Provenance

### getSupportTree(state, itemId)

Recursively walks `parents` to build a full provenance tree. Handles cycles and missing parents.

```ts
interface SupportNode {
  item: MemoryItem;
  parents: SupportNode[];
}

const tree = getSupportTree(state, "m4");
// tree.item = m4
// tree.parents[0].item = m2
// tree.parents[0].parents[0].item = m1
```

### getSupportSet(state, itemId)

Flattened, deduplicated set of all items in the provenance chain (including the root item). The minimal set that justifies a claim.

```ts
const support = getSupportSet(state, "m4");
// [m4, m2, m1] -- everything needed to explain why m4 exists
```

---

## Bulk Operations

### applyMany(state, filter, transform, author, reason?, options?)

Apply a transform function to all matching items in a single pass (one Map clone, not N). Return `Partial<MemoryItem>` to update, `null` to retract, or `{}` to skip.

```ts
type ItemTransform = (item: MemoryItem) => Partial<MemoryItem> | null;
```

```ts
// decay authority by 10%
applyMany(state, {}, (item) => ({ authority: item.authority * 0.9 }), "system:decay");

// retract low-conviction items, boost the rest
applyMany(state, { meta: { agent_id: "agent:v1" } },
  (item) => (item.conviction ?? 0) < 0.3 ? null : { authority: 1.0 },
  "system:evaluator"
);

// tag top 50 by importance
applyMany(state, {}, () => ({ meta: { hot: true } }), "system:tagger",
  undefined, { sort: { field: "importance", order: "desc" }, limit: 50 });
```

Items retracted by a prior transform in the same batch are skipped (no crash).

### bulkAdjustScores(state, criteria, delta, author, reason?, basis?)

Convenience wrapper around `applyMany` for delta-based score adjustments with clamping to [0, 1].

```ts
interface ScoreAdjustment {
  authority?: number;            // delta, not absolute
  conviction?: number;
  importance?: number;
}

bulkAdjustScores(state, { scope: "project:old" }, { authority: -0.2 }, "system:decay");
```

### decayImportance(state, olderThanMs, factor, author, reason?)

Permanently decay stored importance on old items. Items created more than `olderThanMs` ago have their importance multiplied by `factor`. Skips items with zero or undefined importance.

```ts
// halve importance on items older than 7 days
decayImportance(state, 7 * 24 * 60 * 60 * 1000, 0.5, "system:decay");
```

Note: for query-time decay without mutating stored values, use `ScoreWeights.decay` instead.

---

## Graph Integrity

### Conflict Detection & Resolution

```ts
// mark two items as contradicting
markContradiction(state, itemIdA, itemIdB, author, meta?)

// find all active contradictions
getContradictions(state) -> Contradiction[]

// resolve: winner supersedes loser, loser authority lowered
resolveContradiction(state, winnerId, loserId, author, reason?)
```

### Staleness & Cascade

```ts
// find items whose parents are missing (retracted)
getStaleItems(state) -> StaleItem[]

// get direct or transitive dependents
getDependents(state, itemId, transitive?) -> MemoryItem[]

// retract an item and all its transitive dependents
cascadeRetract(state, itemId, author, reason?)
  -> { state, events, retracted: string[] }
```

### Identity / Aliasing

```ts
// mark two items as referring to the same entity (bidirectional)
markAlias(state, itemIdA, itemIdB, author, meta?)

// direct aliases
getAliases(state, itemId) -> MemoryItem[]

// transitive closure (full identity group)
getAliasGroup(state, itemId) -> MemoryItem[]
```

---

## Event Envelope Utilities

### wrapLifecycleEvent(event, causeId, traceId?)

Wraps a `MemoryLifecycleEvent` in an `EventEnvelope` with generated id, timestamp, and `cause_id`.

### wrapStateEvent(item, causeId, traceId?)

Creates a `state.memory` envelope.

### wrapEdgeStateEvent(edge, causeId, traceId?)

Creates a `state.edge` envelope.

---

## Replay

### replayCommands(commands)

Folds an array of `MemoryCommand` from an empty state. Returns final state and all lifecycle events.

### replayFromEnvelopes(envelopes)

Sorts `EventEnvelope<MemoryCommand>[]` by timestamp, extracts payloads, replays.

---

## Serialization

`GraphState` uses `Map` internally, which doesn't serialize with `JSON.stringify`. These helpers handle conversion.

### toJSON(state) / fromJSON(data)

Convert between `GraphState` and a plain serializable object.

```ts
interface SerializedGraphState {
  items: [string, MemoryItem][];
  edges: [string, Edge][];
}

const data = toJSON(state);        // GraphState -> plain object
const restored = fromJSON(data);   // plain object -> GraphState
```

### stringify(state, pretty?) / parse(json)

Full JSON string round-trip.

```ts
// save to disk / send over wire
const json = stringify(state);           // compact
const json = stringify(state, true);     // pretty-printed

// restore
const state = parse(json);
```

All fields are preserved through serialization, including `meta`, `content`, scores, and `parents`.

---

## Stats

### getStats(state)

Returns aggregate counts for items and edges.

```ts
interface GraphStats {
  items: {
    total: number;
    by_kind: Record<string, number>;
    by_source_kind: Record<string, number>;
    by_author: Record<string, number>;
    by_scope: Record<string, number>;
    with_parents: number;
    root: number;
  };
  edges: {
    total: number;
    active: number;
    by_kind: Record<string, number>;
  };
}

const stats = getStats(state);
// stats.items.total          -> 150
// stats.items.by_kind        -> { observation: 80, hypothesis: 30, ... }
// stats.items.root           -> 100
// stats.edges.active         -> 45
// stats.edges.by_kind        -> { SUPPORTS: 20, CONTRADICTS: 5, ... }
```

---

## Intent Graph

Intents represent goals or objectives. They link to memory items via `root_memory_ids` and are the parent of tasks.

### Types

```ts
type IntentStatus = "active" | "paused" | "completed" | "cancelled";

interface Intent {
  id: string;
  parent_id?: string;            // parent intent for sub-intent hierarchies
  label: string;
  description?: string;
  priority: number;              // 0..1
  owner: string;                 // "user:laz", "agent:reasoner"
  status: IntentStatus;
  context?: Record<string, unknown>;
  root_memory_ids?: string[];    // anchors into the memory graph
  meta?: Record<string, unknown>;
}

interface IntentState {
  intents: Map<string, Intent>;
}
```

### Factory & State

```ts
const state = createIntentState();
const intent = createIntent({ label: "find_kati", priority: 0.9, owner: "user:laz" });
// -> id generated, status defaults to "active"
```

### Commands & Reducer

```ts
const { state, events } = applyIntentCommand(state, { type: "intent.create", intent });
```

| Command | Valid from | Target status | Event |
|---------|-----------|---------------|-------|
| `intent.create` | — | — | `intent.created` |
| `intent.update` | any | — | `intent.updated` |
| `intent.pause` | active | paused | `intent.paused` |
| `intent.resume` | paused | active | `intent.resumed` |
| `intent.complete` | active, paused | completed | `intent.completed` |
| `intent.cancel` | active, paused | cancelled | `intent.cancelled` |

Invalid transitions throw `InvalidIntentTransitionError`.

All lifecycle events have `namespace: "intent"`.

### Query

```ts
interface IntentFilter {
  owner?: string;
  status?: IntentStatus;
  statuses?: IntentStatus[];
  min_priority?: number;
  has_memory_id?: string;        // intent references this memory item
  parent_id?: string;            // filter by parent intent
  is_root?: boolean;             // true = no parent, false = has parent
}

getIntents(state, { owner: "user:laz", statuses: ["active", "paused"] });
getIntentById(state, "i1");
getChildIntents(state, "i1");    // all intents with parent_id = "i1"
```

---

## Task Graph

Tasks are units of work tied to an intent. They track execution status, agent assignment, retry attempts, and link to memory items consumed and produced.

### Types

```ts
type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

interface Task {
  id: string;
  intent_id: string;             // parent intent
  parent_id?: string;            // parent task for subtask hierarchies
  action: string;                // "search_linkedin", "summarize_case"
  label?: string;
  status: TaskStatus;
  priority: number;              // 0..1
  context?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
  input_memory_ids?: string[];   // memory items consumed
  output_memory_ids?: string[];  // memory items produced
  agent_id?: string;
  attempt?: number;              // incremented on retry
  meta?: Record<string, unknown>;
}

interface TaskState {
  tasks: Map<string, Task>;
}
```

### Factory & State

```ts
const state = createTaskState();
const task = createTask({ intent_id: "i1", action: "search_linkedin", priority: 0.8 });
// -> id generated, status defaults to "pending", attempt defaults to 0
```

### Commands & Reducer

```ts
const { state, events } = applyTaskCommand(state, { type: "task.create", task });
```

| Command | Valid from | Target status | Event |
|---------|-----------|---------------|-------|
| `task.create` | — | — | `task.created` |
| `task.update` | any | — | `task.updated` |
| `task.start` | pending, failed | running | `task.started` |
| `task.complete` | running | completed | `task.completed` |
| `task.fail` | running | failed | `task.failed` |
| `task.cancel` | pending, running, failed | cancelled | `task.cancelled` |

`task.start` increments `attempt` and optionally sets `agent_id`. `task.fail` → `task.start` is a retry. Invalid transitions throw `InvalidTaskTransitionError`.

All lifecycle events have `namespace: "task"`.

### Query

```ts
interface TaskFilter {
  intent_id?: string;
  action?: string;
  status?: TaskStatus;
  statuses?: TaskStatus[];
  agent_id?: string;
  min_priority?: number;
  has_input_memory_id?: string;
  has_output_memory_id?: string;
  parent_id?: string;            // filter by parent task
  is_root?: boolean;             // true = no parent, false = has parent
}

getTasks(state, { intent_id: "i1", statuses: ["pending", "running"] });
getTaskById(state, "t1");
getChildTasks(state, "t1");      // all tasks with parent_id = "t1"
getTasksByIntent(state, "i1");
```

---

## Cross-Graph Linking

The three graphs (memory, intent, task) reference each other by ID:

| From | To | Field |
|------|----|-------|
| Intent | Memory | `Intent.root_memory_ids` |
| Intent | Intent (parent) | `Intent.parent_id` |
| Task | Intent | `Task.intent_id` |
| Task | Task (parent) | `Task.parent_id` |
| Task | Memory (input) | `Task.input_memory_ids` |
| Task | Memory (output) | `Task.output_memory_ids` |
| Memory | Intent | `MemoryItem.intent_id` |
| Memory | Task | `MemoryItem.task_id` |

No unified query across graphs — each graph has its own getters. The app layer composes them.

---

## Multi-Agent Memory Segmentation

MemEX supports multi-agent systems with one shared graph segmented by conventions on `author`, `meta`, and `scope`.

### Memory segmentation fields

| Field | Convention | Example |
|-------|-----------|---------|
| `author` | Who created the item | `"agent:researcher"`, `"user:laz"` |
| `meta.agent_id` | Specific agent instance | `"agent:researcher-v2"` |
| `meta.session_id` | Session scope | `"session-abc"` |
| `meta.crew_id` | Crew/run scope | `"crew:investigation-42"` |
| `scope` | Logical namespace | `"project:cyberdeck/research"` |

### Querying by agent

```ts
// this agent's items only
getItems(state, { meta: { agent_id: "agent:researcher" } });

// all items from a crew run
getItems(state, { meta: { crew_id: "crew:investigation-42" } });

// everything in a project, ranked
getScoredItems(state, weights, {
  pre: { scope_prefix: "project:cyberdeck/" },
});

// items NOT by a specific agent
getItems(state, { not: { meta: { agent_id: "agent:bad" } } });
```

### Task assignment

```ts
// assign a task to a specific agent
applyTaskCommand(state, {
  type: "task.create",
  task: createTask({
    intent_id: "i1",
    action: "search_linkedin",
    priority: 0.8,
    agent_id: "agent:researcher",     // assigned agent
    input_memory_ids: ["m1", "m2"],
  }),
});

// query tasks by agent
getTasks(state, { agent_id: "agent:researcher", status: "pending" });
```

### Hard isolation via transplant

For sub-agents that need to work independently:

```ts
// export a slice
const slice = exportSlice(mem, intents, tasks, {
  memory_ids: relevantIds,
  include_parents: true,
});

// sub-agent works on its own copy...
// merge back (append-only, existing items untouched)
const { memState, report } = importSlice(mem, intents, tasks, subAgentSlice);
```

---

## Transplant (Export / Import)

Move chains of memories, intents, and tasks between graph instances. Useful for sub-agent isolation, migration, cloning workflows, and backup.

### exportSlice(memState, intentState, taskState, options)

Walk the graph from anchor ids and collect a self-contained slice.

```ts
interface ExportOptions {
  memory_ids?: string[];
  intent_ids?: string[];
  task_ids?: string[];
  include_parents?: boolean;          // walk parents up-graph
  include_children?: boolean;         // walk dependents down-graph
  include_aliases?: boolean;          // include ALIAS groups
  include_related_tasks?: boolean;
  include_related_intents?: boolean;
}

interface MemexExport {
  memories: MemoryItem[];
  edges: Edge[];
  intents: Intent[];
  tasks: Task[];
}
```

```ts
// export a full chain: m1 + all children + related intents/tasks
const slice = exportSlice(memState, intentState, taskState, {
  memory_ids: ["m1"],
  include_children: true,
  include_related_intents: true,
  include_related_tasks: true,
});

// slice is plain JSON — serialize and send anywhere
const json = JSON.stringify(slice);
```

### importSlice(memState, intentState, taskState, slice, options?)

Import a slice into existing state. Default: skip existing ids, never overwrite. With `skipExistingIds: false`, existing entities are updated in place (reported in `report.updated`).

```ts
interface ImportOptions {
  skipExistingIds?: boolean;              // default true
  shallowCompareExisting?: boolean;       // default false — detect conflicts
  reIdOnDifference?: boolean;             // default false — mint new ids on conflict
}

interface ImportReport {
  created:   { memories: string[]; intents: string[]; tasks: string[]; edges: string[] };
  updated:   { memories: string[]; intents: string[]; tasks: string[]; edges: string[] };
  skipped:   { memories: string[]; intents: string[]; tasks: string[]; edges: string[] };
  conflicts: { memories: string[]; intents: string[]; tasks: string[]; edges: string[] };
}
```

```ts
// default: append new, skip existing
const { memState, intentState, taskState, report } = importSlice(
  currentMem, currentIntents, currentTasks,
  slice,
);
// report.created.memories -> ["m2", "m3"]
// report.skipped.memories -> ["m1"]  (already existed)

// with conflict detection
const result = importSlice(mem, intents, tasks, slice, {
  shallowCompareExisting: true,
});
// result.report.conflicts.memories -> ["m1"]  (exists but different)

// with re-id on conflict (mint new ids for differing entities)
const result2 = importSlice(mem, intents, tasks, slice, {
  shallowCompareExisting: true,
  reIdOnDifference: true,
});
// conflicting entities get new uuidv7 ids, internal refs are rewritten
```

**Import behavior:**

| Scenario | `skipExisting` | `shallowCompare` | `reId` | Result |
|----------|---------------|-----------------|--------|--------|
| ID doesn't exist | — | — | — | Created |
| ID exists | false | — | — | Updated in place |
| ID exists, no compare | true | false | — | Skipped |
| ID exists, same content | true | true | — | Skipped |
| ID exists, different content | true | true | false | Conflict (reported, not imported) |
| ID exists, different content | true | true | true | New id minted, imported as separate entity |

When `reIdOnDifference` is true, all internal references (`parents`, `Edge.from/to`, `intent_id`, `input/output_memory_ids`, `root_memory_ids`) are rewritten to the new ids. The original entity is not touched or linked.

**Re-id timestamp preservation:** new ids are generated at +1ms from the original entity's timestamp (extracted from the uuidv7), not from `Date.now()`. This preserves temporal ordering — decay scoring and recency sort are unaffected. If the +1ms id also collides, it increments by another 1ms until a free slot is found.
