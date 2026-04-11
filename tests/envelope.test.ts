import { describe, it, expect } from "vitest";
import {
  wrapLifecycleEvent,
  wrapStateEvent,
  wrapEdgeStateEvent,
} from "../src/envelope.js";
import type { MemoryItem, Edge, MemoryLifecycleEvent } from "../src/types.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const item: MemoryItem = {
  id: "m1",
  scope: "test",
  kind: "observation",
  content: {},
  author: "test",
  source_kind: "observed",
  authority: 1,
};

const edge: Edge = {
  edge_id: "e1",
  from: "m1",
  to: "m2",
  kind: "SUPPORTS",
  author: "test",
  source_kind: "observed",
  authority: 1,
  active: true,
};

describe("wrapLifecycleEvent", () => {
  it("produces correct namespace, type, and valid id", () => {
    const event: MemoryLifecycleEvent = {
      namespace: "memory",
      type: "memory.created",
      item,
      cause_type: "memory.create",
    };
    const env = wrapLifecycleEvent(event, "cmd-123");
    expect(env.id).toMatch(UUID_RE);
    expect(env.namespace).toBe("memory");
    expect(env.type).toBe("memory.created");
    expect(new Date(env.ts).toISOString()).toBe(env.ts);
    expect(env.payload.cause_id).toBe("cmd-123");
    expect(env.payload.item).toEqual(item);
  });

  it("propagates trace_id", () => {
    const event: MemoryLifecycleEvent = {
      namespace: "memory",
      type: "memory.updated",
      item,
    };
    const env = wrapLifecycleEvent(event, "cmd-1", "trace-abc");
    expect(env.trace_id).toBe("trace-abc");
  });

  it("omits trace_id when not provided", () => {
    const event: MemoryLifecycleEvent = {
      namespace: "memory",
      type: "memory.retracted",
      item,
    };
    const env = wrapLifecycleEvent(event, "cmd-1");
    expect(env.trace_id).toBeUndefined();
  });
});

describe("wrapStateEvent", () => {
  it("produces state.memory envelope with cause_id", () => {
    const env = wrapStateEvent(item, "cmd-456");
    expect(env.type).toBe("state.memory");
    expect(env.payload.item).toEqual(item);
    expect(env.payload.cause_id).toBe("cmd-456");
  });

  it("propagates trace_id", () => {
    const env = wrapStateEvent(item, "cmd-1", "trace-xyz");
    expect(env.trace_id).toBe("trace-xyz");
  });
});

describe("wrapEdgeStateEvent", () => {
  it("produces state.edge envelope with cause_id", () => {
    const env = wrapEdgeStateEvent(edge, "cmd-789");
    expect(env.type).toBe("state.edge");
    expect(env.payload.edge).toEqual(edge);
    expect(env.payload.cause_id).toBe("cmd-789");
  });
});
