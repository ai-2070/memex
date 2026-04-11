import { describe, it, expect, beforeEach } from "vitest";
import {
  createIntentState,
  createIntent,
  applyIntentCommand,
  getIntents,
  getIntentById,
  IntentNotFoundError,
  DuplicateIntentError,
  InvalidIntentTransitionError,
} from "../src/intent.js";
import type { Intent, IntentState } from "../src/intent.js";

const makeIntent = (overrides: Partial<Intent> = {}): Intent => ({
  id: "i1",
  label: "find_kati",
  priority: 0.8,
  owner: "user:laz",
  status: "active",
  ...overrides,
});

describe("intent.create", () => {
  it("creates an intent", () => {
    const intent = makeIntent();
    const { state, events } = applyIntentCommand(createIntentState(), {
      type: "intent.create",
      intent,
    });
    expect(state.intents.get("i1")).toEqual(intent);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("intent.created");
    expect(events[0].namespace).toBe("intent");
  });

  it("throws DuplicateIntentError", () => {
    const state = createIntentState();
    const { state: next } = applyIntentCommand(state, {
      type: "intent.create",
      intent: makeIntent(),
    });
    expect(() =>
      applyIntentCommand(next, { type: "intent.create", intent: makeIntent() }),
    ).toThrow(DuplicateIntentError);
  });

  it("does not mutate original state", () => {
    const state = createIntentState();
    applyIntentCommand(state, { type: "intent.create", intent: makeIntent() });
    expect(state.intents.size).toBe(0);
  });
});

describe("intent.update", () => {
  it("updates priority", () => {
    let state = createIntentState();
    state = applyIntentCommand(state, {
      type: "intent.create",
      intent: makeIntent(),
    }).state;
    const { state: next, events } = applyIntentCommand(state, {
      type: "intent.update",
      intent_id: "i1",
      partial: { priority: 0.5 },
      author: "user:laz",
    });
    expect(next.intents.get("i1")!.priority).toBe(0.5);
    expect(events[0].type).toBe("intent.updated");
  });

  it("cannot change id via partial", () => {
    let state = createIntentState();
    state = applyIntentCommand(state, {
      type: "intent.create",
      intent: makeIntent(),
    }).state;
    const { state: next } = applyIntentCommand(state, {
      type: "intent.update",
      intent_id: "i1",
      partial: { id: "sneaky" } as any,
      author: "test",
    });
    expect(next.intents.get("i1")!.id).toBe("i1");
  });

  it("throws IntentNotFoundError", () => {
    expect(() =>
      applyIntentCommand(createIntentState(), {
        type: "intent.update",
        intent_id: "nope",
        partial: { priority: 0.1 },
        author: "test",
      }),
    ).toThrow(IntentNotFoundError);
  });
});

describe("status transitions", () => {
  let state: IntentState;
  beforeEach(() => {
    state = applyIntentCommand(createIntentState(), {
      type: "intent.create",
      intent: makeIntent({ status: "active" }),
    }).state;
  });

  it("active -> paused", () => {
    const { state: next, events } = applyIntentCommand(state, {
      type: "intent.pause",
      intent_id: "i1",
      author: "user:laz",
    });
    expect(next.intents.get("i1")!.status).toBe("paused");
    expect(events[0].type).toBe("intent.paused");
  });

  it("paused -> active (resume)", () => {
    state = applyIntentCommand(state, {
      type: "intent.pause",
      intent_id: "i1",
      author: "test",
    }).state;
    const { state: next } = applyIntentCommand(state, {
      type: "intent.resume",
      intent_id: "i1",
      author: "test",
    });
    expect(next.intents.get("i1")!.status).toBe("active");
  });

  it("active -> completed", () => {
    const { state: next, events } = applyIntentCommand(state, {
      type: "intent.complete",
      intent_id: "i1",
      author: "test",
    });
    expect(next.intents.get("i1")!.status).toBe("completed");
    expect(events[0].type).toBe("intent.completed");
  });

  it("active -> cancelled", () => {
    const { state: next } = applyIntentCommand(state, {
      type: "intent.cancel",
      intent_id: "i1",
      author: "test",
    });
    expect(next.intents.get("i1")!.status).toBe("cancelled");
  });

  it("paused -> completed", () => {
    state = applyIntentCommand(state, {
      type: "intent.pause",
      intent_id: "i1",
      author: "test",
    }).state;
    const { state: next } = applyIntentCommand(state, {
      type: "intent.complete",
      intent_id: "i1",
      author: "test",
    });
    expect(next.intents.get("i1")!.status).toBe("completed");
  });

  it("completed -> pause throws InvalidIntentTransitionError", () => {
    state = applyIntentCommand(state, {
      type: "intent.complete",
      intent_id: "i1",
      author: "test",
    }).state;
    expect(() =>
      applyIntentCommand(state, {
        type: "intent.pause",
        intent_id: "i1",
        author: "test",
      }),
    ).toThrow(InvalidIntentTransitionError);
  });

  it("cancelled -> resume throws InvalidIntentTransitionError", () => {
    state = applyIntentCommand(state, {
      type: "intent.cancel",
      intent_id: "i1",
      author: "test",
    }).state;
    expect(() =>
      applyIntentCommand(state, {
        type: "intent.resume",
        intent_id: "i1",
        author: "test",
      }),
    ).toThrow(InvalidIntentTransitionError);
  });
});

describe("createIntent factory", () => {
  it("generates id and defaults status to active", () => {
    const intent = createIntent({
      label: "test",
      priority: 0.5,
      owner: "user:laz",
    });
    expect(intent.id).toBeDefined();
    expect(intent.status).toBe("active");
  });
});

describe("getIntents", () => {
  let state: IntentState;
  beforeEach(() => {
    state = createIntentState();
    state = applyIntentCommand(state, {
      type: "intent.create",
      intent: makeIntent({
        id: "i1",
        owner: "user:laz",
        status: "active",
        priority: 0.9,
        root_memory_ids: ["m1"],
      }),
    }).state;
    state = applyIntentCommand(state, {
      type: "intent.create",
      intent: makeIntent({
        id: "i2",
        owner: "agent:reasoner",
        status: "paused",
        priority: 0.3,
      }),
    }).state;
    state = applyIntentCommand(state, {
      type: "intent.create",
      intent: makeIntent({
        id: "i3",
        owner: "user:laz",
        status: "completed",
        priority: 0.7,
      }),
    }).state;
  });

  it("returns all intents with no filter", () => {
    expect(getIntents(state)).toHaveLength(3);
  });

  it("filters by owner", () => {
    const result = getIntents(state, { owner: "user:laz" });
    expect(result).toHaveLength(2);
  });

  it("filters by status", () => {
    const result = getIntents(state, { status: "active" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("i1");
  });

  it("filters by statuses array", () => {
    const result = getIntents(state, { statuses: ["active", "paused"] });
    expect(result).toHaveLength(2);
  });

  it("filters by min_priority", () => {
    const result = getIntents(state, { min_priority: 0.5 });
    expect(result).toHaveLength(2);
  });

  it("filters by has_memory_id", () => {
    const result = getIntents(state, { has_memory_id: "m1" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("i1");
  });

  it("getIntentById works", () => {
    expect(getIntentById(state, "i2")?.owner).toBe("agent:reasoner");
    expect(getIntentById(state, "nope")).toBeUndefined();
  });
});
