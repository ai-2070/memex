import type {
  GraphState,
  MemoryItem,
  Edge,
  MemoryFilter,
  EdgeFilter,
  QueryOptions,
  SortField,
  SortOption,
  ScoreWeights,
  ScoredItem,
} from "./types.js";

function resolvePath(obj: unknown, path: string): unknown {
  let current = obj;
  for (const segment of path.split(".")) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object"
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function matchesRange(
  value: number | undefined,
  range: { min?: number; max?: number } | undefined,
): boolean {
  if (!range) return true;
  if (range.min !== undefined && (value === undefined || value < range.min))
    return false;
  if (range.max !== undefined && (value === undefined || value > range.max))
    return false;
  return true;
}

function matchesFilter(item: MemoryItem, filter: MemoryFilter): boolean {
  // ids
  if (filter.ids !== undefined && !filter.ids.includes(item.id)) return false;

  // scope
  if (filter.scope !== undefined && item.scope !== filter.scope) return false;
  if (
    filter.scope_prefix !== undefined &&
    !item.scope.startsWith(filter.scope_prefix)
  )
    return false;

  // kind / source
  if (filter.author !== undefined && item.author !== filter.author)
    return false;
  if (filter.kind !== undefined && item.kind !== filter.kind) return false;
  if (
    filter.source_kind !== undefined &&
    item.source_kind !== filter.source_kind
  )
    return false;

  // cross-graph links
  if (filter.intent_id !== undefined && item.intent_id !== filter.intent_id)
    return false;
  if (filter.intent_ids !== undefined && (!item.intent_id || !filter.intent_ids.includes(item.intent_id)))
    return false;
  if (filter.task_id !== undefined && item.task_id !== filter.task_id)
    return false;
  if (filter.task_ids !== undefined && (!item.task_id || !filter.task_ids.includes(item.task_id)))
    return false;

  // score ranges
  if (filter.range) {
    if (!matchesRange(item.authority, filter.range.authority)) return false;
    if (!matchesRange(item.conviction, filter.range.conviction)) return false;
    if (!matchesRange(item.importance, filter.range.importance)) return false;
  }

  // parent sugar
  if (filter.has_parent !== undefined) {
    if (!item.parents || !item.parents.includes(filter.has_parent))
      return false;
  }
  if (filter.is_root !== undefined) {
    const hasParents = item.parents !== undefined && item.parents.length > 0;
    if (filter.is_root && hasParents) return false;
    if (!filter.is_root && !hasParents) return false;
  }

  // parents (advanced)
  if (filter.parents) {
    const p = item.parents ?? [];
    if (filter.parents.includes !== undefined) {
      if (!p.includes(filter.parents.includes)) return false;
    }
    if (filter.parents.includes_any !== undefined) {
      if (!filter.parents.includes_any.some((id) => p.includes(id)))
        return false;
    }
    if (filter.parents.includes_all !== undefined) {
      if (!filter.parents.includes_all.every((id) => p.includes(id)))
        return false;
    }
    if (filter.parents.count !== undefined) {
      if (!matchesRange(p.length, filter.parents.count)) return false;
    }
  }

  // decay
  if (filter.decay) {
    const multiplier = computeDecayMultiplier(item, filter.decay.config);
    if (multiplier < filter.decay.min) return false;
  }

  // created
  if (filter.created) {
    const ts = itemTimestamp(item);
    if (filter.created.before !== undefined && ts >= filter.created.before)
      return false;
    if (filter.created.after !== undefined && ts < filter.created.after)
      return false;
  }

  // combinators
  if (filter.not && matchesFilter(item, filter.not)) return false;
  if (filter.meta !== undefined) {
    for (const [path, value] of Object.entries(filter.meta)) {
      if (resolvePath(item.meta, path) !== value) return false;
    }
  }
  if (filter.meta_has !== undefined) {
    for (const path of filter.meta_has) {
      if (resolvePath(item.meta, path) === undefined) return false;
    }
  }
  if (filter.or !== undefined && filter.or.length > 0) {
    if (!filter.or.some((sub) => matchesFilter(item, sub))) return false;
  }
  return true;
}

/**
 * Extract millisecond timestamp from a uuidv7 id.
 * uuidv7 encodes unix ms in the first 48 bits.
 */
export function extractTimestamp(uuidv7Id: string): number {
  const hex = uuidv7Id.replace(/-/g, "").slice(0, 12);
  return parseInt(hex, 16);
}

function itemTimestamp(item: MemoryItem): number {
  return item.created_at ?? extractTimestamp(item.id);
}

function getSortValue(item: MemoryItem, field: SortField): number {
  switch (field) {
    case "authority":
      return item.authority;
    case "conviction":
      return item.conviction ?? 0;
    case "importance":
      return item.importance ?? 0;
    case "recency":
      return itemTimestamp(item);
  }
}

export function getItems(
  state: GraphState,
  filter?: MemoryFilter,
  options?: QueryOptions,
): MemoryItem[] {
  let results: MemoryItem[];

  if (!filter) {
    results = [...state.items.values()];
  } else {
    results = [];
    for (const item of state.items.values()) {
      if (matchesFilter(item, filter)) results.push(item);
    }
  }

  if (options?.sort) {
    const sorts: SortOption[] = Array.isArray(options.sort)
      ? options.sort
      : [options.sort];
    results.sort((a, b) => {
      for (const { field, order } of sorts) {
        const va = getSortValue(a, field);
        const vb = getSortValue(b, field);
        if (va < vb) return order === "asc" ? -1 : 1;
        if (va > vb) return order === "asc" ? 1 : -1;
      }
      return 0;
    });
  }

  if (options?.offset !== undefined || options?.limit !== undefined) {
    const start = options.offset ?? 0;
    const end = options.limit !== undefined ? start + options.limit : undefined;
    results = results.slice(start, end);
  }

  return results;
}

const INTERVAL_MS: Record<string, number> = {
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
};

function computeDecayMultiplier(
  item: MemoryItem,
  decay: import("./types.js").DecayConfig,
): number {
  const ageMs = Date.now() - itemTimestamp(item);
  if (ageMs <= 0) return 1; // future item (clock skew) — no decay
  const intervalMs = INTERVAL_MS[decay.interval];
  if (intervalMs === undefined) {
    throw new RangeError(
      `Unknown decay interval: "${decay.interval}". Expected "hour", "day", or "week".`,
    );
  }
  const intervals = ageMs / intervalMs;

  switch (decay.type) {
    case "exponential":
      return Math.pow(1 - decay.rate, intervals);
    case "linear":
      return Math.max(0, 1 - decay.rate * intervals);
    case "step":
      return Math.pow(1 - decay.rate, Math.floor(intervals));
  }
}

function computeScore(item: MemoryItem, weights: ScoreWeights): number {
  const base =
    (weights.authority ?? 0) * item.authority +
    (weights.conviction ?? 0) * (item.conviction ?? 0) +
    (weights.importance ?? 0) * (item.importance ?? 0);

  if (!weights.decay) return base;

  return base * computeDecayMultiplier(item, weights.decay);
}

export interface ScoredQueryOptions {
  pre?: MemoryFilter; // filter before scoring
  post?: MemoryFilter; // filter after scoring (applied to scored items)
  min_score?: number; // drop items below this score
  limit?: number;
  offset?: number;
}

export function getScoredItems(
  state: GraphState,
  weights: ScoreWeights,
  options?: ScoredQueryOptions,
): ScoredItem[] {
  const items = getItems(state, options?.pre);

  let scored = items.map((item) => ({
    item,
    score: computeScore(item, weights),
  }));

  scored.sort((a, b) => b.score - a.score);

  if (options?.min_score !== undefined) {
    scored = scored.filter((s) => s.score >= options.min_score!);
  }

  if (options?.post) {
    const postFilter = options.post;
    scored = scored.filter((s) => matchesFilter(s.item, postFilter));
  }

  if (options?.offset !== undefined || options?.limit !== undefined) {
    const start = options.offset ?? 0;
    const end = options.limit !== undefined ? start + options.limit : undefined;
    scored = scored.slice(start, end);
  }

  return scored;
}

export function getEdges(state: GraphState, filter?: EdgeFilter): Edge[] {
  const activeOnly = filter?.active_only ?? true;
  const results: Edge[] = [];
  for (const edge of state.edges.values()) {
    if (activeOnly && !edge.active) continue;
    if (filter?.from !== undefined && edge.from !== filter.from) continue;
    if (filter?.to !== undefined && edge.to !== filter.to) continue;
    if (filter?.kind !== undefined && edge.kind !== filter.kind) continue;
    if (
      filter?.min_weight !== undefined &&
      (edge.weight === undefined || edge.weight < filter.min_weight)
    )
      continue;
    results.push(edge);
  }
  return results;
}

export function getItemById(
  state: GraphState,
  id: string,
): MemoryItem | undefined {
  return state.items.get(id);
}

export function getEdgeById(
  state: GraphState,
  edgeId: string,
): Edge | undefined {
  return state.edges.get(edgeId);
}

export function getRelatedItems(
  state: GraphState,
  itemId: string,
  direction: "from" | "to" | "both" = "both",
): MemoryItem[] {
  const relatedIds = new Set<string>();

  for (const edge of state.edges.values()) {
    if (!edge.active) continue;
    if (
      (direction === "from" || direction === "both") &&
      edge.from === itemId
    ) {
      relatedIds.add(edge.to);
    }
    if ((direction === "to" || direction === "both") && edge.to === itemId) {
      relatedIds.add(edge.from);
    }
  }

  relatedIds.delete(itemId);

  const results: MemoryItem[] = [];
  for (const id of relatedIds) {
    const item = state.items.get(id);
    if (item) results.push(item);
  }
  return results;
}

export function getParents(state: GraphState, itemId: string): MemoryItem[] {
  const item = state.items.get(itemId);
  if (!item?.parents) return [];
  const results: MemoryItem[] = [];
  for (const pid of item.parents) {
    const parent = state.items.get(pid);
    if (parent) results.push(parent);
  }
  return results;
}

export function getChildren(state: GraphState, itemId: string): MemoryItem[] {
  const results: MemoryItem[] = [];
  for (const item of state.items.values()) {
    if (item.parents && item.parents.includes(itemId)) {
      results.push(item);
    }
  }
  return results;
}
