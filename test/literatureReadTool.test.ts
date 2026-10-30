import { assert } from "chai";
import { readFileSync } from "node:fs";
import {
  createLiteratureReadTool,
  validateLiteratureReadInput,
} from "../src/agent/tools/read/literatureRead";
import {
  LITERATURE_READ_MAX_REQUESTS,
  literatureReadTesting,
  normalizeLiteratureReadIdentifier,
} from "../src/agent/services/literatureReadService";
import { createLiteratureSearchTool } from "../src/agent/tools/read/literatureSearch";
import { LiteratureSearchService } from "../src/agent/services/literatureSearchService";
import {
  clearAgentToolResultHandleStore,
  hasAgentToolResultHandles,
} from "../src/agent/store/toolResultHandles";
import {
  getZoteroMcpDirectPdfToolNames,
  ZOTERO_MCP_SAFE_READ_TOOL_NAMES,
} from "../src/agent/mcp/server";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import { AGENT_SEARCH_TOOL_ROUTES } from "../src/agent/model/agentPersona";
import { estimateTextTokens } from "../src/utils/modelInputCap";
import type { AgentToolContext } from "../src/agent/types";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

type Route = {
  match: string;
  status?: number;
  text?: string;
  /** Throw like Zotero.HTTP does for a non-2xx status or a timeout. */
  throws?: unknown;
};

const JATS_EXCERPT = readFileSync(
  new URL("./fixtures/literatureRead/PMC13588937-excerpt.xml", import.meta.url),
  "utf8",
);
const EFETCH_WITH_BODY = `<pmc-articleset>${JATS_EXCERPT.replace(/^[\s\S]*?(<article)/, "$1")}</pmc-articleset>`;
const EFETCH_WITHOUT_BODY = `<pmc-articleset><article><front><article-meta><article-id pub-id-type="pmcid">PMC13575306</article-id><title-group><article-title>Restricted paper</article-title></title-group><abstract><title>ABSTRACT</title><p>Only the abstract is public.</p></abstract></article-meta></front></article></pmc-articleset>`;

function epmcHit(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    hitCount: 1,
    resultList: {
      result: [
        {
          id: "42760272",
          source: "MED",
          pmid: "42760272",
          pmcid: "PMC13588937",
          doi: "10.1002/hipo.70131",
          title: "Decoding Medial Entorhinal Cortical Dynamics.",
          authorList: {
            author: [
              { firstName: "Masahiro", lastName: "Nakano" },
              { firstName: "Caswell", lastName: "Barry" },
              { firstName: "Claudia", lastName: "Clopath" },
            ],
          },
          pubYear: "2026",
          abstractText: "The hippocampus is central to memory and planning.",
          isOpenAccess: "Y",
          license: "cc by",
          ...overrides,
        },
      ],
    },
  });
}

const EPMC_EMPTY = JSON.stringify({ hitCount: 0, resultList: { result: [] } });

