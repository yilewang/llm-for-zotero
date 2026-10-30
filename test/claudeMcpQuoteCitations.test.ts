import { assert } from "chai";
import {
  createAgentTurnEventHandler,
  type AgentEngineDeps,
} from "../src/modules/contextPanel/agentMode/agentEngine";
import { buildClaudeMcpToolActivityEvent } from "../src/agent/externalBackendBridge";
import { withDigestQuoteCitations } from "../src/agent/digests/paperDigestWorker";
import { buildCodexNativeTurnCallbacksForTests } from "../src/modules/contextPanel/codexNative/turnCallbacks";
import {
  chatHistory,
  finishRequest,
  getConversationWriteGeneration,
  tryBeginRequest,
} from "../src/modules/contextPanel/state";
import { clearAllTaskProgress } from "../src/modules/contextPanel/taskProgress/store";
import { extractQuoteCitationsFromToolContent } from "../src/services/quotes/quoteCitations";
import type { Message } from "../src/modules/contextPanel/types";
import type { ZoteroMcpToolActivityEvent } from "../src/agent/mcp/activityTypes";
import { fakeDocument, FakeElement } from "./helpers/fakeDom";

/**
 * A Zotero MCP call's passage citations reach the chat answer in both
 * external runtimes: Codex merges the activity's citations, and the Claude
 * bridge relays them on its trace row, which the agent panel merges the
 * same way.
 */

const QUOTE =
  "Representational drift did not impair decoding across ten sessions of recording.";

/** A paper_digest call's completed activity, as the MCP server sends it. */
function digestActivity(
  overrides: Partial<ZoteroMcpToolActivityEvent> = {},
): ZoteroMcpToolActivityEvent {
  const digest = withDigestQuoteCitations(
    {
      schema: 2,
      itemId: 1,
      contextItemId: 1001,
      title: "Paper 1",
      answer: "Drift did not impair decoding.",
      evidence: [{ section: "Results", quote: QUOTE }],
      facets: [],
      gaps: [],
      source: {
        backend: "mineru",
        readCharacters: 4_000,
        totalCharacters: 4_000,
        complete: true,
      },
      model: "m",
      producedAt: 1,
      cacheKey: "k",
    },
    "(Ziv, 2021)",
  );
  const { schema: _s, cacheKey: _k, producedAt: _p, ...fields } = digest;
  const content = {
    status: "complete",
    papers: [{ status: "digested", libraryID: 1, ...fields }],
  };
  return {
    requestId: "mcp-digest-1",
    phase: "completed",
    toolName: "paper_digest",
    serverName: "llm_for_zotero",
    ok: true,
    quoteCitations: extractQuoteCitationsFromToolContent(content),
    timestamp: 1,
    ...overrides,
  };
}

function claudeTurn() {
  const body = new FakeElement("div") as FakeElement & {
    ownerDocument: unknown;
  };
  body.ownerDocument = {
    createElement: fakeDocument.createElement,
    defaultView: { setTimeout: () => 0 },
  };
  const assistantMessage: Message = {
    role: "assistant",
    text: "",
    timestamp: 2,
    runMode: "agent",
    streaming: true,
  };
  const handle = createAgentTurnEventHandler({
    deps: {
      appendReasoningPart: (base: string | undefined, next?: string) =>
        `${base || ""}${next || ""}`,
      sanitizeText: (text: string) => text,
      waitForUiStep: async () => undefined,
      normalizePaperContexts: () => [],
    } as unknown as AgentEngineDeps,
    body: body as unknown as Element,
    ui: { chatBox: new FakeElement("div") } as never,
    conversationKey: 1,
    runtimeRequest: { conversationKey: 1, mode: "agent", userText: "Q" },
    assistantMessage,
    pairedUserMessage: { role: "user", text: "Q", timestamp: 1 },
    history: [],
    isCompactCommand: false,
    compactStyle: "keep-assistant",
    messageDeltaCoalescer: { pushText: () => {} },
    flushMessageDeltas: () => {},
    queueRefresh: () => {},
    refreshAssistant: () => {},
    refreshChatSafely: () => {},
    setStatusSafely: () => {},
    pushTraceEvent: () => {},
    scheduleQueueDrain: () => {},
  });
  return { handle, assistantMessage };
}

