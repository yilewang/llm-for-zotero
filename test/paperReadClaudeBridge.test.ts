import { assert } from "chai";
import { createPaperReadTool } from "../src/agent/tools/read/paperRead";
import type { AgentToolContext, AgentToolDefinition } from "../src/agent/types";
import type { PdfContext } from "../src/services/paperContent/types";

const paper = {
  libraryID: 1,
  itemId: 9700,
  contextItemId: 9701,
  title: "Grid cells",
  firstCreator: "Lee",
  year: "2025",
};

const paperContent = {
  title: paper.title,
  chunks: ["Section 1\nGrid cells fire in hexagons."],
  chunkMeta: [],
  chunkStats: [],
  docFreq: {},
  avgChunkLength: 10,
  fullLength: 40,
} as unknown as PdfContext;

function toolContext(request: Record<string, unknown>): AgentToolContext {
  return {
    request: {
      conversationKey: 79,
      mode: "agent",
      conversationKind: "paper",
      userText: "Read the paper.",
      libraryID: 1,
      activeItemId: paper.itemId,
      ...request,
    } as never,
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
  };
}

function fullReadTool(onEnsure?: () => void) {
  return createPaperReadTool(
    {
      ensurePaperContext: async () => {
        onEnsure?.();
        return paperContent;
      },
    } as never,
    {} as never,
    {} as never,
    {
      listPaperContexts: () => [paper],
      resolvePaperContextTarget: () => paper,
    } as never,
  ) as unknown as AgentToolDefinition<never, unknown>;
}

function validated(tool: AgentToolDefinition<never, unknown>) {
  const result = tool.validate({
    mode: "full",
    query: "What do grid cells do?",
    targets: [{ itemId: paper.itemId, contextItemId: paper.contextItemId }],
  });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

describe("paper_read full mode through the Claude bridge", function () {
  const originalZotero = globalThis.Zotero;
  const originalFetch = globalThis.fetch;
  let requests: Array<{ url: string; body?: Record<string, unknown> }>;

  beforeEach(function () {
    requests = [];
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Prefs: {
        get: (key: string) =>
          key.endsWith("claudeCodeBridgeMode")
            ? "custom"
            : key.endsWith("agentBackendBridgeUrl")
              ? "http://127.0.0.1:19999/test"
              : "",
      },
    } as unknown as typeof Zotero;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ url, body });
      if (url.endsWith("/healthz")) {
        return new Response(
          JSON.stringify({ capabilities: ["structured_completion_v1"] }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          text: JSON.stringify({
            digest: "Grid cells fire in hexagons.",
            relevantChunkIds: [0],
          }),
          usage: { inputTokens: 40, outputTokens: 9 },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
  });

  afterEach(function () {
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
    globalThis.fetch = originalFetch;
  });

  it("reads every batch with the chat's Claude model when the backend is claude_bridge", async function () {
    const tool = fullReadTool();
    const output = (await tool.execute(
      validated(tool),
      toolContext({
        exhaustiveReadBackend: "claude_bridge",
        model: "claude-sonnet-4-5",
      }),
    )) as {
      status: string;
      synthesisContext: string;
      papers: Array<{ digests: Array<{ digest: string }> }>;
    };

    assert.equal(output.status, "complete");
    assert.include(output.synthesisContext, "Grid cells fire in hexagons.");
    const posts = requests.filter((request) =>
      request.url.endsWith("/structured-completion"),
    );
    assert.isAbove(posts.length, 0);
    assert.equal(
      posts[0].url,
      "http://127.0.0.1:19999/test/structured-completion",
    );
    assert.equal(posts[0].body?.model, "claude-sonnet-4-5");
    assert.include(
      String(posts[0].body?.prompt),
      "Grid cells fire in hexagons.",
    );
  });

  it("refuses with a Claude-specific message when the chat has no model", async function () {
    let loaded = 0;
    const tool = fullReadTool(() => {
      loaded += 1;
    });
    let error: Error | undefined;
    try {
      await tool.execute(
        validated(tool),
        toolContext({ exhaustiveReadBackend: "claude_bridge", model: "" }),
      );
    } catch (caught) {
      error = caught as Error;
    }
    assert.match(error?.message || "", /Claude tool-free full-read backend/);
    assert.equal(loaded, 0);
    assert.lengthOf(requests, 0);
  });

  it("still refuses when the backend is unavailable", async function () {
    const tool = fullReadTool();
    let error: Error | undefined;
    try {
      await tool.execute(
        validated(tool),
        toolContext({ exhaustiveReadBackend: "unavailable", model: "sonnet" }),
      );
    } catch (caught) {
      error = caught as Error;
    }
    assert.match(error?.message || "", /backend is unavailable/);
    assert.lengthOf(requests, 0);
  });
});
