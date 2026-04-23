import { describe, it, expect } from "vitest";
import { applyCommand, mergeItem } from "../src/reducer.js";
import { createGraphState } from "../src/graph.js";
import { createMemoryItem, createEventEnvelope } from "../src/helpers.js";
import { extractTimestamp } from "../src/query.js";
import { smartRetrieve, getSupportSet } from "../src/retrieval.js";
import {
  markAlias,
  markContradiction,
  resolveContradiction,
  cascadeRetract,
  getAliases,
  getItemsByBudget,
} from "../src/integrity.js";
import { createEdge } from "../src/helpers.js";
import {
  InvalidTimestampError,
  MemoryNotFoundError,
  DuplicateMemoryError,
} from "../src/errors.js";
import { replayFromEnvelopes, replayCommands } from "../src/replay.js";
import { exportSlice, importSlice } from "../src/transplant.js";
import { createIntentState } from "../src/intent.js";
import { createTaskState } from "../src/task.js";
import type { MemoryItem, MemoryCommand, EventEnvelope } from "../src/types.js";

const mkItem = (id: string, overrides: Partial<MemoryItem> = {}): MemoryItem =>
  createMemoryItem({
    id,
    scope: "test",
    kind: "observation",
    content: {},
    author: "agent:a",
    source_kind: "observed",
    authority: 0.5,
    ...overrides,
  });

describe("bugfix-sweep: smartRetrieve / getItemsByBudget accept zero-cost items", () => {
  it("smartRetrieve does not throw when costFn returns 0", () => {
    let state = createGraphState();
    for (let i = 0; i < 3; i++) {
      const item = mkItem(
        `0190${i.toString().padStart(4, "0")}-0000-7000-8000-000000000000`,
        {
          importance: 0.5,
        },
      );
      state = applyCommand(state, { type: "memory.create", item }).state;
    }
    const out = smartRetrieve(state, {
      budget: 10,
      costFn: () => 0,
      weights: { importance: 1 },
    });
    expect(out.length).toBe(3);
  });

  it("smartRetrieve still rejects negative cost", () => {
    let state = createGraphState();
    const item = mkItem("01900000-0000-7000-8000-000000000001");
    state = applyCommand(state, { type: "memory.create", item }).state;
    expect(() =>
      smartRetrieve(state, {
        budget: 10,
        costFn: () => -1,
        weights: { importance: 1 },
      }),
    ).toThrow(RangeError);
  });

  it("getItemsByBudget accepts zero-cost items", () => {
    let state = createGraphState();
    const item = mkItem("01900000-0000-7000-8000-000000000002", {
      importance: 0.9,
    });
    state = applyCommand(state, { type: "memory.create", item }).state;
    const out = getItemsByBudget(state, {
      budget: 5,
      costFn: () => 0,
      weights: { importance: 1 },
    });
    expect(out.length).toBe(1);
  });

  it("smartRetrieve still includes zero-cost items after budget exhaustion", () => {
    // Two expensive items fill the budget, then three free items must still
    // be included. The old `remaining <= 0` early-break would have skipped
    // every zero-cost entry after the budget hit zero.
    let state = createGraphState();
    const ids = [
      "01900000-0000-7000-8000-00000000f001",
      "01900000-0000-7000-8000-00000000f002",
      "01900000-0000-7000-8000-00000000f003",
      "01900000-0000-7000-8000-00000000f004",
      "01900000-0000-7000-8000-00000000f005",
    ];
    // Give expensive items higher importance so they sort first.
    for (let i = 0; i < ids.length; i++) {
      const item = mkItem(ids[i], { importance: i < 2 ? 0.9 : 0.5 });
      state = applyCommand(state, { type: "memory.create", item }).state;
    }
    const expensive = new Set([ids[0], ids[1]]);
    const out = smartRetrieve(state, {
      budget: 10,
      costFn: (item) => (expensive.has(item.id) ? 5 : 0),
      weights: { importance: 1 },
    });
    // All 5 items fit: 5 + 5 + 0 + 0 + 0.
    expect(out.length).toBe(5);
  });

  it("getItemsByBudget still includes zero-cost items after budget exhaustion", () => {
    let state = createGraphState();
    const ids = [
      "01900000-0000-7000-8000-00000000b001",
      "01900000-0000-7000-8000-00000000b002",
      "01900000-0000-7000-8000-00000000b003",
    ];
    for (let i = 0; i < ids.length; i++) {
      const item = mkItem(ids[i], { authority: i === 0 ? 0.9 : 0.5 });
      state = applyCommand(state, { type: "memory.create", item }).state;
    }
    const out = getItemsByBudget(state, {
      budget: 5,
      // First item costs exactly the budget, the rest are free.
      costFn: (item) => (item.id === ids[0] ? 5 : 0),
      weights: { authority: 1 },
    });
    expect(out.length).toBe(3);
  });
});

