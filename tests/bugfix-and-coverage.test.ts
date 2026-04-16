import { describe, it, expect } from "vitest";
import { applyCommand, mergeItem } from "../src/reducer.js";
import { createGraphState } from "../src/graph.js";
import {
  getItems,
  getEdges,
  getScoredItems,
  extractTimestamp,
} from "../src/query.js";
import {
  filterContradictions,
  surfaceContradictions,
  applyDiversity,
  smartRetrieve,
} from "../src/retrieval.js";
import {
  getContradictions,
  markContradiction,
  resolveContradiction,
  getStaleItems,
  getDependents,
  cascadeRetract,
  getAliases,
  getAliasGroup,
} from "../src/integrity.js";
import {
  createIntentState,
  createIntent,
  applyIntentCommand,
  InvalidIntentTransitionError,
} from "../src/intent.js";
import {
  createTaskState,
  createTask,
  applyTaskCommand,
  InvalidTaskTransitionError,
} from "../src/task.js";
import { exportSlice, importSlice } from "../src/transplant.js";
import { toJSON, fromJSON, stringify, parse } from "../src/serialization.js";
import { cloneGraphState } from "../src/graph.js";
import { DuplicateMemoryError, EdgeNotFoundError } from "../src/errors.js";
import type { MemoryItem, Edge, GraphState, ScoredItem } from "../src/types.js";
import type { IntentState, Intent } from "../src/intent.js";
import type { TaskState, Task } from "../src/task.js";

// -- helpers --

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

const makeEdge = (
  id: string,
  from: string,
  to: string,
  kind: string = "SUPPORTS",
  overrides: Partial<Edge> = {},
): Edge => ({
  edge_id: id,
  from,
  to,
  kind,
  author: "system:rule",
  source_kind: "derived_deterministic",
  authority: 0.8,
  active: true,
  ...overrides,
});

function stateWith(items: MemoryItem[], edges: Edge[] = []): GraphState {
  const s = createGraphState();
  for (const i of items) s.items.set(i.id, i);
  for (const e of edges) s.edges.set(e.edge_id, e);
  return s;
}

function toScored(items: MemoryItem[], scores: number[]): ScoredItem[] {
  return items.map((item, i) => ({ item, score: scores[i] }));
}

const makeIntent = (overrides: Partial<Intent> = {}): Intent => ({
  id: "i1",
  label: "find_kati",
  priority: 0.8,
  owner: "user:laz",
  status: "active",
  ...overrides,
});

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: "t1",
  intent_id: "i1",
  action: "search_linkedin",
  status: "pending",
  priority: 0.7,
  attempt: 0,
  ...overrides,
});

// ============================================================
// BUG FIX: mergeEdge strips undefined and protects identity fields
// ============================================================

describe("edge.update — mergeEdge fixes", () => {
  it("does not overwrite edge fields with undefined", () => {
    const state = stateWith(
      [],
      [makeEdge("e1", "m1", "m2", "SUPPORTS", { weight: 0.8 })],
    );
    const { state: next } = applyCommand(state, {
      type: "edge.update",
      edge_id: "e1",
      partial: { weight: undefined, kind: "ABOUT" } as Partial<Edge>,
      author: "test",
    });
    const edge = next.edges.get("e1")!;
    expect(edge.weight).toBe(0.8); // preserved, not overwritten with undefined
    expect(edge.kind).toBe("ABOUT"); // actual update applied
  });

  it("ignores edge_id in partial (cannot change identity)", () => {
    const state = stateWith([], [makeEdge("e1", "m1", "m2")]);
    const { state: next } = applyCommand(state, {
      type: "edge.update",
      edge_id: "e1",
      partial: { edge_id: "sneaky" } as Partial<Edge>,
      author: "test",
    });
    const edge = next.edges.get("e1")!;
    expect(edge.edge_id).toBe("e1"); // identity preserved
    expect(next.edges.has("sneaky")).toBe(false);
  });

  it("ignores from/to in partial (cannot change endpoints)", () => {
    const state = stateWith([], [makeEdge("e1", "m1", "m2")]);
    const { state: next } = applyCommand(state, {
      type: "edge.update",
      edge_id: "e1",
      partial: { from: "x", to: "y" } as Partial<Edge>,
      author: "test",
    });
    const edge = next.edges.get("e1")!;
    expect(edge.from).toBe("m1");
    expect(edge.to).toBe("m2");
  });
});

