/**
 * The later import of a document's outside papers (library_import
 * kind:'document_citations'): each cited outside paper is found in the
 * library or imported by identifier, and a new version of the document cites
 * those items. These tests hold the input, the refusals, the duplicate check,
 * the new version's content, the authorization path, and that the card's
 * "Cite without importing" does not hold an explicit later import back.
 */
import { assert } from "chai";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { DocumentCitationEvidence } from "../src/agent/documents/citationService";
import { finalizeDocument } from "../src/agent/documents/finalizer";
import {
  initPlanDocumentStore,
  loadPlanDocument,
  savePlanDocumentInTransaction,
} from "../src/agent/documents/store";
import type {
  DocumentArtifactV2,
  OutsidePaperSnapshot,
  PlanCitationCluster,
  PlanDocumentAsset,
  PlanVerifiedQuote,
} from "../src/agent/documents/types";
import type { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import {
  getOrCreateZoteroMcpBearerToken,
  registerMcpServer,
  registerScopedZoteroMcpScope,
  unregisterMcpServer,
  ZOTERO_MCP_ENDPOINT_PATH,
  ZOTERO_MCP_SCOPE_HEADER,
} from "../src/agent/mcp/server";
import { clearAgentToolResultHandleStore } from "../src/agent/store/toolResultHandles";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import type { AgentToolRegistry } from "../src/agent/tools/registry";
import {
  createImportDocumentCitationsTool,
  findLibraryItemForPaper,
} from "../src/agent/tools/write/importDocumentCitations";
import type { DirectDocumentFinalizer } from "../src/agent/documents/directFinalization";
import type {
  AgentPendingAction,
  AgentToolContext,
  AgentToolResult,
  PreparedToolExecution,
} from "../src/agent/types";
import { paperSourceId } from "../src/webAccess/paperSources";
import {
  createBatchLibrary,
  installBatchJournal,
  type BatchLibrary,
} from "./helpers/batchFixtures";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

const RUN_ID = "import-later-run";
const EARLIER_RUN_ID = "review-run";

type FakeItem = {
  id: number;
  libraryID: number;
  key: string;
  deleted: boolean;
  parentID?: number;
  isRegularItem: () => boolean;
  isNote: () => boolean;
  getField: (field: string) => string;
};

function fakeItem(
  id: number,
  key: string,
  fields: Record<string, string> = {},
  extra: Partial<FakeItem> = {},
): FakeItem {
  return {
    id,
    libraryID: 1,
    key,
    deleted: false,
    isRegularItem: () => true,
    isNote: () => false,
    getField: (field) => fields[field] || "",
    ...extra,
  };
}

const ALPHA = "paper_alpha";
const BETA = "paper_beta";
const GAMMA = "paper_gamma";
const DELTA = "paper_delta";
const EPSILON = "paper_epsilon";

function snapshot(
  paperId: string,
  title: string,
  identifiers: Partial<OutsidePaperSnapshot>,
): OutsidePaperSnapshot {
  return {
    paperId,
    ...identifiers,
    csl: {
      id: "ext-0",
      type: "article-journal",
      title,
      ...(identifiers.doi ? { DOI: identifiers.doi } : {}),
      ...(identifiers.url ? { URL: identifiers.url } : {}),
    },
  };
}

const PAPERS = [
  // The library holds it: the DOI differs only in case.
  snapshot(ALPHA, "Alpha drift", { doi: "10.1000/ALPHA" }),
  snapshot(BETA, "Beta preprint", { arxivId: "2101.00001" }),
  snapshot(GAMMA, "Gamma study", { pmid: "123456" }),
  snapshot(DELTA, "Delta lab page", { url: "https://lab.example/delta" }),
  snapshot(EPSILON, "Epsilon lost", { doi: "10.1000/missing" }),
];

const LOCATOR = {
  kind: "pdf_page" as const,
  attachmentItemKey: "ATTACH01",
  pageIndex: 3,
  sourceFingerprint: "fingerprint-1",
};

const EVIDENCE: DocumentCitationEvidence[] = [
  {
    version: 2,
    evidenceRef: "obs-1",
    observationId: "obs-1",
    libraryID: 1,
    itemKey: "ZOTERO01",
    sourceKind: "body",
    locator: LOCATOR,
  },
  {
    version: 2,
    evidenceRef: "obs-2",
    observationId: "obs-2",
    libraryID: 1,
    itemKey: "EXIST001",
    sourceKind: "abstract",
  },
];

const ASSET_BYTES = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
const ASSET: PlanDocumentAsset = {
  assetId: "figure-1",
  contentHash: `sha256:${createHash("sha256").update(ASSET_BYTES).digest("hex")}`,
  mimeType: "image/png",
  byteLength: ASSET_BYTES.byteLength,
  width: 10,
  height: 10,
  caption: "Drift over days.",
  durablePath: "/tmp/figure-1.png",
  provenance: {
    origin: "generated",
    generator: "matplotlib",
    generatorVersion: "3",
    evidenceRefs: ["obs-1"],
  },
};

const QUOTE: PlanVerifiedQuote = {
  quoteId: "Q1",
  text: "Representations drift over days.",
  libraryID: 1,
  itemKey: "ZOTERO01",
  attachmentItemKey: "ATTACH01",
  evidenceRefs: ["obs-1"],
  certificate: {
    contextItemId: 102,
    sourceFingerprint: "fingerprint-1",
    pageIndex: 3,
    sourceMatchText: "Representations drift over days.",
    sourceMatchKind: "exact",
    sourceMatchPageOccurrence: 0,
  },
};

const MARKDOWN = [
  "# Drift review",
  "",
  "Tuning drifts [[cite:C1]] while readouts hold [[cite:C2]].",
  "",
  "> Representations drift over days.",
  "",
  "Preprints agree [[cite:C3]]; a PubMed study [[cite:C4]] and a lab page [[cite:C5]] add detail, and one more [[cite:C6]] is cited.",
  "",
  "## Scope and limitations",
  "",
  "Outside papers were read to their abstracts.",
].join("\n");

const CITATIONS: PlanCitationCluster[] = [
  {
    citationId: "C1",
    sources: [
      {
        libraryID: 1,
        itemKey: "ZOTERO01",
        evidenceRefs: ["obs-1"],
        locator: LOCATOR,
      },
    ],
  },
  {
    // The library item and the outside paper it turns out to be.
    citationId: "C2",
    sources: [
      { libraryID: 1, itemKey: "EXIST001", evidenceRefs: [] },
      { kind: "outside", paperId: ALPHA, evidenceRefs: [] },
    ],
  },
  ...[BETA, GAMMA, DELTA, EPSILON].map((paperId, index) => ({
    citationId: `C${index + 3}`,
    sources: [{ kind: "outside" as const, paperId, evidenceRefs: [] }],
  })),
];

describe("library_import kind:'document_citations'", function () {
  let restoreJournal: () => void;
  let sqlite: DatabaseSync;
  let library: BatchLibrary;
  let registry: AgentToolRegistry;
  let items: Map<number, FakeItem>;
  let mode: "safe" | "auto" | "yolo";
  let callCount = 0;
  const originalFetch = globalThis.fetch;
  const originalIOUtils = (globalThis as { IOUtils?: unknown }).IOUtils;

  beforeEach(async function () {
    restoreJournal = await installBatchJournal();
    mode = "auto";
    const zotero = globalThis.Zotero as unknown as Record<string, unknown>;
    zotero.Prefs = { get: () => mode };
    // The document store's own tables run on SQLite; the journal keeps its
    // focused test adapter, which must stay the installed Zotero.DB.
    const journal = zotero.DB as {
      queryAsync: (sql: string, params?: unknown[]) => Promise<unknown>;
    };
    const journalQuery = journal.queryAsync.bind(journal);
    sqlite = new DatabaseSync(":memory:");
    const bindable = (params: unknown[] | undefined) =>
      (params || []).map((value) => (value === undefined ? null : value));
    journal.queryAsync = async (sql: string, params?: unknown[]) => {
      if (!/llm_for_zotero_plan_document/.test(sql))
        return journalQuery(sql, params);
      const statement = sqlite.prepare(sql);
      const head = sql.trimStart().toUpperCase();
      if (head.startsWith("SELECT") || head.startsWith("PRAGMA"))
        return statement.all(...(bindable(params) as never[]));
      statement.run(...(bindable(params) as never[]));
      return [];
    };
    items = new Map([
      [101, fakeItem(101, "ZOTERO01", { title: "Zotero paper" })],
      [
        501,
        fakeItem(501, "EXIST001", {
          title: "Alpha drift",
          DOI: "10.1000/alpha",
        }),
      ],
    ]);
    zotero.Items = {
      get: (id: number) => items.get(id) || null,
      getByLibraryAndKey: (libraryID: number, key: string) =>
        [...items.values()].find(
          (item) => item.libraryID === libraryID && item.key === key,
        ) || false,
    };
    zotero.Libraries = { userLibraryID: 1, get: () => undefined };
    zotero.DataDirectory = { dir: "/tmp/zotero-data" };
    (globalThis as { IOUtils?: unknown }).IOUtils = {
      read: async () => ASSET_BYTES,
      write: async () => undefined,
      makeDirectory: async () => undefined,
    };
    await initPlanDocumentStore();
    clearAgentToolResultHandleStore();

    library = createBatchLibrary([]);
    const gateway = library.zoteroGateway;
    let nextId = 9_000;
    gateway.getItem = (id: number) => items.get(id) || null;
    gateway.importPapersByIdentifiers = async (identifiers: string[]) => {
      library.importedIdentifiers.push(...identifiers);
      const rows = identifiers.map((identifier) => {
        if (identifier === "10.1000/missing")
          return {
            identifier,
            status: "not_found" as const,
            reason: "The translator returned no items",
          };
        const id = nextId++;
        // The translator records the identifier on the item it saves.
        const [, arxiv] = /^arxiv:(.+)$/.exec(identifier) || [];
        const [, pmid] = /^PMID:(\d+)$/.exec(identifier) || [];
        items.set(
          id,
          fakeItem(id, `IMPORT${id}`, {
            title: identifier,
            ...(arxiv
              ? { url: `http://arxiv.org/abs/${arxiv}` }
              : pmid
                ? { extra: `PMID: ${pmid}` }
                : { DOI: identifier }),
          }),
        );
        return { identifier, status: "imported" as const, itemId: id };
      });
      const itemIds = rows.flatMap((row) =>
        "itemId" in row && row.itemId ? [row.itemId] : [],
      );
      return {
        succeeded: itemIds.length,
        failed: rows.length - itemIds.length,
        itemIds,
        items: rows,
      };
    };
    gateway.searchItemsByConditions = async (params: {
      conditions: Array<{ condition: string; value: string }>;
    }) => {
      const [{ condition, value }] = params.conditions;
      const found = [...items.values()].filter((item) =>
        item
          .getField(condition)
          .toLowerCase()
          .includes(String(value).toLowerCase()),
      );
      return {
        items: found.map((item) => ({ itemId: item.id })),
        totalCount: found.length,
        returnedCount: found.length,
        offset: 0,
      };
    };
    gateway.formatStructuredCitations = (params: {
      clusters: Array<{
        citationId: string;
        items: Array<{
          itemId?: number;
          pageIndex?: number;
          outsideId?: string;
        }>;
      }>;
      outsideItems?: Array<{ id: string; title?: string }>;
    }) => {
      const label = (item: {
        itemId?: number;
        pageIndex?: number;
        outsideId?: string;
      }) =>
        item.outsideId
          ? `${params.outsideItems?.find((csl) => csl.id === item.outsideId)?.title}, 2021`
          : `Item ${item.itemId}${item.pageIndex === undefined ? "" : `, p. ${item.pageIndex + 1}`}`;
      const ids = [
        ...new Set(
          params.clusters.flatMap((cluster) =>
            cluster.items.map((item) => item.outsideId ?? item.itemId),
          ),
        ),
      ];
      return {
        styleId: "http://www.zotero.org/styles/apa",
        styleTitle: "APA",
        locale: "en-US",
        clusters: params.clusters.map((cluster) => {
          const text = `(${cluster.items.map(label).join("; ")})`;
          return { citationId: cluster.citationId, text, html: text };
        }),
        bibliographyEntries: ids.map((id) =>
          typeof id === "string"
            ? {
                outsideId: id,
                text: `${params.outsideItems?.find((csl) => csl.id === id)?.title}. (2021).`,
                html: "Outside.",
              }
            : { itemId: id, text: `Item ${id}. (2024).`, html: "Item." },
        ),
      };
    };
    registry = createBuiltInToolRegistry({
      zoteroGateway: gateway as never,
      pdfService: {} as never,
      pdfPageService: {} as never,
      retrievalService: {} as never,
    });
  });

  afterEach(function () {
    globalThis.fetch = originalFetch;
    (globalThis as { IOUtils?: unknown }).IOUtils = originalIOUtils;
    clearAgentToolResultHandleStore();
    sqlite.close();
    restoreJournal();
  });

  function makeContext(
    userText = "Import the papers this review cites.",
  ): AgentToolContext {
    const request = resolvedAgentRequest({
      conversationKey: library.conversationKey,
      libraryID: 1,
      mode: "agent",
      userText,
    });
    request.executionContext = {
      version: 1,
      executionId: RUN_ID,
      conversationKey: library.conversationKey,
      conversationGeneration: 0,
      chatLibraryID: 1,
      permissionOwner: "original_agent",
      workspaceSnapshot: { selectedPapers: [], selectedCollections: [] },
      configuredAccess: { libraryIDs: [1], outputDirectories: [] },
    };
    return {
      request,
      runId: RUN_ID,
      resourceSignature: "paper-A",
      item: null,
      currentAnswerText: "",
      modelName: "test",
    };
  }

  function prepare(
    args: Record<string, unknown>,
    context: AgentToolContext,
  ): Promise<PreparedToolExecution> {
    return registry.prepareExecution(
      {
        id: `library_import-${++callCount}`,
        name: "library_import",
        arguments: args,
      },
      context,
      { callerKind: "model" },
    );
  }

  async function run(
    args: Record<string, unknown>,
    context: AgentToolContext,
  ): Promise<AgentToolResult> {
    let prepared = await prepare(args, context);
    if (prepared.kind === "confirmation")
      prepared = await prepared.execute({ approved: true });
    if (prepared.kind !== "result") throw new Error("No result");
    return prepared.execution.result;
  }

  /** Publishes the earlier turn's review, as submit_document stored it. */
  async function publishReview(
    fields: {
      papers?: OutsidePaperSnapshot[];
      citations?: PlanCitationCluster[];
      markdown?: string;
      documentId?: string;
      conversationKey?: number;
      /** The run that made the document; the earlier turn's by default. */
      runId?: string;
    } = {},
  ): Promise<DocumentArtifactV2> {
    const papers = fields.papers || PAPERS;
    const citations = fields.citations || CITATIONS;
    const documentId = fields.documentId || `${EARLIER_RUN_ID}:document:1`;
    const finalized = await finalizeDocument({
      gateway: library.zoteroGateway as unknown as ZoteroGateway,
      input: {
        documentKind: "literature_review",
        integrityPolicy: "research_grounded",
        title: "Drift review",
        markdown: fields.markdown || MARKDOWN,
        citations,
        quotes: [],
        assets: fields.papers ? [] : [ASSET],
        groundingReviewed: "passed",
        groundingIssues: [],
      },
      now: 1_000,
      context: {
        documentId,
        documentVersion: 1,
        conversationKey: fields.conversationKey ?? library.conversationKey,
        integrityPolicy: "research_grounded",
        origin: {
          kind: "direct",
          runId: fields.runId || EARLIER_RUN_ID,
          sourceMessageTimestamp: 1_000,
        },
        spec: {
          kind: "literature_review",
          title: "Drift review",
          requiredSections: ["Scope and limitations"],
          requiresReferences: true,
          requiresCoverageSection: true,
          allowFigures: true,
          citationStyle: {
            styleId: "http://www.zotero.org/styles/apa",
            styleTitle: "APA",
            locale: "en-US",
          },
        },
        evidence: EVIDENCE,
        corpus: [
          { libraryID: 1, itemKey: "ZOTERO01" },
          { libraryID: 1, itemKey: "EXIST001" },
          ...papers.map((paper) => ({
            kind: "outside" as const,
            paperId: paper.paperId,
          })),
        ],
        outsidePapers: papers,
        quoteCorpusKeys: new Set(),
        coverageItems: [
          {
            libraryID: 1,
            itemKey: "ZOTERO01",
            title: "Zotero paper",
            status: "included",
            evidenceDepth: "body",
          },
        ],
        coverageStatus: "partial",
        validateAssetProvenance: () => undefined,
      },
    });
    // The quote was verified against the open PDF when the review was
    // published; its blockquote is already in the text.
    const document: DocumentArtifactV2 = papers.length
      ? {
          ...finalized.document,
          verifiedQuotes: [QUOTE],
          validation: {
            ...finalized.document.validation,
            quoteVerified: "verified",
          },
        }
      : finalized.document;
    await Zotero.DB.executeTransaction(async () => {
      await savePlanDocumentInTransaction({
        document,
        outbox: finalized.outbox,
      });
    });
    return (await loadPlanDocument(documentId)) as DocumentArtifactV2;
  }

  it("takes a documentId and nothing to import by itself", function () {
    const tool = registry.getTool("library_import")!;
    assert.isTrue(
      tool.validate({ kind: "document_citations", documentId: "doc-1" }).ok,
    );
    const missing = tool.validate({ kind: "document_citations" });
    assert.isFalse(missing.ok);
    assert.include((missing as { error: string }).error, "documentId");
    const mixed = tool.validate({
      kind: "document_citations",
      documentId: "doc-1",
      identifiers: ["10.1000/x"],
    });
    assert.isFalse(mixed.ok);
    assert.include((mixed as { error: string }).error, "only its documentId");
    assert.include(
      JSON.stringify(tool.spec.inputSchema),
      '"document_citations"',
    );
  });

  it("refuses a document that cites no outside paper, or one of another conversation", async function () {
    const plain = await publishReview({
      papers: [],
      citations: [CITATIONS[0]],
      markdown:
        "# Drift review\n\nTuning drifts [[cite:C1]].\n\n## Scope and limitations\n\nOne paper.",
      documentId: `${EARLIER_RUN_ID}:document:2`,
    });
    assert.notProperty(plain, "citationDraft");
    const refused = await run(
      { kind: "document_citations", documentId: plain.documentId },
      makeContext(),
    );
    assert.isTrue(refused.inputRejected, JSON.stringify(refused.content));
    assert.include(
      String((refused.content as { error?: unknown }).error),
      "cites no outside paper, so there is nothing to import",
    );
    const elsewhere = await publishReview({
      documentId: `${EARLIER_RUN_ID}:document:3`,
      conversationKey: 77,
    });
    const foreign = await run(
      { kind: "document_citations", documentId: elsewhere.documentId },
      makeContext(),
    );
    assert.isTrue(foreign.inputRejected);
    assert.include(
      String((foreign.content as { error?: unknown }).error),
      "no document",
    );
    assert.deepEqual(library.importedIdentifiers, []);
  });

  it("finds a library item by DOI, imports the rest by arXiv or PMID, and leaves a URL-only paper outside", async function () {
    mode = "safe";
    const original = await publishReview();
    const context = makeContext();
    const prepared = await prepare(
      { kind: "document_citations", documentId: original.documentId },
      context,
    );
    if (prepared.kind !== "confirmation")
      throw new Error("Safe confirms the import");
    const action: AgentPendingAction = prepared.action;
    assert.equal(action.toolName, "library_import");
    assert.include(action.description, '3 papers that "Drift review" cites');
    assert.include(action.description, "1 cited paper already in the library");
    assert.deepEqual(
      library.importedIdentifiers,
      [],
      "nothing before approval",
    );
    const done = await prepared.execute({ approved: true });
    if (done.kind !== "result") throw new Error("No result");
    const result = done.execution.result;
    assert.isTrue(result.ok, JSON.stringify(result.content));
    assert.deepEqual(library.importedIdentifiers, [
      "arxiv:2101.00001",
      "PMID:123456",
      "10.1000/missing",
    ]);
    const content = result.content as {
      papers: Array<Record<string, unknown>>;
      documentId: string;
      documentVersion: number;
      note: string;
    };
    assert.deepEqual(
      content.papers.map((paper) => [paper.paperId, paper.outcome]),
      [
        [ALPHA, "found_existing"],
        [BETA, "imported"],
        [GAMMA, "imported"],
        [DELTA, "not_importable"],
        [EPSILON, "failed"],
      ],
    );
    assert.equal(content.papers[0].itemId, 501);
    assert.include(String(content.papers[3].reason), "only a web page");
    assert.include(
      String(content.papers[4].reason),
      "The translator returned no items",
    );
    assert.notEqual(content.documentId, original.documentId);
    assert.match(content.documentId, new RegExp(`^${RUN_ID}:document:`));
    assert.equal(content.documentVersion, 2);
    assert.include(content.note, content.documentId);
    assert.include(content.note, "Do not submit the document again");
    // The new version is the turn's answer, as a submitted document is.
    const tool = registry.getTool("library_import")!;
    const input = tool.validate({
      kind: "document_citations",
      documentId: original.documentId,
    });
    if (!input.ok) throw new Error(input.error);
    const terminal = await tool.resolveTerminalResult!(
      input.value,
      result,
      context,
    );
    assert.equal(terminal?.documentId, content.documentId);
    assert.equal(
      terminal?.finalText,
      (await loadPlanDocument(content.documentId))?.visibleMarkdown,
    );
    assert.equal(result.materialRef?.documentId, content.documentId);
  });

  it("publishes a new version with the same text that cites the found and imported items", async function () {
    const original = await publishReview();
    const result = await run(
      { kind: "document_citations", documentId: original.documentId },
      makeContext(),
    );
    assert.isTrue(result.ok, JSON.stringify(result.content));
    const { documentId } = result.content as { documentId: string };
    const version = (await loadPlanDocument(documentId)) as DocumentArtifactV2;
    assert.equal(version.documentVersion, original.documentVersion + 1);
    assert.deepEqual(version.revisionOf, {
      documentId: original.documentId,
      documentVersion: 1,
    });
    assert.equal(version.title, original.title);
    assert.equal(version.documentKind, "literature_review");
    assert.equal(version.integrityPolicy, "research_grounded");
    assert.equal(version.origin.kind, "direct");
    // The same text: the draft is unchanged, prose and quote included.
    assert.equal(
      version.citationDraft?.markdown,
      original.citationDraft?.markdown,
    );
    assert.include(
      version.visibleMarkdown,
      "> Representations drift over days.",
    );
    assert.include(
      version.visibleMarkdown,
      "Outside papers were read to their abstracts.",
    );
    // The kept Zotero citation keeps its page locator and evidence.
    assert.deepEqual(version.citationBundle.clusters[0].sources, [
      {
        libraryID: 1,
        itemKey: "ZOTERO01",
        evidenceRefs: ["obs-1"],
        locator: LOCATOR,
      },
    ]);
    assert.include(
      version.visibleMarkdown,
      "[(Item 101, p. 4)](zotero://open-pdf/library/items/ATTACH01?page=4)",
    );
    // The found paper is its library item, cited once in its cluster.
    assert.deepEqual(
      version.citationBundle.clusters[1].sources.map((source) =>
        "itemKey" in source ? source.itemKey : source.paperId,
      ),
      ["EXIST001"],
    );
    assert.include(
      version.visibleMarkdown,
      "[(Item 501)](zotero://select/library/items/EXIST001)",
    );
    // Imported papers are their new items.
    assert.include(
      version.visibleMarkdown,
      "zotero://select/library/items/IMPORT9000",
    );
    assert.include(
      version.visibleMarkdown,
      "zotero://select/library/items/IMPORT9001",
    );
    // Unimported papers stay outside, with their snapshot, link and marker data.
    assert.deepEqual(
      version.citationBundle.outsidePapers?.map((paper) => [
        paper.paperId,
        paper.csl.id,
      ]),
      [
        [DELTA, "ext-1"],
        [EPSILON, "ext-2"],
      ],
    );
    assert.include(
      version.visibleMarkdown,
      "[(Delta lab page, 2021)](https://lab.example/delta)",
    );
    assert.include(
      version.visibleMarkdown,
      "[(Epsilon lost, 2021)](https://doi.org/10.1000/missing)",
    );
    // One References list, formatted again.
    const references = version.visibleMarkdown.split("## References")[1];
    assert.include(references, "zotero://select/library/items/EXIST001");
    assert.include(references, "zotero://select/library/items/IMPORT9000");
    assert.include(
      references,
      "[Delta lab page. (2021).](https://lab.example/delta)",
    );
    assert.notInclude(references, "Alpha drift. (2021).");
    assert.lengthOf(version.citationBundle.bibliographyEntries, 6);
    assert.deepEqual(
      version.citationBundle.bibliographyEntries
        .filter((entry) => "paperId" in entry)
        .map((entry) => (entry as { paperId: string }).paperId),
      [DELTA, EPSILON],
    );
    // A later import can still relink the papers left outside.
    assert.deepEqual(
      JSON.parse(JSON.stringify(version.citationDraft?.clusters[2].sources)),
      [{ libraryID: 1, itemKey: "IMPORT9000", evidenceRefs: [] }],
    );
    // Quotes, figures, grounding and coverage are carried over.
    assert.deepEqual(version.verifiedQuotes, [QUOTE]);
    assert.equal(version.validation.quoteVerified, "verified");
    assert.equal(version.validation.groundingReviewed, "passed");
    assert.deepEqual(version.assets, original.assets);
    assert.deepEqual(version.coverageItems, original.coverageItems);
    assert.equal(version.coverageStatus, "partial");
    // The stored document is unchanged.
    assert.deepEqual(await loadPlanDocument(original.documentId), original);
  });

  it("publishes the same version again on a retry of the call", async function () {
    const original = await publishReview();
    const context = makeContext();
    const first = await run(
      { kind: "document_citations", documentId: original.documentId },
      context,
    );
    const second = await run(
      { kind: "document_citations", documentId: original.documentId },
      context,
    );
    const ids = [first, second].map(
      (result) => (result.content as { documentId: string }).documentId,
    );
    assert.equal(ids[0], ids[1]);
    assert.deepEqual(
      (second.content as { papers: Array<{ outcome: string }> }).papers.map(
        (paper) => paper.outcome,
      ),
      [
        "found_existing",
        "found_existing",
        "found_existing",
        "not_importable",
        "failed",
      ],
      "the second call finds the first call's imports instead of importing again",
    );
  });

  it("publishes no version when no paper becomes a Zotero item", async function () {
    const original = await publishReview({
      papers: [PAPERS[3]],
      citations: [
        CITATIONS[0],
        {
          citationId: "C2",
          sources: [{ kind: "outside", paperId: DELTA, evidenceRefs: [] }],
        },
      ],
      markdown:
        "# Drift review\n\nTuning drifts [[cite:C1]] and [[cite:C2]].\n\n## Scope and limitations\n\nTwo papers.",
    });
    const result = await run(
      { kind: "document_citations", documentId: original.documentId },
      makeContext(),
    );
    assert.isTrue(result.ok, JSON.stringify(result.content));
    const content = result.content as Record<string, unknown>;
    assert.notProperty(content, "documentId");
    assert.include(String(content.note), "no new version was published");
    assert.isUndefined(result.materialRef);
    assert.deepEqual(library.importedIdentifiers, []);
  });

  it("reports the import when the new version cannot be published", async function () {
    const original = await publishReview();
    const tool = createImportDocumentCitationsTool(
      library.zoteroGateway as unknown as ZoteroGateway,
      {
        finalizer: {
          finalizeImportedCitations: async () => {
            throw new Error("Zotero item 501 is in the trash.");
          },
        } as unknown as DirectDocumentFinalizer,
      },
    );
    const input = tool.validate({ documentId: original.documentId });
    if (!input.ok) throw new Error(input.error);
    const result = (await tool.execute(input.value, makeContext())) as {
      content: Record<string, unknown>;
    };
    assert.deepEqual(library.importedIdentifiers, [
      "arxiv:2101.00001",
      "PMID:123456",
      "10.1000/missing",
    ]);
    assert.equal(result.content.importedCount, 2);
    assert.notProperty(result.content, "documentId");
    assert.include(String(result.content.note), "could not be published");
    assert.include(String(result.content.note), "is in the trash");
    assert.include(String(result.content.note), "marked imported");
    assert.notInclude(String(result.content.note), "Do not call this again");
    assert.include(String(result.content.note), "safe once the cause is fixed");
    // The retry imports nothing again, so it does not say it imported anything.
    const retried = (await tool.execute(input.value, makeContext())) as {
      content: Record<string, unknown>;
    };
    assert.equal(retried.content.importedCount, 0);
    assert.include(
      String(retried.content.note),
      "cited papers were already in the library",
    );
    assert.notInclude(String(retried.content.note), "marked imported");
  });

  it("carries the stored document's issues into the new version without repeating its repairs", async function () {
    // C9 is cited by no text; the first version dropped it.
    const original = await publishReview({
      citations: [
        ...CITATIONS,
        {
          citationId: "C9",
          sources: [{ kind: "outside", paperId: DELTA, evidenceRefs: [] }],
        },
      ],
    });
    const dropped = "dropped unused citation C9";
    assert.include(original.validation.issues, dropped);
    const result = await run(
      { kind: "document_citations", documentId: original.documentId },
      makeContext(),
    );
    assert.isTrue(result.ok, JSON.stringify(result.content));
    const version = (await loadPlanDocument(
      (result.content as { documentId: string }).documentId,
    )) as DocumentArtifactV2;
    assert.deepEqual(
      version.validation.issues.filter((issue) => issue === dropped),
      [dropped],
    );
  });

  it("is planned and described as library_import's identifier import", async function () {
    const original = await publishReview();
    const tool = registry.getTool("library_import")!;
    const input = tool.validate({
      kind: "document_citations",
      documentId: original.documentId,
    });
    if (!input.ok) throw new Error(input.error);
    const plan = await tool.planInvocation!(input.value, makeContext());
    assert.equal(plan.impact, "state_change");
    assert.include(plan.effects, "create");
    const actions = await tool.describeAction!(input.value, makeContext());
    assert.deepEqual(
      actions.map((action) => action.operation),
      ["import_identifiers"],
    );
  });

  it("runs over MCP for a Claude Code or Codex turn, publishing the version under the turn's run", async function () {
    const zotero = globalThis.Zotero as unknown as Record<string, unknown>;
    zotero.Server = { Endpoints: {} };
    const prefs = new Map<string, unknown>([["httpServer.port", 24680]]);
    zotero.Prefs = {
      get: (key: string) => prefs.get(key),
      set: (key: string, value: unknown) => void prefs.set(key, value),
    };
    // The one cited outside paper is already an item: no import runs.
    const original = await publishReview({
      papers: [PAPERS[0]],
      citations: [CITATIONS[0], CITATIONS[1]],
      markdown:
        "# Drift review\n\nTuning drifts [[cite:C1]] while readouts hold [[cite:C2]].\n\n## Scope and limitations\n\nTwo papers.",
    });
    registerMcpServer({ toolRegistry: registry, zoteroGateway: {} as never });
    const scope = registerScopedZoteroMcpScope({
      conversationKey: library.conversationKey,
      libraryID: 1,
      kind: "global",
      runtimeAuthority: "claude",
      runId: "claude-turn-run",
    });
    try {
      const Endpoint = (zotero.Server as { Endpoints: Record<string, any> })
        .Endpoints[ZOTERO_MCP_ENDPOINT_PATH];
      const reply = await new Endpoint().init({
        method: "POST",
        data: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "library_import",
            arguments: {
              kind: "document_citations",
              documentId: original.documentId,
            },
          },
        },
        headers: {
          Authorization: `Bearer ${getOrCreateZoteroMcpBearerToken()}`,
          [ZOTERO_MCP_SCOPE_HEADER]: scope.token,
        },
      });
      const payload = JSON.parse(reply[2]);
      assert.isUndefined(payload.result?.isError, reply[2]);
      const body = JSON.parse(payload.result.content[0].text);
      assert.isTrue(body.ok, reply[2]);
      assert.match(body.result.documentId, /^claude-turn-run:document:/);
      assert.equal(body.result.papers[0].outcome, "found_existing");
      const version = (await loadPlanDocument(
        body.result.documentId,
      )) as DocumentArtifactV2;
      assert.equal(version.documentVersion, 2);
      assert.notProperty(version.citationBundle, "outsidePapers");
      assert.deepEqual(library.importedIdentifiers, []);
    } finally {
      scope.clear();
      unregisterMcpServer();
    }
  });

  it("imports a paper the user chose to cite without importing, when asked later", async function () {
    const doi = "10.1000/candidate-9";
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        results: Array.from({ length: 12 }, (_, i) => ({
          id: `https://openalex.org/W${i + 1}`,
          display_name: `Candidate ${i + 1}`,
          doi: `https://doi.org/10.1000/candidate-${i + 1}`,
          publication_year: 2021,
        })),
      }),
    })) as typeof fetch;
    const context = makeContext(
      "Write a literature review on population coding.",
    );
    const search = await registry.prepareExecution(
      {
        id: "literature_search-1",
        name: "literature_search",
        arguments: {
          mode: "search",
          workflow: "review",
          query: "population coding",
          limit: 12,
          forLiteratureReview: true,
        },
      },
      context,
      { callerKind: "model" },
    );
    if (search.kind !== "result") throw new Error("No search");
    const found = search.execution.result.content as {
      candidateSetId: string;
      sessionId: string;
    };
    const reviewArgs = {
      sessionId: found.sessionId,
      revision: 0,
      count: 1,
      selections: [
        {
          candidateSetId: found.candidateSetId,
          candidateIndex: 9,
          reason: "Relevant population-coding evidence.",
        },
      ],
    };
    const reviewed = await registry.prepareExecution(
      {
        id: "literature_review-1",
        name: "literature_review",
        arguments: reviewArgs,
      },
      context,
      { callerKind: "model" },
    );
    if (reviewed.kind !== "result") throw new Error("No card");
    const review = registry.getTool("literature_review")!;
    const reviewInput = review.validate(reviewArgs);
    if (!reviewInput.ok) throw new Error(reviewInput.error);
    const card = (await review.createResultReviewAction!(
      reviewInput.value,
      reviewed.execution.result,
      context,
    )) as AgentPendingAction;
    const list = card.fields[0];
    if (list.type !== "paper_result_list") throw new Error("No paper card");
    await review.resolveResultReview!(
      reviewInput.value,
      reviewed.execution.result,
      {
        approved: true,
        actionId: "cite",
        data: { selectedPaperIds: [list.rows[0].id] },
      },
      context,
    );
    // The card's choice refuses a same-turn import by identifier.
    const direct = await prepare(
      { kind: "identifiers", identifiers: [doi] },
      context,
    );
    if (direct.kind !== "result") throw new Error("Expected a refusal");
    assert.isTrue(direct.execution.result.inputRejected);
    // A document of this run cites that paper without importing it, as the
    // user chose; the import tool does not override the choice.
    const cited = snapshot(paperSourceId(`doi:${doi}`), "Candidate 9", { doi });
    const publish = (documentId: string, runId?: string) =>
      publishReview({
        papers: [cited],
        documentId,
        runId,
        citations: [
          CITATIONS[0],
          {
            citationId: "C2",
            sources: [
              { kind: "outside", paperId: cited.paperId, evidenceRefs: [] },
            ],
          },
        ],
        markdown:
          "# Drift review\n\nTuning drifts [[cite:C1]] and [[cite:C2]].\n\n## Scope and limitations\n\nTwo papers.",
      });
    const thisRun = await publish(`${RUN_ID}:document:1`, RUN_ID);
    const refused = await run(
      { kind: "document_citations", documentId: thisRun.documentId },
      context,
    );
    assert.isTrue(refused.inputRejected);
    assert.include(
      String((refused.content as { error?: unknown }).error),
      "made in this run",
    );
    assert.deepEqual(library.importedIdentifiers, []);
    // A later turn's request imports a document of an earlier run when the
    // user asks.
    const original = await publish(`${EARLIER_RUN_ID}:document:1`);
    const imported = await run(
      { kind: "document_citations", documentId: original.documentId },
      makeContext(),
    );
    assert.isTrue(imported.ok, JSON.stringify(imported.content));
    assert.deepEqual(library.importedIdentifiers, [doi]);
    assert.equal(
      (imported.content as { papers: Array<{ outcome: string }> }).papers[0]
        .outcome,
      "imported",
    );
  });
});