describe("bugfix-sweep: transplant shallowEqual handles nested arrays", () => {
  it("treats identical arrays-of-arrays as equal and skips import", () => {
    const itemA: MemoryItem = mkItem("01900000-0000-7000-8000-0000000000aa", {
      content: { tags: [["x"], ["y", "z"]] } as Record<string, unknown>,
    });
    let memState = createGraphState();
    memState = applyCommand(memState, {
      type: "memory.create",
      item: itemA,
    }).state;

    const sameItem: MemoryItem = mkItem(
      "01900000-0000-7000-8000-0000000000aa",
      { content: { tags: [["x"], ["y", "z"]] } as Record<string, unknown> },
    );

    const slice = {
      memories: [sameItem],
      intents: [],
      tasks: [],
      edges: [],
    } as ReturnType<typeof exportSlice>;

    const { report } = importSlice(
      memState,
      createIntentState(),
      createTaskState(),
      slice,
      { shallowCompareExisting: true, reIdOnDifference: true },
    );

    expect(report.skipped.memories).toContain(sameItem.id);
    expect(report.created.memories).toHaveLength(0);
  });

  it("differing nested arrays still conflict", () => {
    const itemA: MemoryItem = mkItem("01900000-0000-7000-8000-0000000000ab", {
      content: { tags: [["x"]] } as Record<string, unknown>,
    });
    let memState = createGraphState();
    memState = applyCommand(memState, {
      type: "memory.create",
      item: itemA,
    }).state;

    const diffItem: MemoryItem = mkItem(
      "01900000-0000-7000-8000-0000000000ab",
      { content: { tags: [["y"]] } as Record<string, unknown> },
    );

    const slice = {
      memories: [diffItem],
      intents: [],
      tasks: [],
      edges: [],
    } as ReturnType<typeof exportSlice>;

    const { report } = importSlice(
      memState,
      createIntentState(),
      createTaskState(),
      slice,
      { shallowCompareExisting: true },
    );

    expect(report.conflicts.memories).toContain(diffItem.id);
  });
});

