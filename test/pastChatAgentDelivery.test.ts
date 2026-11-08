import { assert } from "chai";
import { AgentRuntime } from "../src/agent/runtime";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { buildAgentContextBudgetState } from "../src/agent/context/budgetPolicy";
import { compactAgentTranscript } from "../src/agent/context/transcriptCompactor";
import { resolveAgentRuntimeRequest } from "../src/agent/context/resolvedAgentRequest";
import { clearAgentReadLedger } from "../src/agent/context/resourceContextPlan";
import { clearAgentCoverageLedger } from "../src/agent/context/coverageLedger";
import {
  PORTABLE_TRANSCRIPT_KEY,
  clearAgentTranscriptStore,
  replaceAgentTranscriptSegment,
} from "../src/agent/store/transcriptStore";
import { clearAgentToolResultHandleStore } from "../src/agent/store/toolResultHandles";
import {
  PAST_CHAT_MESSAGE_TITLE,
  PAST_CHAT_RELIABILITY_NOTE,
} from "../src/services/pastConversations/pastConversationText";
import { clearPastChatRenderMemoForTests } from "../src/services/pastConversations/pastConversationLoader";
import { injectAttachedPastChatsIntoAgentHistory } from "../src/modules/contextPanel/agentMode/pastChatHistory";
import type {
  AgentModelMessage,
  AgentModelStep,
  AgentRuntimeRequestInput,
} from "../src/agent/types";
import type { AttachedConversationRef } from "../src/shared/types";
import type { ChatMessage } from "../src/utils/llmClient";
import {
  installMockDb,
  type InstalledMockDb,
} from "./helpers/agentRuntimeMockDb";
import {
  createFakePastConversationSource,
  pastChatRows,
} from "./helpers/fakePastConversationSource";

/**
 * How the built-in agent receives attached past chats (step 3, placement D):
 * one user message, rendered once on the attaching turn, stored in the
 * transcript right before that turn's request, and sent with the same bytes
 * at the same place on every later turn.
 */

const PAST_REF: AttachedConversationRef = {
  system: "upstream",
  conversationKey: 10,
  conversationID: "conv-10",
  title: "Grid cells chat",
  libraryID: 1,
};

const HUGE_REF: AttachedConversationRef = {
  system: "codex",
  conversationKey: 20,
  conversationID: "conv-20",
  title: "Long codex chat",
  libraryID: 1,
};

function contentText(message: AgentModelMessage | undefined): string {
  if (!message) return "";
  return typeof message.content === "string"
    ? message.content
    : message.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("\n");
}

function isPastChat(message: AgentModelMessage | undefined): boolean {
  return (
    message?.role === "user" &&
    contentText(message).startsWith(PAST_CHAT_MESSAGE_TITLE)
  );
}

function readPersistedTranscript(
  installed: InstalledMockDb,
  conversationKey: number,
): AgentModelMessage[] {
  return installed.transcripts
    .filter((row) => Number(row.conversationKey) === conversationKey)
    .sort((left, right) => Number(left.sequence) - Number(right.sequence))
    .map((row) => JSON.parse(String(row.messageJson)) as AgentModelMessage);
}

function comparable(messages: readonly AgentModelMessage[]) {
  return messages.map((message) => ({
    role: message.role,
    content: contentText(message),
  }));
}

