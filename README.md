# MemEX: Epistemic Memory for AI Agents

**Memory that stores what an agent *believes* — with provenance, trust, contradiction, and time — not just text it can retrieve.**

Most "AI memory" answers *"what does the corpus say about X?"* — embed text, retrieve the top‑k, paste it into a prompt. That works until the question becomes *epistemic*: **what should I believe about X**, given that my inputs contain rumors, retractions, partisan sources, stale facts, and outright contradictions?

MemEX is a small, pure‑TypeScript library that models memory as a **typed, scored, provenance‑tracked graph over an append‑only event log**. Every belief records *who said it, why we believe it, what it conflicts with, when it was true, and how confident we are* — the structure that high‑stakes analytical work (finance, law, geopolitics) depends on and that vector stores collapse away.

> Vector search tells you what is **similar**. MemEX tells you what you **believe**.

```bash
npm install @ai2070/memex          # one runtime dep: uuidv7
npm install zod                    # optional — runtime schema validation
```

---

## 60‑second tour

Create a graph, record an observation, derive a belief from it, then ask *why* you believe it.

```ts
import {
  createGraphState,
  createMemoryItem,
  applyCommand,
  getScoredItems,
  getSupportTree,
} from "@ai2070/memex";

let state = createGraphState();

// A legal-research agent investigating the famous "hot coffee" case.

// 1. Facts from the primary source — the trial record. High authority.
const record = createMemoryItem({
  scope: "case:liebeck-v-mcdonalds",
  kind: "observation",
  content: {
    source: "trial record (Liebeck v. McDonald's Restaurants, 1994)",
    finding:
      "coffee served at 180-190°F; third-degree burns requiring skin grafts; " +
      "~700 prior burn complaints on file",
  },
  author: "source:trial-record-1994",
  source_kind: "imported",
  authority: 0.95,
  conviction: 0.9,
  importance: 0.7,
});
state = applyCommand(state, { type: "memory.create", item: record }).state;

// 2. The agent's legal read *derived from* the record. It's an interpretation,
//    not a recorded fact, so it carries less authority — but it's the answer to
//    the research question, so it's highly salient.
const assessment = createMemoryItem({
  scope: "case:liebeck-v-mcdonalds",
  kind: "hypothesis",
  content: { claim: "the verdict rested on documented gross negligence, not a frivolous claim" },
  author: "agent:legal-researcher",
  source_kind: "agent_inferred",
  parents: [record.id], // <- provenance edge
  authority: 0.55,
  conviction: 0.75,
  importance: 0.85,
});
state = applyCommand(state, { type: "memory.create", item: assessment }).state;

// 3. Rank beliefs by a weighted blend of the three scores.
const ranked = getScoredItems(state, {
  authority: 0.5,
  conviction: 0.2,
  importance: 0.3,
});

// 4. "What backs this assessment?" -> walk the provenance tree.
const tree = getSupportTree(state, assessment.id);
// tree.item === assessment, tree.parents[0].item === record (the trial record)
```

Nothing was mutated in place: `applyCommand` returns a **new** `GraphState` plus the lifecycle events it produced. State is always a fold over the command log, so every belief change is replayable and auditable.

---

## Why MemEX exists

Four concerns drive the design. They aren't a spec every "epistemic memory" must meet — they're the things practitioners in finance, law, and geopolitics reliably run into, and the reason MemEX has the primitives it has.

### 1. Differential trust — *not all sources are equal*

A 10‑K and a Twitter rumor are not semantic peers. MemEX gives every item three **orthogonal** scores, so you can say "trust this a lot, but the author wasn't sure, and it barely matters right now" — or any other combination.

| Score | Question it answers | Range |
|-------|--------------------|-------|
| `authority` | How much should the **system** trust this, regardless of who said it? | 0..1 |
| `conviction` | How sure was the **author** when they said it? | 0..1 |
| `importance` | How much should we be **thinking about this right now**? (salience) | 0..1 |