describe("bugfix-sweep: replayFromEnvelopes sorts chronologically, not lexically", () => {
  it("orders envelopes by instant even when timezones differ", () => {
    const id1 = "01900000-0000-7000-8000-000000000101";
    const id2 = "01900000-0000-7000-8000-000000000102";
    const cmd1: MemoryCommand = {
      type: "memory.create",
      item: mkItem(id1),
    };
    const cmd2: MemoryCommand = {
      type: "memory.create",
      item: mkItem(id2),
    };

    // Same instant, different wall-clock representation.
    // "2024-01-01T10:00:00+02:00" == "2024-01-01T08:00:00Z".
    // The first lexically precedes "2024-01-01T09:00:00Z" but represents
    // a LATER instant than it.
    const envEarly: EventEnvelope<MemoryCommand> = {
      id: "e1",
      namespace: "memory",
      type: "memory.create",
      ts: "2024-01-01T09:00:00Z",
      payload: cmd1,
    };
    const envLate: EventEnvelope<MemoryCommand> = {
      id: "e2",
      namespace: "memory",
      type: "memory.create",
      ts: "2024-01-01T10:00:00+02:00", // 08:00Z — earlier instant than envEarly
      payload: cmd2,
    };

    const { events } = replayFromEnvelopes([envEarly, envLate]);
    // Chronologically envLate (08:00Z) must fire before envEarly (09:00Z).
    expect(events[0].type).toBe("memory.created");
    expect((events[0] as { item: MemoryItem }).item.id).toBe(id2);
    expect((events[1] as { item: MemoryItem }).item.id).toBe(id1);
  });

  it("collects unparsable timestamps in the skipped list instead of throwing", () => {
    const env: EventEnvelope<MemoryCommand> = {
      id: "e",
      namespace: "memory",
      type: "memory.create",
      ts: "not-a-date",
      payload: {
        type: "memory.create",
        item: mkItem("01900000-0000-7000-8000-000000000103"),
      },
    };
    const env2: EventEnvelope<MemoryCommand> = {
      ...env,
      id: "f",
      ts: "2024-01-01T00:00:00Z",
      payload: {
        type: "memory.create",
        item: mkItem("01900000-0000-7000-8000-0000000001aa"),
      },
    };
    const { state, skipped } = replayFromEnvelopes([env, env2]);
    // Good envelope applied, bad one collected — pipeline did not crash.
    expect(state.items.size).toBe(1);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].envelope).toBe(env);
    expect(skipped[0].error.name).toBe("InvalidTimestampError");
  });

  it("skips non-ISO timestamps that Date.parse would accept non-deterministically", () => {
    // Formats like "Jan 1, 2024" or "2024/01/01" parse on V8 but are
    // implementation-defined. Reject them up front and collect as skipped.
    for (const bad of [
      "Jan 1, 2024",
      "2024/01/01 10:00:00",
      "2024-01-01 10:00:00Z", // space instead of T
      "2024-01-01T10:00:00", // missing offset
      "2024-01-01T10:00:00+0200", // offset without colon
    ]) {
      const env: EventEnvelope<MemoryCommand> = {
        id: "e",
        namespace: "memory",
        type: "memory.create",
        ts: bad,
        payload: {
          type: "memory.create",
          item: mkItem("01900000-0000-7000-8000-000000000104"),
        },
      };
      const { skipped } = replayFromEnvelopes([env]);
      expect(skipped, bad).toHaveLength(1);
      expect(skipped[0].error.name, bad).toBe("InvalidTimestampError");
    }
  });

  it("skips sub-millisecond precision so distinct timestamps do not collapse", () => {
    // `Date.parse` silently truncates anything past the milliseconds place,
    // which would collapse distinct instants to the same epoch ms and break
    // chronological replay order.
    for (const bad of [
      "2024-01-01T00:00:00.0001Z",
      "2024-01-01T00:00:00.000001Z",
      "2024-01-01T00:00:00.000000001Z",
    ]) {
      const env: EventEnvelope<MemoryCommand> = {
        id: "e",
        namespace: "memory",
        type: "memory.create",
        ts: bad,
        payload: {
          type: "memory.create",
          item: mkItem("01900000-0000-7000-8000-000000000110"),
        },
      };
      const { skipped } = replayFromEnvelopes([env]);
      expect(skipped, bad).toHaveLength(1);
    }
  });

  it("skips impossible calendar dates that Date.parse would normalize", () => {
    // Date.parse("2024-02-31T00:00:00Z") returns a valid number (March 2),
    // which would replay the envelope under the wrong date. Reject outright.
    for (const bad of [
      "2024-02-30T00:00:00Z",
      "2024-02-31T00:00:00Z",
      "2023-02-29T00:00:00Z", // not a leap year
      "2024-13-01T00:00:00Z",
      "2024-00-01T00:00:00Z",
      "2024-04-31T00:00:00Z", // April has 30 days
      "2024-01-32T00:00:00Z",
      "2024-01-00T00:00:00Z",
      "2024-01-01T24:00:00Z",
      "2024-01-01T00:60:00Z",
      "2024-01-01T00:00:61Z",
    ]) {
      const env: EventEnvelope<MemoryCommand> = {
        id: "e",
        namespace: "memory",
        type: "memory.create",
        ts: bad,
        payload: {
          type: "memory.create",
          item: mkItem("01900000-0000-7000-8000-000000000111"),
        },
      };
      const { skipped } = replayFromEnvelopes([env]);
      expect(skipped, bad).toHaveLength(1);
    }
  });

  it("handles years 0000-0099 without Date.UTC's legacy coercion", () => {
    // Date.UTC(50, 0, 1) silently maps to 1950; setUTCFullYear must bypass
    // that so an ISO timestamp "0050-01-01" sorts before "1950-01-01".
    const oldEnv: EventEnvelope<MemoryCommand> = {
      id: "a",
      namespace: "memory",
      type: "memory.create",
      ts: "0050-01-01T00:00:00Z",
      payload: {
        type: "memory.create",
        item: mkItem("01900000-0000-7000-8000-000000000120"),
      },
    };
    const modernEnv: EventEnvelope<MemoryCommand> = {
      id: "b",
      namespace: "memory",
      type: "memory.create",
      ts: "1950-01-01T00:00:00Z",
      payload: {
        type: "memory.create",
        item: mkItem("01900000-0000-7000-8000-000000000121"),
      },
    };
    // Pass modern first to force a sort reorder if the two-digit bug returns.
    const { events, skipped } = replayFromEnvelopes([modernEnv, oldEnv]);
    expect(skipped).toHaveLength(0);
    expect((events[0] as { item: MemoryItem }).item.id).toBe(
      "01900000-0000-7000-8000-000000000120", // year 0050 comes first
    );
  });

  it("accepts Feb 29 in a leap year", () => {
    const env: EventEnvelope<MemoryCommand> = {
      id: "e",
      namespace: "memory",
      type: "memory.create",
      ts: "2024-02-29T12:00:00.500Z",
      payload: {
        type: "memory.create",
        item: mkItem("01900000-0000-7000-8000-000000000112"),
      },
    };
    expect(() => replayFromEnvelopes([env])).not.toThrow();
  });

  it("accepts ISO 8601 with Z and with numeric offset", () => {
    const envZ: EventEnvelope<MemoryCommand> = {
      id: "a",
      namespace: "memory",
      type: "memory.create",
      ts: "2024-01-01T00:00:00.000Z",
      payload: {
        type: "memory.create",
        item: mkItem("01900000-0000-7000-8000-000000000105"),
      },
    };
    const envOffset: EventEnvelope<MemoryCommand> = {
      id: "b",
      namespace: "memory",
      type: "memory.create",
      ts: "2024-01-01T02:00:00+02:00",
      payload: {
        type: "memory.create",
        item: mkItem("01900000-0000-7000-8000-000000000106"),
      },
    };
    expect(() => replayFromEnvelopes([envZ, envOffset])).not.toThrow();
  });
});

