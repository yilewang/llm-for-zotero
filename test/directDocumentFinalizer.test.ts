import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import { DirectDocumentFinalizer } from "../src/agent/documents/directFinalization";
import {
  initPlanDocumentStore,
  loadPlanDocument,
} from "../src/agent/documents/store";
import type {
  DocumentOutcomePolicy,
  PlanCitationCluster,
} from "../src/agent/documents/types";
import type { TrustedReadObservation } from "../src/agent/context/readObservationTypes";
import type { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import type { AgentRuntimeRequest } from "../src/agent/types";
import { clearPageTextCache } from "../src/services/pdf/livePdfSelectionLocator";
import { composePdfReaderText } from "./helpers/hostSurfaces";
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
  observations: readonly TrustedReadObservation[] = [],
): AgentRuntimeRequest {
  return {
    conversationKey: 42,
    mode: "agent",
    userText: "Write the requested document",
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
  let restorePdfReaderTextBridge: (() => void) | null = null;
  const queries: Array<{ sql: string; params: unknown[] }> = [];

  before(function () {
    originalZotero = (globalThis as typeof globalThis & { Zotero?: unknown })
      .Zotero;
    originalZtoolkit = (globalThis as any).ztoolkit;
    // Quote verification reaches the live PDF through a host surface bridge.
    // This suite stands in for the plugin surface, so it composes the same
    // reader adapter the panel composes at startup.
    restorePdfReaderTextBridge = composePdfReaderText();
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
    restorePdfReaderTextBridge?.();
    restorePdfReaderTextBridge = null;
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
        documentKind: "custom",
        integrityPolicy,
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
        request: request([observed]),
        runId: `direct-quote-${integrityPolicy}`,
        input: {
          ...draft,
          ...policy,
        },
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
        request: request([observed]),
        runId: `adjacent-manual-quote-${integrityPolicy}`,
        input: {
          ...draft,
          markdown: `# Finding\n\n> ${quote}\n\n(Fixture, 2024) [[quote:Q1]] [[cite:C1]]\n\n## Scope and limitations\n\nOne paper, one page.`,
          ...policy,
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
        request: request([observed]),
        runId: `inline-manual-quote-${integrityPolicy}`,
        input: {
          ...draft,
          markdown: `# Finding\n\n> ${quote} [[quote:Q1]]\n\n(Fixture, 2024)\n\n[[cite:C1]]\n\n## Scope and limitations\n\nOne paper, one page.`,
          ...policy,
        },
      });
      assert.equal(
        inlineAnchor.document.visibleMarkdown.split(quote).length - 1,
        1,
        "a verified anchor inside its literal block must not expand a second copy",
      );
      const attributedInlineAnchor = await finalizer.finalize({
        request: request([observed]),
        runId: `attributed-inline-quote-${integrityPolicy}`,
        input: {
          ...draft,
          markdown: `# Finding\n\n> ${quote} [[quote:Q1]]\n>\n> (Fixture, 2024)\n\n[[cite:C1]]\n\n## Scope and limitations\n\nOne paper, one page.`,
          ...policy,
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
          request: request([observed]),
          runId: `preserve-${name}-${integrityPolicy}`,
          input: {
            ...draft,
            markdown: `# Finding\n\n${markdown}\n\n## Scope and limitations\n\nOne paper, one page.`,
            ...policy,
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
          request: request([observed]),
          runId: "fabricated-quote",
          input: {
            ...draft,
            quotes: [
              {
                ...draft.quotes[0],
                text: "The study proves causation in every biological brain.",
              },
            ],
            ...policy,
          },
        }),
        /failed strict PDF.js verification/,
      );
      await expectRejected(
        finalizer.finalize({
          request: request([{ ...observed, pageIndex: 1 }]),
          runId: "wrong-page-quote",
          input: {
            ...draft,
            ...policy,
          },
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

  describe("repairs instead of rejecting", function () {
    const observed = {
      ...observation,
      attachmentItemKey: "PDF11111",
      pageIndex: 0,
      sourceFingerprint: "pdfjs:unopened",
    };
    const quote = (quoteId: string, text: string) => ({
      quoteId,
      text,
      libraryID: 1,
      itemKey: "AAAA1111",
      attachmentItemKey: "PDF11111",
      evidenceRefs: [observed.observationId],
    });
    const custom: DocumentOutcomePolicy = {
      documentKind: "custom",
      integrityPolicy: "research_grounded",
    };

    beforeEach(function () {
      const originalLookup = Zotero.Items.getByLibraryAndKey;
      (Zotero.Items as any).getByLibraryAndKey = (
        libraryID: number,
        key: string,
      ) =>
        key === "PDF11111" && libraryID === 1
          ? { id: 102, parentID: 101, isAttachment: () => true }
          : originalLookup(libraryID, key);
      (Zotero as any).Reader = { _readers: [] };
    });

    it("drops a declared quote no token uses and reports the repair", async function () {
      const result = await finalizer.finalize({
        request: request([observation]),
        runId: "unused-quote",
        input: {
          ...input({
            markdown:
              "# Finding\n\nA claim. [[cite:C1]]\n\n## Scope and limitations\n\nOne paper.",
            citations: [groundedCitation],
          }),
          quotes: [
            {
              quoteId: "Q1",
              text: "Never used.",
              libraryID: 1,
              itemKey: "AAAA1111",
              attachmentItemKey: "PDF11111",
              evidenceRefs: [observation.observationId],
            },
          ],
          ...custom,
        },
      });
      assert.deepEqual(result.repairs, ["dropped unused quote Q1"]);
      assert.notInclude(result.document.visibleMarkdown, "Never used.");
      assert.include(
        result.document.validation.issues,
        "dropped unused quote Q1",
      );
    });

    it("downgrades a quote whose PDF is not open to cited prose instead of rejecting", async function () {
      const result = await finalizer.finalize({
        request: request([observed]),
        runId: "unopened-quotes",
        input: {
          ...input({
            markdown:
              "# Finding\n\n[[quote:Q1]]\n\n[[quote:Q2]]\n[[cite:C1]]\n\n## Scope and limitations\n\nOne paper.",
            citations: [groundedCitation],
          }),
          quotes: [quote("Q1", "First sentence."), quote("Q2", "Second one.")],
          ...custom,
        },
      });
      assert.include(result.document.visibleMarkdown, "First sentence. [");
      assert.notInclude(result.document.visibleMarkdown, "> First sentence.");
      assert.notInclude(result.document.visibleMarkdown, "[[quote:");
      assert.notInclude(result.document.visibleMarkdown, "[[cite:");
      assert.deepEqual(result.document.verifiedQuotes, []);
      assert.equal(result.document.validation.quoteVerified, "not_applicable");
      const repairs = [
        "quote Q1 could not be verified (PDF not open); kept as cited text",
        "quote Q2 could not be verified (PDF not open); kept as cited text",
      ];
      assert.deepEqual(result.repairs, repairs);
      assert.includeMembers(result.document.validation.issues, repairs);
      assert.deepEqual(
        result.document.version === 2
          ? result.document.citationBundle.clusters.map(
              (cluster) => cluster.citationId,
            )
          : [],
        ["C1"],
        "the paper's existing citation is reused, no cite-Q1 is created",
      );
    });

    it("cites a downgraded quote through a new citation when its source has none", async function () {
      const result = await finalizer.finalize({
        request: request([observed]),
        runId: "unopened-uncited-quote",
        input: {
          ...input({
            markdown:
              "# Finding\n\n[[quote:Q1]]\n\n## Scope and limitations\n\nOne paper.",
            citations: [],
          }),
          quotes: [quote("Q1", "First sentence.")],
          documentKind: "custom",
          integrityPolicy: "authored",
        },
      });
      assert.include(result.document.visibleMarkdown, "First sentence. [");
      assert.notInclude(result.document.visibleMarkdown, "[[cite:");
      assert.deepEqual(
        result.document.version === 2
          ? result.document.citationBundle.clusters.map(
              (cluster) => cluster.citationId,
            )
          : [],
        ["cite-Q1"],
      );
      assert.deepEqual(result.repairs, [
        "quote Q1 could not be verified (PDF not open); kept as cited text",
      ]);
    });

    it("drops an unused citation cluster and reports the repair", async function () {
      const result = await finalizer.finalize({
        request: request([observation]),
        runId: "unused-citation",
        input: {
          ...input({
            markdown:
              "# Finding\n\nA claim. [[cite:C1]]\n\n## Scope and limitations\n\nOne paper.",
            citations: [
              groundedCitation,
              { ...groundedCitation, citationId: "C3" },
            ],
          }),
          ...custom,
        },
      });
      assert.deepEqual(result.repairs, ["dropped unused citation C3"]);
      assert.deepEqual(
        result.document.version === 2
          ? result.document.citationBundle.clusters.map(
              (cluster) => cluster.citationId,
            )
          : [],
        ["C1"],
      );
      assert.include(
        result.document.validation.issues,
        "dropped unused citation C3",
      );
    });

    const downgrade = (runId: string, markdown: string) =>
      finalizer.finalize({
        request: request([observed]),
        runId,
        input: {
          ...input({
            markdown: `# Finding\n\n${markdown}\n\n## Scope and limitations\n\nOne paper.`,
            citations: [groundedCitation],
          }),
          quotes: [quote("Q1", "First sentence.")],
          ...custom,
        },
      });
    const occurrences = (text: string, part: string) =>
      text.split(part).length - 1;

    it("downgrades a quote whose PDF attachment does not resolve", async function () {
      const originalLookup = Zotero.Items.getByLibraryAndKey;
      (Zotero.Items as any).getByLibraryAndKey = (
        libraryID: number,
        key: string,
      ) => (key === "PDF11111" ? false : originalLookup(libraryID, key));
      const result = await downgrade(
        "missing-attachment",
        "[[quote:Q1]] [[cite:C1]]",
      );
      assert.deepEqual(result.repairs, [
        "quote Q1 could not be verified (PDF attachment not found); kept as cited text",
      ]);
      assert.include(result.document.visibleMarkdown, "First sentence. [");
    });

    it("replaces a literal blockquote anchored by an unverifiable inline quote token with cited prose once", async function () {
      const result = await downgrade(
        "downgraded-inline-anchor",
        "> First sentence. [[quote:Q1]]\n\n(Fixture, 2024)\n\n[[cite:C1]]",
      );
      const visible = result.document.visibleMarkdown;
      assert.notInclude(visible, "> First sentence.");
      assert.equal(occurrences(visible, "First sentence."), 1);
      assert.include(visible, "First sentence. [");
    });

    it("replaces a literal blockquote followed by an unverifiable quote anchor with cited prose once", async function () {
      const result = await downgrade(
        "downgraded-adjacent-anchor",
        "> First sentence.\n\n[[quote:Q1]] [[cite:C1]]",
      );
      const visible = result.document.visibleMarkdown;
      assert.notInclude(visible, "> First sentence.");
      assert.equal(occurrences(visible, "First sentence."), 1);
      assert.equal(
        occurrences(visible, "(Author, 2024)"),
        1,
        "the anchor's own citation is not doubled",
      );
    });

    it("does not leave a downgraded quote token alone in a blockquote", async function () {
      const result = await downgrade(
        "downgraded-bare-blockquote",
        "> [[quote:Q1]] [[cite:C1]]",
      );
      const visible = result.document.visibleMarkdown;
      assert.notInclude(visible, "> First sentence.");
      assert.include(visible, "First sentence. [");
      assert.equal(occurrences(visible, "(Author, 2024)"), 1);
    });

    it("removes quotation marks around a downgraded quote token", async function () {
      for (const [open, close] of [
        ['"', '"'],
        ["“", "”"],
      ]) {
        const result = await downgrade(
          `downgraded-quoted-${open}`,
          `The authors state ${open}[[quote:Q1]]${close}.`,
        );
        const visible = result.document.visibleMarkdown;
        assert.include(visible, "The authors state First sentence. [");
        assert.notInclude(visible, `${open}First sentence`);
        assert.notInclude(visible, `2024)${close}`);
        assert.notInclude(visible, `)${close}`);
      }
    });

    const clusterIds = (result: { document: { version?: number } }) =>
      (result.document as any).citationBundle.clusters.map(
        (cluster: { citationId: string }) => cluster.citationId,
      );

    it("removes enclosing marks when the sentence punctuation sits inside them", async function () {
      const result = await downgrade(
        "downgraded-punctuation-inside",
        'They note "[[quote:Q1]]."',
      );
      const visible = result.document.visibleMarkdown;
      assert.include(visible, "They note First sentence. [");
      assert.notInclude(visible, '"First sentence');
      assert.notInclude(visible, '."');
      assert.deepEqual(clusterIds(result), ["C1"]);
    });

    it("treats a citation after the closing mark as the downgraded quote's citation", async function () {
      const result = await downgrade(
        "downgraded-cite-after-close",
        "They note \u201c[[quote:Q1]].\u201d [[cite:C1]]",
      );
      const visible = result.document.visibleMarkdown;
      assert.include(visible, "They note First sentence. [");
      assert.notInclude(visible, "\u201c");
      assert.notInclude(visible, "\u201d");
      assert.equal(occurrences(visible, "(Author, 2024)"), 1);
      assert.deepEqual(clusterIds(result), ["C1"]);
    });

    it("removes single quotation marks around a downgraded quote token", async function () {
      for (const [open, close] of [
        ["'", "'"],
        ["\u2018", "\u2019"],
      ]) {
        const result = await downgrade(
          `downgraded-single-${open}`,
          `They note ${open}[[quote:Q1]]${close}.`,
        );
        const visible = result.document.visibleMarkdown;
        assert.include(visible, "They note First sentence. [");
        assert.notInclude(visible, `${open}First sentence`);
        assert.notInclude(visible, `)${close}`);
      }
    });

    for (const [name, markdown] of [
      ["with model wording", "> Model wording. [[quote:Q1]]"],
      ["with an attribution", "> [[quote:Q1]] (Author, 2024)"],
    ] as const) {
      it(`takes a downgraded quote out of a blockquote ${name}`, async function () {
        const result = await downgrade(
          `downgraded-blockquote-${name}`,
          markdown,
        );
        const visible = result.document.visibleMarkdown;
        assert.notMatch(visible, /^\s*>/m);
        assert.include(visible, "First sentence. [");
      });
    }

    it("rejects a downgraded quote token next to an unpaired quotation mark", async function () {
      await expectRejected(
        downgrade(
          "downgraded-unpaired-mark",
          'They note "[[quote:Q1]] [[cite:C1]]" here.',
        ),
        /Quote Q1 could not be verified and sits next to a quotation mark/,
      );
    });

    it("rejects a downgraded quote token in a blockquote nested in a list", async function () {
      await expectRejected(
        downgrade(
          "downgraded-list-blockquote",
          "- > Model wording [[quote:Q1]]",
        ),
        /Quote Q1 could not be verified and sits inside a blockquote/,
      );
    });

    for (const [name, markdown] of [
      [
        "a quoted literal in prose",
        'The authors state "First sentence." [[quote:Q1]] [[cite:C1]]',
      ],
      [
        "a curly-quoted literal in prose",
        "The authors state “First sentence.” [[quote:Q1]] [[cite:C1]]",
      ],
      [
        "a quoted literal in a blockquote",
        '> "First sentence." [[quote:Q1]]\n\n[[cite:C1]]',
      ],
      [
        "a literal paragraph followed by its token",
        "First sentence.\n\n[[quote:Q1]] [[cite:C1]]",
      ],
      [
        "a corner-bracketed literal paragraph with its token",
        "「First sentence.」 [[quote:Q1]] [[cite:C1]]",
      ],
    ] as const) {
      it(`shows the downgraded wording once for ${name}`, async function () {
        const result = await downgrade(`downgraded-literal-${name}`, markdown);
        const visible = result.document.visibleMarkdown;
        assert.equal(occurrences(visible, "First sentence."), 1, visible);
        assert.notMatch(visible, /["“”「」]First sentence/);
        assert.notMatch(visible, /^\s*>/m);
        // A citation the draft put in its own paragraph stays there.
        assert.match(visible, /First sentence\.\s*\[/);
        assert.equal(occurrences(visible, "(Author, 2024)"), 1);
        assert.deepEqual(clusterIds(result), ["C1"]);
      });
    }

    for (const [name, markdown] of [
      ["corner brackets", "作者指出「[[quote:Q1]]」[[cite:C1]]"],
      ["white corner brackets", "作者指出『[[quote:Q1]]』[[cite:C1]]"],
      ["guillemets with spaces", "They note « [[quote:Q1]] » [[cite:C1]]"],
      ["spaced curly quotes", "They note “ [[quote:Q1]] ” [[cite:C1]]"],
    ] as const) {
      it(`removes ${name} around a downgraded quote token`, async function () {
        const result = await downgrade(`downgraded-marks-${name}`, markdown);
        const visible = result.document.visibleMarkdown;
        assert.include(visible, "First sentence.");
        assert.notMatch(visible, /[「」『』«»“”]/);
        assert.equal(occurrences(visible, "(Author, 2024)"), 1);
      });
    }

    it("keeps prose spacing around a downgraded token with no marks", async function () {
      const result = await downgrade(
        "downgraded-plain-spacing",
        "They note [[quote:Q1]] and “more” here [[cite:C1]].",
      );
      assert.include(
        result.document.visibleMarkdown,
        "They note First sentence. [",
      );
      assert.include(result.document.visibleMarkdown, "and “more” here");
    });

    it("rejects a downgraded quote token inside an HTML blockquote", async function () {
      await expectRejected(
        downgrade(
          "downgraded-html-blockquote",
          "<blockquote>[[quote:Q1]]</blockquote> [[cite:C1]]",
        ),
        /Quote Q1 could not be verified and sits inside a blockquote/,
      );
    });

    it("rejects a malformed citation token instead of dropping its clusters", async function () {
      await expectRejected(
        finalizer.finalize({
          request: request([observation]),
          runId: "malformed-citation",
          input: {
            ...input({
              markdown:
                "# Finding\n\nA claim. [[cite:C1]] and [[cite:C1,,C3]]\n\n## Scope and limitations\n\nOne paper.",
              citations: [
                groundedCitation,
                { ...groundedCitation, citationId: "C3" },
              ],
            }),
            ...custom,
          },
        }),
        /malformed citation token \[\[cite:C1,,C3\]\]/,
      );
    });

    it("splits a comma-joined citation token whose ids all resolve and reports the repair", async function () {
      const result = await finalizer.finalize({
        request: request([observation]),
        runId: "comma-joined-citation",
        input: {
          ...input({
            markdown:
              "# Finding\n\nA claim [[cite:C1, C2,C3]].\n\n## Scope and limitations\n\nOne paper.",
            citations: [
              groundedCitation,
              { ...groundedCitation, citationId: "C2" },
              { ...groundedCitation, citationId: "C3" },
            ],
          }),
          ...custom,
        },
      });
      const visible = result.document.visibleMarkdown;
      assert.notInclude(visible, "[[cite:");
      assert.equal(
        occurrences(
          visible,
          "[(Author, 2024)](zotero://select/library/items/AAAA1111)",
        ),
        3,
        "each of the three citations renders as its own linked label",
      );
      assert.include(
        visible,
        "A claim [(Author, 2024)](zotero://select/library/items/AAAA1111) [(Author, 2024)]",
        "adjacent citations keep the separator consecutive tokens get",
      );
      assert.deepEqual(clusterIds(result), ["C1", "C2", "C3"]);
      assert.deepEqual(result.repairs, [
        "split comma-joined citation token [[cite:C1, C2,C3]]",
      ]);
    });

    it("still rejects a comma-joined citation token with an unknown id, naming it", async function () {
      await expectRejected(
        finalizer.finalize({
          request: request([observation]),
          runId: "comma-joined-unknown",
          input: {
            ...input({
              markdown:
                "# Finding\n\nA claim [[cite:C1,C9,C3]].\n\n## Scope and limitations\n\nOne paper.",
              citations: [
                groundedCitation,
                { ...groundedCitation, citationId: "C3" },
              ],
            }),
            ...custom,
          },
        }),
        /unresolved citation token C9/,
      );
    });

    it("still rejects citations supplied with no citation tokens", async function () {
      await expectRejected(
        finalizer.finalize({
          request: request([observation]),
          runId: "no-citation-tokens",
          input: {
            ...input({
              markdown:
                "# Finding\n\nA claim.\n\n## Scope and limitations\n\nOne paper.",
              citations: [groundedCitation],
            }),
            ...custom,
          },
        }),
        /Citation mappings were supplied but the document has no citation tokens/,
      );
    });
    it("still rejects an unresolved quote token and fabricated quote evidence", async function () {
      await expectRejected(
        finalizer.finalize({
          request: request([observed]),
          runId: "unresolved-quote",
          input: {
            ...input({
              markdown:
                "# Finding\n\n[[quote:Q9]]\n[[cite:C1]]\n\n## Scope and limitations\n\nOne paper.",
              citations: [groundedCitation],
            }),
            ...custom,
          },
        }),
        /unresolved quote token Q9/,
      );
      await expectRejected(
        finalizer.finalize({
          request: request([observed]),
          runId: "fabricated-quote-evidence",
          input: {
            ...input({
              markdown:
                "# Finding\n\n[[quote:Q1]]\n[[cite:C1]]\n\n## Scope and limitations\n\nOne paper.",
              citations: [groundedCitation],
            }),
            quotes: [
              { ...quote("Q1", "First sentence."), evidenceRefs: ["made-up"] },
            ],
            ...custom,
          },
        }),
        /Quote Q1 has an invalid evidence reference/,
      );
    });
  });
  it("rejects literature reviews without verified research evidence", async function () {
    const policy: DocumentOutcomePolicy = {
      documentKind: "literature_review",
      integrityPolicy: "research_grounded",
    };
    await expectRejected(
      finalizer.finalize({
        request: request(),
        runId: "run-no-evidence",
        input: {
          ...input(),
          ...policy,
        },
      }),
      /host-verified abstract or body evidence/,
    );
  });

  it("still rejects a literature review without citations", async function () {
    const policy: DocumentOutcomePolicy = {
      documentKind: "literature_review",
      integrityPolicy: "research_grounded",
    };
    await expectRejected(
      finalizer.finalize({
        request: request([observation]),
        runId: "run-no-references",
        input: {
          ...input(),
          ...policy,
        },
      }),
      /requires grounded citations/,
    );
  });

  it("appends a missing required section with a placeholder and reports it", async function () {
    const policy: DocumentOutcomePolicy = {
      documentKind: "literature_review",
      integrityPolicy: "research_grounded",
    };
    const result = await finalizer.finalize({
      request: request([observation]),
      runId: "run-no-coverage",
      input: {
        ...input({
          citations: [groundedCitation],
          markdown: "# Representational drift\n\nA claim. [[cite:C1]]",
        }),
        ...policy,
      },
    });
    assert.match(
      result.document.visibleMarkdown,
      /## Scope and limitations\n\nNot stated in the submitted document\./,
    );
    assert.deepEqual(result.repairs, [
      'added missing section "Scope and limitations"',
    ]);
    assert.include(
      result.document.validation.issues,
      'added missing section "Scope and limitations"',
    );
  });

  it("inserts a missing section before a draft References section", async function () {
    const result = await finalizer.finalize({
      request: request([observation]),
      runId: "run-section-before-references",
      input: {
        ...input({
          citations: [groundedCitation],
          markdown:
            "# Representational drift\n\nA claim. [[cite:C1]]\n\n## References\n\n- A handwritten entry.",
        }),
        documentKind: "literature_review",
        integrityPolicy: "research_grounded",
      },
    });
    const visible = result.document.visibleMarkdown;
    assert.include(
      visible,
      "## Scope and limitations\n\nNot stated in the submitted document.",
    );
    assert.isBelow(
      visible.indexOf("## Scope and limitations"),
      visible.indexOf("## References"),
    );
    assert.notInclude(visible, "A handwritten entry.");
    assert.deepEqual(result.repairs, [
      'added missing section "Scope and limitations"',
    ]);
  });

  it("does not add the section again when the repaired draft is resubmitted", async function () {
    const policy: DocumentOutcomePolicy = {
      documentKind: "literature_review",
      integrityPolicy: "research_grounded",
    };
    const first = await finalizer.finalize({
      request: request([observation]),
      runId: "run-idempotent-section",
      input: {
        ...input({
          citations: [groundedCitation],
          markdown: "# Representational drift\n\nA claim. [[cite:C1]]",
        }),
        ...policy,
      },
    });
    // The host's bibliography is regenerated on every submission.
    const published =
      first.document.visibleMarkdown.split("\n\n## References")[0];
    const second = await finalizer.finalize({
      request: request([observation]),
      runId: "run-idempotent-section-again",
      input: {
        ...input({
          citations: [groundedCitation],
          markdown: `${published}\n\nAgain. [[cite:C1]]`,
        }),
        ...policy,
      },
    });
    assert.deepEqual(second.repairs, []);
    assert.equal(
      second.document.visibleMarkdown.split("## Scope and limitations").length -
        1,
      1,
    );
  });
  it("adds a title heading to an authored document that has none", async function () {
    const result = await finalizer.finalize({
      request: request(),
      runId: "run-no-heading",
      input: {
        ...input({ markdown: "Just a paragraph." }),
        documentKind: "guide",
        integrityPolicy: "authored",
      },
    });
    assert.match(
      result.document.visibleMarkdown,
      /^# Representational drift\n\nJust a paragraph\./,
    );
    assert.deepEqual(result.repairs, ["added title heading"]);
  });
  it("rejects fabricated citation evidence references", async function () {
    const policy: DocumentOutcomePolicy = {
      documentKind: "literature_review",
      integrityPolicy: "research_grounded",
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
        request: request([observation]),
        runId: "run-fabricated",
        input: {
          ...input({
            markdown:
              "# Review\n\nEvidence [[cite:C1]].\n\n## Scope and limitations\n\nOne verified paper was reviewed.",
            citations: [fabricated],
          }),
          ...policy,
        },
      }),
      /invalid evidence reference/,
    );
  });

  describe("evidence refs a tool result showed in short form", function () {
    const digest =
      "a88d71e2c5d1bfcf196ccd05f2066c88ba9b55538bdf9b2879106e7f514a45b5";
    const read: TrustedReadObservation = {
      ...observation,
      observationId: `sha256:${digest}:2`,
      callDigest: `sha256:${digest}`,
    };
    const policy: DocumentOutcomePolicy = {
      documentKind: "literature_review",
      integrityPolicy: "research_grounded",
    };
    const cited = (evidenceRef: string, observations = [read]) =>
      finalizer.finalize({
        request: request(observations),
        runId: `run-${evidenceRef}`,
        input: {
          ...input({
            markdown:
              "# Review\n\nEvidence [[cite:C1]].\n\n## Scope and limitations\n\nOne verified paper was reviewed.",
            citations: [
              {
                citationId: "C1",
                sources: [
                  {
                    libraryID: 1,
                    itemKey: "AAAA1111",
                    evidenceRefs: [evidenceRef],
                  },
                ],
              },
            ],
          }),
          ...policy,
        },
        now: 300,
      });

    it("validates a citation that names its evidence by the short ref, and stores the full ref", async function () {
      const result = await cited("a88d71e2c5d1:2");
      assert.deepEqual(
        result.document.version === 2
          ? result.document.citationBundle.clusters[0].sources[0].evidenceRefs
          : [],
        [read.observationId],
      );
    });

    it("still validates the full ref older conversations and stored documents carry", async function () {
      const result = await cited(read.observationId);
      assert.deepEqual(
        result.document.version === 2
          ? result.document.citationBundle.clusters[0].sources[0].evidenceRefs
          : [],
        [read.observationId],
      );
    });

    it("rejects a short ref that names no observation of this conversation", async function () {
      await expectRejected(
        cited("a88d71e2c5d1:9"),
        /invalid evidence reference/,
      );
    });
  });

  it("rejects document assets that were not emitted by a host tool", async function () {
    const policy: DocumentOutcomePolicy = {
      documentKind: "guide",
      integrityPolicy: "authored",
    };
    await expectRejected(
      finalizer.finalize({
        request: request(),
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
          ...policy,
        },
      }),
      /not emitted by a successful host tool call/,
    );
  });

  it("does not silently publish a broken relative figure after the asset submission fails", async function () {
    await expectRejected(
      finalizer.finalize({
        request: request(),
        runId: "run-missing-figure",
        input: {
          ...input({
            markdown:
              "# Summary\n\n![Actual cropped figure](assets/figure-1-p3.png)\n\nFigure 1, PDF page 3.",
          }),
          documentKind: "report",
          integrityPolicy: "authored",
        },
      }),
      /figures.*assets|assets.*figures/i,
    );
    assert.isFalse(queries.some(({ sql }) => /INSERT INTO/.test(sql)));
  });

  it("persists a validated research-grounded document with generated references", async function () {
    const policy: DocumentOutcomePolicy = {
      documentKind: "literature_review",
      integrityPolicy: "research_grounded",
    };
    const result = await finalizer.finalize({
      request: request([observation]),
      runId: "run-grounded",
      input: {
        ...input({
          markdown:
            "# Review\n\nEvidence [[cite:C1]].\n\n## Scope and limitations\n\nOne verified paper was reviewed.",
          citations: [groundedCitation],
        }),
        ...policy,
      },
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
      request: request([observation]),
      runId: "run-styles-readiness",
      input: {
        ...input({
          markdown: "# Guide\n\nContext [[cite:C1]].",
          citations: [groundedCitation],
        }),
        documentKind: "guide",
        integrityPolicy: "authored",
      },
      now: 302,
    });
    assert.equal(initializationCalls, 1);
    assert.include(result.document.visibleMarkdown, "## References");
  });

  it("accepts authored documents with or without optional citations", async function () {
    const policy: DocumentOutcomePolicy = {
      documentKind: "guide",
      integrityPolicy: "authored",
    };
    const uncited = await finalizer.finalize({
      request: request(),
      runId: "run-authored-plain",
      input: {
        ...input(),
        ...policy,
      },
      now: 300,
    });
    assert.equal(uncited.document.validation.groundingReviewed, "not_run");

    const cited = await finalizer.finalize({
      request: request(),
      runId: "run-authored-cited",
      input: {
        ...input({
          markdown: "# Guide\n\nOptional context [[cite:C1]].",
          citations: [
            {
              citationId: "C1",
              sources: [
                { libraryID: 1, itemKey: "AAAA1111", evidenceRefs: [] },
              ],
            },
          ],
        }),
        ...policy,
      },
      now: 301,
    });
    assert.include(cited.document.visibleMarkdown, "## References");
  });
  it("reuses a run's document only for identical content and sequences new content", async function () {
    const policy: DocumentOutcomePolicy = {
      documentKind: "guide",
      integrityPolicy: "authored",
    };
    const zotero = (globalThis as any).Zotero;
    const fakeDB = zotero.DB;
    const db = new DatabaseSync(":memory:");
    zotero.DB = {
      queryAsync: async (sql: string, params: unknown[] = []) => {
        const statement = db.prepare(sql);
        const values = params.map((value) =>
          value === undefined ? null : value,
        ) as never[];
        if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql))
          return statement.all(...values);
        statement.run(...values);
        return [];
      },
      executeTransaction: async (task: () => Promise<unknown>) => {
        db.exec("BEGIN");
        try {
          const result = await task();
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    };
    try {
      await initPlanDocumentStore();
      const submit = (markdown?: string, now?: number) =>
        finalizer.finalize({
          request: request(),
          runId: "session-run",
          input: {
            ...input(markdown ? { markdown } : undefined),
            ...policy,
          },
          now,
        });

      const first = await submit(undefined, 400);
      const retried = await submit(undefined, 401);
      assert.equal(first.document.documentId, "session-run:document:1");
      assert.equal(retried.document.documentId, first.document.documentId);
      assert.equal(retried.document.contentHash, first.document.contentHash);

      const second = await submit(
        "# Representational drift\n\nA second, different guide.",
        402,
      );
      assert.equal(second.document.documentId, "session-run:document:2");
      assert.notEqual(second.document.contentHash, first.document.contentHash);

      assert.equal(
        (await loadPlanDocument(first.document.documentId))?.visibleMarkdown,
        first.document.visibleMarkdown,
      );
      assert.equal(
        (await loadPlanDocument(second.document.documentId))?.visibleMarkdown,
        second.document.visibleMarkdown,
      );

      const repaired = await submit("A body with no heading.", 403);
      const repairedRetry = await submit("A body with no heading.", 404);
      assert.equal(
        repairedRetry.document.documentId,
        repaired.document.documentId,
      );
      assert.deepEqual(
        repairedRetry.repairs,
        ["added title heading"],
        "an identical retry reports the repairs its content carries",
      );
    } finally {
      zotero.DB = fakeDB;
      db.close();
    }
  });
  it("rejects citation expansion past the final byte limit before persisting a document", async function () {
    const max = 2 * 1024 * 1024;
    const prefix = "# Guide\n\nContext [[cite:C1]].\n\n";
    const markdown = prefix + "x".repeat(max - prefix.length - 10);
    await expectRejected(
      finalizer.finalize({
        request: request(),
        runId: "run-formatted-limit",
        input: {
          ...input({
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
          documentKind: "guide",
          integrityPolicy: "authored",
        },
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