describe("attached past chats reach the built-in agent", function () {
  let installed: InstalledMockDb;
  const pastRows = pastChatRows(4, (n) =>
    n === 2
      ? "Grid cells fire at the vertices of a triangular lattice."
      : `turn ${n}`,
  );
  const source = createFakePastConversationSource([
    {
      conversationKey: 10,
      entry: { title: "Grid cells chat" },
      messages: pastRows,
    },
    {
      system: "codex",
      conversationKey: 20,
      entry: { title: "Long codex chat" },
      // About 3,000 tokens: full on a large model, an outline on a 16k one.
      messages: pastChatRows(20, (n) => `codex ${n} ${"w".repeat(560)}`),
    },
  ]);

  beforeEach(function () {
    clearAgentReadLedger();
    clearAgentCoverageLedger();
    clearAgentTranscriptStore();
    clearAgentToolResultHandleStore();
    clearPastChatRenderMemoForTests();
    installed = installMockDb();
  });
  afterEach(function () {
    installed();
    clearPastChatRenderMemoForTests();
  });

  function createRuntime(
    prompts: AgentModelMessage[][],
    pastSource: typeof source = source,
  ): AgentRuntime {
    return new AgentRuntime({
      registry: new AgentToolRegistry(),
      pastConversationSource: pastSource,
      adapterFactory: () => ({
        getCapabilities: () => ({
          streaming: false,
          toolCalls: true,
          multimodal: false,
        }),
        supportsTools: () => true,
        async runStep(params): Promise<AgentModelStep> {
          prompts.push(params.messages.map((message) => ({ ...message })));
          return {
            kind: "final",
            text: "Answered.",
            assistantMessage: { role: "assistant", content: "Answered." },
          };
        },
      }),
    });
  }

  function turn(
    conversationKey: number,
    userText: string,
    sourceMessageTimestamp: number,
    overrides: Partial<AgentRuntimeRequestInput> = {},
  ): AgentRuntimeRequestInput {
    return {
      conversationKey,
      mode: "agent",
      userText,
      libraryID: 1,
      model: "test",
      apiKey: "test",
      apiBase: "https://example.invalid",
      metadata: { sourceMessageTimestamp },
      ...overrides,
    };
  }

  it("puts the past chat right before the turn message on the attaching turn, and stores it before the request", async function () {
    const prompts: AgentModelMessage[][] = [];
    const runtime = createRuntime(prompts);
    const outcome = await runtime.runTurn({
      request: turn(7101, "What did we conclude about grid cells?", 100, {
        attachedConversations: [PAST_REF],
        attachedConversationScope: [PAST_REF],
      }),
    });
    assert.equal(outcome.kind, "completed");
    const prompt = prompts[0];
    const index = prompt.findIndex(isPastChat);
    assert.isAtLeast(index, 0);
    assert.equal(
      index,
      prompt.length - 2,
      "immediately before the turn message",
    );
    assert.equal(prompt.filter(isPastChat).length, 1);
    const pastChat = prompt[index];
    assert.isUndefined((pastChat as { transient?: true }).transient);
    const text = contentText(pastChat);
    assert.include(text, "### Past chat upstream:10");
    assert.include(text, PAST_CHAT_RELIABILITY_NOTE);
    assert.include(
      text,
      "Grid cells fire at the vertices of a triangular lattice.",
      "a short chat goes in full",
    );
    assert.notInclude(
      contentText(prompt[prompt.length - 1]),
      PAST_CHAT_MESSAGE_TITLE,
      "nothing about past chats goes into the turn message",
    );
    assert.isFalse(
      prompt.some(
        (message) =>
          message.role === "system" &&
          contentText(message).includes(PAST_CHAT_MESSAGE_TITLE),
      ),
      "never a system message",
    );

    const stored = readPersistedTranscript(installed, 7101);
    assert.deepEqual(
      stored.map((message) =>
        isPastChat(message) ? "past-chat" : contentText(message),
      ),
      [
        "past-chat",
        "User request:\nWhat did we conclude about grid cells?",
        "Answered.",
      ],
    );
  });

  it("sends the same bytes at the same place on the next turn and never adds a second copy", async function () {
    const prompts: AgentModelMessage[][] = [];
    const runtime = createRuntime(prompts);
    await runtime.runTurn({
      request: turn(7102, "Summarize the attached chat.", 100, {
        attachedConversations: [PAST_REF],
        attachedConversationScope: [PAST_REF],
      }),
    });
    // The old chat changes after it was attached: the stored copy stands.
    pastRows.push({ role: "user", text: "added afterwards", timestamp: 9_000 });
    try {
      await runtime.runTurn({
        request: turn(7102, "And what about place cells?", 200, {
          attachedConversationScope: [PAST_REF],
        }),
      });
    } finally {
      pastRows.pop();
    }
    const [first, second] = prompts;
    const pastIndex = first.findIndex(isPastChat);
    assert.deepEqual(
      comparable(second.slice(0, pastIndex + 1)),
      comparable(first.slice(0, pastIndex + 1)),
      "turn 2's prefix through the past-chat message equals turn 1's",
    );
    assert.equal(second.filter(isPastChat).length, 1);
    assert.equal(
      contentText(second[pastIndex + 1]),
      "User request:\nSummarize the attached chat.",
    );
    assert.notInclude(contentText(second[pastIndex]), "added afterwards");
    assert.notInclude(
      contentText(second[second.length - 1]),
      PAST_CHAT_MESSAGE_TITLE,
    );
  });

  it("keeps only transient host notes between a later attaching turn's past chat and its turn message", async function () {
    const prompts: AgentModelMessage[][] = [];
    const runtime = createRuntime(prompts);
    await runtime.runTurn({ request: turn(7103, "First question", 100) });
    await runtime.runTurn({
      request: turn(7103, "Now compare with my earlier chat.", 200, {
        attachedConversations: [PAST_REF],
        attachedConversationScope: [PAST_REF],
      }),
    });
    const prompt = prompts[1];
    const index = prompt.findIndex(isPastChat);
    assert.isAtLeast(index, 0);
    assert.isTrue(
      prompt
        .slice(index + 1, -1)
        .every((message) => (message as { transient?: true }).transient),
    );
    assert.equal(
      contentText(prompt[index - 1]),
      "Answered.",
      "after every stored message of earlier turns",
    );
  });

  it("keeps the attaching turn's past chat in the tail when the transcript is compacted", async function () {
    const earlier: AgentModelMessage[] = [];
    for (let index = 0; index < 6; index += 1) {
      earlier.push(
        { role: "user", content: `User request:\nEarlier ${index}` },
        { role: "assistant", content: `Earlier answer ${index}` },
      );
    }
    await replaceAgentTranscriptSegment({
      conversationKey: 7104,
      compatibilityKey: PORTABLE_TRANSCRIPT_KEY,
      messages: earlier,
      compactedAt: 50,
    });
    const prompts: AgentModelMessage[][] = [];
    const runtime = createRuntime(prompts);
    const outcome = await runtime.runTurn({
      request: turn(7104, "Use the long codex chat.", 100, {
        attachedConversations: [HUGE_REF],
        attachedConversationScope: [HUGE_REF],
      }),
    });
    assert.equal(outcome.kind, "completed");
    const prompt = prompts[0];
    assert.isTrue(
      prompt.some((message) =>
        contentText(message).startsWith("Agent transcript compact checkpoint:"),
      ),
      "the sticky compactedAt forced a compaction",
    );
    const index = prompt.findIndex(isPastChat);
    assert.isAtLeast(index, 0, "the past chat survived the compaction");
    assert.isTrue(
      prompt
        .slice(index + 1, -1)
        .every((message) => (message as { transient?: true }).transient),
      "it is the newest stored message before the turn message",
    );
    assert.include(contentText(prompt[index]), "### Past chat codex:20");
    assert.include(contentText(prompt[index]), "[message 20 · assistant]");
  });

  it("shrinks the past chat on a 16k-token model and the turn still completes", async function () {
    const prompts: AgentModelMessage[][] = [];
    const runtime = createRuntime(prompts);
    const large = await runtime.runTurn({
      request: turn(7105, "Use it", 100, {
        attachedConversations: [HUGE_REF],
        attachedConversationScope: [HUGE_REF],
      }),
    });
    const small = await runtime.runTurn({
      request: turn(7106, "Use it", 100, {
        attachedConversations: [HUGE_REF],
        attachedConversationScope: [HUGE_REF],
        advanced: { inputTokenCap: 16_000 },
      }),
    });
    assert.equal(large.kind, "completed");
    assert.equal(small.kind, "completed");
    const largeText = contentText(prompts[0].find(isPastChat));
    const smallText = contentText(prompts[1].find(isPastChat));
    assert.include(
      largeText,
      "[message 20 · assistant]",
      "full on a large model",
    );
    assert.include(smallText, 'past_chat_read (chat: "codex:20"');
    assert.notInclude(smallText, "[message 20 · assistant]");
    assert.isBelow(smallText.length, largeText.length / 2);
  });

  it("re-creates the past chat from history after an edit or retry cleared the transcript", async function () {
    const prompts: AgentModelMessage[][] = [];
    const runtime = createRuntime(prompts);
    await runtime.runTurn({
      request: turn(7107, "What did we conclude?", 100, {
        attachedConversations: [PAST_REF],
        attachedConversationScope: [PAST_REF],
      }),
    });
    const attached = contentText(prompts[0].find(isPastChat));
    // Edit/retry clears the transcript; the next turn rebuilds it from the
    // chat history the engine hands over.
    clearAgentTranscriptStore();
    installed.transcripts.length = 0;
    const chatMessages = [
      {
        role: "user",
        text: "What did we conclude?",
        timestamp: 100,
        attachedConversations: [PAST_REF],
      },
      { role: "assistant", text: "Answered.", timestamp: 101 },
    ];
    const plainHistory: ChatMessage[] = [
      { role: "user", content: "What did we conclude?" },
      { role: "assistant", content: "Answered." },
    ];
    const history = await injectAttachedPastChatsIntoAgentHistory({
      conversationKey: 7107,
      conversationSystem: "upstream",
      libraryID: 1,
      messages: chatMessages,
      history: plainHistory,
      effectiveRequestConfig: {
        model: "test",
        apiBase: "https://example.invalid",
        authMode: "api_key",
        advanced: undefined,
      },
      source,
    });
    assert.deepEqual(
      history.map((message) =>
        String(message.content).startsWith(PAST_CHAT_MESSAGE_TITLE)
          ? "past-chat"
          : message.content,
      ),
      ["past-chat", "What did we conclude?", "Answered."],
    );
    assert.equal(
      history[0].content,
      attached,
      "the rebuild in the same session sends the attaching turn's bytes",
    );
    await runtime.runTurn({
      request: turn(7107, "Follow-up", 300, {
        history,
        attachedConversationScope: [PAST_REF],
      }),
    });
    const rebuilt = prompts[1];
    const index = rebuilt.findIndex(isPastChat);
    assert.isAtLeast(index, 0);
    assert.equal(contentText(rebuilt[index + 1]), "What did we conclude?");
    assert.equal(contentText(rebuilt[index]), attached);
    assert.isTrue(
      readPersistedTranscript(installed, 7107).some(isPastChat),
      "the rebuilt transcript stores it again",
    );
  });

  it("does not store the past chat twice when the latest turn is retried", async function () {
    const prompts: AgentModelMessage[][] = [];
    const runtime = createRuntime(prompts);
    const request = turn(7110, "What did we conclude?", 100, {
      attachedConversations: [PAST_REF],
      attachedConversationScope: [PAST_REF],
    });
    await runtime.runTurn({ request });
    // A plain retry keeps the transcript and sends the same user message.
    await runtime.runTurn({ request: { ...request } });
    assert.equal(prompts[1].filter(isPastChat).length, 1);
    assert.equal(
      readPersistedTranscript(installed, 7110).filter(isPastChat).length,
      1,
    );
  });

  it("stores one copy when a retry renders different bytes after a restart", async function () {
    const prompts: AgentModelMessage[][] = [];
    const runtime = createRuntime(prompts);
    const request = turn(7111, "What did we conclude?", 100, {
      attachedConversations: [PAST_REF],
      attachedConversationScope: [PAST_REF],
    });
    await runtime.runTurn({ request });
    // A restart empties the render memo; the old chat has grown since.
    clearPastChatRenderMemoForTests();
    pastRows.push({ role: "user", text: "added afterwards", timestamp: 9_000 });
    try {
      await runtime.runTurn({ request: { ...request } });
    } finally {
      pastRows.pop();
    }
    assert.equal(prompts[1].filter(isPastChat).length, 1);
    assert.notInclude(
      contentText(prompts[1].find(isPastChat)),
      "added afterwards",
    );
    assert.equal(
      readPersistedTranscript(installed, 7111).filter(isPastChat).length,
      1,
    );
  });

  it("stores a second copy when the same chat is attached again later with a new question", async function () {
    const prompts: AgentModelMessage[][] = [];
    const runtime = createRuntime(prompts);
    await runtime.runTurn({
      request: turn(7112, "Summarize the attached chat.", 100, {
        attachedConversations: [PAST_REF],
        attachedConversationScope: [PAST_REF],
      }),
    });
    await runtime.runTurn({
      request: turn(7112, "Now compare it with place cells.", 200, {
        attachedConversationScope: [PAST_REF],
      }),
    });
    // Same chat, unchanged, attached again on a later turn.
    await runtime.runTurn({
      request: turn(7112, "Look at that chat again.", 300, {
        attachedConversations: [PAST_REF],
        attachedConversationScope: [PAST_REF],
      }),
    });
    assert.equal(
      readPersistedTranscript(installed, 7112).filter(isPastChat).length,
      2,
      "the deliberate re-attach adds a copy",
    );
    assert.equal(prompts[2].filter(isPastChat).length, 2);
  });

  it("appends a loaded copy when the stored copy of a retried turn had a failed chat", async function () {
    const flaky = { failLoads: true };
    const flakySource = createFakePastConversationSource(
      [
        {
          conversationKey: 10,
          entry: { title: "Grid cells chat" },
          messages: pastRows,
        },
      ],
      flaky,
    );
    const prompts: AgentModelMessage[][] = [];
    const runtime = createRuntime(prompts, flakySource);
    const request = turn(7113, "What did we conclude?", 100, {
      attachedConversations: [PAST_REF],
      attachedConversationScope: [PAST_REF],
    });
    await runtime.runTurn({ request });
    const failedCopy = contentText(prompts[0].find(isPastChat));
    assert.include(failedCopy, "### Past chat upstream:10");
    assert.include(failedCopy, "could not be loaded right now");

    flaky.failLoads = false;
    await runtime.runTurn({ request: { ...request } });
    let copies = readPersistedTranscript(installed, 7113).filter(isPastChat);
    assert.equal(copies.length, 2, "history only grows");
    assert.include(contentText(copies[1]), PAST_CHAT_RELIABILITY_NOTE);
    assert.notInclude(contentText(copies[1]), "could not be loaded");

    // Another retry finds the loaded copy and adds nothing.
    await runtime.runTurn({ request: { ...request } });
    copies = readPersistedTranscript(installed, 7113).filter(isPastChat);
    assert.equal(copies.length, 2);
  });

  it("stores one copy when the same turn is retried twice", async function () {
    const prompts: AgentModelMessage[][] = [];
    const runtime = createRuntime(prompts);
    const request = turn(7114, "What did we conclude?", 100, {
      attachedConversations: [PAST_REF],
      attachedConversationScope: [PAST_REF],
    });
    await runtime.runTurn({ request });
    await runtime.runTurn({ request: { ...request } });
    clearPastChatRenderMemoForTests();
    await runtime.runTurn({ request: { ...request } });
    assert.equal(prompts[2].filter(isPastChat).length, 1);
    assert.equal(
      readPersistedTranscript(installed, 7114).filter(isPastChat).length,
      1,
    );
  });

  it("keeps one copy of the retried turn through a forced compaction", async function () {
    const prompts: AgentModelMessage[][] = [];
    const runtime = createRuntime(prompts);
    const request = turn(7115, "Use the long codex chat.", 100, {
      attachedConversations: [HUGE_REF],
      attachedConversationScope: [HUGE_REF],
    });
    await runtime.runTurn({ request });
    const stored = readPersistedTranscript(installed, 7115);
    const filler: AgentModelMessage[] = [];
    for (let index = 0; index < 6; index += 1) {
      filler.push(
        { role: "user", content: `User request:\nLater ${index}` },
        {
          role: "assistant",
          content: `Later answer ${index} ${"x".repeat(20_000)}`,
        },
      );
    }
    // The copy sits far from the end; the next compaction would summarize it.
    await replaceAgentTranscriptSegment({
      conversationKey: 7115,
      compatibilityKey: PORTABLE_TRANSCRIPT_KEY,
      messages: [...stored, ...filler],
      compactedAt: 50,
    });
    clearPastChatRenderMemoForTests();
    await runtime.runTurn({ request: { ...request } });
    const prompt = prompts[1];
    assert.isTrue(
      prompt.some((message) =>
        contentText(message).startsWith("Agent transcript compact checkpoint:"),
      ),
      "the sticky compactedAt forced a compaction",
    );
    assert.equal(prompt.filter(isPastChat).length, 1, "copy kept, not doubled");
  });

  it("gives Codex conversations no past-chat history message", async function () {
    // Codex gets its chats through chat.ts (pastChatSimpleChatHistory.ts);
    // Claude Code is covered in claudePastChatDelivery.test.ts.
    const plainHistory: ChatMessage[] = [
      { role: "user", content: "Q" },
      { role: "assistant", content: "A" },
    ];
    for (const conversationSystem of ["codex"]) {
      const history = await injectAttachedPastChatsIntoAgentHistory({
        conversationKey: 7108,
        conversationSystem,
        libraryID: 1,
        messages: [
          {
            role: "user",
            timestamp: 1,
            attachedConversations: [PAST_REF],
          },
          { role: "assistant", timestamp: 2 },
        ],
        history: plainHistory,
        effectiveRequestConfig: {
          model: "test",
          apiBase: "",
          authMode: "api_key",
          advanced: undefined,
        },
        source,
      });
      assert.strictEqual(history, plainHistory);
    }
  });

  it("leaves a turn with nothing attached unchanged", async function () {
    const prompts: AgentModelMessage[][] = [];
    const runtime = createRuntime(prompts);
    const loadsBefore = source.loads.length;
    await runtime.runTurn({ request: turn(7109, "Plain question", 100) });
    assert.isFalse(prompts[0].some(isPastChat));
    assert.isFalse(
      prompts[0].some((message) => contentText(message).includes("Past chat")),
    );
    assert.equal(source.loads.length, loadsBefore, "no past chat is read");
    assert.deepEqual(
      readPersistedTranscript(installed, 7109).map(contentText),
      ["User request:\nPlain question", "Answered."],
    );
  });

  it("passes both request fields through the runtime boundary", function () {
    const resolved = resolveAgentRuntimeRequest({
      conversationKey: 1,
      mode: "agent",
      userText: "x",
      libraryID: 1,
      attachedConversations: [PAST_REF],
      attachedConversationScope: [PAST_REF, HUGE_REF],
    });
    assert.deepEqual(resolved.attachedConversations, [PAST_REF]);
    assert.deepEqual(resolved.attachedConversationScope, [PAST_REF, HUGE_REF]);
  });
});

