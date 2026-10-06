import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

/**
 * The standalone sidebar's trash button refuses a conversation that is still
 * generating, like the item panel does. Deleting during a send and pressing
 * Undo used to restore the chat with an answer that streamed on screen but
 * was never saved: the deletion had already fenced the send's writes.
 */
const QUESTION = "Keep generating while I try to delete this chat";

describe("workflow: standalone sidebar delete while generating", function () {
  this.timeout(60000);
  let api: WorkflowTestApi;
  let fixture: Awaited<
    ReturnType<WorkflowTestApi["createPaperWithPdfFixture"]>
  >;
  let win: Window;

  async function waitFor<T>(
    read: () => T | null | false,
    label: string,
    timeoutMs = 10000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = read();
      if (result) return result;
      await Zotero.Promise.delay(25);
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  beforeEach(async function () {
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    fixture = await api.createPaperWithPdfFixture({
      title: "Standalone generating deletion",
      pdfTitle: "Standalone generating deletion PDF",
    });
    await api.openStandaloneForItem(fixture.parentItemId);
    await api.resizeStandaloneWindow(1000, 700);
    win = (Zotero as any).LLMForZotero.data.standaloneWindow;
  });

  afterEach(async function () {
    await api.closeStandalone();
    if (fixture) await api.cleanupFixture(fixture);
    await api.reset();
  });

  it("refuses to delete the generating chat from its sidebar row", async function () {
    await api.clickStandaloneTab("open");
    await api.seedStandaloneConversation([
      { role: "user", text: "An unrelated earlier conversation" },
      { role: "assistant", text: "Unrelated earlier answer." },
    ]);
    const otherKey = (await api.getStandaloneDiagnostics()).conversationKey!;
    const doc = win.document;
    doc
      .querySelector<HTMLButtonElement>('[data-sidebar-action="new-chat"]')!
      .click();
    await waitFor(() => {
      const key = doc.querySelector<HTMLElement>("#llm-main")?.dataset.itemId;
      return key && key !== String(otherKey) ? key : null;
    }, "the new conversation to mount");
    await api.seedStandaloneConversation([
      { role: "user", text: "Earlier question in the generating chat" },
      { role: "assistant", text: "Earlier answer in the generating chat." },
    ]);
    const sendingKey = (await api.getStandaloneDiagnostics()).conversationKey!;
    assert.notEqual(sendingKey, otherKey);
    const rowSelector = `.llm-standalone-conv-item[data-conversation-key="${sendingKey}"]`;
    let during: Record<string, unknown> = {};

    await api.withPendingStandaloneSend(QUESTION, async () => {
      const row = await waitFor(
        () => doc.querySelector<HTMLElement>(rowSelector),
        "the generating chat's sidebar row",
      );
      row
        .querySelector<HTMLButtonElement>(".llm-standalone-conv-delete")!
        .click();
      // Wait briefly for the refusal; a wrongly queued deletion would show up
      // in the pending state read below, well inside its Undo window.
      await waitFor(
        () =>
          (doc.querySelector("#llm-status")?.textContent || "").includes(
            "Cannot delete while generating",
          ),
        "the refusal status",
        2000,
      ).catch(() => undefined);
      await Zotero.Promise.delay(300);
      during = {
        pending: await api.getPendingDeletionState(),
        mounted: doc.querySelector<HTMLElement>("#llm-main")?.dataset.itemId,
        rowPresent: Boolean(doc.querySelector(rowSelector)),
        status: doc.querySelector("#llm-status")?.textContent || "",
      };
    });

    const detail = JSON.stringify(during);
    const pending = during.pending as Awaited<
      ReturnType<WorkflowTestApi["getPendingDeletionState"]>
    >;
    assert.notInclude(pending.pendingConversationKeys, sendingKey, detail);
    assert.equal(pending.persistedRowCount, 0, detail);
    assert.equal(during.mounted, String(sendingKey), detail);
    assert.isTrue(during.rowPresent, detail);
    assert.include(
      String(during.status),
      "Cannot delete while generating",
      detail,
    );
    const history = await api.getConversationHistoryTexts(sendingKey);
    assert.include(
      history.stored.map((entry) => entry.text),
      QUESTION,
      JSON.stringify(history),
    );

    // Once the send has settled, the same trash button deletes the chat.
    const row = await waitFor(
      () => doc.querySelector<HTMLElement>(rowSelector),
      "the settled chat's sidebar row",
    );
    row
      .querySelector<HTMLButtonElement>(".llm-standalone-conv-delete")!
      .click();
    const deadline = Date.now() + 5000;
    let after = await api.getPendingDeletionState();
    while (
      !after.pendingConversationKeys.includes(sendingKey) &&
      Date.now() < deadline
    ) {
      await Zotero.Promise.delay(25);
      after = await api.getPendingDeletionState();
    }
    assert.include(
      after.pendingConversationKeys,
      sendingKey,
      JSON.stringify(after),
    );
    doc
      .querySelector<HTMLButtonElement>(
        ".llm-standalone-history-undo .llm-history-undo-btn",
      )!
      .click();
    const undoDeadline = Date.now() + 5000;
    while (
      (await api.getPendingDeletionState()).pendingConversationKeys.includes(
        sendingKey,
      ) &&
      Date.now() < undoDeadline
    ) {
      await Zotero.Promise.delay(25);
    }
  });
});
