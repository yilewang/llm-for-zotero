/**
 * Reading, filtering and paging the library index snapshot, and building the
 * `Zotero.Search` behind the agent's structured filters.
 *
 * Two separate sources answer "which items match": the warm in-memory index
 * snapshot for listings, and `Zotero.Search` for anything the SQL side can
 * narrow. The exact bounds are applied here either way, because the search
 * conditions can only approximate a year range.
 */

import type {
  LibraryIndexItem,
  LibraryIndexSnapshot,
} from "../../../../services/libraryIndexService";
import { normalizeResultLimit, normalizeText } from "./normalize";
import type {
  AgentLibraryFilters,
  AgentSearchCondition,
  AgentSearchConditionError,
  LibraryItemTarget,
} from "./types";

export function indexItemMatchesType(
  item: LibraryIndexItem,
  requestedType?: string,
): boolean {
  const normalized = requestedType?.trim().toLowerCase();
  return !normalized || item.itemType.toLowerCase() === normalized;
}

export function indexItemHasGatewayPdf(
  snapshot: LibraryIndexSnapshot,
  itemId: number,
): boolean {
  return (snapshot.childAttachmentIdsByItemId.get(itemId) || []).some(
    (attachmentId) => snapshot.attachmentById.get(attachmentId)?.isPdf,
  );
}

export function orderedIndexIds(
  snapshot: LibraryIndexSnapshot,
  predicate: (item: LibraryIndexItem) => boolean,
): number[] {
  return snapshot.topLevelItemOrder.filter((itemId) => {
    const item = snapshot.itemById.get(itemId);
    return Boolean(item && !item.deleted && predicate(item));
  });
}

export function orderedGatewayPaperIds(
  snapshot: LibraryIndexSnapshot,
): number[] {
  return orderedIndexIds(
    snapshot,
    (item) =>
      item.kind === "regular" && indexItemHasGatewayPdf(snapshot, item.itemId),
  ).sort((leftId, rightId) => {
    const left = snapshot.itemById.get(leftId)!;
    const right = snapshot.itemById.get(rightId)!;
    const modifiedDelta = right.modifiedAt - left.modifiedAt;
    if (modifiedDelta !== 0) return modifiedDelta;
    return left.title.localeCompare(right.title, undefined, {
      sensitivity: "base",
    });
  });
}

export function pageIds(ids: number[], limit: unknown): number[] {
  const normalized = normalizeResultLimit(limit);
  return normalized ? ids.slice(0, normalized) : ids;
}

export function sortAndPageIndexIds(
  snapshot: LibraryIndexSnapshot,
  ids: number[],
  options: {
    sort?: "dateAdded" | "title";
    order?: "asc" | "desc";
    offset?: number;
    limit?: number;
  },
): number[] {
  const sorted =
    options.sort === "dateAdded" || options.sort === "title"
      ? [...ids].sort((leftId, rightId) => {
          const left = snapshot.itemById.get(leftId);
          const right = snapshot.itemById.get(rightId);
          const leftValue =
            options.sort === "title"
              ? left?.title || ""
              : left?.dateAdded || "";
          const rightValue =
            options.sort === "title"
              ? right?.title || ""
              : right?.dateAdded || "";
          if (!leftValue && !rightValue) return 0;
          if (!leftValue) return 1;
          if (!rightValue) return -1;
          const compared =
            options.sort === "title"
              ? leftValue.localeCompare(rightValue)
              : leftValue < rightValue
                ? -1
                : leftValue > rightValue
                  ? 1
                  : 0;
          const descending =
            options.sort === "title"
              ? options.order === "desc"
              : options.order !== "asc";
          return descending ? -compared : compared;
        })
      : ids;
  const offset =
    Number.isFinite(options.offset) && Number(options.offset) > 0
      ? Math.floor(Number(options.offset))
      : 0;
  return pageIds(offset ? sorted.slice(offset) : sorted, options.limit);
}

export function libraryItemTargetHasPdf(target: LibraryItemTarget): boolean {
  return target.attachments.some((attachment) => {
    const contentType = normalizeText(attachment.contentType).toLowerCase();
    const title = normalizeText(attachment.title).toLowerCase();
    return (
      contentType === "application/pdf" ||
      title.endsWith(".pdf") ||
      title === "pdf"
    );
  });
}

export function libraryItemTargetMatchesFilters(
  target: LibraryItemTarget,
  filters?: { hasPdf?: boolean },
): boolean {
  if (filters?.hasPdf === undefined) return true;
  return libraryItemTargetHasPdf(target) === filters.hasPdf;
}

// ── Zotero.Search-backed listing helpers ──────────────────────────────────────