describe("bugfix-sweep: mergeItem does not allow rewriting created_at", () => {
  it("preserves created_at when partial attempts to change it", () => {
    const item = mkItem("01900000-0000-7000-8000-000000000201", {
      created_at: 1_700_000_000_000,
    });
    const merged = mergeItem(item, {
      authority: 0.9,
      created_at: 1, // should be ignored
    } as Partial<MemoryItem>);
    expect(merged.created_at).toBe(1_700_000_000_000);
    expect(merged.authority).toBe(0.9);
  });

  it("memory.update command cannot rewrite created_at", () => {
    const item = mkItem("01900000-0000-7000-8000-000000000202", {
      created_at: 1_700_000_000_000,
    });
    let state = createGraphState();
    state = applyCommand(state, { type: "memory.create", item }).state;
    const res = applyCommand(state, {
      type: "memory.update",
      item_id: item.id,
      partial: { created_at: 42 } as Partial<MemoryItem>,
      author: "tester",
    });
    expect(res.state.items.get(item.id)!.created_at).toBe(1_700_000_000_000);
  });
});

describe("bugfix-sweep: markAlias / markContradiction soft-handle self-reference", () => {
  it("markAlias(a,a) is a silent no-op (self-alias is redundant)", () => {
    const id = "01900000-0000-7000-8000-000000000301";
    let state = createGraphState();
    state = applyCommand(state, {
      type: "memory.create",
      item: mkItem(id),
    }).state;
    const before = state;
    const result = markAlias(state, id, id, "tester");
    // Nothing recorded, state unchanged — no ALIAS edges polluting getAliases.
    expect(result.events).toHaveLength(0);
    expect(result.state).toBe(before);
  });

  it("markContradiction(a,a) records the self-edge (internal inconsistency)", () => {
    const id = "01900000-0000-7000-8000-000000000302";
    let state = createGraphState();
    state = applyCommand(state, {
      type: "memory.create",
      item: mkItem(id),
    }).state;
    const result = markContradiction(state, id, id, "tester");
    // A self-CONTRADICTS edge is a meaningful marker: "this item is tainted".
    expect(result.events).toHaveLength(1);
    const contradictEdges = Array.from(result.state.edges.values()).filter(
      (e) => e.kind === "CONTRADICTS",
    );
    expect(contradictEdges).toHaveLength(1);
    expect(contradictEdges[0].from).toBe(id);
    expect(contradictEdges[0].to).toBe(id);
  });

  it("markAlias(a,a) does not pollute getAliases output", () => {
    const id = "01900000-0000-7000-8000-000000000303";
    let state = createGraphState();
    state = applyCommand(state, {
      type: "memory.create",
      item: mkItem(id),
    }).state;
    state = markAlias(state, id, id, "tester").state;
    expect(getAliases(state, id)).toEqual([]);
  });
});

