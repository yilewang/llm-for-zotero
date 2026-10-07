import { assert } from "chai";
import {
  codexRetryRequestParamsForTests,
  codexRetrySkillContextForTests,
  codexSendRequestParamsForTests,
  codexSendSkillContextForTests,
} from "../src/modules/contextPanel/chat";
import {
  toAgentRuntimeRequestParams,
  toCodexNativeSkillContext,
  type TurnRequestContext,
} from "../src/modules/contextPanel/requestContext";

// Golden records of what the Codex send and retry sites in chat.ts hand the
// agent request builder and the native skill router. The expected objects
// were written from the request literals before they were lifted out of the
// two flows; they pin today's per-site differences (send asks for
// `modelAttachments || attachments` but routes skills on the visible
// attachments; retry uses the stored message for its passages and skills).

const item = { id: 501, libraryID: 1 } as unknown as Zotero.Item;
const paperA = { libraryID: 1, itemId: 11, contextItemId: 111, title: "A" };
const paperB = { libraryID: 1, itemId: 12, contextItemId: 121, title: "B" };
const pdfPaper = {
  libraryID: 1,
  itemId: 13,
  contextItemId: 131,
  title: "C",
  contentSourceMode: "pdf" as const,
};
const pinnedPaper = {
  libraryID: 1,
  itemId: 15,
  contextItemId: 151,
  title: "P",
};
const citationPaper = {
  libraryID: 1,
  itemId: 16,
  contextItemId: 161,
  title: "Cite",
};
const passage = {
  text: "Passage.",
  source: "pdf" as const,
  paperContext: paperA,
  contextItemId: 111,
};
const anchors = [{ contextIndex: 0, golden: "anchor" }] as any[];
const collections = [{ collectionId: 5, name: "Col", libraryID: 1 }] as any[];
const tags = [{ name: "tag-a", libraryID: 1 }] as any[];
const visibleAttachments = [{ id: "a1", category: "image" }] as any[];
const modelAttachments = [{ id: "m1", category: "text" }] as any[];
const localDocuments = [{ kind: "pdf", path: "/tmp/c.pdf" }] as any[];
const images = ["data:image/png;base64,AAA"];
const effectiveRequestConfig = {
  model: "gpt-5",
  apiBase: "",
  apiKey: "",
  authMode: "codex_app_server" as const,
  reasoning: undefined,
  advanced: undefined,
};
const llmHistory = [{ role: "user" as const, content: "earlier" }];

function sendSite(overrides: Record<string, unknown> = {}) {
  return {
    conversationKey: 7,
    conversationGeneration: 3,
    userMessage: {
      timestamp: 1234,
      citationPaperContexts: [citationPaper],
      pinnedPaperContexts: [pinnedPaper],
    },
    item,
    shownQuestion: "Shown question",
    selectedTextContextsForMessage: [passage],
    resolvedSelectedTextAnchors: anchors,
    selectedTextsForMessage: ["Passage."],
    selectedTextSourcesForMessage: ["pdf" as const],
    selectedTextPaperContextsForMessage: [paperA],
    selectedTextNoteContextsForMessage: [undefined],
    contextPlan: {
      paperContexts: [paperA],
      fullTextPaperContexts: [paperB],
    },
    normalizedPdfPaperContexts: [pdfPaper],
    selectedCollectionContextsForMessage: collections,
    selectedTagContextsForMessage: [],
    modelAttachments,
    attachments: visibleAttachments,
    localDocuments,
    allSendImages: images,
    opts: { forcedSkillIds: ["skill-x"] },
    effectiveRequestConfig,
    llmHistory,
    ...overrides,
  } as any;
}

function retrySite(overrides: Record<string, unknown> = {}) {
  return {
    conversationKey: 8,
    conversationGeneration: 4,
    retryPair: {
      userMessage: {
        timestamp: 5678,
        selectedTexts: ["Stored passage."],
        selectedTextSources: ["note" as const],
        selectedTextPaperContexts: [undefined],
        selectedTextNoteContexts: [{ noteItemId: 9, title: "N" }],
        pdfPaperContexts: [pdfPaper],
        citationPaperContexts: [citationPaper],
        forcedSkillIds: ["skill-stored"],
        pinnedPaperContexts: [pinnedPaper],
      },
    },
    item,
    question: "Stored question",
    retrySelectedTextContexts: [passage],
    retryResolvedSelectedTextAnchors: anchors,
    contextPlan: {
      paperContexts: [paperA],
      fullTextPaperContexts: [],
    },
    selectedCollectionContexts: [],
    selectedTagContexts: tags,
    attachments: visibleAttachments,
    retryLocalDocuments: undefined,
    allImages: images,
    effectiveRequestConfig,
    llmHistory,
    ...overrides,
  } as any;
}

