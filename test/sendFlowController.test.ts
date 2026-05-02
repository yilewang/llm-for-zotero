import { assert } from "chai";
import type {
  ChatAttachment,
  CollectionContextRef,
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
  const selectedCollection: CollectionContextRef = {
    collectionId: 55,
    name: "Methods",
    libraryID: 1,
  };

  function createBaseDeps(overrides: Record<string, unknown> = {}) {
    const inputBox = {
      value: "ask question",
      dataset: {},
    } as HTMLTextAreaElement;
    let draftValue = inputBox.value;
    let sendCalled = 0;
    let editCalled = 0;
    let retainImageCalled = 0;
    let retainPaperStateCalled = 0;
    let consumePaperModeStateCalled = 0;
    let retainFileCalled = 0;
    let retainTextCalled = 0;
    let persistDraftInputCalls = 0;
    let setActiveEditSessionCalls = 0;
    let lastSentQuestion = "";
    let lastRuntimeMode = "";
    let lastSentAuthMode = "";
    let lastSentProviderProtocol = "";
    let lastSentModelProviderLabel = "";
    let lastEditRuntimeMode = "";
    let lastEditPdfUploadSystemMessages: string[] | undefined;
    let lastSentCollectionContexts: CollectionContextRef[] | undefined;
    let lastEditCollectionContexts: CollectionContextRef[] | undefined;
    let lastStatus: { message: string; level: string } | null = null;

    const deps = {
      body: {} as Element,
      inputBox,
      getItem: () => item,
      closeSlashMenu: () => undefined,
      closePaperPicker: () => undefined,
      getSelectedTextContextEntries: () => selectedTextContexts,
      getSelectedPaperContexts: () => [selectedPaper],
      getSelectedCollectionContexts: () => [],
      getFullTextPaperContexts: () => [selectedPaper],
      getPdfModePaperContexts: () => [],
      resolvePdfPaperAttachments: async () => [],
      renderPdfPagesAsImages: async () => [],
      getModelPdfSupport: () => "none" as const,
      uploadPdfForProvider: async () => null,
      resolvePdfBytes: async () => new Uint8Array(),
      encodeBytesBase64: () => "",
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
      isAgentMode: () => false,
      isGlobalMode: () => false,
      isClaudeConversationSystem: () => false,
      isCodexConversationSystem: () => false,
      normalizeConversationTitleSeed: (raw: unknown) => String(raw || ""),
      getConversationKey: () => item.id,
      touchClaudeConversationTitle: async () => undefined,
      touchCodexConversationTitle: async () => undefined,
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
      editLatestUserMessageAndRetry: async (opts: any) => {
        editCalled += 1;
        lastEditRuntimeMode = opts.targetRuntimeMode || "";
        lastEditPdfUploadSystemMessages = opts.pdfUploadSystemMessages;
        lastEditCollectionContexts = opts.selectedCollectionContexts;
        return "ok" as const;
      },
      sendQuestion: async (opts: any) => {
        sendCalled += 1;
        lastSentQuestion = opts.question;
        lastRuntimeMode = opts.runtimeMode || "";
        lastSentAuthMode = opts.authMode || "";
        lastSentProviderProtocol = opts.providerProtocol || "";
        lastSentModelProviderLabel = opts.modelProviderLabel || "";
        lastSentCollectionContexts = opts.selectedCollectionContexts;
      },
      retainPinnedImageState: () => {
        retainImageCalled += 1;
      },
      retainPaperState: () => {
        retainPaperStateCalled += 1;
      },
      consumePaperModeState: () => {
        consumePaperModeStateCalled += 1;
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
      persistDraftInput: () => {
        persistDraftInputCalls += 1;
        draftValue = inputBox.value;
      },
      autoLockGlobalChat: () => undefined,
      autoUnlockGlobalChat: () => undefined,
      setStatusMessage: (message: string, level: string) => {
        lastStatus = { message, level };
      },
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
        retainPaperStateCalled,
        consumePaperModeStateCalled,
        retainFileCalled,
        retainTextCalled,
        persistDraftInputCalls,
        setActiveEditSessionCalls,
      }),
      getDraftValue: () => draftValue,
      getLastSend: () => ({
        lastSentQuestion,
        lastRuntimeMode,
        lastSentAuthMode,
        lastSentProviderProtocol,
        lastSentModelProviderLabel,
        lastSentCollectionContexts,
      }),
      getLastEditRuntimeMode: () => lastEditRuntimeMode,
      getLastEditPdfUploadSystemMessages: () => lastEditPdfUploadSystemMessages,
      getLastEditCollectionContexts: () => lastEditCollectionContexts,
      getLastStatus: () => lastStatus,
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
    assert.equal(counts.consumePaperModeStateCalled, 1);
    assert.equal(counts.retainPaperStateCalled, 1);
    assert.equal(counts.retainFileCalled, 1);
    assert.equal(counts.retainTextCalled, 1);
  });

  it("sends override text while preserving the current draft", async function () {
    const { controller, inputBox, getCounts, getLastSend } = createBaseDeps({
      getSelectedTextContextEntries: () => [],
      getSelectedPaperContexts: () => [],
      getSelectedCollectionContexts: () => [],
      getFullTextPaperContexts: () => [],
      getSelectedFiles: () => [],
      getSelectedImages: () => [],
      resolvePromptText: (text: string) => text,
      buildModelPromptWithFileContext: (question: string) => question,
    });
    inputBox.value = "draft typed while waiting";

    await controller.doSend({
      overrideText: "queued follow-up",
      preserveInputDraft: true,
    });

    assert.equal(getLastSend().lastSentQuestion, "queued follow-up");
    assert.equal(inputBox.value, "draft typed while waiting");
    assert.equal(getCounts().persistDraftInputCalls, 0);
  });

  it("uses retain-pinned callbacks for edit-latest flow", async function () {
    const { controller, inputBox, getCounts, getLastEditRuntimeMode } = createBaseDeps({
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
    assert.equal(counts.consumePaperModeStateCalled, 1);
    assert.equal(counts.retainPaperStateCalled, 1);
    assert.equal(counts.retainFileCalled, 1);
    assert.equal(counts.retainTextCalled, 1);
    assert.isAtLeast(counts.setActiveEditSessionCalls, 1);
    assert.equal(getLastEditRuntimeMode(), "chat");
  });

  it("passes the current runtime mode into latest-turn edit retries", async function () {
    const { controller, getLastEditRuntimeMode } = createBaseDeps({
      isAgentMode: () => true,
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

    assert.equal(getLastEditRuntimeMode(), "agent");
  });

  it("passes provider-uploaded PDF context through latest-turn edit retries", async function () {
    const {
      controller,
      getLastEditPdfUploadSystemMessages,
    } = createBaseDeps({
      getSelectedFiles: () => [],
      getFullTextPaperContexts: () => [],
      getPdfModePaperContexts: () => [selectedPaper],
      getSelectedProfile: () => ({
        entryId: "entry-1",
        model: "kimi-k2.5",
        apiBase: "https://api.moonshot.cn/v1",
        apiKey: "test-key",
        providerLabel: "Kimi",
        authMode: "api_key",
        providerProtocol: "openai_chat_compat",
      }),
      getModelPdfSupport: () => "upload" as const,
      resolvePdfBytes: async () => new Uint8Array([1, 2, 3]),
      uploadPdfForProvider: async () => ({
        systemMessageContent: "uploaded pdf context",
        label: "Uploaded",
      }),
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

    assert.deepEqual(getLastEditPdfUploadSystemMessages(), [
      "uploaded pdf context",
    ]);
  });

  it("persists the cleared draft before preview sync in normal send flow", async function () {
    const { controller, inputBox, getCounts, getDraftValue } = createBaseDeps({
      updatePaperPreviewPreservingScroll: () => {
        inputBox.value = getDraftValue();
      },
      updateFilePreviewPreservingScroll: () => {
        inputBox.value = getDraftValue();
      },
      updateImagePreviewPreservingScroll: () => {
        inputBox.value = getDraftValue();
      },
      updateSelectedTextPreviewPreservingScroll: () => {
        inputBox.value = getDraftValue();
      },
    });

    await controller.doSend();
    const counts = getCounts();

    assert.equal(getDraftValue(), "");
    assert.equal(inputBox.value, "");
    assert.equal(counts.persistDraftInputCalls, 1);
  });

  it("persists the cleared draft before preview sync in edit flow", async function () {
    const { controller, inputBox, getCounts, getDraftValue } = createBaseDeps({
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
      updatePaperPreviewPreservingScroll: () => {
        inputBox.value = getDraftValue();
      },
      updateFilePreviewPreservingScroll: () => {
        inputBox.value = getDraftValue();
      },
      updateImagePreviewPreservingScroll: () => {
        inputBox.value = getDraftValue();
      },
      updateSelectedTextPreviewPreservingScroll: () => {
        inputBox.value = getDraftValue();
      },
    });

    await controller.doSend();
    const counts = getCounts();

    assert.equal(getDraftValue(), "");
    assert.equal(inputBox.value, "");
    assert.equal(counts.persistDraftInputCalls, 1);
  });

  it("sends raw prompt text in agent mode and marks runtime mode as agent", async function () {
    const { controller, getLastSend } = createBaseDeps({
      isAgentMode: () => true,
    });

    await controller.doSend();
    const lastSend = getLastSend();

    assert.equal(lastSend.lastSentQuestion, "ask question");
    assert.equal(lastSend.lastRuntimeMode, "agent");
  });

  it("routes Codex sends through native chat mode with app-server metadata", async function () {
    const { controller, getLastSend } = createBaseDeps({
      getSelectedTextContextEntries: () => [],
      getSelectedPaperContexts: () => [],
      getFullTextPaperContexts: () => [],
      getSelectedFiles: () => [],
      getSelectedImages: () => [],
      isAgentMode: () => true,
      isCodexConversationSystem: () => true,
      getSelectedProfile: () => ({
        entryId: "codex_app_server::gpt-5.4",
        model: "gpt-5.4",
        apiBase: "",
        apiKey: "",
        providerLabel: "Codex",
        authMode: "codex_app_server",
        providerProtocol: "codex_responses",
      }),
      resolvePromptText: (text: string) => text,
      buildModelPromptWithFileContext: (question: string) => question,
    });

    await controller.doSend();
    const lastSend = getLastSend();

    assert.equal(lastSend.lastSentQuestion, "ask question");
    assert.equal(lastSend.lastRuntimeMode, "chat");
    assert.equal(lastSend.lastSentAuthMode, "codex_app_server");
    assert.equal(lastSend.lastSentProviderProtocol, "codex_responses");
    assert.equal(lastSend.lastSentModelProviderLabel, "Codex");
  });

  it("allows collection-only sends and uses the default collection prompt", async function () {
    const { controller, inputBox, getCounts, getLastSend } = createBaseDeps({
      getSelectedTextContextEntries: () => [],
      getSelectedPaperContexts: () => [],
      getSelectedCollectionContexts: () => [selectedCollection],
      getFullTextPaperContexts: () => [],
      getSelectedFiles: () => [],
      getSelectedImages: () => [],
      resolvePromptText: () => "placeholder",
      buildModelPromptWithFileContext: (question: string) => question,
    });
    inputBox.value = "";

    await controller.doSend();

    assert.equal(getCounts().sendCalled, 1);
    assert.equal(getLastSend().lastSentQuestion, "Please analyze selected collection.");
    assert.deepEqual(getLastSend().lastSentCollectionContexts, [
      selectedCollection,
    ]);
  });

  it("passes selected collections through mixed paper sends", async function () {
    const { controller, getLastSend } = createBaseDeps({
      getSelectedCollectionContexts: () => [selectedCollection],
    });

    await controller.doSend();

    assert.equal(getLastSend().lastRuntimeMode, "chat");
    assert.deepEqual(getLastSend().lastSentCollectionContexts, [
      selectedCollection,
    ]);
  });

  it("passes selected collections through latest-turn edit retries", async function () {
    const { controller, getLastEditCollectionContexts } = createBaseDeps({
      getSelectedCollectionContexts: () => [selectedCollection],
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

    assert.deepEqual(getLastEditCollectionContexts(), [selectedCollection]);
  });

  it("blocks collection context for webchat sends", async function () {
    const { controller, inputBox, getCounts, getLastStatus } = createBaseDeps({
      getSelectedProfile: () => ({
        entryId: "entry-1",
        model: "chatgpt-web",
        apiBase: "",
        apiKey: "",
        providerLabel: "ChatGPT",
        authMode: "webchat",
        providerProtocol: "web_sync",
      }),
      getSelectedCollectionContexts: () => [selectedCollection],
    });

    await controller.doSend();

    assert.equal(getCounts().sendCalled, 0);
    assert.equal(getCounts().editCalled, 0);
    assert.equal(inputBox.value, "ask question");
    assert.deepEqual(getLastStatus(), {
      message:
        "Web chat does not support Zotero collection context. Remove the collection and try again.",
      level: "error",
    });
  });

  it("allows text-like pinned files in codex app server chat", async function () {
    const { controller, getCounts, getLastStatus } = createBaseDeps({
      getSelectedProfile: () => ({
        entryId: "entry-1",
        model: "gpt-5.4",
        apiBase: "https://chatgpt.com/backend-api/codex/responses",
        apiKey: "",
        providerLabel: "Codex",
        authMode: "codex_app_server",
        providerProtocol: "codex_responses",
      }),
    });

    await controller.doSend();

    assert.equal(getCounts().sendCalled, 1);
    assert.isNull(getLastStatus());
  });

  it("blocks pinned PDFs in codex app server chat before sending", async function () {
    const blockedAttachment: ChatAttachment = {
      id: "file-2",
      name: "paper.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024,
      category: "pdf",
    };
    const { controller, inputBox, getCounts, getLastStatus } = createBaseDeps({
      getSelectedProfile: () => ({
        entryId: "entry-1",
        model: "gpt-5.4",
        apiBase: "https://chatgpt.com/backend-api/codex/responses",
        apiKey: "",
        providerLabel: "Codex",
        authMode: "codex_app_server",
        providerProtocol: "codex_responses",
      }),
      getSelectedFiles: () => [blockedAttachment],
    });

    await controller.doSend();

    assert.equal(getCounts().sendCalled, 0);
    assert.equal(getCounts().editCalled, 0);
    assert.equal(inputBox.value, "ask question");
    assert.deepEqual(getLastStatus(), {
      message:
        "Codex App Server chat does not support pinned PDF or binary file attachments (paper.pdf). Remove them and try again.",
      level: "error",
    });
  });

  it("blocks pinned binary files in codex app server latest-turn edit retries", async function () {
    const blockedAttachment: ChatAttachment = {
      id: "file-3",
      name: "archive.zip",
      mimeType: "application/zip",
      sizeBytes: 1024,
      category: "file",
    };
    const { controller, getCounts, getLastStatus } = createBaseDeps({
      getSelectedProfile: () => ({
        entryId: "entry-1",
        model: "gpt-5.4",
        apiBase: "https://chatgpt.com/backend-api/codex/responses",
        apiKey: "",
        providerLabel: "Codex",
        authMode: "codex_app_server",
        providerProtocol: "codex_responses",
      }),
      getSelectedFiles: () => [blockedAttachment],
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

    assert.equal(getCounts().sendCalled, 0);
    assert.equal(getCounts().editCalled, 0);
    assert.deepEqual(getLastStatus(), {
      message:
        "Codex App Server chat does not support pinned PDF or binary file attachments (archive.zip). Remove them and try again.",
      level: "error",
    });
  });
});
