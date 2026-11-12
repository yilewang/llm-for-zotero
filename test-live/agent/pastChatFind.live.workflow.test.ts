/**
 * Live check: the built-in agent finds an earlier chat from plain words
 * (past_chat_search) and adds it (past_chat_attach). It costs API usage: run
 * it only when asked.
 *
 * Cases (test-live/runtimes/pastChatFindLive.ts): clear (attached without a
 * question; the fact is in the answer; the stored user row holds a via
 * "agent" reference), several (asks, attaches nothing), none (attaches
 * nothing; points to "Add past conversation"). n = 1 each; exploratory.
 *
 *   LLM_FOR_ZOTERO_TEST_ENTRIES=test-live/agent/pastChatFind.live.workflow.test.ts \
 *   LLM_FOR_ZOTERO_LIVE_MODEL=deepseek-v4-flash \
 *   LLM_FOR_ZOTERO_LIVE_PROFILE_PATH=<prefs.js with that model> \
 *   node scripts/run-workflow-tests.mjs --agent-live
 *
 * The report is written to <data dir>/past-chat-find-live-report.json.
 */
import { assert } from "chai";
import {
  liveModelName,
  resolveLiveAgentCredentials,
} from "./liveAgentCredentials";
import {
  runPastChatFindCases,
  type PastChatFindTurn,
} from "../runtimes/pastChatFindLive";

declare const Zotero: any;

describe("live: the built-in agent finds and adds an earlier chat", function () {
  this.timeout(900_000);

  it("attaches a clear match without asking, asks between several, and attaches nothing when none matches", async function () {
    const credentials = await resolveLiveAgentCredentials({
      requestedModel: liveModelName("deepseek-v4-flash"),
    });
    assert.isOk(
      credentials,
      "Configure the requested model in the selected test profile; this test must not skip",
    );
    const turns: PastChatFindTurn[] = [];
    try {
      await runPastChatFindCases({
        system: "upstream",
        credentials: credentials!,
        cases: ["clear", "several", "none"],
        turns,
        prefs: { enableAgentMode: true, lastUsedRuntimeMode: "agent" },
      });
    } finally {
      await Zotero.File.putContentsAsync(
        `${Zotero.DataDirectory.dir}/past-chat-find-live-report.json`,
        JSON.stringify({ model: credentials?.model, turns }, null, 2),
      ).catch(() => undefined);
    }
  });
});