describe("request context: Codex send site (golden)", function () {
  it("passes the agent request builder the send's literal fields", function () {
    const site = sendSite();
    const params = codexSendRequestParamsForTests(site);
    assert.deepStrictEqual(params, {
      conversationKey: 7,
      conversationGeneration: 3,
      sourceMessageTimestamp: 1234,
      item,
      userText: "Shown question",
      selectedTextContexts: [passage],
      resolvedSelectedTextAnchors: anchors,
      selectedTexts: ["Passage."],
      selectedTextSources: ["pdf"],
      selectedTextPaperContexts: [paperA],
      selectedTextNoteContexts: [undefined],
      paperContexts: [paperA],
      pdfPaperContexts: [pdfPaper],
      fullTextPaperContexts: [paperB],
      citationPaperContexts: [citationPaper],
      selectedCollectionContexts: collections,
      selectedTagContexts: [],
      attachments: modelAttachments,
      localDocuments,
      screenshots: images,
      forcedSkillIds: ["skill-x"],
      effectiveRequestConfig,
      history: llmHistory,
    } as any);
    assert.notProperty(params, "activePaperContext");
    assert.strictEqual(params.attachments, modelAttachments);
    assert.strictEqual(params.forcedSkillIds, site.opts.forcedSkillIds);
    assert.strictEqual(params.history, llmHistory);
    assert.strictEqual(params.paperContexts, site.contextPlan.paperContexts);
  });

  it("asks for the visible attachments only when the model list is absent (`||`)", function () {
    assert.strictEqual(
      codexSendRequestParamsForTests(sendSite({ modelAttachments: undefined }))
        .attachments,
      visibleAttachments,
    );
    const emptyModel: any[] = [];
    assert.strictEqual(
      codexSendRequestParamsForTests(sendSite({ modelAttachments: emptyModel }))
        .attachments,
      emptyModel,
    );
  });

  it("routes skills on the visible attachments with empty lists dropped", function () {
    const skillContext = codexSendSkillContextForTests(sendSite());
    assert.deepStrictEqual(skillContext, {
      forcedSkillIds: ["skill-x"],
      selectedTextContexts: [passage],
      resolvedSelectedTextAnchors: anchors,
      selectedTexts: ["Passage."],
      selectedTextSources: ["pdf"],
      selectedTextPaperContexts: [paperA],
      selectedTextNoteContexts: undefined,
      selectedPaperContexts: [paperA],
      pdfPaperContexts: [pdfPaper],
      localDocuments,
      fullTextPaperContexts: [paperB],
      pinnedPaperContexts: [pinnedPaper],
      selectedCollectionContexts: collections,
      selectedTagContexts: undefined,
      screenshots: images,
      attachments: visibleAttachments,
    } as any);
  });

  it("drops every empty list from the skill context", function () {
    const skillContext = codexSendSkillContextForTests(
      sendSite({
        userMessage: { timestamp: 1, pinnedPaperContexts: [] },
        selectedTextContextsForMessage: [],
        resolvedSelectedTextAnchors: [],
        selectedTextsForMessage: [],
        selectedTextSourcesForMessage: [],
        selectedTextPaperContextsForMessage: [undefined],
        selectedTextNoteContextsForMessage: [],
        contextPlan: { paperContexts: [], fullTextPaperContexts: [] },
        normalizedPdfPaperContexts: [],
        selectedCollectionContextsForMessage: [],
        selectedTagContextsForMessage: [],
        attachments: [],
        localDocuments: [],
        allSendImages: [],
        opts: { forcedSkillIds: [] },
      }),
    );
    assert.deepStrictEqual(skillContext, {
      forcedSkillIds: undefined,
      selectedTextContexts: undefined,
      resolvedSelectedTextAnchors: undefined,
      selectedTexts: undefined,
      selectedTextSources: undefined,
      selectedTextPaperContexts: undefined,
      selectedTextNoteContexts: undefined,
      selectedPaperContexts: undefined,
      pdfPaperContexts: undefined,
      localDocuments: undefined,
      fullTextPaperContexts: undefined,
      pinnedPaperContexts: undefined,
      selectedCollectionContexts: undefined,
      selectedTagContexts: undefined,
      screenshots: undefined,
      attachments: undefined,
    });
  });
});

