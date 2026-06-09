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
  extractStandalonePaperSourceLabel,
  formatSourceLabelWithPage,
  formatUnverifiedCitationChipLabel,
  isPdfBackedCitationCandidateForTests,
  lookupCachedCitationPage,
  matchAssistantCitationCandidates,
  rememberCachedCitationPage,
  resolveAuthoritativeNonPdfCitationCandidateForTests,
  INLINE_CITATION_SKIP_SELECTOR,
  type AssistantCitationPaperCandidate,
} from "../src/modules/contextPanel/assistantCitationLinks";
import type { PaperContextRef } from "../src/modules/contextPanel/types";

const testDir = dirname(fileURLToPath(import.meta.url));
const globalScope = globalThis as typeof globalThis & { Zotero?: any };

function makeZoteroItem(params: {
  id: number;
  kind: "regular" | "attachment";
  fields?: Record<string, unknown>;
  parentID?: number;
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

describe("assistantCitationLinks", function () {
  const originalZotero = globalScope.Zotero;

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

  it("does not keep the removed render-time PDFWorker page prelookup path", function () {
    const source = readFileSync(
      resolve(testDir, "../src/modules/contextPanel/assistantCitationLinks.ts"),
      "utf8",
    );

    assert.notInclude(source, "resolvePageForCitationButton");
    assert.notInclude(source, "PDFWorker.getFullText");
    assert.include(source, "warmPageTextCache");
  });

  it("keeps idle cache warming separate from page label mutation", function () {
    const source = readFileSync(
      resolve(testDir, "../src/modules/contextPanel/assistantCitationLinks.ts"),
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

  it("uses button-cached candidates before falling back to library search", function () {
    const source = readFileSync(
      resolve(testDir, "../src/modules/contextPanel/assistantCitationLinks.ts"),
      "utf8",
    );

    assert.include(source, "new WeakMap<");
    assert.include(source, "citationButtonCandidateCache.set(citationButton");
    assert.include(source, "citationButtonCandidateCache.get(params.button)");
    assert.include(source, "{ allowLibrarySearch: !staticCandidates.length }");
    assert.include(source, "hasUsefulLocalCandidate");
  });

  it("uses hidden quote-location cache without mutating visible labels during warmup", function () {
    const source = readFileSync(
      resolve(testDir, "../src/modules/contextPanel/assistantCitationLinks.ts"),
      "utf8",
    );
    const start = source.indexOf(
      "function startCitationQuoteLocationCacheWarm",
    );
    const end = source.indexOf("function updateCitationButtonPage");
    const warmSection = source.slice(start, end);

    assert.isAtLeast(start, 0);
    assert.isAbove(end, start);
    assert.include(warmSection, "warmQuoteLocationCacheForAttachment");
    assert.include(warmSection, "isPdfBackedCitationCandidate");
    assert.notInclude(warmSection, "updateCitationButtonPage");
    assert.notInclude(warmSection, "rememberCachedCitationPage");
    assert.include(source, "lookupCachedQuoteLocationForAttachment");
    assert.include(source, "navigateToHiddenQuoteLocation");
  });

  it("omits unresolved quote placeholders instead of rendering fallback text", function () {
    const source = readFileSync(
      resolve(testDir, "../src/modules/contextPanel/assistantCitationLinks.ts"),
      "utf8",
    );

    assert.notInclude(source, "[quote unavailable]");
    assert.notInclude(source, "createQuoteCitationUnavailableElement");
    assert.include(source, "if (quoteCitation) {");
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
