import { assert } from "chai";
import {
  decorateAssistantCitationLinks,
  extractInlineCitationMentions,
  extractBlockquoteTailCitation,
  extractStandalonePaperSourceLabel,
  formatSourceLabelWithPage,
  matchAssistantCitationCandidates,
} from "../src/modules/contextPanel/assistantCitationLinks";
import { renderMarkdown } from "../src/utils/markdown";
import type { PaperContextRef } from "../src/modules/contextPanel/types";

describe("assistantCitationLinks", function () {
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
        firstCreator: "Alice Smith",
        year: "2024",
      },
      {
        itemId: 2,
        contextItemId: 22,
        title: "Paper B",
        firstCreator: "Brian Lee",
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

  it("preserves ambiguous matches when two papers share the same citation label", function () {
    const papers: PaperContextRef[] = [
      {
        itemId: 1,
        contextItemId: 11,
        title: "Paper A",
        firstCreator: "Alice Smith",
        year: "2024",
      },
      {
        itemId: 2,
        contextItemId: 22,
        title: "Paper B",
        firstCreator: "Aaron Smith",
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
        firstCreator: "Alice Smith",
        year: "2024",
        citationKey: "smith2024a",
      },
      {
        itemId: 2,
        contextItemId: 22,
        title: "Paper B",
        firstCreator: "Aaron Smith",
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

  it("parses citation rows with external citationKey and page suffix", function () {
    const papers: PaperContextRef[] = [
      {
        itemId: 1,
        contextItemId: 11,
        title: "Paper A",
        firstCreator: "Alice Smith",
        year: "2024",
        citationKey: "smith2024a",
      },
      {
        itemId: 2,
        contextItemId: 22,
        title: "Paper B",
        firstCreator: "Aaron Smith",
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

  it("decorates inline citations before bubble is attached to DOM", function () {
    const Zotero = (globalThis as typeof globalThis & { Zotero?: { getMainWindow?: () => { document?: Document } } }).Zotero;
    const doc = Zotero?.getMainWindow?.()?.document;
    if (!doc || typeof doc.createElement !== "function") {
      this.skip();
      return;
    }
    const body = doc.createElement("div");
    const bubble = doc.createElement("div") as HTMLDivElement;
    const assistantText =
      'Based on the retrieved evidence, here is a summary of the Methods and Materials section from the paper "Episodic boundaries affect neural features of representational drift in humans" (Kulkarni et al., 2024).';
    bubble.innerHTML = renderMarkdown(assistantText);

    const panelItem = {
      id: 999001,
      libraryID: 0,
      parentID: undefined,
      attachmentContentType: "",
      isAttachment: () => false,
      isRegularItem: () => false,
      getAttachments: () => [],
      getField: (_field: string) => "",
    } as unknown as Zotero.Item;

    const globalAny = globalThis as unknown as {
      ztoolkit?: { log?: (...args: unknown[]) => void };
    };
    const previousZtoolkit = globalAny.ztoolkit;
    globalAny.ztoolkit = {
      ...(previousZtoolkit || {}),
      log: (..._args: unknown[]) => {
        void _args;
      },
    };

    try {
      decorateAssistantCitationLinks({
        body,
        panelItem,
        bubble,
        assistantMessage: {
          role: "assistant",
          text: assistantText,
          timestamp: Date.now(),
        },
        pairedUserMessage: {
          role: "user",
          text: "help me understand this selected paper",
          timestamp: Date.now() - 1,
          paperContexts: [
            {
              itemId: 1,
              contextItemId: 11,
              title:
                "Episodic boundaries affect neural features of representational drift in humans",
              firstCreator: "Kulkarni",
              year: "2024",
            },
          ],
        },
      });
    } catch (err) {
      assert.fail(`decorateAssistantCitationLinks threw: ${String(err)}`);
    } finally {
      globalAny.ztoolkit = previousZtoolkit;
    }

    const inlineButtons = bubble.querySelectorAll(
      "button.llm-paper-citation-link-inline",
    );
    assert.equal(inlineButtons.length, 1);
    assert.include(
      inlineButtons[0]?.textContent || "",
      "Kulkarni et al., 2024",
    );
    assert.notInclude(bubble.textContent || "", "((Kulkarni et al., 2024))");
  });

  it("decorates grouped inline citations as separate links", function () {
    const Zotero = (globalThis as typeof globalThis & { Zotero?: { getMainWindow?: () => { document?: Document } } }).Zotero;
    const doc = Zotero?.getMainWindow?.()?.document;
    if (!doc || typeof doc.createElement !== "function") {
      this.skip();
      return;
    }

    const body = doc.createElement("div");
    const bubble = doc.createElement("div") as HTMLDivElement;
    const assistantText =
      "Representational drift is observed across brain regions (e.g., Ziv et al., 2013; Deitch et al., 2021).";
    bubble.innerHTML = renderMarkdown(assistantText);

    const panelItem = {
      id: 999002,
      libraryID: 0,
      parentID: undefined,
      attachmentContentType: "",
      isAttachment: () => false,
      isRegularItem: () => false,
      getAttachments: () => [],
      getField: (_field: string) => "",
    } as unknown as Zotero.Item;

    const globalAny = globalThis as unknown as {
      ztoolkit?: { log?: (...args: unknown[]) => void };
    };
    const previousZtoolkit = globalAny.ztoolkit;
    globalAny.ztoolkit = {
      ...(previousZtoolkit || {}),
      log: (..._args: unknown[]) => {
        void _args;
      },
    };

    try {
      decorateAssistantCitationLinks({
        body,
        panelItem,
        bubble,
        assistantMessage: {
          role: "assistant",
          text: assistantText,
          timestamp: Date.now(),
        },
        pairedUserMessage: {
          role: "user",
          text: "summarize this topic",
          timestamp: Date.now() - 1,
          paperContexts: [
            {
              itemId: 1,
              contextItemId: 11,
              title: "Paper Ziv",
              firstCreator: "Ziv",
              year: "2013",
            },
            {
              itemId: 2,
              contextItemId: 22,
              title: "Paper Deitch",
              firstCreator: "Deitch",
              year: "2021",
            },
          ],
        },
      });
    } catch (err) {
      assert.fail(`decorateAssistantCitationLinks threw: ${String(err)}`);
    } finally {
      globalAny.ztoolkit = previousZtoolkit;
    }

    const inlineButtons = Array.from(
      bubble.querySelectorAll("button.llm-paper-citation-link-inline"),
    ) as HTMLButtonElement[];
    assert.equal(inlineButtons.length, 2);
    assert.include(inlineButtons[0]?.textContent || "", "Ziv et al., 2013");
    assert.include(inlineButtons[1]?.textContent || "", "Deitch et al., 2021");
    assert.notInclude(inlineButtons[0]?.textContent || "", ";");
    assert.notInclude(inlineButtons[1]?.textContent || "", ";");
    assert.include(bubble.textContent || "", "(e.g., ");
    assert.include(bubble.textContent || "", "; ");
  });

  it("removes a duplicated trailing citation from a blockquote when a citation row follows", function () {
    const Zotero = (globalThis as typeof globalThis & { Zotero?: { getMainWindow?: () => { document?: Document } } }).Zotero;
    const doc = Zotero?.getMainWindow?.()?.document;
    if (!doc || typeof doc.createElement !== "function") {
      this.skip();
      return;
    }

    const body = doc.createElement("div");
    const bubble = doc.createElement("div") as HTMLDivElement;
    const assistantText = [
      '> "Therefore, representational drift is stable across days."',
      "> (Climer et al., 2025)",
      "",
      "(Climer et al., 2025)",
    ].join("\n");
    bubble.innerHTML = renderMarkdown(assistantText);

    const panelItem = {
      id: 999003,
      libraryID: 0,
      parentID: undefined,
      attachmentContentType: "",
      isAttachment: () => false,
      isRegularItem: () => false,
      getAttachments: () => [],
      getField: (_field: string) => "",
    } as unknown as Zotero.Item;

    const globalAny = globalThis as unknown as {
      ztoolkit?: { log?: (...args: unknown[]) => void };
    };
    const previousZtoolkit = globalAny.ztoolkit;
    globalAny.ztoolkit = {
      ...(previousZtoolkit || {}),
      log: (..._args: unknown[]) => {
        void _args;
      },
    };

    try {
      decorateAssistantCitationLinks({
        body,
        panelItem,
        bubble,
        assistantMessage: {
          role: "assistant",
          text: assistantText,
          timestamp: Date.now(),
        },
        pairedUserMessage: {
          role: "user",
          text: "summarize this paper",
          timestamp: Date.now() - 1,
          paperContexts: [
            {
              itemId: 1,
              contextItemId: 11,
              title: "Paper Climer",
              firstCreator: "Climer",
              year: "2025",
            },
          ],
        },
      });
    } catch (err) {
      assert.fail(`decorateAssistantCitationLinks threw: ${String(err)}`);
    } finally {
      globalAny.ztoolkit = previousZtoolkit;
    }

    const text = bubble.textContent || "";
    assert.equal(
      (text.match(/Climer et al\., 2025/g) || []).length,
      1,
    );
    const blockquote = bubble.querySelector("blockquote");
    assert.isOk(blockquote);
    assert.notInclude(blockquote?.textContent || "", "Climer et al., 2025");
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
