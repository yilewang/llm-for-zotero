import { assert } from "chai";
import type {
  ChatAttachment,
  PaperContextRef,
  SelectedTextContext,
} from "../src/modules/contextPanel/types";
import { createSendFlowController } from "../src/modules/contextPanel/setupHandlers/controllers/sendFlowController";

describe("sendFlowController", function () {
  const item = { id: 101 } as unknown as Zotero.Item;
  const selectedPaper: PaperContextRef = {
    itemId: 12,
    contextItemId: 34,
    title: "Pinned paper",
  };
  const selectedFile: ChatAttachment = {
    id: "file-1",
    name: "notes.md",
    mimeType: "text/markdown",
    sizeBytes: 20,
    category: "markdown",
  };
  const selectedTextContexts: SelectedTextContext[] = [
    { text: "selected text", source: "pdf" },
  ];

  function createBaseDeps(overrides: Record<string, unknown> = {}) {
    const inputBox = { value: "ask question" } as HTMLTextAreaElement;
    let sendCalled = 0;
    let editCalled = 0;
    let retainImageCalled = 0;
    let retainPaperCalled = 0;
    let retainFileCalled = 0;
    let retainTextCalled = 0;
    let setActiveEditSessionCalls = 0;

    const deps = {
      body: {} as Element,
      inputBox,
      getItem: () => item,
      closeSlashMenu: () => undefined,
      closePaperPicker: () => undefined,
      getSelectedTextContextEntries: () => selectedTextContexts,
      getSelectedPaperContexts: () => [selectedPaper],
      getPinnedPaperContexts: () => [selectedPaper],
      getSelectedFiles: () => [selectedFile],
      getSelectedImages: () => ["data:image/png;base64,AAA"],
      resolvePromptText: () => "ask question",
      buildQuestionWithSelectedTextContexts: (
        _selectedTexts: string[],
        _sources: unknown,
        promptText: string,
      ) => `${promptText} (with selected text)`,
      buildModelPromptWithFileContext: (
        question: string,
        attachments: ChatAttachment[],
      ) => `${question} [files=${attachments.length}]`,
      isGlobalMode: () => false,
      normalizeConversationTitleSeed: (raw: unknown) => String(raw || ""),
      getConversationKey: () => item.id,
      touchGlobalConversationTitle: async () => undefined,
      touchPaperConversationTitle: async () => undefined,
      getSelectedProfile: () => null,
      getCurrentModelName: () => "",
      isScreenshotUnsupportedModel: () => false,
      getSelectedReasoning: () => undefined,
      getAdvancedModelParams: () => undefined,
      getActiveEditSession: () => null,
      setActiveEditSession: () => {
        setActiveEditSessionCalls += 1;
      },
      getLatestEditablePair: async () => null,
      editLatestUserMessageAndRetry: async () => {
        editCalled += 1;
        return "ok" as const;
      },
      sendQuestion: async () => {
        sendCalled += 1;
      },
      retainPinnedImageState: () => {
        retainImageCalled += 1;
      },
      retainPinnedPaperState: () => {
        retainPaperCalled += 1;
      },
      retainPinnedFileState: () => {
        retainFileCalled += 1;
      },
      retainPinnedTextState: () => {
        retainTextCalled += 1;
      },
      updatePaperPreviewPreservingScroll: () => undefined,
      updateFilePreviewPreservingScroll: () => undefined,
      updateImagePreviewPreservingScroll: () => undefined,
      updateSelectedTextPreviewPreservingScroll: () => undefined,
      scheduleAttachmentGc: () => undefined,
      refreshGlobalHistoryHeader: () => undefined,
      setStatusMessage: () => undefined,
      editStaleStatusText: "stale",
      ...overrides,
    };

    const controller = createSendFlowController(deps as any);
    return {
      controller,
      inputBox,
      getCounts: () => ({
        sendCalled,
        editCalled,
        retainImageCalled,
        retainPaperCalled,
        retainFileCalled,
        retainTextCalled,
        setActiveEditSessionCalls,
      }),
    };
  }

  it("uses retain-pinned callbacks for normal send flow", async function () {
    const { controller, inputBox, getCounts } = createBaseDeps();
    await controller.doSend();
    const counts = getCounts();

    assert.equal(inputBox.value, "");
    assert.equal(counts.sendCalled, 1);
    assert.equal(counts.editCalled, 0);
    assert.equal(counts.retainImageCalled, 1);
    assert.equal(counts.retainPaperCalled, 1);
    assert.equal(counts.retainFileCalled, 1);
    assert.equal(counts.retainTextCalled, 1);
  });

  it("uses retain-pinned callbacks for edit-latest flow", async function () {
    const { controller, inputBox, getCounts } = createBaseDeps({
      getActiveEditSession: () => ({
        conversationKey: item.id,
        userTimestamp: 10,
        assistantTimestamp: 20,
      }),
      getLatestEditablePair: async () => ({
        conversationKey: item.id,
        pair: {
          userMessage: { timestamp: 10 },
          assistantMessage: { timestamp: 20, streaming: false },
        },
      }),
    });
    await controller.doSend();
    const counts = getCounts();

    assert.equal(inputBox.value, "");
    assert.equal(counts.sendCalled, 0);
    assert.equal(counts.editCalled, 1);
    assert.equal(counts.retainImageCalled, 1);
    assert.equal(counts.retainPaperCalled, 1);
    assert.equal(counts.retainFileCalled, 1);
    assert.equal(counts.retainTextCalled, 1);
    assert.isAtLeast(counts.setActiveEditSessionCalls, 1);
  });
});
