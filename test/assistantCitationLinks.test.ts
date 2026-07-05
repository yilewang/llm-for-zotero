import { assert } from "chai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  clearCachedCitationPagesForTests,
  collectAssistantCitationCandidates,
  decorateAssistantCitationLinks,
  extractInlineCitationMentions,
  extractBlockquoteTailCitation,
  extractMarkdownBlockquoteTextsForCitationDecoration,
  extractStandalonePaperSourceLabel,
  formatSourceLabelWithPage,
  formatUnverifiedCitationChipLabel,
  getQuoteCitationLookupTextForTests,
  isPdfBackedCitationCandidateForTests,
  lookupCachedCitationPageForContextIdsForTests,
  lookupCachedCitationPage,
  matchAssistantCitationCandidates,
  rememberCachedCitationPage,
  resolveQuoteCitationPageHintForTests,
  resolveAutoNavigableCitationCandidatesForTests,
  resolveAuthoritativeNonPdfCitationCandidateForTests,
  INLINE_CITATION_SKIP_SELECTOR,
  type AssistantCitationPaperCandidate,
} from "../src/modules/contextPanel/assistantCitationLinks";
import * as citationLinks from "../src/modules/contextPanel/assistantCitationLinks";
import { stripLeadingCitationSeparators } from "../src/modules/contextPanel/citationText";
import type { PaperContextRef } from "../src/modules/contextPanel/types";

const testDir = dirname(fileURLToPath(import.meta.url));
const globalScope = globalThis as typeof globalThis & { Zotero?: any };

function makeZoteroItem(params: {
  id: number;
  kind: "regular" | "attachment";
  fields?: Record<string, unknown>;
  parentID?: number;
  attachmentIDs?: number[];
  attachmentFilename?: string;
  attachmentContentType?: string;
}): Zotero.Item {
  return {
    id: params.id,
    parentID: params.parentID,
    attachmentFilename: params.attachmentFilename,
    attachmentContentType: params.attachmentContentType,
    isRegularItem: () => params.kind === "regular",
    isAttachment: () => params.kind === "attachment",
    getField: (field: string) => params.fields?.[field] || "",
    getAttachments: () => params.attachmentIDs || [],
  } as unknown as Zotero.Item;
}

function installZoteroItems(
  items: Record<number, Zotero.Item | undefined>,
): void {
  globalScope.Zotero = {
    Items: {
      get: (itemId: number) => items[itemId] || null,
    },
  };
}

function installLivePaperContext(params: {
  itemId: number;
  contextItemId: number;
  title: string;
  firstCreator: string;
  year?: string;
  citationKey?: string;
  attachmentTitle?: string;
}): void {
  installZoteroItems({
    [params.itemId]: makeZoteroItem({
      id: params.itemId,
      kind: "regular",
      fields: {
        title: params.title,
        firstCreator: params.firstCreator,
        year: params.year,
        citationKey: params.citationKey,
      },
    }),
    [params.contextItemId]: makeZoteroItem({
      id: params.contextItemId,
      kind: "attachment",
      parentID: params.itemId,
      fields: { title: params.attachmentTitle || "Live PDF" },
      attachmentFilename: "live.pdf",
    }),
  });
}

