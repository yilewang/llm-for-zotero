import { assert } from "chai";
import { createPaperReadTool } from "../src/agent/tools/read/paperRead";
import type { AgentToolContext, AgentToolDefinition } from "../src/agent/types";

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

function tool(): AgentToolDefinition<never, unknown> {
  return createPaperReadTool(
    { ensurePaperContext: async () => undefined } as never,
    { retrieveEvidence: async () => [] } as never,
    {
      readPageTexts: async () => ({
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
      }),
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

  it("returns the pages' map, never cut text, over the model's maxChars", async function () {
    const output = await run({ maxChars: PAGE_CHARS - 1 });
    const paper = output.papers[0];
    assert.equal(paper.status, "map");
    assert.equal(paper.reason, "does_not_fit");
    assert.isEmpty(paper.passages);
    assert.isEmpty(output.results);
    assert.isEmpty(output.quoteCitations);
    assert.match(paper.map[0], /^page 4 \| ~\d+ tokens \| Results$/);
    assert.match(paper.map[1], /^page 5 \| ~\d+ tokens \| Discussion$/);
    assert.isNotEmpty(output.warnings);
  });

  it("returns the pages' map when the measured context cannot hold them", async function () {
    const output = await run({}, 400);
    assert.equal(output.papers[0].status, "map");
    assert.isEmpty(output.papers[0].passages);
  });
});
