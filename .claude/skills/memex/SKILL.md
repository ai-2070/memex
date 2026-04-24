---
name: memex
description: "Build, integrate, and debug code that uses the MemEX memory-graph library (@ai2070/memex). Covers the three graphs (Memory / Intent / Task), typed commands, soft-failure semantics, retrieval & budget packing, transplant, and bulk replay. TRIGGER when: code imports `@ai2070/memex`; user asks about MemEX memory items, edges, contradictions, aliases, intents, tasks, smartRetrieve, exportSlice/importSlice, replayFromEnvelopes; user wires MemEX into an agent or daemon. SKIP for unrelated storage/vector DB work."
allowed-tools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"]
---

# MemEX Skill

Help the user build with `@ai2070/memex` — a typed, provenance-tracked memory graph for AI agents. MemEX separates three graphs (what is believed / what is wanted / what is done) and makes retrieval, contradiction, decay, and identity first-class.

Always write code that matches MemEX's tolerance model: noisy input should not crash the fold; errors are layered.

## Mental Model (memorize)

**Three graphs, one pattern.** Each follows `commands → reducer → lifecycle events`. Cross-reference by id.

| Graph   | Core type   | What it holds                                   | Namespace   |
|---------|-------------|-------------------------------------------------|-------------|
| Memory  | `MemoryItem`| beliefs, evidence, contradictions               | `"memory"`  |
| Intent  | `Intent`    | active goals, priorities, status                | `"intent"`  |
| Task    | `Task`      | units of work tied to intents                   | `"task"`    |

**State is immutable.** `applyCommand` returns a *new* `GraphState`; never mutate.

**Three scores** (all `0..1`, orthogonal):
- `authority` — how much the system should trust this
- `conviction` — how sure the author was
- `importance` — how much attention it needs right now (salient, not permanent)

**Item kinds**: `observation | assertion | assumption | hypothesis | derivation | simulation | policy | trait`. The `kind` says what it *is*; `source_kind` (`user_explicit | observed | agent_inferred | imported | ...`) says how it *got here*.

**Edges**: typed relationships — `DERIVED_FROM`, `CONTRADICTS`, `SUPPORTS`, `ABOUT`, `SUPERSEDES`, `ALIAS`. Edges are created via `edge.create` commands or via helpers like `markContradiction`, `markAlias`, `resolveContradiction`.

## Error model (get this right, it's opinionated)

MemEX is layered on purpose. Do NOT wrap graph-mutation calls in try/catch "just in case" — they don't throw on noise.

| Layer | Throws? | Where |
|-------|---------|-------|
| Graph mutations — `markAlias`, `markContradiction`, `resolveContradiction`, `createEdge` | No. Record/flag/no-op on degenerate shapes. | Library internals |
| Reducer — `applyCommand` | Throws typed errors (`DuplicateMemoryError`, `MemoryNotFoundError`, ...) | Single-command API |
| API boundary — `extractTimestamp`, envelope `ts` parsing | Throws typed `InvalidTimestampError` — caller fixes input | Inputs from outside |
| Bulk replay — `replayCommands`, `replayFromEnvelopes` | Never throws. Per-item failures go to `result.skipped: ReplayFailure[]`. | Long-running daemons |

Write daemons accordingly:

```ts
const { state, events, skipped } = replayFromEnvelopes(envelopes);
for (const failure of skipped) {
  logger.warn({ err: failure.error, at: failure.envelope?.ts });
}
// state is already the partial result — don't re-run
```

Do **not**:
- Expect `replayFromEnvelopes` to throw on a bad envelope. It won't; check `skipped`.
- Wrap `markAlias(a, a)` in try/catch. It's a silent no-op.
- Use `try/catch` around `markContradiction(a, a)` — it records a self-edge deliberately.
- Try to rewrite `created_at` via `memory.update` — it's stripped from the partial, same as `id`.

## Canonical patterns

### Creating items

Always use `createMemoryItem` — it auto-assigns a uuidv7 id and `created_at` (ms).

```ts
import { createMemoryItem, applyCommand, createGraphState } from "@ai2070/memex";

let state = createGraphState();

const obs = createMemoryItem({
  scope: "user:laz/general",
  kind: "observation",
  content: { key: "login_count", value: 42 },
  author: "agent:monitor",
  source_kind: "observed",
  authority: 0.9,
  importance: 0.7,
});

state = applyCommand(state, { type: "memory.create", item: obs }).state;
```

For derivations, set `parents` to the ids of the items they were inferred from. That builds the provenance tree automatically.

### Retrieval (choose the right function)

| Need | Use |
|------|-----|
| Filter only, no scoring | `getItems(state, filter, options?)` |
| Score + decay, no packing | `getScoredItems(state, weights, options?)` |
| Score + budget packing | `getItemsByBudget(state, { budget, costFn, weights, filter? })` |
| Everything: score + decay + contradiction policy + diversity + budget | `smartRetrieve(state, options)` |