describe("transcript compaction of past chats", function () {
  const pastChatMessage: AgentModelMessage = {
    role: "user",
    content: [
      PAST_CHAT_MESSAGE_TITLE,
      [
        "### Past chat upstream:10",
        "Title: Grid cells chat",
        "Mode: Chat · Library chat",
        PAST_CHAT_RELIABILITY_NOTE,
      ].join("\n"),
      `Full text (2 messages):\n\n[message 1 · user]\n${"secret body ".repeat(400)}`,
    ].join("\n\n"),
  };

  function longTranscript(): AgentModelMessage[] {
    const messages: AgentModelMessage[] = [
      pastChatMessage,
      { role: "user", content: "User request:\nUse my earlier chat." },
      { role: "assistant", content: "Done." },
    ];
    for (let index = 0; index < 8; index += 1) {
      messages.push(
        { role: "user", content: `User request:\nLater ${index}` },
        {
          role: "assistant",
          content: `Later answer ${index} ${"x".repeat(20_000)}`,
        },
      );
    }
    return messages;
  }

  it("summarizes an older past chat to a pointer line that names past_chat_read", function () {
    const messages = longTranscript();
    const compacted = compactAgentTranscript({
      messages,
      budget: buildAgentContextBudgetState({ messages, model: "test" }),
      force: true,
    });
    assert.isTrue(compacted.compacted);
    const summary = String(compacted.summaryMessage?.content);
    assert.include(
      summary,
      'Past chat "Grid cells chat" (upstream:10) was attached earlier; open it with past_chat_read.',
    );
    assert.notInclude(summary, "secret body");
    assert.notInclude(summary, PAST_CHAT_MESSAGE_TITLE);
    assert.notMatch(
      summary,
      /Past chat[^.]*context_read/,
      "the pointer never sends the model to context_read",
    );
    assert.isFalse(compacted.messages.some(isPastChat));
  });

  it("keeps a pinned past chat in the tail however small the tail budget", function () {
    const messages: AgentModelMessage[] = [];
    for (let index = 0; index < 8; index += 1) {
      messages.push(
        { role: "user", content: `User request:\nEarlier ${index}` },
        { role: "assistant", content: `Earlier answer ${index}` },
      );
    }
    messages.push(pastChatMessage);
    const budget = {
      ...buildAgentContextBudgetState({ messages, model: "test" }),
      recentTailTokens: 10,
    };
    const unpinned = compactAgentTranscript({ messages, budget, force: true });
    const pinned = compactAgentTranscript({
      messages,
      budget,
      force: true,
      keepInTail: pastChatMessage,
    });
    assert.isTrue(pinned.compacted);
    assert.strictEqual(
      pinned.messages[pinned.messages.length - 1],
      pastChatMessage,
    );
    assert.notInclude(
      unpinned.messages,
      pastChatMessage,
      "without the pin a tight tail budget summarizes it away",
    );
  });
});