describe("finding a cited outside paper in the library", function () {
  const originalZotero = globalThis.Zotero;
  afterEach(function () {
    globalThis.Zotero = originalZotero;
  });

  function gatewayOver(items: FakeItem[]): ZoteroGateway {
    return {
      getItem: (id: number) => items.find((item) => item.id === id) || null,
      searchItemsByConditions: async (params: {
        libraryID: number;
        conditions: Array<{ condition: string; value: string }>;
      }) => {
        const [{ condition, value }] = params.conditions;
        const found = items.filter((item) =>
          item.getField(condition).toLowerCase().includes(value.toLowerCase()),
        );
        return {
          items: found.map((item) => ({ itemId: item.id })),
          totalCount: found.length,
          returnedCount: found.length,
          offset: 0,
        };
      },
    } as unknown as ZoteroGateway;
  }

  it("matches by DOI first, then arXiv id, then PMID, in DOI, URL or Extra", async function () {
    const items = [
      fakeItem(1, "BYPMID01", { extra: "PMID: 42\nPMCID: PMC1" }),
      fakeItem(2, "BYARXIV1", { url: "http://arxiv.org/abs/2101.00001v2" }),
      fakeItem(3, "BYDOI001", { extra: "DOI: 10.1000/Upper" }),
      fakeItem(4, "ARXIVDOI", { DOI: "10.48550/arXiv.2202.00002" }),
    ];
    const gateway = gatewayOver(items);
    const find = (paper: Record<string, string>) =>
      findLibraryItemForPaper(gateway, 1, paper).then((item) => item?.itemKey);
    assert.equal(await find({ doi: "10.1000/upper", pmid: "42" }), "BYDOI001");
    assert.equal(await find({ arxivId: "2101.00001" }), "BYARXIV1");
    assert.equal(await find({ arxivId: "arXiv:2202.00002v1" }), "ARXIVDOI");
    assert.equal(await find({ pmid: "42" }), "BYPMID01");
    assert.isUndefined(await find({ pmid: "4" }));
    assert.isUndefined(await find({ url: "https://example.org" }));
  });

  it("skips trashed items, child items and other libraries", async function () {
    const gateway = gatewayOver([
      fakeItem(1, "TRASHED1", { DOI: "10.1000/a" }, { deleted: true }),
      fakeItem(2, "OTHERLIB", { DOI: "10.1000/a" }, { libraryID: 2 }),
      fakeItem(
        3,
        "ATTACHED",
        { DOI: "10.1000/a" },
        { isRegularItem: () => false },
      ),
    ]);
    assert.isNull(
      await findLibraryItemForPaper(gateway, 1, { doi: "10.1000/a" }),
    );
  });
});
