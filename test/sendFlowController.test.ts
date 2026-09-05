import { assert } from "chai";
import type {
  ChatAttachment,
  CollectionContextRef,
  Message,
  PaperContextRef,
  ResolvedSelectedTextAnchor,
  ResolvedContextSource,
  SelectedTextContext,
  TagContextRef,
} from "../src/modules/contextPanel/types";
import {
  buildAgentRuntimeRequestForTests,
  deriveConversationComposeContextSnapshotForTests,
  getMessageDisplayPaperContextsForTests,
  includeAutoLoadedPaperContextForTests,
  normalizeStoredPaperContextRoutesForTests,
} from "../src/modules/contextPanel/chat";
import { createSendFlowController } from "../src/modules/contextPanel/setupHandlers/controllers/sendFlowController";
import { FULL_PDF_UNSUPPORTED_MESSAGE } from "../src/modules/contextPanel/pdfSupportMessages";
import { setUserSkills, type AgentSkill } from "../src/agent/skills";
import type { LocalDocumentResource } from "../src/shared/types";
import { resolvePromptText as resolveProductionPromptText } from "../src/modules/contextPanel/textUtils";

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

  afterEach(function () {
    setUserSkills([]);
  });

  function makeTestSkill(
    id: string,
    overrides: Partial<AgentSkill> = {},
  ): AgentSkill {
    return {
      id,
      description: `${id} description`,
      version: 1,
      patterns: [],
      contexts: ["any"],
      activation: "auto",
      instruction: `${id} instructions`,
      source: "personal",
      ...overrides,
    };
  }

  it("uses explicit Markdown source context before ambient reader context", function () {
    const currentItem = {
      id: 707,
      libraryID: 1,
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
    assert.deepInclude(result.activePaperContext, {
      libraryID: 1,
      itemId: 707,
      contextItemId: 808,
    });
    assert.lengthOf(result.fullTextPaperContexts, 1);
    assert.equal(
      result.fullTextPaperContexts[0].contextItemId,
      markdownContext.contextItemId,
    );
    assert.equal(result.fullTextPaperContexts[0].contentSourceMode, "markdown");
  });

  it("keeps an auto-loaded raw PDF out of ordinary paper pipelines", function () {
    const currentItem = {
      id: 707,
      libraryID: 1,
      isAttachment: () => false,
      isRegularItem: () => true,
    } as unknown as Zotero.Item;
    const pdfContext: PaperContextRef = {
      itemId: 707,
      contextItemId: 808,
      title: "Raw PDF paper",
      contentSourceMode: "pdf",
    };

    const result = includeAutoLoadedPaperContextForTests(
      currentItem,
      [],
      [],
      new Set(["1:707:808"]),
      {
        contextItem: null,
        paperContext: pdfContext,
        statusText: "using the selected PDF",
      },
    );

    assert.deepEqual(result.paperContexts, []);
    assert.deepEqual(result.fullTextPaperContexts, []);
    assert.deepInclude(result.activePaperContext, {
      libraryID: 1,
      itemId: 707,
      contextItemId: 808,
    });
  });

  it("does not invent an active paper for a standalone-note turn", function () {
    const previousZotero = globalThis.Zotero;
    globalThis.Zotero = {
      Items: { get: () => null },
      getMainWindow: () => null,
      getActiveZoteroPane: () => null,
    } as unknown as typeof Zotero;
    try {
      const standaloneNote = {
        id: 700,
        libraryID: 1,
        parentID: false,
        isNote: () => true,
        getDisplayTitle: () => "Standalone note",
      } as unknown as Zotero.Item;
      const selectedPaper = {
        libraryID: 1,
        itemId: 42,
        contextItemId: 101,
        title: "Selected paper",
      };

      const result = includeAutoLoadedPaperContextForTests(
        standaloneNote,
        [selectedPaper],
        [selectedPaper],
      );

      assert.isUndefined(result.activePaperContext);
      assert.deepInclude(result.paperContexts[0], selectedPaper);
    } finally {
      globalThis.Zotero = previousZotero;
    }
  });

  it("keeps the exact active PDF identity through request enrichment", async function () {
    const firstPdf: PaperContextRef = {
      libraryID: 1,
      itemId: 42,
      contextItemId: 100,
      title: "Parent paper",
    };
    const activePdf: PaperContextRef = {
      libraryID: 1,
      itemId: 42,
      contextItemId: 101,
      title: "Parent paper",
      contentSourceMode: "pdf",
    };
    const previousZotero = globalThis.Zotero;
    globalThis.Zotero = {
      Items: { get: () => null },
      Prefs: { get: () => undefined },
    } as unknown as typeof Zotero;
    try {
      const request = await buildAgentRuntimeRequestForTests({
        conversationKey: 7001,
        item: {
          id: 9001,
          libraryID: 1,
          isAttachment: () => false,
          isRegularItem: () => true,
          isNote: () => false,
        } as unknown as Zotero.Item,
        userText: "Compare these papers.",
        selectedTexts: [],
        activePaperContext: activePdf,
        paperContexts: [firstPdf],
        pdfPaperContexts: [activePdf],
        fullTextPaperContexts: [],
        attachments: undefined,
        screenshots: undefined,
        effectiveRequestConfig: {
          model: "gpt-5",
          apiBase: "https://api.openai.com/v1",
          apiKey: "test",
          authMode: "api_key",
          providerProtocol: "responses_api",
          modelEntryId: "openai:gpt-5",
          modelProviderLabel: "OpenAI",
        },
        history: [],
      });

      assert.deepInclude(request.activePaperContext, {
        libraryID: 1,
        itemId: 42,
        contextItemId: 101,
      });
      assert.notDeepInclude(request.activePaperContext, firstPdf);
    } finally {
      globalThis.Zotero = previousZotero;
    }
  });

  it("repairs legacy stored rows that duplicated a raw PDF into text routes", function () {
    const pdfContext: PaperContextRef = {
      itemId: 707,
      contextItemId: 808,
      title: "Raw PDF paper",
      contentSourceMode: "pdf",
    };

    const normalized = normalizeStoredPaperContextRoutesForTests({
      paperContexts: [pdfContext],
      pdfPaperContexts: [pdfContext],
      fullTextPaperContexts: [pdfContext],
    });

    assert.deepEqual(normalized.paperContexts, []);
    assert.deepEqual(normalized.fullTextPaperContexts, []);
    assert.lengthOf(normalized.pdfPaperContexts, 1);
    assert.deepInclude(normalized.pdfPaperContexts[0], pdfContext);
  });

  it("keeps native-provider PDFs on the attachment transport in Agent mode", async function () {
    const pdfContext: PaperContextRef = {
      itemId: 707,
      contextItemId: 808,
      title: "Native provider PDF",
      contentSourceMode: "pdf",
    };
    const pdfAttachment: ChatAttachment = {
      id: "pdf-paper-808-1",
      name: "native-provider.pdf",
      mimeType: "application/pdf",
      sizeBytes: 128,
      category: "pdf",
      storedPath: "/tmp/native-provider.pdf",
    };
    const previousZotero = globalThis.Zotero;
    globalThis.Zotero = {
      Items: { get: () => null },
      Prefs: { get: () => undefined },
    } as unknown as typeof Zotero;
    let runtimeRequest;
    try {
      runtimeRequest = await buildAgentRuntimeRequestForTests({
        conversationKey: 707,
        item: {
          id: 707,
          libraryID: 1,
          isAttachment: () => false,
          isRegularItem: () => true,
          isNote: () => false,
        } as unknown as Zotero.Item,
        userText: "Analyze the selected PDF.",
        selectedTexts: [],
        paperContexts: [],
        pdfPaperContexts: [pdfContext],
        fullTextPaperContexts: [],
        attachments: [pdfAttachment],
        screenshots: undefined,
        effectiveRequestConfig: {
          model: "gpt-5",
          apiBase: "https://api.openai.com/v1",
          apiKey: "test",
          authMode: "api_key",
          providerProtocol: "responses_api",
          modelEntryId: "openai:gpt-5",
          modelProviderLabel: "OpenAI",
        },
        history: [],
      });
    } finally {
      globalThis.Zotero = previousZotero;
    }

    assert.deepEqual(runtimeRequest.attachments, [pdfAttachment]);
    assert.isUndefined(runtimeRequest.localDocuments);
    assert.isUndefined(runtimeRequest.pdfPaperContexts);
  });

  it("splits mixed retry identities into exactly one ordinary, PDF, or full-text lane", function () {
    const text = {
      itemId: 1,
      contextItemId: 11,
      title: "Text",
      contentSourceMode: "text" as const,
    };
    const pdf = {
      itemId: 2,
      contextItemId: 22,
      title: "PDF",
      contentSourceMode: "pdf" as const,
    };
    const full = {
      itemId: 3,
      contextItemId: 33,
      title: "Full",
      contentSourceMode: "mineru" as const,
    };

    const normalized = normalizeStoredPaperContextRoutesForTests({
      paperContexts: [text, pdf, full],
      pdfPaperContexts: [pdf],
      fullTextPaperContexts: [full, pdf],
    });

    assert.lengthOf(normalized.paperContexts, 1);
    assert.lengthOf(normalized.pdfPaperContexts, 1);
    assert.lengthOf(normalized.fullTextPaperContexts, 1);
    assert.deepInclude(normalized.paperContexts[0], text);
    assert.deepInclude(normalized.pdfPaperContexts[0], pdf);
    assert.deepInclude(normalized.fullTextPaperContexts[0], full);
  });

  it("renders every sent paper route exactly once after stored-route normalization", function () {
    const activePaper = {
      itemId: 1,
      contextItemId: 11,
      title: "Active paper",
    };
    const libraryPaper = {
      itemId: 2,
      contextItemId: 22,
      title: "Library paper",
      contentSourceMode: "mineru" as const,
    };
    const pdfPaper = {
      itemId: 3,
      contextItemId: 33,
      title: "PDF paper",
      contentSourceMode: "pdf" as const,
    };
    const storedRoutes = normalizeStoredPaperContextRoutesForTests({
      paperContexts: [activePaper, libraryPaper],
      pdfPaperContexts: [pdfPaper],
      fullTextPaperContexts: [activePaper, libraryPaper],
    });

    const display = getMessageDisplayPaperContextsForTests(storedRoutes);

    assert.deepEqual(
      display.map((paper) => paper.title),
      ["Active paper", "Library paper", "PDF paper"],
    );
    assert.deepEqual(
      display.map((paper) => `${paper.itemId}:${paper.contextItemId}`),
      ["1:11", "2:22", "3:33"],
    );
  });

  it("derives a retrieval-only continuation snapshot from the latest user turn", function () {
    const activePaper = {
      itemId: 1,
      contextItemId: 11,
      title: "Active paper",
    };
    const ordinaryPaper = {
      itemId: 2,
      contextItemId: 22,
      title: "Ordinary paper",
    };
    const fullTextPaper = {
      itemId: 3,
      contextItemId: 33,
      title: "Full-text paper",
      contentSourceMode: "mineru" as const,
    };
    const pdfPaper = {
      itemId: 4,
      contextItemId: 44,
      title: "PDF paper",
      contentSourceMode: "pdf" as const,
    };
    const latestUserMessage: Message = {
      role: "user",
      text: "Continue with these sources",
      timestamp: 200,
      paperContexts: [activePaper, ordinaryPaper],
      fullTextPaperContexts: [activePaper, fullTextPaper],
      pdfPaperContexts: [pdfPaper],
      selectedCollectionContexts: [selectedCollection, selectedCollection],
      selectedTagContexts: [selectedTag, selectedTag],
    };

    const snapshot = deriveConversationComposeContextSnapshotForTests(
      123,
      [
        {
          role: "user",
          text: "Older context",
          timestamp: 100,
          paperContexts: [{ itemId: 9, contextItemId: 99, title: "Old" }],
        },
        latestUserMessage,
        { role: "assistant", text: "Answer", timestamp: 300 },
      ],
      activePaper,
    );

    assert.deepEqual(
      snapshot.paperContexts.map((paper) => paper.title),
      ["Ordinary paper", "Full-text paper", "PDF paper"],
    );
    assert.isTrue(
      snapshot.paperContexts.every(
        (paper) => paper.contentSourceMode === undefined,
      ),
    );
    assert.deepEqual(snapshot.collectionContexts, [selectedCollection]);
    assert.lengthOf(snapshot.tagContexts, 1);
    assert.deepInclude(snapshot.tagContexts[0], selectedTag);
  });

  it("treats a context-free latest user turn as an intentionally empty snapshot", function () {
    const snapshot = deriveConversationComposeContextSnapshotForTests(123, [
      {
        role: "user",
        text: "Older context",
        timestamp: 100,
        paperContexts: [{ itemId: 9, contextItemId: 99, title: "Old" }],
        selectedCollectionContexts: [selectedCollection],
        selectedTagContexts: [selectedTag],
      },
      { role: "user", text: "No context now", timestamp: 200 },
    ]);

    assert.deepEqual(snapshot, {
      paperContexts: [],
      collectionContexts: [],
      tagContexts: [],
    });
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
    let composerDraftClearedCalls = 0;
    const restoredPaperModes: Array<{
      itemId: number;
      paperContext: PaperContextRef;
      mode: string;
    }> = [];
    let lastSentQuestion = "";
    let lastSentDisplayQuestion: string | undefined;
    let lastRuntimeMode = "";
    let lastSentAuthMode = "";
    let lastSentProviderProtocol = "";
    let lastSentModelProviderLabel = "";
    let lastSentImages: string[] | undefined;
    let lastSentAttachments: ChatAttachment[] | undefined;
    let lastSentModelAttachments: ChatAttachment[] | undefined;
    let lastSentForcedSkillIds: string[] | undefined;
    let lastSentContextSource: ResolvedContextSource | null | undefined;
    let lastSentPdfPaperContexts: PaperContextRef[] | undefined;
    let lastSentWebchatSendPdf = false;
    let lastSentWebchatPdfPaperContexts: PaperContextRef[] | undefined;
    let lastSentLocalDocuments: readonly LocalDocumentResource[] | undefined;
    let lastEditRuntimeMode = "";
    let lastEditDisplayQuestion = "";
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
    let activeRequestId = 0;
    let nextRequestId = 1;
    let activeAbortController: AbortController | null = null;

    const deps = {
      body: {} as Element,
      inputBox,
      getItem: () => item,
      beginRequest: () => {
        if (activeRequestId) return null;
        activeRequestId = nextRequestId++;
        activeAbortController = new AbortController();
        return {
          conversationKey: item.id,
          requestId: activeRequestId,
          signal: activeAbortController.signal,
        };
      },
      isRequestOwner: (_conversationKey: number, requestId: number) =>
        activeRequestId === requestId,
      finishRequest: (
        _body: Element,
        _item: Zotero.Item,
        _conversationKey: number,
        requestId: number,
      ) => {
        if (activeRequestId !== requestId) return false;
        activeRequestId = 0;
        activeAbortController = null;
        return true;
      },
      queueFollowUpInput: () => undefined,
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
      resolvePaperContextNextSendMode: () => "full-next" as const,
      setPaperModeOverride: (
        itemId: number,
        paperContext: PaperContextRef,
        mode: string,
      ) => {
        restoredPaperModes.push({ itemId, paperContext, mode });
      },
      resolvePdfPaperAttachments: async () => [],
      resolveLocalPdfResources: async () => [],
      preflightLocalPdfCapability: async () => undefined,
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
        opts.onProviderDispatch?.();
        lastEditRuntimeMode = opts.targetRuntimeMode || "";
        lastEditDisplayQuestion = opts.displayQuestion || "";
        lastEditImages = opts.screenshotImages;
        lastEditAttachments = opts.attachments;
        lastEditModelAttachments = opts.modelAttachments;
        lastEditPdfUploadSystemMessages = opts.pdfUploadSystemMessages;
        lastEditCollectionContexts = opts.selectedCollectionContexts;
        lastEditTagContexts = opts.selectedTagContexts;
        lastEditContextSource = opts.contextSource;
        activeRequestId = 0;
        activeAbortController = null;
        return "ok" as const;
      },
      sendQuestion: async (opts: any) => {
        sendCalled += 1;
        opts.onProviderDispatch?.();
        lastSentQuestion = opts.question;
        lastSentDisplayQuestion = opts.displayQuestion;
        lastRuntimeMode = opts.runtimeMode || "";
        lastSentAuthMode = opts.authMode || "";
        lastSentProviderProtocol = opts.providerProtocol || "";
        lastSentModelProviderLabel = opts.modelProviderLabel || "";
        lastSentImages = opts.images;
        lastSentAttachments = opts.attachments;
        lastSentModelAttachments = opts.modelAttachments;
        lastSentForcedSkillIds = opts.forcedSkillIds;
        lastSentCollectionContexts = opts.selectedCollectionContexts;
        lastSentTagContexts = opts.selectedTagContexts;
        lastSentContextSource = opts.contextSource;
        lastSentPdfPaperContexts = opts.pdfPaperContexts;
        lastSentWebchatSendPdf = opts.webchatSendPdf === true;
        lastSentWebchatPdfPaperContexts = opts.webchatPdfPaperContexts;
        lastSentLocalDocuments = opts.localDocuments;
        opts.onWebChatSendOutcome?.("success");
        activeRequestId = 0;
        activeAbortController = null;
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
      onComposerDraftCleared: () => {
        composerDraftClearedCalls += 1;
      },
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
        composerDraftClearedCalls,
      }),
      getDraftValue: () => draftValue,
      getLastSend: () => ({
        lastSentQuestion,
        lastSentDisplayQuestion,
        lastRuntimeMode,
        lastSentAuthMode,
        lastSentProviderProtocol,
        lastSentModelProviderLabel,
        lastSentImages,
        lastSentAttachments,
        lastSentModelAttachments,
        lastSentForcedSkillIds,
        lastSentCollectionContexts,
        lastSentTagContexts,
        lastSentContextSource,
        lastSentPdfPaperContexts,
        lastSentWebchatSendPdf,
        lastSentWebchatPdfPaperContexts,
        lastSentLocalDocuments,
      }),
      getLastEditRuntimeMode: () => lastEditRuntimeMode,
      getLastEditDisplayQuestion: () => lastEditDisplayQuestion,
      getLastEditImages: () => lastEditImages,
      getLastEditAttachments: () => lastEditAttachments,
      getLastEditModelAttachments: () => lastEditModelAttachments,
      getLastEditPdfUploadSystemMessages: () => lastEditPdfUploadSystemMessages,
      getLastEditCollectionContexts: () => lastEditCollectionContexts,
      getLastEditTagContexts: () => lastEditTagContexts,
      getLastEditContextSource: () => lastEditContextSource,
      getLastStatus: () => lastStatus,
      getStatuses: () => statuses.slice(),
      getRestoredPaperModes: () => restoredPaperModes.slice(),
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

  it("never seeds local conversation titles from webchat sends", async function () {
    const touchedTitles: string[] = [];
    const { controller } = createBaseDeps({
      getSelectedProfile: () => ({
        entryId: "webchat-chatgpt",
        model: "chatgpt.com",
        authMode: "webchat",
        providerProtocol: "web_sync",
        providerLabel: "WebChat",
      }),
      touchPaperConversationTitle: async (_key: number, seed: string) => {
        touchedTitles.push(seed);
      },
      touchGlobalConversationTitle: async (_key: number, seed: string) => {
        touchedTitles.push(seed);
      },
    });

    await controller.doSend();

    assert.deepEqual(
      touchedTitles,
      [],
      "webchat sends must not write catalog titles",
    );
  });

  it("still seeds local conversation titles for non-webchat sends", async function () {
    const touchedTitles: string[] = [];
    const { controller } = createBaseDeps({
      touchPaperConversationTitle: async (_key: number, seed: string) => {
        touchedTitles.push(seed);
      },
    });

    await controller.doSend();

    assert.isNotEmpty(touchedTitles, "normal sends keep seeding titles");
  });

  it("resolves and forwards canonical selected-text anchors at send time", async function () {
    const context: SelectedTextContext = {
      text: "Late-page selected quote",
      source: "pdf",
      contextItemId: 34,
      pageIndex: 587,
      pageLabel: "588",
      paperContext: selectedPaper,
    };
    const anchor: ResolvedSelectedTextAnchor = {
      contextIndex: 0,
      contextItemId: 34,
      pageIndex: 587,
      pageLabel: "588",
      paperContext: selectedPaper,
      resolution: "chunks",
      primaryChunkIndex: 5,
      preferredChunkIndexes: [4, 5, 6],
      contextText: "Bounded local context",
      injectedChars: 21,
    };
    let resolvedParams: unknown;
    let builderOptions: any;
    let sentOptions: any;
    const { controller } = createBaseDeps({
      getSelectedTextContextEntries: () => [context],
      resolveSelectedTextAnchors: async (params: unknown) => {
        resolvedParams = params;
        return [anchor];
      },
      buildQuestionWithSelectedTextContexts: (
        _texts: string[],
        _sources: unknown,
        prompt: string,
        options: unknown,
      ) => {
        builderOptions = options;
        return prompt;
      },
      sendQuestion: async (options: unknown) => {
        sentOptions = options;
      },
    });

    await controller.doSend();

    assert.deepEqual(resolvedParams, {
      selectedTextContexts: [context],
      paperContexts: [selectedPaper],
    });
    assert.deepEqual(builderOptions.selectedTextContexts, [context]);
    assert.deepEqual(builderOptions.resolvedSelectedTextAnchors, [anchor]);
    assert.deepEqual(sentOptions.selectedTextContexts, [context]);
    assert.deepEqual(sentOptions.resolvedSelectedTextAnchors, [anchor]);
  });

  it("passes input mode to the screenshot gate and omits images for text-only mode", async function () {
    let screenshotGateArgs:
      | {
          modelName: string;
          providerProtocol?: string;
          authMode?: string;
          apiBase?: string;
          inputMode?: string;
        }
      | undefined;
    const profile = {
      entryId: "model-1",
      model: "gpt-5.5",
      apiBase: "https://api.openai.com/v1/responses",
      apiKey: "sk-openai",
      providerLabel: "OpenAI",
      authMode: "api_key" as const,
      providerProtocol: "responses_api" as const,
    };
    const { controller, getLastSend } = createBaseDeps({
      getSelectedProfile: () => profile,
      getCurrentModelName: () => profile.model,
      getAdvancedModelParams: () => ({
        temperature: 0.3,
        maxTokens: 4096,
        inputMode: "text_only",
      }),
      isScreenshotUnsupportedModel: (
        modelName: string,
        providerProtocol?: string,
        authMode?: string,
        apiBase?: string,
        inputMode?: string,
      ) => {
        screenshotGateArgs = {
          modelName,
          providerProtocol,
          authMode,
          apiBase,
          inputMode,
        };
        return inputMode === "text_only";
      },
    });

    await controller.doSend();

    assert.deepEqual(screenshotGateArgs, {
      modelName: "gpt-5.5",
      providerProtocol: "responses_api",
      authMode: "api_key",
      apiBase: "https://api.openai.com/v1/responses",
      inputMode: "text_only",
    });
    assert.deepEqual(getLastSend().lastSentImages, []);
  });

  it("resets the composer draft height after a normal send clears the input", async function () {
    const { controller, getCounts } = createBaseDeps();

    await controller.doSend();

    assert.equal(getCounts().composerDraftClearedCalls, 1);
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
      resolvePromptText: resolveProductionPromptText,
      buildModelPromptWithFileContext: (question: string) => question,
    });
    inputBox.value = "draft typed while waiting";
    let restoreCalls = 0;

    await controller.doSend({
      overrideText: "queued follow-up",
      preserveInputDraft: true,
      restoreQueuedInput: () => {
        restoreCalls += 1;
      },
    });

    assert.equal(getLastSend().lastSentQuestion, "queued follow-up");
    assert.equal(inputBox.value, "draft typed while waiting");
    assert.equal(getCounts().persistDraftInputCalls, 0);
    assert.equal(getCounts().composerDraftClearedCalls, 0);
    assert.equal(restoreCalls, 0);
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

  it("resets the composer draft height after an edit retry clears the input", async function () {
    const { controller, getCounts } = createBaseDeps({
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

    assert.equal(getCounts().composerDraftClearedCalls, 1);
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
    assert.equal(getCounts().composerDraftClearedCalls, 1);
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

  it("sends Claude Code turns with the original agent-style request envelope", async function () {
    const { controller, getLastSend } = createBaseDeps({
      isClaudeConversationSystem: () => true,
      getSelectedCollectionContexts: () => [selectedCollection],
      getSelectedTagContexts: () => [selectedTag],
      getSelectedProfile: () => ({
        entryId: "claude_code::haiku",
        model: "haiku",
        apiBase: "",
        apiKey: "",
        providerLabel: "Claude Code",
        authMode: "api_key",
        providerProtocol: "anthropic_messages",
      }),
    });

    await controller.doSend();
    const lastSend = getLastSend();

    assert.equal(lastSend.lastSentQuestion, "ask question");
    assert.equal(lastSend.lastRuntimeMode, "agent");
    assert.equal(lastSend.lastSentModelProviderLabel, "Claude Code");
    assert.deepEqual(lastSend.lastSentCollectionContexts, [selectedCollection]);
    assert.deepEqual(lastSend.lastSentTagContexts, [selectedTag]);
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
      resolvePromptText: resolveProductionPromptText,
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

  async function sendCodexNativeSkillInput(
    input: string,
    skills: AgentSkill[],
  ) {
    setUserSkills(skills);
    const { controller, inputBox, getLastSend } = createBaseDeps({
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
    inputBox.value = input;

    await controller.doSend();

    return getLastSend();
  }

  it("translates chip-selected Codex app-server skills only in the submitted question", async function () {
    setUserSkills([makeTestSkill("write-note")]);
    const { controller, inputBox, getLastSend } = createBaseDeps({
      getSelectedTextContextEntries: () => [],
      getSelectedPaperContexts: () => [],
      getFullTextPaperContexts: () => [],
      getSelectedFiles: () => [],
      getSelectedImages: () => [],
      consumeForcedSkillIds: () => ["write-note"],
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
    inputBox.value = "please draft this note";

    await controller.doSend();

    const lastSend = getLastSend();
    assert.equal(
      lastSend.lastSentQuestion,
      "$write-note\n\nplease draft this note",
    );
    assert.equal(lastSend.lastSentDisplayQuestion, "please draft this note");
    assert.deepEqual(lastSend.lastSentForcedSkillIds, ["write-note"]);
  });

  it("converts slash skill sends to native $skill mentions for Codex app-server", async function () {
    setUserSkills([makeTestSkill("write-note")]);
    const { controller, inputBox, getLastSend } = createBaseDeps({
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
    inputBox.value = "/write-note please draft this note";

    await controller.doSend();

    const lastSend = getLastSend();
    assert.equal(
      lastSend.lastSentQuestion,
      "$write-note\n\nplease draft this note",
    );
    assert.equal(
      lastSend.lastSentDisplayQuestion,
      "/write-note please draft this note",
    );
    assert.deepEqual(lastSend.lastSentForcedSkillIds, ["write-note"]);
  });

  it("keeps raw native $skill sends from being double-prefixed", async function () {
    setUserSkills([makeTestSkill("write-note")]);
    const { controller, inputBox, getLastSend } = createBaseDeps({
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
    inputBox.value = "$write-note\n\nplease draft this note";

    await controller.doSend();

    const lastSend = getLastSend();
    assert.equal(
      lastSend.lastSentQuestion,
      "$write-note\n\nplease draft this note",
    );
    assert.deepEqual(lastSend.lastSentForcedSkillIds, ["write-note"]);
  });

  it("recognizes fuzzy natural-language Codex skill directives", async function () {
    const skills = [
      makeTestSkill("evidence-based-qa", {
        description:
          "Locate specific passages in selected papers that support a claim with quoted evidence.",
      }),
      makeTestSkill("write-note", {
        description: "Write a long-form reading or literature note.",
      }),
    ];

    const partial = await sendCodexNativeSkillInput(
      "use evidence base skill to read the paper",
      skills,
    );
    assert.equal(
      partial.lastSentQuestion,
      "$evidence-based-qa\n\nread the paper",
    );
    assert.equal(
      partial.lastSentDisplayQuestion,
      "use evidence base skill to read the paper",
    );
    assert.deepEqual(partial.lastSentForcedSkillIds, ["evidence-based-qa"]);

    const typo = await sendCodexNativeSkillInput(
      "use evidnce based skill to read the paper",
      skills,
    );
    assert.equal(typo.lastSentQuestion, "$evidence-based-qa\n\nread the paper");
    assert.deepEqual(typo.lastSentForcedSkillIds, ["evidence-based-qa"]);

    const writeNote = await sendCodexNativeSkillInput(
      "please use write not skill to draft a note",
      skills,
    );
    assert.equal(writeNote.lastSentQuestion, "$write-note\n\ndraft a note");
    assert.deepEqual(writeNote.lastSentForcedSkillIds, ["write-note"]);

    const description = await sendCodexNativeSkillInput(
      "use reading note skill to summarize",
      skills,
    );
    assert.equal(description.lastSentQuestion, "$write-note\n\nsummarize");
    assert.deepEqual(description.lastSentForcedSkillIds, ["write-note"]);

    const quoted = await sendCodexNativeSkillInput(
      'use "evidence base" skill: quote the method',
      skills,
    );
    assert.equal(
      quoted.lastSentQuestion,
      "$evidence-based-qa\n\nquote the method",
    );
    assert.deepEqual(quoted.lastSentForcedSkillIds, ["evidence-based-qa"]);
  });

  it("does not force ambiguous or non-leading natural-language skill mentions", async function () {
    const evidenceSkill = makeTestSkill("evidence-based-qa", {
      description:
        "Locate specific passages in selected papers that support a claim with quoted evidence.",
    });

    const unknown = await sendCodexNativeSkillInput(
      "use imaginary skill to draft a note",
      [evidenceSkill],
    );
    assert.equal(
      unknown.lastSentQuestion,
      "use imaginary skill to draft a note",
    );
    assert.isUndefined(unknown.lastSentForcedSkillIds);

    const vague = await sendCodexNativeSkillInput(
      "use paper skill to read the paper",
      [evidenceSkill],
    );
    assert.equal(vague.lastSentQuestion, "use paper skill to read the paper");
    assert.isUndefined(vague.lastSentForcedSkillIds);

    const tied = await sendCodexNativeSkillInput(
      "use paper not skill to draft",
      [makeTestSkill("paper-note"), makeTestSkill("paper-nots")],
    );
    assert.equal(tied.lastSentQuestion, "use paper not skill to draft");
    assert.isUndefined(tied.lastSentForcedSkillIds);

    const midSentence = await sendCodexNativeSkillInput(
      "should I use evidence base skill?",
      [evidenceSkill],
    );
    assert.equal(
      midSentence.lastSentQuestion,
      "should I use evidence base skill?",
    );
    assert.isUndefined(midSentence.lastSentForcedSkillIds);
  });

  it("allows natural-language directives to force manual Codex skills", async function () {
    const manual = await sendCodexNativeSkillInput(
      "use manual helper skill to run this",
      [
        makeTestSkill("manual-helper", {
          activation: "manual",
          description: "Manual helper for explicit workflow testing.",
        }),
      ],
    );

    assert.equal(manual.lastSentQuestion, "$manual-helper\n\nrun this");
    assert.deepEqual(manual.lastSentForcedSkillIds, ["manual-helper"]);
  });

  it("keeps slash skill text unchanged outside Codex app-server mode", async function () {
    setUserSkills([makeTestSkill("write-note")]);
    const { controller, inputBox, getLastSend } = createBaseDeps({
      getSelectedTextContextEntries: () => [],
      getSelectedPaperContexts: () => [],
      getFullTextPaperContexts: () => [],
      getSelectedFiles: () => [],
      getSelectedImages: () => [],
      isAgentMode: () => true,
      getSelectedProfile: () => ({
        entryId: "openai::gpt-4.1",
        model: "gpt-4.1",
        apiBase: "https://api.openai.com/v1",
        apiKey: "test-key",
        providerLabel: "OpenAI",
        authMode: "api_key",
        providerProtocol: "responses_api",
      }),
      resolvePromptText: (text: string) => text,
      buildModelPromptWithFileContext: (question: string) => question,
    });
    inputBox.value = "/write-note please draft this note";

    await controller.doSend();

    assert.equal(
      getLastSend().lastSentQuestion,
      "/write-note please draft this note",
    );
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

  it("forwards the exact active WebChat PDF identity", async function () {
    const pdfPaperContexts: PaperContextRef[] = [
      {
        itemId: 10,
        contextItemId: 102,
        title: "First paper, second attachment",
        contentSourceMode: "pdf",
      },
    ];
    const { controller, getLastSend, getCounts } = createBaseDeps({
      getSelectedProfile: () => ({
        entryId: "entry-1",
        model: "chatgpt-web",
        apiBase: "",
        apiKey: "",
        providerLabel: "ChatGPT",
        authMode: "webchat",
        providerProtocol: "web_sync",
      }),
      getSelectedPaperContexts: () => pdfPaperContexts,
      getPdfModePaperContexts: () => pdfPaperContexts,
      getActiveWebChatPdfPaperContexts: () => pdfPaperContexts,
      getFullTextPaperContexts: () => [],
      hasActivePdfFullTextPapers: () => true,
      getSelectedFiles: () => [],
    });

    await controller.doSend();

    assert.isTrue(getLastSend().lastSentWebchatSendPdf);
    assert.deepEqual(
      getLastSend().lastSentWebchatPdfPaperContexts,
      pdfPaperContexts,
    );
    assert.deepEqual(getLastSend().lastSentPdfPaperContexts, pdfPaperContexts);
    assert.equal(getCounts().consumePaperModeStateCalled, 1);
  });

  it("sends an active WebChat PDF on a later turn", async function () {
    const pdf: PaperContextRef = {
      itemId: 10,
      contextItemId: 102,
      title: "Persistent PDF",
      contentSourceMode: "pdf",
    };
    const { controller, getLastSend, getCounts } = createBaseDeps({
      getSelectedProfile: () => ({
        entryId: "entry-1",
        model: "chatgpt-web",
        apiBase: "",
        apiKey: "",
        providerLabel: "ChatGPT",
        authMode: "webchat",
        providerProtocol: "web_sync",
      }),
      getSelectedPaperContexts: () => [pdf],
      getPdfModePaperContexts: () => [pdf],
      getActiveWebChatPdfPaperContexts: () => [pdf],
      getFullTextPaperContexts: () => [],
      getSelectedFiles: () => [],
    });

    await controller.doSend();

    assert.equal(getCounts().sendCalled, 1);
    assert.isTrue(getLastSend().lastSentWebchatSendPdf);
    assert.deepEqual(getLastSend().lastSentWebchatPdfPaperContexts, [pdf]);
  });

  it("allows a different PDF on a later turn in the same WebChat", async function () {
    const pdfB: PaperContextRef = {
      itemId: 10,
      contextItemId: 102,
      title: "PDF B",
      contentSourceMode: "pdf",
    };
    const { controller, getCounts, getLastSend } = createBaseDeps({
      getSelectedProfile: () => ({
        entryId: "entry-1",
        model: "chatgpt-web",
        apiBase: "",
        apiKey: "",
        providerLabel: "ChatGPT",
        authMode: "webchat",
        providerProtocol: "web_sync",
      }),
      getSelectedPaperContexts: () => [pdfB],
      getPdfModePaperContexts: () => [pdfB],
      getActiveWebChatPdfPaperContexts: () => [pdfB],
      getFullTextPaperContexts: () => [],
      getSelectedFiles: () => [],
    });

    await controller.doSend();

    assert.equal(getCounts().sendCalled, 1);
    assert.isTrue(getLastSend().lastSentWebchatSendPdf);
    assert.deepEqual(getLastSend().lastSentWebchatPdfPaperContexts, [pdfB]);
  });

  it("blocks multiple active WebChat PDFs before clearing the draft", async function () {
    const pdfPaperContexts: PaperContextRef[] = [
      {
        itemId: 10,
        contextItemId: 101,
        title: "PDF A",
        contentSourceMode: "pdf",
      },
      {
        itemId: 20,
        contextItemId: 202,
        title: "PDF B",
        contentSourceMode: "pdf",
      },
    ];
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
      getSelectedPaperContexts: () => pdfPaperContexts,
      getPdfModePaperContexts: () => pdfPaperContexts,
      getActiveWebChatPdfPaperContexts: () => pdfPaperContexts,
      getFullTextPaperContexts: () => [],
      getSelectedFiles: () => [],
    });

    await controller.doSend();

    assert.equal(getCounts().sendCalled, 0);
    assert.equal(inputBox.value, "ask question");
    assert.deepEqual(getLastStatus(), {
      message:
        "Web chat supports one PDF attachment at a time. Keep one PDF active or start separate chats.",
      level: "error",
    });
  });

  it("allows a PDF upload after restoring a previous WebChat", async function () {
    const pdf: PaperContextRef = {
      itemId: 10,
      contextItemId: 101,
      title: "Selected PDF",
      contentSourceMode: "pdf",
    };
    const { controller, getCounts, getLastSend } = createBaseDeps({
      getSelectedProfile: () => ({
        entryId: "entry-1",
        model: "chatgpt-web",
        apiBase: "",
        apiKey: "",
        providerLabel: "ChatGPT",
        authMode: "webchat",
        providerProtocol: "web_sync",
      }),
      getSelectedPaperContexts: () => [pdf],
      getPdfModePaperContexts: () => [pdf],
      getActiveWebChatPdfPaperContexts: () => [pdf],
      getFullTextPaperContexts: () => [],
      getSelectedFiles: () => [],
    });

    await controller.doSend();

    assert.equal(getCounts().sendCalled, 1);
    assert.isTrue(getLastSend().lastSentWebchatSendPdf);
    assert.deepEqual(getLastSend().lastSentWebchatPdfPaperContexts, [pdf]);
  });

  it("re-arms a forced-new WebChat PDF send after dispatch failure", async function () {
    const pdf: PaperContextRef = {
      itemId: 10,
      contextItemId: 101,
      title: "Selected PDF",
      contentSourceMode: "pdf",
    };
    let forceNewChatIntent = true;
    let sendAttempts = 0;
    const forceFlags: boolean[] = [];
    const { controller, inputBox } = createBaseDeps({
      getSelectedProfile: () => ({
        entryId: "entry-1",
        model: "chatgpt-web",
        apiBase: "",
        apiKey: "",
        providerLabel: "ChatGPT",
        authMode: "webchat",
        providerProtocol: "web_sync",
      }),
      getSelectedPaperContexts: () => [pdf],
      getPdfModePaperContexts: () => [pdf],
      getActiveWebChatPdfPaperContexts: () => [pdf],
      getFullTextPaperContexts: () => [],
      getSelectedFiles: () => [],
      consumeWebChatForceNewChatIntent: () => {
        const current = forceNewChatIntent;
        forceNewChatIntent = false;
        return current;
      },
      markWebChatForceNewChatIntent: () => {
        forceNewChatIntent = true;
      },
      sendQuestion: async (options: {
        webchatForceNewChat?: boolean;
        onWebChatSendOutcome?: (outcome: "success") => void;
      }) => {
        forceFlags.push(options.webchatForceNewChat === true);
        sendAttempts += 1;
        if (sendAttempts === 1) {
          throw new Error("relay failed before navigation");
        }
        options.onWebChatSendOutcome?.("success");
      },
    });

    let firstError: unknown;
    try {
      await controller.doSend();
    } catch (err) {
      firstError = err;
    }
    assert.instanceOf(firstError, Error);
    assert.isTrue(forceNewChatIntent);

    inputBox.value = "retry question";
    await controller.doSend();

    assert.deepEqual(forceFlags, [true, true]);
    assert.isFalse(forceNewChatIntent);
  });

  it("allows a non-forced WebChat PDF retry after dispatch failure", async function () {
    const pdf: PaperContextRef = {
      itemId: 10,
      contextItemId: 101,
      title: "Selected PDF",
      contentSourceMode: "pdf",
    };
    let sendAttempts = 0;
    const { controller, inputBox, getCounts } = createBaseDeps({
      getSelectedProfile: () => ({
        entryId: "entry-1",
        model: "chatgpt-web",
        apiBase: "",
        apiKey: "",
        providerLabel: "ChatGPT",
        authMode: "webchat",
        providerProtocol: "web_sync",
      }),
      getSelectedPaperContexts: () => [pdf],
      getPdfModePaperContexts: () => [pdf],
      getActiveWebChatPdfPaperContexts: () => [pdf],
      getFullTextPaperContexts: () => [],
      getSelectedFiles: () => [],
      sendQuestion: async (options: {
        onWebChatSendOutcome?: (outcome: "success") => void;
      }) => {
        sendAttempts += 1;
        if (sendAttempts === 1) {
          throw new Error("relay outcome unknown");
        }
        options.onWebChatSendOutcome?.("success");
      },
    });

    await controller.doSend().catch(() => undefined);
    assert.equal(sendAttempts, 1);

    inputBox.value = "retry question";
    await controller.doSend();

    assert.equal(sendAttempts, 2);
    assert.equal(getCounts().consumePaperModeStateCalled, 1);
  });

  it("honors a swallowed WebChat pipeline failure outcome", async function () {
    const pdf: PaperContextRef = {
      itemId: 10,
      contextItemId: 101,
      title: "Selected PDF",
      contentSourceMode: "pdf",
    };
    const { controller, getCounts, getRestoredPaperModes } = createBaseDeps({
      getSelectedProfile: () => ({
        entryId: "entry-1",
        model: "chatgpt-web",
        apiBase: "",
        apiKey: "",
        providerLabel: "ChatGPT",
        authMode: "webchat",
        providerProtocol: "web_sync",
      }),
      getSelectedPaperContexts: () => [pdf],
      getPdfModePaperContexts: () => [pdf],
      getActiveWebChatPdfPaperContexts: () => [pdf],
      getFullTextPaperContexts: () => [],
      getSelectedFiles: () => [],
      sendQuestion: async (options: {
        onWebChatSendOutcome?: (outcome: "failed") => void;
      }) => {
        options.onWebChatSendOutcome?.("failed");
      },
    });

    await controller.doSend();

    assert.equal(getCounts().consumePaperModeStateCalled, 0);
    assert.deepEqual(getRestoredPaperModes(), [
      {
        itemId: item.id,
        paperContext: pdf,
        mode: "full-next",
      },
    ]);
  });

  it("restores a sticky WebChat PDF mode after a verified failure", async function () {
    const pdf: PaperContextRef = {
      itemId: 10,
      contextItemId: 101,
      title: "Selected PDF",
      contentSourceMode: "pdf",
    };
    const { controller, getRestoredPaperModes } = createBaseDeps({
      getSelectedProfile: () => ({
        entryId: "entry-1",
        model: "chatgpt-web",
        apiBase: "",
        apiKey: "",
        providerLabel: "ChatGPT",
        authMode: "webchat",
        providerProtocol: "web_sync",
      }),
      getSelectedPaperContexts: () => [pdf],
      getPdfModePaperContexts: () => [pdf],
      getActiveWebChatPdfPaperContexts: () => [pdf],
      getFullTextPaperContexts: () => [],
      getSelectedFiles: () => [],
      resolvePaperContextNextSendMode: () => "full-sticky",
      sendQuestion: async (options: {
        onWebChatSendOutcome?: (outcome: "failed") => void;
      }) => {
        options.onWebChatSendOutcome?.("failed");
      },
    });

    await controller.doSend();

    assert.deepEqual(getRestoredPaperModes(), [
      {
        itemId: item.id,
        paperContext: pdf,
        mode: "full-sticky",
      },
    ]);
  });

  it("re-arms a swallowed forced-new text-only WebChat failure", async function () {
    let forceNewChatIntent = true;
    const { controller } = createBaseDeps({
      getSelectedProfile: () => ({
        entryId: "entry-1",
        model: "chatgpt-web",
        apiBase: "",
        apiKey: "",
        providerLabel: "ChatGPT",
        authMode: "webchat",
        providerProtocol: "web_sync",
      }),
      getSelectedPaperContexts: () => [],
      getPdfModePaperContexts: () => [],
      getActiveWebChatPdfPaperContexts: () => [],
      getFullTextPaperContexts: () => [],
      getSelectedFiles: () => [],
      consumeWebChatForceNewChatIntent: () => {
        const current = forceNewChatIntent;
        forceNewChatIntent = false;
        return current;
      },
      markWebChatForceNewChatIntent: () => {
        forceNewChatIntent = true;
      },
      sendQuestion: async (options: {
        onWebChatSendOutcome?: (outcome: "failed") => void;
      }) => {
        options.onWebChatSendOutcome?.("failed");
      },
    });

    await controller.doSend();

    assert.isTrue(forceNewChatIntent);
  });

  it("keeps a skipped WebChat PDF out of the current upload identity list", async function () {
    const activePdf: PaperContextRef = {
      itemId: 10,
      contextItemId: 102,
      title: "Active PDF",
      contentSourceMode: "pdf",
    };
    const skippedPdf: PaperContextRef = {
      itemId: 20,
      contextItemId: 202,
      title: "Skipped this send",
      contentSourceMode: "pdf",
    };
    const allPdfContexts = [activePdf, skippedPdf];
    const { controller, getLastSend } = createBaseDeps({
      getSelectedProfile: () => ({
        entryId: "entry-1",
        model: "chatgpt-web",
        apiBase: "",
        apiKey: "",
        providerLabel: "ChatGPT",
        authMode: "webchat",
        providerProtocol: "web_sync",
      }),
      getSelectedPaperContexts: () => allPdfContexts,
      getPdfModePaperContexts: () => allPdfContexts,
      getActiveWebChatPdfPaperContexts: () => [activePdf],
      getFullTextPaperContexts: () => [],
      getSelectedFiles: () => [],
    });

    await controller.doSend();

    assert.isTrue(getLastSend().lastSentWebchatSendPdf);
    assert.deepEqual(getLastSend().lastSentPdfPaperContexts, allPdfContexts);
    assert.deepEqual(getLastSend().lastSentWebchatPdfPaperContexts, [
      activePdf,
    ]);
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

  it("sends PDF-mode papers to Codex as exact local resources", async function () {
    const localPdf: LocalDocumentResource = {
      kind: "local_pdf",
      sourceKey: "zotero-pdf:12:34",
      itemId: 12,
      contextItemId: 34,
      title: "Pinned paper",
      name: "paper.pdf",
      mimeType: "application/pdf",
      absolutePath: "/tmp/paper.pdf",
    };
    const { controller, getCounts, getLastSend } = createBaseDeps({
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
      getModelPdfSupport: () => "local_path" as const,
      resolveLocalPdfResources: async () => [localPdf],
      renderPdfPagesAsImages: async () => {
        throw new Error("should not render full PDF pages");
      },
    });

    await controller.doSend();

    assert.equal(getCounts().sendCalled, 1);
    assert.deepEqual(getLastSend().lastSentPdfPaperContexts, [selectedPaper]);
    assert.deepEqual(getLastSend().lastSentLocalDocuments, [localPdf]);
    assert.deepEqual(getLastSend().lastSentAttachments, undefined);
    assert.deepEqual(getLastSend().lastSentModelAttachments, undefined);
  });

  it("preserves the Claude draft when local PDF bridge capability is missing", async function () {
    const localPdf: LocalDocumentResource = {
      kind: "local_pdf",
      sourceKey: "zotero-pdf:12:34",
      itemId: 12,
      contextItemId: 34,
      title: "Pinned paper",
      name: "paper.pdf",
      mimeType: "application/pdf",
      absolutePath: "/tmp/paper.pdf",
    };
    const { controller, inputBox, getCounts, getLastStatus } = createBaseDeps({
      getSelectedTextContextEntries: () => [],
      getSelectedFiles: () => [],
      getSelectedImages: () => [],
      getFullTextPaperContexts: () => [],
      getPdfModePaperContexts: () => [selectedPaper],
      isClaudeConversationSystem: () => true,
      getModelPdfSupport: () => "local_path" as const,
      resolveLocalPdfResources: async () => [localPdf],
      preflightLocalPdfCapability: async () => {
        throw new Error("Update and restart the Claude bridge.");
      },
    });

    await controller.doSend();

    assert.equal(getCounts().sendCalled, 0);
    assert.equal(inputBox.value, "ask question");
    assert.deepEqual(getLastStatus(), {
      message: "Update and restart the Claude bridge.",
      level: "error",
    });
  });

  it("uses a raw-PDF default prompt for a path-only send", async function () {
    const localPdf: LocalDocumentResource = {
      kind: "local_pdf",
      sourceKey: "zotero-pdf:12:34",
      itemId: 12,
      contextItemId: 34,
      title: "Pinned paper",
      name: "paper.pdf",
      mimeType: "application/pdf",
      absolutePath: "/tmp/paper.pdf",
    };
    const { controller, inputBox, getLastSend } = createBaseDeps({
      getSelectedTextContextEntries: () => [],
      getSelectedFiles: () => [],
      getSelectedImages: () => [],
      getFullTextPaperContexts: () => [],
      getPdfModePaperContexts: () => [selectedPaper],
      isCodexConversationSystem: () => true,
      getModelPdfSupport: () => "local_path" as const,
      resolveLocalPdfResources: async () => [localPdf],
      resolvePromptText: (text: string) => text,
      buildModelPromptWithFileContext: (question: string) => question,
    });
    inputBox.value = "";

    await controller.doSend();

    assert.equal(
      getLastSend().lastSentQuestion,
      "Please analyze the selected raw PDF.",
    );
  });

  it("preserves an explicitly selected skill on a Codex raw-PDF send", async function () {
    setUserSkills([makeTestSkill("write-note")]);
    const pdfPaperContext: PaperContextRef = {
      ...selectedPaper,
      contentSourceMode: "pdf",
    };
    const localPdf: LocalDocumentResource = {
      kind: "local_pdf",
      sourceKey: "zotero-pdf:12:34",
      itemId: 12,
      contextItemId: 34,
      title: "Pinned paper",
      name: "paper.pdf",
      mimeType: "application/pdf",
      absolutePath: "/tmp/paper.pdf",
    };
    const { controller, inputBox, getLastSend } = createBaseDeps({
      getSelectedTextContextEntries: () => [],
      getSelectedPaperContexts: () => [pdfPaperContext],
      getSelectedFiles: () => [],
      getSelectedImages: () => [],
      getFullTextPaperContexts: () => [],
      getPdfModePaperContexts: () => [pdfPaperContext],
      consumeForcedSkillIds: () => ["write-note"],
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
      getModelPdfSupport: () => "local_path" as const,
      resolveLocalPdfResources: async () => [localPdf],
      resolvePromptText: (text: string) => text,
      buildModelPromptWithFileContext: (question: string) => question,
    });
    inputBox.value = "Analyze the selected raw PDF.";

    await controller.doSend();

    const lastSend = getLastSend();
    assert.equal(
      lastSend.lastSentQuestion,
      "$write-note\n\nAnalyze the selected raw PDF.",
    );
    assert.deepEqual(lastSend.lastSentForcedSkillIds, ["write-note"]);
    assert.deepEqual(lastSend.lastSentLocalDocuments, [localPdf]);
  });

  it("keeps the plural raw-PDF default when scope context is also selected", async function () {
    const pdfPaperContexts = [
      selectedPaper,
      { itemId: 56, contextItemId: 78, title: "Second paper" },
    ];
    const localDocuments: LocalDocumentResource[] = pdfPaperContexts.map(
      (paperContext, index) => ({
        kind: "local_pdf",
        sourceKey: `zotero-pdf:${paperContext.itemId}:${paperContext.contextItemId}`,
        itemId: paperContext.itemId,
        contextItemId: paperContext.contextItemId,
        title: paperContext.title,
        name: `paper-${index + 1}.pdf`,
        mimeType: "application/pdf",
        absolutePath: `/tmp/paper-${index + 1}.pdf`,
      }),
    );
    const { controller, inputBox, getLastSend } = createBaseDeps({
      getSelectedTextContextEntries: () => [],
      getSelectedFiles: () => [],
      getSelectedImages: () => [],
      getSelectedCollectionContexts: () => [selectedCollection],
      getFullTextPaperContexts: () => [],
      getPdfModePaperContexts: () => pdfPaperContexts,
      isCodexConversationSystem: () => true,
      getModelPdfSupport: () => "local_path" as const,
      resolveLocalPdfResources: async () => localDocuments,
      resolvePromptText: (text: string) => text,
      buildModelPromptWithFileContext: (question: string) => question,
    });
    inputBox.value = "";

    await controller.doSend();

    assert.equal(
      getLastSend().lastSentQuestion,
      "Please analyze the selected raw PDFs.",
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

  it("admits only one of three rapid sends while context is preparing", async function () {
    let resolveContext: ((value: ResolvedContextSource | null) => void) | null =
      null;
    const contextReady = new Promise<ResolvedContextSource | null>(
      (resolve) => {
        resolveContext = resolve;
      },
    );
    const queued: string[] = [];
    const { controller, inputBox, getCounts } = createBaseDeps({
      resolveContextSource: () => contextReady,
      queueFollowUpInput: (text: string) => queued.push(text),
    });

    const first = controller.doSend();
    assert.equal(inputBox.value, "", "the admitted draft clears synchronously");
    const second = controller.doSend();
    const third = controller.doSend();
    resolveContext?.(null);
    await Promise.all([first, second, third]);

    assert.equal(getCounts().sendCalled, 1);
    assert.deepEqual(queued, []);
  });

  it("queues one genuinely new follow-up while preparation owns the conversation", async function () {
    let resolveContext: ((value: ResolvedContextSource | null) => void) | null =
      null;
    const contextReady = new Promise<ResolvedContextSource | null>(
      (resolve) => {
        resolveContext = resolve;
      },
    );
    const queued: string[] = [];
    const { controller, inputBox, getCounts } = createBaseDeps({
      resolveContextSource: () => contextReady,
      queueFollowUpInput: (text: string) => {
        queued.push(text);
        inputBox.value = "";
      },
    });

    const first = controller.doSend();
    inputBox.value = "a real follow-up";
    await controller.doSend();
    await controller.doSend();
    resolveContext?.(null);
    await first;

    assert.equal(getCounts().sendCalled, 1);
    assert.deepEqual(queued, ["a real follow-up"]);
  });

  it("restores the captured draft when preparation is cancelled", async function () {
    let resolveContext: ((value: ResolvedContextSource | null) => void) | null =
      null;
    const contextReady = new Promise<ResolvedContextSource | null>(
      (resolve) => {
        resolveContext = resolve;
      },
    );
    const abortController = new AbortController();
    let owner = 91;
    const { controller, inputBox, getCounts, getDraftValue } = createBaseDeps({
      resolveContextSource: () => contextReady,
      beginRequest: () => ({
        conversationKey: item.id,
        requestId: 91,
        signal: abortController.signal,
      }),
      isRequestOwner: (_conversationKey: number, requestId: number) =>
        owner === requestId,
      finishRequest: (
        _body: Element,
        _item: Zotero.Item,
        _conversationKey: number,
        requestId: number,
      ) => {
        if (owner !== requestId) return false;
        owner = 0;
        return true;
      },
    });

    const send = controller.doSend();
    assert.equal(inputBox.value, "");
    abortController.abort();
    resolveContext?.(null);
    await send;

    assert.equal(getCounts().sendCalled, 0);
    assert.equal(owner, 0);
    assert.equal(inputBox.value, "ask question");
    assert.equal(getDraftValue(), "ask question");
  });

  it("restores a queued follow-up when preparation is cancelled", async function () {
    let resolveContext: ((value: ResolvedContextSource | null) => void) | null =
      null;
    const contextReady = new Promise<ResolvedContextSource | null>(
      (resolve) => {
        resolveContext = resolve;
      },
    );
    const abortController = new AbortController();
    const queued = ["later follow-up"];
    let owner = 92;
    const { controller, inputBox, getCounts } = createBaseDeps({
      resolveContextSource: () => contextReady,
      beginRequest: () => ({
        conversationKey: item.id,
        requestId: 92,
        signal: abortController.signal,
      }),
      isRequestOwner: (_conversationKey: number, requestId: number) =>
        owner === requestId,
      finishRequest: (
        _body: Element,
        _item: Zotero.Item,
        _conversationKey: number,
        requestId: number,
      ) => {
        if (owner !== requestId) return false;
        owner = 0;
        return true;
      },
    });
    inputBox.value = "draft typed while waiting";

    const send = controller.doSend({
      overrideText: "queued follow-up",
      preserveInputDraft: true,
      restoreQueuedInput: () => queued.unshift("queued follow-up"),
    });
    abortController.abort();
    resolveContext?.(null);
    await send;

    assert.equal(getCounts().sendCalled, 0);
    assert.equal(owner, 0);
    assert.deepEqual(queued, ["queued follow-up", "later follow-up"]);
    assert.equal(inputBox.value, "draft typed while waiting");
  });

  it("restores the captured draft when preparation fails", async function () {
    const { controller, inputBox, getCounts, getDraftValue } = createBaseDeps({
      resolveContextSource: async () => {
        throw new Error("context failed");
      },
    });

    await controller.doSend().catch(() => undefined);

    assert.equal(getCounts().sendCalled, 0);
    assert.equal(inputBox.value, "ask question");
    assert.equal(getDraftValue(), "ask question");
  });
});
