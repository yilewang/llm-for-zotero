/**
 * paper_digest reads each paper for the read scope the user named, against
 * real Zotero items, real PDFs and their real extracted text:
 * - "abstract and results": the abstract from the Zotero abstract field
 *   when it has one, else the PDF's abstract; the results as the reader
 *   model picks them from the PDF's chunk outline; a PDF the reader finds
 *   neither part in is named, with the reader's reason, and nothing of it
 *   is read.
 * - abstracts only: no model call; each abstract comes back with its
 *   citation id, also for an item with no attachment, and the answer-time
 *   quote check (the real gate) keeps that id, because it reads the item's
 *   Zotero abstract field, and refuses a quote the field does not hold.
 *
 * - paper_read with sections and no query: the whole named sections of
 *   each paper (the results as the reader model picks them) with a citation
 *   id per passage; a paper with none of them is named, with the reader's
 *   reason, and nothing of it is read.
 * - paper_read mode:'full': its exact evidence carries citation ids, and
 *   the answer-time quote check keeps them and refuses a made-up quote.
 *
 * The reader model is a scripted stub (no live provider) that answers the
 * section picker's prompt apart from the digest prompt; the item records,
 * the PDF text extraction, the section picker, the digest worker and
 * paper_read are the plugin's own. The abstract fields are read back from Zotero.
 */
import { assert } from "chai";
import { resolvedAgentRequest } from "../test/helpers/resolvedAgentRequest";
import { namesOf } from "../test/helpers/sectionPickerFixtures";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { PdfService } from "../src/agent/services/pdfService";
import { createZoteroPaperDigestSources } from "../src/agent/digests/digestJobHost";
import { DIGEST_FAILURE_REASONS } from "../src/agent/digests/paperDigestWorker";
import {
  SECTION_PICK_TASK_LINE,
  clearSectionPickCache,
} from "../src/agent/digests/sectionPicker";
import { applyAssistantMessageQuoteGate } from "../src/modules/contextPanel/quoteValidation/gate";
import { buildCachedQuoteSourceEvidenceForPaperContexts } from "../src/modules/contextPanel/quoteValidation/sourceEvidence";
import { getMessageQuoteDisplay } from "../src/modules/contextPanel/quoteRenderPlan";
import { buildQuoteCitation } from "../src/services/quotes/quoteCitations";
import type { Message } from "../src/modules/contextPanel/types";
import { createPaperReadTool } from "../src/agent/tools/read/paperRead";
import { warmQuoteSourceCachesForPaperContexts } from "../src/modules/contextPanel/quoteValidation/sourceEvidence";
import type { QuoteCitation } from "../src/shared/types";
import {
  clearPaperDigestRunBounds,
  createPaperDigestTool,
  type PaperDigestResult,
} from "../src/agent/tools/read/paperDigest";
import type { ReaderAdapterFactories } from "../src/agent/reader/resolveReader";
import type { ReaderCompletion } from "../src/shared/readerCompletion";
import type { AgentToolContext } from "../src/agent/types";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

declare const Zotero: any;

const FIELD_ABSTRACT =
  "This record abstract says that place cell drift leaves decoding of position intact across ten days.";
const P1_RESULTS =
  "Decoding of position stayed above chance on every one of the ten recorded days.";
const P2_ABSTRACT =
  "We ask whether representational drift in hippocampal place cells impairs the decoding of position.";
const P2_RESULTS =
  "Population vectors rotated slowly while the decoder kept its accuracy across sessions.";
const P3_TEXT =
  "Representational drift was measured over ten days in hippocampal recordings of freely moving mice.";

/** Sentences long enough that each page is its own run of text. */
const filler = (topic: string) =>
  Array.from(
    { length: 24 },
    (_, index) =>
      `Sentence ${index + 1} describes the ${topic} in plain and neutral detail for this fixture.`,
  ).join(" ");

const USER_TEXT = "Read the abstract and results of every paper here";
const PAPER_READ_USER_TEXT = "Read the abstract and results of these papers";
/** What the scripted reader says paper three lacks (`scriptedPick`). */
const THREE_NOT_FOUND = {
  kind: "a running description of recordings",
  reason: "It has no abstract and no results section.",
};

type DigestRow = PaperDigestResult["papers"][number] & Record<string, any>;

