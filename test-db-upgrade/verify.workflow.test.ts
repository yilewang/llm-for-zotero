/**
 * DB upgrade, verify phase: runs on the newer build against a copy of the
 * seed phase's data directory and profile prefs (see
 * scripts/run-db-upgrade-tests.mjs). It never calls api.reset() before its
 * checks, so the startup state it reads is the one the upgrade produced.
 *
 * LLM_FOR_ZOTERO_DB_UPGRADE_PHASE=verify (default): the full check, with one
 * live continuation per system (upstream, Claude Code, Codex) and a new
 * delete / Undo / sweep in each store. It then records the conversations it
 * left for an optional reverse phase.
 *
 * LLM_FOR_ZOTERO_DB_UPGRADE_PHASE=reverse: the older build reopens the DB the
 * newer build wrote. Read-only checks, no model calls.
 */
import { assert } from "chai";
import { resolveLiveAgentCredentials } from "../test-live-agent/liveAgentCredentials";
import {
  LIVE_MODEL_ENTRY_ID,
  describeError,
  ensureOwnZoteroHttpServer,
  env,
  persistenceSnapshot,
  readActivityDisclosures,
  readCatalogTitle,
  readStoredMessages,
  setPrefs,
  waitFor,
  workflowApi,
  type LiveSystem,
} from "../test-live-runtimes/runtimeLiveShared";
import {
  openHistoryConversation,
  readAgentRunRecord,
  readRecord,
  readStoredDebugOutput,
  recordConversation,
  rowsAnywhere,
  scanStartupLog,
  writeRecord,
  writeReport,
  type DbUpgradeRecord,
  type RecordedConversation,
} from "./dbUpgradeShared";

declare const Zotero: any;
declare const Services: any;

const phase = env("LLM_FOR_ZOTERO_DB_UPGRADE_PHASE") || "verify";
const reverse = phase === "reverse";
const CONTINUATION_PROMPT =
  "What was the exact MARK word you replied with earlier in this conversation? Reply with only that word.";

/** What a recorded conversation must look like after the startup sweep. */
function expected(record: DbUpgradeRecord, conversation: RecordedConversation) {
  const pendingTurn =
    !reverse &&
    record.pendingTurn.system === conversation.system &&
    record.pendingTurn.key === conversation.key;
  const texts = pendingTurn
    ? conversation.texts.filter(
        (entry) => !entry.text.includes(record.pendingTurn.marker),
      )
    : conversation.texts;
  return {
    texts,
    messageRows: conversation.snapshot.messageRows - (pendingTurn ? 2 : 0),
    pendingTurn,
    // A finalized turn deletion purges the conversation's agent state with
    // it (finalizeQueuedTurnDeletion, the same on main), so the run of the
    // turn that stays is gone too.
    agentRun: pendingTurn ? null : conversation.agentRun || null,
  };
}

