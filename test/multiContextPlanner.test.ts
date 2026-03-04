import { assert } from "chai";
import {
  assembleFullMultiPaperContext,
  assembleRetrievedMultiPaperContext,
  resolveMultiContextPlan,
  selectContextAssemblyMode,
} from "../src/modules/contextPanel/multiContextPlanner";
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
    embeddingFailed: true,
  };
}

type MockItem = {
  id: number;
  parentID?: number;
  attachmentContentType?: string;
  firstCreator?: string;
  isAttachment: () => boolean;
  isRegularItem: () => boolean;
  getField: (field: string) => string;
  getAttachments: () => number[];
};

const zoteroItems = new Map<number, MockItem>();
let originalZotero: unknown;

function registerMockPaper(params: {
  itemId: number;
  contextItemId: number;
  title: string;
  firstCreator?: string;
  year?: string;
  citationKey?: string;
  pdfContext: PdfContext;
}): PaperContextRef {
  const parent: MockItem = {
    id: params.itemId,
    firstCreator: params.firstCreator,
    isAttachment: () => false,
    isRegularItem: () => true,
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
        default:
          return "";
      }
    },
    getAttachments: () => [params.contextItemId],
  };
  const attachment: MockItem = {
    id: params.contextItemId,
    parentID: params.itemId,
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
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      Items: {
        get(id: number) {
          return zoteroItems.get(id) || null;
        },
      },
    } as unknown as typeof Zotero;
  });

  after(function () {
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
      originalZotero;
  });

  afterEach(function () {
    pdfTextCache.clear();
    zoteroItems.clear();
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

  it("assembles retrieval evidence with per-paper coverage", async function () {
    const paperA: PaperContextRef = {
      itemId: 1,
      contextItemId: 11,
      title: "Paper A",
    };
    const paperB: PaperContextRef = {
      itemId: 2,
      contextItemId: 22,
      title: "Paper B",
    };
    const papers = [
      {
        paperContext: paperA,
        contextItem: null,
        pdfContext: buildPdfContext("A", [
          "shared phenomenon and common result",
          "method details and calibration",
          "additional shared analysis",
        ]),
      },
      {
        paperContext: paperB,
        contextItem: null,
        pdfContext: buildPdfContext("B", [
          "common result appears again in paper B",
          "implementation details",
          "discussion on shared behavior",
        ]),
      },
    ];
    const result = await assembleRetrievedMultiPaperContext({
      papers: papers as any,
      question: "summarize common result",
      contextBudgetTokens: 10_000,
      minChunksByPaper: new Map([
        [buildPaperKey(paperA), 2],
        [buildPaperKey(paperB), 1],
      ]),
    });
    assert.isAtLeast(result.selectedChunkCount, 3);
    assert.isAtLeast(result.selectedPaperCount, 2);
    assert.include(result.contextText, "Retrieved Evidence:");
    assert.include(result.contextText, "Paper 1");
    assert.include(result.contextText, "Paper 2");
    assert.include(result.contextText, "Source label:");
    assert.include(result.contextText, "Quoted evidence:");
    assert.notInclude(result.contextText, "[P1-");
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
      pinnedPaperContexts: [],
      historyPaperContexts: [],
      history: [],
      model: "gpt-4o-mini",
    });
    const withPrefix = await resolveMultiContextPlan({
      conversationMode: "open",
      activeContextItem: null,
      question: "summarize this",
      contextPrefix: "Agent Tool Result\n- Tool: read_paper_text\n" + "detail ".repeat(400),
      paperContexts: [],
      pinnedPaperContexts: [],
      historyPaperContexts: [],
      history: [],
      model: "gpt-4o-mini",
    });

    assert.isBelow(
      withPrefix.contextBudget.contextBudgetTokens,
      withoutPrefix.contextBudget.contextBudgetTokens,
    );
  });

  it("uses full paper context by default in paper mode when the active paper fits", async function () {
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
      pinnedPaperContexts: [],
      historyPaperContexts: [],
      history: [],
      model: "gpt-4o-mini",
    });

    assert.equal(plan.mode, "full");
    assert.equal(plan.selectedChunkCount, 0);
    assert.equal(plan.selectedPaperCount, 1);
    assert.include(plan.contextText, "Full Paper Contexts:");
    assert.include(plan.contextText, "Paper Text:");
    assert.notInclude(plan.contextText, "Retrieved Evidence:");
  });

  it("keeps explicit pinned papers in full context before falling back to retrieval for overflow", async function () {
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
      question: "Compare the two pinned papers.",
      paperContexts: [],
      pinnedPaperContexts: [pinnedA, pinnedB],
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
});
