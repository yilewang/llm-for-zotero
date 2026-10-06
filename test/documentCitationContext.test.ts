import { assert } from "chai";
import type { PlanDocument } from "../src/agent/documents/types";
import { buildDocumentCitationContext } from "../src/modules/contextPanel/planDocumentPresentation";
import { buildQuoteRenderPlan } from "../src/modules/contextPanel/quoteRenderPlan";

describe("document citation context", function () {
  const scope = globalThis as typeof globalThis & { Zotero?: any };
  const original = scope.Zotero;
  const quoteText =
    "Stable readout can coexist with representational drift across ten recording sessions.";
  const paper = {
    id: 10,
    key: "PAPERKEY",
    libraryID: 3,
    isRegularItem: () => true,
    isAttachment: () => false,
    getAttachments: () => [11],
    getField: (field: string) =>
      ({ title: "Known source", firstCreator: "Fixture", date: "2024" })[
        field
      ] || "",
  };
  const attachment = {
    id: 11,
    key: "PDFKEY00",
    libraryID: 3,
    parentID: 10,
    attachmentContentType: "application/pdf",
    isAttachment: () => true,
    isRegularItem: () => false,
    getField: (field: string) => (field === "title" ? "Source PDF" : ""),
  };
  const fixture = (): PlanDocument => ({
    version: 2,
    documentId: "document-test",
    documentVersion: 1,
    documentKind: "custom",
    integrityPolicy: "research_grounded",
    origin: { kind: "direct", runId: "run", sourceMessageTimestamp: 123 },
    conversationKey: 10,
    title: "Document",
    visibleMarkdown: `> ${quoteText}`,
    visibleHtml: "",
    citationBundle: {
      clusters: [],
      bibliographyEntries: [],
      style: { id: "apa", title: "APA" },
      locale: "en-US",
    },
    verifiedQuotes: [
      {
        quoteId: "Q_doc",
        text: quoteText,
        libraryID: 3,
        itemKey: "PAPERKEY",
        attachmentItemKey: "PDFKEY00",
        evidenceRefs: ["evidence"],
        certificate: {
          contextItemId: 11,
          sourceFingerprint: "sha256:source",
          pageIndex: 4,
          sourceMatchText: quoteText,
          sourceMatchKind: "exact",
          sourceMatchPageOccurrence: 0,
        },
      },
    ],
    assets: [],
    coverageItems: [],
    validation: {
      integrityValidated: true,
      groundingReviewed: "passed",
      quoteVerified: "verified",
      issues: [],
    },
    contentHash: "unchanged",
    createdAt: 123,
  });
  beforeEach(function () {
    scope.Zotero = {
      Items: {
        get: (id: number) =>
          id === 10 ? paper : id === 11 ? attachment : null,
        getByLibraryAndKey: (library: number, key: string) =>
          library !== 3
            ? null
            : key === paper.key
              ? paper
              : key === attachment.key
                ? attachment
                : null,
      },
      getMainWindow: () => {
        throw new Error("Must not infer a document source from active UI");
      },
    };
  });
  afterEach(function () {
    scope.Zotero = original;
  });
  it("preserves certified source identity and page provenance without changing document bytes", function () {
    const document = fixture();
    const before = JSON.stringify(document);
    const context = buildDocumentCitationContext(document)!;
    assert.equal(context.panelItem.id, 10);
    const citation = context.assistantMessage.quoteCitations![0];
    assert.equal(citation.citationLabel, "(Fixture, 2024)");
    assert.equal(citation.contextItemId, 11);
    assert.equal(citation.pageHintIndex, 4);
    assert.equal(citation.sourceFingerprint, "sha256:source");
    assert.equal(
      context.assistantMessage.quoteDisplayOverride?.markdown,
      "[[quote:Q_doc]]",
    );
    assert.equal(JSON.stringify(document), before);
  });
  it("keeps a card for each certified quote when two ids differ only by '.' or ':'", function () {
    const otherText =
      "Population codes rotate while the decoder stays aligned with behaviour across weeks.";
    const base = fixture();
    const certified = base.verifiedQuotes[0];
    for (const [first, second] of [
      ["Q1.a", "Q1a"],
      ["p:1", "p1"],
    ]) {
      const document: PlanDocument = {
        ...base,
        visibleMarkdown: `> ${quoteText}\n\n> ${otherText}`,
        verifiedQuotes: [
          { ...certified, quoteId: first },
          {
            ...certified,
            quoteId: second,
            text: otherText,
            certificate: {
              ...certified.certificate,
              sourceMatchText: otherText,
            },
          },
        ],
      };
      const context = buildDocumentCitationContext(document)!;
      const display = context.assistantMessage.quoteDisplayOverride!;
      assert.equal(
        display.markdown,
        `[[quote:${first}]]\n\n[[quote:${second}]]`,
      );
      assert.sameMembers(
        context.assistantMessage.quoteCitations!.map((citation) => citation.id),
        [first, second],
      );
      const plan = buildQuoteRenderPlan(display);
      assert.deepEqual(
        plan.occurrences.map((occurrence) => [
          occurrence.quoteCitationId,
          occurrence.displayText,
        ]),
        [
          [first, quoteText],
          [second, otherText],
        ],
      );
    }
  });
  it("rejects a certificate whose attachment identity no longer matches", function () {
    const document = fixture();
    const changed = {
      ...document,
      verifiedQuotes: [
        {
          ...document.verifiedQuotes[0],
          certificate: {
            ...document.verifiedQuotes[0].certificate,
            contextItemId: 999,
          },
        },
      ],
    };
    assert.isNull(buildDocumentCitationContext(changed));
  });
  it("does not turn a conversation key or the active reader into undocumented source authority", function () {
    assert.isNull(
      buildDocumentCitationContext({ ...fixture(), verifiedQuotes: [] }),
    );
  });
  it("preserves an existing display-time rejection instead of reauthenticating its text", function () {
    const document = fixture();
    const rejected = `> ${quoteText}\n>\n> Not a source quote`;
    const context = buildDocumentCitationContext(document, {
      panelItem: paper as unknown as Zotero.Item,
      assistantMessage: {
        role: "assistant",
        text: document.visibleMarkdown,
        timestamp: 123,
        quoteDisplayOverride: { markdown: rejected, quoteCitations: [] },
      },
    })!;
    assert.equal(
      context.assistantMessage.quoteDisplayOverride?.markdown,
      rejected,
    );
  });
});