/**
 * Checks conditions before any of them reach `Zotero.Search`.
 *
 * `addCondition` throws for both an unknown condition and an unsupported
 * operator, and a throw mid-build leaves a half-populated search. Worse, the
 * callers used to swallow it into an empty result, which is how a year filter
 * silently reported "no matching library results" on every library. Validate
 * first, and tell the model which operators the condition actually takes --
 * an error it cannot act on is as useless as an empty result.
 */
export function validateSearchConditions(
  conditions: AgentSearchCondition[],
): AgentSearchConditionError[] {
  const registry = (
    Zotero as unknown as {
      SearchConditions?: {
        get?: (
          name: string,
        ) => { operators?: Record<string, boolean> } | undefined;
      };
    }
  ).SearchConditions;
  if (!registry?.get) return [];
  const errors: AgentSearchConditionError[] = [];
  for (const entry of conditions) {
    const name = String(entry?.condition || "").trim();
    if (!name) {
      errors.push({ condition: "", reason: "A condition name is required" });
      continue;
    }
    // A block flips joinMode for the WHOLE query: any block sets
    // hasQuicksearch, and joinModeAny is `_joinMode == 'any' || hasQuicksearch`.
    // Exposing them would let one clause silently turn an AND search into OR.
    if (name === "blockStart" || name === "blockEnd") {
      errors.push({
        condition: name,
        reason:
          "Grouping blocks are not available: opening one flips every other condition in the query from AND to OR. Use joinMode instead, or run separate searches.",
      });
      continue;
    }
    // Zotero 10's group markers are placed by `planSearchConditions`, which
    // needs them balanced. A stray marker from the model would silently
    // restructure the query, so the flag stays the only way to ask for one.
    if (name === "groupStart" || name === "groupEnd") {
      errors.push({
        condition: name,
        reason:
          "Condition groups are built for you: mark a clause isRequired under joinMode 'any' instead of passing groupStart/groupEnd.",
      });
      continue;
    }
    const declared = registry.get(name);
    if (!declared) {
      errors.push({
        condition: name,
        reason: `"${name}" is not a Zotero search condition`,
      });
      continue;
    }
    const operator = String(entry?.operator || "").trim();
    const validOperators = Object.keys(declared.operators || {});
    if (!operator || !declared.operators?.[operator]) {
      errors.push({
        condition: name,
        reason: `"${operator || "(missing)"}" is not a valid operator for "${name}"`,
        validOperators,
      });
    }
  }
  return errors;
}

/** One `addCondition` call, in the order the calls must be made. */
export type PlannedSearchCondition = {
  condition: string;
  operator: string;
  value: string | number;
  required?: boolean;
};

/**
 * Zotero 10 removed the per-condition `required` flag (`addCondition` throws
 * on it and the column is gone) in favour of nested condition groups
 * delimited by `groupStart`/`groupEnd`. Zotero 7-9 have the flag and no
 * markers, so the marker's presence in the condition registry is the test.
 */
export function zoteroSupportsConditionGroups(): boolean {
  const registry = (
    Zotero as unknown as {
      SearchConditions?: { get?: (name: string) => unknown };
    }
  ).SearchConditions;
  try {
    return Boolean(registry?.get?.("groupStart"));
  } catch {
    return false;
  }
}

/**
 * Turns the agent's conditions into the `addCondition` calls that mean the
 * same thing on every supported Zotero.
 *
 * On Zotero 7-9 a `required` clause under joinMode `any` is ANDed while the
 * rest are ORed: `req1 AND req2 AND (opt1 OR opt2)`. Zotero 10 expresses
 * exactly that as a top-level `all` search whose optional clauses sit in a
 * nested `any` group. Under joinMode `all` the flag never changed anything,
 * so it is dropped there rather than forwarded to an API that rejects it.
 */
