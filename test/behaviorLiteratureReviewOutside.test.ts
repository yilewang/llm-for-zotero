import { assert } from "chai";
import type { AgentEvent, AgentPendingAction } from "../src/agent/types";
import { selectSteps } from "../test-behavior/catalog";
import { paperCardAnswer, tickedPaperRows } from "../test-behavior/core";
import {
  answerPaperCard,
  assertLaterVersion,
  assertNoOutsideDocument,
  assertOutsideDocument,
  assertOutsideSources,
  assertReviewCardButtons,
  assertReviewSearch,
  assertZoteroOnlySources,
  citedPaperIds,
  laterImportApproval,
  laterImportResult,
  submittedSources,
  successfulSubmission,
} from "../test-behavior/literatureReviewOutside";

function call(name: string, args: unknown, id = `${name}-call`): AgentEvent {
  return { type: "tool_call", callId: id, name, args };
}

function result(
  name: string,
  content: unknown,
  ok = true,
  id = `${name}-call`,
): AgentEvent {
  return {
    type: "tool_result",
    callId: id,
    name,
    ok,
    actionReceipts: [],
    content,
  };
}

const turn = (events: AgentEvent[]) => ({
  events,
  result: { kind: "completed", text: "done" },
  prompt: "",
});

function paperCard(
  overrides: Partial<AgentPendingAction> = {},
): AgentPendingAction {
  return {
    toolName: "literature_review",
    title: "Relevant papers",
    confirmLabel: "Import and cite selected",
    cancelLabel: "Cancel",
    actions: [
      {
        id: "cite",
        label: "Cite {count} without importing",
        style: "secondary",
      },
      { id: "import", label: "Import and cite selected", style: "primary" },
      { id: "cancel", label: "Cancel", style: "secondary" },
    ],
    fields: [
      {
        type: "paper_result_list",
        id: "selectedPaperIds",
        label: "Papers",
        rows: [
          { id: "r1", title: "One", checked: true },
          { id: "r2", title: "Two", checked: false },
          { id: "r3", title: "Three" },
        ],
      },
    ],
    ...overrides,
  } as AgentPendingAction;
}

const shown = (action: AgentPendingAction): AgentEvent => ({
  type: "confirmation_required",
  requestId: "req-1",
  action,
});

describe("behavior steps for literature reviews with outside papers", function () {
  it("lists the four rows with the later import depending on the cite row", function () {
    const rows = selectSteps("full", ["skills"]).filter((row) =>
      /outside|ambiguous/.test(row.id),
    );
    assert.deepEqual(
      rows.map((row) => [row.id, row.mode, row.dependsOn]),
      [
        ["skills.literature-review-outside-cite", "auto", []],
        ["skills.literature-review-outside-import", "auto", []],
        [
          "skills.literature-review-outside-later-import",
          "safe",
          ["skills.literature-review-outside-cite"],
        ],
        ["skills.literature-review-ambiguous-chat", "auto", []],
      ],
    );
  });

  it("selecting the later import also selects the cite row before it", function () {
    assert.deepEqual(
      selectSteps("full", [
        "skills.literature-review-outside-later-import",
      ]).map((row) => row.id),
      [
        "skills.literature-review-outside-cite",
        "skills.literature-review-outside-later-import",
      ],
    );
  });

  it("keeps the new rows out of the smoke tier", function () {
    const smoke = selectSteps("smoke").map((row) => row.id);
    assert.notInclude(smoke.join(","), "outside");
    assert.notInclude(smoke, "skills.literature-review-ambiguous-chat");
  });
});

