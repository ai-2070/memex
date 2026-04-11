import { uuidv7 } from "uuidv7";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IntentStatus = "active" | "paused" | "completed" | "cancelled";

export interface Intent {
  id: string;
  label: string;
  description?: string;

  priority: number; // 0..1
  owner: string; // "user:laz", "agent:reasoner", "system:watchdog"
  status: IntentStatus;

  context?: Record<string, unknown>;
  root_memory_ids?: string[];

  meta?: Record<string, unknown>;
}

export interface IntentState {
  intents: Map<string, Intent>;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export function createIntentState(): IntentState {
  return { intents: new Map() };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createIntent(
  input: Omit<Intent, "id" | "status"> & { id?: string; status?: IntentStatus },
): Intent {
  return {
    ...input,
    id: input.id ?? uuidv7(),
    status: input.status ?? "active",
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export type IntentCommand =
  | { type: "intent.create"; intent: Intent }
  | {
      type: "intent.update";
      intent_id: string;
      partial: Partial<Intent>;
      author: string;
      reason?: string;
    }
  | {
      type: "intent.complete";
      intent_id: string;
      author: string;
      reason?: string;
    }
  | {
      type: "intent.cancel";
      intent_id: string;
      author: string;
      reason?: string;
    }
  | { type: "intent.pause"; intent_id: string; author: string; reason?: string }
  | {
      type: "intent.resume";
      intent_id: string;
      author: string;
      reason?: string;
    };

// ---------------------------------------------------------------------------
// Lifecycle events
// ---------------------------------------------------------------------------

export interface IntentLifecycleEvent {
  namespace: "intent";
  type:
    | "intent.created"
    | "intent.updated"
    | "intent.completed"
    | "intent.cancelled"
    | "intent.paused"
    | "intent.resumed";
  intent: Intent;
  cause_type: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class IntentNotFoundError extends Error {
  constructor(id: string) {
    super(`Intent not found: ${id}`);
    this.name = "IntentNotFoundError";
  }
}

export class DuplicateIntentError extends Error {
  constructor(id: string) {
    super(`Intent already exists: ${id}`);
    this.name = "DuplicateIntentError";
  }
}

export class InvalidIntentTransitionError extends Error {
  constructor(id: string, from: IntentStatus, to: string) {
    super(`Invalid intent transition: ${id} from ${from} to ${to}`);
    this.name = "InvalidIntentTransitionError";
  }
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function setStatus(
  state: IntentState,
  id: string,
  targetStatus: IntentStatus,
  validFrom: IntentStatus[],
  author: string,
  causeType: string,
  eventType: IntentLifecycleEvent["type"],
): { state: IntentState; events: IntentLifecycleEvent[] } {
  const existing = state.intents.get(id);
  if (!existing) throw new IntentNotFoundError(id);
  if (!validFrom.includes(existing.status)) {
    throw new InvalidIntentTransitionError(id, existing.status, targetStatus);
  }
  const updated: Intent = { ...existing, status: targetStatus };
  const intents = new Map(state.intents);
  intents.set(id, updated);
  return {
    state: { intents },
    events: [
      {
        namespace: "intent",
        type: eventType,
        intent: updated,
        cause_type: causeType,
      },
    ],
  };
}

export function applyIntentCommand(
  state: IntentState,
  cmd: IntentCommand,
): { state: IntentState; events: IntentLifecycleEvent[] } {
  switch (cmd.type) {
    case "intent.create": {
      if (state.intents.has(cmd.intent.id)) {
        throw new DuplicateIntentError(cmd.intent.id);
      }
      const intents = new Map(state.intents);
      intents.set(cmd.intent.id, cmd.intent);
      return {
        state: { intents },
        events: [
          {
            namespace: "intent",
            type: "intent.created",
            intent: cmd.intent,
            cause_type: cmd.type,
          },
        ],
      };
    }

    case "intent.update": {
      const existing = state.intents.get(cmd.intent_id);
      if (!existing) throw new IntentNotFoundError(cmd.intent_id);
      const { id: _id, ...rest } = cmd.partial;
      const updated: Intent = { ...existing, ...rest };
      const intents = new Map(state.intents);
      intents.set(cmd.intent_id, updated);
      return {
        state: { intents },
        events: [
          {
            namespace: "intent",
            type: "intent.updated",
            intent: updated,
            cause_type: cmd.type,
          },
        ],
      };
    }

    case "intent.complete":
      return setStatus(
        state,
        cmd.intent_id,
        "completed",
        ["active", "paused"],
        cmd.author,
        cmd.type,
        "intent.completed",
      );

    case "intent.cancel":
      return setStatus(
        state,
        cmd.intent_id,
        "cancelled",
        ["active", "paused"],
        cmd.author,
        cmd.type,
        "intent.cancelled",
      );

    case "intent.pause":
      return setStatus(
        state,
        cmd.intent_id,
        "paused",
        ["active"],
        cmd.author,
        cmd.type,
        "intent.paused",
      );

    case "intent.resume":
      return setStatus(
        state,
        cmd.intent_id,
        "active",
        ["paused"],
        cmd.author,
        cmd.type,
        "intent.resumed",
      );
  }
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export interface IntentFilter {
  owner?: string;
  status?: IntentStatus;
  statuses?: IntentStatus[];
  min_priority?: number;
  has_memory_id?: string;
}

export function getIntents(
  state: IntentState,
  filter?: IntentFilter,
): Intent[] {
  if (!filter) return [...state.intents.values()];

  const results: Intent[] = [];
  for (const intent of state.intents.values()) {
    if (filter.owner !== undefined && intent.owner !== filter.owner) continue;
    if (filter.status !== undefined && intent.status !== filter.status)
      continue;
    if (
      filter.statuses !== undefined &&
      !filter.statuses.includes(intent.status)
    )
      continue;
    if (
      filter.min_priority !== undefined &&
      intent.priority < filter.min_priority
    )
      continue;
    if (filter.has_memory_id !== undefined) {
      if (
        !intent.root_memory_ids ||
        !intent.root_memory_ids.includes(filter.has_memory_id)
      )
        continue;
    }
    results.push(intent);
  }
  return results;
}

export function getIntentById(
  state: IntentState,
  id: string,
): Intent | undefined {
  return state.intents.get(id);
}
