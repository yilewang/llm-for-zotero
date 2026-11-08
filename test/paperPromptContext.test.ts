import { isSinglePaperConversation } from "../src/agent/context/requestTurnPaperScope";
import { assert } from "chai";
import { preparePaperPromptContext } from "../src/agent/context/paperPromptContext";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";
import type { PdfContext } from "../src/services/paperContent/types";
import type { PdfOutlineEntry } from "../src/services/paperContent/documentStructure";
import {
  renderAgentPromptEnvelope,
  composeAgentModelInput,
} from "../src/agent/model/messageBuilder";
import { buildAgentResourceContextPlan } from "../src/agent/context/resourceContextPlan";
import {
  buildChunkIndex,
  chunkPlainPdfText,
} from "../src/services/paperContent/pdfContext";
import { DISSERTATION_PAGES, joinPages } from "./fixtures/longdoc/pageTexts";

const paper = {
  libraryID: 1,
  itemId: 20,
  contextItemId: 21,
  title: "Complete paper",
  firstCreator: "Kim",
  year: "2026",
};
const chunks = [
  "The introduction motivates an investigation of neural representations over extended periods of time.",
  "The methods measured the activity of individual neurons across twelve recording sessions in five animals.",
  "The results show that population decoding remained stable despite changing individual neural responses.",
  "The discussion identifies the small sample size as a limitation and recommends replication in other species.",
];
const context = {
  title: paper.title,
  chunks,
  chunkMeta: chunks.map((text, chunkIndex) => ({
    chunkIndex,
    text,
    normalizedText: text,
    chunkKind: "body",
  })),
  fullLength: chunks.join("\n").length,
} as PdfContext;
const request = (extra = {}) =>
  resolvedAgentRequest({
    conversationKey: 900451,
    mode: "agent",
    libraryID: 1,
    userText: "Explain the paper",
    activePaperContext: paper,
    conversationKind: "paper",
    ...extra,
  });