// ============================================================
// BUG FIX: intent.update cannot bypass state machine
// ============================================================

describe("intent.update — status protection", () => {
  it("ignores status in partial, does not bypass state machine", () => {
    const intent = makeIntent({ status: "active" });
    let state = createIntentState();
    state = applyIntentCommand(state, {
      type: "intent.create",
      intent,
    }).state;

    // attempt to set status to "completed" via update
    const { state: next } = applyIntentCommand(state, {
      type: "intent.update",
      intent_id: "i1",
      partial: { status: "completed" } as Partial<Intent>,
      author: "test",
    });
    // status should remain "active"
    expect(next.intents.get("i1")!.status).toBe("active");
  });

  it("cannot set status to cancelled via update on cancelled intent", () => {
    const intent = makeIntent({ status: "active" });
    let state = createIntentState();
    state = applyIntentCommand(state, {
      type: "intent.create",
      intent,
    }).state;
    state = applyIntentCommand(state, {
      type: "intent.cancel",
      intent_id: "i1",
      author: "test",
    }).state;

    // try to "revive" a cancelled intent via update
    const { state: next } = applyIntentCommand(state, {
      type: "intent.update",
      intent_id: "i1",
      partial: { status: "active" } as Partial<Intent>,
      author: "test",
    });
    expect(next.intents.get("i1")!.status).toBe("cancelled");
  });

  it("still allows updating other fields", () => {
    const intent = makeIntent();
    let state = createIntentState();
    state = applyIntentCommand(state, {
      type: "intent.create",
      intent,
    }).state;
    const { state: next } = applyIntentCommand(state, {
      type: "intent.update",
      intent_id: "i1",
      partial: { label: "new_label", priority: 0.3 },
      author: "test",
    });
    expect(next.intents.get("i1")!.label).toBe("new_label");
    expect(next.intents.get("i1")!.priority).toBe(0.3);
    expect(next.intents.get("i1")!.status).toBe("active"); // unchanged
  });
});

// ============================================================
// BUG FIX: task.update cannot bypass state machine
// ============================================================

describe("task.update — status protection", () => {
  it("ignores status in partial, does not bypass state machine", () => {
    const task = makeTask({ status: "pending" });
    let state = createTaskState();
    state = applyTaskCommand(state, { type: "task.create", task }).state;

    const { state: next } = applyTaskCommand(state, {
      type: "task.update",
      task_id: "t1",
      partial: { status: "completed" } as Partial<Task>,
      author: "test",
    });
    expect(next.tasks.get("t1")!.status).toBe("pending");
  });

  it("cannot revive a failed task via update", () => {
    const task = makeTask({ status: "pending" });
    let state = createTaskState();
    state = applyTaskCommand(state, { type: "task.create", task }).state;
    state = applyTaskCommand(state, {
      type: "task.start",
      task_id: "t1",
    }).state;
    state = applyTaskCommand(state, {
      type: "task.fail",
      task_id: "t1",
      error: "oops",
    }).state;

    const { state: next } = applyTaskCommand(state, {
      type: "task.update",
      task_id: "t1",
      partial: { status: "running" } as Partial<Task>,
      author: "test",
    });
    expect(next.tasks.get("t1")!.status).toBe("failed");
  });
});

// ============================================================
// BUG FIX: applyDiversity preserves contradicted_by
// ============================================================

describe("applyDiversity — contradicted_by preservation", () => {
  it("preserves contradicted_by annotations through diversity", () => {
    const m1 = makeItem("m1", { author: "a" });
    const m2 = makeItem("m2", { author: "a" });
    const m3 = makeItem("m3", { author: "b" });

    const scored: ScoredItem[] = [
      { item: m1, score: 0.9, contradicted_by: [m3] },
      { item: m2, score: 0.8 },
      { item: m3, score: 0.7, contradicted_by: [m1] },
    ];

    const result = applyDiversity(scored, { author_penalty: 0.1 });
    const r1 = result.find((s) => s.item.id === "m1")!;
    const r3 = result.find((s) => s.item.id === "m3")!;
    expect(r1.contradicted_by).toEqual([m3]);
    expect(r3.contradicted_by).toEqual([m1]);
  });
});

