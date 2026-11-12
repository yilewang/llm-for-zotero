import { assert } from "chai";
import type { WorkflowTestApi } from "../../../src/modules/contextPanel/workflowTestTypes";
import {
  writeMineruCacheFiles,
  writeMineruSourceProvenanceForAttachment,
} from "../../../src/services/mineru/mineruCache";
import {
  buildBenchQuerySet,
  generateSyntheticCorpus,
} from "../../../test/helpers/syntheticLibraryCorpus";

declare const Zotero: any;
declare const Services: any;

const PREF_PREFIX = "extensions.zotero.llmforzotero";
const enabled = Services.env.get("LLM_FOR_ZOTERO_SEARCH_BENCH") === "1";
const PAPERS = Number(
  Services.env.get("LLM_FOR_ZOTERO_SEARCH_BENCH_PAPERS") || "500",
);
// Share of papers that are plain PDFs with no MinerU cache; 1 models a user
// who never ran MinerU.
const PDF_SHARE = Number(
  Services.env.get("LLM_FOR_ZOTERO_SEARCH_BENCH_PDF_SHARE") || "0.2",
);
const LABEL =
  Services.env.get("LLM_FOR_ZOTERO_SEARCH_BENCH_LABEL") || "unlabelled";

// The scaffold re-wraps PDF pages, so a planted sentence can cross a line
// break in extracted text; compare with whitespace collapsed on both sides.
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

describe("measurement: library search latency", function () {
  this.timeout(3_600_000);

  it("builds a synthetic library and times the fixed query set", async function () {
    if (!enabled) {
      this.skip();
      return;
    }
    assert.include(
      Zotero.DataDirectory.dir,
      ".scaffold/test/data",
      "disposable profile only",
    );
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    Zotero.Prefs.set(`${PREF_PREFIX}.mineruEnabled`, true, true);
    Zotero.Prefs.set(`${PREF_PREFIX}.mineruGlobalAutoParse`, false, true);
    Zotero.Prefs.set(`${PREF_PREFIX}.mineruSyncEnabled`, false, true);
    Zotero.Prefs.set(`${PREF_PREFIX}.enableSemanticSearch`, false, true);

    const corpus = generateSyntheticCorpus({
      papers: PAPERS,
      seed: 7,
      pdfShare: PDF_SHARE,
    });
    const report: any = {
      schema: 1,
      label: LABEL,
      papers: PAPERS,
      seed: 7,
      pdfShare: PDF_SHARE,
      zoteroVersion: Zotero.version,
      corpusBuildMs: 0,
      indexBuildMs: null,
      indexStatus: null,
      rssBeforeIndexBytes: null,
      rssAfterIndexBytes: null,
      queries: [],
    };
    const save = () =>
      Zotero.File.putContentsAsync(
        `${Zotero.DataDirectory.dir}/library-search-bench.json`,
        JSON.stringify(report, null, 2),
      );

    // 1. Corpus. Item ids are assigned by Zotero; keep a map from synthetic id.
    const corpusStart = Date.now();
    const libraryID = Zotero.Libraries.userLibraryID;
    const itemIdBySynthetic = new Map<number, number>();
    for (const paper of corpus.papers) {
      const fixture = await api.createPaperWithPdfFixture({
        title: paper.title,
        pdfTitle: `${paper.title}.pdf`,
        pages: paper.pages,
      });
      itemIdBySynthetic.set(paper.id, fixture.parentItemId);
      if (paper.mode === "mineru") {
        const encoder = new TextEncoder();
        await writeMineruCacheFiles(fixture.pdfAttachmentId, paper.markdown, [
          { relativePath: "full.md", data: encoder.encode(paper.markdown) },
          {
            relativePath: "content_list.json",
            data: encoder.encode(JSON.stringify(paper.contentList)),
          },
        ]);
        await writeMineruSourceProvenanceForAttachment(
          Zotero.Items.get(fixture.pdfAttachmentId),
        );
      }
    }
    const all = new Zotero.Collection();
    all.libraryID = libraryID;
    all.name = "Bench";
    await all.saveTx();
    const thirty = new Zotero.Collection();
    thirty.libraryID = libraryID;
    thirty.name = "Bench-30";
    await thirty.saveTx();
    await Zotero.DB.executeTransaction(async () => {
      await all.addItems([...itemIdBySynthetic.values()]);
      await thirty.addItems(
        corpus.papers.slice(0, 30).map((p) => itemIdBySynthetic.get(p.id)!),
      );
    });
    report.corpusBuildMs = Date.now() - corpusStart;
    await save();

    // 2. Index build (no-op until the index exists; the stub returns enabled:false).
    report.rssBeforeIndexBytes =
      (await api.memoryProbeInspect({ label: "pre-index", gc: true }))
        .resident ?? null;
    const status = await api.libraryTextIndexStatus();
    if (status.enabled) {
      const indexStart = Date.now();
      const idle = await api.waitForLibraryTextIndexIdle(2_400_000);
      assert.isTrue(idle, "index reached idle within 40 minutes");
      report.indexBuildMs = Date.now() - indexStart;
    }
    report.indexStatus = await api.libraryTextIndexStatus();
    report.rssAfterIndexBytes =
      (await api.memoryProbeInspect({ label: "post-index", gc: true }))
        .resident ?? null;
    await save();

    // 3. Queries: cold pass then warm pass, identical order. Cold means no
    // paper text is loaded this session: the cache is cleared before every
    // cold query. The warm pass repeats the queries without clearing.
    const queries = buildBenchQuerySet(corpus);
    for (const pass of ["cold", "warm"] as const) {
      for (const q of queries) {
        const cacheCleared = pass === "cold";
        if (cacheCleared) await api.clearPaperTextCacheForBench();
        const result = await api.libraryRetrieveBench({
          query: q.query,
          collectionIds: q.scope === "collection30" ? [thirty.id] : undefined,
          depth: "evidence",
        });
        const relevantItemId = itemIdBySynthetic.get(q.relevantPaperId)!;
        const top5 = result.paperItemIds.slice(0, 5);
        report.queries.push({
          id: q.id,
          kind: q.kind,
          scope: q.scope,
          pass,
          cacheCleared,
          elapsedMs: result.elapsedMs,
          phases: result.timing?.phases || {},
          counters: result.timing?.counters || {},
          recallAt5: top5.includes(relevantItemId) ? 1 : 0,
          snippetHit: result.snippetTexts.some((t) =>
            norm(t).includes(norm(q.sentence)),
          )
            ? 1
            : 0,
          snippetCount: result.snippetCount,
          warnings: result.warnings,
        });
        await save();
      }
    }
    assert.lengthOf(
      report.queries,
      queries.length * 2,
      "every query ran twice",
    );
  });
});
