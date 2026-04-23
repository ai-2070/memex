import type {
  GraphState,
  MemoryCommand,
  MemoryLifecycleEvent,
  EventEnvelope,
} from "./types.js";
import { createGraphState } from "./graph.js";
import { applyCommand } from "./reducer.js";

export function replayCommands(commands: MemoryCommand[]): {
  state: GraphState;
  events: MemoryLifecycleEvent[];
} {
  let state = createGraphState();
  const allEvents: MemoryLifecycleEvent[] = [];

  for (const cmd of commands) {
    const result = applyCommand(state, cmd);
    state = result.state;
    allEvents.push(...result.events);
  }

  return { state, events: allEvents };
}

// Canonical ISO 8601 with a "Z" or "±HH:MM" offset. `Date.parse` is only
// spec-reliable for this shape; we reject anything else so replay ordering is
// deterministic across runtimes.
const ISO_8601_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

function parseIsoTs(ts: string): number {
  if (!ISO_8601_RE.test(ts)) {
    throw new Error(`Invalid envelope timestamp: "${ts}" (expected ISO 8601)`);
  }
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid envelope timestamp: "${ts}"`);
  }
  return parsed;
}

export function replayFromEnvelopes(
  envelopes: EventEnvelope<MemoryCommand>[],
): { state: GraphState; events: MemoryLifecycleEvent[] } {
  const indexed = envelopes.map((env) => ({ env, ts: parseIsoTs(env.ts) }));
  indexed.sort((a, b) => a.ts - b.ts);
  const commands = indexed.map(({ env }) => env.payload);
  return replayCommands(commands);
}
