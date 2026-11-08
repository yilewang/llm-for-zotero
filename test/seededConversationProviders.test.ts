import { assert } from "chai";
import { describe, it } from "mocha";
import { buildBridgeRuntimeRequestForTests } from "../src/agent/externalBackendBridge";
import { buildLLMHistoryFromStoredMessagesForTests } from "../src/modules/contextPanel/chat";
import {
  buildSeededConversationHandover,
  buildSeededConversationMessages,
  SEEDED_CONVERSATION_HANDOVER_SOURCE,
  seededConversationNeedsHandover,
} from "../src/modules/contextPanel/seededConversation";
import type { SelectedTextContext } from "../src/shared/types";
import {
  CodexAppServerProcess,
  destroyCachedCodexAppServerProcess,
} from "../src/utils/codexAppServerProcess";
import {
  createNativeLifecycleTestProcess,
  installDirectPathTestPrefs,
} from "./helpers/codexNativeLifecycle";
import { runCodexAppServerNativeTurn } from "./helpers/preparedNativeTurn";

/**
 * What each runtime's provider receives on the first sidebar message after
 * Inline Ask's Continue in sidebar: the passage and the turns, once.
 */
describe("Continue in sidebar: what the provider receives", function () {
  const passage = "A familiar stimulus drifts at a smaller rate.";
  const selection: SelectedTextContext = {
    text: passage,
    source: "pdf",
    contextItemId: 41,
    pageIndex: 3,
    pageLabel: "4",
    paperContext: { itemId: 40, contextItemId: 41, title: "Drift paper" },
  };
  const turns = [
    { role: "user" as const, text: "Explain this passage in plain language." },
    { role: "assistant" as const, text: "Familiar inputs drift slowly." },
    { role: "user" as const, text: "Why slower?" },
    { role: "assistant" as const, text: "Repeated exposure stabilizes it." },
  ];

  it("Codex app-server: a new thread gets the stored passage and turns as injected history, and no chip", async function () {
    assert.isFalse(seededConversationNeedsHandover("codex"));
    const stored = buildSeededConversationMessages(
      { selectedTextContext: selection, turns },
      50_000,
    );
    const requests: Array<{ method: string; params: Record<string, any> }> = [];
    const proc = createNativeLifecycleTestProcess({
      newThreadIds: ["seeded-thread"],
      requests,
      permissionProfilesResult: {
        data: [{ id: ":danger-full-access", description: "Full access" }],
      },
      deltaForTurn: () => "Go on answer",
    });
    const restorePrefs = installDirectPathTestPrefs(
      "off",
      ":danger-full-access",
    );
    // The seeded chat as the panel loads it and sends it as history.
    const history = buildLLMHistoryFromStoredMessagesForTests(stored);
    const originalDB = (globalThis as any).Zotero.DB;
    (globalThis as any).Zotero.DB = { queryAsync: async () => [] };
    const originalSpawn = CodexAppServerProcess.spawn;
    CodexAppServerProcess.spawn = async () => proc;
    const processKey = "native-seeded-inline-ask";
    try {
      await runCodexAppServerNativeTurn({
        scope: {
          conversationKey: 6_000_000_811,
          libraryID: 1,
          kind: "paper" as const,
          paperItemID: 40,
        },
        model: "gpt-5.6",
        messages: [...history, { role: "user" as const, content: "Go on." }],
        processKey,
        hooks: {
          // The seeded chat has no provider thread yet.
          loadProviderSessionId: async () => undefined,
          persistProviderSessionId: async () => {},
        },
      });
    } finally {
      destroyCachedCodexAppServerProcess(processKey, proc);
      CodexAppServerProcess.spawn = originalSpawn;
      (globalThis as any).Zotero.DB = originalDB;
      restorePrefs();
    }
    const injected = requests.filter(
      (request) => request.method === "thread/inject_items",
    );
    assert.lengthOf(injected, 1, "the stored turns are injected once");
    const injectedText = JSON.stringify(injected[0].params.items);
    assert.include(
      injectedText,
      passage,
      "the first question keeps its passage",
    );
    for (const turn of turns) assert.include(injectedText, turn.text);
    const turnStart = requests.find(
      (request) => request.method === "turn/start",
    );
    const turnText = JSON.stringify(turnStart?.params.input);
    assert.include(turnText, "Go on.");
    assert.notInclude(turnText, "Inline Ask", "no transcript chip is sent");
    assert.notInclude(turnText, "Familiar inputs drift slowly.");
  });

  it("Claude Code: the bridge request carries the chip with the paper, page, passage and turns", async function () {
    assert.isTrue(seededConversationNeedsHandover("claude_code"));
    const chip = buildSeededConversationHandover({
      selectedTextContext: selection,
      turns,
    });
    const request = await buildBridgeRuntimeRequestForTests({
      conversationKey: 3_000_000_123,
      mode: "agent",
      userText: "Go on.",
      libraryID: 1,
      selectedTexts: [chip],
      selectedTextSources: [SEEDED_CONVERSATION_HANDOVER_SOURCE],
      selectedTextContexts: [
        { text: chip, source: SEEDED_CONVERSATION_HANDOVER_SOURCE },
      ],
    });
    // The bridge lists selectedTexts under "Selected snippets" in the prompt
    // (packages/claude-bridge sdk-runtime-client.spec.ts); a fresh session
    // gets no stored history, so this is where the turns reach Claude.
    assert.deepEqual(request.selectedTexts, [chip]);
    assert.deepEqual(request.selectedTextSources, ["inlineask"]);
    const text = request.selectedTexts![0];
    assert.isTrue(
      text.startsWith(
        `Paper: Drift paper\nPage: 4\nSelected passage:\n${passage}\n\n`,
      ),
      text,
    );
    const questionAt = text.indexOf("Q: Explain this passage");
    assert.isAbove(questionAt, text.indexOf(passage));
    assert.include(text, "A: Repeated exposure stabilizes it.");
  });
});