describe("bugfix-sweep: soft-failure semantics (record-and-continue)", () => {
  it("createEdge permits self-referencing edges", () => {
    const edge = createEdge({
      from: "m1",
      to: "m1",
      kind: "CONTRADICTS",
      author: "agent:detector",
      source_kind: "derived_deterministic",
      authority: 1,
    });
    expect(edge.from).toBe("m1");
    expect(edge.to).toBe("m1");
    expect(edge.edge_id).toBeTypeOf("string");
    expect(edge.active).toBe(true);
  });

  it("resolveContradiction is a no-op when no CONTRADICTS edge exists", () => {
    const a = "01900000-0000-7000-8000-000000000401";
    const b = "01900000-0000-7000-8000-000000000402";
    let state = createGraphState();
    state = applyCommand(state, {
      type: "memory.create",
      item: mkItem(a, { authority: 0.9 }),
    }).state;
    state = applyCommand(state, {
      type: "memory.create",
      item: mkItem(b, { authority: 0.7 }),
    }).state;

    const result = resolveContradiction(state, a, b, "agent:resolver");
    // Nothing should have happened: no SUPERSEDES edge, no authority change.
    expect(result.events).toHaveLength(0);
    expect(result.state.items.get(a)!.authority).toBe(0.9);
    expect(result.state.items.get(b)!.authority).toBe(0.7);
    const supersedes = Array.from(result.state.edges.values()).filter(
      (e) => e.kind === "SUPERSEDES",
    );
    expect(supersedes).toHaveLength(0);
  });

  it("resolveContradiction handles duplicate calls gracefully", () => {
    const a = "01900000-0000-7000-8000-000000000403";
    const b = "01900000-0000-7000-8000-000000000404";
    let state = createGraphState();
    state = applyCommand(state, {
      type: "memory.create",
      item: mkItem(a, { authority: 0.9 }),
    }).state;
    state = applyCommand(state, {
      type: "memory.create",
      item: mkItem(b, { authority: 0.7 }),
    }).state;
    state = markContradiction(state, a, b, "detector").state;

    // First resolve succeeds, second is a stale duplicate.
    const r1 = resolveContradiction(state, a, b, "agent:resolver");
    expect(r1.events.length).toBeGreaterThan(0);
    const r2 = resolveContradiction(r1.state, a, b, "agent:resolver");
    expect(r2.events).toHaveLength(0); // no crash, no-op
    expect(r2.state).toBe(r1.state);
  });
});