describe("request context: Codex retry site (golden)", function () {
  it("passes the agent request builder the retry's literal fields", function () {
    const site = retrySite();
    const params = codexRetryRequestParamsForTests(site);
    assert.deepStrictEqual(params, {
      conversationKey: 8,
      conversationGeneration: 4,
      sourceMessageTimestamp: 5678,
      item,
      userText: "Stored question",
      selectedTextContexts: [passage],
      resolvedSelectedTextAnchors: anchors,
      selectedTexts: ["Stored passage."],
      selectedTextSources: ["note"],
      selectedTextPaperContexts: [undefined],
      selectedTextNoteContexts: [{ noteItemId: 9, title: "N" }],
      paperContexts: [paperA],
      pdfPaperContexts: [pdfPaper],
      fullTextPaperContexts: [],
      citationPaperContexts: [citationPaper],
      selectedCollectionContexts: [],
      selectedTagContexts: tags,
      attachments: visibleAttachments,
      localDocuments: undefined,
      screenshots: images,
      forcedSkillIds: ["skill-stored"],
      effectiveRequestConfig,
      history: llmHistory,
    } as any);
    assert.notProperty(params, "activePaperContext");
    assert.strictEqual(
      params.forcedSkillIds,
      site.retryPair.userMessage.forcedSkillIds,
    );
  });

  it("falls back to no selected texts when the stored message has none", function () {
    const site = retrySite();
    delete site.retryPair.userMessage.selectedTexts;
    assert.deepStrictEqual(
      codexRetryRequestParamsForTests(site).selectedTexts,
      [],
    );
    assert.isUndefined(codexRetrySkillContextForTests(site).selectedTexts);
  });

  it("routes skills on the stored message with empty lists dropped", function () {
    assert.deepStrictEqual(codexRetrySkillContextForTests(retrySite()), {
      forcedSkillIds: ["skill-stored"],
      selectedTextContexts: [passage],
      resolvedSelectedTextAnchors: anchors,
      selectedTexts: ["Stored passage."],
      selectedTextSources: ["note"],
      selectedTextPaperContexts: undefined,
      selectedTextNoteContexts: [{ noteItemId: 9, title: "N" }],
      selectedPaperContexts: [paperA],
      pdfPaperContexts: [pdfPaper],
      localDocuments: undefined,
      fullTextPaperContexts: undefined,
      pinnedPaperContexts: [pinnedPaper],
      selectedCollectionContexts: undefined,
      selectedTagContexts: tags,
      screenshots: images,
      attachments: visibleAttachments,
    } as any);
  });
});

describe("request context projections", function () {
  const context: TurnRequestContext = {
    activePaperContext: paperB,
    selectedTextContexts: [passage],
    resolvedSelectedTextAnchors: anchors,
    selectedTexts: ["Passage."],
    selectedTextSources: ["pdf"],
    selectedTextPaperContexts: [paperA],
    selectedTextNoteContexts: [undefined],
    selectedPaperContexts: [paperA],
    pdfPaperContexts: [pdfPaper],
    fullTextPaperContexts: [paperB],
    pinnedPaperContexts: [pinnedPaper],
    citationPaperContexts: [citationPaper],
    selectedCollectionContexts: collections,
    selectedTagContexts: tags,
    attachments: modelAttachments,
    skillAttachments: visibleAttachments,
    localDocuments,
    screenshots: images,
    forcedSkillIds: ["skill-x"],
  };
  const turn = {
    conversationKey: 1,
    conversationGeneration: 2,
    sourceMessageTimestamp: 3,
    item,
    userText: "u",
    effectiveRequestConfig,
    history: llmHistory,
  };

  it("projects the context onto the agent request parameters", function () {
    assert.deepStrictEqual(toAgentRuntimeRequestParams(context, turn), {
      ...turn,
      activePaperContext: paperB,
      selectedTextContexts: [passage],
      resolvedSelectedTextAnchors: anchors,
      selectedTexts: ["Passage."],
      selectedTextSources: ["pdf"],
      selectedTextPaperContexts: [paperA],
      selectedTextNoteContexts: [undefined],
      paperContexts: [paperA],
      pdfPaperContexts: [pdfPaper],
      fullTextPaperContexts: [paperB],
      citationPaperContexts: [citationPaper],
      selectedCollectionContexts: collections,
      selectedTagContexts: tags,
      attachments: modelAttachments,
      localDocuments,
      screenshots: images,
      forcedSkillIds: ["skill-x"],
    } as any);
  });

  it("keeps a field the context leaves out absent, not undefined", function () {
    const {
      forcedSkillIds: _forced,
      activePaperContext: _active,
      ...rest
    } = context;
    const params = toAgentRuntimeRequestParams(rest, turn);
    assert.notProperty(params, "forcedSkillIds");
    assert.notProperty(params, "activePaperContext");
  });

  it("projects the context onto the skill context with empty lists dropped", function () {
    assert.deepStrictEqual(toCodexNativeSkillContext(context), {
      forcedSkillIds: ["skill-x"],
      selectedTextContexts: [passage],
      resolvedSelectedTextAnchors: anchors,
      selectedTexts: ["Passage."],
      selectedTextSources: ["pdf"],
      selectedTextPaperContexts: [paperA],
      selectedTextNoteContexts: undefined,
      selectedPaperContexts: [paperA],
      pdfPaperContexts: [pdfPaper],
      localDocuments,
      fullTextPaperContexts: [paperB],
      pinnedPaperContexts: [pinnedPaper],
      selectedCollectionContexts: collections,
      selectedTagContexts: tags,
      screenshots: images,
      attachments: visibleAttachments,
    } as any);
  });
});