function makeCitationCandidate(
  paperContext: PaperContextRef,
): AssistantCitationPaperCandidate {
  return {
    paperContext,
    displayPaperContext: paperContext,
    contextItemId: paperContext.contextItemId,
    sourceLabel: `(${paperContext.firstCreator || paperContext.title})`,
    citationLabel: [paperContext.firstCreator, paperContext.year]
      .filter(Boolean)
      .join(", "),
    displaySourceLabel: `(${paperContext.firstCreator || paperContext.title})`,
    displayCitationLabel: [paperContext.firstCreator, paperContext.year]
      .filter(Boolean)
      .join(", "),
    normalizedSourceLabel: String(
      paperContext.firstCreator || paperContext.title || "",
    ).toLowerCase(),
    normalizedCitationLabel: [paperContext.firstCreator, paperContext.year]
      .filter(Boolean)
      .join(" ")
      .toLowerCase(),
    normalizedDisplaySourceLabel: String(
      paperContext.firstCreator || paperContext.title || "",
    ).toLowerCase(),
    normalizedDisplayCitationLabel: [
      paperContext.firstCreator,
      paperContext.year,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase(),
  };
}

const originalZotero = globalScope.Zotero;

describe("assistantCitationLinks", function () {
  afterEach(function () {
    clearCachedCitationPagesForTests();
    if (originalZotero === undefined) {
      delete globalScope.Zotero;
    } else {
      globalScope.Zotero = originalZotero;
    }
  });

  it("extracts a standalone paper source label from a citation line", function () {
    const extracted = extractStandalonePaperSourceLabel(
      " (Smith et al., 2024) ",
    );

    assert.deepInclude(extracted, {
      sourceLabel: "(Smith et al., 2024)",
      citationLabel: "Smith et al., 2024",
    });
  });

  it("normalizes leading cue text in inline citations for matching", function () {
    const mentions = extractInlineCitationMentions(
      "These systems can interact (as in Kossio et al) under drift.",
    );

    assert.lengthOf(mentions, 1);
    assert.equal(
      mentions[0]?.extractedCitation.displayCitationLabel,
      "as in Kossio et al",
    );
    assert.equal(mentions[0]?.extractedCitation.citationLabel, "Kossio et al");
  });

  it("rejects non-standalone citation lines", function () {
    assert.isNull(
      extractStandalonePaperSourceLabel(
        "According to (Smith et al., 2024), the effect was strong.",
      ),
    );
  });

  it("matches citation lines to the corresponding paper context", function () {
    const papers: PaperContextRef[] = [
      {
        itemId: 1,
        contextItemId: 11,
        title: "Paper A",
        firstCreator: "Smith et al.",
        year: "2024",
      },
      {
        itemId: 2,
        contextItemId: 22,
        title: "Paper B",
        firstCreator: "Lee et al.",
        year: "2025",
      },
    ];

    const matches = matchAssistantCitationCandidates(
      "(Lee et al., 2025)",
      papers,
    );

    assert.lengthOf(matches, 1);
    assert.equal(matches[0].contextItemId, 22);
    assert.equal(matches[0].paperContext.title, "Paper B");
  });

  it("collects citation candidates from full-text and hidden citation contexts", function () {
    const fullTextOnly: PaperContextRef = {
      itemId: 10,
      contextItemId: 110,
      title: "Full Text Only",
      firstCreator: "Garcia",
      year: "2024",
    };
    const hiddenCitationOnly: PaperContextRef = {
      itemId: 20,
      contextItemId: 220,
      title: "Hidden Citation Only",
      firstCreator: "Patel",
      year: "2025",
    };
    const candidates = collectAssistantCitationCandidates(
      {
        __llmGlobalPortalItem: true,
        id: 2_000_000_001,
        libraryID: 1,
      } as never,
      {
        role: "user",
        text: "Compare these.",
        timestamp: 1,
        fullTextPaperContexts: [fullTextOnly],
        citationPaperContexts: [hiddenCitationOnly],
      },
    );

    assert.sameMembers(
      candidates.map((entry) => entry.contextItemId),
      [110, 220],
    );
    assert.sameMembers(
      candidates.map((entry) => entry.sourceLabel),
      ["(Garcia, 2024)", "(Patel, 2025)"],
    );
  });

  it("keeps explicit paired-message attachment context authoritative for multi-PDF parents", function () {
    installZoteroItems({
      3369: makeZoteroItem({
        id: 3369,
        kind: "regular",
        fields: {
          title: "Directional dynamics in the entorhinal cortex",
          firstCreator: "Liu et al.",
          year: "2026",
        },
        attachmentIDs: [3370, 3373],
      }),
      3370: makeZoteroItem({
        id: 3370,
        kind: "attachment",
        parentID: 3369,
        fields: { title: "PDF" },
        attachmentFilename: "main.pdf",
        attachmentContentType: "application/pdf",
      }),
      3373: makeZoteroItem({
        id: 3373,
        kind: "attachment",
        parentID: 3369,
        fields: { title: "Supplementary PDF" },
        attachmentFilename: "supplement.pdf",
        attachmentContentType: "application/pdf",
      }),
    });

    const candidates = collectAssistantCitationCandidates(
      makeZoteroItem({
        id: 3369,
        kind: "regular",
        attachmentIDs: [3370, 3373],
      }),
      {
        role: "user",
        text: "Use the supplementary file.",
        timestamp: 1,
        paperContexts: [
          {
            itemId: 3369,
            contextItemId: 3373,
            title: "Directional dynamics in the entorhinal cortex",
            firstCreator: "Liu et al.",
            year: "2026",
            attachmentTitle: "Supplementary PDF",
          },
        ],
      },
    );

    assert.deepEqual(
      candidates.map((candidate) => candidate.contextItemId),
      [3373],
    );
  });

  it("classifies only PDF-backed citation candidates as page-locatable", function () {
    installZoteroItems({
      11: makeZoteroItem({
        id: 11,
        kind: "attachment",
        parentID: 1,
        attachmentFilename: "paper.pdf",
        attachmentContentType: "application/pdf",
      }),
      22: makeZoteroItem({
        id: 22,
        kind: "attachment",
        parentID: 2,
        attachmentFilename: "test.md",
        attachmentContentType: "text/markdown",
      }),
    });
    const pdfContext: PaperContextRef = {
      itemId: 1,
      contextItemId: 11,
      title: "PDF paper",
    };
    const markdownContext: PaperContextRef = {
      itemId: 2,
      contextItemId: 22,
      title: "Markdown paper",
      attachmentTitle: "test",
      contentSourceMode: "markdown",
    };
    const makeCandidate = (paperContext: PaperContextRef) => ({
      paperContext,
      displayPaperContext: paperContext,
      contextItemId: paperContext.contextItemId,
      sourceLabel: "(Paper)",
      citationLabel: "Paper",
      displaySourceLabel: "(Paper)",
      displayCitationLabel: "Paper",
      normalizedSourceLabel: "paper",
      normalizedCitationLabel: "paper",
      normalizedDisplaySourceLabel: "paper",
      normalizedDisplayCitationLabel: "paper",
    });

    assert.isTrue(
      isPdfBackedCitationCandidateForTests(makeCandidate(pdfContext)),
    );
    assert.isFalse(
      isPdfBackedCitationCandidateForTests(makeCandidate(markdownContext)),
    );
    assert.isFalse(
      isPdfBackedCitationCandidateForTests(
        makeCandidate({
          itemId: 2,
          contextItemId: 22,
          title: "Missing mode markdown",
        }),
      ),
    );
  });

  it("stops PDF fallback when the top static citation candidate is text-backed", function () {
    installZoteroItems({
      11: makeZoteroItem({
        id: 11,
        kind: "attachment",
        parentID: 1,
        attachmentFilename: "paper.pdf",
        attachmentContentType: "application/pdf",
      }),
      22: makeZoteroItem({
        id: 22,
        kind: "attachment",
        parentID: 2,
        attachmentFilename: "test.md",
        attachmentContentType: "text/markdown",
      }),
    });
    const markdownCandidate = makeCitationCandidate({
      itemId: 2,
      contextItemId: 22,
      title: "Markdown paper",
      firstCreator: "Smith",
      year: "2024",
      attachmentTitle: "test.md",
      contentSourceMode: "markdown",
    });
    const pdfCandidate = makeCitationCandidate({
      itemId: 1,
      contextItemId: 11,
      title: "PDF paper",
      firstCreator: "Jones",
      year: "2023",
    });
    const extracted = extractStandalonePaperSourceLabel("(Smith, 2024)");

    assert.equal(
      resolveAuthoritativeNonPdfCitationCandidateForTests({
        orderedCandidates: [markdownCandidate, pdfCandidate],
        staticCandidates: [markdownCandidate],
        extractedCitation: extracted,
      }),
      markdownCandidate,
    );
  });

  it("keeps PDF citation candidates eligible for page navigation", function () {
    installZoteroItems({
      11: makeZoteroItem({
        id: 11,
        kind: "attachment",
        parentID: 1,
        attachmentFilename: "paper.pdf",
        attachmentContentType: "application/pdf",
      }),
      22: makeZoteroItem({
        id: 22,
        kind: "attachment",
        parentID: 2,
        attachmentFilename: "test.md",
        attachmentContentType: "text/markdown",
      }),
    });
    const pdfCandidate = makeCitationCandidate({
      itemId: 1,
      contextItemId: 11,
      title: "PDF paper",
      firstCreator: "Smith",
      year: "2024",
    });
    const markdownCandidate = makeCitationCandidate({
      itemId: 2,
      contextItemId: 22,
      title: "Markdown paper",
      firstCreator: "Jones",
      year: "2023",
      attachmentTitle: "test.md",
      contentSourceMode: "markdown",
    });
    const extracted = extractStandalonePaperSourceLabel("(Smith, 2024)");

    assert.isNull(
      resolveAuthoritativeNonPdfCitationCandidateForTests({
        orderedCandidates: [pdfCandidate, markdownCandidate],
        staticCandidates: [pdfCandidate],
        extractedCitation: extracted,
      }),
    );
  });

  it("allows fallback when the top text-backed candidate is neither static nor ranked", function () {
    installZoteroItems({
      11: makeZoteroItem({
        id: 11,
        kind: "attachment",
        parentID: 1,
        attachmentFilename: "paper.pdf",
        attachmentContentType: "application/pdf",
      }),
      22: makeZoteroItem({
        id: 22,
        kind: "attachment",
        parentID: 2,
        attachmentFilename: "test.md",
        attachmentContentType: "text/markdown",
      }),
    });
    const markdownCandidate = makeCitationCandidate({
      itemId: 2,
      contextItemId: 22,
      title: "Markdown paper",
      firstCreator: "Smith",
      year: "2024",
      attachmentTitle: "test.md",
      contentSourceMode: "markdown",
    });
    const pdfCandidate = makeCitationCandidate({
      itemId: 1,
      contextItemId: 11,
      title: "PDF paper",
      firstCreator: "Jones",
      year: "2023",
    });
    const extracted = extractStandalonePaperSourceLabel("(Garcia, 2026)");

    assert.isNull(
      resolveAuthoritativeNonPdfCitationCandidateForTests({
        orderedCandidates: [markdownCandidate, pdfCandidate],
        staticCandidates: [],
        extractedCitation: extracted,
      }),
    );
  });

  it("preserves ambiguous matches when two papers share the same citation label", function () {
    const papers: PaperContextRef[] = [
      {
        itemId: 1,
        contextItemId: 11,
        title: "Paper A",
        firstCreator: "Smith et al.",
        year: "2024",
      },
      {
        itemId: 2,
        contextItemId: 22,
        title: "Paper B",
        firstCreator: "Smith et al.",
        year: "2024",
      },
    ];

    const matches = matchAssistantCitationCandidates(
      "(Smith et al., 2024)",
      papers,
    );

    assert.lengthOf(matches, 2);
    assert.sameMembers(
      matches.map((entry) => entry.contextItemId),
      [11, 22],
    );
  });

  it("resolves uniquely when citation labels include citationKey disambiguators", function () {
    const papers: PaperContextRef[] = [
      {
        itemId: 1,
        contextItemId: 11,
        title: "Paper A",
        firstCreator: "Smith et al.",
        year: "2024",
        citationKey: "smith2024a",
      },
      {
        itemId: 2,
        contextItemId: 22,
        title: "Paper B",
        firstCreator: "Smith et al.",
        year: "2024",
        citationKey: "smith2024b",
      },
    ];

    const matches = matchAssistantCitationCandidates(
      "(Smith et al., 2024 [smith2024b])",
      papers,
    );

    assert.lengthOf(matches, 1);
    assert.equal(matches[0].contextItemId, 22);
  });

  it("matches stored no-year citations after live metadata adds a year", function () {
    installLivePaperContext({
      itemId: 1,
      contextItemId: 11,
      title: "Information theoretic analysis of neural drift",
      firstCreator: "Heiney et al.",
      year: "2026",
      citationKey: "heiney2026drift",
    });
    const papers: PaperContextRef[] = [
      {
        itemId: 1,
        contextItemId: 11,
        title: "Information theoretic...",
        firstCreator: "Heiney et al.",
      },
    ];

    const matches = matchAssistantCitationCandidates("(Heiney et al)", papers);

    assert.lengthOf(matches, 1);
    assert.equal(matches[0].contextItemId, 11);
    assert.equal(matches[0].citationLabel, "Heiney et al.");
    assert.equal(matches[0].displayCitationLabel, "Heiney et al., 2026");
    assert.equal(
      matches[0].displayPaperContext.title,
      "Information theoretic analysis of neural drift",
    );
  });

  it("matches stale snapshot years while displaying the live corrected year", function () {
    installLivePaperContext({
      itemId: 1,
      contextItemId: 11,
      title: "Information theoretic analysis of neural drift",
      firstCreator: "Heiney et al.",
      year: "2026",
    });
    const papers: PaperContextRef[] = [
      {
        itemId: 1,
        contextItemId: 11,
        title: "Information theoretic...",
        firstCreator: "Heiney et al.",
        year: "2025",
      },
    ];

    const matches = matchAssistantCitationCandidates(
      "(Heiney et al., 2025)",
      papers,
    );

    assert.lengthOf(matches, 1);
    assert.equal(matches[0].citationLabel, "Heiney et al., 2025");
    assert.equal(matches[0].displayCitationLabel, "Heiney et al., 2026");
  });

  it("matches citation keys from stored and live metadata", function () {
    installLivePaperContext({
      itemId: 1,
      contextItemId: 11,
      title: "Information theoretic analysis of neural drift",
      firstCreator: "Heiney et al.",
      year: "2026",
      citationKey: "live-heiney-2026",
    });
    const papers: PaperContextRef[] = [
      {
        itemId: 1,
        contextItemId: 11,
        title: "Information theoretic...",
        firstCreator: "Heiney et al.",
        year: "2025",
        citationKey: "stored-heiney-2025",
      },
    ];

    const storedKeyMatches = matchAssistantCitationCandidates(
      "(Heiney et al., 2025 [stored-heiney-2025])",
      papers,
    );
    const liveKeyMatches = matchAssistantCitationCandidates(
      "(Heiney et al., 2026 [live-heiney-2026])",
      papers,
    );

    assert.lengthOf(storedKeyMatches, 1);
    assert.lengthOf(liveKeyMatches, 1);
    assert.equal(storedKeyMatches[0].contextItemId, 11);
    assert.equal(liveKeyMatches[0].contextItemId, 11);
    assert.equal(liveKeyMatches[0].displayCitationLabel, "Heiney et al., 2026");
  });

  it("keeps stored fallback labels matchable after live metadata is added", function () {
    installLivePaperContext({
      itemId: 1,
      contextItemId: 11,
      title: "Information theoretic analysis of neural drift",
      firstCreator: "Heiney et al.",
      year: "2026",
    });
    const papers: PaperContextRef[] = [
      {
        itemId: 1,
        contextItemId: 11,
        title: "Untitled",
      },
    ];

    const matches = matchAssistantCitationCandidates("(Paper 1)", papers);

    assert.lengthOf(matches, 1);
    assert.equal(matches[0].citationLabel, "Paper 1");
    assert.equal(matches[0].displayCitationLabel, "Heiney et al., 2026");
  });

  it("parses citation rows with external citationKey and page suffix", function () {
    const papers: PaperContextRef[] = [
      {
        itemId: 1,
        contextItemId: 11,
        title: "Paper A",
        firstCreator: "Smith et al.",
        year: "2024",
        citationKey: "smith2024a",
      },
      {
        itemId: 2,
        contextItemId: 22,
        title: "Paper B",
        firstCreator: "Smith et al.",
        year: "2024",
        citationKey: "smith2024b",
      },
    ];

    const matches = matchAssistantCitationCandidates(
      "(Smith et al., 2024) [smith2024b], page 1",
      papers,
    );

    assert.lengthOf(matches, 1);
    assert.equal(matches[0].contextItemId, 22);
  });

  it("keeps parsed page labels out of initial citation display text", function () {
    const extracted = extractStandalonePaperSourceLabel(
      "(Chandra et al., 2025, page 11)",
    );

    assert.equal(extracted?.pageLabel, "11");
    assert.equal(
      formatUnverifiedCitationChipLabel(extracted?.displayCitationLabel || ""),
      "Chandra et al., 2025",
    );
    assert.notInclude(
      formatUnverifiedCitationChipLabel(extracted?.displayCitationLabel || ""),
      "page 11",
    );
  });

  it("rejects section labels as standalone paper source labels", function () {
    for (const label of [
      "(Abstract)",
      "(Method)",
      "(Methods)",
      '(Methods, "Defining manifold components")',
      "(Results)",
      "(Discussion)",
      "(Supplementary Table 1)",
      "(Supplementary Fig. 2)",
      "(Table 1)",
      "(Figure 3)",
    ]) {
      assert.isNull(extractStandalonePaperSourceLabel(label), label);
      assert.isNull(extractBlockquoteTailCitation(`Quoted passage.\n${label}`));
    }
  });

  it("strips unverified page suffixes from raw inline citation labels", function () {
    assert.equal(
      formatUnverifiedCitationChipLabel("(Chandra et al., 2025, page 11)"),
      "(Chandra et al., 2025)",
    );
  });

  it("skips already-decorated citation UI during inline decoration", function () {
    for (const selector of [
      ".llm-citation-row-container",
      ".llm-citation-row",
      ".llm-citation-inline-wrap",
      ".llm-citation-text",
      ".llm-citation-icon",
      ".llm-quote-card",
    ]) {
      assert.include(INLINE_CITATION_SKIP_SELECTOR, selector);
    }
  });

  it("does not render source-less fallback quote cards for unresolved blockquotes", function () {
    const source = readFileSync(
      resolve(testDir, "../src/modules/contextPanel/assistantCitationLinks.ts"),
      "utf8",
    );
    const decorationLoopStart = source.indexOf(
      "LLM citation decoration: blockquotes found =",
    );
    const unresolvedBranchStart = source.indexOf(
      "if (!extractedCitation) {",
      decorationLoopStart,
    );
    const resolvedBranchStart = source.indexOf(
      "LLM citation decoration: citation parsed but no target element available",
      unresolvedBranchStart,
    );
    const unresolvedBranch = source.slice(
      unresolvedBranchStart,
      resolvedBranchStart,
    );

    assert.isAtLeast(decorationLoopStart, 0);
    assert.isAtLeast(unresolvedBranchStart, 0);
    assert.isAbove(resolvedBranchStart, unresolvedBranchStart);
    assert.notInclude(
      unresolvedBranch,
      "replaceBlockquoteWithFallbackQuoteCard",
    );
  });

  it("matches author-only citations with cue text to the correct paper", function () {
    const papers: PaperContextRef[] = [
      {
        itemId: 1,
        contextItemId: 11,
        title: "Paper Zhang",
        firstCreator: "Zhang",
        year: "2024",
      },
      {
        itemId: 2,
        contextItemId: 22,
        title: "Paper Kossio",
        firstCreator: "Kossio",
        year: "2023",
      },
    ];

    const matches = matchAssistantCitationCandidates(
      "(as in Kossio et al)",
      papers,
    );

    assert.lengthOf(matches, 1);
    assert.equal(matches[0].contextItemId, 22);
  });

  it("extracts a trailing citation line embedded in a blockquote", function () {
    const extracted = extractBlockquoteTailCitation(
      '"Therefore, representational drift is stable across days."\n(Climer et al., 2025)',
    );

    assert.isNotNull(extracted);
    assert.equal(
      extracted?.quoteText,
      '"Therefore, representational drift is stable across days."',
    );
    assert.equal(
      extracted?.extractedCitation.sourceLabel,
      "(Climer et al., 2025)",
    );
  });

  it("keeps raw math markdown when extracting source blockquotes for citation decoration", function () {
    const rawMessage = [
      "The reference signal comes from a parallel, stable pathway:",
      "",
      "> Recall that the readout weights w are proportional to $\\mathbf{y}_{*0}$ through Hebbian plasticity,",
      "> meaning that the readout responses can be rewritten as $z_{st} = \\mathbf{y}_{*t}^\\top \\mathbf{y}_{st}$.",
      ">",
      "> (Zaid & Schaffer, 2026, page 7)",
      "",
      "This is elegant.",
    ].join("\n");

    const blockquotes =
      extractMarkdownBlockquoteTextsForCitationDecoration(rawMessage);

    assert.lengthOf(blockquotes, 1);
    assert.include(blockquotes[0], "$\\mathbf{y}_{*0}$");
    assert.include(blockquotes[0], "$z_{st} = \\mathbf{y}_{*t}^\\top");

    const extracted = extractBlockquoteTailCitation(blockquotes[0]);
    assert.isNotNull(extracted);
    assert.equal(
      extracted?.quoteText,
      "Recall that the readout weights w are proportional to $\\mathbf{y}_{*0}$ through Hebbian plasticity, meaning that the readout responses can be rewritten as $z_{st} = \\mathbf{y}_{*t}^\\top \\mathbf{y}_{st}$.",
    );
    assert.equal(
      extracted?.extractedCitation.sourceLabel,
      "(Zaid & Schaffer, 2026)",
    );
    assert.equal(extracted?.extractedCitation.pageLabel, "7");
  });

  it("ignores fenced code blockquote examples when extracting source blockquotes", function () {
    const rawMessage = [
      "Use this Markdown shape when quoting:",
      "",
      "```markdown",
      "> quoted text from the paper",
      ">",
      "> (Author, 2026)",
      "```",
      "",
      "The actual evidence is:",
      "",
      "> Drift was balanced by Hebbian plasticity in the model.",
      ">",
      "> (Eppler et al., 2026, page 1)",
    ].join("\n");

    const blockquotes =
      extractMarkdownBlockquoteTextsForCitationDecoration(rawMessage);

    assert.deepEqual(blockquotes, [
      "Drift was balanced by Hebbian plasticity in the model.\n\n(Eppler et al., 2026, page 1)",
    ]);
  });

  it("uses the shared citation separator helper", function () {
    assert.equal(
      stripLeadingCitationSeparators("; with an explanatory continuation."),
      "with an explanatory continuation.",
    );
  });

  it("extracts a trailing inline citation from blockquote text", function () {
    const extracted = extractBlockquoteTailCitation(
      "Therefore, representational drift is stable across days. (Climer et al., 2025)",
    );

    assert.isNotNull(extracted);
    assert.equal(
      extracted?.quoteText,
      "Therefore, representational drift is stable across days.",
    );
    assert.equal(
      extracted?.extractedCitation.citationLabel,
      "Climer et al., 2025",
    );
  });

  it("does not treat equation-style parentheses as citations in blockquotes", function () {
    const extracted = extractBlockquoteTailCitation(
      "The score can be written as (a + b + c).",
    );

    assert.isNull(extracted);
  });

  it("extracts inline parenthetical citations from regular text", function () {
    const mentions = extractInlineCitationMentions(
      "In episodic memory (Kulkarni et al., 2024), drift is gradual.",
    );

    assert.lengthOf(mentions, 1);
    assert.equal(mentions[0]?.rawText, "(Kulkarni et al., 2024)");
    assert.equal(
      mentions[0]?.extractedCitation.citationLabel,
      "Kulkarni et al., 2024",
    );
  });

  it("keeps standalone citation-only text out of chat inline decoration", function () {
    const source = readFileSync(
      resolve(testDir, "../src/modules/contextPanel/assistantCitationLinks.ts"),
      "utf8",
    );
    const start = source.indexOf("function decorateInlineCitationNodes");
    const end = source.indexOf(
      "function replaceBlockquoteWithFallbackQuoteCard",
    );
    const decorationSection = source.slice(start, end);

    assert.isAtLeast(start, 0);
    assert.isAbove(end, start);
    assert.include(
      decorationSection,
      "if (extractStandalonePaperSourceLabel(trimmedText)) return;",
    );
  });

  it("still extracts inline parenthetical citations embedded in prose", function () {
    const mentions = extractInlineCitationMentions(
      "The framework links neural dysfunction to cognition (Anticevic et al., 2013).",
    );

    assert.lengthOf(mentions, 1);
    assert.equal(mentions[0]?.rawText, "(Anticevic et al., 2013)");
    assert.equal(
      mentions[0]?.extractedCitation.citationLabel,
      "Anticevic et al., 2013",
    );
  });

  it("extracts yearless dual-author parenthetical citations", function () {
    const mentions = extractInlineCitationMentions(
      "Drift is ubiquitous but modulated by circuit architecture (Marks & Goard).",
    );

    assert.lengthOf(mentions, 1);
    assert.equal(mentions[0]?.rawText, "(Marks & Goard)");
    assert.equal(mentions[0]?.extractedCitation.citationLabel, "Marks & Goard");
  });

  it("splits semicolon-grouped inline citations into separate mentions", function () {
    const mentions = extractInlineCitationMentions(
      "Drift spans regions (e.g., Ziv et al., 2013; Deitch et al., 2021).",
    );

    assert.lengthOf(mentions, 2);
    assert.equal(mentions[0]?.rawText, "Ziv et al., 2013");
    assert.equal(mentions[1]?.rawText, "Deitch et al., 2021");
    assert.equal(
      mentions[0]?.extractedCitation.citationLabel,
      "Ziv et al., 2013",
    );
    assert.equal(
      mentions[1]?.extractedCitation.citationLabel,
      "Deitch et al., 2021",
    );
  });

  it("keeps citationKey disambiguators when grouped citations share the same label", function () {
    const mentions = extractInlineCitationMentions(
      "Prior work (Smith et al., 2024 [smith2024a]; Smith et al., 2024 [smith2024b]) reports inconsistent outcomes.",
    );

    assert.lengthOf(mentions, 2);
    assert.equal(mentions[0]?.extractedCitation.citationKey, "smith2024a");
    assert.equal(mentions[1]?.extractedCitation.citationKey, "smith2024b");
  });

  it("does not collapse malformed grouped citations into a single broad link", function () {
    const mentions = extractInlineCitationMentions(
      "The evidence is mixed (e.g., Smith et al., 2024; malformed citation).",
    );

    assert.lengthOf(mentions, 1);
    assert.equal(mentions[0]?.rawText, "Smith et al., 2024");
    assert.equal(
      mentions[0]?.extractedCitation.citationLabel,
      "Smith et al., 2024",
    );
  });

  it("extracts narrative citations like 'Author et al. (Year)' as one mention", function () {
    const mentions = extractInlineCitationMentions(
      "Based on Climer et al. (2025), mice were exposed to different odor stimuli.",
    );

    assert.lengthOf(mentions, 1);
    assert.equal(mentions[0]?.rawText, "Climer et al. (2025)");
    assert.equal(
      mentions[0]?.extractedCitation.citationLabel,
      "Climer et al., 2025",
    );
  });

  it("extracts narrative citations with two authors joined by '&'", function () {
    const mentions = extractInlineCitationMentions(
      "In contrast, Marks & Goard (2021) showed that drift rate depends on the stimulus.",
    );

    assert.lengthOf(mentions, 1);
    assert.equal(mentions[0]?.rawText, "Marks & Goard (2021)");
    assert.equal(
      mentions[0]?.extractedCitation.citationLabel,
      "Marks & Goard, 2021",
    );
  });

  it("extracts narrative citations with two authors joined by 'and'", function () {
    const mentions = extractInlineCitationMentions(
      "According to Smith and Jones (2024), the results were significant.",
    );

    assert.lengthOf(mentions, 1);
    assert.equal(mentions[0]?.rawText, "Smith and Jones (2024)");
    assert.equal(
      mentions[0]?.extractedCitation.citationLabel,
      "Smith and Jones, 2024",
    );
  });

  it("extracts narrative citations when 'et al' omits the trailing period", function () {
    const mentions = extractInlineCitationMentions(
      "Based on Climer et al (2025), mice were exposed to different odor stimuli.",
    );

    assert.lengthOf(mentions, 1);
    assert.equal(
      mentions[0]?.extractedCitation.citationLabel,
      "Climer et al, 2025",
    );
  });

  it("extracts narrative citations with Unicode direction markers around author names", function () {
    const mentions = extractInlineCitationMentions(
      "Based on \u2068Climer\u2069 et al. (2025), mice were exposed to different odor stimuli.",
    );

    assert.lengthOf(mentions, 1);
    assert.equal(
      mentions[0]?.extractedCitation.citationLabel,
      "Climer et al., 2025",
    );
  });

  it("extracts narrative citations like 'Author et al., Year'", function () {
    const mentions = extractInlineCitationMentions(
      "As reported by Climer et al., 2025, drift stayed stable.",
    );

    assert.lengthOf(mentions, 1);
    assert.equal(mentions[0]?.rawText, "Climer et al., 2025");
    assert.equal(
      mentions[0]?.extractedCitation.citationLabel,
      "Climer et al., 2025",
    );
  });

  it("ignores equation-like inline parentheses", function () {
    const mentions = extractInlineCitationMentions(
      "The score is computed as (a + b + c) under this setting.",
    );
    assert.lengthOf(mentions, 0);
  });

  it("ignores year-only parenthetical mentions without an author anchor", function () {
    const mentions = extractInlineCitationMentions(
      "The year (2025) was notable for several labs.",
    );
    assert.lengthOf(mentions, 0);
  });

  it("does not fuzzy-match by author surname alone when year differs", function () {
    const papers: PaperContextRef[] = [
      {
        itemId: 1,
        contextItemId: 11,
        title: "Paper A",
        firstCreator: "Lee et al.",
        year: "2020",
      },
    ];

    const matches = matchAssistantCitationCandidates(
      "(Lee et al., 2018)",
      papers,
    );

    assert.lengthOf(matches, 0);
  });

  it("does not return the single candidate when citation label does not match", function () {
    installLivePaperContext({
      itemId: 1,
      contextItemId: 11,
      title: "Information theoretic analysis of neural drift",
      firstCreator: "Heiney et al.",
      year: "2026",
    });
    const papers: PaperContextRef[] = [
      {
        itemId: 1,
        contextItemId: 11,
        title: "Paper A",
        firstCreator: "Smith et al.",
        year: "2024",
      },
    ];

    const matches = matchAssistantCitationCandidates(
      "(Jones et al., 2022)",
      papers,
    );

    assert.lengthOf(matches, 0);
  });

  it("does not auto-navigate ambiguous author-only citation candidates", function () {
    const extracted = extractStandalonePaperSourceLabel("(Smith et al.)");
    const candidates = [
      makeCitationCandidate({
        itemId: 1,
        contextItemId: 11,
        title: "Paper A",
        firstCreator: "Smith et al.",
        year: "2020",
      }),
      makeCitationCandidate({
        itemId: 2,
        contextItemId: 22,
        title: "Paper B",
        firstCreator: "Smith et al.",
        year: "2021",
      }),
    ];

    const autoNavigable = resolveAutoNavigableCitationCandidatesForTests({
      extractedCitation: extracted,
      orderedCandidates: candidates,
      staticCandidates: candidates,
    });

    assert.lengthOf(autoNavigable, 0);
  });

  it("auto-navigates high-confidence author and year matches", function () {
    const extracted = extractStandalonePaperSourceLabel("(Smith et al., 2021)");
    const candidates = [
      makeCitationCandidate({
        itemId: 1,
        contextItemId: 11,
        title: "Paper A",
        firstCreator: "Smith et al.",
        year: "2020",
      }),
      makeCitationCandidate({
        itemId: 2,
        contextItemId: 22,
        title: "Paper B",
        firstCreator: "Smith et al.",
        year: "2021",
      }),
    ];

    const autoNavigable = resolveAutoNavigableCitationCandidatesForTests({
      extractedCitation: extracted,
      orderedCandidates: candidates,
      staticCandidates: candidates,
    });

    assert.lengthOf(autoNavigable, 1);
    assert.equal(autoNavigable[0].contextItemId, 22);
  });

  it("does not auto-navigate same-parent multi-PDF citation-label matches without attachment evidence", function () {
    const extracted = extractStandalonePaperSourceLabel("(Liu et al., 2026)");
    const candidates = [
      makeCitationCandidate({
        itemId: 3369,
        contextItemId: 3370,
        title: "Directional dynamics in the entorhinal cortex",
        firstCreator: "Liu et al.",
        year: "2026",
        attachmentTitle: "PDF",
      }),
      makeCitationCandidate({
        itemId: 3369,
        contextItemId: 3373,
        title: "Directional dynamics in the entorhinal cortex",
        firstCreator: "Liu et al.",
        year: "2026",
        attachmentTitle: "Supplementary PDF",
      }),
    ];

    const autoNavigable = resolveAutoNavigableCitationCandidatesForTests({
      extractedCitation: extracted,
      orderedCandidates: candidates,
      staticCandidates: candidates,
    });

    assert.lengthOf(autoNavigable, 0);
  });

  it("uses trusted quote contextItemId instead of same-parent PDF candidates", function () {
    installZoteroItems({
      3369: makeZoteroItem({
        id: 3369,
        kind: "regular",
        fields: {
          title: "Directional dynamics in the entorhinal cortex",
          firstCreator: "Liu et al.",
          year: "2026",
        },
        attachmentIDs: [3370, 3373],
      }),
      3370: makeZoteroItem({
        id: 3370,
        kind: "attachment",
        parentID: 3369,
        fields: { title: "PDF" },
        attachmentFilename: "main.pdf",
        attachmentContentType: "application/pdf",
      }),
      3373: makeZoteroItem({
        id: 3373,
        kind: "attachment",
        parentID: 3369,
        fields: { title: "Supplementary PDF" },
        attachmentFilename: "supplement.pdf",
        attachmentContentType: "application/pdf",
      }),
    });
    const resolver = (
      citationLinks as unknown as {
        resolveQuoteCitationCandidatesForTests?: (
          citation: unknown,
          extractedCitation: ReturnType<
            typeof extractStandalonePaperSourceLabel
          >,
          candidates: AssistantCitationPaperCandidate[],
        ) => AssistantCitationPaperCandidate[];
      }
    ).resolveQuoteCitationCandidatesForTests;

    assert.isFunction(resolver);
    const matches = resolver!(
      {
        id: "Q_main",
        quoteText: "Main paper quote text.",
        citationLabel: "(Liu et al., 2026)",
        contextItemId: 3370,
        itemId: 3369,
      },
      extractStandalonePaperSourceLabel("(Liu et al., 2026)"),
      [
        makeCitationCandidate({
          itemId: 3369,
          contextItemId: 3373,
          title: "Directional dynamics in the entorhinal cortex",
          firstCreator: "Liu et al.",
          year: "2026",
          attachmentTitle: "Supplementary PDF",
        }),
      ],
    );

    assert.deepEqual(
      matches.map((candidate) => candidate.contextItemId),
      [3370],
    );
  });

  it("uses citation key matches exclusively over author and year lookalikes", function () {
    const extracted = extractStandalonePaperSourceLabel(
      "(Jones et al., 2022 [smith2024])",
    );
    const keyedCandidate = makeCitationCandidate({
      itemId: 1,
      contextItemId: 11,
      title: "Keyed paper",
      firstCreator: "Smith et al.",
      year: "2024",
      citationKey: "smith2024",
    });
    const authorYearCandidate = makeCitationCandidate({
      itemId: 2,
      contextItemId: 22,
      title: "Lookalike paper",
      firstCreator: "Jones et al.",
      year: "2022",
    });

    const autoNavigable = resolveAutoNavigableCitationCandidatesForTests({
      extractedCitation: extracted,
      orderedCandidates: [authorYearCandidate, keyedCandidate],
      staticCandidates: [authorYearCandidate],
    });

    assert.lengthOf(autoNavigable, 1);
    assert.equal(autoNavigable[0], keyedCandidate);
  });

  it("allows one medium-confidence static author match", function () {
    const extracted = extractStandalonePaperSourceLabel("(Heiney et al.)");
    const staticCandidate = makeCitationCandidate({
      itemId: 1,
      contextItemId: 11,
      title: "Explicit context",
      firstCreator: "Heiney et al.",
    });
    const libraryCandidate = makeCitationCandidate({
      itemId: 2,
      contextItemId: 22,
      title: "Weak library result",
      firstCreator: "Heiney et al.",
      year: "2026",
    });

    const autoNavigable = resolveAutoNavigableCitationCandidatesForTests({
      extractedCitation: extracted,
      orderedCandidates: [libraryCandidate, staticCandidate],
      staticCandidates: [staticCandidate],
    });

    assert.lengthOf(autoNavigable, 1);
    assert.equal(autoNavigable[0], staticCandidate);
  });

  it("does not let weak library candidates beat explicit context", function () {
    const extracted = extractStandalonePaperSourceLabel("(Garcia et al.)");
    const staticCandidate = makeCitationCandidate({
      itemId: 1,
      contextItemId: 11,
      title: "Explicit context",
      firstCreator: "Garcia et al.",
    });
    const libraryCandidate = makeCitationCandidate({
      itemId: 2,
      contextItemId: 22,
      title: "Library result",
      firstCreator: "Garcia et al.",
      year: "2026",
    });

    const autoNavigable = resolveAutoNavigableCitationCandidatesForTests({
      extractedCitation: extracted,
      orderedCandidates: [libraryCandidate, staticCandidate],
      staticCandidates: [staticCandidate],
    });

    assert.lengthOf(autoNavigable, 1);
    assert.equal(autoNavigable[0], staticCandidate);
  });

  describe("citation page cache", function () {
    afterEach(function () {
      clearCachedCitationPagesForTests();
    });

    it("stores and returns verified page labels by attachment and quote text", function () {
      const quote =
        "We choose Hebbian learning, not only for its biological plausibility, but to also allow rapid learning when entering a new environment.";
      const pageLabel = rememberCachedCitationPage(23, quote, 22, "23");

      assert.equal(pageLabel, "23");
      assert.equal(lookupCachedCitationPage(23, quote), "23");
    });

    it("does not store entries for empty quotes", function () {
      const pageLabel = rememberCachedCitationPage(23, "   ", 22, "23");

      assert.isNull(pageLabel);
      assert.isNull(lookupCachedCitationPage(23, ""));
    });

    it("does not synthesize verified page labels from page indexes", function () {
      const quote =
        "Only reader-confirmed page labels should enter the citation cache.";
      const pageLabel = rememberCachedCitationPage(23, quote, 10);

      assert.isNull(pageLabel);
      assert.isNull(lookupCachedCitationPage(23, quote));
    });

    it("looks up verified page labels by the button's own context ids", function () {
      const quote =
        "The same quoted sentence can appear in two PDFs with different printed page labels.";
      rememberCachedCitationPage(11, quote, 2, "A-3");
      rememberCachedCitationPage(22, quote, 7, "B-8");

      assert.equal(
        lookupCachedCitationPageForContextIdsForTests("11", quote),
        "A-3",
      );
      assert.equal(
        lookupCachedCitationPageForContextIdsForTests("22", quote),
        "B-8",
      );
      assert.isNull(lookupCachedCitationPageForContextIdsForTests("", quote));
    });

    it("normalizes stored quote citation page hints as non-authoritative hints", function () {
      assert.deepEqual(
        resolveQuoteCitationPageHintForTests({
          id: "Q_hint",
          quoteText:
            "Stored page hints should speed up first paint without becoming proof that the quote is absent elsewhere.",
          citationLabel: "(Hint et al., 2026)",
          contextItemId: 11,
          pageHintIndex: 4.9,
          pageHintLabel: " v ",
        }),
        { pageIndex: 4, pageLabel: "v" },
      );
      assert.deepEqual(
        resolveQuoteCitationPageHintForTests({
          id: "Q_hint_label",
          quoteText:
            "Printed page labels may be the only available location metadata for an extracted quote.",
          citationLabel: "(Hint et al., 2026)",
          contextItemId: 11,
          pageHintLabel: " 12 ",
        }),
        { pageLabel: "12" },
      );
      assert.isNull(
        resolveQuoteCitationPageHintForTests({
          id: "Q_bad_hint",
          quoteText:
            "Invalid stored page hints must not change citation navigation behavior.",
          citationLabel: "(Hint et al., 2026)",
          contextItemId: 11,
          pageHintIndex: -1,
          pageHintLabel: " ",
        }),
      );
    });

    it("uses the full source quote for lookup when sourceMatchText is only a terminal locator", function () {
      const quoteText = [
        "## 3 Discussion",
        "In this study, we showed that representational similarity is preserved as a generic mathematical consequence of random connectivity: in random networks, pairwise similarities between inputs are largely reflected in the outputs, independent of the specific connectivity pattern.",
        "Drift, whether random synaptic turnover or Hebbian plasticity, merely transitions the network between random instantiations, leaving this similarity intact.",
      ].join("\n\n");

      const lookupText = getQuoteCitationLookupTextForTests({
        id: "Q_eppler",
        quoteText,
        citationLabel: "(Eppler et al., 2026)",
        sourceMatchText: "this similarity intact",
        sourceMatchKind: "raw-middle",
        sourceMatchSource: "context-text",
        contextItemId: 14,
      });

      assert.notInclude(lookupText, "3 Discussion");
      assert.include(lookupText, "In this study, we showed");
      assert.match(lookupText, /^In this study/);
      assert.notInclude(lookupText, "##");
      assert.isAbove(lookupText.length, 250);
    });

    it("removes a sourceMatchText section-heading prefix before quote lookup", function () {
      const quoteText = [
        "## 3 Discussion",
        "In this study, we showed that representational similarity is preserved as a generic mathematical consequence of random connectivity: in random networks, pairwise similarities between inputs are largely reflected in the outputs, independent of the specific connectivity pattern.",
        "Drift, whether random synaptic turnover or Hebbian plasticity, merely transitions the network between random instantiations, leaving this similarity intact.",
      ].join("\n\n");

      const lookupText = getQuoteCitationLookupTextForTests({
        id: "Q_eppler",
        quoteText,
        citationLabel: "(Eppler et al., 2026)",
        sourceMatchText:
          "3 discussion in this study we showed that representational similarity is preserved as a generic mathematical consequence of random connectivity in random networks pairwise similarities between inputs are largely reflected in the outputs independent of the specific connectivity pattern drift whether random synaptic turnover or hebbian plasticity merely transitions the network between random instantiations leaving this similarity intact",
        sourceMatchKind: "raw-middle",
        sourceMatchSource: "context-text",
        contextItemId: 14,
      });

      assert.match(lookupText, /^In this study/);
      assert.notMatch(lookupText, /^3 Discussion/i);
      assert.include(lookupText, "leaving this similarity intact");
      assert.isAbove(lookupText.length, 250);
    });

    it("orders trusted quote page hints after verified caches and before full search", function () {
      const source = readFileSync(
        resolve(
          testDir,
          "../src/modules/contextPanel/assistantCitationLinks.ts",
        ),
        "utf8",
      );
      const verifiedStart = source.indexOf(
        "const cached = await navigateToCachedCitationPage",
      );
      const hiddenStart = source.indexOf("// Hidden page-index cache");
      const hintStart = source.indexOf("// Stored quote page hint");
      const fullSearchStart = source.indexOf(
        'if (status) setStatus(status, "Locating cited quote...", "sending")',
      );
      const hintSection = source.slice(hintStart, fullSearchStart);

      assert.isAtLeast(verifiedStart, 0);
      assert.isAbove(hiddenStart, verifiedStart);
      assert.isAbove(hintStart, hiddenStart);
      assert.isAbove(fullSearchStart, hintStart);
      assert.include(hintSection, "navigateToStoredQuotePageHint");
      assert.include(hintSection, "attemptCitationParagraphJump");
      assert.include(hintSection, "rememberCachedCitationPage");
      assert.include(hintSection, "if (hinted.paragraphJump.matched) return");
      assert.include(hintSection, "continue to full quote-location fallback");
    });

    it("passes trusted quote citation metadata into citation buttons for fast hint clicks", function () {
      const source = readFileSync(
        resolve(
          testDir,
          "../src/modules/contextPanel/assistantCitationLinks.ts",
        ),
        "utf8",
      );
      const createButtonStart = source.indexOf("function createCitationButton");
      const quoteAnchorStart = source.indexOf(
        "function createQuoteCitationAnchorElement",
      );
      const quoteAnchorEnd = source.indexOf(
        "function textContainsQuoteCitationPlaceholder",
        quoteAnchorStart,
      );
      const sourceBackedStart = source.indexOf(
        "const citationElement = createCitationButton",
        quoteAnchorEnd,
      );
      const sourceBackedEnd = source.indexOf(
        "const quoteCard",
        sourceBackedStart,
      );
      const createButtonSection = source.slice(
        createButtonStart,
        quoteAnchorStart,
      );
      const quoteAnchorSection = source.slice(quoteAnchorStart, quoteAnchorEnd);
      const sourceBackedSection = source.slice(
        sourceBackedStart,
        sourceBackedEnd,
      );

      assert.include(createButtonSection, "quoteCitation?: QuoteCitation");
      assert.include(
        createButtonSection,
        "citationButtonQuoteCitationCache.set",
      );
      assert.include(quoteAnchorSection, "quoteCitation: params.quoteCitation");
      assert.include(
        sourceBackedSection,
        "quoteCitation: trustedQuoteCitation",
      );
    });

    it("keeps cached citation navigation tied to the reader it opened", function () {
      const source = readFileSync(
        resolve(
          testDir,
          "../src/modules/contextPanel/assistantCitationLinks.ts",
        ),
        "utf8",
      );
      const resultTypeStart = source.indexOf(
        "type CitationParagraphJumpNavigation",
      );
      const resultTypeEnd = source.indexOf(
        "const citationButtonCandidateCache",
        resultTypeStart,
      );
      const cachedBranchStart = source.indexOf(
        "const cached = await navigateToCachedCitationPage",
      );
      const hiddenBranchStart = source.indexOf(
        "// Hidden page-index cache",
        cachedBranchStart,
      );
      const cachedBranch = source.slice(cachedBranchStart, hiddenBranchStart);

      assert.isAtLeast(resultTypeStart, 0);
      assert.isAbove(resultTypeEnd, resultTypeStart);
      assert.include(
        source.slice(resultTypeStart, resultTypeEnd),
        "reader: any",
      );
      assert.include(
        source.slice(resultTypeStart, resultTypeEnd),
        "contextItemId: number",
      );
      assert.match(cachedBranch, /resolveJumpedPageLabel\(\s*cached\.reader,/);
      assert.notInclude(cachedBranch, "getActiveReaderForSelectedTab()");
      assert.include(cachedBranch, "cached.contextItemId");
    });

    it("refreshes citation buttons from button context ids, not the active reader", function () {
      const source = readFileSync(
        resolve(
          testDir,
          "../src/modules/contextPanel/assistantCitationLinks.ts",
        ),
        "utf8",
      );
      const start = source.indexOf("function refreshAllCitationButtonPages");
      const end = source.indexOf(
        "function resolveMatchingCandidatesForExtractedCitation",
        start,
      );
      const refreshSection = source.slice(start, end);

      assert.isAtLeast(start, 0);
      assert.isAbove(end, start);
      assert.include(refreshSection, "parseCitationContextItemIds");
      assert.include(refreshSection, "button.dataset.citationContextItemIds");
      assert.notInclude(refreshSection, "getActiveReaderForSelectedTab");
      assert.notInclude(refreshSection, "getReaderItemId(activeReader)");
    });

    it("does not keep the removed render-time PDFWorker page prelookup path", function () {
      const source = readFileSync(
        resolve(
          testDir,
          "../src/modules/contextPanel/assistantCitationLinks.ts",
        ),
        "utf8",
      );

      assert.notInclude(source, "resolvePageForCitationButton");
      assert.notInclude(source, "PDFWorker.getFullText");
      assert.include(source, "warmPageTextCache");
    });

    it("keeps idle cache warming separate from page label mutation", function () {
      const source = readFileSync(
        resolve(
          testDir,
          "../src/modules/contextPanel/assistantCitationLinks.ts",
        ),
        "utf8",
      );
      const start = source.indexOf("function startCitationPageTextCacheWarm");
      const end = source.indexOf("function updateCitationButtonPage");
      const warmSection = source.slice(start, end);

      assert.isAtLeast(start, 0);
      assert.isAbove(end, start);
      assert.include(warmSection, "warmPageTextCache");
      assert.include(warmSection, "requestIdleCallback");
      assert.notInclude(warmSection, "updateCitationButtonPage");
      assert.notInclude(warmSection, "rememberCachedCitationPage");
    });

    it("uses button-cached candidates before considering citation fallback", function () {
      const source = readFileSync(
        resolve(
          testDir,
          "../src/modules/contextPanel/assistantCitationLinks.ts",
        ),
        "utf8",
      );

      assert.include(source, "new WeakMap<");
      assert.include(source, "citationButtonCandidateCache.set(citationButton");
      assert.include(source, "citationButtonCandidateCache.get(params.button)");
      assert.include(source, "allowLibrarySearchForCitationNavigation");
      assert.include(source, "hasUsefulLocalCandidate");
    });

    it("keeps active-reader tie breaking below stored provenance", function () {
      const source = readFileSync(
        resolve(
          testDir,
          "../src/modules/contextPanel/assistantCitationLinks.ts",
        ),
        "utf8",
      );
      const start = source.indexOf(
        "async function buildOrderedCitationCandidates",
      );
      const end = source.indexOf(
        "async function resolveCandidatesForCitationNavigation",
        start,
      );
      const orderingSection = source.slice(start, end);

      assert.isAtLeast(start, 0);
      assert.isAbove(end, start);
      assert.include(orderingSection, "authoritativeDelta");
      assert.include(orderingSection, "rankCitationCandidateProvenance");
      assert.include(orderingSection, "activeDelta");
      assert.isBelow(
        orderingSection.indexOf("authoritativeDelta"),
        orderingSection.indexOf("const leftRank"),
      );
      assert.isBelow(
        orderingSection.indexOf("rankDelta"),
        orderingSection.indexOf("activeDelta"),
      );
      assert.include(
        orderingSection,
        "if (leftProvenance === rightProvenance)",
      );
    });

    it("does not select the first child PDF from multi-PDF library search results", function () {
      const source = readFileSync(
        resolve(
          testDir,
          "../src/modules/contextPanel/assistantCitationLinks.ts",
        ),
        "utf8",
      );
      const start = source.indexOf(
        "async function resolveCitationCandidatesFromLibrarySearch",
      );
      const end = source.indexOf(
        "async function buildOrderedCitationCandidates",
        start,
      );
      const searchSection = source.slice(start, end);

      assert.isAtLeast(start, 0);
      assert.isAbove(end, start);
      assert.include(searchSection, "if (group.attachments.length !== 1)");
      assert.isBelow(
        searchSection.indexOf("if (group.attachments.length !== 1)"),
        searchSection.indexOf("const attachment = group.attachments[0]"),
      );
      assert.include(searchSection, '"library-search"');
    });

    it("does not allow whole-library fallback for quote-card navigation", function () {
      const source = readFileSync(
        resolve(
          testDir,
          "../src/modules/contextPanel/assistantCitationLinks.ts",
        ),
        "utf8",
      );

      assert.include(source, "type CitationNavigationMode");
      assert.include(source, "getCitationNavigationMode");
      assert.include(source, "allowLibrarySearchForCitationNavigation");
      assert.include(source, 'navigationMode: "trusted-quote"');
      assert.include(source, 'navigationMode: "untrusted-quote"');
      assert.notInclude(
        source,
        "{ allowLibrarySearch: !staticCandidates.length }",
      );
    });

    it("routes untrusted quote-card clicks through constrained source search", function () {
      const source = readFileSync(
        resolve(
          testDir,
          "../src/modules/contextPanel/assistantCitationLinks.ts",
        ),
        "utf8",
      );

      assert.include(source, "navigateUntrustedQuoteCitation");
      assert.include(source, "resolveCandidatesForCitationNavigation");
      assert.include(source, "skipFindController: true");
      assert.include(source, "matchedCandidates.length > 1");
      assert.include(
        source,
        "quote could not be resolved to a unique explicit PDF",
      );
      assert.include(source, "preferRawCitationLabel");
      assert.include(source, "preferRawCitationLabel: true");
    });

    it("renders untrusted quote-card citation controls without static candidates", function () {
      const source = readFileSync(
        resolve(
          testDir,
          "../src/modules/contextPanel/assistantCitationLinks.ts",
        ),
        "utf8",
      );
      const start = source.indexOf(
        "LLM citation decoration: rendering untrusted source-backed quote",
      );
      const end = source.indexOf(
        "const displayedQuoteContent = buildQuoteCardBodyContentFromBlockquote",
        start,
      );
      const untrustedRenderSection = source.slice(start, end);

      assert.isAtLeast(start, 0);
      assert.isAbove(end, start);
      assert.include(untrustedRenderSection, "createCitationButton");
      assert.notInclude(untrustedRenderSection, "candidates.length");
      assert.include(
        untrustedRenderSection,
        'navigationMode: "untrusted-quote"',
      );
    });

    it("uses hidden quote-location cache without mutating visible labels during warmup", function () {
      const source = readFileSync(
        resolve(
          testDir,
          "../src/modules/contextPanel/assistantCitationLinks.ts",
        ),
        "utf8",
      );
      const start = source.indexOf(
        "function startCitationQuoteLocationCacheWarm",
      );
      const end = source.indexOf("function updateCitationButtonPage");
      const warmSection = source.slice(start, end);

      assert.isAtLeast(start, 0);
      assert.isAbove(end, start);
      assert.include(source, "warmQuoteLocationCacheForAttachment");
      assert.include(warmSection, "enqueueCitationQuoteWarm");
      assert.include(warmSection, "isPdfBackedCitationCandidate");
      assert.notInclude(warmSection, "updateCitationButtonPage");
      assert.notInclude(warmSection, "rememberCachedCitationPage");
      assert.include(source, "lookupCachedQuoteLocationForAttachment");
      assert.include(source, "navigateToHiddenQuoteLocation");
    });

    it("warms trusted quote locations while rendering citation buttons", function () {
      const source = readFileSync(
        resolve(
          testDir,
          "../src/modules/contextPanel/assistantCitationLinks.ts",
        ),
        "utf8",
      );
      const quoteCardStart = source.indexOf("const trustedQuoteText");
      const start = source.indexOf(
        "const matchingCandidates = resolveQuoteCitationCandidates",
        quoteCardStart,
      );
      const end = source.indexOf(
        "const citationElement = createCitationButton",
        start,
      );
      const trustedRenderSection = source.slice(start, end);

      assert.isAtLeast(start, 0);
      assert.isAbove(end, start);
      assert.include(
        trustedRenderSection,
        "startCitationQuoteLocationCacheWarm(matchingCandidates, lookupQuoteText)",
      );
      assert.notInclude(trustedRenderSection, "updateCitationButtonPage");
      assert.notInclude(trustedRenderSection, "rememberCachedCitationPage");
    });

    it("bounds and deduplicates quote-location cache warming", function () {
      const source = readFileSync(
        resolve(
          testDir,
          "../src/modules/contextPanel/assistantCitationLinks.ts",
        ),
        "utf8",
      );
      const start = source.indexOf(
        "function startCitationQuoteLocationCacheWarm",
      );
      const end = source.indexOf(
        "function scheduleCitationPageTextCacheWarm",
        start,
      );
      const warmSection = source.slice(start, end);

      assert.isAtLeast(start, 0);
      assert.isAbove(end, start);
      assert.include(source, "MAX_WARM_CANDIDATES_PER_QUOTE = 2");
      assert.include(source, "MAX_PARALLEL_QUOTE_WARMS = 1");
      assert.include(warmSection, "enqueueCitationQuoteWarm");
      assert.match(warmSection, /slice\(\s*0,\s*MAX_WARM_CANDIDATES_PER_QUOTE/);
    });

    it("omits unresolved quote placeholders instead of rendering fallback text", function () {
      const source = readFileSync(
        resolve(
          testDir,
          "../src/modules/contextPanel/assistantCitationLinks.ts",
        ),
        "utf8",
      );

      assert.notInclude(source, "[quote unavailable]");
      assert.notInclude(source, "createQuoteCitationUnavailableElement");
      assert.include(source, "if (quoteCitation) {");
    });

    it("renders untrusted manual blockquotes as fallback quote cards", function () {
      const source = readFileSync(
        resolve(
          testDir,
          "../src/modules/contextPanel/assistantCitationLinks.ts",
        ),
        "utf8",
      );

      assert.include(source, "createFallbackQuoteCardElement");
      assert.include(source, "replaceBlockquoteWithFallbackQuoteCard");
      assert.notInclude(
        source,
        "rendering unanchored source-backed quote card",
      );
    });

    it("infers the only explicit source candidate for section-labeled fallback quote cards", function () {
      const source = readFileSync(
        resolve(
          testDir,
          "../src/modules/contextPanel/assistantCitationLinks.ts",
        ),
        "utf8",
      );

      assert.include(source, "inferSingleCandidateFallbackCitation");
      assert.include(source, "isNonSourceCitationLabel");
      assert.include(source, "createSyntheticCitationElement");
      assert.include(source, "fallbackCitation");
      assert.include(source, "citationRemainder = fallbackCitation.remainder");
    });
  });

  describe("formatSourceLabelWithPage", function () {
    it("appends page number to a standard citation label", function () {
      assert.equal(
        formatSourceLabelWithPage("(Smith et al., 2024)", "5"),
        "(Smith et al., 2024, page 5)",
      );
    });

    it("handles single-digit page numbers", function () {
      assert.equal(
        formatSourceLabelWithPage("(Lee et al., 2025)", "1"),
        "(Lee et al., 2025, page 1)",
      );
    });

    it("handles multi-digit page numbers", function () {
      assert.equal(
        formatSourceLabelWithPage("(Wang et al., 2023)", "142"),
        "(Wang et al., 2023, page 142)",
      );
    });

    it("returns original label when pageLabel is empty", function () {
      assert.equal(
        formatSourceLabelWithPage("(Smith et al., 2024)", ""),
        "(Smith et al., 2024)",
      );
    });

    it("returns original label when format is not parenthesized", function () {
      assert.equal(
        formatSourceLabelWithPage("Smith et al., 2024", "5"),
        "Smith et al., 2024",
      );
    });

    it("handles fallback Paper labels", function () {
      assert.equal(
        formatSourceLabelWithPage("(Paper 42)", "3"),
        "(Paper 42, page 3)",
      );
    });

    it("handles citation without year", function () {
      assert.equal(
        formatSourceLabelWithPage("(Smith et al.)", "7"),
        "(Smith et al., page 7)",
      );
    });

    it("handles Paper-only fallback label", function () {
      assert.equal(
        formatSourceLabelWithPage("(Paper)", "10"),
        "(Paper, page 10)",
      );
    });
  });
});