describe("behavior driver paper card answers", function () {
  it("sends the pressed button and the ticked rows under the card's field id", function () {
    assert.deepEqual(tickedPaperRows(paperCard()), {
      fieldId: "selectedPaperIds",
      rowIds: ["r1", "r3"],
    });
    assert.deepEqual(paperCardAnswer(paperCard(), "cite"), {
      actionId: "cite",
      data: { selectedPaperIds: ["r1", "r3"] },
    });
  });

  it("counts the checked rows of every mode view once", function () {
    const action = paperCard({
      fields: [
        {
          type: "paper_result_list",
          id: "selectedPaperIds",
          label: "Papers",
          rows: [{ id: "r1", title: "One", checked: true }],
          modes: [
            {
              id: "refs",
              label: "References",
              rows: [
                { id: "r1", title: "One", checked: true },
                { id: "r9", title: "Nine", checked: true },
              ],
            },
          ],
        },
      ],
    });
    assert.deepEqual(tickedPaperRows(action).rowIds, ["r1", "r9"]);
  });

  it("refuses a button the card does not declare", function () {
    const card = paperCard({
      actions: [{ id: "import", label: "Import selected", style: "primary" }],
    });
    assert.throws(
      () => paperCardAnswer(card, "cite"),
      /no cite button; it has import/,
    );
  });

  it("refuses a card with no ticked paper, as the card disables its buttons", function () {
    const card = paperCard({
      fields: [
        {
          type: "paper_result_list",
          id: "selectedPaperIds",
          label: "Papers",
          rows: [{ id: "r1", title: "One", checked: false }],
        },
      ],
    });
    assert.throws(() => paperCardAnswer(card, "import"), /no ticked paper/);
  });

  it("answers only the paper selection card, and marks an import as an effect", function () {
    const log: { actionId: string; rowIds: string[] }[] = [];
    const cite = answerPaperCard("cite", log);
    const imports = answerPaperCard("import", log);
    assert.isUndefined(cite(paperCard({ toolName: "library_import" })));
    assert.isFalse(Boolean(cite(paperCard())?.effect));
    assert.isTrue(Boolean(imports(paperCard())?.effect));
    assert.deepEqual(log, [
      { actionId: "cite", rowIds: ["r1", "r3"] },
      { actionId: "import", rowIds: ["r1", "r3"] },
    ]);
  });
});

describe("behavior checks of a review with outside papers", function () {
  it("needs a review search with forLiteratureReview", function () {
    assertReviewSearch(
      turn([
        call("literature_search", {
          workflow: "review",
          forLiteratureReview: true,
        }),
      ]),
    );
    assert.throws(
      () =>
        assertReviewSearch(
          turn([call("literature_search", { workflow: "review" })]),
        ),
      /forLiteratureReview/,
    );
  });

  it("needs both card buttons with their labels", function () {
    assertReviewCardButtons(turn([shown(paperCard())]));
    assert.throws(
      () => assertReviewCardButtons(turn([])),
      /No literature_review card/,
    );
    const old = paperCard({
      actions: [
        { id: "import", label: "Import selected", style: "primary" },
        { id: "cite", label: "Cite them", style: "secondary" },
      ],
    });
    assert.throws(
      () => assertReviewCardButtons(turn([shown(old)])),
      /without importing/,
    );
  });

  it("reads the one successful submission and its sources", function () {
    const args = {
      citations: [
        { citationId: "C1", sources: [{ paperId: "p1" }] },
        { citationId: "C2", sources: [{ libraryID: 1, itemKey: "ABCD1234" }] },
      ],
    };
    const submission = successfulSubmission(
      turn([
        call("submit_document", args, "a"),
        result("submit_document", { error: "no" }, false, "a"),
        call("submit_document", args, "b"),
        result("submit_document", { documentId: "doc-1" }, true, "b"),
      ]),
    );
    assert.equal(submission.documentId, "doc-1");
    const sources = submittedSources(submission.args);
    assert.deepEqual(citedPaperIds(sources), ["p1"]);
    assertOutsideSources(sources);
    assert.throws(
      () => successfulSubmission(turn([])),
      /one successful submit_document, saw 0/,
    );
  });

  it("rejects web addresses and a missing paperId in outside citations", function () {
    assert.throws(
      () => assertOutsideSources([{ libraryID: 1, itemKey: "ABCD1234" }]),
      /paperId/,
    );
    assert.throws(
      () => assertOutsideSources([{ paperId: "p1" }, { url: "https://x.org" }]),
      /neither a paperId nor a Zotero item/,
    );
    assert.throws(
      () =>
        assertOutsideSources([{ paperId: "p1", url: "https://x.org/paper" }]),
      /neither a paperId nor a Zotero item/,
    );
  });

  it("rejects a paperId source after an import", function () {
    assertZoteroOnlySources([{ libraryID: 1, itemKey: "ABCD1234" }]);
    assert.throws(
      () =>
        assertZoteroOnlySources([
          { libraryID: 1, itemKey: "ABCD1234" },
          { paperId: "p1" },
        ]),
      /outside papers \(p1\)/,
    );
  });
});

