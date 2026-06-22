// Performance benchmarks for the bulk fold paths.
//
// Run with: npm run bench
//
// These guard the O(N) behavior of replay / import / cascade. The "fold
// strategy contrast" group makes the win explicit: folding commands with the
// immutable `applyCommand` clones the whole graph per command (the old,
// quadratic shape) while the in-place fold used by replay stays linear.

import { bench, describe } from "vitest";
import { applyCommand } from "../src/reducer.js";
import { createGraphState } from "../src/graph.js";
import { createMemoryItem, createEdge } from "../src/helpers.js";
import { replayCommands, replayFromEnvelopes } from "../src/replay.js";
import { importSlice } from "../src/transplant.js";
import type { MemexExport } from "../src/transplant.js";
import { createIntentState } from "../src/intent.js";
import { createTaskState } from "../src/task.js";
import { cascadeRetract, getDependents } from "../src/integrity.js";
import type {
  GraphState,
  MemoryItem,
  MemoryCommand,
  Edge,
  EventEnvelope,
} from "../src/types.js";

const BASE = 1_700_000_000_000;
const padId = (i: number): string => `m-${i.toString().padStart(8, "0")}`;

function item(i: number, parents?: string[]): MemoryItem {
  return createMemoryItem({
    id: padId(i),
    scope: "bench",
    kind: "observation",
    content: { text: `item ${i}` },
    author: "agent:bench",
    source_kind: "observed",
    authority: 0.5,
    created_at: BASE + i,
    ...(parents ? { parents } : {}),
  });
}

function createCommands(n: number): MemoryCommand[] {
  const cmds: MemoryCommand[] = [];
  for (let i = 0; i < n; i++)
    cmds.push({ type: "memory.create", item: item(i) });
  return cmds;
}

function createEnvelopes(n: number): EventEnvelope<MemoryCommand>[] {
  const envs: EventEnvelope<MemoryCommand>[] = [];
  for (let i = 0; i < n; i++) {
    envs.push({
      id: `e-${i}`,
      namespace: "memory",
      type: "memory.create",
      // Reverse the timestamps so replayFromEnvelopes pays for the sort.
      ts: new Date(BASE + (n - i)).toISOString(),
      payload: { type: "memory.create", item: item(i) },
    });
  }
  return envs;
}

function chainCommands(n: number): MemoryCommand[] {
  const cmds: MemoryCommand[] = [];
  for (let i = 0; i < n; i++) {
    cmds.push({
      type: "memory.create",
      item: item(i, i > 0 ? [padId(i - 1)] : undefined),
    });
  }
  return cmds;
}

function sliceOf(n: number): MemexExport {
  const memories: MemoryItem[] = [];
  const edges: Edge[] = [];
  for (let i = 0; i < n; i++) {
    memories.push(item(i));
    if (i > 0) {
      edges.push(
        createEdge({
          edge_id: `edge-${i}`,
          from: padId(i),
          to: padId(i - 1),
          kind: "DERIVED_FROM",
          author: "agent:bench",
          source_kind: "observed",
          authority: 0.5,
        }),
      );
    }
  }
  return { memories, edges, intents: [], tasks: [] };
}

describe("replayCommands", () => {
  const c5k = createCommands(5_000);
  const c20k = createCommands(20_000);
  bench("5k creates", () => {
    replayCommands(c5k);
  });
  bench("20k creates", () => {
    replayCommands(c20k);
  });
});

describe("replayFromEnvelopes (sort + fold)", () => {
  const e5k = createEnvelopes(5_000);
  bench("5k reverse-sorted creates", () => {
    replayFromEnvelopes(e5k);
  });
});

describe("importSlice (memories + edges into empty graph)", () => {
  const s5k = sliceOf(5_000);
  const s10k = sliceOf(10_000);
  bench("5k memories", () => {
    importSlice(
      createGraphState(),
      createIntentState(),
      createTaskState(),
      s5k,
    );
  });
  bench("10k memories", () => {
    importSlice(
      createGraphState(),
      createIntentState(),
      createTaskState(),
      s10k,
    );
  });
});

describe("cascadeRetract / getDependents (5k-deep chain)", () => {
  const { state } = replayCommands(chainCommands(5_000));
  const root = padId(0);
  bench("cascadeRetract whole chain", () => {
    cascadeRetract(state, root, "agent:bench");
  });
  bench("getDependents transitive", () => {
    getDependents(state, root, true);
  });
});

describe("fold strategy contrast (2k creates)", () => {
  const cmds = createCommands(2_000);
  bench("immutable applyCommand fold — clone per command (~O(N^2))", () => {
    let state: GraphState = createGraphState();
    for (const cmd of cmds) state = applyCommand(state, cmd).state;
  });
  bench("in-place fold via replayCommands (O(N))", () => {
    replayCommands(cmds);
  });
});