```ts
// Same event, two sources — the trust topology is explicit, not flattened.
const audited = createMemoryItem({
  scope: "10K:ACME-2025", kind: "observation",
  content: { line: "revenue", value: 9.84e9, period: "FY2025" },
  author: "filing:ACME-10K-2025", source_kind: "user_explicit",
  authority: 0.98, importance: 0.85,            // audited statement
});

const rumor = createMemoryItem({
  scope: "10K:ACME-2025", kind: "hypothesis",
  content: { claim: "revenue will be restated downward" },
  author: "social:anon-tip", source_kind: "agent_inferred",
  authority: 0.2,                                // barely trusted...
  importance: 0.9,                               // ...but worth checking
});
```

`importance` decoupled from `authority` is the cell single‑score systems can't represent: *worth checking, not worth trusting.*

### 2. Preserved disagreement — *show both sides*

When two credible sources conflict, the disagreement is itself a signal. MemEX records it as a `CONTRADICTS` **edge** and lets retrieval either *surface* both sides (annotated) or *filter* to the higher‑scoring one.

```ts
import { markContradiction, smartRetrieve } from "@ai2070/memex";

// Early hours of a contested event: official narratives disagree; an OSINT
// rumor is low-trust but high-attention.
let s = createGraphState();
const dod = createMemoryItem({
  scope: "geo:event-2023-balloon", kind: "assertion",
  content: { claim: "PRC surveillance platform" },
  author: "agency:US-DOD", source_kind: "user_explicit",
  authority: 0.85, conviction: 0.85, importance: 0.95,
});
const mfa = createMemoryItem({
  scope: "geo:event-2023-balloon", kind: "assertion",
  content: { claim: "civilian weather balloon, off-course" },
  author: "agency:PRC-MFA", source_kind: "user_explicit",
  authority: 0.7, conviction: 0.8, importance: 0.95,
});
for (const item of [dod, mfa]) s = applyCommand(s, { type: "memory.create", item }).state;
s = markContradiction(s, dod.id, mfa.id, "agent:event-router").state;

// "surface" keeps both sides and flags each with `contradicted_by`.
const briefing = smartRetrieve(s, {
  budget: 4000,
  costFn: (i) => JSON.stringify(i.content).length,
  weights: { authority: 0.4, importance: 0.6 },
  contradictions: "surface",          // or "filter" for a single clean answer
  diversity: { source_penalty: 0.4 }, // don't return 20 paraphrases of one wire
});
// briefing[i].contradicted_by lists the items each one conflicts with.
```

### 3. Causal traceability — *answer "what justifies this?"*

Every derivation carries `parents`. `getSupportTree` / `getSupportSet` reconstruct the evidence chain back to root observations — a generated citation graph, not a narration.

```ts
import { getSupportSet } from "@ai2070/memex";

getSupportSet(state, ratingId);
// -> [rating, leverageRatio, debt, ebitda, footnote12, ...]
//    every item that justifies the rating, deduped, cycle-safe
```

### 4. Temporal honesty — *distinguish "true now" from "true then" without rewriting history*

Time decay is computed **at query time** from each item's `uuidv7` timestamp; stored scores are never mutated. The same graph answers "what do we know now?" and "what did we know in March?" — both first‑class.

```ts
// A query that down-weights stale items, configured per call.
getScoredItems(state, {
  authority: 0.5,
  importance: 0.5,
  decay: { rate: 0.1, interval: "day", type: "exponential" },
});
```

---

## The core model

### Items and edges

A **`MemoryItem`** is a node. Its `kind` says what it *is*; its `source_kind` says how it *got here*.

- **kinds:** `observation` · `assertion` · `assumption` · `hypothesis` · `derivation` · `simulation` · `policy` · `trait`
- **source kinds:** `user_explicit` · `observed` · `derived_deterministic` · `agent_inferred` · `simulated` · `imported`

**Edges** are first‑class objects with their **own** author and authority — because *"case A overrules case B"* or *"filing X supports thesis Y"* is itself a claim someone made with some confidence.

| Edge | Meaning |
|------|---------|
| `DERIVED_FROM` | A relationship discovered after creation |
| `SUPPORTS` | Evidence for another item |
| `CONTRADICTS` | Two items assert conflicting things |
| `SUPERSEDES` | Replaces another item (conflict resolution) |
| `ALIAS` | Same entity, different observations |
| `ABOUT` | References another item |