// ============================================================
// BUG FIX: smartRetrieve surface+diversity preserves contradicted_by
// ============================================================

describe("smartRetrieve — surface + diversity pipeline", () => {
  it("returns contradicted_by when both surface and diversity are used", () => {
    const m1 = makeItem("m1", { authority: 0.9, author: "a" });
    const m2 = makeItem("m2", { authority: 0.8, author: "a" });
    let state = stateWith([m1, m2]);
    const { state: marked } = markContradiction(
      state,
      "m1",
      "m2",
      "system:detector",
    );

    const result = smartRetrieve(marked, {
      budget: 1000,
      costFn: () => 1,
      weights: { authority: 1 },
      contradictions: "surface",
      diversity: { author_penalty: 0.05 },
    });

    const item1 = result.find((s) => s.item.id === "m1");
    const item2 = result.find((s) => s.item.id === "m2");
    expect(item1?.contradicted_by).toBeDefined();
    expect(item1!.contradicted_by!.length).toBeGreaterThan(0);
    expect(item2?.contradicted_by).toBeDefined();
  });
});

// ============================================================
// BUG FIX: computeDecayMultiplier throws on unknown interval
// ============================================================

describe("decay interval validation", () => {
  it("throws RangeError for unknown decay interval", () => {
    const m1 = makeItem("m1", {
      authority: 0.5,
      created_at: Date.now() - 86_400_000,
    });
    const state = stateWith([m1]);

    expect(() =>
      getScoredItems(state, {
        authority: 1,
        decay: {
          rate: 0.1,
          interval: "month" as any,
          type: "exponential",
        },
      }),
    ).toThrow(RangeError);
  });

  it("throws with descriptive message for unknown interval", () => {
    const m1 = makeItem("m1", {
      authority: 0.5,
      created_at: Date.now() - 86_400_000,
    });
    const state = stateWith([m1]);

    expect(() =>
      getScoredItems(state, {
        authority: 1,
        decay: {
          rate: 0.1,
          interval: "month" as any,
          type: "exponential",
        },
      }),
    ).toThrow(/Unknown decay interval.*month/);
  });
});

// ============================================================
// COVERAGE: resolveContradiction without prior CONTRADICTS edge
// ============================================================

describe("resolveContradiction edge cases", () => {
  it("throws when no CONTRADICTS edge exists between the items", () => {
    const state = stateWith([
      makeItem("m1", { authority: 0.9 }),
      makeItem("m2", { authority: 0.7 }),
    ]);
    // no markContradiction first — calling resolve directly should throw
    expect(() =>
      resolveContradiction(state, "m1", "m2", "system:resolver"),
    ).toThrow(/No active CONTRADICTS edge/);
  });
});

// ============================================================
// COVERAGE: filterContradictions tie-breaking
// ============================================================

describe("filterContradictions — equal scores", () => {
  it("excludes one item when scores are exactly equal", () => {
    const m1 = makeItem("m1");
    const m2 = makeItem("m2");
    let state = stateWith([m1, m2]);
    state = markContradiction(state, "m1", "m2", "system:detector").state;

    const scored = toScored([m1, m2], [0.5, 0.5]);
    const filtered = filterContradictions(state, scored);
    // one should be excluded
    expect(filtered).toHaveLength(1);
  });

  it("tiebreaks deterministically regardless of edge direction", () => {
    const m1 = makeItem("aaa");
    const m2 = makeItem("zzz");

    // edge direction: m1 -> m2
    let state1 = stateWith([m1, m2]);
    state1 = markContradiction(state1, "aaa", "zzz", "sys").state;
    const r1 = filterContradictions(state1, toScored([m1, m2], [0.5, 0.5]));

    // edge direction: m2 -> m1
    let state2 = stateWith([m1, m2]);
    state2 = markContradiction(state2, "zzz", "aaa", "sys").state;
    const r2 = filterContradictions(state2, toScored([m1, m2], [0.5, 0.5]));

    // same item should survive regardless of edge direction
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
    expect(r1[0].item.id).toBe(r2[0].item.id);
    // lexicographically smaller id survives
    expect(r1[0].item.id).toBe("aaa");
  });
});

// ============================================================
// COVERAGE: getContradictions when one side is retracted
// ============================================================