describe("Zotero MCP passage citations in external runtimes", function () {
  it("a Claude Code turn adds a completed MCP call's citations to the answer, as Codex does", async function () {
    const activity = digestActivity();
    const ids = (activity.quoteCitations || []).map((citation) => citation.id);
    assert.lengthOf(ids, 1);
    assert.match(ids[0], /^Q_/);

    const { handle, assistantMessage } = claudeTurn();
    await handle(buildClaudeMcpToolActivityEvent(activity));
    assert.deepEqual(
      (assistantMessage.quoteCitations || []).map((citation) => citation.id),
      ids,
    );
  });

  it("a Claude Code turn adds one citation for a call whose relayed result and activity both carry it", async function () {
    const activity = digestActivity();
    const [citation] = activity.quoteCitations || [];
    // The text Claude Code relays as the tool's result: a paper_read-style
    // result still carries the citation record; a paper_digest result shows
    // only the id.
    const relayedWithRecord = JSON.stringify({
      ok: true,
      result: {
        passages: [{ quoteCitationId: citation.id }],
        quoteCitations: [citation],
      },
    });
    const relayedIdOnly = JSON.stringify({
      ok: true,
      result: {
        papers: [
          { evidence: [{ quote: QUOTE, quoteCitationId: citation.id }] },
        ],
      },
    });
    // The record in the relayed text is read on its own, so both halves
    // deliver the same citation below.
    const alone = claudeTurn();
    await alone.handle({
      type: "tool_result",
      callId: "toolu_digest_1",
      name: "mcp__llm_for_zotero__paper_read",
      ok: true,
      content: [{ type: "text", text: relayedWithRecord }],
    } as never);
    assert.deepEqual(
      (alone.assistantMessage.quoteCitations || []).map((entry) => entry.id),
      [citation.id],
    );
    for (const content of [relayedWithRecord, relayedIdOnly]) {
      for (const order of ["result first", "activity first"]) {
        const { handle, assistantMessage } = claudeTurn();
        const relayed = {
          type: "tool_result" as const,
          callId: "toolu_digest_1",
          name: "mcp__llm_for_zotero__paper_digest",
          ok: true,
          content: [{ type: "text", text: content }],
        };
        const row = buildClaudeMcpToolActivityEvent(activity);
        for (const event of order === "result first"
          ? [relayed, row]
          : [row, relayed]) {
          await handle(event as never);
        }
        assert.deepEqual(
          (assistantMessage.quoteCitations || []).map((entry) => entry.id),
          [citation.id],
          `${order}, ${content === relayedIdOnly ? "id only" : "with record"}`,
        );
      }
    }
  });

  it("a started or failed Claude Code MCP call adds no citation", async function () {
    const { handle, assistantMessage } = claudeTurn();
    await handle(
      buildClaudeMcpToolActivityEvent(digestActivity({ ok: false })),
    );
    await handle(
      buildClaudeMcpToolActivityEvent(
        digestActivity({ phase: "started", ok: undefined }),
      ),
    );
    assert.isEmpty(assistantMessage.quoteCitations || []);
  });

  it("a Codex turn merges the same activity's citations", function () {
    const key = 908_311;
    try {
      tryBeginRequest(key, 1, null);
      const assistant: Message = {
        role: "assistant",
        text: "",
        timestamp: 4,
        agentRunId: "codex-native-digest",
        streaming: true,
      };
      chatHistory.set(key, [
        { role: "user", text: "What is drift?", timestamp: 3 },
        assistant,
      ]);
      const callbacks = buildCodexNativeTurnCallbacksForTests({
        conversationKey: key,
        conversationGeneration: getConversationWriteGeneration(key),
        assistantMessage: assistant,
        codexActivityTrace: null,
        body: {} as Element,
        item: {} as Zotero.Item,
        flushResponseStream: () => {},
        setStatusSafely: () => {},
        handleDelta: () => {},
        handleReasoning: () => {},
        handleUsage: () => {},
      });
      const activity = digestActivity();
      callbacks.onMcpToolActivity?.(activity);
      assert.deepEqual(
        (assistant.quoteCitations || []).map((citation) => citation.id),
        (activity.quoteCitations || []).map((citation) => citation.id),
      );
    } finally {
      finishRequest(key, 1);
      chatHistory.delete(key);
      clearAllTaskProgress();
    }
  });
});
