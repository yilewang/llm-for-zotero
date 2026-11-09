import { assert } from "chai";
import { createPaperReadTool } from "../src/agent/tools/read/paperRead";
import type { AgentToolContext, AgentToolDefinition } from "../src/agent/types";
import { estimateTextTokens } from "../src/utils/modelInputCap";
import { resolveOutputReserve } from "../src/utils/outputTokenPolicy";

const paperContext = {
  itemId: 11,
  contextItemId: 22,
  title: "Page Scoped Paper",
  firstCreator: "Huys",
  year: "2016",
};

const PAGES = [
  {
    pageIndex: 3,
    pageLabel: "4",
    text: `Results\n${"The fourth page reports the drift. ".repeat(40)}`,
  },
  {
    pageIndex: 4,
    pageLabel: "5",
    text: `Discussion\n${"The fifth page discusses it. ".repeat(40)}`,
  },
];
const PAGE_CHARS = PAGES.reduce((sum, page) => sum + page.text.length, 0);

/** The page indexes each readPageTexts call asked for. */
let pageReads: number[][] = [];

function tool(): AgentToolDefinition<never, unknown> {
  return createPaperReadTool(
    { ensurePaperContext: async () => undefined } as never,
    { retrieveEvidence: async () => [] } as never,
    {
      readPageTexts: async (params: { pages: number[] }) => {
        pageReads.push(params.pages);
        return {
          target: {
            source: "library",
            title: paperContext.title,
            mimeType: "application/pdf",
            storedPath: "/tmp/page-map.pdf",
            paperContext,
            contextItemId: 22,
            itemId: 11,
          },
          pages: PAGES,
        };
      },
    } as never,
    {
      listPaperContexts: () => [paperContext],
      resolvePaperContextTarget: () => paperContext,
    } as never,
  ) as unknown as AgentToolDefinition<never, unknown>;
}

function context(contextWindowTokens?: number): AgentToolContext {
  return {
    request: {
      conversationKey: 78,
      mode: "agent",
      userText: "What do pages 4 and 5 say?",
      libraryID: 1,
      ...(contextWindowTokens
        ? {
            runtimeContextBudget: {
              contextWindowTokens,
              usedContextTokens: 0,
            },
          }
        : {}),
    } as never,
    item: null,
    currentAnswerText: "",
    modelName: "deepseek-chat",
  };
}

async function run(
  args: Record<string, unknown>,
  contextWindowTokens?: number,
): Promise<any> {
  const definition = tool();
  const validated = definition.validate({
    mode: "targeted",
    targets: [{ itemId: 11, contextItemId: 22 }],
    pages: [4, 5],
    ...args,
  });
  if (!validated.ok) throw new Error(validated.error);
  return definition.execute(validated.value, context(contextWindowTokens));
}

describe("paper_read page reads by the informed-choice rule", function () {
  it("reads the pages whole when they fit", async function () {
    const output = await run({ maxChars: PAGE_CHARS });
    const paper = output.papers[0];
    assert.notEqual(paper.status, "map");
    assert.deepEqual(
      paper.passages.map((passage: any) => passage.text),
      PAGES.map((page) => page.text.trim()),
    );
  });

  it("ignores the model's maxChars and reads the pages when they fit the context left", async function () {
    const output = await run({ maxChars: 1 });
    const paper = output.papers[0];
    assert.notEqual(paper.status, "map");
    assert.deepEqual(
      paper.passages.map((passage: any) => passage.text),
      PAGES.map((page) => page.text.trim()),
    );
    assert.isNotEmpty(output.quoteCitations);
    assert.isUndefined(output.warnings);
  });

  it("returns the pages' map when the measured context cannot hold them", async function () {
    const output = await run({ maxChars: 1_000_000 }, 400);
    assert.equal(output.papers[0].status, "map");
    assert.equal(output.papers[0].reason, "does_not_fit");
    assert.isEmpty(output.papers[0].passages);
    assert.match(output.papers[0].map[0], /^page 4 \| ~\d+ tokens \| Results$/);
    assert.notInclude((output.warnings || []).join(" "), "maxChars");
  });
});

