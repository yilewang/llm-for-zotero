import { assert } from "chai";
import {
  setupMemoryIO,
  setupZoteroGlobals,
  snapshotTestGlobals,
  restoreTestGlobals,
  mockPdfAttachment,
  buildMarkdownPdfContext,
  headingSequenceMarkdown,
} from "./helpers/retrievalCorpus";
import {
  writeMineruCacheFiles,
  readManifest,
  ensureManifest,
  getMineruItemDir,
} from "../src/services/mineru/mineruCache";
import { ensurePDFTextCached } from "../src/services/paperContent/pdfContext";
import { pdfTextCache } from "../src/services/paperContent/contextCache";
import { RetrievalService } from "../src/agent/services/retrievalService";
import { createPaperReadTool } from "../src/agent/tools/read/paperRead";
import { buildRetrievalQueryPlan } from "../src/services/retrieval/retrievalQueryPlan";
import { papers as corpus } from "./fixtures/qaEvaluation/corpus";
import {
  digestSourceLabel,
  withDigestQuoteCitations,
} from "../src/agent/digests/paperDigestWorker";
import type { QuoteCitation } from "../src/shared/types";
import { SECTIONS_NOT_FOUND_RULE } from "../src/agent/digests/readScope";
import { clearSectionPickCache } from "../src/agent/digests/sectionPicker";
import {
  fakeReader,
  headingMatchReader,
  idOf,
  namesOf,
} from "./helpers/sectionPickerFixtures";

/** Stands in for the reader that picks named sections (sectionPicker.ts). */
const STAND_IN_READER = headingMatchReader();