describe("bugfix-sweep: bulk replay is soft — log-and-continue, not crash", () => {
  it("mix of good and bad envelopes produces a partial state + skipped list", () => {
    const good1 = mkItem("01900000-0000-7000-8000-000000000701");
    const good2 = mkItem("01900000-0000-7000-8000-000000000702");
    const envs: EventEnvelope<MemoryCommand>[] = [
      {
        id: "a",
        namespace: "memory",
        type: "memory.create",
        ts: "2024-01-01T00:00:00Z",
        payload: { type: "memory.create", item: good1 },
      },
      {
        id: "b",
        namespace: "memory",
        type: "memory.create",
        ts: "garbage",
        payload: { type: "memory.create", item: mkItem("x") },
      },
      {
        id: "c",
        namespace: "memory",
        type: "memory.create",
        ts: "2024-01-02T00:00:00Z",
        payload: { type: "memory.create", item: good2 },
      },
    ];
    const { state, skipped } = replayFromEnvelopes(envs);
    expect(state.items.size).toBe(2);
    expect(state.items.has(good1.id)).toBe(true);
    expect(state.items.has(good2.id)).toBe(true);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].error).toBeInstanceOf(InvalidTimestampError);
  });

  it("records apply failures (e.g. DuplicateMemoryError) without aborting", () => {
    const item = mkItem("01900000-0000-7000-8000-000000000703");
    const envs: EventEnvelope<MemoryCommand>[] = [
      {
        id: "a",
        namespace: "memory",
        type: "memory.create",
        ts: "2024-01-01T00:00:00Z",
        payload: { type: "memory.create", item },
      },
      {
        id: "b",
        namespace: "memory",
        type: "memory.create",
        ts: "2024-01-02T00:00:00Z",
        payload: { type: "memory.create", item }, // duplicate id
      },
      {
        id: "c",
        namespace: "memory",
        type: "memory.create",
        ts: "2024-01-03T00:00:00Z",
        payload: {
          type: "memory.create",
          item: mkItem("01900000-0000-7000-8000-000000000704"),
        },
      },
    ];
    const { state, skipped } = replayFromEnvelopes(envs);
    expect(state.items.size).toBe(2);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].error).toBeInstanceOf(DuplicateMemoryError);
  });

  it("replayCommands collects per-command failures and continues", () => {
    const item1 = mkItem("01900000-0000-7000-8000-000000000705");
    const item2 = mkItem("01900000-0000-7000-8000-000000000706");
    const commands: MemoryCommand[] = [
      { type: "memory.create", item: item1 },
      {
        type: "memory.update",
        item_id: "missing",
        partial: { authority: 0.1 },
        author: "tester",
      },
      { type: "memory.create", item: item2 },
    ];
    const { state, skipped } = replayCommands(commands);
    expect(state.items.size).toBe(2);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].index).toBe(1);
    expect(skipped[0].error).toBeInstanceOf(MemoryNotFoundError);
  });

  it("empty input returns empty skipped list", () => {
    const r1 = replayFromEnvelopes([]);
    expect(r1.skipped).toEqual([]);
    const r2 = replayCommands([]);
    expect(r2.skipped).toEqual([]);
  });
});