> `parents` on an item is the fast path for provenance set at creation time; an `edge` is the general form, added any time, with its own trust score. Both feed `getSupportTree`.

### Event sourcing and immutability

MemEX is a pure reducer over commands:

```ts
applyCommand(state, cmd): { state: GraphState; events: MemoryLifecycleEvent[] }
```

Commands (`memory.create | update | retract`, `edge.create | update | retract`) are the only way to change state, and they're meant to be stored append‑only. This buys three properties that matter in regulated settings:

- **Auditability** — every belief change traces to the command that caused it.
- **Time travel** — fold the log up to any point to reconstruct historical state.
- **Branching** — multiple worldlines fork from one checkpoint without contention.

```ts
import { replayFromEnvelopes } from "@ai2070/memex";

// Rebuild state on restart from a persisted, timestamp-ordered event log.
const { state, events, skipped } = replayFromEnvelopes(envelopes);
// Replay is integrity-tolerant: bad records land in `skipped`, the batch
// keeps going. A long-running daemon doesn't die on one malformed event.
for (const f of skipped) logger.warn({ err: f.error, at: f.envelope?.ts });
```

---

## Working with beliefs — recipes

### Provenance: explain a conclusion

```ts
import { getSupportTree } from "@ai2070/memex";

const tree = getSupportTree(state, ratingId);
// SupportNode { item, parents: SupportNode[] } — recursive, dedupes cycles.
// "Why do we rate this BBB?" -> the tree walks back through the calculated
// ratios to the audited line items and footnotes that conditioned them.
```

### Supersession: replace without deleting

Being restated (finance) or overruled (law) is **not** the same as being wrong. `resolveContradiction` adds a `SUPERSEDES` edge, lowers the loser's authority, and retracts the open `CONTRADICTS` edge — but keeps the old item queryable.

```ts
import { markContradiction, resolveContradiction, replayCommands } from "@ai2070/memex";

// Record the conflict, then resolve it: Brown v. Board supersedes Plessy for
// the segregation doctrine. (resolveContradiction acts on an existing
// CONTRADICTS edge — it lowers the loser's authority and adds SUPERSEDES.)
state = markContradiction(state, brown.id, plessy.id, "court:SCOTUS").state;
state = resolveContradiction(
  state, brown.id, plessy.id,
  "court:SCOTUS", "Brown v. Board of Education, 347 U.S. 483",
).state;

// `plessy` still exists (reduced authority). A query over the modern scope
// filters it out; a query over the 1953 worldline — rebuilt from the log
// with replayCommands — returns Plessy as live, controlling law.
```

### Staleness and cascade retraction

When evidence is pulled, find what depended on it — and optionally invalidate the whole chain.

```ts
import { getStaleItems, cascadeRetract } from "@ai2070/memex";

getStaleItems(state);               // items whose parents are now missing
// -> [{ item, missing_parents: [...] }, ...]

const { state: next, retracted } = cascadeRetract(
  state, restatedFilingId, "system:restatement",
);
// Retracts the item and every transitive dependent (leverage ratios,
// covenant headroom, growth rates...) in DFS post-order — cycle-safe.
```

### Identity: two names, one entity

```ts
import { markAlias, getAliasGroup } from "@ai2070/memex";

state = markAlias(state, theCompany.id, acmeCorp.id, "agent:resolver").state;
state = markAlias(state, acmeCorp.id, acmeIndustries.id, "agent:resolver").state;

getAliasGroup(state, theCompany.id); // transitive closure -> all three
```

### Smart retrieval: the whole pipeline in one call

`smartRetrieve` composes scoring → contradiction handling → diversity → budget packing.

