import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

/**
 * The standalone sidebar's rename refuses a conversation that is still
 * generating, like the item panel does: the rename button says so and opens
 * no dialog, and the rename commit also gets the panel's guards. A rename
 * confirmed during a reply used to write the title.
 */
const QUESTION = "Keep generating while I try to rename this chat";
const GENERATING_STATUS = "History is unavailable while generating";
const TITLE_AFTER_REPLY = "Renamed after the reply";

describe("workflow: standalone sidebar rename while generating", function () {
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

  /** The stored catalog title of an upstream conversation, either kind. */
  async function storedTitle(conversationKey: number): Promise<string> {
    const title = await Zotero.DB.valueQueryAsync(
      `SELECT title FROM llm_for_zotero_global_conversations
       WHERE conversation_key = ?
       UNION ALL
       SELECT title FROM llm_for_zotero_paper_conversations
       WHERE conversation_key = ?
       LIMIT 1`,
      [conversationKey, conversationKey],
    );
    return String(title || "");
  }

  /** Opens the row's rename dialog, types a title, and confirms it. */
  async function renameFromSidebar(
    doc: Document,
    rowSelector: string,
    title: string,
  ): Promise<void> {
    const row = await waitFor(
      () => doc.querySelector<HTMLElement>(rowSelector),
      "the chat's sidebar row",
    );
    row
      .querySelector<HTMLButtonElement>(".llm-standalone-conv-rename")!
      .click();
    const input = await waitFor(
      () =>
        doc.querySelector<HTMLInputElement>(".llm-conversation-rename-input"),
      "the rename dialog",
    );
    input.value = title;
    const EventCtor = doc.defaultView!.Event;
    input.dispatchEvent(new EventCtor("input", { bubbles: true }));
    doc
      .querySelector<HTMLButtonElement>(
        ".llm-conversation-rename-dialog .llm-modal-primary",
      )!
      .click();
    await waitFor(
      () => !doc.querySelector(".llm-conversation-rename-dialog"),
      "the rename dialog to close",
    );
  }

  beforeEach(async function () {
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    fixture = await api.createPaperWithPdfFixture({
      title: "Standalone generating rename",
      pdfTitle: "Standalone generating rename PDF",
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

  it("refuses to rename the generating chat, and renames it once the reply settles", async function () {
    await api.clickStandaloneTab("open");
    await api.seedStandaloneConversation([
      { role: "user", text: "Earlier question in the generating chat" },
      { role: "assistant", text: "Earlier answer in the generating chat." },
    ]);
    const sendingKey = (await api.getStandaloneDiagnostics()).conversationKey!;
    const doc = win.document;
    const rowSelector = `.llm-standalone-conv-item[data-conversation-key="${sendingKey}"]`;
    let during: Record<string, unknown> = {};

    await api.withPendingStandaloneSend(QUESTION, async () => {
      // Read once the send is pending, after any title it seeds itself.
      const titleBefore = await storedTitle(sendingKey);
      const row = await waitFor(
        () => doc.querySelector<HTMLElement>(rowSelector),
        "the generating chat's sidebar row",
      );
      row
        .querySelector<HTMLButtonElement>(".llm-standalone-conv-rename")!
        .click();
      // A dialog that wrongly opens does so within this wait.
      await Zotero.Promise.delay(500);
      during = {
        dialogOpened: Boolean(
          doc.querySelector(".llm-conversation-rename-dialog"),
        ),
        status: doc.querySelector("#llm-status")?.textContent || "",
        titleBefore,
        titleDuring: await storedTitle(sendingKey),
      };
      // Close a wrongly opened dialog so the send can settle.
      doc
        .querySelector<HTMLButtonElement>(
          ".llm-conversation-rename-dialog .llm-modal-cancel",
        )
        ?.click();
    });

    const detail = JSON.stringify(during);
    assert.isFalse(during.dialogOpened, `no rename dialog opens: ${detail}`);
    assert.equal(during.status, GENERATING_STATUS, detail);
    assert.equal(
      during.titleDuring,
      during.titleBefore,
      `the stored title is unchanged: ${detail}`,
    );

    // Once the send has settled, the same rename button renames the chat.
    await renameFromSidebar(doc, rowSelector, TITLE_AFTER_REPLY);
    const deadline = Date.now() + 5000;
    let titleAfter = await storedTitle(sendingKey);
    while (titleAfter !== TITLE_AFTER_REPLY && Date.now() < deadline) {
      await Zotero.Promise.delay(25);
      titleAfter = await storedTitle(sendingKey);
    }
    assert.equal(titleAfter, TITLE_AFTER_REPLY);
  });
});