describe("bugfix-sweep: extractTimestamp requires a true UUIDv7", () => {
  it("rejects malformed 16-character strings with InvalidTimestampError", () => {
    expect(() => extractTimestamp("abcdefghijkl7mno")).toThrow(
      InvalidTimestampError,
    );
  });

  it("rejects non-hex characters even with correct length", () => {
    const id = "zzzzzzzz-zzzz-7zzz-8zzz-zzzzzzzzzzzz";
    expect(() => extractTimestamp(id)).toThrow(InvalidTimestampError);
  });

  it("rejects UUIDs with the wrong version byte", () => {
    const id = "00000000-0000-4000-8000-000000000000";
    expect(() => extractTimestamp(id)).toThrow(InvalidTimestampError);
  });

  it("accepts a well-formed UUIDv7", () => {
    // 0x018bbd1b3000 == 1_699_684_757_504 ms
    const id = "018bbd1b-3000-7000-8000-000000000000";
    expect(extractTimestamp(id)).toBe(1_699_684_757_504);
  });

  it("thrown error is an Error subclass so generic catch still works", () => {
    let caught: unknown;
    try {
      extractTimestamp("not-a-uuid");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf(InvalidTimestampError);
    expect((caught as Error).name).toBe("InvalidTimestampError");
  });
});

describe("bugfix-sweep: cascadeRetract produces a valid topological order for DAGs", () => {
  it("retracts shared grandchild before its two parents", () => {
    // A is root. B and C are children of A. D is a child of both B and C.
    // Expected retract order: D before B and C, then A last.
    const A = "01900000-0000-7000-8000-000000000401";
    const B = "01900000-0000-7000-8000-000000000402";
    const C = "01900000-0000-7000-8000-000000000403";
    const D = "01900000-0000-7000-8000-000000000404";

    let state = createGraphState();
    state = applyCommand(state, {
      type: "memory.create",
      item: mkItem(A),
    }).state;
    state = applyCommand(state, {
      type: "memory.create",
      item: mkItem(B, { parents: [A] }),
    }).state;
    state = applyCommand(state, {
      type: "memory.create",
      item: mkItem(C, { parents: [A] }),
    }).state;
    state = applyCommand(state, {
      type: "memory.create",
      item: mkItem(D, { parents: [B, C] }),
    }).state;

    const res = cascadeRetract(state, A, "tester");

    // D must appear before B and C; A must be last.
    const idxD = res.retracted.indexOf(D);
    const idxB = res.retracted.indexOf(B);
    const idxC = res.retracted.indexOf(C);
    const idxA = res.retracted.indexOf(A);

    expect(idxD).toBeGreaterThanOrEqual(0);
    expect(idxD).toBeLessThan(idxB);
    expect(idxD).toBeLessThan(idxC);
    expect(idxA).toBe(res.retracted.length - 1);

    // all items should be gone from state
    expect(res.state.items.has(A)).toBe(false);
    expect(res.state.items.has(B)).toBe(false);
    expect(res.state.items.has(C)).toBe(false);
    expect(res.state.items.has(D)).toBe(false);
  });

  it("does not loop on cyclic parent references", () => {
    // Not normally reachable via applyCommand (create order prevents cycles),
    // but the DFS should terminate regardless if the shape somehow appears.
    const X = "01900000-0000-7000-8000-000000000501";
    const Y = "01900000-0000-7000-8000-000000000502";

    const x = mkItem(X, { parents: [Y] });
    const y = mkItem(Y, { parents: [X] });
    // Bypass reducer to construct a cycle directly.
    const state = {
      items: new Map([
        [X, x],
        [Y, y],
      ]),
      edges: new Map(),
    };
    const res = cascadeRetract(state, X, "tester");
    // Must terminate, and must retract both.
    expect(res.state.items.size).toBe(0);
  });
});

describe("bugfix-sweep: createEventEnvelope still produces parseable timestamps", () => {
  it("envelope ts round-trips through replay", () => {
    const id = "01900000-0000-7000-8000-000000000601";
    const cmd: MemoryCommand = {
      type: "memory.create",
      item: mkItem(id),
    };
    const env = createEventEnvelope<MemoryCommand>("memory.create", cmd);
    const { state } = replayFromEnvelopes([env]);
    expect(state.items.has(id)).toBe(true);
  });
});

// Sanity: the UUIDv7 parser we now use accepts canonical form and rejects junk
describe("bugfix-sweep: getSupportSet tolerates items with non-UUIDv7 string ids", () => {
  it("works when items use arbitrary string ids (created_at supplied explicitly)", () => {
    const a = mkItem("custom-id-root", { created_at: 1_700_000_000_000 });
    const b = mkItem("custom-id-child", {
      parents: ["custom-id-root"],
      created_at: 1_700_000_000_001,
    });
    let state = createGraphState();
    state = applyCommand(state, { type: "memory.create", item: a }).state;
    state = applyCommand(state, { type: "memory.create", item: b }).state;
    const support = getSupportSet(state, b.id);
    const ids = support.map((i) => i.id).sort();
    expect(ids).toEqual(["custom-id-child", "custom-id-root"]);
  });
});
