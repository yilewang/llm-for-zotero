/**
 * DB upgrade, seed phase: runs on the older build (main) in a fresh profile
 * and leaves conversations of every system and kind behind, plus one
 * completed and two pending deletions, then records them in the data
 * directory for the verify phase. Run it through
 * scripts/run-db-upgrade-tests.mjs, never on its own: prefs are left set on
 * purpose, because the next phase starts from a copy of this profile.
 *
 * Live turns: upstream 3 (2 chat + 1 Agent), Claude Code 2, Codex 2.
 */
import { assert } from "chai";
import { resolveLiveAgentCredentials } from "../test-live-agent/liveAgentCredentials";
import {
  LIVE_MODEL_ENTRY_ID,
  approveCardsUntil,
  describeError,
  ensureOwnZoteroHttpServer,
  env,
  liveRuntimePrefs,
  persistenceSnapshot,
  randomTag,
  readStoredMessages,
  setPrefs,
  shortSystemName,
  switchPanelToLibraryChat,
  workflowApi,
  type ApprovedCard,
  type LiveKind,
  type LiveSystem,
} from "../test-live-runtimes/runtimeLiveShared";
import {
  readLastUsedPrefs,
  recordConversation,
  writeRecord,
  type DbUpgradeRecord,
  type RecordedConversation,
} from "./dbUpgradeShared";

declare const Zotero: any;
declare const Services: any;

