import { assert } from "chai";
import {
  clearAgentToolResultHandleStore,
  createAgentToolResultHandleRecord,
  hasAgentToolResultHandles,
  upsertAgentToolResultHandles,
} from "../src/agent/store/toolResultHandles";
import { createContextReadTool } from "../src/agent/tools/read/contextRead";
import type { AgentRuntimeRequest, AgentToolContext } from "../src/agent/types";

function request(conversationKey: number): AgentRuntimeRequest {
  return {
    conversationKey,
    mode: "agent",
    userText: "read stored result",
    // What the runtime sets once this conversation holds a stored result.
    metadata: { agentToolResultReadAvailable: true },
  };
}

function context(params: {
  conversationKey: number;
  resourceSignature?: string;
}): AgentToolContext {
  return {
    request: request(params.conversationKey),
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
    resourceSignature: params.resourceSignature,
  };
}

async function executeRead(
  args: unknown,
  toolContext: AgentToolContext,
): Promise<Record<string, unknown>> {
  const tool = createContextReadTool();
  const validation = tool.validate({
    source: "tool_result",
    ...(args as Record<string, unknown>),
  });
  assert.isTrue(validation.ok);
  if (!validation.ok) throw new Error(validation.error);
  return (await tool.execute(validation.value, toolContext)) as Record<
    string,
    unknown
  >;
}

