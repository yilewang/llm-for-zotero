import {
  JOURNAL_ACTIONS_TABLE,
  JOURNAL_BLOB_CLEANUP_TABLE,
  LEGACY_JOURNAL_TABLE,
  JOURNAL_OBSERVATIONS_TABLE,
  JOURNAL_PAYLOADS_TABLE,
  JOURNAL_STEPS_TABLE,
} from "../../src/agent/store/changeJournal";

type Row = Record<string, unknown>;

function compact(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function asRows(values: Iterable<Row>): Row[] {
  return [...values].map((row) => ({ ...row }));
}

/**
 * Focused in-memory adapter for the journal SQL contract.
 *
 * This deliberately understands only the statements issued by
 * changeJournal.ts. It gives lifecycle/restart tests observable durable state
 * without replacing production SQL with a test-only repository abstraction.
 */
export class ChangeJournalTestDb {
  readonly actions = new Map<string, Row>();
  readonly steps = new Map<string, Row>();
  readonly payloads = new Map<string, Row>();
  readonly observations = new Map<string, Row>();
  readonly cleanup = new Map<string, Row>();
  readonly legacyRows = new Map<string, Row>();
  readonly statements: Array<{ sql: string; params: unknown[] }> = [];
  failWhen?: (sql: string, params: unknown[]) => Error | null;
  private rowSequence = 0;

  async executeTransaction(task: () => Promise<void>): Promise<void> {
    const tables = [
      this.actions,
      this.steps,
      this.payloads,
      this.observations,
      this.cleanup,
      this.legacyRows,
    ];
    const snapshots = tables.map(
      (table) =>
        new Map([...table].map(([id, row]) => [id, { ...row }] as const)),
    );
    const rowSequence = this.rowSequence;
    try {
      await task();
    } catch (error) {
      tables.forEach((table, index) => {
        table.clear();
        for (const [id, row] of snapshots[index]) table.set(id, row);
      });
      this.rowSequence = rowSequence;
      throw error;
    }
  }

  addLegacyRow(row: Row): void {
    this.legacyRows.set(String(row.entry_id), { ...row });
  }

  private migrateLegacyActions(): void {
    for (const row of this.legacyRows.values()) {
      const id = String(row.entry_id);
      if (this.actions.has(id)) continue;
      const status = String(row.status || "reversible");
      this.actions.set(id, {
        action_id: id,
        run_id: row.run_id,
        conversation_key: row.conversation_key,
        tool_name: row.operation,
        description: row.description,
        effect: "write",
        reversibility: row.inverse_json == null ? "none" : "partial",
        status:
          status === "reverted"
            ? "reverted"
            : status === "irreversible"
              ? "irreversible"
              : "applied",
        affected_count: row.item_count,
        error_text: null,
        recovery_text:
          row.inverse_json == null
            ? (row.irreversible_reason ?? null)
            : (row.irreversible_reason ??
              "Legacy inverse retained for audit; automatic replay requires a verifiable v2 post-image"),
        created_at: row.created_at,
        updated_at: row.created_at,
        applied_at: status === "reverted" ? null : row.created_at,
        reverted_at: status === "reverted" ? row.created_at : null,
        _rowid: ++this.rowSequence,
      });
    }
  }

  private migrateLegacySteps(): void {
    for (const row of this.legacyRows.values()) {
      const actionId = String(row.entry_id);
      const stepId = `${actionId}:1`;
      if (this.steps.has(stepId)) continue;
      const status = String(row.status || "reversible");
      this.steps.set(stepId, {
        step_id: stepId,
        action_id: actionId,
        sequence_no: 1,
        operation: row.operation,
        forward_json: "{}",
        inverse_json: row.inverse_json ?? null,
        precondition_json: null,
        expected_postcondition_json: null,
        result_json: null,
        reversibility: row.inverse_json == null ? "none" : "partial",
        status:
          status === "reverted"
            ? "reverted"
            : status === "irreversible"
              ? "irreversible"
              : "applied",
        error_text: row.irreversible_reason ?? null,
        created_at: row.created_at,
        updated_at: row.created_at,
      });
    }
  }

  async queryAsync(sql: string, params: unknown[] = []): Promise<unknown> {
    const statement = compact(sql);
    this.statements.push({ sql: statement, params: [...params] });
    const failure = this.failWhen?.(statement, params);
    if (failure) throw failure;

    if (/^CREATE (TABLE|INDEX)/i.test(statement)) return [];

    if (
      statement.startsWith(`INSERT OR IGNORE INTO ${JOURNAL_ACTIONS_TABLE}`) &&
      statement.includes(" FROM llm_for_zotero_agent_change_journal")
    ) {
      this.migrateLegacyActions();
      return [];
    }
    if (
      statement.startsWith(`INSERT OR IGNORE INTO ${JOURNAL_STEPS_TABLE}`) &&
      statement.includes(" FROM llm_for_zotero_agent_change_journal")
    ) {
      this.migrateLegacySteps();
      return [];
    }
    if (
      statement.startsWith(`UPDATE ${JOURNAL_STEPS_TABLE}`) &&
      statement.includes("SET reversibility = CASE")
    ) {
      for (const row of this.steps.values()) {
        if (["full", "partial", "none"].includes(String(row.reversibility))) {
          continue;
        }
        row.reversibility = ["failed", "no_effect"].includes(String(row.status))
          ? "full"
          : row.status === "irreversible"
            ? "none"
            : row.inverse_json != null && row.error_text != null
              ? "partial"
              : row.inverse_json != null
                ? "full"
                : "none";
      }
      return [];
    }

    if (statement.startsWith(`INSERT INTO ${JOURNAL_ACTIONS_TABLE}`)) {
      const [
        actionId,
        runId,
        conversationKey,
        toolName,
        description,
        effect,
        reversibility,
        recovery,
        createdAt,
        updatedAt,
      ] = params;
      this.actions.set(String(actionId), {
        action_id: actionId,
        run_id: runId,
        conversation_key: conversationKey,
        tool_name: toolName,
        description,
        effect,
        reversibility,
        status: "prepared",
        affected_count: 0,
        error_text: null,
        recovery_text: recovery,
        created_at: createdAt,
        updated_at: updatedAt,
        applied_at: null,
        reverted_at: null,
        _rowid: ++this.rowSequence,
      });
      return [];
    }

    if (statement.startsWith(`INSERT INTO ${JOURNAL_STEPS_TABLE}`)) {
      const [
        stepId,
        actionId,
        sequence,
        operation,
        forwardJson,
        inverseJson,
        preconditionJson,
        reversibility,
        status,
        error,
        createdAt,
        updatedAt,
      ] = params;
      this.steps.set(String(stepId), {
        step_id: stepId,
        action_id: actionId,
        sequence_no: sequence,
        operation,
        forward_json: forwardJson,
        inverse_json: inverseJson,
        precondition_json: preconditionJson,
        expected_postcondition_json: null,
        result_json: null,
        reversibility,
        status,
        error_text: error,
        created_at: createdAt,
        updated_at: updatedAt,
      });
      return [];
    }

    if (statement.startsWith(`INSERT INTO ${JOURNAL_PAYLOADS_TABLE}`)) {
      const [
        payloadId,
        actionId,
        stepId,
        storageKind,
        inlineJson,
        blobPath,
        checksum,
        sizeBytes,
        createdAt,
      ] = params;
      this.payloads.set(String(payloadId), {
        payload_id: payloadId,
        action_id: actionId,
        step_id: stepId,
        kind: "recovery_preimage",
        storage_kind: storageKind,
        inline_json: inlineJson,
        blob_path: blobPath,
        checksum,
        size_bytes: sizeBytes,
        created_at: createdAt,
      });
      return [];
    }

    if (statement.startsWith(`INSERT INTO ${JOURNAL_OBSERVATIONS_TABLE}`)) {
      const [
        observationId,
        actionId,
        event,
        objectType,
        objectIdsJson,
        extraJson,
        createdAt,
      ] = params;
      this.observations.set(String(observationId), {
        observation_id: observationId,
        action_id: actionId,
        event,
        object_type: objectType,
        object_ids_json: objectIdsJson,
        extra_json: extraJson,
        created_at: createdAt,
      });
      return [];
    }

    if (
      statement.startsWith(
        `INSERT OR IGNORE INTO ${JOURNAL_BLOB_CLEANUP_TABLE}`,
      )
    ) {
      if (statement.includes(`JOIN ${JOURNAL_ACTIONS_TABLE}`)) {
        const createdAt = params[0];
        for (const payload of this.payloads.values()) {
          const action = this.actions.get(String(payload.action_id));
          const step = this.steps.get(String(payload.step_id));
          const terminalAction = Boolean(
            action &&
            ["failed", "no_effect", "irreversible"].includes(
              String(action.status),
            ),
          );
          const terminalStep = Boolean(
            step &&
            ["failed", "no_effect", "irreversible"].includes(
              String(step.status),
            ),
          );
          if (
            payload.storage_kind !== "blob" ||
            !payload.blob_path ||
            !action ||
            (!terminalAction && !terminalStep)
          ) {
            continue;
          }
          const id = String(payload.payload_id);
          if (!this.cleanup.has(id)) {
            this.cleanup.set(id, {
              cleanup_id: id,
              conversation_key: action.conversation_key,
              blob_path: payload.blob_path,
              created_at: createdAt,
            });
          }
        }
        return [];
      }
      const [conversationKey, createdAt] = params;
      const requestedActionId = statement.includes("AND action_id = ?")
        ? params[2]
        : undefined;
      const actionIds = new Set(
        [...this.actions.values()]
          .filter(
            (row) =>
              row.conversation_key === conversationKey &&
              (requestedActionId === undefined ||
                row.action_id === requestedActionId),
          )
          .map((row) => String(row.action_id)),
      );
      for (const payload of this.payloads.values()) {
        if (
          payload.storage_kind !== "blob" ||
          !payload.blob_path ||
          !actionIds.has(String(payload.action_id))
        ) {
          continue;
        }
        const id = String(payload.payload_id);
        if (!this.cleanup.has(id)) {
          this.cleanup.set(id, {
            cleanup_id: id,
            conversation_key: conversationKey,
            blob_path: payload.blob_path,
            created_at: createdAt,
          });
        }
      }
      return [];
    }

    if (
      statement.startsWith(
        `SELECT status, conversation_key FROM ${JOURNAL_ACTIONS_TABLE}`,
      )
    ) {
      const row = this.actions.get(String(params[0]));
      return row
        ? [{ status: row.status, conversation_key: row.conversation_key }]
        : [];
    }
    if (statement.startsWith(`SELECT status FROM ${JOURNAL_ACTIONS_TABLE}`)) {
      const row = this.actions.get(String(params[0]));
      return row ? [{ status: row.status }] : [];
    }
    if (statement.startsWith(`SELECT status FROM ${JOURNAL_STEPS_TABLE}`)) {
      const row = this.steps.get(String(params[0]));
      return row ? [{ status: row.status }] : [];
    }

    if (
      statement.startsWith(`UPDATE ${JOURNAL_ACTIONS_TABLE} SET status = ?`) &&
      statement.includes("AND status IN")
    ) {
      const [status, updatedAt, actionId, ...allowed] = params;
      const row = this.actions.get(String(actionId));
      if (row && allowed.includes(row.status)) {
        row.status = status;
        row.updated_at = updatedAt;
      }
      return [];
    }
    if (
      statement.startsWith(`UPDATE ${JOURNAL_STEPS_TABLE} SET status = ?`) &&
      statement.includes("AND status IN")
    ) {
      const [status, updatedAt, stepId, ...allowed] = params;
      const row = this.steps.get(String(stepId));
      if (row && allowed.includes(row.status)) {
        row.status = status;
        row.updated_at = updatedAt;
      }
      return [];
    }

    if (statement.startsWith(`UPDATE ${JOURNAL_STEPS_TABLE} SET status = ?`)) {
      const [
        status,
        inverseJson,
        expectedPostconditionJson,
        resultJson,
        reversibility,
        error,
        updatedAt,
        stepId,
      ] = params;
      const row = this.steps.get(String(stepId));
      if (row) {
        row.status = status;
        if (inverseJson != null) row.inverse_json = inverseJson;
        if (expectedPostconditionJson != null) {
          row.expected_postcondition_json = expectedPostconditionJson;
        }
        if (resultJson != null) row.result_json = resultJson;
        if (reversibility != null) row.reversibility = reversibility;
        row.error_text = error;
        row.updated_at = updatedAt;
      }
      return [];
    }

    if (
      statement.startsWith(`UPDATE ${JOURNAL_ACTIONS_TABLE} SET status = ?`)
    ) {
      const [
        status,
        reversibility,
        affectedCount,
        error,
        recovery,
        updatedAt,
        appliedStatus,
        appliedAt,
        revertedStatus,
        revertedAt,
        actionId,
      ] = params;
      const row = this.actions.get(String(actionId));
      if (row) {
        row.status = status;
        if (reversibility != null) row.reversibility = reversibility;
        if (affectedCount != null) row.affected_count = affectedCount;
        row.error_text = error;
        if (recovery != null) row.recovery_text = recovery;
        row.updated_at = updatedAt;
        if (
          [
            "applied",
            "partially_applied",
            "irreversible",
            "no_effect",
          ].includes(String(appliedStatus)) &&
          row.applied_at == null
        ) {
          row.applied_at = appliedAt;
        }
        if (revertedStatus === "reverted") row.reverted_at = revertedAt;
      }
      return [];
    }

    if (
      statement.startsWith(`UPDATE ${JOURNAL_STEPS_TABLE}`) &&
      statement.includes("SET status = 'revert_failed'") &&
      statement.includes("WHERE status = 'reverting'")
    ) {
      for (const row of this.steps.values()) {
        if (row.status === "reverting") {
          row.status = "revert_failed";
          row.error_text ||=
            "Interrupted while reverting; verify the current object state before retrying";
          row.updated_at = params[0];
        }
      }
      return [];
    }
    if (
      statement.startsWith(`UPDATE ${JOURNAL_ACTIONS_TABLE}`) &&
      statement.includes("SET status = 'revert_failed'") &&
      statement.includes("WHERE status = 'reverting'")
    ) {
      for (const row of this.actions.values()) {
        if (row.status === "reverting") {
          row.status = "revert_failed";
          row.recovery_text ||=
            "The process stopped during undo. Guarded retry will verify the current post-image before applying another inverse.";
          row.updated_at = params[0];
        }
      }
      return [];
    }

    if (
      statement.startsWith(`UPDATE ${JOURNAL_STEPS_TABLE}`) &&
      statement.includes("SET forward_json = '{}'")
    ) {
      const terminalActionIds = statement.includes(
        `SELECT action_id FROM ${JOURNAL_ACTIONS_TABLE}`,
      )
        ? new Set(
            [...this.actions.values()]
              .filter((row) =>
                ["failed", "no_effect", "irreversible"].includes(
                  String(row.status),
                ),
              )
              .map((row) => String(row.action_id)),
          )
        : null;
      for (const row of this.steps.values()) {
        if (
          terminalActionIds
            ? !terminalActionIds.has(String(row.action_id)) &&
              !["failed", "no_effect", "irreversible"].includes(
                String(row.status),
              )
            : row.action_id !== params[0]
        ) {
          continue;
        }
        row.forward_json = "{}";
        row.inverse_json = null;
        row.precondition_json = null;
        row.expected_postcondition_json = null;
        row.result_json = null;
      }
      return [];
    }
    if (
      statement.startsWith(`UPDATE ${JOURNAL_STEPS_TABLE}`) &&
      statement.includes("WHERE status = 'applying'")
    ) {
      for (const row of this.steps.values()) {
        if (row.status === "applying") {
          row.status = "uncertain";
          row.updated_at = params[0];
        }
      }
      return [];
    }
    if (
      statement.startsWith(`UPDATE ${JOURNAL_ACTIONS_TABLE}`) &&
      statement.includes("SELECT action_id") &&
      statement.includes("status = 'uncertain'")
    ) {
      const uncertainActions = new Set(
        [...this.steps.values()]
          .filter((row) => row.status === "uncertain")
          .map((row) => String(row.action_id)),
      );
      for (const row of this.actions.values()) {
        if (
          uncertainActions.has(String(row.action_id)) &&
          (row.status === "prepared" || row.status === "applying")
        ) {
          row.status = "uncertain";
          row.updated_at = params[0];
        }
      }
      return [];
    }
    if (
      statement.startsWith(`UPDATE ${JOURNAL_STEPS_TABLE}`) &&
      statement.includes("WHERE status = 'prepared'")
    ) {
      for (const row of this.steps.values()) {
        if (row.status === "prepared") {
          row.status = "failed";
          row.error_text ||= "Interrupted before the write started";
          row.updated_at = params[0];
        }
      }
      return [];
    }
    if (
      statement.startsWith(`UPDATE ${JOURNAL_ACTIONS_TABLE}`) &&
      statement.includes("SET status = 'partially_applied'")
    ) {
      const effectfulActionIds = new Set(
        [...this.steps.values()]
          .filter((row) =>
            ["applied", "irreversible"].includes(String(row.status)),
          )
          .map((row) => String(row.action_id)),
      );
      for (const row of this.actions.values()) {
        if (
          (row.status === "prepared" || row.status === "applying") &&
          effectfulActionIds.has(String(row.action_id))
        ) {
          const steps = [...this.steps.values()].filter(
            (step) =>
              step.action_id === row.action_id &&
              ["applied", "irreversible"].includes(String(step.status)),
          );
          const reversibilities = steps.map((step) =>
            String(step.reversibility),
          );
          row.status = "partially_applied";
          row.reversibility = reversibilities.every((value) => value === "full")
            ? "full"
            : reversibilities.every((value) => value === "none")
              ? "none"
              : "partial";
          const recovery = steps
            .filter(
              (step) =>
                step.reversibility !== "full" && step.error_text != null,
            )
            .map((step) => String(step.error_text))
            .join(" ");
          row.recovery_text = recovery || null;
          row.updated_at = params[0];
        }
      }
      return [];
    }
    if (
      statement.startsWith(`UPDATE ${JOURNAL_ACTIONS_TABLE}`) &&
      statement.includes("SET status = 'no_effect'")
    ) {
      const noEffectActionIds = new Set(
        [...this.steps.values()]
          .filter((row) =>
            ["no_effect", "reverted"].includes(String(row.status)),
          )
          .map((row) => String(row.action_id)),
      );
      for (const row of this.actions.values()) {
        if (
          (row.status === "prepared" || row.status === "applying") &&
          noEffectActionIds.has(String(row.action_id))
        ) {
          row.status = "no_effect";
          row.reversibility = "full";
          row.affected_count = 0;
          row.error_text = null;
          row.recovery_text = null;
          row.applied_at ??= params[0];
          row.updated_at = params[1];
        }
      }
      return [];
    }
    if (
      statement.startsWith(`UPDATE ${JOURNAL_ACTIONS_TABLE}`) &&
      statement.includes("WHERE status IN ('prepared','applying')")
    ) {
      for (const row of this.actions.values()) {
        if (row.status === "prepared" || row.status === "applying") {
          row.status = "failed";
          row.reversibility = "full";
          row.affected_count = 0;
          row.error_text ||= "Interrupted before the write started";
          row.recovery_text = null;
          row.updated_at = params[0];
        }
      }
      return [];
    }

    if (statement.startsWith(`SELECT * FROM ${JOURNAL_STEPS_TABLE}`)) {
      return asRows(this.steps.values())
        .filter((row) => row.action_id === params[0])
        .sort(
          (left, right) => Number(left.sequence_no) - Number(right.sequence_no),
        );
    }
    if (statement.startsWith(`SELECT * FROM ${JOURNAL_ACTIONS_TABLE}`)) {
      let rows = asRows(this.actions.values());
      let parameterIndex = 0;
      if (statement.includes("action_id = ?")) {
        const value = params[parameterIndex++];
        rows = rows.filter((row) => row.action_id === value);
      }
      if (statement.includes("conversation_key = ?")) {
        const value = params[parameterIndex++];
        rows = rows.filter((row) => row.conversation_key === value);
      }
      if (statement.includes("run_id = ?")) {
        const value = params[parameterIndex++];
        rows = rows.filter((row) => row.run_id === value);
      }
      if (statement.includes("status NOT IN")) {
        rows = rows.filter(
          (row) =>
            !["reverted", "no_effect", "failed"].includes(String(row.status)),
        );
      }
      const sorted = rows.sort(
        (left, right) =>
          Number(right.created_at) - Number(left.created_at) ||
          Number(right._rowid) - Number(left._rowid),
      );
      if (!statement.includes("LIMIT ?")) return sorted;
      const limit = Number(params[params.length - 1]) || 50;
      return sorted.slice(0, limit);
    }

    if (
      statement.startsWith(
        `SELECT object_ids_json FROM ${JOURNAL_OBSERVATIONS_TABLE}`,
      )
    ) {
      return asRows(this.observations.values())
        .filter((row) => row.action_id === params[0])
        .sort(
          (left, right) => Number(left.created_at) - Number(right.created_at),
        );
    }

    if (
      statement.startsWith(`SELECT blob_path FROM ${JOURNAL_PAYLOADS_TABLE}`)
    ) {
      return asRows(this.payloads.values()).filter((row) => {
        if (row.storage_kind !== "blob" || !row.blob_path) return false;
        if (!statement.includes("action_id")) return true;
        return params.map(String).includes(String(row.action_id));
      });
    }
    if (
      statement.startsWith(
        `SELECT cleanup_id, blob_path FROM ${JOURNAL_BLOB_CLEANUP_TABLE}`,
      )
    ) {
      return asRows(this.cleanup.values()).filter(
        (row) => params.length === 0 || row.conversation_key === params[0],
      );
    }

    if (statement.startsWith(`DELETE FROM ${JOURNAL_BLOB_CLEANUP_TABLE}`)) {
      this.cleanup.delete(String(params[0]));
      return [];
    }
    if (statement.startsWith(`DELETE FROM ${JOURNAL_OBSERVATIONS_TABLE}`)) {
      const actionIds = this.actionIdsForDelete(statement, params);
      for (const [id, row] of this.observations) {
        if (actionIds.has(String(row.action_id))) this.observations.delete(id);
      }
      return [];
    }
    if (statement.startsWith(`DELETE FROM ${JOURNAL_PAYLOADS_TABLE}`)) {
      if (statement.includes(`SELECT step_id FROM ${JOURNAL_STEPS_TABLE}`)) {
        for (const [id, row] of this.payloads) {
          const action = this.actions.get(String(row.action_id));
          const step = this.steps.get(String(row.step_id));
          const terminalAction = Boolean(
            action &&
            ["failed", "no_effect", "irreversible"].includes(
              String(action.status),
            ),
          );
          const terminalStep = Boolean(
            step &&
            ["failed", "no_effect", "irreversible"].includes(
              String(step.status),
            ),
          );
          if (terminalAction || terminalStep) this.payloads.delete(id);
        }
        return [];
      }
      const actionIds = this.actionIdsForDelete(statement, params);
      for (const [id, row] of this.payloads) {
        if (actionIds.has(String(row.action_id))) this.payloads.delete(id);
      }
      return [];
    }
    if (statement.startsWith(`DELETE FROM ${JOURNAL_STEPS_TABLE}`)) {
      const actionIds = this.actionIdsForDelete(statement, params);
      for (const [id, row] of this.steps) {
        if (actionIds.has(String(row.action_id))) this.steps.delete(id);
      }
      return [];
    }
    if (statement.startsWith(`DELETE FROM ${JOURNAL_ACTIONS_TABLE}`)) {
      if (!params.length) this.actions.clear();
      else {
        for (const [id, row] of this.actions) {
          if (row.conversation_key === params[0]) this.actions.delete(id);
        }
      }
      return [];
    }
    if (statement.startsWith(`DELETE FROM ${LEGACY_JOURNAL_TABLE}`)) {
      if (!params.length) this.legacyRows.clear();
      else {
        for (const [id, row] of this.legacyRows) {
          if (row.conversation_key === params[0]) this.legacyRows.delete(id);
        }
      }
      return [];
    }

    return [];
  }

  private actionIdsForDelete(
    statement: string,
    params: unknown[],
  ): Set<string> {
    if (!statement.includes(`SELECT action_id FROM ${JOURNAL_ACTIONS_TABLE}`)) {
      return params.length
        ? new Set([String(params[0])])
        : new Set(this.actions.keys());
    }
    if (statement.includes("status IN ('failed','no_effect','irreversible')")) {
      return new Set(
        [...this.actions.values()]
          .filter((row) =>
            ["failed", "no_effect", "irreversible"].includes(
              String(row.status),
            ),
          )
          .map((row) => String(row.action_id)),
      );
    }
    if (!params.length) return new Set(this.actions.keys());
    return new Set(
      [...this.actions.values()]
        .filter((row) => row.conversation_key === params[0])
        .map((row) => String(row.action_id)),
    );
  }
}