describe("QA acquisition contracts", function () {
  let previous: ReturnType<typeof snapshotTestGlobals>;
  let memory: ReturnType<typeof setupMemoryIO>;
  const refs = corpus.map((p, i) => ({
    libraryID: 1,
    itemId: 9700 + i * 2,
    contextItemId: 9701 + i * 2,
    title: p.title,
    firstCreator: p.author,
    year: p.year,
  }));
  beforeEach(async function () {
    previous = snapshotTestGlobals();
    memory = setupMemoryIO();
    setupZoteroGlobals();
    pdfTextCache.clear();
    for (const [i, p] of corpus.entries()) {
      await writeMineruCacheFiles(
        refs[i].contextItemId,
        i === 1
          ? p.text.replace(
              "## Methods",
              "## Additional context\n\nThe comparison requires paper-specific section identities.\n\n## Methods",
            )
          : p.text,
        [],
      );
      await ensurePDFTextCached(mockPdfAttachment(refs[i].contextItemId));
    }
  });
  afterEach(function () {
    pdfTextCache.clear();
    restoreTestGlobals(previous);
  });
  const pdf = () =>
    ({
      ensurePaperContext: async (p: any) => pdfTextCache.get(p.contextItemId),
    }) as any;
  async function read(args: Record<string, unknown>, multi = false) {
    const service = pdf();
    const tool = createPaperReadTool(
      service,
      new RetrievalService(service),
      {} as any,
      {
        listPaperContexts: () => refs,
        resolvePaperContextTarget: (target: any) =>
          refs.find((p) => p.itemId === target.itemId),
      } as any,
      undefined,
      undefined,
      { readerFactories: STAND_IN_READER.factories },
    );
    const input = tool.validate({
      mode: "targeted",
      targets: (multi ? refs : refs.slice(0, 1)).map((p) => ({
        itemId: p.itemId,
        contextItemId: p.contextItemId,
      })),
      ...args,
    });
    if (!input.ok) throw Error(input.error);
    return (await tool.execute(input.value, {
      request: {
        conversationKey: 10,
        mode: "agent",
        conversationKind: "paper",
        userText: "Read the specified section",
        libraryID: 1,
        activeItemId: refs[0].itemId,
      },
      item: null,
      currentAnswerText: "",
      modelName: "test",
    } as any)) as any;
  }
  it("gives a digest quote the id paper_read gives the same passage", async function () {
    const result = await read({ query: "observational drift", topK: 2 });
    const citations = (result.quoteCitations || []) as QuoteCitation[];
    assert.isNotEmpty(citations);
    const [passage] = citations;
    // paper_read labels its quotes with the paper's source label.
    assert.equal(passage.citationLabel, digestSourceLabel(refs[0]));
    const digest = withDigestQuoteCitations(
      {
        schema: 2,
        itemId: refs[0].itemId,
        contextItemId: refs[0].contextItemId,
        title: refs[0].title,
        answer: "The paper reports drift.",
        evidence: [{ quote: passage.quoteText }],
        facets: [],
        gaps: [],
        source: {
          backend: "mineru",
          readCharacters: 1,
          totalCharacters: 1,
          complete: true,
        },
        model: "m",
        producedAt: 1,
        cacheKey: "k",
      },
      digestSourceLabel(refs[0]),
    );
    assert.equal(digest.evidence[0].quoteCitationId, passage.id);
    assert.deepEqual(
      digest.quoteCitations?.map((citation) => [
        citation.id,
        citation.citationLabel,
        citation.contextItemId,
        citation.itemId,
      ]),
      [
        [
          passage.id,
          passage.citationLabel,
          passage.contextItemId,
          passage.itemId,
        ],
      ],
    );
  });
  it("keeps an Abstract-only top-one read inside Abstract", async function () {
    const result = await read({
      query: "observational drift",
      sections: ["Abstract"],
      topK: 1,
    });
    assert.lengthOf(result.papers[0].passages, 1);
    assert.equal(result.papers[0].passages[0].sectionLabel, "Abstract");
  });
  it("resolves the Methods name independently in papers with different section layouts", async function () {
    const result = await read(
      { query: "sample recording method", sections: ["Methods"], topK: 8 },
      true,
    );
    for (const paper of result.papers) {
      assert.isNotEmpty(paper.passages);
      for (const p of paper.passages) assert.equal(p.sectionLabel, "Methods");
    }
  });
  it("marks fallback text as exploratory rather than claiming a query match", async function () {
    const result = await read({ query: "zxqv wploq mmzk", topK: 4 });
    assert.isNotEmpty(result.papers[0].passages);
    assert.equal(result.papers[0].status, "exploratory");
  });
  for (const label of ["Table 1", "表2"]) {
    it(`redirects explicit ${label} to text without requiring a table intent classification`, async function () {
      const result = await read({ mode: "figures", figureLabels: [label] });
      assert.equal(result.status, "no_figures");
      assert.include(result.guidance, "mode:'targeted'");
      assert.notProperty(result, "warning");
    });
  }
  it("does not redirect real figures or mixed selections into a table-only workflow", async function () {
    for (const figureLabels of [["Figure 1"], ["Figure 1", "Table 1"], []]) {
      const result = await read({ mode: "figures", figureLabels });
      assert.equal(result.status, "error");
      assert.include(
        result.warning,
        "figure extraction service is not available",
      );
    }
  });
  it("preserves legacy section page locations without a content list", async function () {
    const id = refs[0].contextItemId;
    const manifest = (await readManifest(id))!;
    delete manifest.structure;
    manifest.sections.forEach((s, i) => {
      s.page = i;
    });
    memory.files.set(
      `${getMineruItemDir(id)}/manifest.json`,
      new TextEncoder().encode(JSON.stringify(manifest)),
    );
    const rebuilt = (await ensureManifest(id))!;
    assert.deepEqual(
      rebuilt.sections.map((s) => s.page),
      manifest.sections.map((s) => s.page),
    );
  });
  it("does not reuse evidence for distinct Chinese queries or a larger requested set", async function () {
    let calls = 0;
    const service = new RetrievalService(
      pdf(),
      async (_p, _ctx, q, _api, options) => {
        calls++;
        return Array.from({ length: options?.topK || 1 }, (_, i) => ({
          paperKey: "x",
          itemId: refs[0].itemId,
          contextItemId: refs[0].contextItemId,
          title: "x",
          chunkIndex: i,
          chunkText: q,
          estimatedTokens: 5,
          bm25Score: 1,
          embeddingScore: 0,
          hybridScore: 1,
          evidenceScore: 1,
        }));
      },
    );
    const request = (question: string, perPaperTopK = 1) =>
      service.retrieveEvidence({
        papers: [refs[0]],
        question,
        queryPlan: buildRetrievalQueryPlan({ query: question }),
        topK: 4,
        perPaperTopK,
      });
    await request("神经元");
    const second = await request("血压");
    assert.equal(second[0].text, "血压");
    const larger = await request("血压", 4);
    assert.lengthOf(larger, 4);
    assert.equal(calls, 3);
  });
  it("invalidates held evidence when the source fingerprint changes", async function () {
    let calls = 0;
    const service = new RetrievalService(pdf(), async () => {
      calls++;
      return [];
    });
    const query = {
      papers: [refs[0]],
      question: "neurons",
      queryPlan: buildRetrievalQueryPlan({ query: "neurons" }),
    };
    await service.retrieveEvidence(query);
    const ctx = pdfTextCache.get(refs[0].contextItemId)!;
    ctx.chunkMeta[0].sourceFingerprint = "new-source";
    await service.retrieveEvidence(query);
    assert.equal(calls, 2);
  });
  it("keeps mathematical operators and long-query suffixes distinct, but reuses an identical read", async function () {
    let calls = 0;
    const service = new RetrievalService(pdf(), async () => {
      calls++;
      return [];
    });
    const request = (question: string) =>
      service.retrieveEvidence({
        papers: [refs[0]],
        question,
        queryPlan: buildRetrievalQueryPlan({ query: question }),
      });
    await request("m(h)/h");
    await request("m(h)*h");
    const prefix =
      "Explain the measurement recorded under the following experimental conditions and identify the separate evidence for each requested variable. ".repeat(
        3,
      );
    await request(prefix + "neurons");
    await request(prefix + "blood pressure");
    await request(prefix + "blood pressure");
    assert.equal(calls, 4);
  });
  it("invalidates sources lacking provenance without disabling identical-read reuse", async function () {
    const ctx = pdfTextCache.get(refs[0].contextItemId)!;
    ctx.chunkMeta.forEach((m) => {
      delete m.sourceFingerprint;
    });
    let calls = 0;
    const service = new RetrievalService(pdf(), async () => {
      calls++;
      return [];
    });
    const query = {
      papers: [refs[0]],
      question: "neurons",
      queryPlan: buildRetrievalQueryPlan({ query: "neurons" }),
    };
    await service.retrieveEvidence(query);
    await service.retrieveEvidence(query);
    ctx.chunks[0] += " Updated source content.";
    await service.retrieveEvidence(query);
    assert.equal(calls, 2);
  });
  it("searches a query only inside the named sections and names a section the paper lacks", async function () {
    const result = await read({
      query: "blood pressure",
      sections: ["Human Participants"],
      topK: 3,
    });
    // No section of that name: nothing of the paper is searched instead.
    assert.isEmpty(result.results);
    assert.isEmpty(result.papers[0].passages);
    assert.equal(result.papers[0].status, "no_matching_sections");
    assert.include(JSON.stringify(result.warnings), "Not found in ");
    assert.include(JSON.stringify(result.warnings), "Human Participants");
    assert.include(result.warnings, SECTIONS_NOT_FOUND_RULE);
    assert.include(result.note, "none of the named sections were found");
  });
  it("keeps a query inside the named sections the paper has when another name is missing", async function () {
    const result = await read({
      query: "sample recording method",
      sections: ["Methods", "Human Participants"],
      topK: 8,
    });
    assert.isNotEmpty(result.papers[0].passages);
    for (const p of result.papers[0].passages)
      assert.equal(p.sectionLabel, "Methods");
    assert.include(JSON.stringify(result.warnings), "Human Participants");
    assert.equal(
      result.warnings.filter((w: string) => w === SECTIONS_NOT_FOUND_RULE)
        .length,
      1,
    );
  });
  // Since the reader picks named sections, which heading binds a name is
  // the reader's call: the search stays inside what it picked, and a name it
  // finds no part for is reported and not searched.
  it("searches only the sections the reader picks for each name", async function () {
    clearSectionPickCache();
    const picks: Record<string, string | undefined> = {
      methods: "2 Methods",
      "model calibration": undefined,
      "model fit": "5 Model fit",
    };
    const reader = fakeReader((prompt) => ({
      parts: namesOf(prompt).map((name) =>
        picks[name]
          ? { name, sections: [idOf(prompt, `| # ${picks[name]} |`)] }
          : { name, none: true },
      ),
    }));
    const markdown = headingSequenceMarkdown(
      [
        "Place cells under drift",
        "Abstract",
        "1 Introduction",
        "2 Methods",
        "3 Results",
        "4 Comparison with other methods",
        "5 Model fit",
        "6 Discussion",
      ],
      {
        "2 Methods": "The recording method used silicon probes.",
        "4 Comparison with other methods":
          "Each recording method was compared with calcium imaging.",
        "5 Model fit": "The model fit the recording well.",
      },
    );
    const ctx = await buildMarkdownPdfContext(markdown, 9801);
    // The paper's MinerU directory, as the attachment lookup supplies it:
    // the reader picks from its headings.
    const paper = {
      ...refs[0],
      itemId: 9800,
      contextItemId: 9801,
      mineruCacheDir: getMineruItemDir(9801),
    };
    const service = { ensurePaperContext: async () => ctx } as any;
    const tool = createPaperReadTool(
      service,
      new RetrievalService(service),
      {} as any,
      {
        listPaperContexts: () => [paper],
        resolvePaperContextTarget: () => paper,
      } as any,
      undefined,
      undefined,
      { readerFactories: reader.factories },
    );
    const run = async (sections: string[]) => {
      const input = tool.validate({
        mode: "targeted",
        targets: [{ itemId: paper.itemId, contextItemId: paper.contextItemId }],
        query: "recording method",
        sections,
        topK: 8,
      });
      if (!input.ok) throw Error(input.error);
      return (await tool.execute(input.value, {
        request: {
          conversationKey: 11,
          mode: "agent",
          conversationKind: "paper",
          userText: "Read the methods",
          libraryID: 1,
          activeItemId: paper.itemId,
        },
        item: null,
        currentAnswerText: "",
        modelName: "test",
      } as any)) as any;
    };
    const methods = await run(["methods"]);
    assert.isNotEmpty(methods.papers[0].passages);
    for (const p of methods.papers[0].passages)
      assert.equal(p.sectionLabel, "2 Methods");
    // A name the reader finds no part for is not searched.
    const calibration = await run(["model calibration"]);
    assert.isEmpty(calibration.papers[0].passages);
    assert.include(JSON.stringify(calibration.warnings), "model calibration");
    const fit = await run(["model fit"]);
    assert.isNotEmpty(fit.papers[0].passages);
    for (const p of fit.papers[0].passages)
      assert.match(p.sectionLabel, /5 Model fit$/);
  });
  it("does not carry a legacy page onto a changed source range", async function () {
    const id = refs[0].contextItemId;
    const manifest = (await readManifest(id))!;
    delete manifest.structure;
    manifest.sections.forEach((s) => {
      s.page = 99;
      s.charEnd += 1;
    });
    memory.files.set(
      `${getMineruItemDir(id)}/manifest.json`,
      new TextEncoder().encode(JSON.stringify(manifest)),
    );
    const rebuilt = (await ensureManifest(id))!;
    assert.isFalse(rebuilt.sections.some((s) => s.page === 99));
  });
});
