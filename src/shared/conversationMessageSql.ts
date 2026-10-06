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

/** Selects one user row that matches a conversation selector and a filter. */
export function buildUserRowExistsQuery(params: {
  tableName: string;
  whereSql: string;
  filterSql: string;
}): string {
  return `SELECT id FROM ${params.tableName}
    WHERE ${params.whereSql} AND role = 'user'${params.filterSql}
    LIMIT 1`;
}