describe("paper_read page reads measured as the model sees them", function () {
  const textTokens = PAGES.reduce(
    (sum, page) => sum + estimateTextTokens(page.text),
    0,
  );
  const reserve = resolveOutputReserve(undefined, "deepseek-chat", {});

  it("shows the model a page read's citation ids without their records", async function () {
    const definition = tool();
    const output = await run({});
    assert.isNotEmpty(output.quoteCitations);
    const view = (definition as any).modelContent(output, {});
    assert.isUndefined(view.quoteCitations);
    assert.isString(view.papers[0].passages[0].quoteCitationId);
    assert.isNotEmpty(view.results, "the results stay");
  });

  it("returns the pages' map when the result the model would see does not fit, though the text does", async function () {
    // The reading share (0.8 of what is left) holds the text 1.5 times
    // over, not the result, which carries each page's text twice.
    const share = Math.ceil(textTokens * 1.5);
    const output = await run({}, reserve + Math.ceil(share / 0.8));
    assert.equal(output.papers[0].status, "map");
    assert.isEmpty(output.results);
    const roomy = await run({}, reserve + Math.ceil((textTokens * 4) / 0.8));
    assert.notEqual(roomy.papers[0].status, "map");
  });
});

describe("paper_read pages given as text", function () {
  beforeEach(function () {
    pageReads = [];
  });

  for (const [pages, expected] of [
    ["4-5", [3, 4]],
    ["4\u20135", [3, 4]],
    ["4, 5", [3, 4]],
    ["4", [3]],
    ["pages 4-5", [3, 4]],
  ] as const) {
    it(`reads pages ${JSON.stringify(pages)} as those pages, not as a search`, async function () {
      const output = await run({ pages });
      assert.deepEqual(pageReads, [[...expected]]);
      assert.notEqual(output.papers[0].status, "map");
    });
  }

  it("reads every page of a range longer than 12 pages", async function () {
    await run({ pages: "1-20" });
    assert.deepEqual(pageReads, [Array.from({ length: 20 }, (_, i) => i)]);
  });

  for (const pages of ["x", "4-", "page", "0"]) {
    it(`fails validation for pages ${JSON.stringify(pages)} instead of searching`, function () {
      const validated = tool().validate({
        mode: "targeted",
        targets: [{ itemId: 11, contextItemId: 22 }],
        pages,
      });
      assert.isFalse(validated.ok);
      if (!validated.ok) assert.match(validated.error, /pages/);
    });
  }

  it("treats an empty pages value as no pages", function () {
    for (const pages of ["", []]) {
      const validated = tool().validate({
        mode: "targeted",
        targets: [{ itemId: 11, contextItemId: 22 }],
        query: "drift",
        pages,
      });
      assert.isTrue(validated.ok);
    }
  });

  it("maps the paper over the context left and reads the other despite maxChars", async function () {
    const big = {
      ...paperContext,
      itemId: 12,
      contextItemId: 23,
      title: "Big Paper",
    };
    const bigPages = [
      {
        pageIndex: 0,
        pageLabel: "1",
        text: `Intro\n${"A very long first page of the large paper. ".repeat(1500)}`,
      },
    ];
    const definition = createPaperReadTool(
      { ensurePaperContext: async () => undefined } as never,
      { retrieveEvidence: async () => [] } as never,
      {
        readPageTexts: async (params: {
          paperContext: typeof paperContext;
        }) => ({
          target: {
            source: "library",
            title: params.paperContext.title,
            mimeType: "application/pdf",
            storedPath: "/tmp/page-map.pdf",
            paperContext: params.paperContext,
            contextItemId: params.paperContext.contextItemId,
            itemId: params.paperContext.itemId,
          },
          pages: params.paperContext.contextItemId === 23 ? bigPages : PAGES,
        }),
      } as never,
      {
        listPaperContexts: () => [paperContext, big],
        resolvePaperContextTarget: (target: { contextItemId: number }) =>
          target.contextItemId === 23 ? big : paperContext,
      } as never,
    ) as unknown as AgentToolDefinition<never, unknown>;
    const validated = definition.validate({
      mode: "targeted",
      targets: [
        { itemId: 12, contextItemId: 23 },
        { itemId: 11, contextItemId: 22 },
      ],
      pages: [1, 4, 5],
      maxChars: PAGE_CHARS - 1,
    });
    if (!validated.ok) throw new Error(validated.error);
    const output: any = await definition.execute(
      validated.value,
      context(12_000),
    );
    const warnings = (output.warnings || []).join(" ");
    assert.include(warnings, "Read fewer pages at a time.");
    assert.notInclude(warnings, "maxChars");
    const [bigPaper, smallPaper] = output.papers;
    assert.equal(bigPaper.status, "map");
    assert.notEqual(smallPaper.status, "map");
    assert.isNotEmpty(smallPaper.passages);
  });
});
