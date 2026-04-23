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

// Strict ISO 8601 with milliseconds-only precision and an explicit offset.
// Sub-millisecond precision is rejected because Date.UTC drops it, which
// would collapse distinct timestamps and break chronological replay. We also
// validate calendar fields manually so that impossible dates like 2024-02-31
// don't silently normalize under Date.parse.
const ISO_8601_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|([+-])(\d{2}):(\d{2}))$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

function parseIsoTs(ts: string): number {
  const m = ISO_8601_RE.exec(ts);
  if (!m) {
    throw new Error(`Invalid envelope timestamp: "${ts}" (expected ISO 8601)`);
  }
  const year = +m[1];
  const month = +m[2];
  const day = +m[3];
  const hour = +m[4];
  const minute = +m[5];
  const second = +m[6];
  const ms = m[7] ? +m[7].padEnd(3, "0") : 0;

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new Error(
      `Invalid envelope timestamp: "${ts}" (calendar fields out of range)`,
    );
  }

  // Date.UTC legacy-coerces years 0..99 into 1900..1999; setUTCFullYear
  // bypasses that so years like 0050 round-trip correctly.
  const date = new Date(
    Date.UTC(2000, month - 1, day, hour, minute, second, ms),
  );
  date.setUTCFullYear(year);
  let epoch = date.getTime();

  if (m[8]) {
    const offH = +m[9];
    const offM = +m[10];
    if (offH > 23 || offM > 59) {
      throw new Error(`Invalid envelope timestamp: "${ts}" (bad offset)`);
    }
    const sign = m[8] === "-" ? 1 : -1;
    epoch += sign * (offH * 60 + offM) * 60 * 1000;
  }

  return epoch;
}

export function replayFromEnvelopes(
  envelopes: EventEnvelope<MemoryCommand>[],
): { state: GraphState; events: MemoryLifecycleEvent[] } {
  const indexed = envelopes.map((env) => ({ env, ts: parseIsoTs(env.ts) }));
  indexed.sort((a, b) => a.ts - b.ts);
  const commands = indexed.map(({ env }) => env.payload);
  return replayCommands(commands);
}