describe("default paper prompt context", function () {
  it("delivers all sections once with stable source anchors across follow-up retrieval", async function () {
    const firstRequest = request();
    const first = await preparePaperPromptContext(firstRequest, {
      tokenBudget: 5000,
      load: async () => context,
    });
    assert.lengthOf(first.quoteCitations, 4);
    for (const text of chunks) assert.include(first.blocks[0], text);
    assert.include(first.blocks[0], "Complete extracted paper");
    const nextRequest = request({
      userText: "Read one more snippet about the methods",
      history: [{ role: "assistant", content: "Prior answer" }],
    });
    const next = await preparePaperPromptContext(nextRequest, {
      tokenBudget: 5000,
      load: async () => context,
    });
    assert.deepEqual(next, first);
    const plan = buildAgentResourceContextPlan(firstRequest);
    plan.paperContext = first;
    const initial = await renderAgentPromptEnvelope(firstRequest, [], [], plan);
    const followup = await renderAgentPromptEnvelope(nextRequest, [], [], plan);
    assert.deepEqual(
      initial.envelope.systemMessages,
      followup.envelope.systemMessages,
    );
    const messages = composeAgentModelInput(followup.envelope, {
      transcriptMessages: [
        {
          role: "tool",
          tool_call_id: "read-1",
          name: "paper_read",
          content: "Extra methods evidence",
        },
      ],
    });
    const paperMessage = messages.findIndex((message) =>
      String(message.content).includes("Complete extracted paper text"),
    );
    assert.isAbove(paperMessage, 0);
    assert.isBelow(
      paperMessage,
      messages.findIndex((message) => message.role === "tool"),
    );
    assert.equal((messages[paperMessage] as any).cachePolicy, "stable-prefix");
  });

  it("preserves explicit slash skills for one paper and resumes with added scope", async function () {
    const single = request({ forcedSkillIds: ["evidence-based-qa"] });
    assert.isTrue(isSinglePaperConversation(single));
    assert.deepEqual(single.forcedSkillIds, ["evidence-based-qa"]);
    const multi = request({
      selectedPaperContexts: [
        { ...paper, itemId: 30, contextItemId: 31, title: "Second paper" },
      ],
    });
    assert.isFalse(isSinglePaperConversation(multi));
    const before = await preparePaperPromptContext(single, {
      tokenBudget: 5000,
      load: async () => context,
    });
    const after = await preparePaperPromptContext(multi, {
      tokenBudget: 5000,
      load: async () => context,
    });
    assert.equal(after.blocks[0], before.blocks[0]);
    assert.lengthOf(after.blocks, 2);
    assert.notEqual(after.quoteCitations[0].id, after.quoteCitations[4].id);
    assert.isFalse(
      isSinglePaperConversation(
        request({
          selectedCollectionContexts: [
            { libraryID: 1, collectionId: 4, name: "Added collection" },
          ],
        }),
      ),
    );
  });

  it("reports capacity limits and unavailable text without claiming full coverage", async function () {
    const partial = await preparePaperPromptContext(request(), {
      tokenBudget: 220,
      load: async () => context,
    });
    assert.include(partial.blocks[0], "Partial text:");
    assert.notInclude(partial.blocks[0], "Complete extracted paper");
    assert.isBelow(partial.quoteCitations.length, 4);
    const missing = await preparePaperPromptContext(request(), {
      load: async () => undefined,
    });
    assert.include(missing.blocks[0], "Full text unavailable");
    assert.isEmpty(missing.quoteCitations);
  });

  it("refreshes source text instead of retaining stale content by conversation identity", async function () {
    const revised = await preparePaperPromptContext(request(), {
      tokenBudget: 5000,
      load: async () => ({ ...context, chunks: [chunks[1]] }),
    });
    assert.notInclude(revised.blocks[0], chunks[0]);
    assert.include(revised.blocks[0], chunks[1]);
  });

  it("gives each sentence run of a PDF-text chunk its own passage ID", async function () {
    // Zotero full-text and PDFWorker chunks have no blank lines, so one
    // metadata phrase used to cost the whole ~2,000-character chunk its ID.
    const sentences = [
      "We find that CA1 flexibly reconfigures a shared pool of neurons to integrate distinct inputs from upstream areas, and then selectively engages its cortical targets.",
      "These subspaces persist across different mazes but express spatial context selectivity.",
      "Neuronal membership in these subspaces is constrained by the intrinsic excitability of neurons and their laminar position within cell body layers.",
      "Finally, we show that input- and output-related subspaces are differentially reactivated during post-task sleep, especially during hippocampal sharp-wave ripples.",
      "Identifying input and output hippocampal subspaces required two complementary experiments that labelled projection neurons in each region.",
      "Received: 3 May 2022. Accepted: 1 March 2023. Published online: 12 April 2023.",
      "We performed silicon probe recordings in freely moving mice while they explored familiar and novel mazes over many consecutive days of training.",
      "Units were clustered automatically and curated manually, and only well-isolated single units with stable waveforms across the session were kept.",
      "Place fields were defined as contiguous regions where the firing rate exceeded twice the mean rate of the cell across the whole maze.",
      "Population vectors were compared across sessions with a cross-validated decoder that was trained on one day and tested on the following day.",
      "The decoder reached high accuracy within a session and degraded slowly across days, consistent with gradual drift of single-cell tuning.",
      "Together, these results suggest that the hippocampus multiplexes its inputs and outputs through partially overlapping neuronal subspaces.",
    ];
    const chunk = `2 | Nature | www.nature.com\nArticle\n${sentences.slice(0, 5).join(" ")}\n${sentences.slice(5).join(" ")}`;
    assert.isAbove(chunk.length, 1500);
    assert.notMatch(chunk, /\n\s*\n/);
    const pdfText = {
      title: paper.title,
      chunks: [chunk],
      chunkMeta: [
        {
          chunkIndex: 0,
          text: chunk,
          normalizedText: chunk,
          chunkKind: "body",
        },
      ],
      fullLength: chunk.length,
    } as PdfContext;
    const prepared = await preparePaperPromptContext(request(), {
      tokenBudget: 5000,
      load: async () => pdfText,
    });
    const block = prepared.blocks[0];
    // Before the bound the whole chunk was one passage, so one metadata
    // phrase ("Published online") cost all of it its ID.
    const markers =
      block.match(/^\[(?:passage Q_[^\]]+|no passage ID)\]$/gm) || [];
    assert.isAtLeast(markers.length, 2);
    assert.isNotEmpty(prepared.quoteCitations);
    for (const citation of prepared.quoteCitations) {
      assert.isAtMost(citation.quoteText.length, 1000);
      assert.include(chunk, citation.quoteText);
      assert.include(block, `[passage ${citation.id}]`);
    }
    // The sentences far from the metadata line keep an ID.
    assert.isTrue(
      prepared.quoteCitations.some((citation) =>
        citation.quoteText.includes(sentences[10]),
      ),
    );
    for (const sentence of sentences) assert.include(block, sentence);
    assert.notInclude(block, "[chunk");
  });

  it("keeps a blank-line paragraph within the bound as one passage", async function () {
    const paragraph = Array.from(
      { length: 9 },
      (_, index) =>
        `Sentence ${index + 1} of the methods describes one recording step in enough detail to be quoted as evidence.`,
    ).join(" ");
    assert.isAbove(paragraph.length, 850);
    assert.isAtMost(paragraph.length, 1000);
    const text = `${paragraph}\n\n${chunks[2]}`;
    const prepared = await preparePaperPromptContext(request(), {
      tokenBudget: 5000,
      load: async () => ({
        ...context,
        chunks: [text],
        chunkMeta: [{ ...context.chunkMeta[0], text, normalizedText: text }],
      }),
    });
    assert.deepEqual(
      prepared.quoteCitations.map((citation) => citation.quoteText),
      [paragraph, chunks[2]],
    );
  });

  describe("passage IDs cite body text", function () {
    const prepare = (text: string) =>
      preparePaperPromptContext(request(), {
        tokenBudget: 5000,
        load: async () => ({
          ...context,
          chunks: [text],
          chunkMeta: [{ ...context.chunkMeta[0], text, normalizedText: text }],
        }),
      });
    const flat = (text: string) => text.replace(/\s+/g, " ").trim();
    const unescapedDollars = (text: string) =>
      (text.match(/(?<!\\)\$/g) || []).length;

    it("gives a heading paragraph no ID and starts a heading-led paragraph's quote at its body", async function () {
      const title = "# Slow drift of hippocampal place codes across many weeks";
      const body =
        "Organisms continually tune their perceptual systems to the features they encounter in their environment.";
      const text = `${title}\n\n## Summary\n${body}\n\n${chunks[2]}`;
      const prepared = await prepare(text);
      assert.deepEqual(
        prepared.quoteCitations.map((citation) => citation.quoteText),
        [body, chunks[2]],
      );
      // The model still reads every paragraph, the headings included.
      assert.include(prepared.blocks[0], `[no passage ID]\n${title}`);
      assert.include(
        prepared.blocks[0],
        `[passage ${prepared.quoteCitations[0].id}]\n## Summary\n${body}`,
      );
    });

    it("trims a quote that a long-passage cut left inside a formula", async function () {
      // One long sentence, so the only sentence-shaped cut near the middle is
      // the ". B" inside the formula.
      const words = (count: number) =>
        Array.from({ length: count }, (_, i) => `step${i}`).join(" ");
      const tail =
        "Then the decoder was retrained on every session of the second cohort of animals.";
      const text = `Population activity was measured ${words(80)} with $\\alpha = 1 . B_{2}$ as the gain ${words(60)}. ${tail}`;
      assert.isAbove(text.length, 1000);
      const prepared = await prepare(text);
      assert.isNotEmpty(prepared.quoteCitations);
      for (const citation of prepared.quoteCitations) {
        assert.equal(
          unescapedDollars(citation.quoteText) % 2,
          0,
          citation.quoteText,
        );
        assert.include(flat(text), flat(citation.quoteText));
      }
      assert.include(
        prepared.quoteCitations.map((citation) => citation.quoteText),
        tail,
      );
    });

    it("never cuts a long passage inside a formula, so the formula keeps its passage ID", async function () {
      const words = (count: number) =>
        Array.from({ length: count }, (_, i) => `step${i}`).join(" ");
      const formula = "$\\alpha = 1 . B_{2}$";
      const text = `Population activity in the cortex was measured ${words(75)} with ${formula} as the gain ${words(75)}.`;
      assert.isAbove(text.length, 1000);
      const prepared = await prepare(text);
      const pieces = prepared.blocks
        .join("\n")
        .split(/\n\n/)
        .filter((piece) => /^\[(passage [^\]]+|no passage ID)\]/.test(piece));
      assert.isAtLeast(pieces.length, 1);
      for (const piece of pieces) {
        assert.equal(unescapedDollars(piece) % 2, 0, piece);
      }
      const holder = pieces.find((piece) => piece.includes("1 . B_{2}"));
      assert.isDefined(holder);
      assert.match(holder!, /^\[passage [^\]]+\]/);
      assert.isTrue(
        prepared.quoteCitations.some((citation) =>
          citation.quoteText.includes(formula),
        ),
      );
    });
  });

  it("counts the chunks that fit when the budget cuts the paper", async function () {
    for (const tokenBudget of [200, 230, 260, 290]) {
      const partial = await preparePaperPromptContext(request(), {
        tokenBudget,
        load: async () => context,
      });
      const included = chunks.filter((text) =>
        partial.blocks[0].includes(text),
      );
      const counted = /Partial text: (\d+)\/4 chunks/.exec(partial.blocks[0]);
      if (included.length === chunks.length) {
        assert.isNull(counted, String(tokenBudget));
        continue;
      }
      assert.equal(Number(counted?.[1]), included.length, String(tokenBudget));
      assert.deepEqual(included, chunks.slice(0, included.length));
    }
  });

  it("tells the model how to quote a passage that has no ID", async function () {
    const prepared = await preparePaperPromptContext(request(), {
      tokenBudget: 5000,
      load: async () => context,
    });
    assert.include(prepared.blocks[0], "never construct an ID");
    assert.include(prepared.blocks[0], "[no passage ID]");
    assert.notInclude(prepared.blocks[0], "Chunk numbers");
  });

  it("names passage IDs for sentence citations", async function () {
    const prepared = await preparePaperPromptContext(request(), {
      tokenBudget: 5000,
      load: async () => context,
    });
    assert.include(prepared.blocks[0], "[[cite:ID]] sentence citations");
    assert.notInclude(prepared.blocks[0], "paragraph citations");
  });

  describe("a document with chapters", function () {
    const BODY =
      "The argument continues with further detail on this page. ".repeat(45);
    const text = joinPages(DISSERTATION_PAGES.map((lines) => [...lines, BODY]));
    const parts = chunkPlainPdfText(text, "zotero-worker", {
      layout: { totalPages: DISSERTATION_PAGES.length },
      structure: { bookmarks: null },
    });
    const chaptered = {
      title: "Dissertation",
      ...parts,
      ...buildChunkIndex(parts.chunks),
      fullLength: text.length,
      sourceType: "zotero-worker",
    } as PdfContext;

    it("preloads the map of its parts, not its text", async function () {
      const prepared = await preparePaperPromptContext(request(), {
        tokenBudget: 1_000_000,
        load: async () => chaptered,
      });
      const block = prepared.blocks[0];
      assert.include(block, "s1 | Chapter 1:Introduction | pages 3–6 |");
      assert.include(
        block,
        "s4 | Chapter 2:Philosophical and historical background | pages 7–8 |",
      );
      assert.match(block, /\| ~\d+ tokens \| 2 sections/);
      assert.notInclude(block, "The argument continues");
      assert.notInclude(block, "This Dissertation is composed");
      assert.notInclude(block, "1.1Visual processing", "only the top level");
      assert.include(block, "paper_read");
      assert.include(block, "`>` blockquote");
      assert.include(block, "never construct an ID");
      assert.isEmpty(prepared.quoteCitations);
    });

    it("keeps the map block byte-stable for the same file", async function () {
      const first = await preparePaperPromptContext(request(), {
        load: async () => chaptered,
      });
      const second = await preparePaperPromptContext(
        request({ userText: "A different question" }),
        { load: async () => chaptered },
      );
      assert.equal(first.blocks[0], second.blocks[0]);
    });

    it("preloads the whole text when the user attached it as full text", async function () {
      const prepared = await preparePaperPromptContext(
        request({ fullTextPaperContexts: [paper] }),
        { tokenBudget: 1_000_000, load: async () => chaptered },
      );
      assert.include(prepared.blocks[0], "Complete extracted paper text");
      assert.include(prepared.blocks[0], "This Dissertation is composed");
    });
  });

  describe("a document whose whole text does not fit", function () {
    const PAGE_BODY = (page: number) =>
      `Page ${page} reports one more measurement of the drift. `.repeat(30);
    const pagedText = joinPages([
      ["Drift in a short paper", "1 Introduction", PAGE_BODY(1)],
      ["2 Methods", PAGE_BODY(2)],
      ["3 Results", PAGE_BODY(3)],
    ]);
    // Loaded as a chat loads it: an unchaptered text gets its page spans.
    const parts = chunkPlainPdfText(pagedText, "zotero-worker", {
      layout: { totalPages: 3 },
      structure: { bookmarks: null },
    });
    const paged = {
      title: "Drift",
      ...parts,
      ...buildChunkIndex(parts.chunks),
      fullLength: pagedText.length,
      sourceType: "zotero-worker",
    } as PdfContext;
    const { textPages: _textPages, ...withoutPages } = paged;
    const wholeTokens = paged.chunks.reduce(
      (sum, text) => sum + Math.ceil(text.length / 4),
      0,
    );

    it("gets its pages from the text's form feeds, chunk metadata unchanged", function () {
      assert.isUndefined(paged.documentStructure);
      assert.deepEqual(
        paged.textPages?.map((page) => page.firstLine),
        ["Drift in a short paper", "2 Methods", "3 Results"],
      );
      assert.isTrue(paged.textPages!.every((page) => page.tokens > 0));
      assert.isTrue(
        paged.chunkMeta.every((meta) => meta.pageStart === undefined),
      );
      const indexed = chunkPlainPdfText(pagedText, "zotero-worker", {
        layout: { totalPages: 3 },
      });
      assert.deepEqual(indexed.chunkMeta, paged.chunkMeta);
      assert.isUndefined(indexed.textPages);
      // A split that does not match the PDF's page count gives none.
      assert.isUndefined(
        chunkPlainPdfText(pagedText, "zotero-worker", {
          layout: { totalPages: 4 },
          structure: { bookmarks: null },
        }).textPages,
      );
    });

    it("numbers its pages past a blank first page the bookmarks show", function () {
      const bookmarks = [
        ["1 Introduction", 1],
        ["2 Methods", 2],
        ["3 Results", 3],
      ].map(([title, pageIndex]) => ({
        depth: 0,
        title: String(title),
        pageIndex: Number(pageIndex),
        top: null,
        fitsPage: false,
      }));
      const shifted = chunkPlainPdfText(pagedText, "zotero-worker", {
        layout: { totalPages: 4 },
        structure: { bookmarks },
      });
      assert.isUndefined(shifted.documentStructure);
      assert.deepEqual(
        shifted.textPages?.map((page) => page.firstLine),
        ["", "Drift in a short paper", "2 Methods", "3 Results"],
      );
      assert.equal(shifted.textPages?.[0].tokens, 0);
      // Without bookmarks no shift can be shown.
      assert.isUndefined(
        chunkPlainPdfText(pagedText, "zotero-worker", {
          layout: { totalPages: 4 },
          structure: { bookmarks: null },
        }).textPages,
      );
    });

    it("keeps today's whole-text block when it fits", async function () {
      const options = { tokenBudget: 1_000_000 };
      const prepared = await preparePaperPromptContext(request(), {
        ...options,
        load: async () => paged,
      });
      const plain = await preparePaperPromptContext(request(), {
        ...options,
        load: async () => withoutPages,
      });
      assert.include(prepared.blocks[0], "Complete extracted paper text");
      assert.equal(prepared.blocks[0], plain.blocks[0]);
      assert.deepEqual(prepared.quoteCitations, plain.quoteCitations);
    });

    it("preloads a page map instead of partial text", async function () {
      const tokenBudget = Math.floor(wholeTokens / 2);
      const prepared = await preparePaperPromptContext(request(), {
        tokenBudget,
        load: async () => paged,
      });
      const block = prepared.blocks[0];
      assert.notInclude(block, "Partial text");
      assert.notInclude(block, "reports one more measurement");
      assert.match(block, /^page 1 \| ~\d+ tokens \| Drift in a short paper$/m);
      assert.match(block, /^page 2 \| ~\d+ tokens \| 2 Methods$/m);
      assert.match(block, /^page 3 \| ~\d+ tokens \| 3 Results$/m);
      assert.include(block, "pages");
      assert.include(block, "paper_read");
      assert.include(block, "never construct an ID");
      assert.isEmpty(prepared.quoteCitations);
      const again = await preparePaperPromptContext(
        request({ userText: "A different question" }),
        { tokenBudget, load: async () => paged },
      );
      assert.equal(again.blocks[0], block, "byte-stable for one file state");
    });

    it("keeps today's partial text when the text has no page spans", async function () {
      const prepared = await preparePaperPromptContext(request(), {
        tokenBudget: Math.floor(wholeTokens / 2),
        load: async () => withoutPages,
      });
      assert.include(prepared.blocks[0], "Partial text:");
    });

    it("keeps the user's explicit full-text attach as today", async function () {
      const tokenBudget = Math.floor(wholeTokens / 2);
      const attached = await preparePaperPromptContext(
        request({ fullTextPaperContexts: [paper] }),
        { tokenBudget, load: async () => paged },
      );
      const today = await preparePaperPromptContext(
        request({ fullTextPaperContexts: [paper] }),
        { tokenBudget, load: async () => withoutPages },
      );
      assert.include(attached.blocks[0], "Partial text:");
      assert.equal(attached.blocks[0], today.blocks[0]);
    });

    it("decides on the block's real cost: at the boundary it is whole or a page map, never partial", async function () {
      // Many short paragraphs: their passage-ID prefixes cost more than the
      // raw chunk text suggests.
      const para = (page: number, index: number) =>
        `Paragraph ${index} on page ${page} gives one finding about drift in cortex.`;
      const page = (number: number) =>
        Array.from({ length: 25 }, (_, index) => para(number, index)).join(
          "\n\n",
        );
      const text = joinPages([
        ["Title", page(1)],
        ["2 Methods", page(2)],
        ["3 Results", page(3)],
      ]);
      const chunked = chunkPlainPdfText(text, "zotero-worker", {
        layout: { totalPages: 3 },
        structure: { bookmarks: null },
      });
      const many = {
        title: "Many paragraphs",
        ...chunked,
        ...buildChunkIndex(chunked.chunks),
        fullLength: text.length,
        sourceType: "zotero-worker",
      } as PdfContext;
      const kind = async (tokenBudget: number) => {
        const block = (
          await preparePaperPromptContext(request(), {
            tokenBudget,
            load: async () => many,
          })
        ).blocks[0];
        return block.includes("Partial text")
          ? "partial"
          : block.includes("Complete extracted")
            ? "complete"
            : /^page 1 \| /m.test(block)
              ? "pagemap"
              : "other";
      };
      // The smallest budget that holds the whole block.
      let low = 1;
      let high = 1_000_000;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if ((await kind(middle)) === "complete") high = middle;
        else low = middle + 1;
      }
      const raw = many.chunks.reduce(
        (sum, chunk) => sum + Math.ceil(chunk.length / 4),
        0,
      );
      assert.isAbove(low, raw, "the passage prefixes cost more than raw text");
      assert.equal(await kind(low - 1), "pagemap");
      for (const budget of [raw - 1, raw, raw + 1, Math.floor((raw + low) / 2)])
        assert.equal(await kind(budget), "pagemap", String(budget));
      const atBoundary = await preparePaperPromptContext(request(), {
        tokenBudget: low,
        load: async () => many,
      });
      const roomy = await preparePaperPromptContext(request(), {
        tokenBudget: 1_000_000,
        load: async () => many,
      });
      assert.equal(atBoundary.blocks[0], roomy.blocks[0], "the fitting block");
    });

    it("writes only the document's size when its page map does not fit either", async function () {
      const mapOnly = await preparePaperPromptContext(request(), {
        tokenBudget: Math.floor(wholeTokens / 2),
        load: async () => paged,
      });
      const mapTokens = Math.ceil(mapOnly.blocks[0].length / 4);
      const prepared = await preparePaperPromptContext(request(), {
        tokenBudget: mapTokens - 1,
        load: async () => paged,
      });
      const block = prepared.blocks[0];
      assert.notMatch(block, /^page 1 \| /m);
      assert.notInclude(block, "reports one more measurement");
      const total = paged.textPages!.reduce(
        (sum, page) => sum + page.tokens,
        0,
      );
      assert.include(block, `its 3 pages hold about ${total} tokens`);
      assert.include(block, "query");
      assert.include(block, "pages");
      assert.isEmpty(prepared.quoteCitations);
    });

    it("spends a page map's cost from the budget a second paper shares", async function () {
      const second = {
        ...paper,
        itemId: 30,
        contextItemId: 31,
        title: "Second",
      };
      const twoPapers = request({ selectedPaperContexts: [second] });
      const load = async (ref: { itemId?: number }) =>
        ref.itemId === second.itemId ? context : paged;
      const alone = await preparePaperPromptContext(request(), {
        tokenBudget: Math.floor(wholeTokens / 2),
        load: async () => paged,
      });
      const mapTokens = Math.ceil(alone.blocks[0].length / 4);
      const secondAlone = await preparePaperPromptContext(
        request({ activePaperContext: second }),
        { tokenBudget: 1_000_000, load: async () => context },
      );
      const secondTokens = Math.ceil(secondAlone.blocks[0].length / 4) + 200;
      // Room for the map and the second paper whole, but not for this
      // paper's text: the map is spent, and the second paper still fits.
      const shared = await preparePaperPromptContext(twoPapers, {
        tokenBudget: mapTokens + secondTokens,
        load,
      });
      assert.lengthOf(shared.blocks, 2);
      assert.match(shared.blocks[0], /^page 1 \| /m);
      assert.include(shared.blocks[1], "Complete extracted paper text");
      // With room for the map alone, the second paper gets what is left.
      const tight = await preparePaperPromptContext(twoPapers, {
        tokenBudget: mapTokens + 60,
        load,
      });
      assert.match(tight.blocks[0], /^page 1 \| /m);
      assert.notInclude(tight.blocks[1], "Complete extracted paper text");
    });
  });

  describe("a bookmarked document whose whole text does not fit", function () {
    const BODY = (topic: string) =>
      `The ${topic} adds one more measurement of the drift. `.repeat(30);
    const bookmarkedText = joinPages([
      [
        "Drift in a bookmarked paper",
        "Abstract",
        "We track drift.",
        "1 Introduction",
        BODY("introduction"),
      ],
      [
        BODY("introduction"),
        "2 Methods",
        BODY("method"),
        "2.1 Data",
        BODY("data"),
      ],
      [BODY("data"), "3 Results", BODY("result")],
    ]);
    const bookmarks = [
      ["1 Introduction", 0, 0],
      ["2 Methods", 1, 0],
      ["2.1 Data", 1, 1],
      ["3 Results", 2, 0],
    ].map(([title, pageIndex, depth]) => ({
      depth: Number(depth),
      title: String(title),
      pageIndex: Number(pageIndex),
      top: null,
      fitsPage: false,
    }));
    const load = (withBookmarks: PdfOutlineEntry[] | null) => {
      const parts = chunkPlainPdfText(bookmarkedText, "zotero-worker", {
        layout: { totalPages: 3 },
        structure: { bookmarks: withBookmarks },
      });
      return {
        title: "Drift",
        ...parts,
        ...buildChunkIndex(parts.chunks),
        fullLength: bookmarkedText.length,
        sourceType: "zotero-worker",
      } as PdfContext;
    };
    const bookmarked = load(bookmarks);
    const unbookmarked = load(null);
    const wholeTokens = bookmarked.chunks.reduce(
      (sum, text) => sum + Math.ceil(text.length / 4),
      0,
    );

    it("stays unchaptered, chunk metadata unchanged, with its bookmarks' sections", function () {
      assert.isUndefined(bookmarked.documentStructure);
      assert.deepEqual(bookmarked.chunkMeta, unbookmarked.chunkMeta);
      assert.isUndefined(unbookmarked.bookmarkSections);
      const sections = bookmarked.bookmarkSections!.sections;
      assert.deepEqual(
        sections.map((section) => [
          section.title,
          section.level,
          section.pageStart,
        ]),
        [
          ["(before the first section)", 1, 0],
          ["1 Introduction", 1, 0],
          ["2 Methods", 1, 1],
          ["2.1 Data", 2, 1],
          ["3 Results", 1, 2],
        ],
      );
      // Each starts at the line with its title.
      for (const section of sections.slice(1))
        assert.isTrue(
          bookmarkedText.slice(section.charStart).startsWith(section.title),
          section.title,
        );
      // Background indexing computes none.
      assert.isUndefined(
        chunkPlainPdfText(bookmarkedText, "zotero-worker", {
          layout: { totalPages: 3 },
        }).bookmarkSections,
      );
    });

    it("preloads its bookmarks' section map instead of its page map", async function () {
      const tokenBudget = Math.floor(wholeTokens / 2);
      const prepared = await preparePaperPromptContext(request(), {
        tokenBudget,
        load: async () => bookmarked,
      });
      const block = prepared.blocks[0];
      assert.notInclude(block, "adds one more measurement");
      assert.notInclude(block, "Partial text");
      assert.notMatch(block, /^page 1 \| /m);
      assert.match(
        block,
        /^s1 \| 1 Introduction \| pages 1–2 \| ~\d+ tokens$/m,
      );
      assert.match(
        block,
        /^s2 \| 2 Methods \| pages 2–3 \| ~\d+ tokens \| 1 section$/m,
      );
      assert.match(block, /^s4 \| 3 Results \| page 3 \| ~\d+ tokens$/m);
      assert.include(block, "sectionIds");
      assert.include(block, "never construct an ID");
      assert.isEmpty(prepared.quoteCitations);
      const again = await preparePaperPromptContext(
        request({ userText: "A different question" }),
        { tokenBudget, load: async () => bookmarked },
      );
      assert.equal(again.blocks[0], block, "byte-stable for one file state");
    });

    it("keeps today's whole-text block, byte-identical, when it fits", async function () {
      const options = { tokenBudget: 1_000_000 };
      const prepared = await preparePaperPromptContext(request(), {
        ...options,
        load: async () => bookmarked,
      });
      const today = await preparePaperPromptContext(request(), {
        ...options,
        load: async () => unbookmarked,
      });
      assert.include(prepared.blocks[0], "Complete extracted paper text");
      assert.equal(prepared.blocks[0], today.blocks[0]);
      assert.deepEqual(prepared.quoteCitations, today.quoteCitations);
    });

    it("gets the page map without bookmarks", async function () {
      const prepared = await preparePaperPromptContext(request(), {
        tokenBudget: Math.floor(wholeTokens / 2),
        load: async () => unbookmarked,
      });
      assert.match(prepared.blocks[0], /^page 1 \| /m);
      assert.notMatch(prepared.blocks[0], /^s1 \| /m);
    });

    it("keeps the user's explicit full-text attach as today", async function () {
      const tokenBudget = Math.floor(wholeTokens / 2);
      const attached = await preparePaperPromptContext(
        request({ fullTextPaperContexts: [paper] }),
        { tokenBudget, load: async () => bookmarked },
      );
      const today = await preparePaperPromptContext(
        request({ fullTextPaperContexts: [paper] }),
        { tokenBudget, load: async () => unbookmarked },
      );
      assert.include(attached.blocks[0], "Partial text:");
      assert.equal(attached.blocks[0], today.blocks[0]);
    });

    it("writes only the document's size when its section map does not fit either", async function () {
      const mapOnly = await preparePaperPromptContext(request(), {
        tokenBudget: Math.floor(wholeTokens / 2),
        load: async () => bookmarked,
      });
      const prepared = await preparePaperPromptContext(request(), {
        tokenBudget: Math.ceil(mapOnly.blocks[0].length / 4) - 1,
        load: async () => bookmarked,
      });
      const block = prepared.blocks[0];
      assert.notMatch(block, /^s1 \| /m);
      assert.include(block, "This document is long: its 3 pages hold about");
    });
  });
});