describe("workflow: paper_digest reads what the read scope names", function () {
  this.timeout(180000);
  let api: WorkflowTestApi;
  let libraryID: number;
  const fixtures: WorkflowTestFixture[] = [];
  const recordOnly: number[] = [];
  let withField: WorkflowTestFixture;
  let pdfAbstract: WorkflowTestFixture;
  let noHeadings: WorkflowTestFixture;
  let fieldOnly: number;

  before(async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    api = Zotero.LLMForZotero.api.workflowTest;
    await api.reset();
    libraryID = Zotero.Libraries.userLibraryID;
    const stamp = Date.now();
    // Results first: the PDF text opens with its Results heading.
    withField = await api.createPaperWithPdfFixture({
      title: `Drift with a record abstract ${stamp}`,
      pages: [
        `Results. ${P1_RESULTS} ${filler("results")}`,
        `Discussion. ${filler("discussion")}`,
      ],
    });
    pdfAbstract = await api.createPaperWithPdfFixture({
      title: `Drift with a PDF abstract ${stamp}`,
      pages: [
        `Abstract. ${P2_ABSTRACT} ${filler("abstract")}`,
        `Results. ${P2_RESULTS} ${filler("results")}`,
      ],
    });
    noHeadings = await api.createPaperWithPdfFixture({
      title: `Drift with no headings ${stamp}`,
      pages: [`${P3_TEXT} ${filler("recordings")}`],
    });
    fixtures.push(withField, pdfAbstract, noHeadings);
    const first = Zotero.Items.get(withField.parentItemId);
    first.setField("abstractNote", FIELD_ABSTRACT);
    await first.saveTx();
    const record = new Zotero.Item("journalArticle");
    record.libraryID = libraryID;
    record.setField("title", `Drift record without a PDF ${stamp}`);
    record.setField("abstractNote", FIELD_ABSTRACT);
    fieldOnly = await record.saveTx();
    recordOnly.push(fieldOnly);
  });

  after(async function () {
    clearPaperDigestRunBounds();
    clearSectionPickCache();
    for (const fixture of fixtures) await api.cleanupFixture(fixture);
    for (const id of recordOnly) {
      const item = Zotero.Items.get(id);
      if (item) await item.eraseTx();
    }
  });

  /**
   * A reader that records each call. A section pick (the prompt that opens
   * with `SECTION_PICK_TASK_LINE`) is answered by `pick` and recorded in
   * `pickPrompts`; any other prompt is a digest call, recorded in `prompts`,
   * and quotes the fixture's sentences.
   */
  function stubReader(
    pick: (prompt: string) => unknown = () => {
      throw new Error("this call must not pick sections");
    },
  ) {
    const prompts: string[] = [];
    const pickPrompts: string[] = [];
    const complete: ReaderCompletion = async (prompt) => {
      if (prompt.includes(SECTION_PICK_TASK_LINE)) {
        pickPrompts.push(prompt);
        return { text: JSON.stringify(pick(prompt)) };
      }
      prompts.push(prompt);
      return {
        text: JSON.stringify({
          answer: "The paper's named sections, as read.",
          evidence: [FIELD_ABSTRACT, P1_RESULTS, P2_ABSTRACT, P2_RESULTS].map(
            (quote) => ({ section: "", quote }),
          ),
        }),
      };
    };
    const factories: ReaderAdapterFactories = {
      turnModel: () => complete,
      codexResponses: () => complete,
      claudeBridge: () => complete,
    };
    return { prompts, pickPrompts, complete, factories };
  }

  /**
   * The picker's reply per paper, from the prompt's chunk outline (lines
   * `c0 | page 1 | 123 chars | <first line>`):
   * - a prompt that asks for the results alone: the chunk run whose first
   *   line starts "Results." (the abstract was served by the abstract rule);
   * - a prompt that also asks for the abstract: the paper has neither
   *   (the abstract rule found no abstract), so both are none, with why.
   */
  function scriptedPick(prompt: string): unknown {
    const names = namesOf(prompt);
    if (names.includes("abstract"))
      return {
        parts: [
          { name: "abstract", kind: "abstract", none: true },
          { name: "results", none: true },
        ],
        paper: THREE_NOT_FOUND,
      };
    const line = prompt
      .split("\n")
      .find(
        (entry) =>
          /^c\d+(?:-\d+)? \|/.test(entry) &&
          (entry.split(" | ").pop() || "").startsWith("Results."),
      );
    const range = /^c(\d+)(?:-(\d+))?/.exec(line || "");
    if (!range) throw new Error("no chunk of the outline starts 'Results.'");
    return {
      parts: [
        {
          name: "results",
          chunks: [
            { from: Number(range[1]), to: Number(range[2] ?? range[1]) },
          ],
        },
      ],
    };
  }

  function tool(reader: ReturnType<typeof stubReader>) {
    return createPaperDigestTool({
      ...createZoteroPaperDigestSources({
        zoteroGateway: new ZoteroGateway(),
        pdfService: new PdfService(),
      }),
      readerFactories: reader.factories,
      wait: async () => undefined,
    });
  }

  /** A Codex MCP turn's request, resolved as the MCP server resolves it. */
  function context(runId: string): AgentToolContext {
    const request = resolvedAgentRequest({
      conversationKey: 0,
      mode: "agent",
      userText: USER_TEXT,
      libraryID,
      model: "gpt-workflow",
    });
    Object.assign(request, {
      authMode: "codex_app_server",
      providerProtocol: "codex_responses",
      exhaustiveReadBackend: "codex_responses",
      executionContext: { permissionOwner: "external_runtime" },
    });
    return {
      request,
      item: null,
      currentAnswerText: "",
      modelName: "workflow",
      runId,
    } as unknown as AgentToolContext;
  }

  async function call(
    digestTool: ReturnType<typeof tool>,
    input: Record<string, unknown>,
    runId: string,
  ): Promise<PaperDigestResult> {
    const validated = digestTool.validate!(input);
    assert.isTrue(validated.ok, JSON.stringify(validated));
    if (!validated.ok) throw new Error("invalid input");
    return (await digestTool.execute(
      validated.value,
      context(runId),
    )) as PaperDigestResult;
  }

  const rowOf = (result: PaperDigestResult, itemId: number) =>
    result.papers.find((row) => row.itemId === itemId) as DigestRow;

  it("reads the abstract and results of each paper from the right source and names the paper with no headings", async function () {
    // Native readback: the record abstracts are what Zotero holds.
    const first = Zotero.Items.get(withField.parentItemId);
    await first.reload();
    assert.equal(first.getField("abstractNote"), FIELD_ABSTRACT);
    assert.equal(
      Zotero.Items.get(pdfAbstract.parentItemId).getField("abstractNote"),
      "",
    );

    clearSectionPickCache();
    const reader = stubReader(scriptedPick);
    const result = await call(
      tool(reader),
      {
        targets: [
          withField.parentItemId,
          pdfAbstract.parentItemId,
          noHeadings.parentItemId,
        ],
        instruction: "Report each paper's abstract and results",
        read: { source: "sections", sections: ["abstract", "results"] },
      },
      `scope-sections-${Date.now()}`,
    );

    const one = rowOf(result, withField.parentItemId);
    assert.equal(one.status, "digested", JSON.stringify(one));
    // The abstract is the Zotero field; the results are the chunk the
    // reader picked, named "PDF text" (this extraction gives no page
    // numbers), for "results".
    assert.deepEqual(one.source.covered, [
      "Abstract",
      "PDF text (for: results)",
    ]);
    assert.include(one.source.textSource, "Zotero abstract field");
    const oneIds = one.evidence.map((entry: any) => entry.quoteCitationId);
    assert.isNotEmpty(oneIds.filter(Boolean), JSON.stringify(one.evidence));
    for (const id of oneIds) assert.match(id, /^Q_/);
    const oneQuotes = one.evidence.map((entry: any) => entry.quote);
    assert.include(oneQuotes, FIELD_ABSTRACT);
    assert.include(oneQuotes, P1_RESULTS);

    const two = rowOf(result, pdfAbstract.parentItemId);
    assert.equal(two.status, "digested", JSON.stringify(two));
    assert.include(two.source.textSource, "PDF abstract");
    assert.deepEqual(two.source.covered, [
      "Abstract",
      "PDF text (for: results)",
    ]);
    assert.equal(two.source.bounds, "approximate");
    const twoQuotes = two.evidence.map((entry: any) => entry.quote);
    assert.include(twoQuotes, P2_ABSTRACT);
    assert.include(twoQuotes, P2_RESULTS);
    assert.notInclude(twoQuotes, FIELD_ABSTRACT);

    // The reader found neither part in paper three: the row is not
    // digested, carries the reader's reason, and nothing of the paper is read.
    const three = rowOf(result, noHeadings.parentItemId);
    assert.equal(three.status, "failed", JSON.stringify(three));
    assert.equal(three.reason, DIGEST_FAILURE_REASONS.noMatchingSections);
    assert.deepEqual(three.notFound, THREE_NOT_FOUND);
    assert.include(result.note, "Nothing read for");
    assert.include(result.note, `item:${noHeadings.parentItemId}`);
    assert.include(result.note, THREE_NOT_FOUND.reason);

    // One pick per paper whose names the abstract rule did not serve whole:
    // papers one and two (the abstract rule serves "abstract"; "results" is
    // picked) and paper three (the rule finds no abstract, so "abstract" is
    // picked with "results"). The pick is made once per paper.
    assert.lengthOf(reader.pickPrompts, 3);
    assert.sameMembers(
      reader.pickPrompts.map((prompt) => namesOf(prompt).join("+")),
      ["results", "results", "abstract+results"],
    );
    // The call names no `question`, so each pick carries the user's request.
    for (const prompt of reader.pickPrompts) assert.include(prompt, USER_TEXT);
    // The model digested the two papers it was given, never the third's
    // text. The pick prompts show each chunk's first line by design, so the
    // check is on digest prompts only.
    assert.lengthOf(reader.prompts, 2);
    for (const prompt of reader.prompts)
      assert.notInclude(prompt, P3_TEXT.slice(0, 40));
    assert.notInclude(
      reader.prompts.join("\n"),
      "Sentence 1 describes the discussion",
    );
  });

  it("returns abstracts as written with citation ids and makes no model call", async function () {
    const reader = stubReader();
    const result = await call(
      tool(reader),
      {
        targets: [
          withField.parentItemId,
          pdfAbstract.parentItemId,
          noHeadings.parentItemId,
          fieldOnly,
        ],
        instruction: "Give each paper's abstract",
        read: { source: "abstract" },
      },
      `scope-abstracts-${Date.now()}`,
    );
    assert.lengthOf(reader.prompts, 0, "no model call for abstracts");
    assert.lengthOf(reader.pickPrompts, 0, "no pick call for abstracts");

    const one = rowOf(result, withField.parentItemId);
    assert.equal(one.status, "digested");
    assert.equal(one.answer, FIELD_ABSTRACT);
    assert.equal(one.source.textSource, "Zotero abstract field");
    assert.match(one.evidence[0].quoteCitationId, /^Q_/);
    assert.lengthOf(one.quoteCitations, 1);

    const two = rowOf(result, pdfAbstract.parentItemId);
    assert.equal(two.status, "digested");
    assert.equal(two.source.textSource, "PDF abstract");
    assert.include(two.answer, P2_ABSTRACT);
    assert.notInclude(two.answer, P2_RESULTS);
    assert.match(two.evidence[0].quoteCitationId, /^Q_/);

    const three = rowOf(result, noHeadings.parentItemId);
    assert.equal(three.status, "failed");
    assert.equal(three.reason, DIGEST_FAILURE_REASONS.noAbstract);

    // An item with no attachment is still read for its record's abstract.
    const four = rowOf(result, fieldOnly);
    assert.equal(four.status, "digested", JSON.stringify(four));
    assert.equal(four.answer, FIELD_ABSTRACT);
    assert.equal(four.contextItemId, fieldOnly);
    assert.match(four.evidence[0].quoteCitationId, /^Q_/);
    assert.equal(
      Zotero.Items.get(fieldOnly).getField("abstractNote"),
      FIELD_ABSTRACT,
    );
  });
  it("keeps an abstract citation's id through the answer-time quote check for an item with no PDF", async function () {
    const reader = stubReader();
    const result = await call(
      tool(reader),
      {
        targets: [fieldOnly],
        instruction: "Give the paper's abstract",
        read: { source: "abstract" },
      },
      `scope-abstract-gate-${Date.now()}`,
    );
    const row = rowOf(result, fieldOnly);
    assert.equal(row.status, "digested", JSON.stringify(row));
    const citation = row.quoteCitations[0];
    assert.equal(citation.sourceChunkKind, "abstract");

    // Two papers in scope require body evidence, as a collection scope does;
    // the record-only item has no PDF and no page text anywhere.
    const papers = [
      {
        itemId: fieldOnly,
        contextItemId: fieldOnly,
        title: Zotero.Items.get(fieldOnly).getField("title"),
      },
      {
        itemId: withField.parentItemId,
        contextItemId: withField.pdfAttachmentId,
        title: Zotero.Items.get(withField.parentItemId).getField("title"),
      },
    ];
    const finalize = async (record: any) => {
      const message: Message = {
        role: "assistant",
        text: `The record says so. [[quote:${record.id}]]`,
        timestamp: Date.now(),
        quoteCitations: [record],
      };
      await applyAssistantMessageQuoteGate(
        message,
        message.text,
        message.quoteCitations,
        buildCachedQuoteSourceEvidenceForPaperContexts(papers),
        {
          pairedUserMessage: {
            role: "user",
            text: "Give the abstracts",
            timestamp: 0,
            paperContexts: papers,
          } as Message,
        },
      );
      return getMessageQuoteDisplay(message);
    };
    const kept = await finalize(citation);
    assert.include(
      (kept.quoteCitations || []).map((entry) => entry.id),
      citation.id,
      kept.markdown,
    );
    assert.notInclude(kept.markdown, "Not a source quote");

    // A quote the Zotero abstract field does not hold is still refused.
    const fabricated = buildQuoteCitation({
      quoteText:
        "Dentate gyrus granule cells were silenced by optogenetic stimulation during every learning trial.",
      sourceMatchKind: "exact",
      sourceMatchSource: "context-text",
      citationLabel: citation.citationLabel,
      sourceSectionLabel: "Abstract",
      sourceChunkKind: "abstract",
      contextItemId: citation.contextItemId,
      itemId: fieldOnly,
      allowShortQuoteText: true,
    })!;
    const refused = await finalize(fabricated);
    assert.notInclude(
      (refused.quoteCitations || []).map((entry) => entry.id),
      fabricated.id,
      refused.markdown,
    );
  });
  /** paper_read over the plugin's own services, reading as the turn would. */
  function paperReadTool(
    fullReadAnalyzer?: Parameters<typeof createPaperReadTool>[5],
    readerOptions?: Parameters<typeof createPaperReadTool>[6],
  ) {
    return createPaperReadTool(
      new PdfService(),
      {} as never,
      {} as never,
      new ZoteroGateway(),
      undefined,
      fullReadAnalyzer,
      readerOptions,
    );
  }

  async function readPapers(
    readTool: ReturnType<typeof paperReadTool>,
    input: Record<string, unknown>,
  ): Promise<any> {
    const validated = readTool.validate!(input);
    assert.isTrue(validated.ok, JSON.stringify(validated));
    if (!validated.ok) throw new Error("invalid input");
    const request = resolvedAgentRequest({
      conversationKey: 0,
      mode: "agent",
      userText: PAPER_READ_USER_TEXT,
      libraryID,
      model: "gpt-workflow",
    });
    Object.assign(request, {
      authMode: "codex_app_server",
      providerProtocol: "codex_responses",
      exhaustiveReadBackend: "codex_responses",
      executionContext: { permissionOwner: "external_runtime" },
    });
    return readTool.execute(validated.value, {
      request,
      item: null,
      currentAnswerText: "",
      modelName: "workflow",
    } as unknown as AgentToolContext);
  }

  /** The answer-time quote check of one answer citing `citation`. */
  async function finalizeQuote(citation: QuoteCitation, papers: any[]) {
    await warmQuoteSourceCachesForPaperContexts([papers]);
    const message: Message = {
      role: "assistant",
      text: `The paper says so. [[quote:${citation.id}]]`,
      timestamp: Date.now(),
      quoteCitations: [citation],
    };
    await applyAssistantMessageQuoteGate(
      message,
      message.text,
      message.quoteCitations,
      buildCachedQuoteSourceEvidenceForPaperContexts(papers),
      {
        pairedUserMessage: {
          role: "user",
          text: "Read the paper",
          timestamp: 0,
          paperContexts: papers,
        } as Message,
      },
    );
    return getMessageQuoteDisplay(message);
  }

  it("paper_read with sections and no query returns both papers' whole abstract and results with citation ids, and names the paper with neither", async function () {
    clearSectionPickCache();
    const reader = stubReader(scriptedPick);
    const result = await readPapers(
      paperReadTool(undefined, { readerFactories: reader.factories }),
      {
        mode: "targeted",
        sections: ["abstract", "results"],
        targets: [
          { itemId: withField.parentItemId },
          { itemId: pdfAbstract.parentItemId },
          { itemId: noHeadings.parentItemId },
        ],
      },
    );
    assert.equal(result.read, "whole_sections", JSON.stringify(result));
    const row = (itemId: number) =>
      result.papers.find((paper: any) => paper.paperContext.itemId === itemId);
    const registered = new Set(
      (result.quoteCitations as QuoteCitation[]).map((entry) => entry.id),
    );
    const textOf = (paper: any) =>
      paper.passages.map((passage: any) => passage.text).join("\n");

    const one = row(withField.parentItemId);
    assert.equal(one.status, "complete", JSON.stringify(one));
    assert.deepEqual(one.covered, ["Abstract", "PDF text (for: results)"]);
    assert.include(one.textSource, "Zotero abstract field");
    assert.include(textOf(one), FIELD_ABSTRACT);
    assert.include(textOf(one), P1_RESULTS);
    assert.notInclude(textOf(one), "Sentence 1 describes the discussion");

    const two = row(pdfAbstract.parentItemId);
    assert.equal(two.status, "complete", JSON.stringify(two));
    assert.deepEqual(two.covered, ["Abstract", "PDF text (for: results)"]);
    assert.equal(two.bounds, "approximate");
    assert.include(textOf(two), P2_ABSTRACT);
    assert.include(textOf(two), P2_RESULTS);

    for (const paper of [one, two]) {
      assert.isTrue(paper.sections.every((entry: any) => entry.complete));
      for (const passage of paper.passages) {
        assert.notMatch(passage.sectionLabel, /chunk|PDF text|page/i);
        assert.match(passage.quoteCitationId, /^Q_/, passage.text);
        assert.isTrue(registered.has(passage.quoteCitationId));
      }
    }

    const three = row(noHeadings.parentItemId);
    assert.equal(three.status, "no_matching_sections");
    assert.deepEqual(three.passages, []);
    assert.deepEqual(three.unmatched, ["abstract", "results"]);
    assert.deepEqual(three.notFound, THREE_NOT_FOUND);
    assert.include(result.note, "Nothing read for");
    assert.include(result.note, `item:${noHeadings.parentItemId}`);
    assert.isTrue(
      result.warnings.some((warning: string) =>
        warning.includes(THREE_NOT_FOUND.reason),
      ),
      JSON.stringify(result.warnings),
    );
    assert.notInclude(JSON.stringify(result), P3_TEXT.slice(0, 40));

    // One pick per paper, as in the digest: results for papers one and two,
    // abstract and results for paper three. paper_read has no digest calls.
    assert.lengthOf(reader.pickPrompts, 3);
    assert.sameMembers(
      reader.pickPrompts.map((prompt) => namesOf(prompt).join("+")),
      ["results", "results", "abstract+results"],
    );
    for (const prompt of reader.pickPrompts)
      assert.include(prompt, PAPER_READ_USER_TEXT);
    assert.lengthOf(reader.prompts, 0, "a whole-sections read digests nothing");

    // The real quote check keeps paper one's abstract (from the Zotero
    // field) and results ids, and refuses a made-up quote.
    // The picked results are labelled with the name the user asked for, not
    // with where they were found ("PDF text", a page).
    const passageLabel: Record<string, string> = {
      Abstract: "Abstract",
      Results: "Results",
    };
    const citationOf = (sectionLabel: string) => {
      const passage = one.passages.find(
        (entry: any) => entry.sectionLabel === passageLabel[sectionLabel],
      );
      assert.exists(passage, `${sectionLabel} passage of paper one`);
      const record = (result.quoteCitations as QuoteCitation[]).find(
        (entry) => entry.id === passage.quoteCitationId,
      );
      assert.exists(record, `${sectionLabel} id is registered`);
      return record!;
    };
    const onePapers = [
      {
        itemId: withField.parentItemId,
        contextItemId: withField.pdfAttachmentId,
        title: Zotero.Items.get(withField.parentItemId).getField("title"),
      },
    ];
    for (const sectionLabel of ["Abstract", "Results"]) {
      const sectionCitation = citationOf(sectionLabel);
      const kept = await finalizeQuote(sectionCitation, onePapers);
      assert.include(
        (kept.quoteCitations || []).map((entry) => entry.id),
        sectionCitation.id,
        `${sectionLabel}: ${kept.markdown}`,
      );
      assert.notInclude(kept.markdown, "Not a source quote");
    }
    const madeUp = buildQuoteCitation({
      quoteText:
        "Dentate gyrus granule cells were silenced by optogenetic stimulation during every learning trial.",
      sourceMatchKind: "exact",
      sourceMatchSource: "context-text",
      citationLabel: citationOf("Results").citationLabel,
      contextItemId: citationOf("Results").contextItemId,
      itemId: withField.parentItemId,
      allowShortQuoteText: true,
    })!;
    const madeUpShown = await finalizeQuote(madeUp, onePapers);
    assert.notInclude(
      (madeUpShown.quoteCitations || []).map((entry) => entry.id),
      madeUp.id,
      madeUpShown.markdown,
    );

    // The model is shown the ids, not the citation records.
    const view = paperReadTool().modelContent!(result, {} as never) as any;
    assert.notProperty(view, "quoteCitations");
    assert.match(view.papers[0].passages[0].quoteCitationId, /^Q_/);
  });

  it("paper_read mode:'full' returns citation ids the real quote check keeps, and it refuses a made-up quote", async function () {
    const analyzed: number[][] = [];
    const result = await readPapers(
      paperReadTool(async (input) => {
        analyzed.push(input.chunks.map((chunk) => chunk.chunkIndex));
        return {
          digest: "The paper reports that the decoder kept its accuracy.",
          relevantChunkIds: input.chunks.map((chunk) => chunk.chunkIndex),
        };
      }),
      {
        mode: "full",
        targets: [{ itemId: pdfAbstract.parentItemId }],
      },
    );
    assert.equal(result.status, "complete", JSON.stringify(result.warnings));
    assert.isNotEmpty(analyzed, "the reader read the paper's chunks");
    const evidence = result.papers[0].exactEvidence;
    assert.isNotEmpty(evidence);
    const citations = new Map(
      (result.quoteCitations as QuoteCitation[]).map((entry) => [
        entry.id,
        entry,
      ]),
    );
    for (const chunk of evidence)
      assert.isTrue(
        citations.has(chunk.quoteCitationId),
        `id ${chunk.quoteCitationId} is registered`,
      );
    const resultsChunk = evidence.find((chunk: any) =>
      chunk.text.includes(P2_RESULTS.slice(0, 40)),
    );
    assert.exists(resultsChunk, JSON.stringify(evidence));
    const citation = citations.get(resultsChunk.quoteCitationId)!;

    const papers = [
      {
        itemId: pdfAbstract.parentItemId,
        contextItemId: pdfAbstract.pdfAttachmentId,
        title: Zotero.Items.get(pdfAbstract.parentItemId).getField("title"),
      },
    ];
    const kept = await finalizeQuote(citation, papers);
    assert.include(
      (kept.quoteCitations || []).map((entry) => entry.id),
      citation.id,
      kept.markdown,
    );
    assert.notInclude(kept.markdown, "Not a source quote");

    const fabricated = buildQuoteCitation({
      quoteText:
        "Dentate gyrus granule cells were silenced by optogenetic stimulation during every learning trial.",
      sourceMatchKind: "exact",
      sourceMatchSource: "context-text",
      citationLabel: citation.citationLabel,
      contextItemId: citation.contextItemId,
      itemId: pdfAbstract.parentItemId,
      allowShortQuoteText: true,
    })!;
    const refused = await finalizeQuote(fabricated, papers);
    assert.notInclude(
      (refused.quoteCitations || []).map((entry) => entry.id),
      fabricated.id,
      refused.markdown,
    );
  });
});