const PAPER = {
  paperId: "p1",
  doi: "10.1000/abc",
  csl: { id: "p1", type: "article-journal" },
};

function storedDocument(overrides: Record<string, unknown> = {}): any {
  return {
    version: 2,
    documentId: "doc-1",
    documentVersion: 1,
    title: "Review",
    visibleMarkdown:
      "Claim [A](https://doi.org/10.1000/abc).\n\n## References\n\n- [Able, A. (2021). Alpha.](https://doi.org/10.1000/abc)\n",
    citationDraft: { markdown: "Claim [[cite:C1]].", clusters: [] },
    citationBundle: {
      clusters: [
        { citationId: "C1", sources: [{ kind: "outside", paperId: "p1" }] },
      ],
      bibliographyEntries: [{ paperId: "p1", text: "Able, A.", html: "" }],
      outsidePapers: [PAPER],
    },
    ...overrides,
  };
}

describe("behavior checks of stored review documents", function () {
  it("accepts a document with its outside papers listed, linked and drafted", function () {
    assertOutsideDocument(storedDocument(), ["p1"]);
  });

  it("names what a stored document lacks", function () {
    const bundle = storedDocument().citationBundle;
    assert.throws(
      () =>
        assertOutsideDocument(
          storedDocument({
            citationBundle: { ...bundle, outsidePapers: undefined },
          }),
          ["p1"],
        ),
      /outsidePapers is empty/,
    );
    assert.throws(
      () => assertOutsideDocument(storedDocument(), ["p2"]),
      /without an outside-paper snapshot: p2/,
    );
    assert.throws(
      () =>
        assertOutsideDocument(
          storedDocument({
            citationBundle: { ...bundle, bibliographyEntries: [] },
          }),
          ["p1"],
        ),
      /without a bibliography entry: p1/,
    );
    assert.throws(
      () =>
        assertOutsideDocument(
          storedDocument({
            visibleMarkdown: "Claim.\n\n## References\n\n- x\n",
          }),
          ["p1"],
        ),
      /does not link outside paper p1 to https:\/\/doi.org\/10.1000\/abc/,
    );
    assert.throws(
      () =>
        assertOutsideDocument(storedDocument({ citationDraft: undefined }), [
          "p1",
        ]),
      /citationDraft/,
    );
  });

  it("accepts a document that lists no outside paper after an import", function () {
    assertNoOutsideDocument(
      storedDocument({
        citationBundle: {
          clusters: [
            { citationId: "C1", sources: [{ libraryID: 1, itemKey: "K1" }] },
          ],
          bibliographyEntries: [],
        },
      }),
    );
    assert.throws(
      () => assertNoOutsideDocument(storedDocument()),
      /outsidePapers is not empty/,
    );
  });
});

