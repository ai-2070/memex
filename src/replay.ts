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
  const sorted = [...envelopes].sort((a, b) => a.ts.localeCompare(b.ts));
  const commands = sorted.map((env) => env.payload);
  return replayCommands(commands);
}