describe("getContradictions — retracted items", () => {
  it("skips contradictions where one item has been retracted", () => {
    const m1 = makeItem("m1");
    const m2 = makeItem("m2");
    let state = stateWith([m1, m2]);
    state = markContradiction(state, "m1", "m2", "system:detector").state;
    // retract m2
    state = applyCommand(state, {
      type: "memory.retract",
      item_id: "m2",
      author: "test",
    }).state;

    const contradictions = getContradictions(state);
    expect(contradictions).toHaveLength(0);
  });
});

// ============================================================
// COVERAGE: getScoredItems with post filter
// ============================================================

describe("getScoredItems — post filter", () => {
  it("applies post filter after scoring", () => {
    const state = stateWith([
      makeItem("m1", { authority: 0.9, scope: "a" }),
      makeItem("m2", { authority: 0.8, scope: "b" }),
      makeItem("m3", { authority: 0.7, scope: "a" }),
    ]);

    const result = getScoredItems(
      state,
      { authority: 1 },
      {
        post: { scope: "a" },
      },
    );
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.item.scope === "a")).toBe(true);
    // should be sorted by score
    expect(result[0].item.id).toBe("m1");
    expect(result[1].item.id).toBe("m3");
  });

  it("post filter can use score-based range after scoring", () => {
    const state = stateWith([
      makeItem("m1", { authority: 0.9, importance: 0.1 }),
      makeItem("m2", { authority: 0.3, importance: 0.9 }),
      makeItem("m3", { authority: 0.1, importance: 0.1 }),
    ]);

    // score by authority, then post-filter for high-importance only
    const result = getScoredItems(
      state,
      { authority: 1 },
      { post: { range: { importance: { min: 0.5 } } } },
    );
    expect(result).toHaveLength(1);
    expect(result[0].item.id).toBe("m2");
  });
});

// ============================================================
// COVERAGE: getEdges with to filter
// ============================================================

describe("getEdges — to filter", () => {
  it("filters edges by to field", () => {
    const state = stateWith(
      [],
      [
        makeEdge("e1", "m1", "m2"),
        makeEdge("e2", "m1", "m3"),
        makeEdge("e3", "m2", "m3"),
      ],
    );
    const result = getEdges(state, { to: "m3" });
    expect(result).toHaveLength(2);
    expect(result.every((e) => e.to === "m3")).toBe(true);
  });
});

// ============================================================
// COVERAGE: cascadeRetract on nonexistent item
// ============================================================

describe("cascadeRetract — edge cases", () => {
  it("returns empty retracted list for nonexistent item", () => {
    const state = stateWith([makeItem("m1")]);
    const { state: next, retracted } = cascadeRetract(
      state,
      "nonexistent",
      "test",
    );
    expect(retracted).toHaveLength(0);
    expect(next.items.has("m1")).toBe(true);
  });

  it("handles circular parent-child dependencies", () => {
    // m1 -> m2 -> m3 -> m1 (cycle via parents)
    const state = stateWith([
      makeItem("m1", { parents: ["m3"] }),
      makeItem("m2", { parents: ["m1"] }),
      makeItem("m3", { parents: ["m2"] }),
    ]);
    const deps = getDependents(state, "m1", true);
    // should not infinite loop; should find m2 and m3
    expect(deps.length).toBeGreaterThanOrEqual(2);
    const ids = deps.map((d) => d.id).sort();
    expect(ids).toContain("m2");
    expect(ids).toContain("m3");
  });
});

// ============================================================
// COVERAGE: getAliasGroup with nonexistent start
// ============================================================

describe("getAliasGroup — nonexistent item", () => {
  it("returns empty array for nonexistent item id", () => {
    const state = stateWith([makeItem("m1")]);
    const group = getAliasGroup(state, "nonexistent");
    expect(group).toHaveLength(0);
  });
});

// ============================================================
// COVERAGE: cloneGraphState shallow clone behavior
// ============================================================

describe("cloneGraphState — shallow clone", () => {
  it("Map-level mutations do not affect original", () => {
    const state = stateWith([makeItem("m1")]);
    const clone = cloneGraphState(state);
    clone.items.delete("m1");
    expect(state.items.has("m1")).toBe(true);
    expect(clone.items.has("m1")).toBe(false);
  });

  it("value-level references are shared (shallow)", () => {
    const state = stateWith([makeItem("m1", { content: { x: 1 } })]);
    const clone = cloneGraphState(state);
    // both maps point to the same MemoryItem object
    expect(clone.items.get("m1")).toBe(state.items.get("m1"));
  });
});

