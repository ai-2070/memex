import { uuidv7 } from "uuidv7";
import type {
  EventEnvelope,
  MemoryLifecycleEvent,
  MemoryItem,
  Edge,
} from "./types.js";

export function wrapLifecycleEvent(
  event: MemoryLifecycleEvent,
  causeId: string,
  traceId?: string,
): EventEnvelope<MemoryLifecycleEvent & { cause_id: string }> {
  return {
    id: uuidv7(),
    namespace: "memory",
    type: event.type,
    ts: new Date().toISOString(),
    ...(traceId ? { trace_id: traceId } : {}),
    payload: { ...event, cause_id: causeId },
  };
}

export function wrapStateEvent(
  item: MemoryItem,
  causeId: string,
  traceId?: string,
): EventEnvelope<{ item: MemoryItem; cause_id: string }> {
  return {
    id: uuidv7(),
    namespace: "memory",
    type: "state.memory",
    ts: new Date().toISOString(),
    ...(traceId ? { trace_id: traceId } : {}),
    payload: { item, cause_id: causeId },
  };
}

export function wrapEdgeStateEvent(
  edge: Edge,
  causeId: string,
  traceId?: string,
): EventEnvelope<{ edge: Edge; cause_id: string }> {
  return {
    id: uuidv7(),
    namespace: "memory",
    type: "state.edge",
    ts: new Date().toISOString(),
    ...(traceId ? { trace_id: traceId } : {}),
    payload: { edge, cause_id: causeId },
  };
}