describe("behavior checks of a later import", function () {
  const prior = { documentId: "doc-1", documentVersion: 1 };
  const imported = {
    revisionOf: { documentId: "doc-1", documentVersion: 1 },
    documentId: "doc-2",
    importedCount: 1,
    papers: [{ paperId: "p2", outcome: "not_importable" }],
  };

  it("finds the successful document_citations import of the right document", function () {
    const events = [
      call("library_import", {
        kind: "document_citations",
        documentId: "doc-1",
      }),
      result("library_import", imported),
    ];
    assert.equal(laterImportResult(turn(events), "doc-1").documentId, "doc-2");
    assert.throws(
      () => laterImportResult(turn(events), "doc-9"),
      /named document doc-1, not doc-9/,
    );
    assert.throws(
      () => laterImportResult(turn([]), "doc-1"),
      /never called with kind 'document_citations'/,
    );
    assert.throws(
      () =>
        laterImportResult(
          turn([
            events[0],
            result("library_import", { error: "refused" }, false),
          ]),
          "doc-1",
        ),
      /published a new version/,
    );
  });

  it("names an import by identifiers as the failure, not the approval wording", function () {
    const byIdentifiers = [
      call("library_import", {
        kind: "identifiers",
        identifiers: ["10.1000/a", "10.1000/b"],
      }),
      result("library_import", { importedCount: 2 }),
    ];
    assert.throws(
      () => laterImportResult(turn(byIdentifiers), "doc-1"),
      /imported by identifiers instead of document_citations/,
    );
    assert.throws(
      () =>
        laterImportResult(
          turn([
            ...byIdentifiers,
            call("library_import", {
              kind: "document_citations",
              documentId: "doc-1",
            }),
            result("library_import", imported),
          ]),
          "doc-1",
        ),
      /imported by identifiers instead of document_citations/,
    );
    const card = (fields: AgentPendingAction["fields"], description: string) =>
      ({
        toolName: "library_import",
        title: "Import",
        description,
        confirmLabel: "Import",
        cancelLabel: "Cancel",
        fields,
      }) as AgentPendingAction;
    assert.throws(
      () =>
        laterImportApproval(
          card(
            [
              {
                type: "checklist",
                id: "identifiersChecklist",
                label: "Identifiers to import",
                items: [{ id: "0", label: "10.1000/a", checked: true }],
              },
            ],
            "Import 1 identifier into the library.",
          ),
          "Drift review",
        ),
      /imported by identifiers instead of document_citations/,
    );
    assert.deepEqual(
      laterImportApproval(
        card([], 'Import 2 papers that "Drift review" cites into the library.'),
        "Drift review",
      ),
      { effect: true },
    );
    assert.throws(
      () => laterImportApproval(card([], "Import 2 papers."), "Drift review"),
      /does not name the review "Drift review"/,
    );
    assert.isUndefined(
      laterImportApproval({ ...card([], ""), toolName: "note_write" }, "x"),
    );
  });

  it("checks the new version number, its link to the old document and leftover outside sources", function () {
    const next = storedDocument({
      documentId: "doc-2",
      documentVersion: 2,
      revisionOf: { documentId: "doc-1", documentVersion: 1 },
      citationBundle: {
        clusters: [
          { citationId: "C1", sources: [{ libraryID: 1, itemKey: "K1" }] },
          { citationId: "C2", sources: [{ kind: "outside", paperId: "p2" }] },
        ],
        bibliographyEntries: [],
      },
    });
    assertLaterVersion(next, imported, prior);
    assert.throws(
      () =>
        assertLaterVersion({ ...next, documentVersion: 3 }, imported, prior),
      /documentVersion/,
    );
    assert.throws(
      () =>
        assertLaterVersion(
          { ...next, revisionOf: { documentId: "doc-0", documentVersion: 1 } },
          imported,
          prior,
        ),
      /revisionOf.documentId/,
    );
    // A paper the import found in the library must be cited as that item.
    const found = {
      ...imported,
      papers: [
        { paperId: "p1", outcome: "imported", itemId: 11 },
        { paperId: "p2", outcome: "found_existing", itemId: 12 },
      ],
    };
    const keys = (itemId: number) => (itemId === 11 ? "K1" : "K2");
    assert.throws(
      () => assertLaterVersion(next, found, prior, keys),
      /does not cite the Zotero item\(s\) K2/,
    );
    const citedBoth = {
      ...next,
      citationBundle: {
        ...next.citationBundle,
        clusters: [
          { citationId: "C1", sources: [{ libraryID: 1, itemKey: "K1" }] },
          { citationId: "C2", sources: [{ libraryID: 1, itemKey: "K2" }] },
        ],
      },
    };
    assertLaterVersion(citedBoth, found, prior, keys);
    // An imported paper left as an outside source is wrong.
    assert.throws(
      () =>
        assertLaterVersion(
          {
            ...citedBoth,
            citationBundle: {
              ...citedBoth.citationBundle,
              clusters: [
                ...citedBoth.citationBundle.clusters,
                {
                  citationId: "C3",
                  sources: [{ kind: "outside", paperId: "p2" }],
                },
              ],
            },
          },
          found,
          prior,
          keys,
        ),
      /still cites imported paper\(s\) as outside: p2/,
    );
  });
});
