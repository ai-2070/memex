import { describe, it, expect } from "vitest";
import { replayCommands, replayFromEnvelopes } from "../src/replay.js";
import { MemoryNotFoundError } from "../src/errors.js";
import type {
  MemoryItem,
  Edge,
  MemoryCommand,
  EventEnvelope,
} from "../src/types.js";

const item1: MemoryItem = {
  id: "m1",
  scope: "test",
  kind: "observation",
  content: { key: "v1" },
  author: "user:laz",
  source_kind: "observed",
  authority: 0.9,
};

const item2: MemoryItem = {
  id: "m2",
  scope: "test",
  kind: "assertion",
  content: { key: "v2" },
  author: "user:laz",
  source_kind: "user_explicit",
  authority: 0.8,
};

const edge1: Edge = {
  edge_id: "e1",
  from: "m1",
  to: "m2",
  kind: "SUPPORTS",
  author: "system:rule",
  source_kind: "derived_deterministic",
  authority: 0.7,
  active: true,
};

describe("replayCommands", () => {
  it("replays empty command list to empty state", () => {
    const { state, events } = replayCommands([]);
    expect(state.items.size).toBe(0);
    expect(events).toHaveLength(0);
  });

  it("replays create -> update -> retract to empty state with 3 events", () => {
    const commands: MemoryCommand[] = [
      { type: "memory.create", item: item1 },
      {
        type: "memory.update",
        item_id: "m1",
        partial: { authority: 0.5 },
        author: "system:tuner",
      },
      { type: "memory.retract", item_id: "m1", author: "user:laz" },
    ];
    const { state, events } = replayCommands(commands);
    expect(state.items.size).toBe(0);
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe("memory.created");
    expect(events[1].type).toBe("memory.updated");
    expect(events[2].type).toBe("memory.retracted");
  });

  it("replays create A, create B, edge A->B to 2 items + 1 edge", () => {
    const commands: MemoryCommand[] = [
      { type: "memory.create", item: item1 },
      { type: "memory.create", item: item2 },
      { type: "edge.create", edge: edge1 },
    ];
    const { state } = replayCommands(commands);
    expect(state.items.size).toBe(2);
    expect(state.edges.size).toBe(1);
  });

  it("throws at point of failure for invalid command", () => {
    const commands: MemoryCommand[] = [
      { type: "memory.create", item: item1 },
      {
        type: "memory.update",
        item_id: "nonexistent",
        partial: { authority: 0.1 },
        author: "test",
      },
    ];
    expect(() => replayCommands(commands)).toThrow(MemoryNotFoundError);
  });
});

describe("replayFromEnvelopes", () => {
  it("sorts by timestamp before replaying", () => {
    const envelopes: EventEnvelope<MemoryCommand>[] = [
      {
        id: "ev2",
        namespace: "memory",
        type: "memory.create",
        ts: "2026-04-10T19:30:00.000Z",
        payload: { type: "memory.create", item: item2 },
      },
      {
        id: "ev1",
        namespace: "memory",
        type: "memory.create",
        ts: "2026-04-10T19:20:00.000Z",
        payload: { type: "memory.create", item: item1 },
      },
      {
        id: "ev3",
        namespace: "memory",
        type: "edge.create",
        ts: "2026-04-10T19:40:00.000Z",
        payload: { type: "edge.create", edge: edge1 },
      },
    ];
    const { state, events } = replayFromEnvelopes(envelopes);
    expect(state.items.size).toBe(2);
    expect(state.edges.size).toBe(1);
    expect(events[0].item?.id).toBe("m1");
  });

  it("does not mutate the input array", () => {
    const envelopes: EventEnvelope<MemoryCommand>[] = [
      {
        id: "ev2",
        namespace: "memory",
        type: "memory.create",
        ts: "2026-04-10T19:30:00.000Z",
        payload: { type: "memory.create", item: item2 },
      },
      {
        id: "ev1",
        namespace: "memory",
        type: "memory.create",
        ts: "2026-04-10T19:20:00.000Z",
        payload: { type: "memory.create", item: item1 },
      },
    ];
    const firstId = envelopes[0].id;
    replayFromEnvelopes(envelopes);
    expect(envelopes[0].id).toBe(firstId);
  });
});
