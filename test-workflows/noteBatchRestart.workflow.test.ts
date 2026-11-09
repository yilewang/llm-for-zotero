/**
 * A note batch cut short by a real end of the Zotero process, then continued
 * in a new process. Two processes: the `crash` (SIGKILL aimed at the test
 * Zotero's own process id) or `quit` (forced quit) phase writes notes in one
 * note_write_batch and ends the process while it writes; the `resume` phase
 * starts a new Zotero on a copy of that data folder, the user trashes one of
 * the journaled notes, and "continue" finishes the job.
 * `npm run test:note-batch-restart` runs both pairs
 * (scripts/run-note-batch-restart-test.mjs); in an ordinary run
 * NOTE_BATCH_RESTART_PHASE is unset and these tests do nothing.
 * NOTE_BATCH_RESTART_KILL_AFTER (`--first` in the runner) ends the process
 * during the first note instead, before any row names a written note.
 * NOTE_BATCH_RESTART_TAMPER (`--absent`, `--changed`) erases or trashes the
 * note in flight before "continue"; NOTE_BATCH_RESTART_UNDO (`--undo`) undoes
 * the batch's action once the resume ends. `--undo-during-card` undoes the
 * interrupted action while the Safe-mode confirmation card of "continue" is
 * pending. NOTE_BATCH_RESTART_TARGET=standalone (`--standalone`,
 * `--standalone-undo-first`, `--standalone-moved`) writes standalone notes
 * filed into the folder, each citing its paper.
 *
 * Every variant of `npm run test:note-batch-restart`:
 * - (none): killed during the 12th note; continue keeps the note in flight.
 * - `--quit`: the same, ended by a forced quit.
 * - `--first`: killed during the first note.
 * - `--absent`: the note in flight is erased before "continue".
 * - `--changed`: the note in flight is trashed, then restored.
 * - `--undo`: the batch's action is undone after "continue".
 * - `--undo-first`: the interrupted batch is undone before "continue".
 * - `--undo-during-card`: undone while the Safe-mode card is open.
 * - `--standalone`: standalone notes; a cited paper is edited first.
 * - `--standalone-undo-first`: standalone notes, undone before "continue".
 * - `--standalone-moved`: the standalone note in flight leaves its folder.
 * - `--legacy`: pre-upgrade data (steps record no row; unwritten rows name
 *   no action) of a child batch.
 * - `--legacy --first`: pre-upgrade data killed during the first note, so
 *   no row names any action.
 * - `--legacy-first-unlanded`: the same, but the first note never landed
 *   (erased before "continue"), so an old step holds nothing at its key;
 *   row 1 is written once, none is refused, and a second continue changes
 *   nothing.
 * - `--legacy-standalone`: pre-upgrade data of standalone notes.
 * - `--legacy-standalone-edited`: the same with a cited paper edited, so
 *   the old step matches no row; then the note is erased and a second
 *   continue writes the rows and settles the step.
 * - `--legacy-twice`: two notes a paper, killed during a second note,
 *   with the paper's first note erased.
 * - `--legacy-undo-first`: pre-upgrade data, undone before "continue".
 * - `--legacy-unnamed-action`: the first attempt is undone, and a
 *   pre-upgrade continue under a second action, which no row names, was
 *   killed during its first note.
 */
import "./hostSurfaceBootstrap";
import { assert } from "chai";
import { resolvedAgentRequest } from "../test/helpers/resolvedAgentRequest";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { innermostToolResult } from "../src/agent/contracts/toolResultEnvelope";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import type { AgentToolContext } from "../src/agent/types";
import { INTERRUPTED_AGENT_RUN_MARKER } from "../src/agent/store/traceStore";
import {
  initAgentChangeJournal,
  listJournalActions,
} from "../src/agent/store/changeJournal";
import {
  initAgentBatchItemStore,
  listBatchItems,
  listResumableBatches,
} from "../src/agent/store/batchItemStore";
import { readRecoveryText } from "../src/agent/store/journalRecoveryBlobStore";
import { loadPlanDocument } from "../src/agent/documents/store";
import { documentNoteParts } from "../src/agent/documents/actions";
import { mergeNoteCitationItems } from "../src/utils/noteCitations";
import { noteHtmlMatches } from "../src/utils/noteHtml";
import { findUncertainNoteStepForRow } from "../src/agent/services/noteCreation";
import {
  getOriginalAgentPermissionMode,
  setOriginalAgentPermissionMode,
} from "../src/agent/originalAgentPermissionMode";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

declare const Zotero: any;

const PAPER_COUNT = 30;
const DEFAULT_KILL_AFTER_NOTES = 12;

function restartPhase(): string {
  return String(
    (globalThis as any).Services?.env?.get?.("NOTE_BATCH_RESTART_PHASE") || "",
  );
}

const TAMPER_MODES = [
  "absent",
  "changed",
  "undo-first",
  "undo-during-card",
  "moved",
  "legacy",
  "legacy-edited",
  "legacy-twice",
  "legacy-undo-first",
  "legacy-first",
  "legacy-first-unlanded",
  "legacy-unnamed-action",
] as const;
type TamperMode = "" | (typeof TAMPER_MODES)[number];

function tamperMode(): TamperMode {
  const value = String(
    (globalThis as any).Services?.env?.get?.("NOTE_BATCH_RESTART_TAMPER") || "",
  );
  return (TAMPER_MODES as readonly string[]).includes(value)
    ? (value as TamperMode)
    : "";
}

/** Modes that rewrite the data to its pre-upgrade shape before "continue". */
function legacyMode(mode: TamperMode): boolean {
  return mode.startsWith("legacy");
}

function notesPerPaper(): 1 | 2 {
  return String(
    (globalThis as any).Services?.env?.get?.(
      "NOTE_BATCH_RESTART_NOTES_PER_PAPER",
    ) || "",
  ) === "2"
    ? 2
    : 1;
}

/** The refusal a row gets while the note an interrupted attempt left is live. */
const heldNoteReason = (noteId: number) =>
  `A note from the interrupted attempt (note ${noteId}) is still in the library; this item was not rewritten.`;

/** The refusal a row gets while that note is in the trash. */
const trashedNoteReason = (noteId: number) =>
  `A note from the interrupted attempt (note ${noteId}) is in the trash; this item was not rewritten.`;

/** The refusal a row gets when an old step's note cannot be tied to one row. */
const untiedNoteReason = (noteId: number) =>
  `Note ${noteId} from the interrupted attempt may be this item's note; I cannot tell which item it belongs to, so I did not write this item. If note ${noteId} is not this item's note, delete it permanently and continue.`;

function standaloneTarget(): boolean {
  return (
    String(
      (globalThis as any).Services?.env?.get?.("NOTE_BATCH_RESTART_TARGET") ||
        "",
    ) === "standalone"
  );
}

function undoAfterResume(): boolean {
  return Boolean(
    (globalThis as any).Services?.env?.get?.("NOTE_BATCH_RESTART_UNDO"),
  );
}

function killAfterNotes(): number {
  const value = Number(
    (globalThis as any).Services?.env?.get?.("NOTE_BATCH_RESTART_KILL_AFTER") ||
      DEFAULT_KILL_AFTER_NOTES,
  );
  return Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_KILL_AFTER_NOTES;
}

type Record = {
  folderId: number;
  folderName: string;
  ids: number[];
  titles: string[];
  conversationKey: number;
  variant: string;
  killAfterNotes: number;
  target?: "item" | "standalone";
  notesPerPaper?: 1 | 2;
};

