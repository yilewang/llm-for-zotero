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
 */
import { assert } from "chai";
import { INTERRUPTED_AGENT_RUN_MARKER } from "../src/agent/store/traceStore";
import {
  initAgentChangeJournal,
  listJournalActions,
} from "../src/agent/store/changeJournal";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

declare const Zotero: any;

const PAPER_COUNT = 30;
const KILL_AFTER_NOTES = 12;

function restartPhase(): string {
  return String(
    (globalThis as any).Services?.env?.get?.("NOTE_BATCH_RESTART_PHASE") || "",
  );
}

type Record = {
  folderId: number;
  folderName: string;
  ids: number[];
  titles: string[];
  conversationKey: number;
  variant: string;
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
      killAfterNotes: KILL_AFTER_NOTES,
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
    if (restartPhase() !== "resume") this.skip();
    await waitForStartup();
    const record = JSON.parse(await IOUtils.readUTF8(recordPath())) as Record;
    const { ids } = record;
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
    for (const action of await listJournalActions({
      conversationKey: record.conversationKey,
      limit: 500,
    }))
      for (const step of action.steps)
        if (step.operation === "create_note" && step.status === "applied")
          landedPapers.add(JSON.parse(step.forwardJson).parentItemId);
    assert.isAtLeast(landedPapers.size, KILL_AFTER_NOTES - 1);
    assert.isAtMost(written.length - landedPapers.size, 1);
    for (const id of landedPapers) assert.include(written, id);

    // The user trashes the note of one paper the journal recorded.
    const trashedPaper = written[0];
    assert.include([...landedPapers], trashedPaper);
    const trashedNote = liveNotes(trashedPaper)[0];
    trashedNote.deleted = true;
    await trashedNote.saveTx();
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
      rewritePapers: [trashedPaper],
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
      assert.isTrue(result.batchResults[1]?.ok, report);
      assert.deepEqual(result.batchResults[1].applied, [trashedPaper], report);

      // Native state: one live note a paper; the trashed one stays in the
      // trash beside its replacement.
      assert.isTrue(Zotero.Items.get(trashedNote.id).deleted);

      // The journal: one applied create_note step a paper, two for the paper
      // whose note was rewritten; the killed run's steps are not repeated.
      const actions = await listJournalActions({
        conversationKey: record.conversationKey,
        limit: 500,
      });
      const perPaper: { [id: number]: string[] } = {};
      for (const action of actions)
        for (const step of action.steps) {
          if (step.operation !== "create_note") continue;
          const parent = JSON.parse(step.forwardJson).parentItemId as number;
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

      // PRODUCT BUG (found by this scenario, crash variant only): the note
      // being written when the process was killed exists in Zotero, but its
      // journal step stays "uncertain" and the resumed batch creates a second
      // note for that paper instead of reusing the reserved key. The
      // invariant is one live note a paper, so it stays asserted. It runs
      // last so the checks above still report on a failing run.
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
    } finally {
      for (const id of ids) {
        const paper = Zotero.Items.get(id);
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
        .clickPanelDelete(panel.panelId)
        .catch(() => undefined);
      await IOUtils.remove(recordPath()).catch(() => undefined);
    }
  });
});
