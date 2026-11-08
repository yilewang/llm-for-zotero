import { isSinglePaperConversation } from "../src/agent/context/requestTurnPaperScope";
import { assert } from "chai";
import { preparePaperPromptContext } from "../src/agent/context/paperPromptContext";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";
import type { PdfContext } from "../src/services/paperContent/types";
import {
  renderAgentPromptEnvelope,
  composeAgentModelInput,
} from "../src/agent/model/messageBuilder";
import { buildAgentResourceContextPlan } from "../src/agent/context/resourceContextPlan";

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
});
