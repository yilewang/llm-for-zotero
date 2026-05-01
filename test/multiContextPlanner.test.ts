import { assert } from "chai";
import {
  assembleFullMultiPaperContext,
  assembleRetrievedMultiPaperContext,
  resolveMultiContextPlan,
  selectContextAssemblyMode,
} from "../src/modules/contextPanel/multiContextPlanner";
import { COLLECTION_RETRIEVAL_MAX_PAPERS } from "../src/modules/contextPanel/constants";
import {
  buildChunkMetadata,
  buildPaperKey,
} from "../src/modules/contextPanel/pdfContext";
import { pdfTextCache } from "../src/modules/contextPanel/state";
import type {
  ChunkStat,
  PaperContextRef,
  PdfContext,
} from "../src/modules/contextPanel/types";

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) || []).filter(
    (token) => token.length >= 3,
  );
}

function buildPdfContext(title: string, chunks: string[]): PdfContext {
  const docFreq: Record<string, number> = {};
  const chunkStats: ChunkStat[] = chunks.map((chunk, index) => {
    const tf: Record<string, number> = {};
    const terms = tokenize(chunk);
    for (const term of terms) {
      tf[term] = (tf[term] || 0) + 1;
    }
    const uniqueTerms = Object.keys(tf);
    for (const term of uniqueTerms) {
      docFreq[term] = (docFreq[term] || 0) + 1;
    }
    return {
      index,
      length: terms.length,
      tf,
      uniqueTerms,
    };
  });
  const avgChunkLength = chunkStats.length
    ? chunkStats.reduce((sum, chunk) => sum + chunk.length, 0) /
      chunkStats.length
    : 0;
  return {
    title,
    chunks,
    chunkMeta: buildChunkMetadata(chunks),
    chunkStats,
    docFreq,
    avgChunkLength,
    fullLength: chunks.join("\n\n").length,
  };
}

type MockItem = {
  id: number;
  parentID?: number;
  libraryID?: number;
  attachmentContentType?: string;
  firstCreator?: string;
  dateModified?: string;
  isAttachment: () => boolean;
  isRegularItem: () => boolean;
  getDisplayTitle?: () => string;
  getCreators?: () => Array<{ firstName?: string; lastName?: string; name?: string }>;
  getField: (field: string) => string;
  getAttachments: () => number[];
};

type MockCollection = {
  id: number;
  name: string;
  libraryID: number;
  getChildItems: () => number[];
  getChildCollections: () => number[];
};

const zoteroItems = new Map<number, MockItem>();
const zoteroCollections = new Map<number, MockCollection>();
let originalZotero: unknown;
let originalZtoolkit: unknown;

function registerMockPaper(params: {
  itemId: number;
  contextItemId: number;
  title: string;
  firstCreator?: string;
  year?: string;
  citationKey?: string;
  abstractNote?: string;
  dateModified?: string;
  pdfContext: PdfContext;
}): PaperContextRef {
  const parent: MockItem = {
    id: params.itemId,
    libraryID: 1,
    firstCreator: params.firstCreator,
    dateModified: params.dateModified,
    isAttachment: () => false,
    isRegularItem: () => true,
    getDisplayTitle: () => params.title,
    getCreators: () =>
      params.firstCreator ? [{ name: params.firstCreator }] : [],
    getField: (field: string) => {
      switch (field) {
        case "title":
          return params.title;
        case "firstCreator":
          return params.firstCreator || "";
        case "year":
        case "date":
        case "issued":
          return params.year || "";
        case "citationKey":
          return params.citationKey || "";
        case "abstractNote":
          return params.abstractNote || "";
        default:
          return "";
      }
    },
    getAttachments: () => [params.contextItemId],
  };
  const attachment: MockItem = {
    id: params.contextItemId,
    parentID: params.itemId,
    libraryID: 1,
    attachmentContentType: "application/pdf",
    isAttachment: () => true,
    isRegularItem: () => false,
    getField: (field: string) => {
      switch (field) {
        case "title":
          return `${params.title} PDF`;
        default:
          return "";
      }
    },
    getAttachments: () => [],
  };
  zoteroItems.set(parent.id, parent);
  zoteroItems.set(attachment.id, attachment);
  pdfTextCache.set(attachment.id, params.pdfContext);
  return {
    itemId: params.itemId,
    contextItemId: params.contextItemId,
    title: params.title,
    firstCreator: params.firstCreator,
    year: params.year,
    citationKey: params.citationKey,
  };
}

