import { describe, it, expect } from "vitest";
import {
  createMemoryItem,
  createEdge,
  createEventEnvelope,
} from "../src/helpers.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("createMemoryItem", () => {
  const base = {
    scope: "test",
    kind: "observation" as const,
    content: { key: "value" },
    author: "user:laz",
    source_kind: "observed" as const,
    authority: 0.9,
  };

  it("generates a valid uuidv7 id", () => {
    const item = createMemoryItem(base);
    expect(item.id).toMatch(UUID_RE);
  });

  it("preserves a caller-supplied id", () => {
    const item = createMemoryItem({ ...base, id: "custom-id" });
    expect(item.id).toBe("custom-id");
  });

  it("throws RangeError for authority > 1", () => {
    expect(() => createMemoryItem({ ...base, authority: 1.5 })).toThrow(
      RangeError,
    );
  });

  it("throws RangeError for authority < 0", () => {
    expect(() => createMemoryItem({ ...base, authority: -0.1 })).toThrow(
      RangeError,
    );
  });

  it("throws RangeError for conviction out of range", () => {
    expect(() => createMemoryItem({ ...base, conviction: 2 })).toThrow(
      RangeError,
    );
  });

  it("throws RangeError for importance out of range", () => {
    expect(() => createMemoryItem({ ...base, importance: -1 })).toThrow(
      RangeError,
    );
  });

  it("accepts undefined optional scores", () => {
    const item = createMemoryItem(base);
    expect(item.conviction).toBeUndefined();
    expect(item.importance).toBeUndefined();
  });

  it("preserves all input fields", () => {
    const item = createMemoryItem({
      ...base,
      conviction: 0.8,
      importance: 0.5,
      meta: { agent_id: "agent:x" },
    });
    expect(item.conviction).toBe(0.8);
    expect(item.importance).toBe(0.5);
    expect(item.meta?.agent_id).toBe("agent:x");
  });
});

describe("createEdge", () => {
  const base = {
    from: "m1",
    to: "m2",
    kind: "SUPPORTS" as const,
    author: "system:rule",
    source_kind: "derived_deterministic" as const,
    authority: 0.9,
  };

  it("generates a uuidv7 id and defaults active to true", () => {
    const edge = createEdge(base);
    expect(edge.edge_id).toMatch(UUID_RE);
    expect(edge.active).toBe(true);
  });

  it("preserves caller-supplied edge_id and active", () => {
    const edge = createEdge({ ...base, edge_id: "e-custom", active: false });
    expect(edge.edge_id).toBe("e-custom");
    expect(edge.active).toBe(false);
  });

  it("throws RangeError for authority out of range", () => {
    expect(() => createEdge({ ...base, authority: 1.01 })).toThrow(RangeError);
  });
});

describe("createEventEnvelope", () => {
  it("produces correct namespace, valid ts, and uuidv7 id", () => {
    const env = createEventEnvelope("memory.create", { test: true });
    expect(env.id).toMatch(UUID_RE);
    expect(env.namespace).toBe("memory");
    expect(env.type).toBe("memory.create");
    expect(new Date(env.ts).toISOString()).toBe(env.ts);
    expect(env.payload).toEqual({ test: true });
  });

  it("includes trace_id when provided", () => {
    const env = createEventEnvelope("test", null, { trace_id: "t-123" });
    expect(env.trace_id).toBe("t-123");
  });

  it("omits trace_id when not provided", () => {
    const env = createEventEnvelope("test", null);
    expect(env.trace_id).toBeUndefined();
  });
});