describe("agent tool-result handles", function () {
  it("advances within an oversized row and reconstructs every character and anchor", async function () {
    const row = {
      itemId: 41,
      pageLabel: "p. 7",
      quoteCitationId: "Q_tail",
      text: "α beta\n".repeat(5000) + "EXACT_END",
    };
    const record = createAgentToolResultHandleRecord({
      conversationKey: 814,
      toolName: "paper_read",
      toolCallId: "oversized",
      content: { results: [row] },
    });
    await upsertAgentToolResultHandles([record!]);
    let textOffset = 0;
    let recovered = "";
    for (let page = 0; page < 100; page++) {
      const output = await executeRead(
        {
          handle: record!.handle,
          path: "results",
          offset: 0,
          textOffset,
          maxTokens: 512,
        },
        context({ conversationKey: 814 }),
      );
      const chunk = output.itemChunk as {
        text: string;
        nextTextOffset?: number;
      };
      assert.exists(
        chunk,
        "a row larger than the budget must yield readable content instead of an empty page",
      );
      recovered += chunk.text;
      if (chunk.nextTextOffset === undefined) break;
      assert.isAbove(chunk.nextTextOffset, textOffset);
      textOffset = chunk.nextTextOffset;
    }
    assert.deepEqual(JSON.parse(recovered), row);
  });

  beforeEach(function () {
    clearAgentToolResultHandleStore();
  });

  it("reads paged catalog rows from an exact stored tool result", async function () {
    const record = createAgentToolResultHandleRecord({
      conversationKey: 1,
      toolName: "library_search",
      toolCallId: "call-catalog",
      inputDigest: "digest-a",
      resourceSignature: "scope-a",
      content: {
        totalCount: 3,
        returnedCount: 3,
        filters: { collectionId: 42 },
        results: [
          { itemId: 10, title: "Paper A" },
          { itemId: 11, title: "Paper B" },
          { itemId: 12, title: "Paper C" },
        ],
      },
    });
    assert.exists(record);
    await upsertAgentToolResultHandles([record!]);

    const output = await executeRead(
      {
        handle: record!.handle,
        path: "results",
        offset: 1,
        limit: 1,
      },
      context({ conversationKey: 1, resourceSignature: "scope-a" }),
    );

    assert.equal(output.ok, true);
    assert.equal(output.handle, record!.handle);
    assert.equal(output.totalCount, 3);
    assert.equal(output.returnedCount, 1);
    assert.equal(output.nextOffset, 2);
    assert.deepEqual(output.items, [{ itemId: 11, title: "Paper B" }]);
  });

  it("tracks handle availability in memory and gates handle reads, not tool visibility", async function () {
    const tool = createContextReadTool();
    // The tool also reads the conversation, so it is never hidden.
    assert.isUndefined(tool.isAvailable);
    const unflagged = await tool.execute(
      {
        source: "tool_result",
        handle: "trh_unflagged",
        offset: 0,
        textOffset: 0,
        limit: 20,
        maxTokens: 6_000,
        allowStale: false,
      },
      {
        request: { ...request(1), metadata: {} },
        item: null,
        currentAnswerText: "",
        modelName: "test-model",
      },
    );
    assert.equal((unflagged as { ok?: unknown }).ok, false);
    assert.match(
      String((unflagged as { error?: unknown }).error),
      /No stored tool results are available/,
    );
    assert.isFalse(hasAgentToolResultHandles(1));

    const record = createAgentToolResultHandleRecord({
      conversationKey: 1,
      toolName: "library_search",
      toolCallId: "call-catalog",
      content: { results: [{ itemId: 1 }] },
    });
    assert.exists(record);
    await upsertAgentToolResultHandles([record!]);
    assert.isTrue(hasAgentToolResultHandles(1));

    clearAgentToolResultHandleStore();
    assert.isFalse(hasAgentToolResultHandles(1));
  });

  it("reads evidence sections with source anchors intact", async function () {
    const record = createAgentToolResultHandleRecord({
      conversationKey: 2,
      toolName: "library_retrieve",
      toolCallId: "call-evidence",
      resourceSignature: "scope-a",
      content: {
        coverage: { indexedTextScanned: 5 },
        snippets: [
          {
            itemId: 20,
            contextItemId: 30,
            title: "Evidence Paper",
            sectionLabel: "Results",
            pageLabel: "p. 7",
            quoteCitationId: "Q_1",
            text: "Important anchored evidence.",
          },
        ],
      },
    });
    assert.exists(record);
    await upsertAgentToolResultHandles([record!]);

    const output = await executeRead(
      { handle: record!.handle, path: "snippets" },
      context({ conversationKey: 2, resourceSignature: "scope-a" }),
    );

    const items = output.items as Record<string, unknown>[];
    assert.equal(items[0].itemId, 20);
    assert.equal(items[0].contextItemId, 30);
    assert.equal(items[0].sectionLabel, "Results");
    assert.equal(items[0].pageLabel, "p. 7");
    assert.equal(items[0].quoteCitationId, "Q_1");
  });

  it("rejects cross-conversation handle access", async function () {
    const record = createAgentToolResultHandleRecord({
      conversationKey: 3,
      toolName: "library_search",
      toolCallId: "call-catalog",
      content: { results: [{ itemId: 1 }] },
    });
    assert.exists(record);
    await upsertAgentToolResultHandles([record!]);

    const output = await executeRead(
      { handle: record!.handle, path: "results" },
      context({ conversationKey: 4 }),
    );

    assert.equal(output.ok, false);
    assert.match(String(output.error), /current conversation/);
  });

  it("blocks stale-scope handles by default and allows explicit stale reads", async function () {
    const record = createAgentToolResultHandleRecord({
      conversationKey: 5,
      toolName: "library_retrieve",
      toolCallId: "call-evidence",
      resourceSignature: "scope-old",
      content: { snippets: [{ text: "Old scoped evidence" }] },
    });
    assert.exists(record);
    await upsertAgentToolResultHandles([record!]);

    const output = await executeRead(
      { handle: record!.handle, path: "snippets" },
      context({ conversationKey: 5, resourceSignature: "scope-new" }),
    );

    assert.equal(output.ok, false);
    assert.equal(output.stale, true);
    assert.equal(output.currentResourceSignature, "scope-new");
    assert.equal(output.resourceSignature, "scope-old");
    assert.notProperty(output, "items");
    assert.notProperty(output, "value");
    assert.notProperty(output, "excerpt");
    assert.notProperty(output, "availablePaths");
    assert.notProperty(output, "snippetsCount");
    assert.include(
      String((output.warnings as string[])[0]),
      "resource scope has changed",
    );
    assert.include(String(output.error), "Re-run the source tool");

    const staleAllowed = await executeRead(
      { handle: record!.handle, path: "snippets", allowStale: true },
      context({ conversationKey: 5, resourceSignature: "scope-new" }),
    );
    assert.equal(staleAllowed.ok, true);
    assert.equal(staleAllowed.stale, true);
    assert.equal(staleAllowed.currentResourceSignature, "scope-new");
    assert.deepEqual(staleAllowed.items, [{ text: "Old scoped evidence" }]);
    assert.include(
      String((staleAllowed.warnings as string[])[0]),
      "allowStale",
    );
  });

  it("keeps the stale-scope warning beside a stored result's own warnings", async function () {
    const record = createAgentToolResultHandleRecord({
      conversationKey: 6,
      toolName: "paper_read",
      toolCallId: "call-warned",
      resourceSignature: "scope-old",
      content: {
        warnings: ["Not found in Lee, 2025: results.", "Shared warning."],
        results: [{ text: "Old scoped evidence" }],
      },
    });
    await upsertAgentToolResultHandles([record!]);
    const output = await executeRead(
      { handle: record!.handle, allowStale: true },
      context({ conversationKey: 6, resourceSignature: "scope-new" }),
    );
    const warnings = output.warnings as string[];
    // The read's own warning first, then the record's, each once.
    assert.include(warnings[0], "allowStale");
    assert.deepEqual(warnings.slice(1), [
      "Not found in Lee, 2025: results.",
      "Shared warning.",
    ]);
  });
});