function buildActiveAttachment(itemId: number, contextItemId: number): MockItem {
  return {
    id: contextItemId,
    parentID: itemId,
    attachmentContentType: "application/pdf",
    isAttachment: () => true,
    isRegularItem: () => false,
    getField: (_field: string) => "",
    getAttachments: () => [],
  };
}

describe("multiContextPlanner", function () {
  before(function () {
    originalZotero = (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero;
    originalZtoolkit = (globalThis as typeof globalThis & { ztoolkit?: unknown }).ztoolkit;
    const prefs: Record<string, unknown> = {};
    (globalThis as typeof globalThis & { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      Items: {
        get(id: number) {
          return zoteroItems.get(id) || null;
        },
      },
      Collections: {
        get(id: number) {
          return zoteroCollections.get(id) || null;
        },
      },
      Prefs: {
        get: (key: string) => prefs[key],
        set: (key: string, value: unknown) => { prefs[key] = value; },
      },
      PDFWorker: {
        getFullText: async (id: number) => ({
          text: `Abstract\nCalibration drift affects robust retrieval for attachment ${id}.`,
        }),
      },
    } as unknown as typeof Zotero;
  });

  after(function () {
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
      originalZotero;
    (globalThis as typeof globalThis & { ztoolkit?: unknown }).ztoolkit =
      originalZtoolkit;
  });

  afterEach(function () {
    pdfTextCache.clear();
    zoteroItems.clear();
    zoteroCollections.clear();
  });

  it("selects full mode when full text fits context budget", function () {
    const mode = selectContextAssemblyMode({
      fullContextText: "A short full context",
      fullContextTokens: 120,
      contextBudgetTokens: 2_000,
    });
    assert.equal(mode, "full");
  });

  it("selects retrieval mode when full text exceeds context budget", function () {
    const mode = selectContextAssemblyMode({
      fullContextText: "Very long context",
      fullContextTokens: 12_000,
      contextBudgetTokens: 1_500,
    });
    assert.equal(mode, "retrieval");
  });

  it("assembles full multi-paper context blocks", function () {
    const paperA: PaperContextRef = {
      itemId: 3,
      contextItemId: 33,
      title: "Paper C",
    };
    const full = assembleFullMultiPaperContext({
      papers: [
        {
          paperContext: paperA,
          contextItem: null,
          pdfContext: buildPdfContext("C", ["Full text block one.", "Two."]),
        },
      ] as any,
    });
    assert.include(full.contextText, "Full Paper Contexts:");
    assert.include(full.contextText, "Paper 1");
    assert.include(full.contextText, "Answer format when quoting this paper:");
    assert.isAbove(full.estimatedTokens, 0);
  });

  it("reserves context budget for an existing prefix block", async function () {
    const withoutPrefix = await resolveMultiContextPlan({
      conversationMode: "open",
      activeContextItem: null,
      question: "summarize this",
      paperContexts: [],
      fullTextPaperContexts: [],
      historyPaperContexts: [],
      history: [],
      model: "gpt-4o-mini",
    });
    const withPrefix = await resolveMultiContextPlan({
      conversationMode: "open",
      activeContextItem: null,
      question: "summarize this",
      contextPrefix:
        "Context Result\n- Source: extracted text\n" + "detail ".repeat(400),
      paperContexts: [],
      fullTextPaperContexts: [],
      historyPaperContexts: [],
      history: [],
      model: "gpt-4o-mini",
    });

    assert.isBelow(
      withPrefix.contextBudget.contextBudgetTokens,
      withoutPrefix.contextBudget.contextBudgetTokens,
    );
  });

  it("uses full paper context in paper mode when the active paper is marked for full text", async function () {
    const paper = registerMockPaper({
      itemId: 10,
      contextItemId: 11,
      title: "Default Paper",
      firstCreator: "Smith",
      year: "2024",
      pdfContext: buildPdfContext("Default Paper", [
        "A concise abstract and introduction block.",
        "Methods and results fit comfortably in context.",
      ]),
    });
    const plan = await resolveMultiContextPlan({
      conversationMode: "paper",
      activeContextItem: buildActiveAttachment(paper.itemId, paper.contextItemId) as any,
      question: "Summarize this paper.",
      paperContexts: [],
      fullTextPaperContexts: [paper],
      historyPaperContexts: [],
      history: [],
      model: "gpt-4o-mini",
    });

    assert.equal(plan.mode, "full");
    assert.equal(plan.strategy, "paper-first-full");
    assert.equal(plan.selectedChunkCount, 0);
    assert.equal(plan.selectedPaperCount, 1);
    assert.include(plan.contextText, "Full Paper Contexts:");
    assert.include(plan.contextText, "Paper Text:");
    assert.notInclude(plan.contextText, "Retrieved Evidence:");
  });

  it("forces full paper context when the active paper is explicitly set to full text even if the paper is large", async function () {
    const paper = registerMockPaper({
      itemId: 12,
      contextItemId: 13,
      title: "Large First Turn",
      firstCreator: "Nguyen",
      year: "2025",
      pdfContext: buildPdfContext("Large First Turn", [
        "Abstract\n" + "signal ".repeat(1500).trim(),
        "Methods\n" + "detail ".repeat(2500).trim(),
        "Results\n" + "result ".repeat(2500).trim(),
      ]),
    });
    const plan = await resolveMultiContextPlan({
      conversationMode: "paper",
      activeContextItem: buildActiveAttachment(paper.itemId, paper.contextItemId) as any,
      question: "Summarize the paper.",
      paperContexts: [],
      fullTextPaperContexts: [paper],
      historyPaperContexts: [],
      history: [],
      model: "gpt-4o-mini",
      advanced: {
        temperature: 0.2,
        maxTokens: 512,
        inputTokenCap: 2048,
      },
    });

    assert.equal(plan.mode, "full");
    assert.equal(plan.strategy, "paper-first-full");
    assert.equal(plan.selectedChunkCount, 0);
    assert.include(plan.contextText, "Full Paper Contexts:");
    assert.notInclude(plan.contextText, "Retrieved Evidence:");
  });

  it("uses focused retrieval on paper-mode follow-up turns even when full text would fit", async function () {
    const paper = registerMockPaper({
      itemId: 14,
      contextItemId: 15,
      title: "Follow-up Paper",
      firstCreator: "Lee",
      year: "2024",
      pdfContext: buildPdfContext("Follow-up Paper", [
        "Abstract\nThis paper studies calibration drift in retrieval systems.",
        "Methods\nWe evaluate hybrid BM25 and embedding retrieval.",
        "Results\nHybrid retrieval improves recall on follow-up questions.",
        "Discussion\nThe abstract remains useful as a stable anchor.",
      ]),
    });
    const plan = await resolveMultiContextPlan({
      conversationMode: "paper",
      activeContextItem: buildActiveAttachment(paper.itemId, paper.contextItemId) as any,
      question: "What do the results say about recall?",
      paperContexts: [],
      fullTextPaperContexts: [],
      historyPaperContexts: [],
      history: [{ role: "user", content: "Summarize this paper." }],
      model: "gpt-4o-mini",
    });

    assert.equal(plan.mode, "retrieval");
    assert.equal(plan.strategy, "paper-followup-retrieval");
    assert.isAtLeast(plan.selectedChunkCount, 2);
    assert.isAtMost(plan.selectedChunkCount, 5);
    assert.include(plan.contextText, "Retrieved Evidence:");
    assert.notInclude(plan.contextText, "Full Paper Contexts:");
    assert.include(
      plan.contextText,
      "This paper studies calibration drift in retrieval systems.",
    );
  });

  it("keeps exactly one abstract anchor in paper-mode follow-up retrieval when available", async function () {
    const paper: PaperContextRef = {
      itemId: 30,
      contextItemId: 31,
      title: "Abstract Anchor Paper",
      firstCreator: "Garcia",
      year: "2026",
    };
    const pdfContext = buildPdfContext("Abstract Anchor Paper", [
      "Abstract\nThe abstract anchor should always be present in follow-up retrieval.",
      "A second paragraph that still belongs to the abstract section.",
      "Methods\nThe method chunk should also be eligible.",
      "Results\nThe results chunk should be eligible too.",
      "Discussion\nThe discussion chunk provides interpretation.",
    ]);
    const result = await assembleRetrievedMultiPaperContext({
      papers: [
        {
          paperContext: paper,
          contextItem: null,
          pdfContext,
          paperKey: buildPaperKey(paper),
          isActive: true,
          pinKind: "implicit-active",
          order: 1,
        },
      ] as any,
      question: "What does the paper say overall?",
      contextBudgetTokens: 10_000,
      minChunksByPaper: new Map(),
      options: {
        guaranteedAbstractPaperKey: buildPaperKey(paper),
        minTotalChunks: 2,
        maxChunks: 5,
      },
    });

    assert.isAtLeast(result.selectedChunkCount, 2);
    assert.isAtMost(result.selectedChunkCount, 5);
    assert.include(
      result.contextText,
      "The abstract anchor should always be present in follow-up retrieval.",
    );
    assert.equal(
      (
        result.contextText.match(
          /The abstract anchor should always be present in follow-up retrieval\./g,
        ) || []
      ).length,
      1,
    );
    assert.notInclude(
      result.contextText,
      "A second paragraph that still belongs to the abstract section.",
    );
  });

  it("falls back to hybrid chunks when no abstract chunk exists in paper-mode follow-up retrieval", async function () {
    const paper: PaperContextRef = {
      itemId: 32,
      contextItemId: 33,
      title: "No Abstract Paper",
      firstCreator: "Patel",
      year: "2026",
    };
    const result = await assembleRetrievedMultiPaperContext({
      papers: [
        {
          paperContext: paper,
          contextItem: null,
          pdfContext: buildPdfContext("No Abstract Paper", [
            "Introduction\nThis introduction frames the retrieval problem.",
            "Methods\nThe method chunk explains the setup.",
            "Results\nResults describe the most important outcome.",
          ]),
          paperKey: buildPaperKey(paper),
          isActive: true,
          pinKind: "implicit-active",
          order: 1,
        },
      ] as any,
      question: "What is the main outcome?",
      contextBudgetTokens: 10_000,
      minChunksByPaper: new Map(),
      options: {
        guaranteedAbstractPaperKey: buildPaperKey(paper),
        minTotalChunks: 2,
        maxChunks: 5,
      },
    });

    assert.isAtLeast(result.selectedChunkCount, 2);
    assert.isAtMost(result.selectedChunkCount, 5);
    assert.include(result.contextText, "Results describe the most important outcome.");
  });

  it("adds a capability reminder only for follow-up questions about access or coverage", async function () {
    const paper = registerMockPaper({
      itemId: 34,
      contextItemId: 35,
      title: "Capability Paper",
      firstCreator: "Chen",
      year: "2024",
      pdfContext: buildPdfContext("Capability Paper", [
        "Abstract\nThe paper studies retrieval interfaces.",
        "Results\nFocused retrieval remains accurate.",
      ]),
    });
    const plan = await resolveMultiContextPlan({
      conversationMode: "paper",
      activeContextItem: buildActiveAttachment(paper.itemId, paper.contextItemId) as any,
      question: "Do you have access to the full text or only a few sections?",
      paperContexts: [],
      fullTextPaperContexts: [],
      historyPaperContexts: [],
      history: [{ role: "user", content: "Summarize this paper." }],
      model: "gpt-4o-mini",
    });
    const unrelated = await resolveMultiContextPlan({
      conversationMode: "paper",
      activeContextItem: buildActiveAttachment(paper.itemId, paper.contextItemId) as any,
      question: "What is the main finding?",
      paperContexts: [],
      fullTextPaperContexts: [],
      historyPaperContexts: [],
      history: [{ role: "user", content: "Summarize this paper." }],
      model: "gpt-4o-mini",
    });

    assert.equal(plan.strategy, "paper-followup-retrieval");
    assert.include(plan.assistantInstruction || "", "full text");
    assert.isUndefined(unrelated.assistantInstruction);
  });

  it("keeps explicit full-text papers in full context before falling back to retrieval for overflow", async function () {
    const longChunk = "full-text ".repeat(12000).trim();
    const pinnedA = registerMockPaper({
      itemId: 20,
      contextItemId: 21,
      title: "Pinned A",
      firstCreator: "Alpha",
      year: "2023",
      pdfContext: buildPdfContext("Pinned A", [longChunk]),
    });
    const pinnedB = registerMockPaper({
      itemId: 22,
      contextItemId: 23,
      title: "Pinned B",
      firstCreator: "Beta",
      year: "2022",
      pdfContext: buildPdfContext("Pinned B", [longChunk]),
    });
    const plan = await resolveMultiContextPlan({
      conversationMode: "open",
      activeContextItem: null,
      question: "Compare the two full-text papers.",
      paperContexts: [],
      fullTextPaperContexts: [pinnedA, pinnedB],
      historyPaperContexts: [],
      history: [],
      model: "gpt-4o-mini",
      advanced: {
        temperature: 0.2,
        maxTokens: 1200,
        inputTokenCap: 8000,
      },
    });

    assert.equal(plan.mode, "full");
    assert.isAtLeast(plan.selectedPaperCount, 1);
    assert.include(plan.contextText, "Full Paper Contexts:");
    assert.match(plan.contextText, /Title: Pinned [AB]/);
  });

  it("metadata-ranks large collection scopes and caps deep retrieval", async function () {
    const itemIds: number[] = [];
    for (let index = 1; index <= 60; index += 1) {
      const suffix = String(index).padStart(3, "0");
      itemIds.push(1_000 + index);
      registerMockPaper({
        itemId: 1_000 + index,
        contextItemId: 2_000 + index,
        title: `Calibration Drift Paper ${suffix}`,
        firstCreator: "Rivera",
        year: "2026",
        abstractNote:
          "This abstract discusses calibration drift and robust retrieval.",
        pdfContext: buildPdfContext(`Calibration Drift Paper ${suffix}`, [
          `Abstract\nCalibration drift affects robust retrieval in paper ${suffix}.`,
          `Methods\nThis paper ${suffix} contains follow-up implementation detail.`,
        ]),
      });
    }
    zoteroCollections.set(55, {
      id: 55,
      name: "Large Methods Folder",
      libraryID: 1,
      getChildItems: () => itemIds,
      getChildCollections: () => [],
    });

    const plan = await resolveMultiContextPlan({
      conversationMode: "open",
      activeContextItem: null,
      question: "What does calibration drift say about robust retrieval?",
      collectionContexts: [
        {
          collectionId: 55,
          name: "Large Methods Folder",
          libraryID: 1,
        },
      ],
      paperContexts: [],
      fullTextPaperContexts: [],
      historyPaperContexts: [],
      history: [],
      model: "gpt-4o-mini",
      advanced: {
        temperature: 0.2,
        maxTokens: 512,
        inputTokenCap: 8_000,
      },
    });

    assert.equal(plan.mode, "retrieval");
    assert.include(plan.contextText, "Selected Zotero collection scopes:");
    assert.include(plan.contextText, "metadata-ranked shortlist");
    assert.include(
      plan.contextText,
      `${COLLECTION_RETRIEVAL_MAX_PAPERS} of 60 PDF-backed papers selected`,
    );
    assert.include(plan.contextText, "Title: Calibration Drift Paper 001");
    assert.notInclude(plan.contextText, "Title: Calibration Drift Paper 060");
    assert.isAtMost(plan.selectedPaperCount, COLLECTION_RETRIEVAL_MAX_PAPERS);
    assert.isAtLeast(plan.citationPaperContexts?.length || 0, 1);
    assert.isAtMost(
      plan.citationPaperContexts?.length || 0,
      COLLECTION_RETRIEVAL_MAX_PAPERS,
    );
    assert.include(
      (plan.citationPaperContexts || []).map((paper) => paper.title),
      "Calibration Drift Paper 001",
    );
    assert.notInclude(
      (plan.citationPaperContexts || []).map((paper) => paper.title),
      "Calibration Drift Paper 060",
    );
  });
});
