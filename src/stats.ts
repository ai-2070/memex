import type { GraphState } from "./types.js";

export interface GraphStats {
  items: {
    total: number;
    by_kind: Record<string, number>;
    by_source_kind: Record<string, number>;
    by_author: Record<string, number>;
    by_scope: Record<string, number>;
    with_parents: number;
    root: number;
  };
  edges: {
    total: number;
    active: number;
    by_kind: Record<string, number>;
  };
}

function countBy<T>(
  values: Iterable<T>,
  keyFn: (v: T) => string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of values) {
    const key = keyFn(v);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function getStats(state: GraphState): GraphStats {
  const items = [...state.items.values()];
  const edges = [...state.edges.values()];

  let withParents = 0;
  let root = 0;
  for (const item of items) {
    if (item.parents && item.parents.length > 0) {
      withParents++;
    } else {
      root++;
    }
  }

  return {
    items: {
      total: items.length,
      by_kind: countBy(items, (i) => i.kind),
      by_source_kind: countBy(items, (i) => i.source_kind),
      by_author: countBy(items, (i) => i.author),
      by_scope: countBy(items, (i) => i.scope),
      with_parents: withParents,
      root,
    },
    edges: {
      total: edges.length,
      active: edges.filter((e) => e.active).length,
      by_kind: countBy(edges, (e) => e.kind),
    },
  };
}
