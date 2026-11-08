/**
 * A document that cites only Zotero items keeps the content hash it had
 * before outside papers existed: a retried submission of such a document
 * still finds the version already stored. The expected hash is the one the
 * finalizer produced at 432d24fc, before outside-paper citations.
 */
import { assert } from "chai";
import type { DocumentCitationEvidence } from "../src/agent/documents/citationService";
import { finalizeDocument } from "../src/agent/documents/finalizer";
import type { ZoteroGateway } from "../src/agent/services/zoteroGateway";

const EVIDENCE: DocumentCitationEvidence[] = [
  {
    version: 2,
    evidenceRef: "obs-1",
    observationId: "obs-1",
    libraryID: 1,
    itemKey: "ZOTERO01",
    sourceKind: "abstract",
  },
];

const GOLDEN_HASH =
  "sha256:d0d0196668f2324f0f14ccb8e12bb15c38d9080ff8680b5a64ca5436f97379cf";

describe("the content hash of a document without outside papers", function () {
  const originalZotero = globalThis.Zotero;
  beforeEach(function () {
    const item = {
      id: 101,
      libraryID: 1,
      key: "ZOTERO01",
      deleted: false,
      isRegularItem: () => true,
      isNote: () => false,
      getField: (field: string) => (field === "title" ? "Zotero paper" : ""),
    };
    (globalThis as { Zotero?: unknown }).Zotero = {
      ...(originalZotero as object),
      Libraries: { userLibraryID: 1, get: () => undefined },
      Items: {
        get: () => item,
        getByLibraryAndKey: () => item,
      },
    };
  });
  afterEach(function () {
    (globalThis as { Zotero?: unknown }).Zotero = originalZotero;
  });

  it("is the hash the finalizer gave before outside-paper citations", async function () {
    const gateway = {
      formatStructuredCitations: (params: {
        clusters: Array<{
          citationId: string;
          items: Array<{ itemId?: number }>;
        }>;
      }) => ({
        styleId: "http://www.zotero.org/styles/apa",
        styleTitle: "APA",
        locale: "en-US",
        clusters: params.clusters.map((cluster) => {
          const text = `(${cluster.items.map((item) => `Item ${item.itemId}`).join("; ")})`;
          return { citationId: cluster.citationId, text, html: text };
        }),
        bibliographyEntries: [
          { itemId: 101, text: "Item 101. (2024).", html: "Item." },
        ],
      }),
      getItem: () => ({ id: 101, libraryID: 1, key: "ZOTERO01" }),
      searchItemsByConditions: async () => ({ items: [] }),
    } as unknown as ZoteroGateway;
    const { document } = await finalizeDocument({
      gateway,
      input: {
        documentKind: "literature_review",
        integrityPolicy: "research_grounded",
        title: "Drift review",
        markdown:
          "# Drift review\n\nTuning drifts [[cite:C1]].\n\n## Scope and limitations\n\nOne paper.",
        citations: [
          {
            citationId: "C1",
            sources: [{ libraryID: 1, itemKey: "ZOTERO01", evidenceRefs: [] }],
          },
          {
            citationId: "C9",
            sources: [{ libraryID: 1, itemKey: "ZOTERO01", evidenceRefs: [] }],
          },
        ],
        quotes: [],
        assets: [],
        groundingReviewed: "passed_with_limitations",
        groundingIssues: ["One claim rests on an abstract."],
      },
      now: 1_000,
      context: {
        documentId: "run-1:document:1",
        documentVersion: 1,
        conversationKey: 7,
        integrityPolicy: "research_grounded",
        origin: {
          kind: "direct",
          runId: "run-1",
          sourceMessageTimestamp: 1_000,
        },
        spec: {
          kind: "literature_review",
          title: "Drift review",
          requiredSections: ["Scope and limitations"],
          requiresReferences: true,
          requiresCoverageSection: false,
          allowFigures: false,
          citationStyle: {
            styleId: "http://www.zotero.org/styles/apa",
            styleTitle: "APA",
            locale: "en-US",
          },
        },
        evidence: EVIDENCE,
        corpus: [{ libraryID: 1, itemKey: "ZOTERO01" }],
        quoteCorpusKeys: new Set(),
        coverageItems: [],
        coverageStatus: "partial",
        validateAssetProvenance: () => undefined,
      },
    });
    assert.include(document.validation.issues, "dropped unused citation C9");
    assert.notProperty(document, "citationDraft");
    assert.notProperty(document, "revisionOf");
    assert.equal(document.contentHash, GOLDEN_HASH);
  });
});