`costFn` may return `0` for free/cached items (they're always included). Negative / non-finite cost throws `RangeError`.

Contradictions at retrieval:
- `"filter"` — keep the higher-scoring side (clean context for user-facing output)
- `"surface"` — keep both, flagged with `contradicted_by` (agent reasoning)

### Soft isolation for crews

Don't create per-agent stores. One graph, filtered:

```ts
getItems(state, { meta: { agent_id: "agent:researcher" } });
getScoredItems(state, weights, { pre: { scope_prefix: "project:x/" } });
```

### Hard isolation via transplant

For sandboxed sub-agents or parallel reasoning:

```ts
const slice = exportSlice(memState, intentState, taskState, {
  memory_ids: relevantIds,
  include_parents: true,          // walk provenance chains
  include_related_tasks: true,    // pull linked tasks too
});

// ... sub-agent operates on the slice ...

const { memState: merged, report } = importSlice(
  memState, intentState, taskState, subSlice,
  { shallowCompareExisting: true, reIdOnDifference: true },
);
// report.created / updated / skipped / conflicts
```

### Cascade retraction

`cascadeRetract(state, itemId, author, reason?)` retracts an item and all its transitive dependents in topological order (leaves before roots). Cycle-safe; handles DAGs with shared children. Does NOT stack-overflow on deep chains.

### Resolving contradictions

```ts
// detect
markContradiction(state, "m1", "m2", "agent:detector");

// ... later, when one wins ...
resolveContradiction(state, winnerId, loserId, "agent:resolver", "new evidence");
// - creates SUPERSEDES edge
// - retracts the CONTRADICTS edge
// - lowers loser.authority to 10% of its current value
// - if no active CONTRADICTS edge exists, this is a silent no-op (not an error)
```

### Thinking budget from scores

A common loop: items with high importance AND low authority need reasoning. After processing, decay importance:

```ts
const priority = item.importance * (1 - item.authority); // higher = more worth thinking about

// after processing
applyCommand(state, {
  type: "memory.update",
  item_id: item.id,
  partial: { importance: item.importance * 0.3 },
  author: "system:thinker",
  reason: "processed",
});
```

## Scripting quick-starts

### Fold an event log into state

```ts
import { replayFromEnvelopes } from "@ai2070/memex";

const { state, events, skipped } = replayFromEnvelopes(envelopes);
if (skipped.length > 0) {
  // quarantine / metric / alert — batch still applied successfully otherwise
}
```

### Persist & restore

```ts
import { stringify, parse } from "@ai2070/memex";

await fs.writeFile("graph.json", stringify(state, /*pretty=*/ true));
const restored = parse(await fs.readFile("graph.json", "utf8"));
```

### Validate external input (optional, requires `zod >= 4`)

```ts
import { MemoryCommandSchema } from "@ai2070/memex/schemas";

const cmd = MemoryCommandSchema.parse(raw);   // throws on shape mismatch
state = applyCommand(state, cmd).state;
```

## How to respond

1. **If the user asks a concept question** (what's authority vs conviction, when to use surface vs filter, etc.): answer from the mental model above. Keep it tight — a paragraph plus an example snippet is usually enough.

2. **If the user is writing new code against MemEX**: write idiomatic code using the patterns above. Always:
   - Use `createMemoryItem` / `createEdge` factories (not raw object literals)
   - Assign `scope`, `kind`, `source_kind`, `author` explicitly
   - Rebind `state` from each `applyCommand` result (`state = applyCommand(...).state`)
   - For bulk replay, destructure `skipped` and handle it (log / metric)

3. **If the user has a bug**: check for these before anything else:
   - Mutating `state.items` / `state.edges` directly (should be `applyCommand`)
   - Missing `state = ...` reassignment after `applyCommand`
   - Expecting `replayFromEnvelopes` to throw (it collects in `skipped`)
   - Expecting `markAlias(a,a)` / `resolveContradiction` with no edge to throw (they no-op)
   - Trying to update `created_at` via partial (it's stripped)
   - Passing a non-UUIDv7 id to `extractTimestamp` (throws `InvalidTimestampError`)

4. **If the user is integrating MemEX into an agent**: default to the "Soft isolation (shared graph, scoped views)" pattern — one graph, `meta.agent_id` / `scope` filters. Only suggest transplant for genuinely sandboxed work.

5. **Check `API.md` for exact signatures** before writing code — it's the source of truth. Use `Grep` to find examples already in the repo if helpful.

## Keep it terse

When writing code for the user, show the *minimum idiomatic* example — don't re-document the library inline. Link to `API.md` or `README.md` for detail. MemEX is opinionated; match the opinions.
