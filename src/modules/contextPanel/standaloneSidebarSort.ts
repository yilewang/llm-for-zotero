/**
 * Order of the window sidebar's "Conversations" list, picked from the sort
 * menu on its heading, and the short date a row may show at its end.
 */

export type StandaloneSidebarSortOrder = "recent" | "created" | "title";

export const STANDALONE_SIDEBAR_SORT_ORDERS: readonly StandaloneSidebarSortOrder[] =
  ["recent", "created", "title"];

export const DEFAULT_STANDALONE_SIDEBAR_SORT_ORDER: StandaloneSidebarSortOrder =
  "recent";

export function parseStandaloneSidebarSortOrder(
  value: unknown,
): StandaloneSidebarSortOrder {
  return STANDALONE_SIDEBAR_SORT_ORDERS.includes(
    value as StandaloneSidebarSortOrder,
  )
    ? (value as StandaloneSidebarSortOrder)
    : DEFAULT_STANDALONE_SIDEBAR_SORT_ORDER;
}

/** Full name in the sort menu. */
export function getStandaloneSidebarSortMenuLabel(
  order: StandaloneSidebarSortOrder,
): string {
  if (order === "created") return "Date created";
  if (order === "title") return "Title (A–Z)";
  return "Recent activity";
}

type SortableSidebarEntry = {
  title?: string;
  lastActivityAt: number;
  createdAt?: number;
};

function createdTime(entry: SortableSidebarEntry): number {
  const created = Number(entry.createdAt);
  return Number.isFinite(created) && created > 0
    ? created
    : entry.lastActivityAt;
}

/** The time a row's date shows: when it was made in "Date created" order. */
export function getStandaloneSidebarEntryTime(
  entry: SortableSidebarEntry,
  order: StandaloneSidebarSortOrder,
): number {
  return order === "created" ? createdTime(entry) : entry.lastActivityAt;
}

