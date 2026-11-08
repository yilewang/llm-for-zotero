import { assert } from "chai";
import {
  createWebReadTool,
  validateWebReadInput,
} from "../src/agent/tools/read/webRead";
import {
  clearWebSourcesForRun,
  registerWebSearchSources,
} from "../src/webAccess/runSources";
import {
  buildWebPageSections,
  getStoredWebPage,
  readWebPageRange,
  readWebPageSections,
  storeWebPage,
} from "../src/webAccess/webPageStore";
import { normalizePageText } from "../src/webAccess/pageText";
import { TavilyClient } from "../src/webAccess/tavilyClient";
import { setWebAccessProvider } from "../src/webAccess/prefs";
import type {
  WebAccessProvider,
  WebReadRequest,
  WebSourceRecord,
} from "../src/webAccess/types";
import type { AgentToolContext } from "../src/agent/types";

const RUN = "run-web-read-modes";
const URL_A = "https://example.org/guide";

const PAGE = [
  "Intro text that comes before any heading. ".repeat(8),
  "# Guide",
  "Welcome.",
  "## Install",
  "Install steps. ".repeat(40),
  "### On macOS",
  "Mac steps. ".repeat(30),
  "## Use",
  "```",
  "# not a heading inside code",
  "```",
  "Use it like this. ".repeat(40),
  "# Appendix",
  "Extra.",
].join("\n\n");

function record(url: string, content?: string): WebSourceRecord {
  return {
    sourceId: "provider-id",
    url,
    hostname: "example.org",
    organization: "Example",
    title: "Guide",
    ...(content !== undefined ? { content } : {}),
  };
}