```ts
import { smartRetrieve } from "@ai2070/memex";

const context = smartRetrieve(state, {
  budget: 16000,                                  // e.g. a token budget
  costFn: (i) => JSON.stringify(i.content).length,
  weights: {
    authority: 0.85, importance: 0.15,
    decay: { rate: 0.05, interval: "day", type: "exponential" },
  },
  filter: {
    scope_prefix: "doctrine:1A/",
    range: { authority: { min: 0.7 } },           // exclude low-authority noise
    or: [{ source_kind: "user_explicit" }, { source_kind: "imported" }],
  },
  contradictions: "surface",
  diversity: { source_penalty: 0.4 },             // span across courts/sources
});
```

Diversity penalties matter: naive ranking returns five paraphrases of the same report. Penalizing duplicate authors / shared parents / source kinds forces genuinely independent sources into the context.

### Querying: the filter algebra

`getItems(state, filter?, options?)` supports `and` (implicit), `or`, `not`, `range`, `ids`, `scope` / `scope_prefix`, `has_parent` / `is_root` / `parents` (includes / includes_any / includes_all / count), `intent_id` / `task_id`, `meta` (dot‑path) / `meta_has`, `created` (time range), and `decay` (freshness floor), plus multi‑field sort.

```ts
import { getItems } from "@ai2070/memex";

// Low resolution: trusted, recent, no speculation.
getItems(state, {
  range: { authority: { min: 0.7 } },
  not: { or: [{ kind: "hypothesis" }, { kind: "simulation" }] },
  decay: { config: { rate: 0.3, interval: "day", type: "exponential" }, min: 0.5 },
}, { sort: { field: "importance", order: "desc" }, limit: 20 });

// The attention queue: high-importance, low-trust items worth thinking about.
getItems(state, { range: { authority: { max: 0.5 }, importance: { min: 0.7 } } });
```

### Bulk operations

Sweep the graph in a single pass — for periodic re‑weighting, decay, or rule‑based cleanup.

```ts
import { bulkAdjustScores, decayImportance, applyMany } from "@ai2070/memex";

// Boost a whole episode's importance when an analog gains traction.
state = bulkAdjustScores(
  state, { scope: "macro:history/1995" }, { importance: +0.4 },
  "system:rebalance", "1995 analog conviction crossed 0.7",
).state;

// Age out importance on everything older than a week.
state = decayImportance(state, 7 * 86_400_000, 0.5, "system:nightly").state;

// Conditional transform: return a partial to update, `null` to retract.
state = applyMany(
  state,
  { scope_prefix: "tmp:", range: { importance: { max: 0.05 } } },
  (item) => null,                       // retract everything matching
  "system:gc",
).state;
```

---

## The three graphs: memory, intent, task

MemEX coordinates three graphs under one event‑envelope pattern. Use only what you need; they cross‑reference by id.

| Graph | Holds | Core type | Question |
|-------|-------|-----------|----------|
| **Memory** | beliefs, evidence, contradictions | `MemoryItem` | What is believed? |
| **Intent** | goals & objectives | `Intent` | What is wanted? |
| **Task** | units of work tied to intents | `Task` | What is done? |

This closes the loop a flat store can only fake — **beliefs → goals → tasks → new beliefs**, with provenance running all the way back:

```
 Memory ───▶ Intent ───▶ Task ───┐
 (belief)    (direction) (work)   │ produces new memory
    ▲                             │ (results, observations)
    └─────────────────────────────┘  with parents + intent_id + task_id
```

```ts
import {
  createIntentState, createIntent, applyIntentCommand,
  createTaskState, createTask, applyTaskCommand,
} from "@ai2070/memex";

let intents = createIntentState();
let tasks = createTaskState();

// A goal, anchored to the belief that motivated it.
const intent = createIntent({
  label: "determine whether Liebeck was a frivolous lawsuit",
  owner: "agent:legal-researcher",
  priority: 0.8,
  root_memory_ids: [assessment.id],
});
intents = applyIntentCommand(intents, { type: "intent.create", intent }).state;

// An executable unit under that intent, consuming the evidence it weighs.
const task = createTask({
  intent_id: intent.id,
  action: "review_primary_record",
  priority: 0.8,
  input_memory_ids: [record.id],
});
tasks = applyTaskCommand(tasks, { type: "task.create", task }).state;
tasks = applyTaskCommand(tasks, { type: "task.start", task_id: task.id }).state;
tasks = applyTaskCommand(tasks, {
  type: "task.complete", task_id: task.id, output_memory_ids: [/* new item ids */],
}).state;

// The new belief the task produced links back to its origins.
createMemoryItem({
  scope: "case:liebeck-v-mcdonalds", kind: "derivation",
  content: { synthesis: "the popular 'frivolous lawsuit' framing is contradicted by the trial record" },
  author: "agent:legal-researcher", source_kind: "derived_deterministic",
  parents: [record.id], intent_id: intent.id, task_id: task.id,
  authority: 0.8,
});
```

