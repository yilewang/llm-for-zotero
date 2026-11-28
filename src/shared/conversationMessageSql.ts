import type { StoredMessageText } from "./types";

export type { StoredMessageText };
export type StoredMessageOrderDirection = "asc" | "desc";

export function storedMessageRoleOrderSql(roleColumn = "role"): string {
  return `CASE ${roleColumn} WHEN 'user' THEN 0 WHEN 'assistant' THEN 1 ELSE 2 END`;
}

export function storedMessageDisplayOrderSql(
  options: {
    direction?: StoredMessageOrderDirection;
    tableAlias?: string;
  } = {},
): string {
  const direction = options.direction === "desc" ? "DESC" : "ASC";
  const column = (name: string) =>
    options.tableAlias ? `${options.tableAlias}.${name}` : name;
  return [
    `${column("timestamp")} ${direction}`,
    `${storedMessageRoleOrderSql(column("role"))} ${direction}`,
    `${column("id")} ${direction}`,
  ].join(", ");
}

export function buildLatestStoredMessagesQuery(params: {
  tableName: string;
  selectColumnsSql: string;
  whereSql: string;
}): string {
  return `SELECT *
    FROM (
      SELECT ${params.selectColumnsSql}
      FROM ${params.tableName}
      WHERE ${params.whereSql}
      ORDER BY ${storedMessageDisplayOrderSql({ direction: "desc" })}
      LIMIT ?
    )
    ORDER BY ${storedMessageDisplayOrderSql({ direction: "asc" })}`;
}

/**
 * Every stored message of a conversation as text, oldest first, before
 * `beforeTimestamp` when given: no screenshot, attachment or context data.
 * `compactMarkerColumn` names the store's compaction-marker column, if any.
 */
export function buildStoredMessageTextsQuery(params: {
  tableName: string;
  whereSql: string;
  compactMarkerColumn?: string;
  before: boolean;
}): string {
  // Every row has the column: a Zotero DB row throws on an unknown one.
  return `SELECT role, text, timestamp, ${
    params.compactMarkerColumn || "0"
  } AS compactMarker
    FROM ${params.tableName}
    WHERE ${params.whereSql}${params.before ? " AND timestamp < ?" : ""}
    ORDER BY ${storedMessageDisplayOrderSql({ direction: "asc" })}`;
}

/**
 * A revision of the rows buildStoredMessageTextsQuery reads: their count,
 * last id and total text length. It changes when a message is added,
 * removed (a Clear, a deleted turn, an edit's truncation) or rewritten.
 */
export function buildStoredMessageTextsRevisionQuery(params: {
  tableName: string;
  whereSql: string;
  before: boolean;
}): string {
  return `SELECT COUNT(*) AS count, MAX(id) AS lastId, TOTAL(LENGTH(text)) AS chars
    FROM ${params.tableName}
    WHERE ${params.whereSql}${params.before ? " AND timestamp < ?" : ""}`;
}

/** The row of buildStoredMessageTextsRevisionQuery as one string. */
export function readStoredMessageTextsRevision(
  rows: ReadonlyArray<Record<string, unknown>> | undefined,
): string {
  const row = rows?.[0];
  return row
    ? `${Number(row.count) || 0}:${Number(row.lastId) || 0}:${Number(row.chars) || 0}`
    : "0:0:0";
}

/** Rows of buildStoredMessageTextsQuery as StoredMessageText. */
export function readStoredMessageTexts(
  rows: ReadonlyArray<Record<string, unknown>> | undefined,
): StoredMessageText[] {
  return (rows || []).map((row) => ({
    role: String(row.role || ""),
    text: typeof row.text === "string" ? row.text : String(row.text ?? ""),
    timestamp: Number(row.timestamp) || 0,
    ...(Number(row.compactMarker) === 1 ? { compactMarker: true } : {}),
  }));
}

/** Which stored user row an "update latest user message" write targets. */
export type UpdateLatestUserMessageOptions = {
  /**
   * When set, the write targets the user row stored at this timestamp, even
   * when a later user row exists, and writes nothing when no user row has
   * it. Without it the write targets the conversation's latest user row.
   */
  expectedTimestamp?: number;
};

/**
 * The extra WHERE condition, appended after `role = 'user'`, that limits an
 * "update latest user message" write to the expected row. It is empty when
 * the write targets the latest user row.
 */
export function latestUserRowFilter(options: UpdateLatestUserMessageOptions): {
  exact: boolean;
  sql: string;
  params: unknown[];
} {
  const expected = Number(options.expectedTimestamp);
  if (options.expectedTimestamp === undefined || !Number.isFinite(expected)) {
    return { exact: false, sql: "", params: [] };
  }
  return {
    exact: true,
    sql: " AND timestamp = ?",
    params: [Math.floor(expected)],
  };
}

/**
 * Selects one row of `role` (the user row by default) that matches a
 * conversation selector and a filter.
 */
export function buildUserRowExistsQuery(params: {
  tableName: string;
  whereSql: string;
  filterSql: string;
  role?: "user" | "assistant";
}): string {
  return `SELECT id FROM ${params.tableName}
    WHERE ${params.whereSql} AND role = '${params.role === "assistant" ? "assistant" : "user"}'${params.filterSql}
    LIMIT 1`;
}

/**
 * Which stored assistant row an "update latest assistant message" write
 * targets: the row at `expectedTimestamp` when set, the latest otherwise.
 * The filter is `latestUserRowFilter`, which does not depend on the role.
 */
export type UpdateLatestAssistantMessageOptions =
  UpdateLatestUserMessageOptions;
