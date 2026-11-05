/**
 * One bibliography for Zotero items and outside papers: the CSL item each
 * cited outside paper is formatted from, the one citeproc run that formats
 * both kinds, the links the document's citations and References open, the
 * stored form, and the document card that opens outside links in the browser
 * and marks outside References entries "Not in library".
 */
import { assert } from "chai";
import {
  lookUpOutsidePaperDoi,
  prefetchOutsidePaperLookups,
  rememberOutsidePapers,
  setOutsidePaperPrefetchLookup,
  type OutsidePaperHolder,
  type OutsidePaperLookupCache,
  type OutsidePaperRecord,
} from "../src/agent/context/outsidePaperRecords";
import {
  bindDocumentCitationGroupsForDisplay,
  formatDocumentCitations,
} from "../src/agent/documents/citationService";
import { decodePlanDocument } from "../src/agent/documents/decoders";
import { finalizeDocument } from "../src/agent/documents/finalizer";
import {
  buildOutsidePaperSnapshots,
  cslNameOf,
  outsidePaperCslItem,
  outsidePaperUri,
} from "../src/agent/documents/outsidePaperCitations";
import type {
  DocumentSpec,
  FormattedCitationBundle,
  OutsidePaperSnapshot,
  PlanCitationCluster,
  PlanDocument,
} from "../src/agent/documents/types";
import { LiteratureSearchService } from "../src/agent/services/literatureSearchService";
import { SettingsCapability } from "../src/agent/services/zotero/settingsCapability";
import type { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { decoratePlanDocumentCitations } from "../src/modules/contextPanel/planDocumentPresentation";
import { renderMarkdownForNote } from "../src/utils/markdown";
import { FakeElement, collectFakeText, fakeDocument } from "./helpers/fakeDom";

const PAREN_DOI =
  "10.1002/(SICI)1097-4636(199702)34:2<123::AID-JBM1>3.0.CO;2-G";
const PAREN_DOI_URI =
  "https://doi.org/10.1002/%28SICI%291097-4636%28199702%2934%3A2%3C123%3A%3AAID-JBM1%3E3.0.CO%3B2-G";

function record(fields: Partial<OutsidePaperRecord> = {}): OutsidePaperRecord {
  return {
    paperId: "paper_beta",
    title: "Beta drifts",
    authors: ["Bea Beta"],
    year: 2021,
    depth: "abstract",
    ...fields,
  };
}

describe("an outside paper's CSL item", function () {
  it("splits display names into family and given, keeping one-token and group names whole", function () {
    assert.deepEqual(cslNameOf("Ada Lovelace"), {
      family: "Lovelace",
      given: "Ada",
    });
    assert.deepEqual(cslNameOf("Grace B. M. Hopper"), {
      family: "Hopper",
      given: "Grace B. M.",
    });
    assert.deepEqual(cslNameOf("Turing, Alan M."), {
      family: "Turing",
      given: "Alan M.",
    });
    assert.deepEqual(cslNameOf("Ludwig van Beethoven"), {
      family: "van Beethoven",
      given: "Ludwig",
    });
    assert.deepEqual(cslNameOf("Martin Luther King Jr."), {
      family: "King",
      given: "Martin Luther",
      suffix: "Jr.",
    });
    assert.deepEqual(cslNameOf("Aristotle"), { literal: "Aristotle" });
    assert.deepEqual(cslNameOf("ATLAS Collaboration"), {
      literal: "ATLAS Collaboration",
    });
    assert.isNull(cslNameOf("  "));
  });

  it("builds a journal article, or an article for an arXiv-only paper", function () {
    assert.deepEqual(
      outsidePaperCslItem(
        record({
          doi: "10.1000/beta",
          url: "https://publisher.example/beta",
          authors: ["Bea Beta", "Aristotle"],
        }),
        "ext-1",
      ),
      {
        id: "ext-1",
        type: "article-journal",
        title: "Beta drifts",
        author: [{ family: "Beta", given: "Bea" }, { literal: "Aristotle" }],
        issued: { "date-parts": [[2021]] },
        DOI: "10.1000/beta",
        URL: "https://publisher.example/beta",
      },
    );
    const arxiv = outsidePaperCslItem(
      record({ arxivId: "2101.00001", year: undefined }),
      "ext-2",
    );
    assert.equal(arxiv.type, "article");
    assert.equal(arxiv.URL, "https://arxiv.org/abs/2101.00001");
    assert.notProperty(arxiv, "issued");
    assert.equal(
      outsidePaperCslItem(record({ doi: "10.48550/arXiv.2101.00001" }), "ext-3")
        .type,
      "article",
      "arXiv's own DOI is still a preprint",
    );
  });

  it("links at doi.org, escaping what ends a Markdown link target, else at the paper's page", function () {
    assert.equal(outsidePaperUri({ doi: PAREN_DOI }), PAREN_DOI_URI);
    assert.notMatch(PAREN_DOI_URI, /[()<>\s]/);
    assert.equal(
      outsidePaperUri({ arxivId: "2101.00001" }),
      "https://arxiv.org/abs/2101.00001",
    );
    assert.equal(
      outsidePaperUri({ pmid: "123" }),
      "https://pubmed.ncbi.nlm.nih.gov/123/",
    );
    assert.equal(
      outsidePaperUri({ url: "https://example.org/a paper (v2)" }),
      "https://example.org/a%20paper%20%28v2%29",
    );
    assert.isUndefined(outsidePaperUri({}));
  });
});

describe("enriching outside papers with a DOI lookup", function () {
  const papers = [
    record({ paperId: "paper_a", doi: "10.1000/a" }),
    record({ paperId: "paper_b", url: "https://example.org/b" }),
  ];

  it("takes the CSL fields a lookup finds over the record's, and looks up DOIs only", async function () {
    const asked: string[] = [];
    const snapshots = await buildOutsidePaperSnapshots({
      papers,
      lookup: async (doi) => {
        asked.push(doi);
        return {
          type: "paper-conference",
          author: [{ family: "Beta", given: "Beatrice" }],
          issued: { "date-parts": [[2021, 4]] },
          "container-title": "Journal of Drift",
          volume: "3",
          issue: "2",
          page: "10-20",
        };
      },
    });
    assert.deepEqual(asked, ["10.1000/a"]);
    assert.deepInclude(snapshots[0].csl, {
      id: "ext-1",
      type: "paper-conference",
      title: "Beta drifts",
      author: [{ family: "Beta", given: "Beatrice" }],
      issued: { "date-parts": [[2021, 4]] },
      "container-title": "Journal of Drift",
      volume: "3",
      issue: "2",
      page: "10-20",
    });
    assert.deepEqual(snapshots[0], {
      paperId: "paper_a",
      doi: "10.1000/a",
      csl: snapshots[0].csl,
    });
    assert.notProperty(snapshots[1].csl, "container-title");
    assert.equal(snapshots[1].csl.id, "ext-2");
    assert.equal(snapshots[1].url, "https://example.org/b");
  });

  it("keeps the thin record when the lookup fails", async function () {
    const snapshots = await buildOutsidePaperSnapshots({
      papers,
      lookup: async () => {
        throw new Error("translator offline");
      },
    });
    assert.deepEqual(snapshots[0].csl, outsidePaperCslItem(papers[0], "ext-1"));
  });

  it("keeps the thin record when every lookup outlasts the shared cap", async function () {
    const started = Date.now();
    const snapshots = await buildOutsidePaperSnapshots({
      papers: [papers[0], record({ paperId: "paper_c", doi: "10.1000/c" })],
      lookup: () => new Promise(() => undefined),
      timeoutMs: 30,
    });
    assert.isBelow(Date.now() - started, 1000);
    assert.notProperty(snapshots[0].csl, "container-title");
    assert.notProperty(snapshots[1].csl, "container-title");
  });
});

describe("the run's DOI lookups", function () {
  it("answers a DOI the run already looked up from its cache, a timeout included", async function () {
    const cache: Record<string, unknown> = {};
    let calls = 0;
    const paper = record({ paperId: "paper_a", doi: "10.1000/A" });
    const build = (lookup: () => Promise<null | { volume: string }>) =>
      buildOutsidePaperSnapshots({
        papers: [paper],
        lookup: () => {
          calls += 1;
          return lookup();
        },
        timeoutMs: 20,
        cache: cache as never,
      });
    const first = await build(() => new Promise(() => undefined));
    const second = await build(async () => ({ volume: "9" }));
    assert.equal(calls, 1, "a DOI is looked up once per run");
    assert.deepEqual(cache, { "10.1000/a": null }, "keyed by normalized DOI");
    assert.deepEqual(second, first);
  });
});

/** Resolves after `ms`; lets queued lookups run in between. */
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** A lookup that answers each DOI after `ms` and counts how many run at once. */
function countingLookup(ms = 5) {
  const state = { asked: [] as string[], running: 0, mostAtOnce: 0 };
  const lookup = async (doi: string) => {
    state.asked.push(doi);
    state.running += 1;
    state.mostAtOnce = Math.max(state.mostAtOnce, state.running);
    await settle(ms);
    state.running -= 1;
    return { volume: `v-${doi}` };
  };
  return { state, lookup };
}

describe("the run's DOI lookup queue", function () {
  afterEach(function () {
    setOutsidePaperPrefetchLookup(null);
  });

  it("runs a submission's lookups one at a time, never in parallel", async function () {
    const { state, lookup } = countingLookup();
    const papers = ["a", "b", "c", "d"].map((name) =>
      record({ paperId: `paper_${name}`, doi: `10.1000/${name}` }),
    );
    const snapshots = await buildOutsidePaperSnapshots({
      papers,
      lookup,
      cache: {},
    });
    assert.equal(state.mostAtOnce, 1);
    assert.deepEqual(
      state.asked,
      papers.map((paper) => paper.doi),
    );
    assert.deepEqual(
      snapshots.map((snapshot) => snapshot.csl.volume),
      papers.map((paper) => `v-${paper.doi}`),
    );
  });

  it("looks up a DOI once while it is in flight, and once per run", async function () {
    const { state, lookup } = countingLookup();
    const cache: OutsidePaperLookupCache = {};
    const [first, second] = await Promise.all([
      lookUpOutsidePaperDoi(cache, "10.1000/A", lookup),
      lookUpOutsidePaperDoi(cache, "https://doi.org/10.1000/a", lookup),
    ]);
    assert.deepEqual(first, { volume: "v-10.1000/A" });
    assert.deepEqual(second, first);
    assert.deepEqual(
      await lookUpOutsidePaperDoi(cache, "10.1000/a", lookup),
      first,
    );
    assert.deepEqual(state.asked, ["10.1000/A"]);
    assert.deepEqual(cache, { "10.1000/a": first });
  });

  it("never asks Crossref for an arXiv DOI", async function () {
    const { state, lookup } = countingLookup();
    const cache: OutsidePaperLookupCache = {};
    assert.isNull(
      await lookUpOutsidePaperDoi(cache, "10.48550/arXiv.2101.00001", lookup),
    );
    assert.deepEqual(state.asked, []);
    assert.deepEqual(cache, { "10.48550/arxiv.2101.00001": null });
  });

  it("moves past a request that never answers, recording nothing for it", async function () {
    const asked: string[] = [];
    const cache: OutsidePaperLookupCache = {};
    const lookup = (doi: string) => {
      asked.push(doi);
      return doi.endsWith("hung")
        ? new Promise<null>(() => undefined)
        : Promise.resolve({ volume: "2" });
    };
    const options = { requestTimeoutMs: 20 };
    const hung = lookUpOutsidePaperDoi(cache, "10.1000/hung", lookup, options);
    const next = lookUpOutsidePaperDoi(cache, "10.1000/next", lookup, options);
    assert.isNull(await hung);
    assert.deepEqual(await next, { volume: "2" });
    assert.deepEqual(asked, ["10.1000/hung", "10.1000/next"]);
    assert.deepEqual(cache, {
      "10.1000/hung": null,
      "10.1000/next": { volume: "2" },
    });
  });

  it("prefetches a DOI the run read at abstract or body depth, in the background", async function () {
    const { state, lookup } = countingLookup();
    setOutsidePaperPrefetchLookup(lookup);
    const holder: OutsidePaperHolder = {};
    const records = [
      record({ paperId: "paper_meta", doi: "10.1000/meta", depth: "metadata" }),
      record({ paperId: "paper_abs", doi: "10.1000/abs", depth: "abstract" }),
      record({ paperId: "paper_body", doi: "10.1000/body", depth: "body" }),
      record({ paperId: "paper_nodoi", depth: "body" }),
    ];
    rememberOutsidePapers(holder, records);
    prefetchOutsidePaperLookups(holder, records);
    assert.deepEqual(holder.outsidePaperLookupCache, {}, "nothing is awaited");
    await settle(40);
    assert.equal(state.mostAtOnce, 1);
    assert.deepEqual(state.asked, ["10.1000/abs", "10.1000/body"]);
    assert.deepEqual(holder.outsidePaperLookupCache, {
      "10.1000/abs": { volume: "v-10.1000/abs" },
      "10.1000/body": { volume: "v-10.1000/body" },
    });
  });

  it("never throws into the recording call, and prefetches nothing without a lookup", async function () {
    const holder: OutsidePaperHolder = {};
    const records = [record({ doi: "10.1000/x", depth: "body" })];
    rememberOutsidePapers(holder, records);
    prefetchOutsidePaperLookups(holder, records);
    await settle();
    assert.deepEqual(holder.outsidePaperLookupCache, {});
    setOutsidePaperPrefetchLookup(() => {
      throw new Error("offline");
    });
    prefetchOutsidePaperLookups(holder, records);
    await settle();
    assert.deepEqual(holder.outsidePaperLookupCache, { "10.1000/x": null });
  });

  it("at submission awaits a prefetch in flight and looks up the missing DOIs under one deadline", async function () {
    const prefetch = countingLookup(15);
    setOutsidePaperPrefetchLookup(prefetch.lookup);
    const holder: OutsidePaperHolder = {};
    const read = record({ paperId: "paper_a", doi: "10.1000/a" });
    rememberOutsidePapers(holder, [read]);
    prefetchOutsidePaperLookups(holder, [read]);
    const submit = countingLookup();
    const snapshots = await buildOutsidePaperSnapshots({
      papers: [read, record({ paperId: "paper_b", doi: "10.1000/b" })],
      lookup: submit.lookup,
      timeoutMs: 1000,
      cache: holder.outsidePaperLookupCache,
    });
    assert.deepEqual(prefetch.state.asked, ["10.1000/a"]);
    assert.deepEqual(submit.state.asked, ["10.1000/b"], "queued behind it");
    assert.deepEqual(
      snapshots.map((snapshot) => snapshot.csl.volume),
      ["v-10.1000/a", "v-10.1000/b"],
    );
  });

  it("keeps the deadline's answer when a prefetch arrives later, so a retry formats the same", async function () {
    let answer: (value: { volume: string }) => void = () => undefined;
    setOutsidePaperPrefetchLookup(
      () => new Promise((resolve) => (answer = resolve)),
    );
    const holder: OutsidePaperHolder = {};
    const read = record({ paperId: "paper_a", doi: "10.1000/a" });
    rememberOutsidePapers(holder, [read]);
    prefetchOutsidePaperLookups(holder, [read]);
    const submit = () =>
      buildOutsidePaperSnapshots({
        papers: [read],
        lookup: async () => ({ volume: "never asked" }),
        timeoutMs: 20,
        cache: holder.outsidePaperLookupCache,
      });
    const first = await submit();
    answer({ volume: "late" });
    await settle();
    const second = await submit();
    assert.deepEqual(holder.outsidePaperLookupCache, { "10.1000/a": null });
    assert.notProperty(first[0].csl, "volume");
    assert.deepEqual(second, first);
  });
});

describe("the Crossref citation lookup", function () {
  const scope = globalThis as typeof globalThis & { fetch?: unknown };
  const originalFetch = scope.fetch;
  let requested: string[];

  function respond(
    message: Record<string, unknown> | null,
    ok = true,
    status = ok ? 200 : 500,
  ) {
    requested = [];
    scope.fetch = async (url: string) => {
      requested.push(url);
      return {
        ok,
        status,
        json: async () => ({ message }),
      };
    };
  }

  afterEach(function () {
    scope.fetch = originalFetch;
  });

  // The translator path would write a temporary item: it must not be asked.
  const service = () =>
    new LiteratureSearchService({
      fetchMetadataByIdentifier: () => {
        throw new Error("the Zotero translator must not be used");
      },
    } as unknown as ZoteroGateway);

  it("reads the citation fields as CSL, from Crossref only", async function () {
    respond({
      type: "journal-article",
      "container-title": [
        "Journal of <i>Drift</i> &amp; Memory &lt;i&gt;Letters&lt;/i&gt;",
      ],
      volume: "3",
      issue: "2",
      page: "10-20",
      issued: { "date-parts": [[2021, 4, 2]] },
      author: [
        { given: "Ada", family: "Able" },
        { family: "Solo" },
        { name: "ATLAS Collaboration" },
        {},
      ],
    });
    const found = await service().lookupCitationMetadataByDoi(PAREN_DOI);
    assert.deepEqual(requested, [
      `https://api.crossref.org/works/${encodeURIComponent(PAREN_DOI)}`,
    ]);
    assert.deepEqual(found, {
      type: "article-journal",
      author: [
        { family: "Able", given: "Ada" },
        { family: "Solo" },
        { literal: "ATLAS Collaboration" },
      ],
      issued: { "date-parts": [[2021, 4, 2]] },
      "container-title": "Journal of Drift & Memory Letters",
      volume: "3",
      issue: "2",
      page: "10-20",
    });
  });

  it("maps only Crossref types with a clean CSL equivalent", async function () {
    for (const [crossRef, csl] of [
      ["posted-content", "article"],
      ["proceedings-article", "paper-conference"],
      ["book-chapter", "chapter"],
      ["book", "book"],
      ["dissertation", undefined],
    ]) {
      respond({ type: crossRef, volume: "1" });
      const found = await service().lookupCitationMetadataByDoi("10.1/x");
      assert.equal(found?.type, csl, crossRef);
    }
  });

  it("finds nothing when Crossref fails or knows nothing", async function () {
    respond(null, false);
    assert.isNull(await service().lookupCitationMetadataByDoi("10.1/x"));
    respond({ type: "journal-article", volume: "1" }, false, 429);
    assert.isNull(
      await service().lookupCitationMetadataByDoi("10.1/x"),
      "too many requests",
    );
    respond({ type: "dissertation" });
    assert.isNull(await service().lookupCitationMetadataByDoi("10.1/x"));
  });

  it("asks Crossref once per run for a DOI it answered with too many requests", async function () {
    respond({ type: "journal-article", volume: "1" }, false, 429);
    const cache: OutsidePaperLookupCache = {};
    const lookup = (doi: string) => service().lookupCitationMetadataByDoi(doi);
    assert.isNull(await lookUpOutsidePaperDoi(cache, "10.1/x", lookup));
    assert.isNull(await lookUpOutsidePaperDoi(cache, "10.1/x", lookup));
    assert.lengthOf(requested, 1, "no retry");
    assert.deepEqual(cache, { "10.1/x": null });
  });
});

describe("formatting Zotero items and outside papers in one citeproc run", function () {
  const scope = globalThis as typeof globalThis & { Zotero?: unknown };
  const original = scope.Zotero;
  let getCiteProcOptions: Array<{ cache?: boolean } | undefined>;
  let retrieved: string[];
  let updated: Array<Array<number | string>>;

  function installEngine(entryIds: Array<Array<string | number>>) {
    getCiteProcOptions = [];
    retrieved = [];
    updated = [];
    scope.Zotero = {
      Prefs: { get: () => "" },
      Styles: {
        get: () => ({
          title: "APA",
          getCiteProc: (
            _locale: string,
            format: string,
            options?: { cache?: boolean },
          ) => {
            getCiteProcOptions.push(options);
            const engine = {
              free: () => undefined,
              sys: {
                retrieveItem: (id: string | number) => {
                  retrieved.push(`zotero:${id}`);
                  return { id };
                },
              },
              updateItems: (ids: Array<number | string>) => {
                updated.push(ids);
                // citeproc asks its system for every id, as a string.
                for (const id of ids) engine.sys.retrieveItem(String(id));
              },
              previewCitationCluster: (citation: {
                citationItems: Array<{ id: string | number }>;
              }) =>
                `${format}:${citation.citationItems.map((item) => item.id).join("+")}`,
              makeBibliography: () => [
                { entry_ids: entryIds },
                entryIds.map((ids) => `${format}-${ids[0]}`),
              ],
            };
            return engine;
          },
        }),
      },
    };
  }

  afterEach(function () {
    scope.Zotero = original;
  });

  const capability = () =>
    new SettingsCapability({ getItem: () => null as unknown as Zotero.Item });

  it("serves ext ids from the outside items on a fresh engine and pairs entries by string id", function () {
    // citeproc reports ids as strings, in its own (APA) order.
    installEngine([["ext-1"], ["7"], ["ext-2"]]);
    const outsideItems = [
      { id: "ext-1", type: "article-journal", title: "Alpha" },
      { id: "ext-2", type: "article", title: "Gamma" },
    ];
    const result = capability().formatStructuredCitations({
      clusters: [
        {
          citationId: "C1",
          items: [{ itemId: 7, pageIndex: 1 }, { outsideId: "ext-1" }],
        },
        { citationId: "C2", items: [{ outsideId: "ext-2" }] },
      ],
      outsideItems,
    });
    assert.deepEqual(getCiteProcOptions, [{ cache: false }, { cache: false }]);
    assert.deepEqual(updated[0], [7, "ext-1", "ext-2"]);
    assert.deepEqual(
      retrieved.slice(0, 1),
      ["zotero:7"],
      "a Zotero id still reaches Zotero's own lookup",
    );
    assert.notInclude(retrieved, "zotero:ext-1");
    assert.notInclude(retrieved, "zotero:ext-2");
    assert.deepEqual(result.clusters[0], {
      citationId: "C1",
      text: "text:7+ext-1",
      html: "html:7+ext-1",
    });
    assert.deepEqual(result.bibliographyEntries, [
      { outsideId: "ext-1", text: "text-ext-1", html: "html-ext-1" },
      { itemId: 7, text: "text-7", html: "html-7" },
      { outsideId: "ext-2", text: "text-ext-2", html: "html-ext-2" },
    ]);
  });

  it("keeps today's cached engine and its lookup when no outside paper is cited", function () {
    installEngine([[1]]);
    const result = capability().formatStructuredCitations({
      clusters: [{ citationId: "C1", items: [{ itemId: 1 }] }],
      outsideItems: [{ id: "ext-1", type: "article-journal" }],
    });
    assert.deepEqual(getCiteProcOptions, [{ cache: true }, { cache: true }]);
    assert.deepEqual(updated[0], [1]);
    assert.deepEqual(result.bibliographyEntries, [
      { itemId: 1, text: "text-1", html: "html-1" },
    ]);
  });

  it("refuses an outside id that looks like a Zotero id or one no item supplies", function () {
    installEngine([]);
    assert.throws(
      () =>
        capability().formatStructuredCitations({
          clusters: [{ citationId: "C1", items: [{ outsideId: "12" }] }],
          outsideItems: [{ id: "12" }],
        }),
      /id "12" is invalid/,
    );
    assert.throws(
      () =>
        capability().formatStructuredCitations({
          clusters: [{ citationId: "C1", items: [{ outsideId: "ext-9" }] }],
        }),
      /"ext-9" was not supplied/,
    );
  });
});

const spec: DocumentSpec = {
  kind: "literature_review",
  title: "Review",
  requiredSections: [],
  requiresReferences: true,
  requiresCoverageSection: false,
  allowFigures: false,
  citationStyle: { styleId: "apa", styleTitle: "APA", locale: "en-US" },
};

const betaPaper: OutsidePaperSnapshot = {
  paperId: "paper_beta",
  doi: PAREN_DOI,
  csl: { id: "provisional", type: "article-journal", title: "Beta drifts" },
};
const gammaPaper: OutsidePaperSnapshot = {
  paperId: "paper_gamma",
  arxivId: "2101.00001",
  csl: { id: "provisional", type: "article", title: "Gamma" },
};

type GatewayParams = {
  clusters: Array<{
    citationId: string;
    items: Array<{ itemId?: number; outsideId?: string }>;
  }>;
  outsideItems?: Array<{ id: string; title?: string }>;
};

/** A citeproc stand-in: labels by work, bibliography in APA order. */
function fakeGateway(calls: GatewayParams[] = []): ZoteroGateway {
  const label = (
    item: { itemId?: number; outsideId?: string },
    params: GatewayParams,
  ) => {
    if (item.itemId === 10) return "Alpha, 2020";
    const title = params.outsideItems?.find(
      (entry) => entry.id === item.outsideId,
    )?.title;
    return title === "Beta drifts" ? "Beta, 2021" : "Gamma, 2022";
  };
  return {
    formatStructuredCitations: (params: GatewayParams) => {
      calls.push(params);
      const works = [
        ...new Map(
          params.clusters
            .flatMap((cluster) => cluster.items)
            .map((item) => [item.outsideId ?? item.itemId, item]),
        ).values(),
      ].sort((left, right) =>
        label(left, params).localeCompare(label(right, params)),
      );
      return {
        styleId: "apa",
        styleTitle: "APA",
        locale: "en-US",
        clusters: params.clusters.map((cluster) => ({
          citationId: cluster.citationId,
          text: `(${cluster.items.map((item) => label(item, params)).join("; ")})`,
          html: "(html)",
        })),
        bibliographyEntries: works.map((item) => {
          const text = `${label(item, params).replace(", ", ". (")}). Title.`;
          return item.outsideId
            ? { outsideId: item.outsideId, text, html: text }
            : { itemId: item.itemId!, text, html: text };
        }),
      };
    },
  } as unknown as ZoteroGateway;
}

describe("a document citing Zotero items and outside papers", function () {
  const scope = globalThis as typeof globalThis & { Zotero?: unknown };
  const original = scope.Zotero;

  beforeEach(function () {
    scope.Zotero = {
      Libraries: { userLibraryID: 1, get: () => undefined },
      Items: {
        getByLibraryAndKey: (_libraryID: number, itemKey: string) =>
          itemKey === "AAAA1111" ? { id: 10, isNote: () => false } : false,
      },
    };
  });

  afterEach(function () {
    scope.Zotero = original;
  });

  const clusters: PlanCitationCluster[] = [
    {
      citationId: "C1",
      sources: [
        { libraryID: 1, itemKey: "AAAA1111", evidenceRefs: [] },
        { kind: "outside", paperId: "paper_beta", evidenceRefs: [] },
      ],
    },
    {
      citationId: "C2",
      sources: [{ kind: "outside", paperId: "paper_gamma", evidenceRefs: [] }],
    },
    {
      citationId: "unused",
      sources: [{ kind: "outside", paperId: "paper_unused", evidenceRefs: [] }],
    },
  ];

  const format = (calls: GatewayParams[] = []) =>
    formatDocumentCitations({
      gateway: fakeGateway(calls),
      draftMarkdown:
        "# Review\n\nDrift is common [[cite:C1]]. A preprint agrees [[cite:C2]].",
      clusters,
      corpus: [
        { libraryID: 1, itemKey: "AAAA1111" },
        { kind: "outside", paperId: "paper_beta" },
        { kind: "outside", paperId: "paper_gamma" },
        { kind: "outside", paperId: "paper_unused" },
      ],
      evidence: [],
      spec,
      requireEvidence: false,
      outsidePapers: [gammaPaper, betaPaper],
    });

  it("links each name of a mixed group to its own source", async function () {
    const result = await format();
    assert.include(
      result.visibleMarkdown,
      `([Alpha, 2020](zotero://select/library/items/AAAA1111); [Beta, 2021](${PAREN_DOI_URI}))`,
    );
    assert.include(
      result.visibleMarkdown,
      "[(Gamma, 2022)](https://arxiv.org/abs/2101.00001)",
    );
  });

  it("numbers the cited outside papers in citation order and keeps only those", async function () {
    const calls: GatewayParams[] = [];
    const result = await format(calls);
    assert.deepEqual(calls[0].clusters, [
      {
        citationId: "C1",
        items: [{ itemId: 10, pageIndex: undefined }, { outsideId: "ext-1" }],
      },
      { citationId: "C2", items: [{ outsideId: "ext-2" }] },
    ]);
    assert.deepEqual(
      calls[0].outsideItems?.map((item) => [item.id, item.title]),
      [
        ["ext-1", "Beta drifts"],
        ["ext-2", "Gamma"],
      ],
    );
    assert.deepEqual(result.citationBundle.outsidePapers, [
      { ...betaPaper, csl: { ...betaPaper.csl, id: "ext-1" } },
      { ...gammaPaper, csl: { ...gammaPaper.csl, id: "ext-2" } },
    ]);
  });

  it("lists References once in citeproc order, outside entries linked at doi.org or their page", async function () {
    const result = await format();
    assert.deepEqual(result.citationBundle.bibliographyEntries, [
      {
        libraryID: 1,
        itemKey: "AAAA1111",
        text: "Alpha. (2020). Title.",
        html: "Alpha. (2020). Title.",
      },
      {
        paperId: "paper_beta",
        text: "Beta. (2021). Title.",
        html: "Beta. (2021). Title.",
      },
      {
        paperId: "paper_gamma",
        text: "Gamma. (2022). Title.",
        html: "Gamma. (2022). Title.",
      },
    ]);
    const references = result.visibleMarkdown.split("## References\n\n")[1];
    assert.equal(
      references,
      [
        "- [Alpha. (2020). Title.](zotero://select/library/items/AAAA1111)",
        `- [Beta. (2021). Title.](${PAREN_DOI_URI})`,
        "- [Gamma. (2022). Title.](https://arxiv.org/abs/2101.00001)",
        "",
      ].join("\n"),
    );
    const noteHtml = renderMarkdownForNote(result.visibleMarkdown);
    assert.include(noteHtml, `href="${PAREN_DOI_URI}"`);
    assert.include(noteHtml, 'href="https://arxiv.org/abs/2101.00001"');
    assert.notInclude(result.visibleMarkdown, "Not in library");
  });

  it("refuses an outside source the record cannot format", async function () {
    let message = "";
    try {
      await formatDocumentCitations({
        gateway: fakeGateway(),
        draftMarkdown: "# Review\n\nClaim [[cite:C2]].",
        clusters: [clusters[1]],
        corpus: [{ kind: "outside", paperId: "paper_gamma" }],
        evidence: [],
        spec,
        requireEvidence: false,
      });
    } catch (error) {
      message = String(error);
    }
    assert.match(message, /paper_gamma, which has no record to format it from/);
  });

  it("binds a saved mixed group's numbered links per name for display", function () {
    const bundle: FormattedCitationBundle = {
      clusters: [
        {
          citationId: "C1",
          text: "(Alpha, 2020; Beta, 2021)",
          html: "",
          sources: clusters[0].sources,
        },
      ],
      bibliographyEntries: [],
      style: { id: "apa", title: "APA" },
      locale: "en-US",
      outsidePapers: [{ ...betaPaper, csl: { ...betaPaper.csl, id: "ext-1" } }],
    };
    const markdown = `Claim (Alpha, 2020; Beta, 2021) [1](zotero://select/library/items/AAAA1111) [2](${PAREN_DOI_URI}).`;
    assert.equal(
      bindDocumentCitationGroupsForDisplay({
        markdown,
        bundle,
        gateway: fakeGateway(),
      }),
      `Claim ([Alpha, 2020](zotero://select/library/items/AAAA1111); [Beta, 2021](${PAREN_DOI_URI})).`,
    );
  });
});

function storedDocument(extra: Record<string, unknown> = {}) {
  return {
    version: 2,
    documentId: "run-1:document:1",
    documentVersion: 1,
    documentKind: "literature_review",
    integrityPolicy: "authored",
    origin: { kind: "direct", runId: "run-1", sourceMessageTimestamp: 10 },
    conversationKey: 7,
    title: "Review",
    visibleMarkdown: `# Review\n\nClaim [(Beta, 2021)](${PAREN_DOI_URI}).\n\n## References\n\n- [Beta. (2021). Title.](${PAREN_DOI_URI})\n`,
    visibleHtml: "<h1>Review</h1>",
    citationBundle: {
      clusters: [
        {
          citationId: "C1",
          text: "(Beta, 2021)",
          html: "(Beta, 2021)",
          sources: [
            { kind: "outside", paperId: "paper_beta", evidenceRefs: [] },
          ],
        },
      ],
      bibliographyEntries: [
        {
          paperId: "paper_beta",
          text: "Beta. (2021). Title.",
          html: "Beta. (2021). Title.",
        },
      ],
      style: { id: "apa", title: "APA" },
      locale: "en-US",
      outsidePapers: [
        {
          paperId: "paper_beta",
          doi: PAREN_DOI,
          csl: {
            id: "ext-1",
            type: "article-journal",
            title: "Beta drifts",
            author: [
              { family: "Beta", given: "Bea" },
              { literal: "Aristotle" },
            ],
            issued: { "date-parts": [[2021]] },
            DOI: PAREN_DOI,
            "container-title": "Journal of Drift",
          },
        },
      ],
    },
    verifiedQuotes: [],
    assets: [],
    coverageItems: [],
    validation: {
      integrityValidated: true,
      groundingReviewed: "not_run",
      quoteVerified: "not_applicable",
      issues: [],
    },
    contentHash: "sha256:document",
    createdAt: 10,
    citationDraft: {
      markdown: "# Review\n\nClaim [[cite:C1]].",
      clusters: [
        {
          citationId: "C1",
          sources: [
            { kind: "outside", paperId: "paper_beta", evidenceRefs: [] },
          ],
        },
      ],
    },
    revisionOf: { documentId: "run-0:document:1", documentVersion: 1 },
    ...extra,
  };
}

describe("the stored form of an outside bibliography", function () {
  it("round-trips outside entries, the paper snapshots, the citation draft and revisionOf", function () {
    const stored = storedDocument();
    const decoded = decodePlanDocument(JSON.parse(JSON.stringify(stored)));
    // Optional fields the decoder leaves undefined are not stored.
    assert.deepEqual(JSON.parse(JSON.stringify(decoded)), stored);
    assert.deepEqual(
      decodePlanDocument(JSON.parse(JSON.stringify(decoded))),
      decoded,
    );
  });

  it("still decodes a document stored before outside papers, adding no fields", function () {
    const old = storedDocument({
      citationDraft: undefined,
      revisionOf: undefined,
    }) as Record<string, any>;
    delete old.citationDraft;
    delete old.revisionOf;
    old.citationBundle = {
      clusters: [
        {
          citationId: "C1",
          text: "(Alpha, 2020)",
          html: "(Alpha, 2020)",
          sources: [
            {
              libraryID: 1,
              itemKey: "AAAA1111",
              evidenceRefs: [],
              locator: undefined,
            },
          ],
        },
      ],
      bibliographyEntries: [
        {
          libraryID: 1,
          itemKey: "AAAA1111",
          text: "Alpha. (2020).",
          html: "Alpha. (2020).",
        },
      ],
      style: { id: "apa", title: "APA" },
      locale: "en-US",
    };
    const decoded = decodePlanDocument(JSON.parse(JSON.stringify(old)));
    assert.deepEqual(decoded.citationBundle, old.citationBundle);
    assert.notProperty(decoded.citationBundle, "outsidePapers");
    assert.notProperty(decoded, "citationDraft");
    assert.notProperty(decoded, "revisionOf");
  });

  it("refuses a snapshot whose CSL id could be a Zotero id", function () {
    const stored = storedDocument() as Record<string, any>;
    stored.citationBundle.outsidePapers[0].csl.id = "42";
    assert.throws(() => decodePlanDocument(stored), /csl\.id is invalid/);
  });
});

describe("finalizing a document with an outside citation", function () {
  const scope = globalThis as typeof globalThis & { Zotero?: unknown };
  const original = scope.Zotero;

  beforeEach(function () {
    scope.Zotero = {
      Libraries: { userLibraryID: 1, get: () => undefined },
      Items: {
        getByLibraryAndKey: (_libraryID: number, itemKey: string) =>
          itemKey === "AAAA1111" ? { id: 10, isNote: () => false } : false,
      },
    };
  });

  afterEach(function () {
    scope.Zotero = original;
  });

  const finalize = (citations: PlanCitationCluster[]) =>
    finalizeDocument({
      gateway: fakeGateway(),
      now: 100,
      input: {
        title: "Review",
        markdown: "# Review\n\nClaim [[cite:C1]].",
        citations,
        quotes: [],
        assets: [],
        groundingReviewed: "passed",
        groundingIssues: [],
      },
      context: {
        documentId: "run:document:1",
        documentVersion: 1,
        conversationKey: 7,
        integrityPolicy: "authored",
        origin: { kind: "direct", runId: "run", sourceMessageTimestamp: 100 },
        coverageItems: [],
        spec: { ...spec, requiresReferences: true },
        corpus: citations.flatMap((cluster) => cluster.sources),
        evidence: [],
        quoteCorpusKeys: new Set(),
        outsidePapers: [betaPaper],
        validateAssetProvenance: () => undefined,
      },
    });

  it("keeps the tokenized draft and the clusters only when an outside paper is cited", async function () {
    const outside: PlanCitationCluster[] = [
      {
        citationId: "C1",
        sources: [{ kind: "outside", paperId: "paper_beta", evidenceRefs: [] }],
      },
    ];
    const { document } = await finalize(outside);
    assert.deepEqual(
      (document as Extract<PlanDocument, { version: 2 }>).citationDraft,
      { markdown: "# Review\n\nClaim [[cite:C1]].", clusters: outside },
    );
    const stored = JSON.parse(JSON.stringify(document));
    assert.deepEqual(
      JSON.parse(JSON.stringify(decodePlanDocument(stored))),
      stored,
      "the store decodes the document before saving it: nothing is lost",
    );

    const zotero = await finalize([
      {
        citationId: "C1",
        sources: [{ libraryID: 1, itemKey: "AAAA1111", evidenceRefs: [] }],
      },
    ]);
    assert.notProperty(zotero.document, "citationDraft");
    assert.notProperty(zotero.document.citationBundle, "outsidePapers");
  });
});

describe("the document card's outside links", function () {
  const scope = globalThis as typeof globalThis & { Zotero?: unknown };
  const original = scope.Zotero;
  let launched: string[];

  beforeEach(function () {
    launched = [];
    scope.Zotero = {
      Libraries: { userLibraryID: 1, get: () => undefined },
      Items: { getByLibraryAndKey: () => null, get: () => null },
      launchURL: (url: string) => void launched.push(url),
    };
  });

  afterEach(function () {
    scope.Zotero = original;
  });

  function link(href: string, text: string, parent: FakeElement) {
    const anchor = new FakeElement("a");
    anchor.setAttribute("href", href);
    anchor.textContent = text;
    parent.appendChild(anchor);
    return anchor;
  }

  function renderedCard() {
    const root = new FakeElement("div");
    const paragraph = new FakeElement("p");
    root.appendChild(paragraph);
    // The parser may hand back the link target decoded.
    const body = link(decodeURI(PAREN_DOI_URI), "(Beta, 2021)", paragraph);
    const bullets = new FakeElement("ul");
    root.appendChild(bullets);
    const bulletItem = new FakeElement("li");
    bullets.appendChild(bulletItem);
    const bulletLink = link(PAREN_DOI_URI, "(Beta, 2021)", bulletItem);
    const references = new FakeElement("ul");
    root.appendChild(references);
    const entries = [
      ["zotero://select/library/items/AAAA1111", "Alpha. (2020). Title."],
      [PAREN_DOI_URI, "Beta. (2021). Title."],
    ].map(([href, text]) => {
      const item = new FakeElement("li");
      references.appendChild(item);
      return link(href, text, item);
    });
    return { root, body, bulletLink, entries };
  }

  const document = () =>
    decodePlanDocument({
      ...storedDocument(),
      citationBundle: {
        ...storedDocument().citationBundle,
        clusters: [
          {
            citationId: "C0",
            text: "(Alpha, 2020)",
            html: "(Alpha, 2020)",
            sources: [{ libraryID: 1, itemKey: "AAAA1111", evidenceRefs: [] }],
          },
          ...storedDocument().citationBundle.clusters,
        ],
        bibliographyEntries: [
          {
            libraryID: 1,
            itemKey: "AAAA1111",
            text: "Alpha. (2020). Title.",
            html: "Alpha. (2020). Title.",
          },
          {
            paperId: "paper_beta",
            text: "Beta. (2021). Title.",
            html: "Beta. (2021). Title.",
          },
        ],
      },
    });

  it("opens an outside citation at doi.org in the browser", function () {
    const card = renderedCard();
    decoratePlanDocumentCitations({
      doc: fakeDocument,
      root: card.root as unknown as HTMLElement,
      document: document(),
    });
    assert.equal(card.body.getAttribute("href"), PAREN_DOI_URI);
    assert.equal(card.body.dataset.llmPlanCitationSource, "outside");
    assert.equal(card.body.title, "Open at doi.org");
    const event = card.body.dispatchFakeEvent("click");
    assert.isTrue(event.defaultPrevented);
    assert.isTrue(event.propagationStopped);
    assert.deepEqual(launched, [PAREN_DOI_URI]);
  });

  it("names a paper page when the paper has no DOI", function () {
    const stored = storedDocument() as Record<string, any>;
    stored.citationBundle.outsidePapers[0] = {
      paperId: "paper_beta",
      arxivId: "2101.00001",
      csl: { id: "ext-1", type: "article" },
    };
    const root = new FakeElement("div");
    const anchor = link(
      "https://arxiv.org/abs/2101.00001",
      "(Beta, 2021)",
      root,
    );
    decoratePlanDocumentCitations({
      doc: fakeDocument,
      root: root as unknown as HTMLElement,
      document: decodePlanDocument(stored),
    });
    assert.equal(anchor.title, "Open paper page");
  });

  it("marks only outside References entries, and only on screen", function () {
    const card = renderedCard();
    const doc = document();
    decoratePlanDocumentCitations({
      doc: fakeDocument,
      root: card.root as unknown as HTMLElement,
      document: doc,
    });
    // Decorating twice draws one marker.
    decoratePlanDocumentCitations({
      doc: fakeDocument,
      root: card.root as unknown as HTMLElement,
      document: doc,
    });
    const markers = card.root.findAllByClass(
      "llm-plan-document-outside-marker",
    );
    assert.lengthOf(markers, 1);
    assert.equal(markers[0].parentElement, card.entries[1].parentElement);
    assert.equal(markers[0].textContent, " · Not in library");
    assert.equal(
      card.entries[1].nextSibling,
      markers[0],
      "the marker follows its entry",
    );
    assert.equal(
      collectFakeText(card.entries[0].parentElement),
      "Alpha. (2020). Title.",
    );
    assert.equal(
      collectFakeText(card.bulletLink.parentElement),
      "(Beta, 2021)",
      "a citation in a body list is not a References entry",
    );
    assert.equal(card.entries[0].title, "Open cited Zotero source");
    assert.notInclude(doc.visibleMarkdown, "Not in library");
    assert.notInclude(
      renderMarkdownForNote(doc.visibleMarkdown),
      "Not in library",
    );
  });
});
