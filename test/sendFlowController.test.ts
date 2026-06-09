import { assert } from "chai";
import type {
  ChatAttachment,
  CollectionContextRef,
  PaperContextRef,
  ResolvedContextSource,
  SelectedTextContext,
  TagContextRef,
} from "../src/modules/contextPanel/types";
import { includeAutoLoadedPaperContextForTests } from "../src/modules/contextPanel/chat";
import { createSendFlowController } from "../src/modules/contextPanel/setupHandlers/controllers/sendFlowController";
import { FULL_PDF_UNSUPPORTED_MESSAGE } from "../src/modules/contextPanel/pdfSupportMessages";

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
  const selectedTag: TagContextRef = {
    name: "Stable",
    normalizedName: "stable",
    libraryID: 1,
  };

  it("uses explicit Markdown source context before ambient reader context", function () {
    const currentItem = {
      id: 707,
      isAttachment: () => false,
      isRegularItem: () => true,
    } as unknown as Zotero.Item;
    const activePdfReaderItem = {
      id: 909,
      parentID: 707,
      attachmentContentType: "application/pdf",
      attachmentFilename: "active.pdf",
      isAttachment: () => true,
      isRegularItem: () => false,
      getField: () => "active.pdf",
    } as unknown as Zotero.Item;
    const markdownContext: PaperContextRef = {
      itemId: 707,
      contextItemId: 808,
      title: "Parent paper",
      attachmentTitle: "test",
      contentSourceMode: "markdown",
    };

    const result = includeAutoLoadedPaperContextForTests(
      currentItem,
      [],
      undefined,
      undefined,
      {
        contextItem: activePdfReaderItem,
        paperContext: markdownContext,
        statusText: "using the selected Markdown attachment as context",
      },
    );

    assert.lengthOf(result.paperContexts, 1);
    assert.equal(result.paperContexts[0].itemId, markdownContext.itemId);
    assert.equal(
      result.paperContexts[0].contextItemId,
      markdownContext.contextItemId,
    );
    assert.equal(result.paperContexts[0].contentSourceMode, "markdown");
    assert.lengthOf(result.fullTextPaperContexts, 1);
    assert.equal(
      result.fullTextPaperContexts[0].contextItemId,
      markdownContext.contextItemId,
    );
    assert.equal(result.fullTextPaperContexts[0].contentSourceMode, "markdown");
  });

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
    let lastSentImages: string[] | undefined;
    let lastSentAttachments: ChatAttachment[] | undefined;
    let lastSentModelAttachments: ChatAttachment[] | undefined;
    let lastSentContextSource: ResolvedContextSource | null | undefined;
    let lastEditRuntimeMode = "";
    let lastEditImages: string[] | undefined;
    let lastEditAttachments: ChatAttachment[] | undefined;
    let lastEditModelAttachments: ChatAttachment[] | undefined;
    let lastEditPdfUploadSystemMessages: string[] | undefined;
    let lastEditContextSource: ResolvedContextSource | null | undefined;
    let lastSentCollectionContexts: CollectionContextRef[] | undefined;
    let lastSentTagContexts: TagContextRef[] | undefined;
    let lastEditCollectionContexts: CollectionContextRef[] | undefined;
    let lastEditTagContexts: TagContextRef[] | undefined;
    let lastStatus: { message: string; level: string } | null = null;
    const statuses: Array<{ message: string; level: string }> = [];

    const deps = {
      body: {} as Element,
      inputBox,
      getItem: () => item,
      resolveContextSource: async () => ({
        contextItem: item,
        paperContext: null,
        statusText: "",
      }),
      closeSlashMenu: () => undefined,
      closePaperPicker: () => undefined,
      getSelectedTextContextEntries: () => selectedTextContexts,
      getSelectedPaperContexts: () => [selectedPaper],
      getSelectedCollectionContexts: () => [],
      getSelectedTagContexts: () => [],
      getFullTextPaperContexts: () => [selectedPaper],
      getPdfModePaperContexts: () => [],
      resolvePdfPaperAttachments: async () => [],
      renderPdfPagesAsImages: async () => [],
      getModelPdfSupport: () => "none" as const,
      uploadPdfForProvider: async () => null,
      resolvePdfBytes: async () => new Uint8Array(),
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
        lastEditImages = opts.screenshotImages;
        lastEditAttachments = opts.attachments;
        lastEditModelAttachments = opts.modelAttachments;
        lastEditPdfUploadSystemMessages = opts.pdfUploadSystemMessages;
        lastEditCollectionContexts = opts.selectedCollectionContexts;
        lastEditTagContexts = opts.selectedTagContexts;
        lastEditContextSource = opts.contextSource;
        return "ok" as const;
      },
      sendQuestion: async (opts: any) => {
        sendCalled += 1;
        lastSentQuestion = opts.question;
        lastRuntimeMode = opts.runtimeMode || "";
        lastSentAuthMode = opts.authMode || "";
        lastSentProviderProtocol = opts.providerProtocol || "";
        lastSentModelProviderLabel = opts.modelProviderLabel || "";
        lastSentImages = opts.images;
        lastSentAttachments = opts.attachments;
        lastSentModelAttachments = opts.modelAttachments;
        lastSentCollectionContexts = opts.selectedCollectionContexts;
        lastSentTagContexts = opts.selectedTagContexts;
        lastSentContextSource = opts.contextSource;
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
        statuses.push({ message, level });
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
        lastSentImages,
        lastSentAttachments,
        lastSentModelAttachments,
        lastSentCollectionContexts,
        lastSentTagContexts,
        lastSentContextSource,
      }),
      getLastEditRuntimeMode: () => lastEditRuntimeMode,
      getLastEditImages: () => lastEditImages,
      getLastEditAttachments: () => lastEditAttachments,
      getLastEditModelAttachments: () => lastEditModelAttachments,
      getLastEditPdfUploadSystemMessages: () => lastEditPdfUploadSystemMessages,
      getLastEditCollectionContexts: () => lastEditCollectionContexts,
      getLastEditTagContexts: () => lastEditTagContexts,
      getLastEditContextSource: () => lastEditContextSource,
      getLastStatus: () => lastStatus,
      getStatuses: () => statuses.slice(),
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

  it("awaits the resolved context source before selecting paper contexts", async function () {
    const resolvedContextSource: ResolvedContextSource = {
      contextItem: { id: 404 } as unknown as Zotero.Item,
      paperContext: null,
      statusText: "resolved",
    };
    let resolverFinished = false;
    const { controller, getLastSend } = createBaseDeps({
      resolveContextSource: async () => {
        await Promise.resolve();
        resolverFinished = true;
        return resolvedContextSource;
      },
      getSelectedPaperContexts: () => {
        assert.isTrue(resolverFinished);
        return [selectedPaper];
      },
    });

    await controller.doSend();

    assert.deepEqual(
      getLastSend().lastSentContextSource,
      resolvedContextSource,
    );
  });

  it("passes the resolved context source into latest-turn edit retries", async function () {
    const resolvedContextSource: ResolvedContextSource = {
      contextItem: { id: 505 } as unknown as Zotero.Item,
      paperContext: null,
      statusText: "resolved",
    };
    const { controller, getLastEditContextSource } = createBaseDeps({
      resolveContextSource: async () => resolvedContextSource,
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

    assert.deepEqual(getLastEditContextSource(), resolvedContextSource);
  });

  it("passes explicit Markdown source context through sends and edit retries", async function () {
    const markdownItem = { id: 808 } as unknown as Zotero.Item;
    const markdownContext: PaperContextRef = {
      itemId: 707,
      contextItemId: 808,
      title: "Parent paper",
      attachmentTitle: "test",
      contentSourceMode: "markdown",
    };
    const markdownSource: ResolvedContextSource = {
      contextItem: markdownItem,
      paperContext: markdownContext,
      statusText: "using the selected Markdown attachment as context",
    };
    const sendCase = createBaseDeps({
      resolveContextSource: async () => markdownSource,
      getSelectedPaperContexts: () => [],
      getFullTextPaperContexts: () => [],
    });

    await sendCase.controller.doSend();

    assert.deepEqual(
      sendCase.getLastSend().lastSentContextSource,
      markdownSource,
    );

    const editCase = createBaseDeps({
      resolveContextSource: async () => markdownSource,
      getSelectedPaperContexts: () => [],
      getFullTextPaperContexts: () => [],
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

    await editCase.controller.doSend();

    assert.deepEqual(editCase.getLastEditContextSource(), markdownSource);
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
    const { controller, inputBox, getCounts, getLastEditRuntimeMode } =
      createBaseDeps({
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

  it("blocks provider-upload full-PDF mode in latest-turn edit retries", async function () {
    const {
      controller,
      getCounts,
      getLastStatus,
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
      getModelPdfSupport: () => "none" as const,
      resolvePdfPaperAttachments: async () => [
        {
          id: "pdf-paper-34-1",
          name: "paper.pdf",
          mimeType: "application/pdf",
          sizeBytes: 123,
          category: "pdf",
          storedPath: "/tmp/paper.pdf",
        },
      ],
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

    assert.equal(getCounts().editCalled, 0);
    assert.deepEqual(getLastStatus(), {
      message: FULL_PDF_UNSUPPORTED_MESSAGE,
      level: "error",
    });
    assert.isUndefined(getLastEditPdfUploadSystemMessages());
  });

  it("blocks PDF-mode paper chips for third-party providers", async function () {
    const pdfAttachment: ChatAttachment = {
      id: "pdf-paper-34-1",
      name: "paper.pdf",
      mimeType: "application/pdf",
      sizeBytes: 123,
      category: "pdf",
      storedPath: "/tmp/paper.pdf",
    };
    const { controller, getCounts, getStatuses } = createBaseDeps({
      getSelectedFiles: () => [],
      getSelectedImages: () => [],
      getFullTextPaperContexts: () => [],
      getPdfModePaperContexts: () => [selectedPaper],
      getSelectedProfile: () => ({
        entryId: "entry-1",
        model: "third-party-vision",
        apiBase: "https://openrouter.ai/api/v1",
        apiKey: "test-key",
        providerLabel: "OpenRouter",
        authMode: "api_key",
        providerProtocol: "openai_chat_compat",
      }),
      getModelPdfSupport: () => "none" as const,
      resolvePdfPaperAttachments: async () => [pdfAttachment],
      renderPdfPagesAsImages: async () => {
        throw new Error("should not render full PDF pages");
      },
    });

    await controller.doSend();

    assert.equal(getCounts().sendCalled, 0);
    assert.deepInclude(getStatuses(), {
      message: FULL_PDF_UNSUPPORTED_MESSAGE,
      level: "error",
    });
  });

  it("blocks direct uploaded PDFs on third-party providers", async function () {
    const uploadedPdf: ChatAttachment = {
      id: "upload-1",
      name: "upload.pdf",
      mimeType: "application/pdf",
      sizeBytes: 456,
      category: "pdf",
      storedPath: "/tmp/upload.pdf",
    };
    let renderAttachmentCalls = 0;
    const { controller, getCounts, getStatuses } = createBaseDeps({
      getSelectedPaperContexts: () => [],
      getFullTextPaperContexts: () => [],
      getSelectedFiles: () => [uploadedPdf],
      getSelectedImages: () => [],
      getSelectedProfile: () => ({
        entryId: "entry-1",
        model: "third-party-vision",
        apiBase: "https://openrouter.ai/api/v1",
        apiKey: "test-key",
        providerLabel: "OpenRouter",
        authMode: "api_key",
        providerProtocol: "openai_chat_compat",
      }),
      getModelPdfSupport: () => "none" as const,
      renderPdfPagesAsImages: async () => {
        renderAttachmentCalls += 1;
        return ["data:image/png;base64,SHOULD_NOT_RENDER"];
      },
    });

    await controller.doSend();

    assert.equal(getCounts().sendCalled, 0);
    assert.equal(renderAttachmentCalls, 0);
    assert.deepInclude(getStatuses(), {
      message: FULL_PDF_UNSUPPORTED_MESSAGE,
      level: "error",
    });
  });

  it("blocks mixed direct and paper PDFs on third-party providers", async function () {
    const uploadedPdf: ChatAttachment = {
      id: "upload-1",
      name: "upload.pdf",
      mimeType: "application/pdf",
      sizeBytes: 456,
      category: "pdf",
      storedPath: "/tmp/upload.pdf",
    };
    const paperPdf: ChatAttachment = {
      id: "pdf-paper-34-1",
      name: "paper.pdf",
      mimeType: "application/pdf",
      sizeBytes: 123,
      category: "pdf",
      storedPath: "/tmp/paper.pdf",
    };
    const { controller, getCounts, getStatuses } = createBaseDeps({
      getSelectedFiles: () => [uploadedPdf],
      getSelectedImages: () => [],
      getFullTextPaperContexts: () => [],
      getPdfModePaperContexts: () => [selectedPaper],
      getSelectedProfile: () => ({
        entryId: "entry-1",
        model: "third-party-vision",
        apiBase: "https://openrouter.ai/api/v1",
        apiKey: "test-key",
        providerLabel: "OpenRouter",
        authMode: "api_key",
        providerProtocol: "openai_chat_compat",
      }),
      getModelPdfSupport: () => "none" as const,
      resolvePdfPaperAttachments: async () => [paperPdf],
      renderPdfPagesAsImages: async () => {
        throw new Error("should not render full PDF pages");
      },
    });

    await controller.doSend();

    assert.equal(getCounts().sendCalled, 0);
    assert.deepInclude(getStatuses(), {
      message: FULL_PDF_UNSUPPORTED_MESSAGE,
      level: "error",
    });
  });

  it("sends direct uploaded PDFs on official native providers without a warning", async function () {
    const uploadedPdf: ChatAttachment = {
      id: "upload-1",
      name: "upload.pdf",
      mimeType: "application/pdf",
      sizeBytes: 456,
      category: "pdf",
      storedPath: "/tmp/upload.pdf",
    };
    const { controller, getCounts, getLastSend, getStatuses } = createBaseDeps({
      getSelectedPaperContexts: () => [],
      getFullTextPaperContexts: () => [],
      getSelectedFiles: () => [uploadedPdf],
      getSelectedImages: () => [],
      getSelectedProfile: () => ({
        entryId: "entry-1",
        model: "gpt-4o",
        apiBase: "https://api.openai.com/v1/responses",
        apiKey: "test-key",
        providerLabel: "OpenAI",
        authMode: "api_key",
        providerProtocol: "responses_api",
      }),
      getModelPdfSupport: () => "native" as const,
    });

    await controller.doSend();

    assert.equal(getCounts().sendCalled, 1);
    assert.deepEqual(getLastSend().lastSentAttachments, [uploadedPdf]);
    assert.deepEqual(getLastSend().lastSentModelAttachments, [uploadedPdf]);
    assert.notDeepInclude(getStatuses(), {
      message: FULL_PDF_UNSUPPORTED_MESSAGE,
      level: "error",
    });
  });

  it("blocks PDF sends when the provider has no native PDF support", async function () {
    const { controller, inputBox, getCounts, getLastStatus } = createBaseDeps({
      getSelectedFiles: () => [],
      getFullTextPaperContexts: () => [],
      getPdfModePaperContexts: () => [selectedPaper],
      getSelectedProfile: () => ({
        entryId: "entry-1",
        model: "deepseek-v4-flash",
        apiBase: "https://api.deepseek.com/v1",
        apiKey: "test-key",
        providerLabel: "DeepSeek",
        authMode: "api_key",
        providerProtocol: "openai_chat_compat",
      }),
      getModelPdfSupport: () => "none" as const,
    });

    await controller.doSend();

    assert.equal(getCounts().sendCalled, 0);
    assert.equal(getCounts().editCalled, 0);
    assert.equal(inputBox.value, "ask question");
    assert.deepEqual(getLastStatus(), {
      message: FULL_PDF_UNSUPPORTED_MESSAGE,
      level: "error",
    });
  });

  it("does not auto-render PDF-mode papers for third-party providers", async function () {
    const pdfAttachment: ChatAttachment = {
      id: "pdf-paper-34-1",
      name: "paper.pdf",
      mimeType: "application/pdf",
      sizeBytes: 123,
      category: "pdf",
      storedPath: "/tmp/paper.pdf",
    };
    const { controller, getCounts, getLastStatus } = createBaseDeps({
      getSelectedFiles: () => [],
      getSelectedImages: () => [],
      getFullTextPaperContexts: () => [],
      getPdfModePaperContexts: () => [selectedPaper],
      getSelectedProfile: () => ({
        entryId: "entry-1",
        model: "third-party-vision",
        apiBase: "https://openrouter.ai/api/v1",
        apiKey: "test-key",
        providerLabel: "OpenRouter",
        authMode: "api_key",
        providerProtocol: "openai_chat_compat",
      }),
      getModelPdfSupport: () => "none" as const,
      resolvePdfPaperAttachments: async () => [pdfAttachment],
      renderPdfPagesAsImages: async () => {
        throw new Error("should not render full PDF pages");
      },
    });

    await controller.doSend();

    assert.equal(getCounts().sendCalled, 0);
    assert.deepEqual(getLastStatus(), {
      message: FULL_PDF_UNSUPPORTED_MESSAGE,
      level: "error",
    });
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
    assert.equal(
      getLastSend().lastSentQuestion,
      "Please analyze selected collection.",
    );
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

  it("passes selected tags through mixed paper sends", async function () {
    const { controller, getLastSend } = createBaseDeps({
      getSelectedTagContexts: () => [selectedTag],
    });

    await controller.doSend();

    assert.equal(getLastSend().lastRuntimeMode, "chat");
    assert.deepEqual(getLastSend().lastSentTagContexts, [selectedTag]);
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

  it("passes selected tags through latest-turn edit retries", async function () {
    const { controller, getLastEditTagContexts } = createBaseDeps({
      getSelectedTagContexts: () => [selectedTag],
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

    assert.deepEqual(getLastEditTagContexts(), [selectedTag]);
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
        "Web chat does not support Zotero collection or tag context. Remove the scope chip and try again.",
      level: "error",
    });
  });

  it("allows text-like pinned files in Codex native app-server", async function () {
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

  it("blocks pinned PDFs in Codex native app-server before sending", async function () {
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
        "Codex native app-server does not support pinned PDF or binary file attachments directly (paper.pdf). Remove them and try again.",
      level: "error",
    });
  });

  it("blocks PDF-mode papers in Codex native app-server", async function () {
    const pdfAttachment: ChatAttachment = {
      id: "pdf-paper-34-1",
      name: "paper.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024,
      category: "pdf",
      storedPath: "/tmp/paper.pdf",
    };
    const { controller, getCounts, getLastStatus, getStatuses } =
      createBaseDeps({
        getSelectedTextContextEntries: () => [],
        getSelectedFiles: () => [],
        getSelectedImages: () => [],
        getFullTextPaperContexts: () => [],
        getPdfModePaperContexts: () => [selectedPaper],
        getSelectedProfile: () => ({
          entryId: "entry-1",
          model: "gpt-5.4",
          apiBase: "https://chatgpt.com/backend-api/codex/responses",
          apiKey: "",
          providerLabel: "Codex",
          authMode: "codex_app_server",
          providerProtocol: "codex_responses",
        }),
        getModelPdfSupport: () => "none" as const,
        resolvePdfPaperAttachments: async () => [pdfAttachment],
        renderPdfPagesAsImages: async () => {
          throw new Error("should not render full PDF pages");
        },
      });

    await controller.doSend();

    assert.equal(getCounts().sendCalled, 0);
    assert.deepEqual(getLastStatus(), {
      message: FULL_PDF_UNSUPPORTED_MESSAGE,
      level: "error",
    });
    assert.notInclude(
      getStatuses().map((status) => status.message),
      "Codex native app-server does not support pinned PDF or binary file attachments directly (paper.pdf). Remove them and try again.",
    );
  });

  it("blocks pinned binary files in Codex native app-server latest-turn edit retries", async function () {
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
        "Codex native app-server does not support pinned PDF or binary file attachments directly (archive.zip). Remove them and try again.",
      level: "error",
    });
  });
});