describe("workflow: note batch across a Zotero restart", function () {
  this.timeout(300000);

  const recordPath = () =>
    PathUtils.join(Zotero.DataDirectory.dir, "note-batch-restart-record.json");
  const api = () =>
    (Zotero as any).LLMForZotero.api.workflowTest as WorkflowTestApi;

  async function waitForStartup(): Promise<void> {
    await Zotero.initializationPromise;
    await Zotero.uiReadyPromise;
    for (
      let waited = 0;
      waited < 100 && !Zotero.LLMForZotero?.api?.workflowTest;
      waited += 1
    )
      await Zotero.Promise.delay(100);
    await initAgentChangeJournal();
    // This file's own copy of the row store reads the plugin's table.
    await initAgentBatchItemStore();
    await Zotero.Promise.delay(1000);
  }

  /** Erases the papers, folder and panel this test made. */
  async function cleanUp(record: Record, panelId: string) {
    for (const noteId of Zotero.Collections.get(record.folderId)?.getChildItems(
      true,
      true,
    ) || []) {
      const note = Zotero.Items.get(noteId);
      if (note?.isNote() && !note.parentID)
        await note.eraseTx().catch(() => undefined);
    }
    for (const id of record.ids) {
      const paper = Zotero.Items.get(id);
      if (!paper) continue;
      for (const noteId of paper.getNotes(true))
        await Zotero.Items.get(noteId)
          ?.eraseTx()
          .catch(() => undefined);
      await paper.eraseTx().catch(() => undefined);
    }
    await Zotero.Collections.get(record.folderId)
      ?.eraseTx()
      .catch(() => undefined);
    await api()
      .clickPanelDelete(panelId)
      .catch(() => undefined);
    await IOUtils.remove(recordPath()).catch(() => undefined);
  }

  /** Undoes one journal action through the real undo tool, approving its cards. */
  async function undoAction(record: Record, actionId: string) {
    const libraryID = Zotero.Libraries.userLibraryID;
    const key = record.conversationKey;
    const undoRequest = resolvedAgentRequest({
      conversationKey: key,
      mode: "agent",
      userText: "Undo the notes",
      libraryID,
      executionContext: {
        version: 1,
        executionId: `note-batch-restart-undo:${key}`,
        conversationKey: key,
        conversationGeneration: 0,
        chatLibraryID: libraryID,
        permissionOwner: "original_agent",
        workspaceSnapshot: { selectedPapers: [], selectedCollections: [] },
        configuredAccess: {
          libraryIDs: [libraryID],
          outputDirectories: [],
        },
      },
    });
    const undoContext = {
      request: undoRequest,
      item: null,
      modelName: "workflow",
      currentAnswerText: "",
      runId: `note-batch-restart-undo-run:${key}`,
    } as AgentToolContext;
    const registry = new AgentToolRegistry(
      new ActionContractService(new ZoteroGateway()),
    );
    registry.register(
      (Zotero as any).LLMForZotero.api.agent.getToolDefinition("undo"),
    );
    let prepared = await registry.prepareExecution(
      {
        id: "undo-batch",
        name: "undo",
        arguments: { actionIds: [actionId] },
      },
      undoContext,
      { callerKind: "model" },
    );
    for (let cards = 0; prepared.kind === "confirmation"; cards += 1) {
      assert.isBelow(cards, 4, "too many cards");
      prepared = await prepared.execute({ approved: true });
    }
    if (prepared.kind !== "result") throw new Error("unreachable");
    const undone = innermostToolResult(prepared.execution.result.content) as {
      reverted: number;
      conflicts: unknown[];
    };
    const undoReport = JSON.stringify(prepared.execution.result.content);
    return { undone, undoReport };
  }

  /**
   * "Continue" through the real note_write_batch tool in Safe mode: while
   * its confirmation card is pending, the user undoes `undoActionId`; then
   * the card is approved.
   */
  async function continueWithUndoDuringCard(
    record: Record,
    resumeBatchId: string,
    undoActionId: string,
  ) {
    const libraryID = Zotero.Libraries.userLibraryID;
    const key = record.conversationKey;
    const request = resolvedAgentRequest({
      conversationKey: key,
      mode: "agent",
      userText: "continue",
      libraryID,
      executionContext: {
        version: 1,
        executionId: `note-batch-restart-continue:${key}`,
        conversationKey: key,
        conversationGeneration: 0,
        chatLibraryID: libraryID,
        permissionOwner: "original_agent",
        workspaceSnapshot: { selectedPapers: [], selectedCollections: [] },
        configuredAccess: {
          libraryIDs: [libraryID],
          outputDirectories: [],
        },
      },
    });
    const context = {
      request,
      item: null,
      modelName: "workflow",
      currentAnswerText: "",
      runId: `note-batch-restart-continue-run:${key}`,
    } as AgentToolContext;
    const registry = new AgentToolRegistry(
      new ActionContractService(new ZoteroGateway()),
    );
    registry.register(
      (Zotero as any).LLMForZotero.api.agent.getToolDefinition(
        "note_write_batch",
      ),
    );
    const previousMode = getOriginalAgentPermissionMode();
    setOriginalAgentPermissionMode("safe");
    try {
      let prepared = await registry.prepareExecution(
        {
          id: "continue-batch",
          name: "note_write_batch",
          arguments: { resumeBatchId },
        },
        context,
        { callerKind: "model" },
      );
      assert.equal(
        prepared.kind,
        "confirmation",
        "Safe mode asks before the batch continues",
      );
      // The card is open: the user undoes the interrupted action now.
      const undo = await undoAction(record, undoActionId);
      for (let cards = 0; prepared.kind === "confirmation"; cards += 1) {
        assert.isBelow(cards, 4, "too many cards");
        prepared = await prepared.execute({ approved: true });
      }
      if (prepared.kind !== "result") throw new Error("unreachable");
      return {
        undo,
        report: JSON.stringify(prepared.execution.result.content),
      };
    } finally {
      setOriginalAgentPermissionMode(previousMode);
    }
  }

  /** The batch's rows as stored, read straight from the table. */
  async function rowsOf(batchId: string) {
    const rows = (await Zotero.DB.queryAsync(
      `SELECT item_key, status, action_id, step_sequence, note_id, error
       FROM llm_for_zotero_agent_batch_items WHERE batch_id = ?`,
      [batchId],
    )) as any[];
    // A result row throws on a property it does not hold (its JSON form
    // included), so each is read into a plain object.
    return rows.map((row) => ({
      itemKey: String(row.item_key),
      status: String(row.status),
      actionId: row.action_id === null ? null : String(row.action_id),
      stepSequence:
        row.step_sequence === null ? null : Number(row.step_sequence),
      noteId: row.note_id === null ? null : Number(row.note_id),
      error: String(row.error || ""),
    }));
  }

  /** "Continue" in the panel, the scripted model resuming the named batch. */
  function resumeFromPanel(record: Record, panelId: string) {
    return api().resumeNoteBatchAfterRestart({
      panelId,
      collection: {
        collectionId: record.folderId,
        name: record.folderName,
        libraryID: Zotero.Libraries.userLibraryID,
      },
      papers: record.ids.map((itemId, index) => ({
        itemId,
        title: record.titles[index],
      })),
      inputTokenCap: 2_000_000,
      rewritePapers: [],
    });
  }

  const liveNotesOf = (paperId: number): Zotero.Item[] =>
    Zotero.Items.get(paperId)
      .getNotes()
      .map((noteId: number) => Zotero.Items.get(noteId))
      .filter((note: Zotero.Item) => !note.deleted);

  async function firstPhase(variant: "crash" | "quit") {
    await waitForStartup();
    assert.match(
      Zotero.DataDirectory.dir,
      /[/\\]\.scaffold[/\\]test[/\\]data[/\\]?$/,
      "only the disposable test data folder is killed",
    );
    const libraryID = Zotero.Libraries.userLibraryID;
    const folder = new Zotero.Collection();
    folder.libraryID = libraryID;
    folder.name = `Note batch restart ${Date.now()}`;
    await folder.saveTx();
    const ids: number[] = [];
    const titles: string[] = [];
    for (let index = 1; index <= PAPER_COUNT; index += 1) {
      const paper = new Zotero.Item("journalArticle");
      paper.libraryID = libraryID;
      paper.setField("title", `Restart batch paper ${index}`);
      paper.setCollections([folder.id]);
      await paper.saveTx();
      ids.push(paper.id);
      titles.push(`Restart batch paper ${index}`);
    }
    const panel = await api().renderPanelForItem(ids[0]);
    const conversationKey = api().getPanelConversationKey({
      panelId: panel.panelId,
    });
    const record: Record = {
      folderId: folder.id,
      folderName: folder.name,
      ids,
      titles,
      conversationKey,
      variant,
      killAfterNotes: killAfterNotes(),
      target: standaloneTarget() ? "standalone" : "item",
      notesPerPaper: notesPerPaper(),
    };
    await IOUtils.writeUTF8(recordPath(), JSON.stringify(record));
    const survived = await api().startNoteBatchUntilQuit({
      panelId: panel.panelId,
      collection: {
        collectionId: folder.id,
        name: folder.name,
        libraryID,
      },
      papers: ids.map((itemId, index) => ({ itemId, title: titles[index] })),
      inputTokenCap: 2_000_000,
      killAfterNotes: record.killAfterNotes,
      variant,
      target: record.target,
      notesPerPaper: record.notesPerPaper,
    });
    assert.fail(`Zotero was not ended: ${JSON.stringify(survived)}`);
  }

  it("crash phase: Zotero is killed while a 30-note batch writes", async function () {
    if (restartPhase() !== "crash") this.skip();
    await firstPhase("crash");
  });

  it("quit phase: Zotero is force-quit while a 30-note batch writes", async function () {
    if (restartPhase() !== "quit") this.skip();
    await firstPhase("quit");
  });

  it("resume phase: continue finishes the batch with one live note a paper and one receipt a noted paper", async function () {
    if (restartPhase() !== "resume" || tamperMode() || standaloneTarget())
      this.skip();
    await waitForStartup();
    const record = JSON.parse(await IOUtils.readUTF8(recordPath())) as Record;
    const { ids } = record;
    const KILL_AFTER_NOTES = record.killAfterNotes ?? DEFAULT_KILL_AFTER_NOTES;
    const libraryID = Zotero.Libraries.userLibraryID;
    const liveNotes = (paperId: number): Zotero.Item[] =>
      Zotero.Items.get(paperId)
        .getNotes()
        .map((noteId: number) => Zotero.Items.get(noteId))
        .filter((note: Zotero.Item) => !note.deleted);

    // A new process holds the data the first one left.
    const written = ids.filter((id) => liveNotes(id).length > 0);
    console.log(
      `Note batch restart (${record.variant}): ${written.length} of ${ids.length} notes at the restart`,
    );
    assert.isAtLeast(written.length, KILL_AFTER_NOTES);
    assert.isBelow(written.length, ids.length, "the batch was cut short");
    for (const id of written) assert.lengthOf(liveNotes(id), 1);

    // The plugin's startup did not lose the conversation.
    const panel = await api().renderPanelForItem(ids[0]);
    assert.equal(
      api().getPanelConversationKey({ panelId: panel.panelId }),
      record.conversationKey,
      "the conversation key is the same in the new process",
    );

    // The papers whose create_note step reached "applied" before the end.
    // The note being written when the process ended exists in Zotero but its
    // step is still open; the batch resume finishes that step.
    const landedPapers = new Set<number>();
    // The step of the note in flight: its key was reserved before the save.
    const openSteps: Array<{
      actionId: string;
      stepId: string;
      paper: number;
      key: string;
    }> = [];
    for (const action of await listJournalActions({
      conversationKey: record.conversationKey,
      limit: 500,
    }))
      for (const step of action.steps) {
        if (step.operation !== "create_note") continue;
        const forward = JSON.parse(step.forwardJson);
        if (step.status === "applied") landedPapers.add(forward.parentItemId);
        if (step.status === "uncertain")
          openSteps.push({
            actionId: action.actionId,
            stepId: step.stepId,
            paper: forward.parentItemId,
            key: forward.key,
          });
      }
    assert.isAtLeast(landedPapers.size, KILL_AFTER_NOTES - 1);
    assert.isAtMost(written.length - landedPapers.size, 1);
    for (const id of landedPapers) assert.include(written, id);
    // Each note in Zotero without an applied step is the in-flight one, and
    // its open step names it by the key it reserved.
    const inFlight = written.filter((id) => !landedPapers.has(id));
    assert.lengthOf(openSteps, inFlight.length, JSON.stringify(openSteps));
    // A kill inside the note's own save always leaves its step open, so the
    // crash variant always exercises the settling of that step.
    if (record.variant === "crash")
      assert.lengthOf(openSteps, 1, JSON.stringify(openSteps));
    for (const open of openSteps) {
      assert.include(inFlight, open.paper);
      assert.equal(liveNotes(open.paper)[0].key, open.key);
    }

    // The user trashes the note of one paper the journal recorded, when the
    // process ended after one landed.
    const trashedPaper: number | undefined = written.find((id) =>
      landedPapers.has(id),
    );
    const trashedNote =
      trashedPaper === undefined ? undefined : liveNotes(trashedPaper)[0];
    if (trashedNote) {
      trashedNote.deleted = true;
      await trashedNote.saveTx();
    }
    const liveBefore = ids.filter(
      (id) => liveNotes(id).length > 0 && landedPapers.has(id),
    );
    assert.notInclude(liveBefore, trashedPaper);

    const result = await api().resumeNoteBatchAfterRestart({
      panelId: panel.panelId,
      collection: {
        collectionId: record.folderId,
        name: record.folderName,
        libraryID,
      },
      papers: ids.map((itemId, index) => ({
        itemId,
        title: record.titles[index],
      })),
      inputTokenCap: 2_000_000,
      rewritePapers: trashedPaper === undefined ? [] : [trashedPaper],
    });
    const report = JSON.stringify(result);
    try {
      assert.equal(result.conversationKey, record.conversationKey, report);

      // The killed run was marked interrupted by startup recovery.
      assert.exists(result.priorRun, report);
      assert.equal(result.priorRun!.status, "failed", report);
      assert.equal(
        result.priorRun!.finalText,
        INTERRUPTED_AGENT_RUN_MARKER,
        report,
      );
      assert.lengthOf(result.resumableBatchIds, 1, report);
      assert.equal(result.resumeBatchId, result.resumableBatchIds[0], report);

      // The resumed ledger took one journal receipt for each paper with a
      // live, journaled note, and none for the paper whose note was trashed.
      assert.exists(result.initialNotePart, report);
      const receiptIds = result.initialNotePart!.receiptIds;
      const journalReceipts = receiptIds.filter((id) =>
        id.startsWith("journal:"),
      );
      assert.lengthOf(journalReceipts, liveBefore.length, report);
      assert.lengthOf(new Set(journalReceipts), liveBefore.length, report);
      assert.sameMembers(
        result.initialNotePart!.doneTargets,
        liveBefore.map((id) => `item:${id}`),
        report,
      );

      // The resumed batch wrote the papers left (the note in flight at the end
      // included, finished from its open step), and the model's second
      // batch rewrote the trashed paper's note.
      assert.equal(result.runStatus, "completed", report);
      assert.equal(result.end, "completed", report);
      assert.isTrue(result.batchResults[0]?.ok, report);
      assert.sameMembers(
        result.batchResults[0].applied,
        ids.filter((id) => !landedPapers.has(id)),
        report,
      );
      if (trashedNote) {
        assert.isTrue(result.batchResults[1]?.ok, report);
        assert.deepEqual(
          result.batchResults[1].applied,
          [trashedPaper],
          report,
        );
        // The trashed note stays in the trash beside its replacement.
        assert.isTrue(Zotero.Items.get(trashedNote.id).deleted);
      } else assert.lengthOf(result.batchResults, 1, report);

      // The journal: one applied create_note step a paper, two for the paper
      // whose note was rewritten; the killed run's steps are not repeated.
      const actions = await listJournalActions({
        conversationKey: record.conversationKey,
        limit: 500,
      });
      const perPaper: { [id: number]: string[] } = {};
      const paperOfStep = new Map<string, number>();
      for (const action of actions)
        for (const step of action.steps) {
          if (step.operation !== "create_note") continue;
          const parent = JSON.parse(step.forwardJson).parentItemId as number;
          paperOfStep.set(step.stepId, parent);
          (perPaper[parent] ||= []).push(`${action.runId}:${step.status}`);
        }
      for (const id of ids) {
        const applied = (perPaper[id] || []).filter((entry) =>
          entry.endsWith(":applied"),
        );
        assert.lengthOf(
          applied,
          id === trashedPaper ? 2 : 1,
          `paper ${id} steps ${JSON.stringify(perPaper[id])}: ${report}`,
        );
        // The killed run made one step for each paper it reached, and none
        // twice; the papers it never reached were written by the resume.
        const original = (perPaper[id] || []).filter((entry) =>
          entry.startsWith(`${result.priorRun!.runId}:`),
        );
        assert.isAtMost(original.length, 1, `paper ${id}: ${report}`);
        if (landedPapers.has(id))
          assert.lengthOf(original, 1, `paper ${id}: ${report}`);
      }

      // The note in flight when the process ended is the one the resume
      // kept: its step is applied, under the action that opened it, and no
      // create_note step of that action is left uncertain.
      for (const open of openSteps) {
        const [action] = await listJournalActions({
          actionId: open.actionId,
          limit: 1,
        });
        const step = action.steps.find((entry) => entry.stepId === open.stepId);
        assert.equal(step?.status, "applied", report);
        assert.equal(
          JSON.parse(step?.resultJson || "{}").noteId,
          liveNotes(open.paper)[0]?.id,
          report,
        );
        assert.deepEqual(
          action.steps
            .filter(
              (entry) =>
                entry.operation === "create_note" &&
                entry.status === "uncertain",
            )
            .map((entry) => entry.stepId),
          [],
          report,
        );
      }

      // The ledger the resumed run ended with: one receipt for each paper,
      // the kept note's paper included, and none twice.
      assert.exists(result.finalNotePart, report);
      assert.sameMembers(
        result.finalNotePart!.doneTargets,
        ids.map((id) => `item:${id}`),
        report,
      );
      const receiptsPerPaper = new Map<number, string[]>();
      for (const receiptId of result.finalNotePart!.receiptIds) {
        const tool = result.toolReceipts[receiptId];
        const papers = receiptId.startsWith("journal:")
          ? [paperOfStep.get(receiptId.slice("journal:".length))]
          : [
              ...(tool?.appliedTargets || []),
              ...(tool?.alreadySatisfiedTargets || []),
            ].map((target) => Number(target.replace(/^item:/, "")));
        assert.isAtLeast(
          papers.length,
          1,
          `receipt ${receiptId} names no paper: ${report}`,
        );
        for (const paper of papers) {
          assert.isDefined(paper, `${receiptId}: ${report}`);
          receiptsPerPaper.set(paper!, [
            ...(receiptsPerPaper.get(paper!) || []),
            receiptId,
          ]);
        }
      }
      for (const id of ids)
        assert.lengthOf(
          receiptsPerPaper.get(id) || [],
          1,
          `paper ${id} receipts: ${report}`,
        );

      // One live note a paper. It runs last so the checks above still report
      // on a failing run.
      const describeNotes = async (id: number) => {
        const steps: string[] = [];
        for (const action of await listJournalActions({
          conversationKey: record.conversationKey,
          limit: 500,
        }))
          for (const step of action.steps)
            if (
              step.operation === "create_note" &&
              JSON.parse(step.forwardJson).parentItemId === id
            )
              steps.push(
                `${action.runId}/${action.actionId}/${step.stepId} ${step.status} key=${JSON.parse(step.forwardJson).key} result=${step.resultJson}`,
              );
        return JSON.stringify({
          notes: Zotero.Items.get(id)
            .getNotes(true)
            .map((noteId: number) => {
              const note = Zotero.Items.get(noteId);
              return { key: note.key, deleted: !!note.deleted };
            }),
          steps,
        });
      };
      for (const id of ids)
        assert.lengthOf(
          liveNotes(id),
          1,
          `paper ${id} ${await describeNotes(id)}`,
        );
      for (const open of openSteps)
        assert.equal(liveNotes(open.paper)[0].key, open.key);

      // Undo of the whole batch, settled note included: the action that
      // opened the batch trashes every note it landed. The rewrite of the
      // user's trashed note belongs to a later action and stays.
      if (undoAfterResume()) {
        assert.lengthOf(openSteps, 1, "the undo variant needs a settled step");
        const [batchAction] = await listJournalActions({
          actionId: openSteps[0].actionId,
          limit: 1,
        });
        const landed = batchAction.steps
          .filter(
            (step) =>
              step.operation === "create_note" && step.status === "applied",
          )
          .map((step) => ({
            noteId: JSON.parse(step.resultJson || "{}").noteId as number,
            paper: JSON.parse(step.forwardJson).parentItemId as number,
          }));
        assert.isAtLeast(landed.length, KILL_AFTER_NOTES, report);
        assert.include(
          landed.map((entry) => entry.paper),
          openSteps[0].paper,
          "the settled note is part of the undone action",
        );
        const { undone, undoReport } = await undoAction(
          record,
          batchAction.actionId,
        );
        assert.lengthOf(undone.conflicts, 0, undoReport);
        for (const entry of landed) {
          const note = Zotero.Items.get(entry.noteId);
          assert.isTrue(
            !note || note.deleted,
            `note ${entry.noteId} of paper ${entry.paper} is still live: ${undoReport}`,
          );
        }
        for (const id of ids)
          assert.lengthOf(
            liveNotes(id),
            id === trashedPaper ? 1 : 0,
            `paper ${id} after the undo`,
          );
        const [after] = await listJournalActions({
          actionId: batchAction.actionId,
          limit: 1,
        });
        assert.equal(after.status, "reverted", undoReport);
      }
    } finally {
      await cleanUp(record, panel.panelId);
    }
  });

  it("resume phase (erased or trashed note): the note in flight is finished once, or refused until the user restores it, and never written again", async function () {
    const mode = tamperMode();
    if (
      restartPhase() !== "resume" ||
      !["absent", "changed", "undo-first", "undo-during-card"].includes(mode) ||
      standaloneTarget()
    )
      this.skip();
    await waitForStartup();
    const record = JSON.parse(await IOUtils.readUTF8(recordPath())) as Record;
    const { ids } = record;
    const libraryID = Zotero.Libraries.userLibraryID;
    const panel = await api().renderPanelForItem(ids[0]);
    const inFlight: Array<{
      actionId: string;
      stepId: string;
      paper: number;
      key: string;
    }> = [];
    for (const action of await listJournalActions({
      conversationKey: record.conversationKey,
      limit: 500,
    }))
      for (const step of action.steps)
        if (step.operation === "create_note" && step.status === "uncertain") {
          const forward = JSON.parse(step.forwardJson);
          inFlight.push({
            actionId: action.actionId,
            stepId: step.stepId,
            paper: forward.parentItemId,
            key: forward.key,
          });
        }
    try {
      assert.lengthOf(inFlight, 1, JSON.stringify(inFlight));
      const [open] = inFlight;
      const note = liveNotesOf(open.paper)[0];
      assert.equal(note?.key, open.key, "the note in flight is in Zotero");
      if (mode === "undo-first") {
        // The user undoes the interrupted batch before continuing. The note
        // in flight has no inverse, so it stays live and its step open.
        await undoAction(record, open.actionId);
        assert.equal(liveNotesOf(open.paper)[0]?.key, open.key);
      } else if (mode === "absent") await note.eraseTx();
      else if (mode === "changed") {
        note.deleted = true;
        await note.saveTx();
      }
      const stepStatus = async () => {
        const [action] = await listJournalActions({
          actionId: open.actionId,
          limit: 1,
        });
        return action.steps.find((step) => step.stepId === open.stepId)!.status;
      };
      const resume = () => resumeFromPanel(record, panel.panelId);
      const others = ids.filter((id) => id !== open.paper);
      const inFlightAt = ids.indexOf(open.paper);
      if (mode === "undo-during-card") {
        // Preparation ran while the interrupted action could still be
        // reopened, so the card offers the in-flight paper. The undo then
        // ends that action, the approved continue writes under a new one,
        // and the row is refused at write time instead of being written
        // beside the note the earlier attempt left.
        const resumable = await listResumableBatches(record.conversationKey);
        assert.lengthOf(resumable, 1, JSON.stringify(resumable));
        const batchId = resumable[0].batchId;
        const openSequence = (
          await listJournalActions({ actionId: open.actionId, limit: 1 })
        )[0].steps.find((step) => step.stepId === open.stepId)!.sequence;
        const { undo, report } = await continueWithUndoDuringCard(
          record,
          batchId,
          open.actionId,
        );
        // The refusal names the note the earlier attempt left.
        assert.include(report, heldNoteReason(note.id), report);
        const expectRefusedAfterUndo = async (text: string) => {
          assert.equal(await stepStatus(), "uncertain", text);
          assert.lengthOf(liveNotesOf(open.paper), 1, text);
          assert.equal(liveNotesOf(open.paper)[0].key, open.key, text);
          assert.lengthOf(
            Zotero.Items.get(open.paper).getNotes(true),
            1,
            `no replacement beside the reserved note: ${text}`,
          );
          const rows = await rowsOf(batchId);
          const refused = rows.filter(
            (row) => row.itemKey === `item:${open.paper}`,
          );
          assert.lengthOf(refused, 1, JSON.stringify(rows));
          assert.equal(refused[0].status, "failed", JSON.stringify(rows));
          assert.equal(refused[0].actionId, open.actionId);
          assert.equal(refused[0].stepSequence, openSequence);
          assert.equal(refused[0].error, heldNoteReason(note.id));
          assert.lengthOf(
            rows.filter((row) => row.status === "saved"),
            ids.length - 1,
            JSON.stringify(rows),
          );
          // The undo trashed the notes before the one in flight; the papers
          // after it were written once by the approved continue.
          for (const id of others)
            assert.lengthOf(
              liveNotesOf(id),
              ids.indexOf(id) < inFlightAt ? 0 : 1,
              `paper ${id}: ${text}`,
            );
        };
        await expectRefusedAfterUndo(`${report} undo=${undo.undoReport}`);
        // A later continue refuses the row too.
        const later = await resume();
        assert.equal(later.resumeBatchId, batchId, JSON.stringify(later));
        await expectRefusedAfterUndo(JSON.stringify(later));
        return;
      }
      const first = await resume();
      const report = JSON.stringify(first);
      assert.isNotEmpty(first.resumeBatchId, report);
      assert.isAtLeast(first.batchResults.length, 1, report);
      // After an undo the papers before the one in flight keep their notes
      // in the trash: a trashed note still counts as written, so a resume
      // does not overrule the undo. No paper ever has two live notes.
      for (const id of others)
        assert.lengthOf(
          liveNotesOf(id),
          mode === "undo-first" && ids.indexOf(id) < inFlightAt ? 0 : 1,
          `paper ${id}: ${report}`,
        );
      if (mode === "absent") {
        // Nothing landed: the step had no effect and the paper is written
        // once. With every row saved, the action reads fully applied.
        assert.equal(await stepStatus(), "no_effect", report);
        const [action] = await listJournalActions({
          actionId: open.actionId,
          limit: 1,
        });
        assert.equal(action.status, "applied", report);
        assert.lengthOf(liveNotesOf(open.paper), 1, report);
        assert.lengthOf(
          Zotero.Items.get(open.paper).getNotes(true),
          1,
          "one note on the paper, none left over",
        );
        const rows = await rowsOf(first.resumeBatchId);
        assert.isTrue(
          rows.every((row) => row.status === "saved"),
          JSON.stringify(rows),
        );
        return;
      }
      if (mode === "undo-first") {
        // The in-flight paper keeps its one reserved note and is not
        // rewritten; every other paper has exactly one live note.
        assert.equal(await stepStatus(), "uncertain", report);
        assert.lengthOf(liveNotesOf(open.paper), 1, report);
        assert.equal(liveNotesOf(open.paper)[0].key, open.key, report);
        assert.lengthOf(
          Zotero.Items.get(open.paper).getNotes(true),
          1,
          `no replacement beside the reserved note: ${report}`,
        );
        const rows = await rowsOf(first.resumeBatchId);
        const unsaved = rows.filter((row) => row.status !== "saved");
        assert.lengthOf(unsaved, 1, JSON.stringify(rows));
        assert.equal(unsaved[0].itemKey, `item:${open.paper}`);
        // The refusal names the note the earlier attempt left.
        assert.include(report, heldNoteReason(note.id), report);
        return;
      }
      // Trashed: the reserved note was changed. The step stays open, the row
      // is refused with the action and step that hold the note, and no
      // replacement exists after this resume or after a second one.
      const expectRefused = async (run: typeof first) => {
        const text = JSON.stringify(run);
        assert.equal(await stepStatus(), "uncertain", text);
        assert.lengthOf(liveNotesOf(open.paper), 0, text);
        assert.lengthOf(
          Zotero.Items.get(open.paper).getNotes(true),
          1,
          `only the trashed note: ${text}`,
        );
        const rows = await rowsOf(first.resumeBatchId);
        const failed = rows.filter((row) => row.status === "failed");
        assert.lengthOf(failed, 1, JSON.stringify(rows));
        assert.equal(failed[0].actionId, open.actionId);
        // The same wording the preparation and the write-time check give.
        assert.equal(failed[0].error, trashedNoteReason(note.id));
        assert.lengthOf(
          rows.filter((row) => row.status === "saved"),
          ids.length - 1,
          JSON.stringify(rows),
        );
        for (const id of others)
          assert.lengthOf(liveNotesOf(id), 1, `paper ${id}: ${text}`);
      };
      await expectRefused(first);
      const second = await resume();
      assert.equal(second.resumeBatchId, first.resumeBatchId);
      assert.isAtLeast(
        second.batchResults.length,
        1,
        `the second continue called the batch: ${JSON.stringify(second)}`,
      );
      await expectRefused(second);
      // The user restores the note from the trash: the next continue finds
      // it live and matching, keeps it, and writes nothing.
      const trashed = Zotero.Items.get(note.id);
      trashed.deleted = false;
      await trashed.saveTx();
      const third = await resume();
      const thirdReport = JSON.stringify(third);
      assert.equal(third.resumeBatchId, first.resumeBatchId, thirdReport);
      assert.equal(await stepStatus(), "applied", thirdReport);
      const [action] = await listJournalActions({
        actionId: open.actionId,
        limit: 1,
      });
      assert.equal(action.status, "applied", thirdReport);
      assert.lengthOf(
        Zotero.Items.get(open.paper).getNotes(true),
        1,
        `only the restored note: ${thirdReport}`,
      );
      assert.equal(liveNotesOf(open.paper)[0]?.id, note.id, thirdReport);
      const rows = await rowsOf(first.resumeBatchId);
      assert.isTrue(
        rows.every((row) => row.status === "saved"),
        JSON.stringify(rows),
      );
      assert.equal(
        rows.find((row) => row.itemKey === `item:${open.paper}`)?.noteId,
        note.id,
      );
      for (const id of others)
        assert.lengthOf(liveNotesOf(id), 1, `paper ${id}: ${thirdReport}`);
    } finally {
      await cleanUp(record, panel.panelId);
    }
  });

  it("resume phase (standalone notes): continue keeps the note in flight after a cited paper changed, or refuses it after an undo or a move, and never writes it twice", async function () {
    const mode = tamperMode();
    if (
      restartPhase() !== "resume" ||
      !standaloneTarget() ||
      (mode !== "" && mode !== "undo-first" && mode !== "moved")
    )
      this.skip();
    await waitForStartup();
    const record = JSON.parse(await IOUtils.readUTF8(recordPath())) as Record;
    const { ids } = record;
    const libraryID = Zotero.Libraries.userLibraryID;
    const panel = await api().renderPanelForItem(ids[0]);
    // Standalone notes have no parent: each is found through the folder it
    // was filed into, and tied to its paper through its batch row.
    const folderNotes = (): Zotero.Item[] =>
      (
        Zotero.Collections.get(record.folderId).getChildItems(
          false,
          true,
        ) as Zotero.Item[]
      ).filter((entry) => entry.isNote() && !entry.parentID);
    const liveFolderNotes = () => folderNotes().filter((note) => !note.deleted);
    const paperOfItemKey = (itemKey: unknown) =>
      Number(String(itemKey || "").replace(/^item:/, ""));
    const landed: Array<{ paper: number; noteId: number }> = [];
    const inFlight: Array<{
      actionId: string;
      stepId: string;
      sequence: number;
      paper: number;
      key: string;
      forwardJson: string;
    }> = [];
    let batchId = "";
    for (const action of await listJournalActions({
      conversationKey: record.conversationKey,
      limit: 500,
    }))
      for (const step of action.steps) {
        if (step.operation !== "create_note") continue;
        const forward = JSON.parse(step.forwardJson);
        // Every step names the batch row it writes.
        assert.isObject(forward.batchItem, step.forwardJson);
        assert.isUndefined(forward.parentItemId, step.forwardJson);
        batchId ||= forward.batchItem.batchId;
        assert.equal(forward.batchItem.batchId, batchId);
        if (step.status === "applied")
          landed.push({
            paper: paperOfItemKey(forward.batchItem.itemKey),
            noteId: JSON.parse(step.resultJson || "{}").noteId,
          });
        if (step.status === "uncertain")
          inFlight.push({
            actionId: action.actionId,
            stepId: step.stepId,
            sequence: step.sequence,
            paper: paperOfItemKey(forward.batchItem.itemKey),
            key: forward.key,
            forwardJson: step.forwardJson,
          });
      }
    try {
      console.log(
        `Standalone note batch restart: ${folderNotes().length} of ${ids.length} notes at the restart`,
      );
      assert.lengthOf(inFlight, 1, JSON.stringify(inFlight));
      const [open] = inFlight;
      assert.isAtLeast(landed.length, record.killAfterNotes - 1);
      assert.lengthOf(folderNotes(), landed.length + 1);
      const reserved = Zotero.Items.getByLibraryAndKey(libraryID, open.key);
      assert.exists(reserved, "the note in flight is in Zotero");
      assert.isFalse(Boolean(reserved.deleted));
      assert.isFalse(Boolean(reserved.parentID));
      assert.include(reserved.getCollections(), record.folderId);
      const stepOf = async () => {
        const [action] = await listJournalActions({
          actionId: open.actionId,
          limit: 1,
        });
        return action.steps.find((step) => step.stepId === open.stepId)!;
      };
      const rowOf = async () =>
        (await listBatchItems(batchId)).find(
          (row) => row.itemKey === `item:${open.paper}`,
        )!;

      if (mode === "undo-first") {
        // The user undoes the interrupted batch before continuing: its landed
        // notes go to the trash; the note in flight has no inverse and stays.
        await undoAction(record, open.actionId);
        for (const entry of landed)
          assert.isTrue(Boolean(Zotero.Items.get(entry.noteId)?.deleted));
        assert.isFalse(
          Boolean(Zotero.Items.getByLibraryAndKey(libraryID, open.key).deleted),
        );
      } else if (mode === "moved") {
        // The user takes the note in flight out of the folder it was filed
        // into: it was changed by the user and is left alone.
        reserved.removeFromCollection(record.folderId);
        await reserved.saveTx();
        assert.notInclude(reserved.getCollections(), record.folderId);
      } else {
        // A cited paper's metadata changes before "continue": the body the
        // batch rebuilds for the in-flight row no longer equals the one its
        // step reserved, so matching the step by body would miss it.
        const paper = Zotero.Items.get(open.paper);
        paper.setField("title", `${paper.getField("title")} (revised title)`);
        await paper.saveTx();
        const row = await rowOf();
        assert.exists(row.materialRef, JSON.stringify(row));
        const document = await loadPlanDocument(row.materialRef!.documentId);
        const parts = documentNoteParts(document!.visibleHtml, libraryID);
        const rebuilt = mergeNoteCitationItems(parts.html, parts.citationItems);
        const intended = await readRecoveryText(
          JSON.parse(open.forwardJson).html,
        );
        assert.isFalse(
          noteHtmlMatches(intended, rebuilt),
          "the rebuilt body differs from the reserved one",
        );
        // The same step without the row it records is not found by body.
        const step = await stepOf();
        const legacyForward = JSON.parse(step.forwardJson);
        delete legacyForward.batchItem;
        const legacy = await findUncertainNoteStepForRow(
          [{ ...step, forwardJson: JSON.stringify(legacyForward) }],
          {
            batchId,
            itemKey: `item:${open.paper}`,
            targetItemId: open.paper,
            standalone: true,
            collections: [record.folderId],
            rebuiltHtml: async () => rebuilt,
          },
        );
        assert.isUndefined(legacy, "body matching misses the changed note");
      }

      const result = await resumeFromPanel(record, panel.panelId);
      const report = JSON.stringify(result);
      assert.equal(result.resumeBatchId, batchId, report);
      assert.equal(result.priorRun?.status, "failed", report);
      assert.isAtLeast(result.batchResults.length, 1, report);
      assert.isTrue(result.batchResults[0].ok, report);
      const rows = await listBatchItems(batchId);
      const inFlightAt = ids.indexOf(open.paper);

      if (mode === "undo-first") {
        // Refused, not rewritten: the step stays open and the row names it.
        assert.equal((await stepOf()).status, "uncertain", report);
        const refused = rows.filter((row) => row.status !== "saved");
        assert.lengthOf(refused, 1, JSON.stringify(rows));
        assert.equal(refused[0].itemKey, `item:${open.paper}`);
        // One note for each row, trashed ones included: no second note for
        // the paper in flight. Live: the reserved note and the papers after it.
        assert.lengthOf(folderNotes(), ids.length, report);
        assert.lengthOf(
          liveFolderNotes(),
          ids.length - inFlightAt,
          `live notes: ${report}`,
        );
        assert.isFalse(
          Boolean(Zotero.Items.getByLibraryAndKey(libraryID, open.key).deleted),
        );
        // The refusal names the note the earlier attempt left.
        assert.include(report, heldNoteReason(reserved.id), report);
        return;
      }

      if (mode === "moved") {
        // Refused, not kept and not rewritten: the step stays open, the row
        // says the note was moved, and the note stays where the user put it.
        const expectMoved = async (text: string) => {
          assert.equal((await stepOf()).status, "uncertain", text);
          const after = await listBatchItems(batchId);
          const refused = after.filter((row) => row.status !== "saved");
          assert.lengthOf(refused, 1, JSON.stringify(after));
          assert.equal(refused[0].itemKey, `item:${open.paper}`);
          assert.equal(refused[0].status, "failed", JSON.stringify(after));
          assert.equal(
            refused[0].error,
            `Note ${reserved.id} was moved, so I did not touch it.`,
          );
          assert.notInclude(
            after.map((row) => row.noteId),
            reserved.id,
            "no row claims the moved note",
          );
          // Every other row has its own note in the folder; the moved note
          // is outside it, live, with no copy written beside it.
          assert.lengthOf(folderNotes(), ids.length - 1, text);
          assert.lengthOf(liveFolderNotes(), ids.length - 1, text);
          const moved = Zotero.Items.getByLibraryAndKey(libraryID, open.key);
          assert.isFalse(Boolean(moved.deleted), text);
          assert.isFalse(Boolean(moved.parentID), text);
          assert.notInclude(moved.getCollections(), record.folderId, text);
        };
        await expectMoved(report);
        const later = await resumeFromPanel(record, panel.panelId);
        assert.equal(later.resumeBatchId, batchId, JSON.stringify(later));
        await expectMoved(JSON.stringify(later));
        return;
      }

      // The receipt is not asserted here: this variant edits the cited
      // paper's title on purpose, and the batch postcondition rebuilds each
      // citation from current metadata, so the kept note (written before the
      // edit) does not verify. A standalone batch without that edit verifies
      // (libraryNotesAndItemType.workflow.test.ts).

      // Kept: the step is applied with the reserved note, under the action
      // that opened it, and that action has no open note step left.
      const step = await stepOf();
      assert.equal(step.status, "applied", report);
      assert.equal(
        JSON.parse(step.resultJson || "{}").noteId,
        reserved.id,
        report,
      );
      const [action] = await listJournalActions({
        actionId: open.actionId,
        limit: 1,
      });
      assert.deepEqual(
        action.steps
          .filter(
            (entry) =>
              entry.operation === "create_note" && entry.status === "uncertain",
          )
          .map((entry) => entry.stepId),
        [],
        report,
      );
      // Exactly one note per row: every row saved, each naming its own live
      // standalone note in the folder, and no other note there.
      assert.lengthOf(rows, ids.length, JSON.stringify(rows));
      assert.isTrue(
        rows.every((row) => row.status === "saved"),
        JSON.stringify(rows),
      );
      const noteIds = rows.map((row) => row.noteId);
      assert.lengthOf(new Set(noteIds), ids.length, JSON.stringify(rows));
      assert.sameMembers(
        folderNotes().map((note) => note.id),
        noteIds as number[],
        report,
      );
      for (const note of folderNotes()) {
        assert.isFalse(Boolean(note.deleted), report);
        assert.isFalse(Boolean(note.parentID), report);
      }
      assert.equal((await rowOf()).noteId, reserved.id, report);
      assert.equal(Zotero.Items.get(reserved.id).key, open.key);
      // A standalone note names no paper, so the ledger takes no journal
      // receipt for it either (journalReceipts.ts).
      assert.deepEqual(result.initialNotePart?.receiptIds ?? [], [], report);
    } finally {
      await cleanUp(record, panel.panelId);
    }
  });

  /**
   * Rewrites this conversation's batch to the shape the build before the
   * per-row resume left behind: create_note steps record no batch row, and
   * a row names its action only once its note landed, so every unwritten
   * row (the one in flight included) is `pending` with no action.
   */
  async function downgradeToPreUpgradeShape(
    conversationKey: number,
    batchId: string,
  ) {
    for (const action of await listJournalActions({
      conversationKey,
      limit: 500,
    }))
      for (const step of action.steps) {
        if (step.operation !== "create_note") continue;
        const forward = JSON.parse(step.forwardJson);
        if (!("batchItem" in forward)) continue;
        delete forward.batchItem;
        await Zotero.DB.queryAsync(
          `UPDATE llm_for_zotero_agent_journal_steps_v2
           SET forward_json = ? WHERE step_id = ?`,
          [JSON.stringify(forward), step.stepId],
        );
      }
    await Zotero.DB.queryAsync(
      `UPDATE llm_for_zotero_agent_batch_items
       SET action_id = NULL, step_sequence = NULL
       WHERE batch_id = ? AND status <> 'saved'`,
      [batchId],
    );
  }

  it("resume phase (pre-upgrade data): continue keeps, or refuses, the note in flight and never writes a note twice", async function () {
    const mode = tamperMode();
    if (restartPhase() !== "resume" || !legacyMode(mode)) this.skip();
    await waitForStartup();
    const record = JSON.parse(await IOUtils.readUTF8(recordPath())) as Record;
    const { ids } = record;
    const libraryID = Zotero.Libraries.userLibraryID;
    const standalone = record.target === "standalone";
    const twice = record.notesPerPaper === 2;
    const panel = await api().renderPanelForItem(ids[0]);
    const folderNotes = (): Zotero.Item[] =>
      (
        Zotero.Collections.get(record.folderId).getChildItems(
          false,
          true,
        ) as Zotero.Item[]
      ).filter((entry) => entry.isNote() && !entry.parentID);
    try {
      const resumable = await listResumableBatches(record.conversationKey);
      assert.lengthOf(resumable, 1, JSON.stringify(resumable));
      const batchId = resumable[0].batchId;
      // The note in flight, read while its step still names its row.
      const inFlight: Array<{
        actionId: string;
        stepId: string;
        key: string;
        itemKey: string;
      }> = [];
      for (const action of await listJournalActions({
        conversationKey: record.conversationKey,
        limit: 500,
      }))
        for (const step of action.steps)
          if (step.operation === "create_note" && step.status === "uncertain") {
            const forward = JSON.parse(step.forwardJson);
            inFlight.push({
              actionId: action.actionId,
              stepId: step.stepId,
              key: forward.key,
              itemKey: forward.batchItem.itemKey,
            });
          }
      assert.lengthOf(inFlight, 1, JSON.stringify(inFlight));
      const [open] = inFlight;
      const paper = Number(open.itemKey.replace(/^item:/, "").split("#")[0]);
      const reserved = Zotero.Items.getByLibraryAndKey(libraryID, open.key);
      assert.exists(reserved, "the note in flight is in Zotero");
      assert.isFalse(Boolean(reserved.deleted));
      const stepOf = async () => {
        const [action] = await listJournalActions({
          actionId: open.actionId,
          limit: 1,
        });
        return action.steps.find((step) => step.stepId === open.stepId)!;
      };

      await downgradeToPreUpgradeShape(record.conversationKey, batchId);
      for (const action of await listJournalActions({
        conversationKey: record.conversationKey,
        limit: 500,
      }))
        for (const step of action.steps)
          if (step.operation === "create_note")
            assert.notProperty(JSON.parse(step.forwardJson), "batchItem");
      const before = await rowsOf(batchId);
      const inFlightRow = before.find((row) => row.itemKey === open.itemKey)!;
      assert.equal(inFlightRow.status, "pending", JSON.stringify(before));
      assert.isNull(inFlightRow.actionId, JSON.stringify(before));
      for (const row of before)
        if (row.status === "saved") assert.isNotNull(row.actionId);
        else assert.isNull(row.actionId, JSON.stringify(row));

      let erasedNoteId: number | undefined;
      if (mode === "legacy-twice") {
        // The process ended in the paper's second note. The user then erases
        // the paper's first note, so its row has to be written again.
        assert.isTrue(twice, "the batch has two notes a paper");
        assert.equal(open.itemKey, `item:${paper}#2`);
        const first = before.find((row) => row.itemKey === `item:${paper}`)!;
        assert.equal(first.status, "saved", JSON.stringify(before));
        erasedNoteId = first.noteId!;
        await Zotero.Items.get(erasedNoteId).eraseTx();
        assert.lengthOf(Zotero.Items.get(paper).getNotes(true), 1);
      } else if (mode === "legacy-edited") {
        // The in-flight note's cited paper changes: its rebuilt body no
        // longer equals the reserved one, so the old step matches no row.
        const cited = Zotero.Items.get(paper);
        cited.setField("title", `${cited.getField("title")} (revised title)`);
        await cited.saveTx();
      } else if (mode === "legacy-undo-first") {
        // The user undoes the interrupted batch before continuing; the note
        // in flight has no inverse and stays.
        await undoAction(record, open.actionId);
        assert.isFalse(
          Boolean(Zotero.Items.getByLibraryAndKey(libraryID, open.key).deleted),
        );
      } else if (mode === "legacy-first") {
        // The process ended during the batch's first note: no row names any
        // action, so nothing points the resume at the step of the note in
        // flight.
        assert.equal(record.killAfterNotes, 1);
        assert.isTrue(
          before.every((row) => row.actionId === null),
          JSON.stringify(before),
        );
      } else if (mode === "legacy-first-unlanded") {
        // The process ended before the first note's save committed: the
        // step is open and nothing is at its key. Erasing the note leaves
        // the same state.
        assert.equal(record.killAfterNotes, 1);
        assert.isTrue(
          before.every((row) => row.actionId === null),
          JSON.stringify(before),
        );
        await Zotero.Items.get(reserved.id).eraseTx();
        assert.isNotOk(Zotero.Items.getByLibraryAndKey(libraryID, open.key));
      } else if (mode === "legacy-unnamed-action") {
        // The first attempt (action X) saved its rows and is undone. A
        // pre-upgrade "continue" then wrote under a second action Y and
        // ended during its first note. Y holds that note's step, and no row
        // names Y. The step is moved from X to a new action Y to make that
        // shape from this crash.
        const second = `${open.actionId}-legacy-continue`;
        await Zotero.DB.queryAsync(
          `INSERT INTO llm_for_zotero_agent_journal_actions_v2
             (action_id, run_id, conversation_key, tool_name, description,
              effect, reversibility, status, affected_count, error_text,
              recovery_text, created_at, updated_at, applied_at, reverted_at)
           SELECT ?, run_id || ':legacy-continue', conversation_key,
                  tool_name, description, effect, reversibility, status, 0,
                  error_text, recovery_text, created_at + 1, updated_at + 1,
                  NULL, NULL
           FROM llm_for_zotero_agent_journal_actions_v2 WHERE action_id = ?`,
          [second, open.actionId],
        );
        await Zotero.DB.queryAsync(
          `UPDATE llm_for_zotero_agent_journal_steps_v2
           SET action_id = ?, sequence_no = 1 WHERE step_id = ?`,
          [second, open.stepId],
        );
        await Zotero.DB.queryAsync(
          `UPDATE llm_for_zotero_agent_journal_payloads_v2
           SET action_id = ? WHERE step_id = ?`,
          [second, open.stepId],
        );
        const first = open.actionId;
        open.actionId = second;
        assert.equal((await stepOf()).status, "uncertain");
        const { undone, undoReport } = await undoAction(record, first);
        assert.lengthOf(undone.conflicts, 0, undoReport);
        const [undoneAction] = await listJournalActions({
          actionId: first,
          limit: 1,
        });
        assert.equal(undoneAction.status, "reverted", undoReport);
        assert.isFalse(
          Boolean(Zotero.Items.getByLibraryAndKey(libraryID, open.key).deleted),
        );
        const named = (await rowsOf(batchId)).map((row) => row.actionId);
        assert.notInclude(named, second, "no row names the second action");
      }

      const result = await resumeFromPanel(record, panel.panelId);
      const report = JSON.stringify(result);
      assert.equal(result.resumeBatchId, batchId, report);
      assert.isAtLeast(result.batchResults.length, 1, report);
      const rows = await rowsOf(batchId);
      const rowText = JSON.stringify(rows);
      const step = await stepOf();

      if (mode === "legacy-first-unlanded") {
        // Nothing is at the step's key, so it holds no row: row 1 is
        // written once, no row is refused, and a second continue changes
        // nothing.
        assert.isTrue(
          rows.every((row) => row.status === "saved"),
          `no row is refused: ${rowText}; ${report}`,
        );
        const noteIds = rows.map((row) => row.noteId);
        assert.lengthOf(new Set(noteIds), ids.length, rowText);
        for (const id of ids)
          assert.lengthOf(
            Zotero.Items.get(id).getNotes(true),
            1,
            `paper ${id}, trashed notes included: ${report}`,
          );
        assert.lengthOf(liveNotesOf(paper), 1, report);
        const notesNow = () =>
          ids.map((id) => Zotero.Items.get(id).getNotes(true).join(","));
        const settled = JSON.stringify([await rowsOf(batchId), notesNow()]);
        const second = await resumeFromPanel(record, panel.panelId);
        const secondReport = JSON.stringify(second);
        assert.equal(
          JSON.stringify([await rowsOf(batchId), notesNow()]),
          settled,
          secondReport,
        );
        return;
      }

      if (
        mode === "legacy-edited" ||
        mode === "legacy-undo-first" ||
        mode === "legacy-first" ||
        mode === "legacy-unnamed-action"
      ) {
        // Refused, not rewritten: the old step stays open and no second
        // note stands beside the one the interrupted attempt left.
        assert.equal(step.status, "uncertain", report);
        assert.isFalse(Boolean(Zotero.Items.get(reserved.id).deleted));
        assert.notInclude(
          rows.map((row) => row.noteId),
          reserved.id,
          `no row claims the note it cannot be matched to: ${rowText}`,
        );
        const unsaved = rows.filter((row) => row.status !== "saved");
        assert.include(
          unsaved.map((row) => row.itemKey),
          open.itemKey,
          rowText,
        );
        if (mode !== "legacy-edited") {
          // Only the paper in flight is refused; it keeps its one note.
          assert.lengthOf(unsaved, 1, rowText);
          // The old step matched no row by body, so the refusal says the
          // note cannot be tied to one row, and how to end the refusal.
          assert.include(report, untiedNoteReason(reserved.id), report);
          // One note on every paper, trashed notes included: the paper in
          // flight has only the reserved note, and no paper has a copy.
          for (const id of ids)
            assert.lengthOf(
              Zotero.Items.get(id).getNotes(true),
              1,
              `paper ${id}, trashed notes included: ${report}`,
            );
          assert.equal(
            Zotero.Items.get(paper).getNotes(true)[0],
            reserved.id,
            `the reserved note is the paper's only note: ${report}`,
          );
          // An undo trashed the notes before the one in flight.
          const undone =
            mode === "legacy-undo-first" || mode === "legacy-unnamed-action";
          const at = ids.indexOf(paper);
          for (const id of ids)
            if (id !== paper)
              assert.lengthOf(
                liveNotesOf(id),
                undone && ids.indexOf(id) < at ? 0 : 1,
                `paper ${id}: ${report}`,
              );
          return;
        }
        // An old standalone step that matches no row could be any
        // unwritten row's, so every one of them is refused and named.
        for (const row of unsaved) {
          assert.equal(row.status, "failed", rowText);
          assert.equal(row.error, untiedNoteReason(reserved.id), rowText);
        }
        // The folder holds the saved rows' notes and the reserved one.
        assert.sameMembers(
          folderNotes().map((note) => note.id),
          [
            ...rows.flatMap((row) =>
              row.status === "saved" ? [row.noteId!] : [],
            ),
            reserved.id,
          ],
          report,
        );
        // The user erases the note, as the refusal asks. The next continue
        // writes every refused row once and settles the old step: nothing
        // is at its key, so it had no effect, and the action it belongs to
        // reads fully applied.
        await Zotero.Items.get(reserved.id).eraseTx();
        const second = await resumeFromPanel(record, panel.panelId);
        const secondReport = JSON.stringify(second);
        assert.equal(second.resumeBatchId, batchId, secondReport);
        assert.equal((await stepOf()).status, "no_effect", secondReport);
        const [action] = await listJournalActions({
          actionId: open.actionId,
          limit: 1,
        });
        assert.equal(action.status, "applied", secondReport);
        const after = await rowsOf(batchId);
        const afterText = JSON.stringify(after);
        assert.isTrue(
          after.every((row) => row.status === "saved"),
          afterText,
        );
        const noteIds = after.map((row) => row.noteId);
        assert.lengthOf(new Set(noteIds), ids.length, afterText);
        assert.sameMembers(
          folderNotes().map((note) => note.id),
          noteIds as number[],
          secondReport,
        );
        for (const note of folderNotes())
          assert.isFalse(Boolean(note.deleted), secondReport);
        return;
      }

      // Kept: the old step is settled with the reserved note, every row is
      // saved, each with its own note, and the action reads fully applied.
      assert.equal(step.status, "applied", report);
      assert.equal(JSON.parse(step.resultJson || "{}").noteId, reserved.id);
      const [action] = await listJournalActions({
        actionId: open.actionId,
        limit: 1,
      });
      assert.equal(action.status, "applied", report);
      assert.isTrue(
        rows.every((row) => row.status === "saved"),
        rowText,
      );
      assert.equal(
        rows.find((row) => row.itemKey === open.itemKey)?.noteId,
        reserved.id,
        rowText,
      );
      const noteIds = rows.map((row) => row.noteId);
      assert.lengthOf(new Set(noteIds), rows.length, rowText);
      if (standalone) {
        assert.sameMembers(
          folderNotes().map((note) => note.id),
          noteIds as number[],
          report,
        );
        for (const note of folderNotes())
          assert.isFalse(Boolean(note.deleted), report);
        return;
      }
      const perPaper = twice ? 2 : 1;
      for (const id of ids) {
        assert.lengthOf(liveNotesOf(id), perPaper, `paper ${id}: ${report}`);
        assert.lengthOf(
          Zotero.Items.get(id).getNotes(true),
          perPaper,
          `paper ${id}, trashed notes included: ${report}`,
        );
      }
      if (twice) {
        // The first row has a new note with its own body; the second row
        // kept the note in flight, which carries the second body.
        const firstRow = rows.find((row) => row.itemKey === `item:${paper}`)!;
        assert.notEqual(firstRow.noteId, erasedNoteId);
        assert.notEqual(firstRow.noteId, reserved.id, rowText);
        const firstBody = Zotero.Items.get(firstRow.noteId!).getNote();
        assert.include(
          firstBody,
          `Reading note on the finding of paper ${paper}`,
        );
        assert.notInclude(firstBody, "second reading note");
        assert.include(
          Zotero.Items.get(reserved.id).getNote(),
          `second reading note on paper ${paper}`,
        );
      }
    } finally {
      await cleanUp(record, panel.panelId);
    }
  });
});
