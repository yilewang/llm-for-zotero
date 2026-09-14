import { assert } from "chai";
import {
  clearPlanDocumentConversationRowsInTransaction,
  loadDocumentActionState,
  savePlanDocumentInTransaction,
} from "../src/agent/documents/store";
import { exportPlanDocumentMarkdown } from "../src/agent/documents/actions";
import type { PlanDocument } from "../src/agent/documents/types";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";
import {
  sha256Bytes,
  sha256Text,
} from "../src/agent/store/journalRecoveryBlobStore";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";

describe("workflow: document save recovery", function () {
  this.timeout(60000);
  let parent: Zotero.Item;
  let api: WorkflowTestApi;
  let document: PlanDocument;
  let originalQuery: typeof Zotero.DB.queryAsync;
  const temporaryPaths: string[] = [];

  beforeEach(async function () {
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    parent = new Zotero.Item("journalArticle");
    parent.libraryID = Zotero.Libraries.userLibraryID;
    parent.setField("title", "Disposable document recovery parent");
    await parent.saveTx();
    originalQuery = Zotero.DB.queryAsync;
    const now = Date.now();
    document = {
      version: 2,
      documentId: `document-recovery:${parent.key}`,
      documentVersion: 1,
      conversationKey: parent.id,
      title: "Recovery workflow",
      documentKind: "custom",
      integrityPolicy: "authored",
      origin: {
        kind: "direct",
        runId: `recovery:${parent.key}`,
        sourceMessageTimestamp: now,
      },
      visibleMarkdown: "# Recovery workflow\n\nPreserve this exact note.",
      visibleHtml: "<h1>Recovery workflow</h1><p>Preserve this exact note.</p>",
      citationBundle: {
        clusters: [],
        bibliographyEntries: [],
        style: { id: "apa", title: "APA" },
        locale: "en-US",
      },
      assets: [],
      verifiedQuotes: [],
      coverageItems: [],
      validation: {
        integrityValidated: true,
        groundingReviewed: "not_run",
        quoteVerified: "not_applicable",
        issues: [],
      },
      contentHash: await sha256Text(`recovery:${parent.key}`),
      createdAt: now,
    };
  });

  afterEach(async function () {
    Zotero.DB.queryAsync = originalQuery;
    await api.reset();
    const state = await loadDocumentActionState(document.documentId);
    const binding = state?.savedNote || state?.pendingNote;
    const saved =
      binding &&
      Zotero.Items.getByLibraryAndKey(binding.libraryID, binding.itemKey);
    if (saved && !saved.parentID) await saved.eraseTx();
    await parent.eraseTx();
    await Zotero.DB.executeTransaction(() =>
      clearPlanDocumentConversationRowsInTransaction(document.conversationKey),
    );
    for (const path of temporaryPaths.splice(0))
      await (globalThis as any).IOUtils.remove(path, { ignoreAbsent: true });
  });

  async function storeDocument() {
    await Zotero.DB.executeTransaction(() =>
      savePlanDocumentInTransaction({
        document,
        outbox: {
          version: 1,
          outboxId: `outbox:${parent.key}`,
          documentId: document.documentId,
          conversationKey: parent.id,
          messageTimestamp: document.createdAt,
          visibleMarkdown: document.visibleMarkdown,
          status: "delivered",
          attemptCount: 1,
          createdAt: document.createdAt,
          updatedAt: document.createdAt,
        },
      }),
    );
  }

  function injectCheckpointFailure(fail: (state: any) => boolean) {
    (Zotero.DB as any).queryAsync = function (sql: string, ...args: any[]) {
      if (
        sql.includes(
          "INSERT OR REPLACE INTO llm_for_zotero_plan_document_action_state",
        )
      ) {
        const state = JSON.parse(args[0][1]);
        if (state.documentId === document.documentId && fail(state))
          throw new Error("Injected document checkpoint failure");
      }
      return (originalQuery as any).call(this, sql, ...args);
    };
  }

  async function waitFor<T>(read: () => T | null | false): Promise<T> {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const result = read();
      if (result) return result;
      await Zotero.Promise.delay(25);
    }
    throw new Error("Document recovery UI did not settle");
  }

  async function renderCard() {
    const panel = await api.renderPanelForItem(parent.id);
    const trace = api.renderToolResultForPanel(
      panel.panelId,
      {
        callId: `submit:${parent.key}`,
        name: "submit_document",
        ok: true,
        content: { documentId: document.documentId },
      },
      { documentId: document.documentId },
    )!;
    const button = await waitFor(() =>
      trace.querySelector<HTMLButtonElement>(".llm-plan-document-action-note"),
    );
    const status = trace.querySelector<HTMLElement>(
      ".llm-plan-document-action-status",
    )!;
    return { button, status };
  }

  async function clickSave(card: Awaited<ReturnType<typeof renderCard>>) {
    card.button.click();
    await waitFor(
      () => !card.button.disabled && Boolean(card.status.textContent),
    );
  }

  it("reuses the same native note after card failure, export, and retry", async function () {
    await storeDocument();
    const card = await renderCard();
    injectCheckpointFailure((state) => Boolean(state.savedNote));
    await clickSave(card);
    assert.include(card.status.textContent, "checkpoint failure");
    Zotero.DB.queryAsync = originalQuery;
    const initial = (await loadDocumentActionState(document.documentId))!
      .pendingNote!;
    const note = Zotero.Items.getByLibraryAndKey(
      initial.libraryID,
      initial.itemKey,
    )!;
    const noteId = note.id;
    await note.reload(["note"], true);
    assert.include(note.getNote(), "Preserve this exact note.");
    const path = `${Zotero.getTempDirectory().path}/document-recovery-${parent.key}.md`;
    temporaryPaths.push(path);
    await exportPlanDocumentMarkdown(document.documentId, path);
    assert.equal(
      (await loadDocumentActionState(document.documentId))!.pendingNote!
        .itemKey,
      initial.itemKey,
    );
    await clickSave(card);
    assert.equal(card.status.textContent, "Note already saved");
    const final = (await loadDocumentActionState(document.documentId))!;
    assert.equal(final.savedNote!.itemKey, initial.itemKey);
    assert.isUndefined(final.pendingNote);
    assert.equal(
      Zotero.Items.getByLibraryAndKey(initial.libraryID, initial.itemKey)!.id,
      noteId,
    );
    assert.equal(final.lastExportedName, `document-recovery-${parent.key}.md`);
    const rows = await Zotero.DB.queryAsync(
      "SELECT itemID FROM itemNotes WHERE note LIKE ?",
      [`%${document.visibleHtml}%`],
    );
    assert.lengthOf(
      rows,
      1,
      "The real library contains exactly one saved document note",
    );
  });

  for (const failCheckpoint of [true, false])
    it(`${failCheckpoint ? "keeps a failed figure checkpoint incomplete" : "saves finalized figures once"} through the installed workflow note tool`, async function () {
      const win = Zotero.getMainWindow() as any;
      const pixels = Uint8Array.from(
        win.atob(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBc8AAAAASUVORK5CYII=",
        ),
        (c: string) => c.charCodeAt(0),
      );
      const path = `${Zotero.getTempDirectory().path}/document-figure-${parent.key}.png`;
      temporaryPaths.push(path);
      await (globalThis as any).IOUtils.write(path, pixels);
      document = {
        ...document,
        assets: [
          {
            assetId: "figure-1",
            contentHash: `sha256:${await sha256Bytes(pixels)}`,
            mimeType: "image/png",
            byteLength: pixels.length,
            caption: "Recovery figure",
            durablePath: path,
            provenance: {
              origin: "generated",
              generator: "workflow",
              generatorVersion: "1",
              evidenceRefs: [],
            },
          },
        ],
      };
      await storeDocument();
      await initAgentChangeJournal();
      const tool = (Zotero as any).LLMForZotero.api.agent.getToolDefinition(
        "note_write",
      );
      const context = {
        request: {
          conversationKey: parent.id,
          mode: "agent",
          libraryID: parent.libraryID,
          actionContract: {
            id: "recovery-workflow",
            obligations: [
              {
                id: "save",
                operation: "note_create",
                contentFrom: "summary",
                targetBoundary: { frozenTargetIds: [parent.id] },
              },
            ],
          },
          actionProgress: {
            contractId: "recovery-workflow",
            materialOutputs: [
              {
                outputId: "summary",
                documentId: document.documentId,
                documentVersion: document.documentVersion,
                contentHash: document.contentHash,
              },
            ],
          },
        },
        item: parent,
        modelName: "workflow",
        currentAnswerText: "",
      };
      const execute = async () => {
        const input = tool.validate({
          mode: "create",
          documentId: document.documentId,
          targetItemId: parent.id,
        });
        assert.isTrue(input.ok);
        let failure: unknown;
        try {
          const result = await tool.execute(input.value, context);
          assert.oneOf(result.content.status, ["created", "already_satisfied"]);
          assert.equal(result.content.documentId, document.documentId);
        } catch (error) {
          failure = error;
        }
        if (failCheckpoint) assert.match(String(failure), /incomplete/);
        else assert.isUndefined(failure);
      };
      if (failCheckpoint)
        injectCheckpointFailure(
          (state) => state.pendingNote?.finalized === true,
        );
      await execute();
      Zotero.DB.queryAsync = originalQuery;
      const state = (await loadDocumentActionState(document.documentId))!;
      const binding = state.savedNote || state.pendingNote!;
      if (failCheckpoint) {
        assert.isUndefined(state.savedNote);
        assert.isFalse(binding.finalized);
      } else {
        assert.isUndefined(state.pendingNote);
        assert.isTrue(state.savedNote!.finalized);
      }
      const note = Zotero.Items.getByLibraryAndKey(
        binding.libraryID,
        binding.itemKey,
      )!;
      await note.reload(["note"], true);
      if (failCheckpoint)
        assert.notInclude(note.getNote(), "data-attachment-key");
      else assert.include(note.getNote(), "data-attachment-key");
      const images = note.getAttachments();
      assert.lengthOf(images, 1);
      assert.isTrue(await Zotero.Items.get(images[0]).fileExists());
      await execute();
      await parent.reload(["childItems"], true);
      assert.deepEqual(parent.getNotes(), [note.id]);
      assert.deepEqual(
        note.getAttachments(),
        images,
        "Retry must not import images again",
      );
    });
});
