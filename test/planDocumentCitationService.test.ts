import { assert } from "chai";
import {
  bindDocumentCitationGroupsForDisplay,
  formatPlanDocumentCitations,
} from "../src/agent/documents/citationService";
import type { FormattedCitationBundle } from "../src/agent/documents/types";
import { renderMarkdownForNote } from "../src/utils/markdown";
import type { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import type { ResearchEvidenceRecord } from "../src/agent/research/types";

describe("plan document citation serialization", function () {
  const priorZotero = (globalThis as { Zotero?: unknown }).Zotero;

  before(function () {
    const items = new Map([
      ["AAAA1111", { id: 10, isNote: () => false }],
      ["BBBB2222", { id: 11, isNote: () => false }],
    ]);
    (globalThis as { Zotero?: unknown }).Zotero = {
      Libraries: { userLibraryID: 1, get: () => undefined },
      Items: {
        getByLibraryAndKey: (_libraryID: number, itemKey: string) =>
          items.get(itemKey) || false,
      },
    };
  });

  after(function () {
    (globalThis as { Zotero?: unknown }).Zotero = priorZotero;
  });

  it("binds saved groups by unique CSL label even when source order differs, and preserves ambiguous groups", function () {
    const bundle: FormattedCitationBundle = {
      clusters: [
        {
          citationId: "C1",
          text: "(Alpha, 2020; Beta, 2021)",
          html: "",
          sources: [
            { libraryID: 1, itemKey: "BBBB2222", evidenceRefs: [] },
            { libraryID: 1, itemKey: "AAAA1111", evidenceRefs: [] },
          ],
        },
      ],
      bibliographyEntries: [],
      style: { id: "apa", title: "APA" },
      locale: "en-US",
    };
    const markdown =
      "Evidence (Alpha, 2020; Beta, 2021) [1](zotero://select/library/items/BBBB2222) [2](zotero://select/library/items/AAAA1111). Other (Alpha, 2020).";
    let ambiguous = false;
    const gateway = {
      formatStructuredCitations: ({
        clusters,
      }: {
        clusters: Array<{
          citationId: string;
          items: Array<{ itemId: number }>;
        }>;
      }) => ({
        clusters: clusters.map((cluster) => ({
          citationId: cluster.citationId,
          text:
            ambiguous || cluster.items[0].itemId === 10
              ? "(Alpha, 2020)"
              : "(Beta, 2021)",
          html: "",
        })),
        bibliographyEntries: [],
      }),
    } as unknown as ZoteroGateway;
    assert.equal(
      bindDocumentCitationGroupsForDisplay({ markdown, bundle, gateway }),
      "Evidence ([Alpha, 2020](zotero://select/library/items/AAAA1111); [Beta, 2021](zotero://select/library/items/BBBB2222)). Other (Alpha, 2020).",
    );
    ambiguous = true;
    assert.equal(
      bindDocumentCitationGroupsForDisplay({ markdown, bundle, gateway }),
      markdown,
    );
  });

  it("links each exact CSL label without adding a second numbered citation group", async function () {
    const evidence: ResearchEvidenceRecord[] = [
      {
        version: 2,
        evidenceRef: "e-a",
        researchJobId: "research",
        executionId: "execution",
        parentTaskId: "task",
        libraryID: 1,
        itemKey: "AAAA1111",
        sourceFingerprint: "pdfjs:a",
        sourceKind: "body",
        observationId: "observation-a",
        locator: {
          kind: "pdf_page",
          attachmentItemKey: "PDFP1111",
          pageIndex: 4,
          sourceFingerprint: "pdfjs:a",
        },
        createdAt: 1,
      },
      {
        version: 2,
        evidenceRef: "e-b",
        researchJobId: "research",
        executionId: "execution",
        parentTaskId: "task",
        libraryID: 1,
        itemKey: "BBBB2222",
        sourceFingerprint: "metadata:b",
        sourceKind: "metadata",
        observationId: "observation-b",
        createdAt: 1,
      },
    ];
    const result = await formatPlanDocumentCitations({
      gateway: {
        formatStructuredCitations: ({
          clusters,
        }: {
          clusters: Array<{
            citationId: string;
            items: Array<{ itemId: number }>;
          }>;
        }) => ({
          clusters: clusters.map((cluster) => ({
            citationId: cluster.citationId,
            text:
              cluster.items.length > 1
                ? "(Alpha, 2020; Beta, 2021)"
                : cluster.items[0].itemId === 10
                  ? "(Alpha, 2020)"
                  : "(Beta, 2021)",
            html: "",
          })),
          bibliographyEntries: [
            { itemId: 10, text: "Alpha. 2020.", html: "Alpha. 2020." },
            { itemId: 11, text: "Beta. 2021.", html: "Beta. 2021." },
          ],
          styleId: "apa",
          styleTitle: "APA",
          locale: "en-US",
        }),
      } as unknown as ZoteroGateway,
      draftMarkdown:
        "## Findings\n\nResult [[cite:cluster]].\n\nRepeated label (Alpha, 2020; Beta, 2021) [[cite:cluster]].\n\nAttached label (Alpha, 2020; Beta, 2021)[[cite:cluster]].\n\nContext (not a citation) [[cite:cluster]].",
      clusters: [
        {
          citationId: "cluster",
          sources: [
            {
              libraryID: 1,
              itemKey: "AAAA1111",
              evidenceRefs: ["e-a"],
              locator: {
                kind: "pdf_page",
                attachmentItemKey: "PDFP1111",
                pageIndex: 4,
                sourceFingerprint: "pdfjs:a",
              },
            },
            {
              libraryID: 1,
              itemKey: "BBBB2222",
              evidenceRefs: ["e-b"],
            },
          ],
        },
      ],
      corpus: [
        { snapshotId: "s", libraryID: 1, itemKey: "AAAA1111", ordinal: 0 },
        { snapshotId: "s", libraryID: 1, itemKey: "BBBB2222", ordinal: 1 },
      ],
      evidence,
      spec: {
        kind: "literature_review",
        title: "Review",
        requiredSections: ["Findings"],
        requiresReferences: true,
        requiresCoverageSection: false,
        allowFigures: false,
        citationStyle: { styleId: "apa", styleTitle: "APA", locale: "en-US" },
      },
    });

    const citation =
      "([Alpha, 2020](zotero://open-pdf/library/items/PDFP1111?page=5); " +
      "[Beta, 2021](zotero://select/library/items/BBBB2222))";
    assert.include(result.visibleMarkdown, citation);
    assert.equal(
      result.visibleMarkdown.split("Alpha, 2020").length - 1,
      4,
      "each citation occurrence has one label, even when the model supplies the literal label before its token",
    );
    assert.include(
      result.visibleMarkdown,
      `Context (not a citation) ${citation}`,
    );
    assert.equal(
      result.citationBundle.clusters[0].text,
      "(Alpha, 2020; Beta, 2021)",
    );
    assert.deepEqual(
      result.citationBundle.clusters[0].sources.map((source) => source.itemKey),
      ["AAAA1111", "BBBB2222"],
    );
    const noteHtml = renderMarkdownForNote(result.visibleMarkdown);
    assert.include(
      noteHtml,
      'href="zotero://open-pdf/library/items/PDFP1111?page=5"',
    );
    assert.include(noteHtml, 'href="zotero://select/library/items/BBBB2222"');
  });

  it("replaces a model-authored References section with the host bibliography", async function () {
    const result = await formatPlanDocumentCitations({
      gateway: {
        formatStructuredCitations: () => ({
          clusters: [
            {
              citationId: "cluster",
              text: "(Alpha, 2020)",
              html: "<span>(Alpha, 2020)</span>",
            },
          ],
          bibliographyEntries: [
            { itemId: 10, text: "Alpha. 2020.", html: "Alpha. 2020." },
          ],
          styleId: "apa",
          styleTitle: "APA",
          locale: "en-US",
        }),
      } as unknown as ZoteroGateway,
      draftMarkdown: [
        "# Review",
        "",
        "Evidence [[cite:cluster]].",
        "",
        "## References",
        "",
        "- Model-authored entry that must not survive",
      ].join("\n"),
      clusters: [
        {
          citationId: "cluster",
          sources: [
            {
              libraryID: 1,
              itemKey: "AAAA1111",
              evidenceRefs: ["e-a"],
            },
          ],
        },
      ],
      corpus: [
        { snapshotId: "s", libraryID: 1, itemKey: "AAAA1111", ordinal: 0 },
      ],
      evidence: [
        {
          version: 2,
          evidenceRef: "e-a",
          researchJobId: "research",
          executionId: "execution",
          parentTaskId: "task",
          libraryID: 1,
          itemKey: "AAAA1111",
          sourceFingerprint: "pdfjs:a",
          sourceKind: "body",
          observationId: "observation-a",
          createdAt: 1,
        },
      ],
      spec: {
        kind: "literature_review",
        title: "Review",
        requiredSections: [],
        requiresReferences: true,
        requiresCoverageSection: false,
        allowFigures: false,
        citationStyle: { styleId: "apa", styleTitle: "APA", locale: "en-US" },
      },
    });

    assert.notInclude(result.visibleMarkdown, "Model-authored entry");
    assert.equal(result.visibleMarkdown.match(/^## References$/gm)?.length, 1);
    assert.include(result.visibleMarkdown, "Alpha. 2020.");
  });

  it("binds a literal multi-paper label to its adjacent sequence of citation tokens", async function () {
    const result = await formatPlanDocumentCitations({
      gateway: {
        formatStructuredCitations: () => ({
          clusters: [
            { citationId: "a", text: "(Alpha, 2020)", html: "" },
            { citationId: "b", text: "(Beta, n.d.)", html: "" },
          ],
          bibliographyEntries: [],
          styleId: "apa",
          styleTitle: "APA",
          locale: "en-US",
        }),
      } as unknown as ZoteroGateway,
      draftMarkdown:
        "## Findings\n\nTogether (Alpha, 2020; Beta, n.d.)[[cite:a]][[cite:b]].\n\nIndependent (unrelated discussion)[[cite:a]][[cite:b]].\n\nQualified (e.g., Alpha, 2020; Beta, n.d.)[[cite:a]][[cite:b]].\n\nWrapped (Alpha [[cite:a]]).\n\nMixed (Alpha [[cite:a]]; Beta [[cite:b]]).\n\nFull (Alpha, 2020 [[cite:a]]).\n\nPreserve (a claim about Alpha [[cite:a]]).",
      clusters: [
        {
          citationId: "a",
          sources: [{ libraryID: 1, itemKey: "AAAA1111", evidenceRefs: [] }],
        },
        {
          citationId: "b",
          sources: [{ libraryID: 1, itemKey: "BBBB2222", evidenceRefs: [] }],
        },
      ],
      corpus: [
        { libraryID: 1, itemKey: "AAAA1111" },
        { libraryID: 1, itemKey: "BBBB2222" },
      ],
      evidence: [],
      requireEvidence: false,
      spec: {
        kind: "custom",
        title: "Review",
        requiredSections: [],
        requiresReferences: false,
        requiresCoverageSection: false,
        allowFigures: false,
        citationStyle: { styleId: "apa", styleTitle: "APA", locale: "en-US" },
      },
    });
    assert.equal(result.visibleMarkdown.split("Alpha, 2020").length - 1, 7);
    assert.equal(result.visibleMarkdown.split("Beta, n.d.").length - 1, 4);
    const alpha = "[Alpha, 2020](zotero://select/library/items/AAAA1111)";
    const beta = "[Beta, n.d.](zotero://select/library/items/BBBB2222)";
    assert.include(result.visibleMarkdown, `Wrapped (${alpha}).`);
    assert.include(result.visibleMarkdown, `Mixed (${alpha}; ${beta}).`);
    assert.include(result.visibleMarkdown, `Full (${alpha}).`);
    assert.include(result.visibleMarkdown, "Preserve (a claim about Alpha ");
    assert.include(result.visibleMarkdown, "Qualified (e.g., ");
    assert.include(
      result.visibleMarkdown,
      "Independent (unrelated discussion)",
    );
    assert.include(
      result.visibleMarkdown,
      "zotero://select/library/items/AAAA1111",
    );
    assert.include(
      result.visibleMarkdown,
      "zotero://select/library/items/BBBB2222",
    );
  });
});