// ============================================================
// COVERAGE: extractTimestamp with non-uuidv7 ids
// ============================================================

describe("extractTimestamp — edge cases", () => {
  it("throws for non-uuidv7 formatted id", () => {
    expect(() => extractTimestamp("not-a-uuid")).toThrow("not a valid UUIDv7");
  });

  it("extracts valid timestamp from real uuidv7", () => {
    // uuidv7 encodes timestamp in first 48 bits
    const now = Date.now();
    const ts = extractTimestamp(
      now.toString(16).padStart(12, "0").slice(0, 8) +
        "-" +
        now.toString(16).padStart(12, "0").slice(8, 12) +
        "-7000-8000-000000000000",
    );
    expect(ts).toBe(now);
  });
});

// ============================================================
// COVERAGE: serialization.parse with malformed input
// ============================================================

describe("serialization — error handling", () => {
  it("throws on malformed JSON", () => {
    expect(() => parse("{not valid json")).toThrow();
  });

  it("creates empty maps when items field is missing", () => {
    // parse doesn't validate shape — this documents the behavior
    const state = parse('{"edges": []}');
    expect(state.items.size).toBe(0);
    expect(state.edges.size).toBe(0);
  });

  it("round-trips correctly", () => {
    const state = stateWith(
      [makeItem("m1", { content: { text: "hello" } })],
      [makeEdge("e1", "m1", "m2")],
    );
    const json = stringify(state);
    const restored = parse(json);
    expect(restored.items.get("m1")!.content).toEqual({ text: "hello" });
    expect(restored.edges.get("e1")!.from).toBe("m1");
  });
});

// ============================================================
// COVERAGE: importSlice with skipExistingIds: false + collision
// ============================================================

describe("importSlice — skipExistingIds: false", () => {
  it("updates existing memory when importing with skipExisting=false", () => {
    const mem = stateWith([makeItem("m1")]);
    const intents = createIntentState();
    const tasks = createTaskState();

    const slice = {
      memories: [makeItem("m1", { content: { new: true } })],
      edges: [],
      intents: [],
      tasks: [],
    };

    const result = importSlice(mem, intents, tasks, slice, {
      skipExistingIds: false,
    });
    expect(result.memState.items.get("m1")!.content).toEqual({ new: true });
    expect(result.report.updated.memories).toEqual(["m1"]);
  });

  it("creates non-colliding items with skipExisting=false", () => {
    const mem = stateWith([makeItem("m1")]);
    const intents = createIntentState();
    const tasks = createTaskState();

    const slice = {
      memories: [makeItem("m2")],
      edges: [],
      intents: [],
      tasks: [],
    };

    const result = importSlice(mem, intents, tasks, slice, {
      skipExistingIds: false,
    });
    expect(result.memState.items.has("m2")).toBe(true);
    expect(result.report.created.memories).toContain("m2");
  });
});

// ============================================================
// COVERAGE: exportSlice with include_aliases
// ============================================================

describe("exportSlice — include_aliases", () => {
  it("walks alias edges and includes aliased items", () => {
    const m1 = makeItem("m1");
    const m2 = makeItem("m2");
    const m3 = makeItem("m3");
    let state = stateWith([m1, m2, m3]);
    const { state: aliased } = applyCommand(state, {
      type: "edge.create",
      edge: makeEdge("ae1", "m1", "m2", "ALIAS"),
    });
    const { state: aliased2 } = applyCommand(aliased, {
      type: "edge.create",
      edge: makeEdge("ae2", "m2", "m3", "ALIAS"),
    });

    const intents = createIntentState();
    const tasks = createTaskState();

    const slice = exportSlice(aliased2, intents, tasks, {
      memory_ids: ["m1"],
      include_aliases: true,
    });

    const ids = slice.memories.map((m) => m.id).sort();
    expect(ids).toContain("m1");
    expect(ids).toContain("m2");
    expect(ids).toContain("m3");
    // alias edges should be included
    expect(slice.edges.length).toBeGreaterThanOrEqual(2);
  });
});

