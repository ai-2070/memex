import { describe, it, expect, expectTypeOf } from "vitest";
import type {
  MemoryItem,
  Edge,
  EventEnvelope,
  GraphState,
  MemoryCommand,
  MemoryLifecycleEvent,
  MemoryFilter,
} from "../src/types.js";

describe("MemoryItem", () => {
  it("accepts a valid literal", () => {
    const item: MemoryItem = {
      id: "01HV5W1YF3F8R9H1M6V3X6X8A0",
      scope: "user:laz/general",
      kind: "assertion",
      content: { key: "theme", value: "dark" },
      author: "user:laz",
      source_kind: "user_explicit",
      authority: 0.99,
    };
    expect(item.id).toBe("01HV5W1YF3F8R9H1M6V3X6X8A0");
  });

  it("accepts optional fields", () => {
    const item: MemoryItem = {
      id: "m1",
      scope: "test",
      kind: "observation",
      content: {},
      author: "test",
      source_kind: "observed",
      authority: 0.5,
      conviction: 0.8,
      importance: 0.3,
      meta: { agent_id: "agent:x", session_id: "s1", custom: true },
    };
    expect(item.conviction).toBe(0.8);
    expect(item.meta?.custom).toBe(true);
  });

  it("accepts arbitrary kind and source_kind strings", () => {
    const item: MemoryItem = {
      id: "m2",
      scope: "test",
      kind: "custom_kind",
      content: {},
      author: "test",
      source_kind: "custom_source",
      authority: 0.5,
    };
    expect(item.kind).toBe("custom_kind");
    expect(item.source_kind).toBe("custom_source");
  });
});

describe("Edge", () => {
  it("accepts a valid literal", () => {
    const edge: Edge = {
      edge_id: "e1",
      from: "m1",
      to: "m2",
      kind: "DERIVED_FROM",
      author: "system:rule_x",
      source_kind: "derived_deterministic",
      authority: 0.9,
      active: true,
    };
    expect(edge.kind).toBe("DERIVED_FROM");
  });

  it("accepts optional weight and meta", () => {
    const edge: Edge = {
      edge_id: "e2",
      from: "m1",
      to: "m3",
      kind: "SUPPORTS",
      weight: 0.7,
      author: "agent:reasoner",
      source_kind: "agent_inferred",
      authority: 0.6,
      active: true,
      meta: { reason: "correlation" },
    };
    expect(edge.weight).toBe(0.7);
  });
});

describe("MemoryCommand discriminated union", () => {
  it("narrows memory.create to access cmd.item", () => {
    const cmd: MemoryCommand = {
      type: "memory.create",
      item: {
        id: "m1",
        scope: "test",
        kind: "observation",
        content: {},
        author: "test",
        source_kind: "observed",
        authority: 1,
      },
    };
    if (cmd.type === "memory.create") {
      expectTypeOf(cmd.item).toEqualTypeOf<MemoryItem>();
      expect(cmd.item.id).toBe("m1");
    }
  });

  it("narrows memory.update to access cmd.partial and cmd.item_id", () => {
    const cmd: MemoryCommand = {
      type: "memory.update",
      item_id: "m1",
      partial: { authority: 0.5 },
      author: "system:tuner",
    };
    if (cmd.type === "memory.update") {
      expectTypeOf(cmd.item_id).toBeString();
      expectTypeOf(cmd.partial).toEqualTypeOf<Partial<MemoryItem>>();
    }
  });

  it("narrows edge.create to access cmd.edge", () => {
    const cmd: MemoryCommand = {
      type: "edge.create",
      edge: {
        edge_id: "e1",
        from: "m1",
        to: "m2",
        kind: "SUPPORTS",
        author: "test",
        source_kind: "observed",
        authority: 1,
        active: true,
      },
    };
    if (cmd.type === "edge.create") {
      expectTypeOf(cmd.edge).toEqualTypeOf<Edge>();
    }
  });
});

describe("EventEnvelope", () => {
  it("types payload generically", () => {
    const env: EventEnvelope<{ item: MemoryItem }> = {
      id: "ev1",
      namespace: "memory",
      type: "state.memory",
      ts: "2026-04-10T19:30:00.010Z",
      payload: {
        item: {
          id: "m1",
          scope: "test",
          kind: "observation",
          content: {},
          author: "test",
          source_kind: "observed",
          authority: 1,
        },
      },
    };
    expectTypeOf(env.payload.item).toEqualTypeOf<MemoryItem>();
    expect(env.namespace).toBe("memory");
  });

  it("accepts optional trace_id", () => {
    const env: EventEnvelope<null> = {
      id: "ev2",
      namespace: "memory",
      type: "test",
      ts: "2026-01-01T00:00:00Z",
      trace_id: "trace-123",
      payload: null,
    };
    expect(env.trace_id).toBe("trace-123");
  });
});

describe("GraphState", () => {
  it("constructs with empty Maps", () => {
    const state: GraphState = { items: new Map(), edges: new Map() };
    expect(state.items.size).toBe(0);
    expect(state.edges.size).toBe(0);
  });
});

describe("MemoryLifecycleEvent", () => {
  it("has namespace memory and dot-notation type", () => {
    const event: MemoryLifecycleEvent = {
      namespace: "memory",
      type: "memory.created",
      item: {
        id: "m1",
        scope: "test",
        kind: "observation",
        content: {},
        author: "test",
        source_kind: "observed",
        authority: 1,
      },
      cause_type: "memory.create",
    };
    expect(event.namespace).toBe("memory");
    expect(event.type).toBe("memory.created");
  });
});

describe("MemoryFilter", () => {
  it("accepts an empty object (all fields optional)", () => {
    const filter: MemoryFilter = {};
    expect(filter).toEqual({});
  });

  it("accepts all fields including range", () => {
    const filter: MemoryFilter = {
      scope: "user:laz/general",
      author: "user:laz",
      kind: "observation",
      source_kind: "observed",
      range: {
        authority: { min: 0.3, max: 0.9 },
        conviction: { min: 0.2 },
        importance: { max: 0.7 },
      },
      not: { or: [{ kind: "simulation" }, { kind: "hypothesis" }] },
      meta: { agent_id: "agent:foo" },
      or: [{ kind: "trait" }],
    };
    expect(filter.scope).toBe("user:laz/general");
  });
});
