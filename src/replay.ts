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

export function replayFromEnvelopes(
  envelopes: EventEnvelope<MemoryCommand>[],
): { state: GraphState; events: MemoryLifecycleEvent[] } {
  const sorted = [...envelopes].sort((a, b) => {
    const ta = Date.parse(a.ts);
    const tb = Date.parse(b.ts);
    if (Number.isNaN(ta) || Number.isNaN(tb)) {
      throw new Error(`Invalid envelope timestamp: "${a.ts}" or "${b.ts}"`);
    }
    return ta - tb;
  });
  const commands = sorted.map((env) => env.payload);
  return replayCommands(commands);
}