describe(`DB upgrade ${phase} (${reverse ? "older" : "newer"} build)`, function () {
  this.timeout(900_000);
  let record: DbUpgradeRecord;
  const api = () => workflowApi();
  const report: Record<string, unknown> = { phase };

  async function guarded(name: string, task: () => Promise<void>) {
    try {
      await task();
    } catch (error) {
      assert.fail(`${name}: ${describeError(error)}`);
    }
  }

  async function openConversation(conversation: RecordedConversation) {
    setPrefs({ conversationSystem: conversation.system });
    const panel = await api().renderPanelForItem(record.paperItemId);
    let diag = await api().getDiagnostics(panel.panelId);
    assert.equal(diag.conversationSystem, conversation.system, "panel system");
    const wantGlobal = conversation.kind === "library";
    if (wantGlobal !== (diag.conversationKind === "global")) {
      diag = await api().togglePanelConversationMode(panel.panelId);
    }
    const opened = await openHistoryConversation(
      panel.panelId,
      conversation.key,
    );
    assert.isTrue(
      opened,
      `${conversation.label} opens from the history menu (${JSON.stringify({
        panelKey: (await api().getDiagnostics(panel.panelId)).conversationKey,
      })})`,
    );
    return panel;
  }

  before(async function () {
    // Codex and Claude Code call this instance's MCP endpoint over HTTP.
    await ensureOwnZoteroHttpServer();
    record = await readRecord();
    report.seedCommit = record.sourceCommit;
  });

  after(async function () {
    // The runner prints this file after the phase.
    await writeReport(phase, report);
  });

  it("starts without a transaction timeout or a store failure", async function () {
    await guarded("startup log", async () => {
      const findings = scanStartupLog(await readStoredDebugOutput());
      report.startupLog = findings;
      assert.isTrue(
        findings.storing && findings.lines > 0,
        `the runner turns on the Zotero debug store; ${JSON.stringify(findings)}`,
      );
      assert.isAbove(findings.startupPhases, 0, JSON.stringify(findings));
      assert.equal(findings.transactionTimeouts, 0, JSON.stringify(findings));
      assert.equal(findings.storeInitFailures, 0, JSON.stringify(findings));
      assert.equal(findings.deferredTaskFailures, 0, JSON.stringify(findings));
    });
  });

  (reverse ? it.skip : it)(
    "restores the paper's last conversation at startup",
    async function () {
      await guarded("startup restore", async () => {
        const panel = await api().renderStartupPanelForItem(record.paperItemId);
        const diag = await api().getDiagnostics(panel.panelId);
        report.startupRestore = {
          before: record.startupRestore,
          after: {
            system: diag.conversationSystem,
            kind: diag.conversationKind,
            key: diag.conversationKey,
          },
        };
        assert.equal(diag.conversationSystem, record.startupRestore.system);
        assert.equal(diag.conversationKind, record.startupRestore.kind);
        if (record.startupRestore.messageRows > 0) {
          assert.equal(
            diag.conversationKey,
            record.startupRestore.key,
            "the same stored conversation is restored",
          );
        }
      });
    },
  );

  it("the startup sweep finishes the deletions the older build queued", async function () {
    await guarded("startup sweep", async () => {
      const state = await waitFor(
        () => api().getPendingDeletionState(),
        (value) => value.persistedRowCount === 0,
        60_000,
        500,
      );
      report.pendingRowsAfterStartup = state.persistedRowCount;
      report.pendingRowsAtSeedEnd = record.pendingRowsAtEnd;
      assert.equal(state.persistedRowCount, 0, "no deletion stays queued");
      if (reverse) return;
      for (const deletion of [
        record.completedDeletion,
        record.pendingDeletion,
      ]) {
        const snapshot = await persistenceSnapshot(
          deletion.system,
          deletion.key,
        );
        assert.equal(
          snapshot.catalogRows +
            snapshot.messageRows +
            snapshot.searchIndexRows +
            snapshot.registryRows,
          0,
          `${deletion.marker} is gone: ${JSON.stringify(snapshot)}`,
        );
        assert.equal(await rowsAnywhere(deletion.key), 0, deletion.marker);
      }
      const turnRows = await readStoredMessages(
        record.pendingTurn.system,
        record.pendingTurn.key,
      );
      assert.isFalse(
        turnRows.some((row) => row.text.includes(record.pendingTurn.marker)),
        "the queued Claude turn is gone",
      );
      assert.isAbove(turnRows.length, 0, "the rest of that conversation stays");
    });
  });

  it("keeps every conversation's rows, title and texts", async function () {
    await guarded("rows", async () => {
      const mismatches: string[] = [];
      for (const conversation of record.conversations) {
        const want = expected(record, conversation);
        const snapshot = await persistenceSnapshot(
          conversation.system,
          conversation.key,
        );
        const was = conversation.snapshot;
        for (const [field, value] of [
          ["catalogRows", was.catalogRows],
          ["messageRows", want.messageRows],
          ["searchIndexRows", was.searchIndexRows],
          ["registryRows", was.registryRows],
        ] as const) {
          if (snapshot[field] !== value)
            mismatches.push(
              `${conversation.label} ${field} ${value} -> ${snapshot[field]}`,
            );
        }
        const title = await readCatalogTitle(
          conversation.system,
          conversation.key,
        );
        if (title !== conversation.title)
          mismatches.push(
            `${conversation.label} title ${JSON.stringify(conversation.title)} -> ${JSON.stringify(title)}`,
          );
        const texts = (
          await readStoredMessages(conversation.system, conversation.key)
        ).map((row) => ({ role: row.role, text: row.text }));
        if (JSON.stringify(texts) !== JSON.stringify(want.texts))
          mismatches.push(`${conversation.label} texts differ`);
        if (conversation.agentRun) {
          const run = await readAgentRunRecord(conversation.agentRun.runId);
          const wantRun = want.agentRun;
          if (
            wantRun
              ? !run ||
                run.events !== wantRun.events ||
                run.status !== wantRun.status
              : run !== null
          )
            mismatches.push(
              `${conversation.label} run ${JSON.stringify(conversation.agentRun)} -> ${JSON.stringify(run)}`,
            );
        }
      }
      report.rowMismatches = mismatches;
      assert.deepEqual(mismatches, [], "rows, titles and texts are unchanged");
      if (record.agentNoteId) {
        const note = Zotero.Items.get(record.agentNoteId);
        assert.isOk(note, "the Agent's note still exists");
        assert.equal(note.getNoteTitle(), record.agentNoteTitle);
      }
    });
  });

  it("opens every conversation with its messages, its activity and its search entry", async function () {
    await guarded("open", async () => {
      const opened: Record<string, unknown> = {};
      for (const conversation of record.conversations) {
        const want = expected(record, conversation);
        const panel = await openConversation(conversation);
        const visible = await waitFor(
          () => api().getPanelVisibleMessageCount(panel.panelId),
          (count) => count === want.messageRows,
        );
        assert.equal(
          visible,
          want.messageRows,
          `${conversation.label} shows its messages`,
        );
        if (want.agentRun) {
          const disclosures = await waitFor(
            async () => readActivityDisclosures(panel.panelId),
            (list) => list.some((text) => /^Worked for /.test(text)),
            15_000,
          );
          assert.isTrue(
            disclosures.some((text) => /^Worked for /.test(text)),
            `${conversation.label} shows the Agent's activity: ${JSON.stringify(disclosures)}`,
          );
        }
        const search = await waitFor(
          () => api().searchPanelHistory(panel.panelId, conversation.marker),
          (result) =>
            result.entries.some(
              (entry) => entry.conversationKey === conversation.key,
            ),
        );
        assert.include(
          search.entries.map((entry) => entry.conversationKey),
          conversation.key,
          `${conversation.label} is found by history search`,
        );
        opened[conversation.label] = visible;
      }
      report.opened = opened;
    });
  });

  const continued: Array<{ label: string; system: LiveSystem; key: number }> =
    [];

  (reverse ? it.skip : it)(
    "continues one conversation per system with a live turn",
    async function () {
      await guarded("continuation", async () => {
        const credentials = await resolveLiveAgentCredentials();
        assert.isOk(credentials, "live credentials must be configured");
        const answers: Record<string, string> = {};
        for (const label of [
          "upstream-paper",
          "claude_code-paper",
          "codex-paper",
        ]) {
          const conversation = record.conversations.find(
            (entry) => entry.label === label,
          )!;
          const panel = await openConversation(conversation);
          if (conversation.system === "upstream") {
            await api().selectPanelModelEntry(
              panel.panelId,
              LIVE_MODEL_ENTRY_ID,
            );
            const diag = await api().getDiagnostics(panel.panelId);
            if (diag.runtimeMode === "agent")
              await api().clickPanelRuntimeModeToggle(panel.panelId);
          }
          const turn = await api().sendLiveChatTurn(
            panel.panelId,
            CONTINUATION_PROMPT,
            300_000,
          );
          answers[label] = turn.answerText.slice(0, 200);
          assert.equal(
            (await api().getDiagnostics(panel.panelId)).conversationKey,
            conversation.key,
            `${label} continues in the same conversation`,
          );
          assert.include(
            turn.answerText,
            conversation.marker,
            `${label} remembers its marker across the upgrade`,
          );
          continued.push({
            label,
            system: conversation.system,
            key: conversation.key,
          });
        }
        report.continuations = answers;
      });
    },
  );

  (reverse ? it.skip : it)(
    "deletes, undoes and sweeps in all three stores",
    async function () {
      await guarded("delete lifecycle", async () => {
        assert.lengthOf(continued, 3, "the continuation step ran first");
        for (const entry of continued) {
          const conversation = record.conversations.find(
            (item) => item.label === entry.label,
          )!;
          const panel = await openConversation(conversation);
          const rows = await readStoredMessages(entry.system, entry.key);
          const count = await api().getPanelVisibleMessageCount(panel.panelId);
          assert.equal(count, rows.length, `${entry.label} shows every row`);
          await api().deletePanelTurn(
            panel.panelId,
            rows[rows.length - 2].timestamp,
            rows[rows.length - 1].timestamp,
          );
          assert.equal(
            await waitFor(
              () => api().getPanelVisibleMessageCount(panel.panelId),
              (value) => value === count - 2,
            ),
            count - 2,
            `${entry.label} hides the queued turn`,
          );
          await api().clickPanelUndo(panel.panelId);
          assert.equal(
            await waitFor(
              () => api().getPanelVisibleMessageCount(panel.panelId),
              (value) => value === count,
            ),
            count,
            `${entry.label} Undo restores the turn`,
          );
          await api().startNewPanelConversation(panel.panelId);
          await api().deletePanelHistoryConversation(panel.panelId, entry.key);
          await api().sweepPendingDeletionsAsRestart();
          const gone = await persistenceSnapshot(entry.system, entry.key);
          assert.equal(
            gone.catalogRows +
              gone.messageRows +
              gone.searchIndexRows +
              gone.registryRows +
              gone.pendingDeletionRows,
            0,
            `${entry.label} is deleted: ${JSON.stringify(gone)}`,
          );
        }
      });
    },
  );

  (reverse ? it.skip : it)(
    "records the remaining conversations for the reverse phase",
    async function () {
      await guarded("record", async () => {
        const removed = new Set(continued.map((entry) => entry.key));
        const remaining: RecordedConversation[] = [];
        for (const conversation of record.conversations) {
          if (removed.has(conversation.key)) continue;
          remaining.push(
            await recordConversation({
              label: conversation.label,
              system: conversation.system,
              kind: conversation.kind,
              key: conversation.key,
              marker: conversation.marker,
            }),
          );
        }
        await writeRecord({
          ...record,
          phase: "verify",
          writtenAt: Date.now(),
          sourceCommit: env("LLM_FOR_ZOTERO_DB_UPGRADE_COMMIT"),
          conversations: remaining,
          pendingRowsAtEnd: (await api().getPendingDeletionState())
            .persistedRowCount,
        });
        Services.prefs.savePrefFile(null);
        report.remaining = remaining.length;
      });
    },
  );
});
