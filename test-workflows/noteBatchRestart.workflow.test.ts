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
 * the batch's action once the resume ends.
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
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

declare const Zotero: any;

const PAPER_COUNT = 30;
const DEFAULT_KILL_AFTER_NOTES = 12;

function restartPhase(): string {
  return String(
    (globalThis as any).Services?.env?.get?.("NOTE_BATCH_RESTART_PHASE") || "",
  );
}

function tamperMode(): "" | "absent" | "changed" | "undo-first" {
  const value = String(
    (globalThis as any).Services?.env?.get?.("NOTE_BATCH_RESTART_TAMPER") || "",
  );
  return value === "absent" || value === "changed" || value === "undo-first"
    ? value
    : "";
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
    await Zotero.Promise.delay(1000);
  }

  /** Erases the papers, folder and panel this test made. */
  async function cleanUp(record: Record, panelId: string) {
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
    if (restartPhase() !== "resume" || tamperMode()) this.skip();
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

  it("resume phase (erased or trashed note): the note in flight is finished once, or refused twice, and never written again", async function () {
    const mode = tamperMode();
    if (restartPhase() !== "resume" || !mode) this.skip();
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
      else {
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
      const rowsOf = async (batchId: string) => {
        const rows = (await Zotero.DB.queryAsync(
          `SELECT status, action_id, error
           FROM llm_for_zotero_agent_batch_items WHERE batch_id = ?`,
          [batchId],
        )) as any[];
        // A result row throws on a property it does not hold (its JSON
        // form included), so each is read into a plain object.
        return rows.map((row) => ({
          status: String(row.status),
          actionId: String(row.action_id),
          error: String(row.error || ""),
        }));
      };
      const resume = () =>
        api().resumeNoteBatchAfterRestart({
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
          rewritePapers: [],
        });
      const others = ids.filter((id) => id !== open.paper);
      const first = await resume();
      const report = JSON.stringify(first);
      assert.isNotEmpty(first.resumeBatchId, report);
      assert.isAtLeast(first.batchResults.length, 1, report);
      // After an undo the papers before the one in flight keep their notes
      // in the trash: a trashed note still counts as written, so a resume
      // does not overrule the undo. No paper ever has two live notes.
      const inFlightAt = ids.indexOf(open.paper);
      for (const id of others)
        assert.lengthOf(
          liveNotesOf(id),
          mode === "undo-first" && ids.indexOf(id) < inFlightAt ? 0 : 1,
          `paper ${id}: ${report}`,
        );
      if (mode === "absent") {
        // Nothing landed: the step fails and the paper is written once.
        assert.equal(await stepStatus(), "failed", report);
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
        assert.isNotEmpty(failed[0].error);
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
    } finally {
      await cleanUp(record, panel.panelId);
    }
  });
});