/** A sorted copy; ties keep the order the entries came in. */
export function sortStandaloneSidebarEntries<T extends SortableSidebarEntry>(
  entries: readonly T[],
  order: StandaloneSidebarSortOrder,
): T[] {
  const sorted = entries.slice();
  if (order === "title") {
    const collator = new Intl.Collator(undefined, {
      sensitivity: "base",
      numeric: true,
    });
    sorted.sort((a, b) =>
      collator.compare((a.title || "").trim(), (b.title || "").trim()),
    );
  } else if (order === "created") {
    sorted.sort((a, b) => createdTime(b) - createdTime(a));
  } else {
    sorted.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }
  return sorted;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * "now", "5h", "3d" within a week; then "Oct 2" this year, or the year.
 */
export function formatStandaloneSidebarShortDate(
  timestamp: number,
  options?: { now?: number; translate?: (value: string) => string },
): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  const now = options?.now ?? Date.now();
  const translate = options?.translate ?? ((value: string) => value);
  const diff = Math.max(0, now - timestamp);
  if (diff < HOUR_MS) return translate("now");
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)}h`;
  if (diff < 7 * DAY_MS) return `${Math.floor(diff / DAY_MS)}d`;
  const date = new Date(timestamp);
  if (date.getFullYear() !== new Date(now).getFullYear()) {
    return String(date.getFullYear());
  }
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/**
 * "Group by agent": the list split into one section per runtime, in an
 * order the user sets by dragging the section labels.
 */
export type StandaloneSidebarGroupKey = "upstream" | "codex" | "claude_code";

export const DEFAULT_STANDALONE_SIDEBAR_GROUP_ORDER: readonly StandaloneSidebarGroupKey[] =
  ["upstream", "codex", "claude_code"];

export function getStandaloneSidebarGroupLabel(
  key: StandaloneSidebarGroupKey,
): string {
  if (key === "codex") return "Codex";
  if (key === "claude_code") return "Claude";
  return "Agent";
}

/** The saved order; unknown names are dropped and missing ones go last. */
export function parseStandaloneSidebarGroupOrder(
  value: unknown,
): StandaloneSidebarGroupKey[] {
  const order: StandaloneSidebarGroupKey[] = [];
  if (typeof value === "string") {
    for (const part of value.split(",")) {
      const key = part.trim() as StandaloneSidebarGroupKey;
      if (
        DEFAULT_STANDALONE_SIDEBAR_GROUP_ORDER.includes(key) &&
        !order.includes(key)
      ) {
        order.push(key);
      }
    }
  }
  for (const key of DEFAULT_STANDALONE_SIDEBAR_GROUP_ORDER) {
    if (!order.includes(key)) order.push(key);
  }
  return order;
}

/** A saved list of section names (the folded ones), unknown names dropped. */
export function parseStandaloneSidebarGroupKeys(
  value: unknown,
): StandaloneSidebarGroupKey[] {
  if (typeof value !== "string") return [];
  const keys: StandaloneSidebarGroupKey[] = [];
  for (const part of value.split(",")) {
    const key = part.trim() as StandaloneSidebarGroupKey;
    if (
      DEFAULT_STANDALONE_SIDEBAR_GROUP_ORDER.includes(key) &&
      !keys.includes(key)
    ) {
      keys.push(key);
    }
  }
  return keys;
}

export function serializeStandaloneSidebarGroupOrder(
  order: readonly StandaloneSidebarGroupKey[],
): string {
  return parseStandaloneSidebarGroupOrder(order.join(",")).join(",");
}

/**
 * The order after a section is dropped at `toIndex`, counted among the
 * other sections that are shown (`visible`); hidden ones keep their place.
 */
export function moveStandaloneSidebarGroup(
  order: readonly StandaloneSidebarGroupKey[],
  key: StandaloneSidebarGroupKey,
  toIndex: number,
  visible: readonly StandaloneSidebarGroupKey[] = order,
): StandaloneSidebarGroupKey[] {
  const others = visible.filter((k) => k !== key);
  const index = Math.max(0, Math.min(others.length, Math.round(toIndex)));
  const shown = [...others.slice(0, index), key, ...others.slice(index)];
  // Lay the reordered shown sections back into the slots they held.
  const slots = order
    .map((k, i) => (shown.includes(k) || k === key ? i : -1))
    .filter((i) => i >= 0);
  const next = order.slice();
  slots.forEach((slot, i) => {
    next[slot] = shown[i];
  });
  return next;
}

/** Sections in `order`, each keeping its entries' order; empty ones left out. */
export function groupStandaloneSidebarEntries<
  T extends { conversationSystem?: string },
>(
  entries: readonly T[],
  order: readonly StandaloneSidebarGroupKey[],
  fallback: StandaloneSidebarGroupKey = "upstream",
): Array<{ key: StandaloneSidebarGroupKey; items: T[] }> {
  const buckets = new Map<StandaloneSidebarGroupKey, T[]>();
  for (const entry of entries) {
    const system = entry.conversationSystem as StandaloneSidebarGroupKey;
    const key = DEFAULT_STANDALONE_SIDEBAR_GROUP_ORDER.includes(system)
      ? system
      : fallback;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(entry);
    else buckets.set(key, [entry]);
  }
  return order
    .filter((key) => buckets.has(key))
    .map((key) => ({ key, items: buckets.get(key) as T[] }));
}

/** Each section's own order and "Show dates" choice. */
export type StandaloneSidebarSectionOptions = {
  sort: StandaloneSidebarSortOrder;
  showDates: boolean;
};

export function getStandaloneSidebarSectionOptions(
  options: ReadonlyMap<
    StandaloneSidebarGroupKey,
    StandaloneSidebarSectionOptions
  >,
  key: StandaloneSidebarGroupKey,
): StandaloneSidebarSectionOptions {
  return (
    options.get(key) || {
      sort: DEFAULT_STANDALONE_SIDEBAR_SORT_ORDER,
      showDates: false,
    }
  );
}

/** Saved as "codex=title+dates,upstream=recent"; bad parts are skipped. */
export function parseStandaloneSidebarSectionOptions(
  value: unknown,
): Map<StandaloneSidebarGroupKey, StandaloneSidebarSectionOptions> {
  const options = new Map<
    StandaloneSidebarGroupKey,
    StandaloneSidebarSectionOptions
  >();
  if (typeof value !== "string") return options;
  for (const part of value.split(",")) {
    const [rawKey, rawValue = ""] = part.split("=");
    const key = rawKey.trim() as StandaloneSidebarGroupKey;
    if (!DEFAULT_STANDALONE_SIDEBAR_GROUP_ORDER.includes(key)) continue;
    const [sort, ...flags] = rawValue.split("+").map((s) => s.trim());
    options.set(key, {
      sort: parseStandaloneSidebarSortOrder(sort),
      showDates: flags.includes("dates"),
    });
  }
  return options;
}

export function serializeStandaloneSidebarSectionOptions(
  options: ReadonlyMap<
    StandaloneSidebarGroupKey,
    StandaloneSidebarSectionOptions
  >,
): string {
  return DEFAULT_STANDALONE_SIDEBAR_GROUP_ORDER.filter((key) =>
    options.has(key),
  )
    .map((key) => {
      const { sort, showDates } = options.get(
        key,
      ) as StandaloneSidebarSectionOptions;
      return `${key}=${parseStandaloneSidebarSortOrder(sort)}${showDates ? "+dates" : ""}`;
    })
    .join(",");
}