// ============================================================
// COVERAGE: smartRetrieve with no contradiction handling
// ============================================================

describe("smartRetrieve — no contradiction handling", () => {
  it("returns all items when contradictions option is undefined", () => {
    const m1 = makeItem("m1", { authority: 0.9 });
    const m2 = makeItem("m2", { authority: 0.8 });
    let state = stateWith([m1, m2]);
    state = markContradiction(state, "m1", "m2", "system:detector").state;

    const result = smartRetrieve(state, {
      budget: 1000,
      costFn: () => 1,
      weights: { authority: 1 },
      // contradictions: undefined — no handling
    });
    // both items should be returned
    expect(result).toHaveLength(2);
  });
});

// ============================================================
// COVERAGE: surfaceContradictions idempotency
// ============================================================

describe("surfaceContradictions — repeated calls", () => {
  it("does not accumulate duplicate contradicted_by entries on fresh clone", () => {
    const m1 = makeItem("m1");
    const m2 = makeItem("m2");
    let state = stateWith([m1, m2]);
    state = markContradiction(state, "m1", "m2", "system:detector").state;

    const scored = toScored([m1, m2], [0.5, 0.5]);
    const result1 = surfaceContradictions(state, scored);
    // calling again with fresh scored (no stale contradicted_by)
    const result2 = surfaceContradictions(
      state,
      toScored([m1, m2], [0.5, 0.5]),
    );

    const r1m1 = result1.find((s) => s.item.id === "m1")!;
    const r2m1 = result2.find((s) => s.item.id === "m1")!;
    expect(r1m1.contradicted_by).toHaveLength(1);
    expect(r2m1.contradicted_by).toHaveLength(1);
  });
});

// ============================================================
// COVERAGE: applyDiversity with mixed parent/no-parent items
// ============================================================

describe("applyDiversity — mixed parents", () => {
  it("handles items with and without parents", () => {
    const m1 = makeItem("m1", { parents: ["p1"] });
    const m2 = makeItem("m2"); // no parents
    const m3 = makeItem("m3", { parents: ["p1"] });

    const scored = toScored([m1, m2, m3], [0.9, 0.8, 0.7]);
    const result = applyDiversity(scored, { parent_penalty: 0.1 });

    // m1 has parent p1 (first seen, no penalty)
    // m2 has no parents (no penalty)
    // m3 has parent p1 (second occurrence, penalty applied)
    const m3result = result.find((s) => s.item.id === "m3")!;
    expect(m3result.score).toBeLessThan(0.7); // penalty applied
    const m2result = result.find((s) => s.item.id === "m2")!;
    expect(m2result.score).toBe(0.8); // no penalty
  });
});

// ============================================================
// COVERAGE: memory.update — mergeItem behavior
// ============================================================

describe("mergeItem — edge cases", () => {
  it("setting content key to undefined preserves it", () => {
    const existing = makeItem("m1", { content: { a: 1, b: 2 } });
    const merged = mergeItem(existing, {
      content: { a: undefined, c: 3 } as any,
    });
    // a should be preserved (undefined means no change), b preserved, c added
    expect(merged.content.a).toBe(1);
    expect(merged.content.b).toBe(2);
    expect(merged.content.c).toBe(3);
  });

  it("setting meta key to undefined preserves it", () => {
    const existing = makeItem("m1", { meta: { agent_id: "bot", x: 1 } });
    const merged = mergeItem(existing, {
      meta: { agent_id: undefined, y: 2 } as any,
    });
    expect(merged.meta!.agent_id).toBe("bot");
    expect(merged.meta!.x).toBe(1);
    expect(merged.meta!.y).toBe(2);
  });

  it("does not allow changing id via partial", () => {
    const existing = makeItem("m1");
    const merged = mergeItem(existing, { id: "sneaky" });
    expect(merged.id).toBe("m1");
  });
});

// ============================================================
// COVERAGE: importSlice re-id on intents and tasks
// ============================================================