describe("web pages read in steps", function () {
  afterEach(function () {
    clearWebSourcesForRun(RUN);
  });

  describe("the page's sections", function () {
    it("makes one section per heading, holding its subsections", function () {
      const sections = buildWebPageSections(PAGE);
      assert.deepEqual(
        sections.map((section) => [section.id, section.heading, section.level]),
        [
          ["s0", "(Start of page)", 1],
          ["s1", "Guide", 1],
          ["s2", "Install", 2],
          ["s3", "On macOS", 3],
          ["s4", "Use", 2],
          ["s5", "Appendix", 1],
        ],
      );
      const install = sections[2];
      assert.include(PAGE.slice(install.start, install.end), "Mac steps.");
      assert.notInclude(PAGE.slice(install.start, install.end), "## Use");
      const guide = sections[1];
      assert.include(PAGE.slice(guide.start, guide.end), "Use it like this.");
      assert.notInclude(PAGE.slice(guide.start, guide.end), "Appendix");
    });

    it("splits a page without headings into parts at paragraph breaks", function () {
      const text = Array.from(
        { length: 30 },
        (_, index) => `Paragraph ${index}. ${"Words here. ".repeat(40)}`,
      ).join("\n\n");
      const sections = buildWebPageSections(text);
      assert.isAbove(sections.length, 2);
      assert.equal(sections[0].id, "p1");
      assert.match(sections[0].heading, /^Part 1: Paragraph 0\./);
      for (const section of sections.slice(1)) {
        assert.match(text.slice(section.start), /^Paragraph \d+\./);
      }
      assert.equal(sections.at(-1)!.end, text.length);
    });
  });

  describe("reading a kept page", function () {
    it("reads the whole page in pieces that end at breaks and join up", function () {
      const page = storeWebPage(RUN, record(URL_A, PAGE));
      const pieces: string[] = [];
      let offset: number | undefined = 0;
      let guard = 0;
      while (offset !== undefined && guard++ < 20) {
        const piece = readWebPageRange(page, offset, 2_000);
        assert.isAtMost(piece.content.length, 2_000);
        pieces.push(piece.content);
        offset = piece.nextOffset;
      }
      assert.isUndefined(offset);
      assert.equal(
        pieces.join(" ").replace(/\s+/g, " "),
        PAGE.replace(/\s+/g, " "),
      );
    });

    it("reads chosen sections once each, and says where the rest starts", function () {
      const page = storeWebPage(RUN, record(URL_A, PAGE));
      const both = readWebPageSections(page, ["s3", "s2", "s9"], 40_000);
      assert.deepEqual(both.sectionIds, ["s2", "s3"]);
      assert.deepEqual(both.unknownIds, ["s9"]);
      assert.equal(both.content.match(/Mac steps\./g)?.length, 30);
      assert.isUndefined(both.nextOffset);
      const apart = readWebPageSections(page, ["s2", "s5"], 40_000);
      assert.include(apart.content, "[...]");
      const cut = readWebPageSections(page, ["s1"], 1_000);
      assert.isNumber(cut.nextOffset);
      assert.include(PAGE.slice(cut.nextOffset!), "# Appendix");
    });

    it("keeps a page's line breaks", function () {
      assert.deepEqual(normalizePageText("# A\r\n\r\n\r\n\r\nB   c \n"), {
        text: "# A\n\nB c",
        truncated: false,
      });
      assert.isTrue(normalizePageText("x".repeat(20), 10).truncated);
    });
  });

  describe("the web_read tool", function () {
    const originalZotero = globalThis.Zotero;
    afterEach(function () {
      (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
        originalZotero;
    });

    function context(): AgentToolContext {
      return {
        request: {
          conversationKey: 1,
          mode: "agent",
          userText: "Read the guide",
          authMode: "api_key",
        },
        runId: RUN,
        item: null,
        currentAnswerText: "",
        modelName: "test-model",
      };
    }

    function fakeProvider(calls: WebReadRequest[]): WebAccessProvider {
      return {
        search: async () => {
          throw new Error("not used");
        },
        read: async (request) => {
          calls.push(request);
          return {
            provider: "tavily",
            pages: request.urls.map((url) =>
              record(url, request.wholePage ? PAGE : "Matching passage"),
            ),
            failedResults: [],
            usage: { credits: 1 },
          };
        },
        getUsage: async () => {
          throw new Error("not used");
        },
      };
    }

    it("goes from passages to outline, sections and the whole page with one fetch", async function () {
      const calls: WebReadRequest[] = [];
      const read = createWebReadTool(() => fakeProvider(calls));
      const [searched] = registerWebSearchSources(RUN, [record(URL_A)]);

      const passages = await read.execute(
        { urls: [URL_A], query: "install", depth: "basic" },
        context(),
      );
      assert.equal(passages.pages[0].readMode, "passages");
      assert.equal(calls[0].query, "install");
      assert.notOk(calls[0].wholePage);

      const outline = await read.execute(
        { urls: [URL_A], mode: "outline", depth: "basic" },
        context(),
      );
      assert.isTrue(calls[1].wholePage);
      assert.isUndefined(calls[1].query);
      assert.equal(outline.pages[0].sourceId, searched.sourceId);
      assert.equal(outline.pages[0].totalChars, PAGE.length);
      assert.deepEqual(
        outline.pages[0].outline!.map((entry) => entry.heading),
        ["(Start of page)", "Guide", "Install", "On macOS", "Use", "Appendix"],
      );
      assert.notProperty(outline.pages[0], "content");
      assert.include(outline.note!, "mode 'sections'");
      assert.deepEqual(outline.citation.availableSourceIds, [
        searched.sourceId,
      ]);

      const sections = await read.execute(
        { urls: [URL_A], mode: "sections", sections: ["s3"], depth: "basic" },
        context(),
      );
      assert.include(sections.pages[0].content!, "Mac steps.");
      assert.deepEqual(sections.pages[0].sectionIds, ["s3"]);

      const first = await read.execute(
        { urls: [URL_A], mode: "full", maxChars: 2_000, depth: "basic" },
        context(),
      );
      const nextOffset = first.pages[0].nextOffset!;
      assert.isNumber(nextOffset);
      assert.include(first.note!, "offset");
      const rest = await read.execute(
        {
          urls: [URL_A],
          mode: "full",
          offset: nextOffset,
          maxChars: 40_000,
          depth: "basic",
        },
        context(),
      );
      assert.isUndefined(rest.pages[0].nextOffset);
      assert.isUndefined(rest.note);
      assert.equal(rest.pages[0].range!.start, nextOffset);
      // One whole-page fetch served the outline, sections and full reads.
      assert.lengthOf(calls, 2);
      assert.isNotNull(getStoredWebPage(RUN, URL_A));

      try {
        await read.execute(
          {
            urls: [URL_A],
            mode: "sections",
            sections: ["s42"],
            depth: "basic",
          },
          context(),
        );
        assert.fail("Expected an unknown section to be refused");
      } catch (error) {
        assert.include((error as Error).message, "mode 'outline'");
      }
      assert.equal(
        read.presentation!.buildTraceSummary!({
          args: { urls: [URL_A], mode: "outline", depth: "basic" },
          content: outline,
        }),
        "Read web page outline · Depth: basic",
      );
    });

    it("clears a run's kept pages with its sources", function () {
      storeWebPage(RUN, record(URL_A, PAGE));
      clearWebSourcesForRun(RUN);
      assert.isNull(getStoredWebPage(RUN, URL_A));
    });

    it("checks each mode's inputs", function () {
      const base = { urls: [URL_A], depth: "basic" };
      assert.isTrue(validateWebReadInput({ ...base, mode: "outline" }).ok);
      assert.isFalse(validateWebReadInput({ ...base, mode: "skim" }).ok);
      assert.isFalse(validateWebReadInput({ ...base, mode: "passages" }).ok);
      assert.isFalse(
        validateWebReadInput({
          ...base,
          urls: [URL_A, "https://example.org/b"],
          mode: "sections",
          sections: ["s1"],
        }).ok,
      );
      assert.isFalse(
        validateWebReadInput({ ...base, mode: "sections", sections: [] }).ok,
      );
      assert.isFalse(
        validateWebReadInput({ ...base, query: "q", offset: 10 }).ok,
      );
      assert.isFalse(
        validateWebReadInput({
          ...base,
          urls: [URL_A, "https://example.org/b"],
          mode: "full",
          offset: 10,
        }).ok,
      );
      assert.isFalse(
        validateWebReadInput({ ...base, mode: "full", maxChars: 500_000 }).ok,
      );
      const full = validateWebReadInput({ ...base, mode: "full", offset: 0 });
      assert.isTrue(full.ok);
    });

    it("reads whole pages by default where the provider has no passages", function () {
      (globalThis as typeof globalThis & { Zotero: unknown }).Zotero = {
        Prefs: {
          get: () => "deepseek",
          set: () => {},
          clear: () => {},
        },
      };
      setWebAccessProvider("deepseek");
      const plain = validateWebReadInput({ urls: [URL_A] });
      assert.isTrue(plain.ok);
      if (plain.ok) assert.equal(plain.value.mode, "full");
      assert.isFalse(
        validateWebReadInput({ urls: [URL_A], mode: "passages" }).ok,
      );
      assert.isTrue(
        validateWebReadInput({
          urls: [URL_A],
          mode: "sections",
          sections: ["s1"],
        }).ok,
      );
      const schema = JSON.stringify(createWebReadTool().spec.inputSchema);
      assert.include(schema, '"outline"');
      assert.notInclude(schema, '"passages"');
    });
  });

  it("asks Tavily for the whole page, as Markdown, without a query", async function () {
    let body: Record<string, unknown> = {};
    const client = new TavilyClient("secret", async (request) => {
      body = JSON.parse(request.body || "{}");
      return {
        status: 200,
        body: {
          results: [
            {
              url: URL_A,
              title: "Guide",
              raw_content: "# Guide\n\n\n\nFirst   line.\nSecond line.",
            },
          ],
        },
      };
    });
    const result = await client.read({ urls: [URL_A], wholePage: true });
    assert.equal(body.format, "markdown");
    assert.equal(body.extract_depth, "basic");
    assert.notProperty(body, "query");
    assert.notProperty(body, "chunks_per_source");
    assert.equal(
      result.pages[0].content,
      "# Guide\n\nFirst line.\nSecond line.",
    );
  });
});
