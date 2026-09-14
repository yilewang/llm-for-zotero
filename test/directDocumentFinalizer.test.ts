import { assert } from "chai";
import { DirectDocumentFinalizer } from "../src/agent/documents/directFinalization";
import type {
  DocumentOutcomePolicy,
  PlanCitationCluster,
} from "../src/agent/documents/types";
import type { TrustedReadObservation } from "../src/agent/plans/types";
import type { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import type { AgentRuntimeRequest } from "../src/agent/types";
import { clearPageTextCache } from "../src/modules/contextPanel/livePdfSelectionLocator";
import { ToolInputRejection } from "../src/agent/tools/execution/failure";

const observation: TrustedReadObservation = {
  version: 1,
  observationId: "observation-1",
  issuer: "zotero_host",
  toolName: "paper_read",
  callDigest: "sha256:call",
  inputDigest: "sha256:input",
  resultDigest: "sha256:result",
  libraryID: 1,
  itemKey: "AAAA1111",
  capabilities: ["body"],
  certificateDigest: "sha256:certificate",
};

const groundedCitation: PlanCitationCluster = {
  citationId: "C1",
  sources: [
    {
      libraryID: 1,
      itemKey: "AAAA1111",
      evidenceRefs: [observation.observationId],
    },
  ],
};

function request(
  policy: DocumentOutcomePolicy,
  observations: readonly TrustedReadObservation[] = [],
): AgentRuntimeRequest {
  return {
    conversationKey: 42,
    mode: "agent",
    userText: "Write the requested document",
    documentOutcomePolicy: policy,
    documentReadObservations: observations,
    turnPaperScope: {} as AgentRuntimeRequest["turnPaperScope"],
    zoteroMetadataContext: {} as AgentRuntimeRequest["zoteroMetadataContext"],
    metadata: { sourceMessageTimestamp: 100 },
    skillRoutingReceipt: {
      routerSchemaVersion: 1,
      routerIdentityHash: "sha256:router",
      skillManifestHash: "sha256:manifest",
      skills: [
        {
          id: "literature-review",
          source: "automatic",
          requestedScope: "library-corpus",
          version: 1,
          instructionHash: "sha256:instruction",
        },
      ],
    },
  };
}

function input(params?: {
  markdown?: string;
  citations?: readonly PlanCitationCluster[];
}) {
  return {
    title: "Representational drift",
    markdown:
      params?.markdown ?? "# Representational drift\n\nA complete guide.",
    citations: params?.citations ?? [],
    quotes: [],
    assets: [],
    groundingReviewed: "passed" as const,
    groundingIssues: [],
  };
}

async function expectRejected(
  promise: Promise<unknown>,
  message: RegExp,
): Promise<void> {
  try {
    await promise;
    assert.fail("expected the document finalizer to reject");
  } catch (error) {
    assert.match(String(error), message);
    assert.instanceOf(
      error,
      ToolInputRejection,
      "a refused submission is a repair opportunity for the model, not a tool failure",
    );
  }
}

describe("DirectDocumentFinalizer", function () {
  let originalZotero: unknown;
  let originalZtoolkit: unknown;
  let finalizer: DirectDocumentFinalizer;
  const queries: Array<{ sql: string; params: unknown[] }> = [];

  before(function () {
    originalZotero = (globalThis as typeof globalThis & { Zotero?: unknown })
      .Zotero;
    originalZtoolkit = (globalThis as any).ztoolkit;
  });

  beforeEach(function () {
    queries.length = 0;
    (globalThis as any).ztoolkit = { log: () => undefined };
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      DB: {
        queryAsync: async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params: params || [] });
          return [];
        },
        executeTransaction: async (callback: () => Promise<unknown>) =>
          callback(),
      },
      Items: {
        getByLibraryAndKey: (libraryID: number, itemKey: string) =>
          libraryID === 1 && itemKey === "AAAA1111"
            ? {
                id: 101,
                isNote: () => false,
                getField: (field: string) =>
                  field === "title" ? "Verified paper" : "",
              }
            : false,
      },
      Libraries: {
        userLibraryID: 1,
        get: () => undefined,
      },
    } as unknown as typeof Zotero;
    const gateway = {
      formatStructuredCitations: (params: {
        clusters: Array<{ citationId: string }>;
        styleId?: string;
        locale?: string;
      }) => ({
        styleId: params.styleId || "apa",
        styleTitle: "APA",
        locale: params.locale || "en-US",
        clusters: params.clusters.map((cluster) => ({
          citationId: cluster.citationId,
          text: "(Author, 2024)",
          html: "(Author, 2024)",
        })),
        bibliographyEntries: [
          {
            itemId: 101,
            text: "Author. (2024). Verified paper.",
            html: "Author. (2024). Verified paper.",
          },
        ],
      }),
    } as unknown as ZoteroGateway;
    finalizer = new DirectDocumentFinalizer(gateway);
  });

  after(function () {
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
      originalZotero;
    (globalThis as any).ztoolkit = originalZtoolkit;
  });

  for (const { integrityPolicy, pageLocated } of (
    ["authored", "research_grounded"] as const
  ).flatMap((integrityPolicy) =>
    [true, false].map((pageLocated) => ({ integrityPolicy, pageLocated })),
  )) {
    it(`verifies direct ${integrityPolicy} quotes from ${pageLocated ? "page-located" : "whole-paper extracted"} text using the live PDF and persists their certificates`, async function () {
      clearPageTextCache();
      const quote = "Stable readout can coexist with representational drift.";
      const originalLookup = Zotero.Items.getByLibraryAndKey;
      (Zotero.Items as any).getByLibraryAndKey = (
        libraryID: number,
        key: string,
      ) =>
        key === "PDF11111" && libraryID === 1
          ? { id: 102, parentID: 101, isAttachment: () => true }
          : originalLookup(libraryID, key);
      (Zotero as any).Reader = {
        _readers: [
          {
            itemID: 102,
            _window: {
              PDFViewerApplication: {
                pdfDocument: {
                  numPages: 1,
                  fingerprints: ["direct-quote-fingerprint"],
                  getPage: async () => ({
                    getTextContent: async () => ({ items: [{ str: quote }] }),
                  }),
                },
              },
            },
          },
        ],
      };
      const observed = {
        ...observation,
        attachmentItemKey: "PDF11111",
        pageIndex: pageLocated ? 0 : undefined,
        sourceFingerprint: pageLocated
          ? "pdfjs:direct-quote-fingerprint"
          : undefined,
      };
      const policy: DocumentOutcomePolicy = {
        required: true,
        documentKind: "custom",
        integrityPolicy,
        trigger: "document_intent",
      };
      const draft = {
        ...input({
          markdown:
            "# Finding\n\n[[quote:Q1]]\n[[cite:C1]]\n\n## Scope and limitations\n\nOne paper, one page.",
          citations: [groundedCitation],
        }),
        quotes: [
          {
            quoteId: "Q1",
            text: quote,
            libraryID: 1,
            itemKey: "AAAA1111",
            attachmentItemKey: "PDF11111",
            evidenceRefs: [observed.observationId],
          },
        ],
      };
      const result = await finalizer.finalize({
        request: request(policy, [observed]),
        runId: `direct-quote-${integrityPolicy}`,
        input: draft,
      });
      assert.include(result.document.visibleMarkdown, `> ${quote}`);
      assert.notInclude(result.document.visibleMarkdown, "[[quote:");
      assert.equal(result.document.validation.quoteVerified, "verified");
      assert.lengthOf(result.document.verifiedQuotes, 1);
      assert.equal(result.document.verifiedQuotes[0].certificate.pageIndex, 0);
      assert.equal(
        result.document.verifiedQuotes[0].certificate.sourceFingerprint,
        "pdfjs:direct-quote-fingerprint",
      );
      assert.isTrue(
        queries.some(({ params }) =>
          params.some(
            (param) =>
              typeof param === "string" &&
              param.includes('"verifiedQuotes":[{"quoteId":"Q1"'),
          ),
        ),
        "the quote certificate is persisted, not only returned",
      );
      const duplicate = await finalizer.finalize({
        request: request(policy, [observed]),
        runId: `adjacent-manual-quote-${integrityPolicy}`,
        input: {
          ...draft,
          markdown: `# Finding\n\n> ${quote}\n\n(Fixture, 2024) [[quote:Q1]] [[cite:C1]]\n\n## Scope and limitations\n\nOne paper, one page.`,
        },
      });
      assert.equal(
        duplicate.document.visibleMarkdown.split(`> ${quote}`).length - 1,
        1,
        "a literal quote with its adjacent verified anchor is published once",
      );
      assert.notInclude(
        duplicate.document.visibleMarkdown,
        "(Fixture, 2024) >",
      );
      const inlineAnchor = await finalizer.finalize({
        request: request(policy, [observed]),
        runId: `inline-manual-quote-${integrityPolicy}`,
        input: {
          ...draft,
          markdown: `# Finding\n\n> ${quote} [[quote:Q1]]\n\n(Fixture, 2024)\n\n[[cite:C1]]\n\n## Scope and limitations\n\nOne paper, one page.`,
        },
      });
      assert.equal(
        inlineAnchor.document.visibleMarkdown.split(quote).length - 1,
        1,
        "a verified anchor inside its literal block must not expand a second copy",
      );
      const attributedInlineAnchor = await finalizer.finalize({
        request: request(policy, [observed]),
        runId: `attributed-inline-quote-${integrityPolicy}`,
        input: {
          ...draft,
          markdown: `# Finding\n\n> ${quote} [[quote:Q1]]\n>\n> (Fixture, 2024)\n\n[[cite:C1]]\n\n## Scope and limitations\n\nOne paper, one page.`,
        },
      });
      assert.equal(
        attributedInlineAnchor.document.visibleMarkdown.split(quote).length - 1,
        1,
        "a trailing attribution inside the same block is not a second quotation",
      );
      for (const [name, markdown, expectedCount] of [
        [
          "separate occurrence",
          `> ${quote}\n\nA separate discussion follows.\n\n[[quote:Q1]] [[cite:C1]]`,
          2,
        ],
        [
          "unrelated manual quote",
          "> An interpretation not stated by the paper.\n\n[[quote:Q1]] [[cite:C1]]",
          1,
        ],
      ] as const) {
        const separate = await finalizer.finalize({
          request: request(policy, [observed]),
          runId: `preserve-${name}-${integrityPolicy}`,
          input: {
            ...draft,
            markdown: `# Finding\n\n${markdown}\n\n## Scope and limitations\n\nOne paper, one page.`,
          },
        });
        assert.equal(
          separate.document.visibleMarkdown.split(`> ${quote}`).length - 1,
          expectedCount,
          name,
        );
        if (name === "unrelated manual quote")
          assert.include(
            separate.document.visibleMarkdown,
            "> An interpretation not stated by the paper.",
          );
      }
      const countWrites = () =>
        queries.filter(({ sql }) => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql))
          .length;
      const savedCount = countWrites();
      await expectRejected(
        finalizer.finalize({
          request: request(policy, [observed]),
          runId: "fabricated-quote",
          input: {
            ...draft,
            quotes: [
              {
                ...draft.quotes[0],
                text: "The study proves causation in every biological brain.",
              },
            ],
          },
        }),
        /failed strict PDF.js verification/,
      );
      await expectRejected(
        finalizer.finalize({
          request: request(policy, [{ ...observed, pageIndex: 1 }]),
          runId: "wrong-page-quote",
          input: draft,
          // An otherwise valid quotation cannot borrow evidence from another page.
        }),
        /not backed by trusted evidence on its verified PDF page/,
      );
      assert.equal(
        countWrites(),
        savedCount,
        "rejected quotes are not published",
      );
      clearPageTextCache();
    });
  }

  it("rejects literature reviews without verified research evidence", async function () {
    const policy: DocumentOutcomePolicy = {
      required: true,
      documentKind: "literature_review",
      integrityPolicy: "research_grounded",
      trigger: "document_intent",
    };
    await expectRejected(
      finalizer.finalize({
        request: request(policy),
        runId: "run-no-evidence",
        input: input(),
      }),
      /host-verified abstract or body evidence/,
    );
  });

  it("rejects missing coverage disclosure and missing references", async function () {
    const policy: DocumentOutcomePolicy = {
      required: true,
      documentKind: "literature_review",
      integrityPolicy: "research_grounded",
      trigger: "literature_review_skill",
    };
    await expectRejected(
      finalizer.finalize({
        request: request(policy, [observation]),
        runId: "run-no-references",
        input: input(),
      }),
      /requires grounded citations/,
    );
    await expectRejected(
      finalizer.finalize({
        request: request(policy, [observation]),
        runId: "run-no-coverage",
        input: input({ citations: [groundedCitation] }),
      }),
      /missing required sections: scope and limitations/,
    );
  });

  it("rejects fabricated citation evidence references", async function () {
    const policy: DocumentOutcomePolicy = {
      required: true,
      documentKind: "literature_review",
      integrityPolicy: "research_grounded",
      trigger: "document_intent",
    };
    const fabricated: PlanCitationCluster = {
      citationId: "C1",
      sources: [
        {
          libraryID: 1,
          itemKey: "AAAA1111",
          evidenceRefs: ["made-up-evidence"],
        },
      ],
    };
    await expectRejected(
      finalizer.finalize({
        request: request(policy, [observation]),
        runId: "run-fabricated",
        input: input({
          markdown:
            "# Review\n\nEvidence [[cite:C1]].\n\n## Scope and limitations\n\nOne verified paper was reviewed.",
          citations: [fabricated],
        }),
      }),
      /invalid evidence reference/,
    );
  });

  it("rejects document assets that were not emitted by a host tool", async function () {
    const policy: DocumentOutcomePolicy = {
      required: true,
      documentKind: "guide",
      integrityPolicy: "authored",
      trigger: "document_intent",
    };
    await expectRejected(
      finalizer.finalize({
        request: request(policy),
        runId: "run-invented-asset",
        input: {
          ...input(),
          assets: [
            {
              assetId: "invented",
              contentHash: `sha256:${"a".repeat(64)}`,
              mimeType: "image/png",
              byteLength: 10,
              width: 10,
              height: 10,
              caption: "Invented path",
              durablePath: "/tmp/invented.png",
              provenance: {
                origin: "generated",
                generator: "model",
                generatorVersion: "1",
                evidenceRefs: [],
              },
            },
          ],
        },
      }),
      /not emitted by a successful host tool call/,
    );
  });

  it("does not silently publish a broken relative figure after the asset submission fails", async function () {
    await expectRejected(
      finalizer.finalize({
        request: request({
          required: true,
          documentKind: "report",
          integrityPolicy: "authored",
          trigger: "document_intent",
        }),
        runId: "run-missing-figure",
        input: input({
          markdown:
            "# Summary\n\n![Actual cropped figure](assets/figure-1-p3.png)\n\nFigure 1, PDF page 3.",
        }),
      }),
      /figures.*assets|assets.*figures/i,
    );
    assert.isFalse(queries.some(({ sql }) => /INSERT INTO/.test(sql)));
  });

  it("persists a validated research-grounded document with generated references", async function () {
    const policy: DocumentOutcomePolicy = {
      required: true,
      documentKind: "literature_review",
      integrityPolicy: "research_grounded",
      trigger: "literature_review_skill",
    };
    const result = await finalizer.finalize({
      request: request(policy, [observation]),
      runId: "run-grounded",
      input: input({
        markdown:
          "# Review\n\nEvidence [[cite:C1]].\n\n## Scope and limitations\n\nOne verified paper was reviewed.",
        citations: [groundedCitation],
      }),
      now: 200,
    });

    assert.equal(result.document.version, 2);
    assert.deepInclude(result.document.origin, {
      kind: "direct",
      runId: "run-grounded",
      sourceMessageTimestamp: 100,
    });
    assert.deepInclude(
      result.document.version === 2 && result.document.origin.kind === "direct"
        ? result.document.origin.routingReceipt
        : {},
      { routerIdentityHash: "sha256:router" },
    );
    assert.include(result.document.visibleMarkdown, "## References");
    assert.lengthOf(result.document.coverageItems, 1);
    assert.isTrue(
      queries.some((entry) =>
        entry.sql.includes("INSERT INTO llm_for_zotero_plan_documents"),
      ),
    );
  });

  it("waits for native citation styles before publishing a cited document", async function () {
    let ready = false;
    let initializationCalls = 0;
    (Zotero as any).Styles = {
      init: async () => {
        initializationCalls++;
        await Promise.resolve();
        ready = true;
      },
    };
    const gateway = (finalizer as any).gateway;
    const format = gateway.formatStructuredCitations.bind(gateway);
    gateway.formatStructuredCitations = (params: unknown) => {
      if (!ready) throw new Error("Styles not yet loaded");
      return format(params);
    };
    const result = await finalizer.finalize({
      request: request(
        {
          required: true,
          documentKind: "guide",
          integrityPolicy: "authored",
          trigger: "document_intent",
        },
        [observation],
      ),
      runId: "run-styles-readiness",
      input: input({
        markdown: "# Guide\n\nContext [[cite:C1]].",
        citations: [groundedCitation],
      }),
      now: 302,
    });
    assert.equal(initializationCalls, 1);
    assert.include(result.document.visibleMarkdown, "## References");
  });

  it("accepts authored documents with or without optional citations", async function () {
    const policy: DocumentOutcomePolicy = {
      required: true,
      documentKind: "guide",
      integrityPolicy: "authored",
      trigger: "document_intent",
    };
    const uncited = await finalizer.finalize({
      request: request(policy),
      runId: "run-authored-plain",
      input: input(),
      now: 300,
    });
    assert.equal(uncited.document.validation.groundingReviewed, "not_run");

    const cited = await finalizer.finalize({
      request: request(policy),
      runId: "run-authored-cited",
      input: input({
        markdown: "# Guide\n\nOptional context [[cite:C1]].",
        citations: [
          {
            citationId: "C1",
            sources: [{ libraryID: 1, itemKey: "AAAA1111", evidenceRefs: [] }],
          },
        ],
      }),
      now: 301,
    });
    assert.include(cited.document.visibleMarkdown, "## References");
  });
  it("rejects citation expansion past the final byte limit before persisting a document", async function () {
    const max = 2 * 1024 * 1024;
    const prefix = "# Guide\n\nContext [[cite:C1]].\n\n";
    const markdown = prefix + "x".repeat(max - prefix.length - 10);
    await expectRejected(
      finalizer.finalize({
        request: request({
          required: true,
          documentKind: "guide",
          integrityPolicy: "authored",
          trigger: "document_intent",
        }),
        runId: "run-formatted-limit",
        input: input({
          markdown,
          citations: [
            {
              citationId: "C1",
              sources: [
                { libraryID: 1, itemKey: "AAAA1111", evidenceRefs: [] },
              ],
            },
          ],
        }),
        now: 100,
      }),
      /Finalized document exceeds the 2 MiB limit/,
    );
    assert.isFalse(
      queries.some((entry) =>
        entry.sql.includes("INSERT INTO llm_for_zotero_plan_documents"),
      ),
    );
  });
});