describe("importSlice — re-id intents and tasks", () => {
  it("remaps intent root_memory_ids when memories are re-id'd", () => {
    const memId = fakeUuid(1);
    const intentId = fakeUuid(2);
    // set up existing state with memId
    const mem = stateWith([makeItem(memId, { content: { old: true } })]);
    const intents = createIntentState();
    const tasks = createTaskState();

    // slice has memId (different content) and intent referencing memId
    const slice = {
      memories: [makeItem(memId, { content: { new: true } })],
      edges: [],
      intents: [
        makeIntent({
          id: intentId,
          root_memory_ids: [memId],
        }),
      ],
      tasks: [],
    };

    const result = importSlice(mem, intents, tasks, slice, {
      skipExistingIds: true,
      shallowCompareExisting: true,
      reIdOnDifference: true,
    });

    // memory should have been re-id'd
    expect(result.report.created.memories).toHaveLength(1);
    const newMemId = result.report.created.memories[0];
    expect(newMemId).not.toBe(memId);

    // intent should reference the new memory id
    const importedIntent = result.report.created.intents[0];
    const intent = result.intentState.intents.get(importedIntent)!;
    expect(intent.root_memory_ids).toContain(newMemId);
    expect(intent.root_memory_ids).not.toContain(memId);
  });

  it("remaps task memory ids when memories are re-id'd", () => {
    const memId = fakeUuid(1);
    const intentId = fakeUuid(2);
    const taskId = fakeUuid(3);
    const mem = stateWith([makeItem(memId, { content: { old: true } })]);
    let intents = createIntentState();
    intents = applyIntentCommand(intents, {
      type: "intent.create",
      intent: makeIntent({ id: intentId }),
    }).state;
    const tasks = createTaskState();

    const slice = {
      memories: [makeItem(memId, { content: { new: true } })],
      edges: [],
      intents: [],
      tasks: [
        makeTask({
          id: taskId,
          intent_id: intentId,
          input_memory_ids: [memId],
          output_memory_ids: [memId],
        }),
      ],
    };

    const result = importSlice(mem, intents, tasks, slice, {
      skipExistingIds: true,
      shallowCompareExisting: true,
      reIdOnDifference: true,
    });

    const newMemId = result.report.created.memories[0];
    const importedTaskId = result.report.created.tasks[0];
    const task = result.taskState.tasks.get(importedTaskId)!;
    expect(task.input_memory_ids).toContain(newMemId);
    expect(task.output_memory_ids).toContain(newMemId);
  });
});

// ============================================================
// COVERAGE: edge collision in importSlice
// ============================================================

describe("importSlice — edge collision", () => {
  it("skips edge when id already exists and skipExisting is true", () => {
    const edge = makeEdge("e1", "m1", "m2");
    const mem = stateWith([makeItem("m1"), makeItem("m2")], [edge]);
    const intents = createIntentState();
    const tasks = createTaskState();

    const slice = {
      memories: [],
      edges: [makeEdge("e1", "m1", "m2", "ABOUT")],
      intents: [],
      tasks: [],
    };

    const result = importSlice(mem, intents, tasks, slice);
    expect(result.report.skipped.edges).toContain("e1");
    // original edge should be unchanged
    expect(result.memState.edges.get("e1")!.kind).toBe("SUPPORTS");
  });
});

// ============================================================
// COVERAGE: created filter boundary (exclusive after)
// ============================================================

describe("created filter — boundary semantics", () => {
  it("before is exclusive (item at exact boundary is excluded)", () => {
    // Create an item with a known id that encodes a specific timestamp
    const ts = 1700000000000;
    const hex = ts.toString(16).padStart(12, "0");
    const id =
      hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-7000-8000-000000000000";

    const state = stateWith([makeItem(id)]);
    const items = getItems(state, { created: { before: ts } });
    expect(items).toHaveLength(0); // exclusive: at exactly ts, excluded
  });

  it("after is inclusive (item at exact boundary is included)", () => {
    const ts = 1700000000000;
    const hex = ts.toString(16).padStart(12, "0");
    const id =
      hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-7000-8000-000000000000";

    const state = stateWith([makeItem(id)]);
    const items = getItems(state, { created: { after: ts } });
    expect(items).toHaveLength(1); // inclusive: at exactly ts, included
  });

  it("item between before and after is included", () => {
    const ts = 1700000000000;
    const hex = ts.toString(16).padStart(12, "0");
    const id =
      hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-7000-8000-000000000000";

    const state = stateWith([makeItem(id)]);
    const items = getItems(state, {
      created: { after: ts - 1, before: ts + 1 },
    });
    expect(items).toHaveLength(1);
  });
});