const ARXIV_ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/1706.03762v7</id><title>Attention Is All You Need</title><summary>The dominant sequence transduction models.</summary><published>2017-06-12T00:00:00Z</published><link href="https://arxiv.org/pdf/1706.03762v7" title="pdf" type="application/pdf"/><author><name>Ashish Vaswani</name></author><author><name>Noam Shazeer</name></author><author><name>Niki Parmar</name></author></entry></feed>`;
const OLD_ARXIV_ATOM = ARXIV_ATOM.replaceAll("1706.03762v7", "hep-th/9711200v3")
  .replace("Attention Is All You Need", "The Large N Limit")
  .replace(
    /<author>.*<\/author>/,
    "<author><name>Juan Maldacena</name></author>",
  );
const ARXIV_HTML = `<html><body><article class="ltx_document"><div class="ltx_abstract"><p>The dominant models.</p></div><section class="ltx_section"><h2 class="ltx_title"><span class="ltx_tag">1 </span>Introduction</h2><div class="ltx_para"><p>Attention replaces recurrence entirely.</p></div></section><section class="ltx_section"><h2 class="ltx_title"><span class="ltx_tag">2 </span>Model</h2><div class="ltx_para"><p>Multi-head attention runs in parallel.</p></div></section></article></body></html>`;

const OPENALEX_WORK = JSON.stringify({
  id: "https://openalex.org/W1",
  doi: "https://doi.org/10.1016/j.example.2020.01.001",
  display_name: "An Elsevier paper",
  publication_year: 2020,
  authorships: [{ author: { display_name: "Grace Hopper" } }],
  abstract_inverted_index: { Compilers: [0], matter: [1] },
  ids: { openalex: "https://openalex.org/W1" },
  open_access: { is_oa: true, oa_url: "https://example.org/landing" },
  best_oa_location: {
    pdf_url: "https://example.org/paper.pdf",
    landing_page_url: "https://example.org/landing",
  },
});

describe("literature_read tool", function () {
  const originalZotero = globalThis.Zotero;
  let requested: string[] = [];
  let unexpected: string[] = [];
  let sleeps: number[] = [];
  let now = 1_000_000;

  function stubHttp(routes: Route[]) {
    requested = [];
    unexpected = [];
    globalThis.Zotero = {
      HTTP: {
        request: async (_method: string, url: string) => {
          requested.push(url);
          const route = routes.find((entry) => url.includes(entry.match));
          if (!route) {
            unexpected.push(url);
            throw new Error(`Unexpected URL: ${url}`);
          }
          if (route.throws) throw route.throws;
          return {
            status: route.status ?? 200,
            responseText: route.text ?? "",
          };
        },
      },
    } as unknown as typeof Zotero;
  }

  const context: AgentToolContext = {
    runId: "literature-read-test",
    request: resolvedAgentRequest({
      conversationKey: 4242,
      mode: "agent",
      userText: "Did other studies find the same result?",
      libraryID: 1,
    }),
    item: null,
    currentAnswerText: "",
    modelName: "test",
  };

  async function read(args: Record<string, unknown>) {
    const tool = createLiteratureReadTool();
    const validated = tool.validate(args);
    if (!validated.ok) throw new Error(validated.error);
    return (await tool.execute(validated.value, context)) as Record<
      string,
      any
    >;
  }

  function assertNoForbiddenOpenAlexCalls() {
    for (const url of requested) {
      assert.notInclude(url, "content.openalex.org");
      assert.notMatch(url, /api\.openalex\.org\/works\?/);
    }
  }

  beforeEach(function () {
    literatureReadTesting.reset();
    now = 1_000_000;
    sleeps = [];
    literatureReadTesting.setClock({
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    clearAgentToolResultHandleStore();
  });

  afterEach(function () {
    globalThis.Zotero = originalZotero;
    literatureReadTesting.reset();
    assert.deepEqual(unexpected, [], "the test stubbed every requested URL");
  });

  describe("identifiers and validation", function () {
    it("normalizes DOI, PMID, PMCID and arXiv forms", function () {
      const cases: Array<[string, string, string | null]> = [
        ["doi", "https://doi.org/10.1002/hipo.70131", "10.1002/hipo.70131"],
        ["doi", "doi: 10.1002/hipo.70131", "10.1002/hipo.70131"],
        ["doi", "hipo.70131", null],
        ["pmid", "42760272", "42760272"],
        ["pmid", "PMID:42760272", "42760272"],
        ["pmid", "abc", null],
        ["pmcid", "13588937", "PMC13588937"],
        ["pmcid", "pmc13588937", "PMC13588937"],
        ["pmcid", "PMC13588937.1", "PMC13588937"],
        ["arxivId", "arXiv:1706.03762v7", "1706.03762"],
        ["arxivId", "https://arxiv.org/abs/2401.04088", "2401.04088"],
        ["arxivId", "hep-th/9711200v3", "hep-th/9711200"],
        ["arxivId", "not-an-id", null],
      ];
      for (const [kind, raw, expected] of cases) {
        const normalized = normalizeLiteratureReadIdentifier(
          kind as never,
          raw,
        );
        assert.equal(normalized?.value ?? null, expected, `${kind} ${raw}`);
      }
    });

    it("requires exactly one valid identifier", function () {
      const none = validateLiteratureReadInput({ query: "x" });
      assert.isFalse(none.ok);
      if (!none.ok) assert.include(none.error, "exactly one of doi, pmid");
      const several = validateLiteratureReadInput({
        doi: "10.1/x",
        pmid: "1",
      });
      assert.isFalse(several.ok);
      if (!several.ok) assert.include(several.error, "not doi and pmid");
      const bad = validateLiteratureReadInput({ doi: "nonsense" });
      assert.isFalse(bad.ok);
      if (!bad.ok) assert.include(bad.error, "not a valid DOI");
      const offset = validateLiteratureReadInput({
        doi: "10.1/x",
        textOffset: 10,
      });
      assert.isFalse(offset.ok);
      assert.isTrue(
        validateLiteratureReadInput({ pmcid: "123", section: 2, textOffset: 5 })
          .ok,
      );
    });
  });

  describe("resolution ladder", function () {
    it("reads arXiv through the export API, then LaTeXML HTML, spaced three seconds apart", async function () {
      stubHttp([
        { match: "export.arxiv.org/api/query", text: ARXIV_ATOM },
        { match: "arxiv.org/html/1706.03762", text: ARXIV_HTML },
      ]);
      const result = await read({ arxivId: "arXiv:1706.03762v7" });
      assert.deepEqual(requested, [
        "https://export.arxiv.org/api/query?id_list=1706.03762&max_results=1",
        "https://arxiv.org/html/1706.03762",
      ]);
      assert.deepEqual(sleeps, [3_000]);
      assert.equal(result.fullText.status, "open_access");
      assert.equal(result.sourceLabel, "(Vaswani et al., 2017)");
      assert.equal(
        result.abstract,
        "The dominant sequence transduction models.",
      );
      assert.deepEqual(
        result.sections.map((s: { title: string }) => s.title),
        ["Introduction", "Model"],
      );
      assert.include(result.citation, "https://arxiv.org/abs/1706.03762");
    });

    it("returns an old-style arXiv paper without HTML as abstract-only with its PDF link", async function () {
      stubHttp([
        { match: "export.arxiv.org/api/query", text: OLD_ARXIV_ATOM },
        { match: "arxiv.org/html/hep-th/9711200", status: 404, text: "nf" },
      ]);
      const result = await read({ arxivId: "hep-th/9711200" });
      assert.equal(result.fullText.status, "abstract_only");
      assert.equal(result.fullText.reason, "no_html");
      assert.equal(
        result.fullText.pdfUrl,
        "https://arxiv.org/pdf/hep-th/9711200v3",
      );
      assert.equal(result.sourceLabel, "(Maldacena, 2017)");
      assert.notProperty(result, "sections");
    });

    it("reads an open-access DOI from Europe PMC fullTextXML", async function () {
      stubHttp([
        { match: "/rest/search?", text: epmcHit() },
        { match: "/PMC13588937/fullTextXML", text: JATS_EXCERPT },
      ]);
      const result = await read({ doi: "https://doi.org/10.1002/hipo.70131" });
      assert.lengthOf(requested, 2);
      assert.include(
        decodeURIComponent(requested[0]),
        'query=DOI:"10.1002/hipo.70131"&resultType=core',
      );
      assert.equal(result.source, "europepmc");
      assert.equal(result.fullText.status, "open_access");
      assert.equal(result.paper.pmcid, "PMC13588937");
      assert.equal(
        result.paper.title,
        "Decoding Medial Entorhinal Cortical Dynamics",
      );
      assert.equal(result.sourceLabel, "(Nakano et al., 2026)");
      assert.equal(
        result.abstract,
        "The hippocampus is central to memory and planning.",
      );
      assert.include(
        result.sections.map((s: { title: string }) => s.title),
        "Simulation of Left–Right Sweeps",
      );
      assert.include(result.citation, "https://doi.org/10.1002/hipo.70131");
      assert.include(result.citation, "no [[cite:]] or [[quote:]] anchors");
      // A document cites it by paperId; Markdown links are for chat.
      assert.match(
        result.citation,
        /^In a chat answer, cite this outside paper/,
      );
      assert.include(
        result.citation,
        "in a submit_document document, cite it by its paperId.",
      );
    });

    it("reads a non-open-access paper with a PMCID through NCBI efetch", async function () {
      stubHttp([
        { match: "/rest/search?", text: epmcHit({ isOpenAccess: "N" }) },
        { match: "efetch.fcgi", text: EFETCH_WITH_BODY },
      ]);
      const result = await read({ pmid: "42760272" });
      assert.lengthOf(requested, 2);
      assert.include(
        requested[1],
        "efetch.fcgi?db=pmc&id=13588937&tool=llm-for-zotero&email=llm-for-zotero%40github.com",
      );
      assert.equal(result.source, "pmc");
      assert.equal(result.fullText.status, "open_access");
    });

    it("reports abstract-only when efetch returns no body", async function () {
      stubHttp([
        {
          match: "/rest/search?",
          text: epmcHit({ isOpenAccess: "N", pmcid: "PMC13575306" }),
        },
        { match: "efetch.fcgi", text: EFETCH_WITHOUT_BODY },
      ]);
      const result = await read({ pmcid: "13575306" });
      assert.equal(result.fullText.status, "abstract_only");
      assert.equal(result.fullText.reason, "not_open_access");
      assert.include(result.fullText.note, "answer from the abstract");
      assert.notProperty(result, "sections");
    });

    it("falls back to efetch when Europe PMC fullTextXML answers HTTP 500", async function () {
      stubHttp([
        { match: "/rest/search?", text: epmcHit() },
        {
          match: "/fullTextXML",
          throws: {
            status: 500,
            xmlhttp: { status: 500, responseText: '{"status":500}' },
          },
        },
        { match: "efetch.fcgi", text: EFETCH_WITH_BODY },
      ]);
      const result = await read({ doi: "10.1002/hipo.70131" });
      assert.lengthOf(requested, 3);
      assert.equal(result.source, "pmc");
      assert.equal(result.fullText.status, "open_access");
    });

    it("looks a DOI Europe PMC does not know up once in OpenAlex and returns the PDF link", async function () {
      stubHttp([
        { match: "/rest/search?", text: EPMC_EMPTY },
        { match: "api.openalex.org/works/", text: OPENALEX_WORK },
      ]);
      const result = await read({ doi: "10.1016/j.example.2020.01.001" });
      assert.lengthOf(requested, 2);
      assert.include(
        requested[1],
        "https://api.openalex.org/works/https%3A%2F%2Fdoi.org%2F10.1016%2Fj.example.2020.01.001?select=",
      );
      assertNoForbiddenOpenAlexCalls();
      assert.equal(result.source, "openalex");
      assert.equal(result.fullText.status, "pdf_only");
      assert.equal(result.fullText.pdfUrl, "https://example.org/paper.pdf");
      assert.equal(result.abstract, "Compilers matter");
      assert.equal(result.sourceLabel, "(Hopper, 2020)");
      assert.include(result.fullText.note, "does not read PDFs");
    });

    it("stops at four requests when OpenAlex leads back through Europe PMC", async function () {
      const work = JSON.parse(OPENALEX_WORK);
      work.ids.pmid = "https://pubmed.ncbi.nlm.nih.gov/42760272";
      let searches = 0;
      stubHttp([
        {
          match: "/rest/search?",
          get text() {
            searches += 1;
            return searches === 1 ? EPMC_EMPTY : epmcHit();
          },
        } as Route,
        { match: "api.openalex.org/works/", text: JSON.stringify(work) },
        { match: "/fullTextXML", status: 500, text: "{}" },
        { match: "efetch.fcgi", text: EFETCH_WITH_BODY },
      ]);
      const result = await read({ doi: "10.1016/j.example.2020.01.001" });
      assert.lengthOf(requested, LITERATURE_READ_MAX_REQUESTS);
      assert.notInclude(requested.join(" "), "efetch.fcgi");
      assertNoForbiddenOpenAlexCalls();
      assert.equal(result.paper.pmid, "42760272");
      assert.notEqual(result.fullText.status, "open_access");
    });

    it("states a rate limit fail-fast, keeps the abstract and is not cached", async function () {
      stubHttp([
        { match: "/rest/search?", text: epmcHit() },
        { match: "/fullTextXML", status: 429, text: "Too Many Requests" },
      ]);
      const result = await read({ doi: "10.1002/hipo.70131" });
      assert.lengthOf(requested, 2);
      assert.equal(result.fullText.status, "unavailable");
      assert.equal(result.fullText.reason, "rate_limited");
      assert.equal(
        result.abstract,
        "The hippocampus is central to memory and planning.",
      );
      assert.include(
        result.fullText.note,
        "do not retry this paper by shell, sleep or repeated calls",
      );
      await read({ doi: "10.1002/hipo.70131" });
      assert.lengthOf(requested, 4, "a transient failure is not cached");
    });

    it("treats a resolved status 0 as a network error and does not cache it", async function () {
      stubHttp([{ match: "/rest/search?", status: 0 }]);
      const result = await read({ pmid: "1" });
      assert.equal(result.fullText.reason, "network_error");
      await read({ pmid: "1" });
      assert.lengthOf(requested, 2, "a network blip is not cached");
    });

    it("does not cache a 403 challenge or an unparsable 200", async function () {
      stubHttp([{ match: "/rest/search?", status: 403, text: "challenge" }]);
      const blocked = await read({ pmid: "1" });
      assert.equal(blocked.fullText.reason, "request_failed");
      await read({ pmid: "1" });
      assert.lengthOf(requested, 2, "a 403 is not cached");
      stubHttp([{ match: "/rest/search?", text: "<html>not json</html>" }]);
      await read({ pmid: "2" });
      await read({ pmid: "2" });
      assert.lengthOf(requested, 2, "an unparsable 200 is not cached");
    });

    it("caches not_found", async function () {
      stubHttp([{ match: "/rest/search?", text: EPMC_EMPTY }]);
      const result = await read({ pmid: "3" });
      assert.equal(result.fullText.reason, "not_found");
      await read({ pmid: "3" });
      assert.lengthOf(requested, 1);
    });

    it("states a timeout on the first request without guessing another route", async function () {
      stubHttp([
        {
          match: "/rest/search?",
          throws: Object.assign(new Error("Request timed out"), {
            name: "TimeoutException",
          }),
        },
      ]);
      const result = await read({ pmid: "1" });
      assert.lengthOf(requested, 1);
      assert.equal(result.fullText.status, "unavailable");
      assert.equal(result.fullText.reason, "timeout");
    });
  });

  describe("bounded output", function () {
    function longJats() {
      const paragraph = (n: number, topic: string) =>
        `<p>Paragraph ${n} about ${topic}. ${"Neurons fire in sequences across the maze. ".repeat(20)}</p>`;
      const secs = Array.from(
        { length: 12 },
        (_, s) =>
          `<sec><title>Section ${s + 1}</title>${Array.from({ length: 6 }, (_, p) => paragraph(p, s === 7 ? "theta skipping in entorhinal cortex" : "place fields")).join("")}</sec>`,
      ).join("");
      return `<article><front><article-meta><title-group><article-title>Long</article-title></title-group><abstract><p>${"Abstract sentence. ".repeat(40)}</p></abstract></article-meta></front><body>${secs}</body></article>`;
    }

    beforeEach(function () {
      stubHttp([
        { match: "/rest/search?", text: epmcHit() },
        { match: "/fullTextXML", text: longJats() },
      ]);
    });

    it("keeps every mode under the 6,000-token budget", async function () {
      const overview = await read({ pmcid: "PMC13588937" });
      assert.isAtMost(estimateTextTokens(JSON.stringify(overview)), 6_000);
      assert.lengthOf(overview.sections, 12);
      const passages = await read({
        pmcid: "PMC13588937",
        query: "theta skipping entorhinal",
      });
      assert.isAtMost(estimateTextTokens(JSON.stringify(passages)), 6_000);
      assert.isAbove(passages.passages.length, 0);
      for (const passage of passages.passages) {
        assert.equal(passage.section, "8 Section 8");
      }
      const section = await read({ pmcid: "PMC13588937", section: "3" });
      assert.isAtMost(estimateTextTokens(JSON.stringify(section)), 6_000);
      assert.lengthOf(requested, 2, "follow-ups read the cached paper");
    });

    it("bounds the result for a record with thousands of authors", async function () {
      const authors = Array.from({ length: 3_000 }, (_, index) => ({
        firstName: `Given${index}`,
        lastName: `Surname${index}`,
      }));
      stubHttp([
        {
          match: "/rest/search?",
          text: epmcHit({
            authorList: { author: authors },
            title: "T".repeat(5_000),
            license: "L".repeat(5_000),
          }),
        },
        { match: "/fullTextXML", text: longJats() },
      ]);
      const overview = await read({ pmcid: "PMC13588937" });
      assert.lengthOf(overview.paper.authors, 10);
      assert.equal(overview.paper.authorCount, 3_000);
      for (const args of [
        {},
        { query: "theta skipping entorhinal" },
        { section: "3" },
        { section: "99" },
      ]) {
        const result = await read({ pmcid: "PMC13588937", ...args });
        assert.isAtMost(
          estimateTextTokens(JSON.stringify(result)),
          6_000,
          JSON.stringify(args),
        );
      }
    });

    it("pages a section losslessly with textOffset", async function () {
      const first = await read({ pmcid: "PMC13588937", section: "Section 5" });
      assert.deepEqual(first.section, { number: "5", title: "Section 5" });
      let text = first.text as string;
      let next = first.nextTextOffset as number | undefined;
      // Shrink the budget's effect by reading the long text in pages.
      while (next !== undefined) {
        const page = await read({
          pmcid: "PMC13588937",
          section: "5",
          textOffset: next,
        });
        assert.equal(page.textOffset, next);
        text += page.text;
        next = page.nextTextOffset;
      }
      assert.equal(text.length, first.totalChars);
      assert.match(text, /^## 5 Section 5\n\nParagraph 0 about place fields\./);
      assert.lengthOf(requested, 2);
    });

    it("names the outline when a section does not match", async function () {
      const result = await read({ pmcid: "PMC13588937", section: "Methods" });
      assert.include(result.error, 'No section matches "Methods"');
      assert.lengthOf(result.sections, 12);
    });
  });

  describe("cache", function () {
    it("expires entries after the TTL and evicts the oldest past the cap", async function () {
      stubHttp([
        {
          match: "/rest/search?",
          text: epmcHit({ isOpenAccess: "N", pmcid: "" }),
        },
      ]);
      await read({ pmid: "1" });
      await read({ pmid: "1" });
      assert.lengthOf(requested, 1);
      now += literatureReadTesting.CACHE_TTL_MS + 1;
      await read({ pmid: "1" });
      assert.lengthOf(requested, 2);
      for (
        let id = 2;
        id <= literatureReadTesting.CACHE_MAX_ENTRIES + 1;
        id += 1
      )
        await read({ pmid: String(id) });
      assert.equal(
        literatureReadTesting.cacheSize(),
        literatureReadTesting.CACHE_MAX_ENTRIES,
      );
      const before = requested.length;
      await read({ pmid: "1" });
      assert.lengthOf(requested, before + 1, "the oldest entry was evicted");
    });
  });

  describe("reading never imports", function () {
    it("stores no handle record and returns no candidate fields", async function () {
      stubHttp([
        { match: "/rest/search?", text: epmcHit() },
        { match: "/fullTextXML", text: JATS_EXCERPT },
      ]);
      const result = await read({ doi: "10.1002/hipo.70131" });
      assert.isFalse(hasAgentToolResultHandles(4242));
      for (const key of [
        "candidateSetId",
        "candidateIndex",
        "sessionId",
        "nextStep",
        "reviewRequired",
      ]) {
        assert.notProperty(result, key);
      }
      const source = readFileSync(
        new URL("../src/agent/tools/read/literatureRead.ts", import.meta.url),
        "utf8",
      );
      assert.notInclude(source, "literatureDiscovery");
      assert.notInclude(source, "toolResultHandles");
    });
  });

  describe("tool contract and exposure", function () {
    it("describes reading compactly, with the identifier rule the schema cannot carry", function () {
      const tool = createLiteratureReadTool();
      const description = tool.spec.description;
      assert.include(
        description,
        "Give exactly one of doi, pmid, pmcid or arxivId",
      );
      assert.include(description, "Never imports");
      assert.include(description, "instead of shell or curl");
      assert.isBelow(description.length, 600);
      assert.equal(tool.spec.executionClass, "read");
      assert.equal(tool.spec.workCategory, "retrieval");
      assert.equal(tool.presentation?.label, "Read Outside Paper");
      assert.notProperty(
        (tool.spec.inputSchema as { properties: object }).properties,
        "need",
      );
    });

    it("plans a read-only network egress naming the identifier", function () {
      const tool = createLiteratureReadTool();
      const validated = tool.validate({ doi: "doi:10.1002/hipo.70131" });
      assert.isTrue(validated.ok);
      if (!validated.ok) return;
      const plan = tool.planInvocation!(validated.value, context);
      assert.equal(plan.impact, "read_only");
      assert.deepEqual(plan.domains, ["network"]);
      assert.deepEqual(plan.effects, ["read", "egress"]);
      assert.deepEqual(plan.targets, ["DOI 10.1002/hipo.70131"]);
    });

    it("summarizes reading, not searching, and links the paper in the trace", function () {
      const tool = createLiteratureReadTool();
      const onCall = tool.presentation!.summaries!.onCall as (input: {
        label: string;
        args: unknown;
      }) => string;
      assert.equal(
        onCall({ label: "", args: { pmcid: "123" } }),
        "Reading outside paper (PMCID PMC123)",
      );
      const details = tool.presentation!.buildTraceDetails!({
        args: { doi: "10.1000/x" },
        content: {
          sourceLabel: "(Smith et al., 2021)",
          paper: { title: "A paper", url: "https://doi.org/10.1000/x" },
        },
      });
      assert.deepEqual(details, [
        {
          label: "Paper",
          value: "Smith et al., 2021, A paper",
          timeline: { icon: "paper", href: "https://doi.org/10.1000/x" },
        },
      ]);
    });

    it("is registered, safe over MCP and visible in direct-path PDF turns", function () {
      const registry = createBuiltInToolRegistry({
        zoteroGateway: {} as never,
        pdfService: {} as never,
        pdfPageService: {} as never,
        retrievalService: {} as never,
      });
      assert.isOk(registry.getTool("literature_read"));
      assert.include([...ZOTERO_MCP_SAFE_READ_TOOL_NAMES], "literature_read");
      const directPdf = getZoteroMcpDirectPdfToolNames();
      assert.include(directPdf, "literature_read");
      assert.notInclude(directPdf, "literature_search");
      assert.include(
        AGENT_SEARCH_TOOL_ROUTES,
        "literature_read reads a found paper's abstract and open-access text",
      );
    });

    it("sends a DOI-only literature_search to literature_read", function () {
      const validated = createLiteratureSearchTool({} as never).validate({
        mode: "search",
        doi: "10.1/x",
        need: "user_named_outside_source",
      });
      assert.isFalse(validated.ok);
      if (!validated.ok) {
        assert.include(
          validated.error,
          "to read one paper by DOI, PMID, PMCID or arXiv ID, use literature_read",
        );
      }
    });
  });

  describe("literature_search results carry reading identifiers", function () {
    const originalFetch = globalThis.fetch;
    afterEach(function () {
      globalThis.fetch = originalFetch;
    });

    const gateway = {
      resolveMetadataItem: () => null,
      getEditableArticleMetadata: () => null,
    } as never;

    it("adds pmid, pmcid and openAccess to Europe PMC results", async function () {
      stubHttp([{ match: "/rest/search?", text: epmcHit() }]);
      const result = (await new LiteratureSearchService(gateway).execute(
        { mode: "search", source: "europepmc", query: "theta sequences" },
        context,
      )) as { results: Array<Record<string, unknown>> };
      assert.include(result.results[0], {
        pmid: "42760272",
        pmcid: "PMC13588937",
        openAccess: true,
      });
    });

    it("selects OpenAlex ids and adds the PMID", async function () {
      const urls: string[] = [];
      globalThis.fetch = (async (url: string | URL | Request) => {
        urls.push(String(url));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [
              {
                id: "https://openalex.org/W9",
                display_name: "A biomedical paper",
                ids: { pmid: "https://pubmed.ncbi.nlm.nih.gov/123456" },
              },
            ],
          }),
        } as Response;
      }) as typeof fetch;
      const result = (await new LiteratureSearchService(gateway).execute(
        { mode: "search", source: "openalex", query: "theta sequences" },
        context,
      )) as { results: Array<Record<string, unknown>> };
      assert.match(urls[0], /select=[^&]*ids/);
      assert.equal(result.results[0].pmid, "123456");
    });
  });
});