describe("DB upgrade seed (older build)", function () {
  this.timeout(900_000);
  const tag = randomTag();
  const conversations: RecordedConversation[] = [];
  const state: {
    credentials: Awaited<ReturnType<typeof resolveLiveAgentCredentials>>;
    paperItemId: number;
    collectionId: number;
    agentNoteId: number;
    agentNoteTitle: string;
    completedDeletion?: DbUpgradeRecord["completedDeletion"];
  } = {
    credentials: null,
    paperItemId: 0,
    collectionId: 0,
    agentNoteId: 0,
    agentNoteTitle: "",
  };
  const api = () => workflowApi();
  const prefsFor = (system: LiveSystem, extra: Record<string, unknown> = {}) =>
    liveRuntimePrefs(system, state.credentials!, {
      enableAgentMode: true,
      originalAgentPermissionMode: "auto",
      claudeCodePermissionMode: "default",
      ...extra,
    });

  async function openPanel(system: LiveSystem, kind: LiveKind) {
    setPrefs(prefsFor(system));
    const panel = await api().renderPanelForItem(state.paperItemId);
    let diag = await api().getDiagnostics(panel.panelId);
    assert.equal(diag.conversationSystem, system, "panel system");
    if (kind === "library") {
      diag = await switchPanelToLibraryChat(panel.panelId);
    }
    assert.equal(
      diag.conversationKind,
      kind === "library" ? "global" : "paper",
      "panel kind",
    );
    if (system === "upstream") {
      await api().selectPanelModelEntry(panel.panelId, LIVE_MODEL_ENTRY_ID);
    }
    return panel;
  }

  async function markerTurn(
    panelId: string,
    system: LiveSystem,
    kind: LiveKind,
  ): Promise<{ key: number; marker: string }> {
    const marker = `MARK-${shortSystemName(system)}-${kind}-${tag}`;
    const turn = await api().sendLiveChatTurn(
      panelId,
      `Reply with exactly ${marker}`,
      300_000,
    );
    assert.include(turn.answerText, marker, `${system} ${kind} marker turn`);
    const key = Number((await api().getDiagnostics(panelId)).conversationKey);
    assert.isAbove(key, 0);
    return { key, marker };
  }

  async function guarded(name: string, task: () => Promise<void>) {
    try {
      await task();
    } catch (error) {
      assert.fail(`${name}: ${describeError(error)}`);
    }
  }

  it("prepares a paper, a collection and the live prefs", async function () {
    await guarded("prepare", async () => {
      state.credentials = await resolveLiveAgentCredentials();
      assert.isOk(state.credentials, "live credentials must be configured");
      // Codex and Claude Code call this instance's MCP endpoint over HTTP.
      await ensureOwnZoteroHttpServer();
      await api().reset();
      setPrefs(prefsFor("upstream"));
      const fixture = await api().createPaperWithPdfFixture({
        title: `DB upgrade paper ${tag}`,
        pdfTitle: `db-upgrade-${tag}.pdf`,
        pages: [
          "This synthetic page exists so the panel has a paper to open across an upgrade.",
        ],
      });
      state.paperItemId = fixture.parentItemId;
      const collection = new Zotero.Collection();
      collection.libraryID = Zotero.Libraries.userLibraryID;
      collection.name = `DB upgrade folder ${tag}`;
      await collection.saveTx();
      state.collectionId = collection.id;
      const paper = Zotero.Items.get(state.paperItemId);
      paper.addToCollection(collection.id);
      await paper.saveTx();
    });
  });

  it("upstream paper: two live chat turns", async function () {
    await guarded("upstream paper", async () => {
      const panel = await openPanel("upstream", "paper");
      const { key, marker } = await markerTurn(
        panel.panelId,
        "upstream",
        "paper",
      );
      const second = await api().sendLiveChatTurn(
        panel.panelId,
        "Repeat the word you said before.",
        300_000,
      );
      assert.include(second.answerText, marker, "turn 2 remembers the marker");
      conversations.push(
        await recordConversation({
          label: "upstream-paper",
          system: "upstream",
          kind: "paper",
          key,
          marker,
        }),
      );
    });
  });

  it("upstream paper: a seeded, titled conversation and a completed deletion", async function () {
    await guarded("seeded + D1", async () => {
      const panel = await openPanel("upstream", "paper");
      await api().startNewPanelConversation(panel.panelId);
      const titleMarker = `SEEDTITLE-${tag}`;
      const seeded = await api().seedPanelStoredTurn(
        panel.panelId,
        `${titleMarker} what does the seeded note say`,
        `The seeded answer for ${tag}.`,
      );
      conversations.push(
        await recordConversation({
          label: "upstream-seeded",
          system: "upstream",
          kind: "paper",
          key: seeded.conversationKey,
          marker: titleMarker,
        }),
      );
      await api().startNewPanelConversation(panel.panelId);
      const doomedMarker = `D1-${tag}`;
      const doomed = await api().seedPanelStoredTurn(
        panel.panelId,
        `${doomedMarker} this conversation is deleted before the upgrade`,
        "Deleted answer.",
      );
      await api().startNewPanelConversation(panel.panelId);
      await api().deletePanelHistoryConversation(
        panel.panelId,
        doomed.conversationKey,
      );
      await api().sweepPendingDeletionsAsRestart();
      const gone = await persistenceSnapshot(
        "upstream",
        doomed.conversationKey,
      );
      assert.equal(
        gone.catalogRows + gone.messageRows,
        0,
        JSON.stringify(gone),
      );
      state.completedDeletion = {
        system: "upstream",
        key: doomed.conversationKey,
        marker: doomedMarker,
      };
    });
  });

  it("upstream library: an Agent turn creates a note", async function () {
    await guarded("upstream agent", async () => {
      const panel = await openPanel("upstream", "library");
      let diag = await api().getDiagnostics(panel.panelId);
      if (diag.runtimeMode !== "agent") {
        diag = await api().clickPanelRuntimeModeToggle(panel.panelId);
      }
      assert.equal(diag.runtimeMode, "agent", "Agent mode is on");
      const marker = `SEEDNOTE-${tag}`;
      const approved: ApprovedCard[] = [];
      await approveCardsUntil(
        panel.panelId,
        api().sendLiveChatTurn(
          panel.panelId,
          `Create a standalone Zotero note titled "${marker}" with one sentence saying that it was written before an upgrade.`,
          600_000,
        ),
        approved,
      );
      const key = Number(
        (await api().getDiagnostics(panel.panelId)).conversationKey,
      );
      const notes = (await Zotero.DB.queryAsync(
        "SELECT itemID FROM itemNotes WHERE title LIKE ?",
        [`%${marker}%`],
      )) as any[];
      assert.isAtLeast(notes.length, 1, "the Agent turn created the note");
      state.agentNoteId = Number(notes[0].itemID);
      state.agentNoteTitle = String(
        Zotero.Items.get(state.agentNoteId)?.getNoteTitle() || "",
      );
      const recorded = await recordConversation({
        label: "upstream-library-agent",
        system: "upstream",
        kind: "library",
        key,
        marker,
      });
      assert.isOk(recorded.agentRun, "the Agent answer has a run");
      assert.isAbove(recorded.agentRun!.events, 0, "the run has a trace");
      conversations.push(recorded);
      // Later upstream chats in this profile are plain chat again.
      await api().clickPanelRuntimeModeToggle(panel.panelId);
    });
  });

  for (const system of ["claude_code", "codex"] as LiveSystem[]) {
    it(`${system}: paper and library marker turns`, async function () {
      await guarded(system, async () => {
        const panel = await openPanel(system, "paper");
        const paper = await markerTurn(panel.panelId, system, "paper");
        conversations.push(
          await recordConversation({
            label: `${system}-paper`,
            system,
            kind: "paper",
            ...paper,
          }),
        );
        const diag = await switchPanelToLibraryChat(panel.panelId);
        assert.equal(diag.conversationKind, "global", "library chat");
        const library = await markerTurn(panel.panelId, system, "library");
        conversations.push(
          await recordConversation({
            label: `${system}-library`,
            system,
            kind: "library",
            ...library,
          }),
        );
      });
    });
  }

  it("queues a conversation deletion and a Claude turn deletion, then records everything", async function () {
    await guarded("pending deletions", async () => {
      // Prepare both targets first: each queued deletion finalizes by itself
      // six seconds later, so the queueing and the end of the run are kept
      // close together. The runner checks the copied DB for both rows.
      const upstreamPanel = await openPanel("upstream", "paper");
      // The panel may reopen the empty draft the D1 step ended on.
      await api().startNewPanelConversation(upstreamPanel.panelId, {
        allowReusedDraft: true,
      });
      const pendingMarker = `D2-${tag}`;
      const pending = await api().seedPanelStoredTurn(
        upstreamPanel.panelId,
        `${pendingMarker} this deletion is still pending at the upgrade`,
        "Pending answer.",
      );
      await api().startNewPanelConversation(upstreamPanel.panelId);

      const claudePanel = await openPanel("claude_code", "library");
      const claudeLibrary = conversations.find(
        (entry) => entry.label === "claude_code-library",
      )!;
      assert.equal(
        (await api().getDiagnostics(claudePanel.panelId)).conversationKey,
        claudeLibrary.key,
        "the Claude library panel reopens the recorded conversation",
      );
      const turnMarker = `PENDTURN-${tag}`;
      const turn = await api().seedPanelStoredTurn(
        claudePanel.panelId,
        `${turnMarker} question whose turn is deleted at the upgrade`,
        `${turnMarker} answer`,
      );
      // The record keeps the Claude library conversation with the turn; the
      // verify phase expects it without.
      const index = conversations.indexOf(claudeLibrary);
      conversations[index] = await recordConversation({
        label: claudeLibrary.label,
        system: "claude_code",
        kind: "library",
        key: claudeLibrary.key,
        marker: claudeLibrary.marker,
      });

      await api().deletePanelHistoryConversation(
        upstreamPanel.panelId,
        pending.conversationKey,
      );
      await api().deletePanelTurn(
        claudePanel.panelId,
        turn.userTimestamp,
        turn.assistantTimestamp,
      );
      const pendingRows = (await api().getPendingDeletionState())
        .persistedRowCount;

      const restored = await api().renderStartupPanelForItem(state.paperItemId);
      const restoredDiag = await api().getDiagnostics(restored.panelId);
      const restoredSystem = (restoredDiag.conversationSystem ||
        "upstream") as LiveSystem;
      const restoredKey = Number(restoredDiag.conversationKey || 0);
      const restoredRows = restoredKey
        ? (await readStoredMessages(restoredSystem, restoredKey)).length
        : 0;

      const record: DbUpgradeRecord = {
        version: 1,
        phase: "seed",
        writtenAt: Date.now(),
        sourceCommit: env("LLM_FOR_ZOTERO_DB_UPGRADE_COMMIT"),
        libraryID: Zotero.Libraries.userLibraryID,
        paperItemId: state.paperItemId,
        collectionId: state.collectionId,
        agentNoteId: state.agentNoteId,
        agentNoteTitle: state.agentNoteTitle,
        conversations,
        completedDeletion: state.completedDeletion!,
        pendingDeletion: {
          system: "upstream",
          key: pending.conversationKey,
          marker: pendingMarker,
        },
        pendingTurn: {
          system: "claude_code",
          key: claudeLibrary.key,
          marker: turnMarker,
          userTimestamp: turn.userTimestamp,
          assistantTimestamp: turn.assistantTimestamp,
        },
        pendingRowsAtEnd: pendingRows,
        startupRestore: {
          system: restoredSystem,
          kind: String(restoredDiag.conversationKind || ""),
          key: restoredKey,
          messageRows: restoredRows,
        },
        lastUsedPrefs: readLastUsedPrefs(),
      };
      await writeRecord(record);
      Services.prefs.savePrefFile(null);
      assert.equal(pendingRows, 2, "both deletions are queued at the end");
    });
  });
});