Intents run a status machine (`active ↔ paused → completed / cancelled`); tasks run (`pending → running → completed / failed`, with `failed → running` retry). Invalid transitions throw typed errors.

---

## Transplant: portable belief, sandboxed sub‑agents

`exportSlice` pulls a self‑contained sub‑graph (optionally walking up parents, down children, across aliases and related intents/tasks). `importSlice` merges it back **append‑only** with a per‑entity report. Memory becomes a *value you can move* — between agents, processes, or machines.

```ts
import { exportSlice, importSlice, getItems } from "@ai2070/memex";

// Pick the entities to hand off (export is by id), then walk up to their
// dependencies so the slice is self-contained.
const ids = getItems(memState, { scope_prefix: "deal:reorg-2026/" }).map((i) => i.id);
const slice = exportSlice(memState, intentState, taskState, {
  memory_ids: ids,
  include_parents: true,        // also: include_children, include_aliases,
                                //       include_related_intents / _tasks
});

// ... sub-agent reasons over its OWN copy, adding derivations ...

// Merge back. Existing items are untouched by default (append-only); with
// shallow compare + re-id, a divergent edit to an existing id is minted as a
// fresh uuidv7 instead of clobbering the consensus graph.
const { memState: merged, report } = importSlice(
  memState, intentState, taskState, subAgentSlice,
  { shallowCompareExisting: true, reIdOnDifference: true },
);
// report.created / updated / skipped / conflicts — what the sub-agent did.
```

This makes multi‑agent patterns fall out of the design rather than requiring bespoke sync code:

| Pattern | How it works |
|---------|--------------|
| **Crews** | Each member works a `scope_prefix` slice; a partner agent queries by `author` / `meta.agent_id` and reconciles. Coordination is data, not chatter. |
| **Swarms** | Fan out N sub‑agents on one baseline slice; merge with conflict detection. Branching scenarios (route IP through Lux vs. SG; Anglo‑German vs. US‑Soviet analog) are this primitive at coarse grain. |
| **Cross‑session memory** | One graph spans all conversations. Continuity is the default; *forgetting* is the explicit operation (`memory.retract`). |
| **Background thinking** | Pick low‑authority/high‑importance items (`importance × (1 − authority)`), open tasks under an intent, write results back with full provenance. |

```ts
// Soft isolation: one shared graph, segmented by query — no per-agent stores.
getItems(state, { meta: { agent_id: "agent:researcher" } }); // just my work
getItems(state, { scope_prefix: "project:cyberdeck/" });     // a project view
```

---

## Persistence

The library is pure (no I/O). Persistence is `JSON` plus your own store:

```ts
import { stringify, parse, toJSON, fromJSON, getStats } from "@ai2070/memex";

const json = stringify(state, /* pretty */ true);  // -> save anywhere
const restored = parse(json);                       // -> GraphState

getStats(state); // counts by kind / source_kind / author / scope / edge kind
```

For event‑sourced persistence, store the lifecycle events (wrapped in envelopes) and rebuild with `replayCommands` / `replayFromEnvelopes` on startup.

---

## Choosing parameters

Starting points, not prescriptions — calibrate to your domain.

**Decay**

| Scenario | Recommendation |
|----------|----------------|
| Chat context, ephemeral | `{ rate: 0.3, interval: "hour", type: "linear" }` |
| Project / working memory | `{ rate: 0.1, interval: "day", type: "exponential" }` |
| Policies, traits, foundational docs | No decay — a 1972 communiqué can be critical to a 2024 briefing |

**Score weights**

