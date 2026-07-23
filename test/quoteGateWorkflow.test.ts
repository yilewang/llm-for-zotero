import { assert } from "chai";
import {
  buildAssistantDisplayMarkdownForRender,
  finalizeAssistantMessageQuoteCitationsForTests,
  getQuoteValidationDecisionCacheStatsForTests,
  resetQuoteValidationDecisionCacheForTests,
  scheduleConversationQuoteRevalidation,
  waitForAssistantQuoteValidationForTests,
} from "../src/modules/contextPanel/chat";
import { buildQuoteCitation } from "../src/modules/contextPanel/quoteCitations";
import { clearPageTextCache } from "../src/modules/contextPanel/livePdfSelectionLocator";
import {
  beginQuoteNavigationActivity,
  resetQuoteValidationActivityForTests,
} from "../src/modules/contextPanel/quoteValidationActivity";
import {
  chatHistory,
  pdfTextCache,
  pdfTextLoadingTasks,
} from "../src/modules/contextPanel/state";
import type {
  Message,
  PaperContextRef,
} from "../src/modules/contextPanel/types";

function installPdfSource(
  contextItemId: number,
  sourceText: string,
  options: { hasCompletePageBoundaries?: () => boolean } = {},
): { getCallCount: () => number; restore: () => void } {
  const originalZotero = globalThis.Zotero;
  const originalZtoolkit = globalThis.ztoolkit;
  let calls = 0;
  const attachment = {
    id: contextItemId,
    parentID: undefined,
    attachmentContentType: "application/pdf",
    isAttachment: () => true,
    isNote: () => false,
    getField: (field: string) =>
      field === "title" ? "Representational drift paper" : "",
    getFilename: () => "representational-drift.pdf",
  } as unknown as Zotero.Item;
  (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
    Items: {
      get: (id: number) => (id === contextItemId ? attachment : null),
    },
    PDFWorker: {
      getFullText: async () => {
        calls += 1;
        return options.hasCompletePageBoundaries?.() === false
          ? { text: sourceText }
          : {
              text: sourceText,
              pageChars: [sourceText.length],
            };
      },
    },
  } as typeof Zotero;
  (globalThis as typeof globalThis & { ztoolkit: typeof ztoolkit }).ztoolkit = {
    log: () => undefined,
  } as typeof ztoolkit;
  return {
    getCallCount: () => calls,
    restore: () => {
      (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero =
        originalZotero;
      (
        globalThis as typeof globalThis & { ztoolkit: typeof ztoolkit }
      ).ztoolkit = originalZtoolkit;
    },
  };
}

describe("minimal source-match quote gate workflow", function () {
  const conversationKey = 9011;
  const contextItemId = 811;
  let restoreSource = () => undefined;
  const paper: PaperContextRef = {
    itemId: 810,
    contextItemId,
    title: "Representational drift paper",
    firstCreator: "Eppler et al.",
    year: "2026",
    contentSourceMode: "text",
  };

  afterEach(function () {
    restoreSource();
    restoreSource = () => undefined;
    chatHistory.delete(conversationKey);
    pdfTextCache.clear();
    pdfTextLoadingTasks.clear();
    clearPageTextCache();
    resetQuoteValidationDecisionCacheForTests();
    resetQuoteValidationActivityForTests();
  });

  it("keeps a registered Eppler anchor trusted without source I/O", async function () {
    const source = installPdfSource(contextItemId, "Unneeded PDF text.");
    restoreSource = source.restore;
    const citation = buildQuoteCitation({
      quoteText:
        "For each NC bin, neuron pairs were grouped into K bins based on their SC at day t. For each SC bin k, we computed the mean across pairwise NC Yi",
      displayQuoteText:
        "For each NC bin, neuron pairs were grouped into K bins based on their SC at day t. For each SC bin k, we computed the mean across **pairwise NC Yᵢ**...",
      citationLabel: "(Eppler et al., 2026)",
      sourceMatchText:
        "For each NC bin, neuron pairs were grouped into K bins based on their SC at day t. For each SC bin k, we computed the mean across pairwise NC Yi",
      sourceMatchKind: "normalized-span",
      sourceMatchSource: "pdf-page-text",
      contextItemId,
      itemId: paper.itemId,
      pageHintLabel: "10",
    });
    assert.isDefined(citation);
    const userMessage: Message = {
      role: "user",
      text: "Explain the method.",
      timestamp: 1,
      paperContexts: [paper],
    };
    const assistantMessage: Message = {
      role: "assistant",
      text: `[[quote:${citation!.id}]]`,
      quoteCitations: [citation!],
      timestamp: 2,
    };
    chatHistory.set(conversationKey, [userMessage, assistantMessage]);

    finalizeAssistantMessageQuoteCitationsForTests(assistantMessage, {
      pairedUserMessage: userMessage,
      conversationKey,
    });
    await waitForAssistantQuoteValidationForTests(conversationKey);

    assert.equal(source.getCallCount(), 0);
    assert.equal(assistantMessage.text, `[[quote:${citation!.id}]]`);
    assert.deepEqual(assistantMessage.quoteCitations, [citation!]);
    assert.isUndefined(assistantMessage.quoteDisplayOverride);
    assert.include(
      buildAssistantDisplayMarkdownForRender(assistantMessage),
      "[[quote-occurrence:",
    );
  });

  it("defers without I/O, then overlays a unique source match", async function () {
    const quote =
      "Noise correlation changed more favorably for neuron pairs with high signal correlation.";
    const source = installPdfSource(
      contextItemId,
      `Results. ${quote} The next result follows.`,
    );
    restoreSource = source.restore;
    const userMessage: Message = {
      role: "user",
      text: "Explain the result.",
      timestamp: 1,
      paperContexts: [paper],
    };
    const assistantMessage: Message = {
      role: "assistant",
      text: `> ${quote}`,
      timestamp: 2,
    };
    chatHistory.set(conversationKey, [userMessage, assistantMessage]);

    finalizeAssistantMessageQuoteCitationsForTests(assistantMessage, {
      pairedUserMessage: userMessage,
      conversationKey,
    });

    assert.equal(source.getCallCount(), 0);
    assert.equal(assistantMessage.text, `> ${quote}`);
    assert.isUndefined(assistantMessage.quoteDisplayOverride);

    await waitForAssistantQuoteValidationForTests(conversationKey);

    assert.isAbove(source.getCallCount(), 0);
    assert.equal(assistantMessage.text, `> ${quote}`);
    assert.isUndefined(assistantMessage.quoteCitations);
    assert.match(
      assistantMessage.quoteDisplayOverride?.markdown || "",
      /\[\[quote:Q_[a-z0-9]+\]\]/,
    );
    assert.equal(
      assistantMessage.quoteDisplayOverride?.quoteCitations?.[0]?.citationLabel,
      "(Eppler et al., 2026)",
    );
  });

  it("repairs a historical manual-anchor pair on load without rewriting raw history", async function () {
    const anchorQuote =
      "To describe the probabilistic response of an entire population, we need to make assumptions about the joint responses of neurons.";
    const displayedQuote = `${anchorQuote} The simplest assumption is that all neurons respond independently from each other.`;
    const raw = `> ${displayedQuote}\n> [[quote:Q_07qwnp0]]`;
    const citation = buildQuoteCitation({
      id: "Q_07qwnp0",
      quoteText: anchorQuote,
      citationLabel: "(Ma, 2009)",
      sourceMatchText: anchorQuote,
      sourceMatchKind: "exact",
      sourceMatchSource: "context-text",
      contextItemId,
      itemId: paper.itemId,
      sourceFingerprint: "fnv1a32-historical-mineru",
    });
    assert.isDefined(citation);
    const source = installPdfSource(
      contextItemId,
      `${displayedQuote} Then, the population response distribution is the product of the response distributions of the neurons in the population.`,
    );
    restoreSource = source.restore;
    const userMessage: Message = {
      role: "user",
      text: "What exactly is the joint probability distribution here?",
      timestamp: 1,
      paperContexts: [
        {
          ...paper,
          title: "Population Codes: Theoretic Aspects",
          firstCreator: "Ma",
          year: "2009",
        },
      ],
    };
    const assistantMessage: Message = {
      role: "assistant",
      text: raw,
      quoteCitations: [citation!],
      timestamp: 2,
    };
    chatHistory.set(conversationKey, [userMessage, assistantMessage]);

    finalizeAssistantMessageQuoteCitationsForTests(assistantMessage, {
      pairedUserMessage: userMessage,
      conversationKey,
    });
    await waitForAssistantQuoteValidationForTests(conversationKey);

    assert.equal(assistantMessage.text, raw);
    assert.deepEqual(assistantMessage.quoteCitations, [citation!]);
    assert.equal(
      (
        assistantMessage.quoteDisplayOverride?.markdown.match(
          /\[\[quote:Q_[a-z0-9]+\]\]/g,
        ) || []
      ).length,
      1,
    );
    assert.lengthOf(
      assistantMessage.quoteDisplayOverride?.quoteCitations || [],
      1,
    );
    assert.equal(
      assistantMessage.quoteDisplayOverride?.quoteCitations?.[0]?.quoteText,
      displayedQuote,
    );
    assert.notEqual(
      assistantMessage.quoteDisplayOverride?.quoteCitations?.[0]
        ?.sourceFingerprint,
      citation!.sourceFingerprint,
    );
  });

  it("keeps the searchable Asabuki page-4 quote verified after background authentication", async function () {
    const quote =
      "For excitatory synapses, errors between excitatory drive and the output of the cell provide feedback to the synapses... All excitatory connections seek to minimize these errors. For inhibitory synapses, the error between excitatory and inhibitory drive must be minimized to maintain excitation–inhibition balance.";
    const pageText =
      "For excitatory synapses, errors between the excitatory drive and the output of the cell provide feedback to the synapses (dashed arrow) and modulate plasticity (blue square; exc. error). All excitatory connections seek to minimize these errors. For inhibitory synapses, the error between excitatory and inhibitory drive must be minimized to maintain excitation-inhibition balance (orange square; inh. error).";
    const asabukiPaper: PaperContextRef = {
      ...paper,
      title:
        "Intrinsic representational drift from predictive excitatory-inhibitory plasticity",
      firstCreator: "Asabuki and Clopath",
      year: "",
    };
    const source = installPdfSource(contextItemId, pageText);
    restoreSource = source.restore;
    const userMessage: Message = {
      role: "user",
      text: "Explain predictive E/I plasticity.",
      timestamp: 1,
      paperContexts: [asabukiPaper],
    };
    const assistantMessage: Message = {
      role: "assistant",
      text: `> ${quote}\n>\n> (Asabuki and Clopath, page 4)`,
      timestamp: 2,
    };
    chatHistory.set(conversationKey, [userMessage, assistantMessage]);

    finalizeAssistantMessageQuoteCitationsForTests(assistantMessage, {
      pairedUserMessage: userMessage,
      conversationKey,
    });

    assert.isUndefined(assistantMessage.quoteDisplayOverride);
    await waitForAssistantQuoteValidationForTests(conversationKey);

    assert.match(
      assistantMessage.quoteDisplayOverride?.markdown || "",
      /\[\[quote:Q_[a-z0-9]+\]\]/,
    );
    assert.notInclude(
      assistantMessage.quoteDisplayOverride?.markdown || "",
      "Not a source quote",
    );
    assert.isNotEmpty(
      assistantMessage.quoteDisplayOverride?.quoteCitations || [],
    );
  });

  it("revalidates legacy Climer same-line citations without rewriting stored history", async function () {
    const waterQuote =
      "The water-restricted mice received water rewards $2 . 2 5 \\mathsf { m }$ down a 3-m visual virtual track";
    const methodsQuote =
      "Mice received $4 \\mu \\mathrm { l }$ water reward $2 / 3 ( 2 . 2 5 \\mathsf { m } )$ of the way along the $3 { \\cdot } \\mathsf { m }$ virtual track.";
    const sourceText = [
      "The water-restricted mice received water rewards 2.25 m down a 3-m visual virtual track, a track length resembling those in other studies.",
      "Mice received 4 μl water reward 2/3 (2.25 m) of the way along the 3 m virtual track.",
    ].join("\n");
    const raw = [
      `> “${waterQuote}” (Climer et al., 2025)`,
      "",
      `> “${methodsQuote}” (Climer et al., 2025)`,
    ].join("\n");
    const climerPaper: PaperContextRef = {
      ...paper,
      itemId: 2443,
      contextItemId,
      title:
        "Hippocampal representations drift in stable multisensory environments",
      firstCreator: "Climer et al.",
      year: "2025",
    };
    const source = installPdfSource(contextItemId, sourceText);
    restoreSource = source.restore;
    const userMessage: Message = {
      role: "user",
      text: "Where was the reward delivered?",
      timestamp: 1,
      paperContexts: [climerPaper],
    };
    const assistantMessage: Message = {
      role: "assistant",
      text: raw,
      timestamp: 2,
    };
    chatHistory.set(conversationKey, [userMessage, assistantMessage]);

    finalizeAssistantMessageQuoteCitationsForTests(assistantMessage, {
      pairedUserMessage: userMessage,
      conversationKey,
    });
    await waitForAssistantQuoteValidationForTests(conversationKey);

    assert.equal(assistantMessage.text, raw);
    assert.isUndefined(assistantMessage.quoteCitations);
    assert.notInclude(
      assistantMessage.quoteDisplayOverride?.markdown || "",
      "Not a source quote",
    );
    assert.equal(
      (
        assistantMessage.quoteDisplayOverride?.markdown.match(
          /\[\[quote:Q_[a-z0-9]+\]\]/g,
        ) || []
      ).length,
      2,
    );
    assert.lengthOf(
      assistantMessage.quoteDisplayOverride?.quoteCitations || [],
      2,
    );
    assert.equal(
      assistantMessage.quoteDisplayOverride?.quoteCitations?.[0]?.citationLabel,
      "(Climer et al., 2025)",
    );
  });

  it("revalidates the stored Kriegeskorte and Wei quote through fused references without rewriting history", async function () {
    const quote =
      "the noise correlation for a pair of neurons is proportional to the product of the derivatives of their tuning curves at the stimulus value. As information already missing from the input cannot possibly be recovered from the code, such so-called differential noise correlations limit the FI that the code can achieve, no matter how many neurons we allow.";
    const raw = `> ${quote}\n\n(Kriegeskorte & Wei, 2021, page 7)`;
    const sourceText = [
      "There is some evidence that related effects are present in frontal cortex194,195.",
      "In this scenario, the noise correlation for a pair of neurons is proportional to the product of the derivatives of their tuning curves at the stimulus value.",
      "As information already missing from the input cannot possibly be recovered from the code, such so-called differential noise correlations limit the FI that the code can achieve, no matter how many neurons we allow135.",
    ].join(" ");
    const kriegeskortePaper: PaperContextRef = {
      ...paper,
      itemId: 4,
      contextItemId,
      title: "Neural tuning and representational geometry",
      firstCreator: "Kriegeskorte and Wei",
      year: "2021",
    };
    const source = installPdfSource(contextItemId, sourceText);
    restoreSource = source.restore;
    const userMessage: Message = {
      role: "user",
      text: "Explain differential noise correlations.",
      timestamp: 1,
      paperContexts: [kriegeskortePaper],
    };
    const assistantMessage: Message = {
      role: "assistant",
      text: raw,
      timestamp: 2,
    };
    chatHistory.set(conversationKey, [userMessage, assistantMessage]);

    finalizeAssistantMessageQuoteCitationsForTests(assistantMessage, {
      pairedUserMessage: userMessage,
      conversationKey,
    });
    await waitForAssistantQuoteValidationForTests(conversationKey);

    assert.equal(assistantMessage.text, raw);
    assert.isUndefined(assistantMessage.quoteCitations);
    assert.match(
      assistantMessage.quoteDisplayOverride?.markdown || "",
      /\[\[quote:Q_[a-z0-9]+\]\]/,
    );
    assert.notInclude(
      assistantMessage.quoteDisplayOverride?.markdown || "",
      "Not a source quote",
    );
    assert.lengthOf(
      assistantMessage.quoteDisplayOverride?.quoteCitations || [],
      1,
    );
    assert.equal(
      assistantMessage.quoteDisplayOverride?.quoteCitations?.[0]?.citationLabel,
      "(Kriegeskorte and Wei, 2021)",
    );
  });

  it("extracts and computes once for repeated quote and source scopes", async function () {
    resetQuoteValidationDecisionCacheForTests();
    const quote =
      "Cached provenance decisions preserve the same verified source wording across a warm reopening.";
    const source = installPdfSource(contextItemId, `Results. ${quote}`);
    restoreSource = source.restore;
    const userMessage: Message = {
      role: "user",
      text: "Explain the result.",
      timestamp: 1,
      paperContexts: [paper],
    };
    const first: Message = {
      role: "assistant",
      text: `> ${quote}`,
      timestamp: 2,
    };
    chatHistory.set(conversationKey, [userMessage, first]);

    finalizeAssistantMessageQuoteCitationsForTests(first, {
      pairedUserMessage: userMessage,
      conversationKey,
    });
    await waitForAssistantQuoteValidationForTests(conversationKey);

    const second: Message = {
      role: "assistant",
      text: `> ${quote}`,
      timestamp: 3,
    };
    chatHistory.set(conversationKey, [userMessage, first, second]);
    finalizeAssistantMessageQuoteCitationsForTests(second, {
      pairedUserMessage: userMessage,
      conversationKey,
    });
    await waitForAssistantQuoteValidationForTests(conversationKey);

    assert.equal(source.getCallCount(), 1);
    const cacheStats = getQuoteValidationDecisionCacheStatsForTests();
    assert.equal(cacheStats.entries, 1);
    assert.isAbove(cacheStats.bytes, 0);
    assert.equal(cacheStats.hits, 1);
    assert.equal(cacheStats.computations, 1);
    assert.equal(cacheStats.sourceIndexEntries, 1);
    assert.isAbove(cacheStats.sourceIndexBytes, 0);
    assert.equal(cacheStats.sourceIndexHits, 1);
    assert.equal(cacheStats.sourceIndexBuilds, 1);
    assert.deepEqual(second.quoteDisplayOverride, first.quoteDisplayOverride);
  });

  it("reuses one immutable source index for different quotes in the same scope", async function () {
    resetQuoteValidationDecisionCacheForTests();
    const firstQuote =
      "The first source-backed result remains available in the prepared attachment index.";
    const secondQuote =
      "The second source-backed result uses that same immutable attachment index.";
    const source = installPdfSource(
      contextItemId,
      `${firstQuote} ${secondQuote}`,
    );
    restoreSource = source.restore;
    const userMessage: Message = {
      role: "user",
      text: "Explain both results.",
      timestamp: 1,
      paperContexts: [paper],
    };
    const first: Message = {
      role: "assistant",
      text: `> ${firstQuote}`,
      timestamp: 2,
    };
    chatHistory.set(conversationKey, [userMessage, first]);
    finalizeAssistantMessageQuoteCitationsForTests(first, {
      pairedUserMessage: userMessage,
      conversationKey,
    });
    await waitForAssistantQuoteValidationForTests(conversationKey);

    const second: Message = {
      role: "assistant",
      text: `> ${secondQuote}`,
      timestamp: 3,
    };
    chatHistory.set(conversationKey, [userMessage, first, second]);
    finalizeAssistantMessageQuoteCitationsForTests(second, {
      pairedUserMessage: userMessage,
      conversationKey,
    });
    await waitForAssistantQuoteValidationForTests(conversationKey);

    const cacheStats = getQuoteValidationDecisionCacheStatsForTests();
    assert.equal(source.getCallCount(), 1);
    assert.equal(cacheStats.computations, 2);
    assert.equal(cacheStats.sourceIndexBuilds, 1);
    assert.equal(cacheStats.sourceIndexHits, 1);
  });

  it("lets user citation navigation preempt idle provenance validation", async function () {
    const quote =
      "Foreground citation navigation must settle before source validation begins in the background.";
    const source = installPdfSource(contextItemId, quote);
    restoreSource = source.restore;
    const userMessage: Message = {
      role: "user",
      text: "Explain the result.",
      timestamp: 1,
      paperContexts: [paper],
    };
    const assistantMessage: Message = {
      role: "assistant",
      text: `> ${quote}`,
      timestamp: 2,
    };
    chatHistory.set(conversationKey, [userMessage, assistantMessage]);
    const endNavigation = beginQuoteNavigationActivity();

    finalizeAssistantMessageQuoteCitationsForTests(assistantMessage, {
      pairedUserMessage: userMessage,
      conversationKey,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(source.getCallCount(), 0);

    endNavigation();
    await waitForAssistantQuoteValidationForTests(conversationKey);
    assert.equal(source.getCallCount(), 1);
    assert.include(
      assistantMessage.quoteDisplayOverride?.markdown || "",
      "[[quote:",
    );
  });

  it("cancels a stale conversation generation before extraction or UI mutation", async function () {
    const quote =
      "A stale conversation must never receive a provenance display mutation.";
    const source = installPdfSource(contextItemId, quote);
    restoreSource = source.restore;
    const userMessage: Message = {
      role: "user",
      text: "Explain the result.",
      timestamp: 1,
      paperContexts: [paper],
    };
    const staleAssistant: Message = {
      role: "assistant",
      text: `> ${quote}`,
      timestamp: 2,
    };
    chatHistory.set(conversationKey, [userMessage, staleAssistant]);

    finalizeAssistantMessageQuoteCitationsForTests(staleAssistant, {
      pairedUserMessage: userMessage,
      conversationKey,
    });
    chatHistory.set(conversationKey, [
      userMessage,
      { role: "assistant", text: "Replacement answer.", timestamp: 3 },
    ]);
    await waitForAssistantQuoteValidationForTests(conversationKey);

    assert.equal(source.getCallCount(), 0);
    assert.isUndefined(staleAssistant.quoteDisplayOverride);
  });

  it("rejects a partial source match when the complete displayed quote is absent", async function () {
    const sourceSentence =
      "Noise correlation changed more favorably for neuron pairs with high signal correlation.";
    const quote = `${sourceSentence} This explanatory sentence was added by the model.`;
    const source = installPdfSource(contextItemId, sourceSentence);
    restoreSource = source.restore;
    const userMessage: Message = {
      role: "user",
      text: "Explain the result.",
      timestamp: 1,
      paperContexts: [paper],
    };
    const assistantMessage: Message = {
      role: "assistant",
      text: `> ${quote}`,
      timestamp: 2,
    };
    chatHistory.set(conversationKey, [userMessage, assistantMessage]);

    finalizeAssistantMessageQuoteCitationsForTests(assistantMessage, {
      pairedUserMessage: userMessage,
      conversationKey,
    });
    await waitForAssistantQuoteValidationForTests(conversationKey);

    assert.equal(
      assistantMessage.quoteDisplayOverride?.markdown,
      `> ${quote}\n>\n> Not a source quote`,
    );
    assert.isUndefined(assistantMessage.quoteDisplayOverride?.quoteCitations);
    assert.equal(assistantMessage.text, `> ${quote}`);
  });

  it("adds Not a source quote only after a complete zero match", async function () {
    const quote =
      "Among neuron pairs, does noise correlation change more favorably for high signal correlation?";
    const raw = `> ${quote}\n>\n> (Eppler et al., 2026, page 3)`;
    const source = installPdfSource(
      contextItemId,
      "The complete paper text discusses a different experimental result.",
    );
    restoreSource = source.restore;
    const userMessage: Message = {
      role: "user",
      text: "Explain the result.",
      timestamp: 1,
      paperContexts: [paper],
    };
    const assistantMessage: Message = {
      role: "assistant",
      text: raw,
      timestamp: 2,
    };
    chatHistory.set(conversationKey, [userMessage, assistantMessage]);

    finalizeAssistantMessageQuoteCitationsForTests(assistantMessage, {
      pairedUserMessage: userMessage,
      conversationKey,
    });
    assert.isUndefined(assistantMessage.quoteDisplayOverride);

    await waitForAssistantQuoteValidationForTests(conversationKey);

    assert.equal(assistantMessage.text, raw);
    assert.isUndefined(assistantMessage.quoteCitations);
    assert.equal(
      assistantMessage.quoteDisplayOverride?.markdown,
      `> ${quote}\n>\n> Not a source quote`,
    );
    assert.include(
      buildAssistantDisplayMarkdownForRender(assistantMessage),
      "[[quote-occurrence:",
    );
  });

  it("strips the Eppler label after complete evidence leaves only an incidental overlap", async function () {
    const quote =
      "Among neuron pairs that begin with roughly similar noise correlation, does noise correlation change more favorably for pairs with high signal correlation than for pairs with low signal correlation?";
    const raw = `> ${quote}\n>\n> (Eppler et al., 2026)`;
    const source = installPdfSource(
      contextItemId,
      "The least reduction of noise correlations was observed for pairs with high signal correlations in the first interval.",
    );
    restoreSource = source.restore;
    const userMessage: Message = {
      role: "user",
      text: "Explain the prediction index.",
      timestamp: 1,
      paperContexts: [paper],
    };
    const assistantMessage: Message = {
      role: "assistant",
      text: raw,
      timestamp: 2,
    };
    chatHistory.set(conversationKey, [userMessage, assistantMessage]);

    finalizeAssistantMessageQuoteCitationsForTests(assistantMessage, {
      pairedUserMessage: userMessage,
      conversationKey,
    });
    await waitForAssistantQuoteValidationForTests(conversationKey);

    assert.equal(assistantMessage.text, raw);
    assert.equal(
      assistantMessage.quoteDisplayOverride?.markdown,
      `> ${quote}\n>\n> Not a source quote`,
    );
    assert.notInclude(
      assistantMessage.quoteDisplayOverride?.markdown || "",
      "Eppler",
    );
    assert.isUndefined(assistantMessage.quoteDisplayOverride?.quoteCitations);
  });

  it("turns the exact persisted I-k card yellow and strips its label", async function () {
    const quote =
      "**Iₖ = the set of neuron-pair indices that fall into the k-th SC bin on day t.**";
    const raw = `> ${quote}\n>\n> (Eppler et al., 2026)`;
    const source = installPdfSource(
      contextItemId,
      "For each SC bin k, we computed the mean across pairwise NC Yi. Where Ik is the set of pairs in bin k.",
    );
    restoreSource = source.restore;
    const userMessage: Message = {
      role: "user",
      text: "Please explain I_k.",
      timestamp: 1,
      paperContexts: [paper],
    };
    const assistantMessage: Message = {
      role: "assistant",
      text: raw,
      timestamp: 2,
    };
    chatHistory.set(conversationKey, [userMessage, assistantMessage]);

    finalizeAssistantMessageQuoteCitationsForTests(assistantMessage, {
      pairedUserMessage: userMessage,
      conversationKey,
    });
    await waitForAssistantQuoteValidationForTests(conversationKey);

    assert.equal(
      assistantMessage.quoteDisplayOverride?.markdown,
      `> ${quote}\n>\n> Not a source quote`,
    );
    assert.notInclude(
      assistantMessage.quoteDisplayOverride?.markdown || "",
      "Eppler",
    );
    assert.isUndefined(assistantMessage.quoteDisplayOverride?.quoteCitations);
  });

  it("revalidates deferred historical quotes after navigation makes the source scope complete", async function () {
    let pageBoundariesAvailable = false;
    const quote =
      "Among neuron pairs that begin with roughly similar noise correlation, does noise correlation change more favorably for pairs with high signal correlation than for pairs with low signal correlation?";
    const raw = `> ${quote}\n>\n> (Eppler et al., 2026)`;
    const source = installPdfSource(
      contextItemId,
      "The least reduction of noise correlations was observed for pairs with high signal correlations in the first interval.",
      { hasCompletePageBoundaries: () => pageBoundariesAvailable },
    );
    restoreSource = source.restore;
    const userMessage: Message = {
      role: "user",
      text: "Explain the prediction index.",
      timestamp: 1,
      paperContexts: [paper],
    };
    const assistantMessage: Message = {
      role: "assistant",
      text: raw,
      timestamp: 2,
    };
    chatHistory.set(conversationKey, [userMessage, assistantMessage]);

    finalizeAssistantMessageQuoteCitationsForTests(assistantMessage, {
      pairedUserMessage: userMessage,
      conversationKey,
    });
    await waitForAssistantQuoteValidationForTests(conversationKey);

    assert.isUndefined(assistantMessage.quoteDisplayOverride);
    assert.include(assistantMessage.text, "(Eppler et al., 2026)");

    pageBoundariesAvailable = true;
    scheduleConversationQuoteRevalidation(conversationKey);
    await waitForAssistantQuoteValidationForTests(conversationKey);

    assert.equal(
      assistantMessage.quoteDisplayOverride?.markdown,
      `> ${quote}\n>\n> Not a source quote`,
    );
    assert.notInclude(
      assistantMessage.quoteDisplayOverride?.markdown || "",
      "Eppler",
    );
  });

  it("preserves historical raw content during fast and background review", async function () {
    const quote =
      "A historical model interpretation currently appears as a sourced quotation.";
    const raw = `> ${quote}\n>\n> (Eppler et al., 2026, page 3)`;
    const staleCitation = buildQuoteCitation({
      quoteText: quote,
      citationLabel: "(Eppler et al., 2026)",
      sourceMatchKind: "progressive",
      sourceMatchSource: "context-text",
      contextItemId,
      itemId: paper.itemId,
      pageHintLabel: "3",
    });
    assert.isDefined(staleCitation);
    const source = installPdfSource(
      contextItemId,
      "The complete paper contains unrelated source wording.",
    );
    restoreSource = source.restore;
    const userMessage: Message = {
      role: "user",
      text: "Explain the result.",
      timestamp: 1,
      paperContexts: [paper],
    };
    const assistantMessage: Message = {
      role: "assistant",
      text: raw,
      quoteCitations: [staleCitation!],
      timestamp: 2,
    };
    chatHistory.set(conversationKey, [userMessage, assistantMessage]);

    finalizeAssistantMessageQuoteCitationsForTests(assistantMessage, {
      pairedUserMessage: userMessage,
      conversationKey,
    });
    assert.equal(assistantMessage.text, raw);
    assert.isUndefined(assistantMessage.quoteDisplayOverride);

    await waitForAssistantQuoteValidationForTests(conversationKey);

    assert.equal(assistantMessage.text, raw);
    assert.deepEqual(assistantMessage.quoteCitations, [staleCitation!]);
    assert.include(
      assistantMessage.quoteDisplayOverride?.markdown || "",
      "Not a source quote",
    );
  });

  it("leaves unresolved and open-ended source scopes unchanged", async function () {
    const quote =
      "A genuine quotation may belong to a source that is not yet available.";
    const source = installPdfSource(
      contextItemId,
      "The resolved paper contains unrelated wording.",
    );
    restoreSource = source.restore;
    const cases: Message[] = [
      {
        role: "user",
        text: "Compare these papers.",
        timestamp: 1,
        paperContexts: [
          paper,
          { ...paper, itemId: 0, contextItemId: 0, title: "Unresolved paper" },
        ],
      },
      {
        role: "user",
        text: "Compare this collection.",
        timestamp: 3,
        paperContexts: [paper],
        selectedCollectionContexts: [
          { collectionId: 17, libraryID: 1, name: "Drift" },
        ],
      },
    ];

    for (const [index, userMessage] of cases.entries()) {
      const assistantMessage: Message = {
        role: "assistant",
        text: `> ${quote}\n>\n> (Eppler et al., 2026)`,
        timestamp: index + 10,
      };
      chatHistory.set(conversationKey, [userMessage, assistantMessage]);
      finalizeAssistantMessageQuoteCitationsForTests(assistantMessage, {
        pairedUserMessage: userMessage,
        conversationKey,
      });
      await waitForAssistantQuoteValidationForTests(conversationKey);
      assert.isUndefined(assistantMessage.quoteDisplayOverride);
      assert.include(assistantMessage.text, "(Eppler et al., 2026)");
    }
  });
});