export function planSearchConditions(params: {
  conditions: AgentSearchCondition[];
  joinMode?: "all" | "any";
  includeTrashed?: boolean;
  supportsConditionGroups?: boolean;
}): PlannedSearchCondition[] {
  const supportsGroups =
    params.supportsConditionGroups ?? zoteroSupportsConditionGroups();
  const clause = (entry: AgentSearchCondition): PlannedSearchCondition => ({
    condition: entry.mode
      ? `${entry.condition}/${entry.mode}`
      : entry.condition,
    operator: entry.operator,
    value: entry.value === undefined ? "" : entry.value,
  });
  const plan: PlannedSearchCondition[] = [];
  const joinMode =
    params.joinMode === "any" || params.joinMode === "all"
      ? params.joinMode
      : undefined;
  const required = params.conditions.filter((entry) => entry.required);
  const optional = params.conditions.filter((entry) => !entry.required);
  const grouped = supportsGroups && joinMode === "any" && required.length > 0;

  if (grouped) {
    plan.push({ condition: "joinMode", operator: "all", value: "" });
  } else if (joinMode) {
    plan.push({ condition: "joinMode", operator: joinMode, value: "" });
  }
  // Zotero excludes trashed items unless told otherwise, so listing the
  // trash was impossible without this -- which in turn made restore
  // unusable, because nothing could enumerate what was in there.
  if (params.includeTrashed) {
    plan.push({ condition: "deleted", operator: "true", value: "" });
  }

  if (!supportsGroups) {
    for (const entry of params.conditions) {
      plan.push(
        entry.required ? { ...clause(entry), required: true } : clause(entry),
      );
    }
    return plan;
  }
  if (!grouped) {
    for (const entry of params.conditions) plan.push(clause(entry));
    return plan;
  }
  for (const entry of required) plan.push(clause(entry));
  if (optional.length) {
    plan.push({ condition: "groupStart", operator: "true", value: "" });
    plan.push({ condition: "joinMode", operator: "any", value: "" });
    for (const entry of optional) plan.push(clause(entry));
    plan.push({ condition: "groupEnd", operator: "true", value: "" });
  }
  return plan;
}

/**
 * Applies the exact year range in JS.
 *
 * The SQL side can only narrow: Zotero compares dates as strings, and an
 * `isAfter` on a bare year matches everything later in *that same* year. So
 * the range is enforced here, on the parsed year, exactly as the in-memory
 * fallback path already did. Items with no parseable year are excluded, which
 * is what a year-bounded question means.
 */
export function libraryItemTargetMatchesYear(
  target: LibraryItemTarget,
  filters?: { yearFrom?: number; yearTo?: number },
): boolean {
  if (filters?.yearFrom == null && filters?.yearTo == null) return true;
  const year = parseInt(String(target.year ?? ""), 10);
  if (Number.isNaN(year)) return false;
  if (filters.yearFrom != null && year < filters.yearFrom) return false;
  if (filters.yearTo != null && year > filters.yearTo) return false;
  return true;
}

/**
 * Builds the `Zotero.Search` behind the agent's structured filters.
 *
 * Two conditions here were wrong in ways that silently produced empty or
 * over-broad results:
 *
 * 1. `year` was given `isGreaterThan`/`isLessThan`, which it does not accept
 *    (`searchConditions.js` allows only is/isNot/contains/doesNotContain).
 *    `addCondition` *throws* on an unsupported operator, and both callers
 *    swallowed the throw — so every text search combined with a year filter
 *    reported "no matching library results", always. The list path happened
 *    to fall back to an in-memory filter, which is why this went unnoticed.
 *    Year is now narrowed with `date`, which does support ranges, and made
 *    exact by `libraryItemTargetMatchesYear`.
 *
 * 2. The author filter was an OR block. Any block sets `hasQuicksearch`, and
 *    `joinModeAny` is `_joinMode == 'any' || hasQuicksearch` — so opening a
 *    block flipped *every other condition* in the query from AND to OR. A
 *    search for "papers by Peyrache in collection X" returned everything by
 *    Peyrache plus everything in X. `creator` matches all creator roles in
 *    one condition, so no block is needed.
 */
export function buildAgentLibrarySearch(
  libraryID: number,
  filters: AgentLibraryFilters,
): Zotero.Search {
  const search = new Zotero.Search({ libraryID });
  if (filters.collectionId) {
    search.addCondition("collectionID", "is", filters.collectionId);
  }
  if (filters.unfiled) {
    search.addCondition("unfiled", "true", "");
  }
  if (filters.itemType) {
    search.addCondition("itemType", "is", filters.itemType);
  }
  if (filters.author) {
    // `creator` spans author, editor, bookAuthor and the rest.
    search.addCondition("creator", "contains", filters.author);
  }
  if (filters.yearFrom != null) {
    // `> 'YYYY-00-00'`, so this may admit part of the preceding year; the
    // exact bound is applied afterwards.
    search.addCondition("date", "isAfter", String(filters.yearFrom - 1));
  }
  if (filters.yearTo != null) {
    // `< 'YYYY-00-00'` for the following year, which is an exact upper bound.
    search.addCondition("date", "isBefore", String(filters.yearTo + 1));
  }
  if (filters.tag) {
    search.addCondition("tag", "is", filters.tag);
  }
  if (filters.deleted) {
    // Zotero excludes trashed items from every search unless asked, so
    // without this the trash could not be enumerated -- and restoring
    // something the user deleted meant knowing its id already.
    search.addCondition("deleted", "true" as never, "");
  }
  return search;
}