| Goal | Weights |
|------|---------|
| High‑trust retrieval | `{ authority: 0.8, importance: 0.2 }` |
| Attention queue (what needs thinking?) | `{ importance: 0.8, authority: 0.2 }` |
| Balanced | `{ authority: 0.4, conviction: 0.3, importance: 0.3 }` |

**Diversity penalties**

| Goal | Recommendation |
|------|----------------|
| Exploration ("what do we know?") | High `author_penalty` (0.3–0.5) — spread across sources |
| Verification ("is this true?") | Low/zero — you *want* corroborating evidence |
| Audit / debugging | Zero — show everything |

**Contradictions**

| Audience | Mode |
|----------|------|
| User‑facing context | `contradictions: "filter"` (one clean answer) |
| Agent reasoning | `contradictions: "surface"` (see the disagreement) |
| Audit | Neither — call `getContradictions(state)` directly |

---

## The same primitives, across domains

The three target domains in the [whitepaper](./WHITEPAPER.md) exercise the *same* small set of primitives:

| Need | Finance | Law | Geopolitics | MemEX primitive |
|------|---------|-----|-------------|-----------------|
| Differential trust | 10‑K vs. tweet | SCOTUS vs. blog | wire vs. troll | `authority` |
| Author confidence ≠ system trust | analyst conviction | dictum vs. holding | source caveats | `conviction` ⟂ `authority` |
| Salience without endorsement | rumor worth checking | unsettled doctrine | unverified field report | `importance` ⟂ `authority` |
| Provenance | audit trail to filings | brief citations | OSINT chains | `parents` + `getSupportTree` |
| Disagreement preserved | bull/bear theses | conflicting clauses | contradicting OSINT | `CONTRADICTS` + `surface` |
| Supersession without deletion | restatements | overruled cases | retracted reports | `SUPERSEDES` |
| Temporal honesty | point‑in‑time | "as of" doctrine | scenario timing | query‑time `DecayConfig` |
| Branching | shadow portfolios | alternative arguments | scenario worldlines | `exportSlice` / `importSlice` |
| Goal‑tracked work | thesis verification | brief drafting | verification ops | `Intent` + `Task` |
| Avoiding source collapse | correlated funds | over‑citing one circuit | wire‑service echo | diversity penalties |

---

## What MemEX deliberately is *not*

MemEX is a **substrate**, not a thinking system. It makes belief structure cheap to represent; it does not do the reasoning. Known boundaries (see the [whitepaper §10](./WHITEPAPER.md) for detail):

- **It does not assign authority for you.** Importing every source at `0.7` defeats the purpose — calibration is the application's job.
- **It does not detect contradictions.** It makes them easy to *represent*; detecting them is a domain‑specific NLP problem upstream.
- **It is not a probabilistic graphical model.** The three scores are heuristics, not a posterior. Where the math matters, put MemEX *beside* a Bayesian engine, not in place of one.
- **State is in‑memory.** Serialization and replay make persistence straightforward but external; very large or distributed graphs need a partitioning story the library doesn't provide.
- **The three decay curves are coarse.** Real claim half‑lives vary enormously; per‑class decay config is on you.

It is intended to sit **underneath** vector and text search and **above** event logs and persistence — providing the epistemic semantics those layers lack.

```
        Agent / Cognition layer        (thinking, prioritization)
                  │
               ┌──▼──┐
               │MemEX│   ← belief state: trust, conflict, provenance, time
               └──┬──┘
     ┌────────────┼────────────┐
 Vector search  Text search  Event store   (recall + durability)
```

---

## Documentation

- **[API.md](./API.md)** — full public API reference.
- **[WHITEPAPER.md](./WHITEPAPER.md)** — the epistemic‑memory framing and worked examples in finance, law, and geopolitics this README distills.
- **Validation** — `import { MemoryItemSchema, EdgeSchema, IntentSchema, TaskSchema } from "@ai2070/memex/schemas"` (requires `zod >= 4`). Schemas are type‑wired to the source interfaces, so a drift fails the build.

## License

Apache 2.0 — see [LICENSE](./LICENSE).
