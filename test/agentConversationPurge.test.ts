import { assert } from "chai";
import { purgeAgentConversation } from "../src/agent/store/agentConversationPurge";

/**
 * The agent row purge runs inside every store's deletion transaction.  Its
 * statement order is part of the deletion contract: Task progress first, the
 * trace run IDs read (and their files queued) before any row goes, and each
 * delete statement tolerating an absent table on its own.
 */
describe("agent conversation purge", function () {
  const globalScope = globalThis as { Zotero?: unknown };
  let savedZotero: unknown;
  let statements: string[];
  let calls: string[];
  let queuedTraceFiles: unknown[][];

  function install(
    options: {
      missing?: RegExp;
      failOn?: RegExp;
      runIds?: string[];
      exportRunIds?: string[];
    } = {},
  ) {
    statements = [];
    calls = [];
    queuedTraceFiles = [];
    globalScope.Zotero = {
      Profile: { dir: "/tmp/llm-for-zotero-agent-purge" },
      DB: {
        queryAsync: async (sql: string, params: unknown[] = []) => {
          const text = sql.replace(/\s+/g, " ").trim();
          statements.push(text);
          if (text.includes("INTO llm_for_zotero_agent_trace_file_cleanup")) {
            queuedTraceFiles.push(params);
          }
          if (options.missing?.test(text)) throw new Error("no such table: t");
          if (options.failOn?.test(text)) throw new Error("disk I/O error");
          if (
            text.startsWith(
              "SELECT run_id AS runId FROM llm_for_zotero_agent_runs",
            )
          ) {
            return (options.runIds || ["run-1"]).map((runId) => ({ runId }));
          }
          if (
            text.startsWith(
              "SELECT run_id AS runId FROM llm_for_zotero_agent_trace_exports",
            )
          ) {
            return (options.exportRunIds || []).map((runId) => ({ runId }));
          }
          return [];
        },
      },
    };
  }

  const deps = {
    clearTaskProgress: (key: number) => {
      calls.push(`clearTaskProgress:${key}`);
      calls.push(`statementsBefore:${statements.length}`);
    },
  };

  beforeEach(function () {
    savedZotero = globalScope.Zotero;
  });
  afterEach(function () {
    globalScope.Zotero = savedZotero;
  });

  it("clears Task progress first, reads run IDs, then deletes in the fixed order", async function () {
    install();
    await purgeAgentConversation(77, deps);
    assert.deepEqual(calls, ["clearTaskProgress:77", "statementsBefore:0"]);
    const heads = statements.map((sql) =>
      sql.replace(/ WHERE .*$/, "").replace(/ \(.*$/, ""),
    );
    assert.deepEqual(heads.slice(0, 6), [
      "SELECT run_id AS runId FROM llm_for_zotero_agent_runs",
      "SELECT run_id AS runId FROM llm_for_zotero_agent_trace_exports",
      "INSERT OR REPLACE INTO llm_for_zotero_agent_trace_file_cleanup",
      "DELETE FROM llm_for_zotero_agent_run_events",
      "DELETE FROM llm_for_zotero_agent_runs",
      "DELETE FROM llm_for_zotero_agent_trace_exports",
    ]);
    assert.deepEqual(heads.slice(6, 11), [
      "DELETE FROM llm_for_zotero_agent_memory",
      "DELETE FROM llm_for_zotero_agent_transcript",
      "DELETE FROM llm_for_zotero_agent_tool_result_handles",
      "DELETE FROM llm_for_zotero_agent_evidence",
      "DELETE FROM llm_for_zotero_agent_coverage",
    ]);
    assert.deepEqual(heads.slice(-5), [
      "DELETE FROM llm_for_zotero_agent_journal_observations_v2",
      "DELETE FROM llm_for_zotero_agent_journal_payloads_v2",
      "DELETE FROM llm_for_zotero_agent_journal_steps_v2",
      "DELETE FROM llm_for_zotero_agent_journal_actions_v2",
      "DELETE FROM llm_for_zotero_agent_change_journal",
    ]);
  });

  it("queues the trace files of exports that have no run row", async function () {
    install({ runIds: [], exportRunIds: ["export-only"] });
    await purgeAgentConversation(77, deps);
    assert.deepEqual(
      queuedTraceFiles.map((params) => params[0]),
      ["export-only"],
      "the export-only run reaches the trace-file cleanup queue",
    );
    assert.equal(queuedTraceFiles[0][1], 77);
    assert.isFalse(
      statements.some((sql) =>
        sql.startsWith("DELETE FROM llm_for_zotero_agent_run_events"),
      ),
      "no run events to delete without a run row",
    );
  });

  it("skips an absent table and keeps deleting the rest", async function () {
    install({ missing: /agent_memory|agent_journal_payloads_v2/ });
    await purgeAgentConversation(77, deps);
    assert.isTrue(
      statements.some((sql) =>
        sql.startsWith("DELETE FROM llm_for_zotero_agent_transcript"),
      ),
    );
    assert.isTrue(
      statements.some((sql) =>
        sql.startsWith("DELETE FROM llm_for_zotero_agent_change_journal"),
      ),
    );
  });

  it("lets any other failure reach the owning transaction", async function () {
    install({ failOn: /DELETE FROM llm_for_zotero_agent_transcript/ });
    let failure = "";
    await purgeAgentConversation(77, deps).catch((error) => {
      failure = String(error);
    });
    assert.include(failure, "disk I/O error");
    assert.isFalse(
      statements.some((sql) =>
        sql.startsWith("DELETE FROM llm_for_zotero_agent_tool_result_handles"),
      ),
    );
  });

  it("does nothing but clear Task progress without a database", async function () {
    statements = [];
    calls = [];
    globalScope.Zotero = {};
    await purgeAgentConversation(77, deps);
    assert.deepEqual(calls, ["clearTaskProgress:77", "statementsBefore:0"]);
    assert.deepEqual(statements, []);
  });
});
