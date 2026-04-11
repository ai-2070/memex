// ---------------------------------------------------------------------------
// Memory Item Kind — what the item *is*
// ---------------------------------------------------------------------------

export type KnownMemoryKind =
  | "observation"
  | "assertion"
  | "assumption"
  | "hypothesis"
  | "derivation"
  | "simulation"
  | "policy"
  | "trait";

export type MemoryKind = KnownMemoryKind | (string & {});

// ---------------------------------------------------------------------------
// Source Kind — how the item *got here*
// ---------------------------------------------------------------------------

export type KnownSourceKind =
  | "user_explicit"
  | "observed"
  | "derived_deterministic"
  | "agent_inferred"
  | "simulated"
  | "imported";

export type SourceKind = KnownSourceKind | (string & {});

// ---------------------------------------------------------------------------
// MemoryItem (the core node type)
// ---------------------------------------------------------------------------

export interface MemoryItem {
  id: string;
  scope: string;
  kind: MemoryKind;
  content: Record<string, unknown>;

  author: string;
  source_kind: SourceKind;
  parents?: string[]; // item ids this was derived/inferred from

  authority: number; // 0..1 -- how much should the system trust this?
  conviction?: number; // 0..1 -- how sure was the author?
  importance?: number; // 0..1 -- how much attention does this need right now? (salience)

  meta?: {
    agent_id?: string;
    session_id?: string;
    [key: string]: unknown;
  };
}

// ---------------------------------------------------------------------------
// Edge
// ---------------------------------------------------------------------------

export type KnownEdgeKind =
  | "DERIVED_FROM"
  | "CONTRADICTS"
  | "SUPPORTS"
  | "ABOUT"
  | "SUPERSEDES"
  | "ALIAS";

export type EdgeKind = KnownEdgeKind | (string & {});

export interface Edge {
  edge_id: string;
  from: string;
  to: string;
  kind: EdgeKind;

  weight?: number;

  author: string;
  source_kind: SourceKind;
  authority: number;
  active: boolean;

  meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Event Envelope
// ---------------------------------------------------------------------------

export type KnownNamespace =
  | "memory"
  | "task"
  | "agent"
  | "tool"
  | "net"
  | "app"
  | "chat"
  | "system"
  | "debug";

export type Namespace = KnownNamespace | (string & {});

export interface EventEnvelope<T = unknown> {
  id: string;
  namespace: Namespace;
  type: string;
  ts: string;
  trace_id?: string;
  payload: T;
}

// ---------------------------------------------------------------------------
// Graph State
// ---------------------------------------------------------------------------

export interface GraphState {
  items: Map<string, MemoryItem>;
  edges: Map<string, Edge>;
}

// ---------------------------------------------------------------------------
// Memory Commands (into MemEX)
// ---------------------------------------------------------------------------

export type MemoryCommand =
  | { type: "memory.create"; item: MemoryItem }
  | {
      type: "memory.update";
      item_id: string;
      partial: Partial<MemoryItem>;
      author: string;
      reason?: string;
      basis?: Record<string, unknown>;
    }
  | { type: "memory.retract"; item_id: string; author: string; reason?: string }
  | { type: "edge.create"; edge: Edge }
  | {
      type: "edge.update";
      edge_id: string;
      partial: Partial<Edge>;
      author: string;
      reason?: string;
    }
  | { type: "edge.retract"; edge_id: string; author: string; reason?: string };

// ---------------------------------------------------------------------------
// Memory Lifecycle Events (out of applyCommand)
// ---------------------------------------------------------------------------

export type LifecycleEventType =
  | "memory.created"
  | "memory.updated"
  | "memory.retracted"
  | "edge.created"
  | "edge.updated"
  | "edge.retracted";

export interface MemoryLifecycleEvent {
  namespace: "memory";
  type: LifecycleEventType;
  item?: MemoryItem;
  edge?: Edge;
  cause_type?: string;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export interface MemoryFilter {
  ids?: string[]; // match any of these item ids
  scope?: string; // exact match
  scope_prefix?: string; // starts with, e.g. "project:"
  author?: string;
  kind?: MemoryKind;
  source_kind?: SourceKind;

  range?: {
    authority?: { min?: number; max?: number };
    conviction?: { min?: number; max?: number };
    importance?: { min?: number; max?: number };
  };

  has_parent?: string; // sugar for parents.includes
  is_root?: boolean; // sugar for parents.count.max = 0
  parents?: {
    includes?: string;
    includes_any?: string[];
    includes_all?: string[];
    count?: { min?: number; max?: number };
  };

  decay?: {
    config: DecayConfig;
    min: number; // 0..1 — minimum decay multiplier to keep
  };
  created?: {
    before?: number; // unix ms
    after?: number; // unix ms
  };
  not?: MemoryFilter;
  meta?: Record<string, unknown>; // dot-path exact match
  meta_has?: string[]; // dot-paths that must exist
  or?: MemoryFilter[];
}

export type SortField = "authority" | "conviction" | "importance" | "recency";

export interface SortOption {
  field: SortField;
  order: "asc" | "desc";
}

export interface QueryOptions {
  sort?: SortOption | SortOption[]; // single or multi-sort (first = primary)
  limit?: number;
  offset?: number;
}

export type DecayInterval = "hour" | "day" | "week";
export type DecayType = "exponential" | "linear" | "step";

export interface DecayConfig {
  rate: number; // 0..1 — how much to decay per interval
  interval: DecayInterval;
  type: DecayType;
}

export interface ScoreWeights {
  authority?: number;
  conviction?: number;
  importance?: number;
  decay?: DecayConfig;
}

export interface ScoredItem {
  item: MemoryItem;
  score: number;
  contradicted_by?: MemoryItem[]; // present when contradictions are surfaced
}

export interface EdgeFilter {
  from?: string;
  to?: string;
  kind?: EdgeKind;
  min_weight?: number;
  active_only?: boolean;
}
