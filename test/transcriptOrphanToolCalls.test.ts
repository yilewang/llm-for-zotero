import { assert } from "chai";
import {
  appendAgentTranscriptMessages,
  loadAgentTranscriptSegment,
  clearAgentTranscriptStore,
  replaceAgentTranscriptSegment,
} from "../src/agent/store/transcriptStore";
import type { AgentModelMessage } from "../src/agent/types";

/**
 * An assistant message carrying a round's whole tool_calls list is recorded
 * before the per-call loop runs, and that loop can bail mid-list — a denial
 * that ends the run, the error breaker, a declined review card. The
 * unanswered calls then sit in the transcript forever, and
 * OpenAI-compatible providers reject the next request with a 400.
 *
 * Persisting failed runs (Stage C) made this reachable on a second path, so
 * the invariant is enforced at the store where every producer passes through.
 */
describe("transcript orphan tool_calls", function () {
  beforeEach(function () {
    clearAgentTranscriptStore();
  });

  async function roundTrip(messages: AgentModelMessage[]) {
    await appendAgentTranscriptMessages({
      conversationKey: 4242,
      compatibilityKey: "test",
      messages,
    });
    const segment = await loadAgentTranscriptSegment({
      conversationKey: 4242,
      compatibilityKey: "test",
    });
    return segment.messages;
  }

  it("keeps a call that was answered", async function () {
    const stored = await roundTrip([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "a",
            type: "function",
            function: { name: "t", arguments: "{}" },
          },
        ],
      } as never,
      { role: "tool", tool_call_id: "a", content: "ok" } as never,
    ]);
    const assistant = stored.find((m) => m.role === "assistant") as never as {
      tool_calls?: unknown[];
    };
    assert.lengthOf(assistant?.tool_calls || [], 1);
  });

  it("drops the unanswered half of a partially answered round", async function () {
    const stored = await roundTrip([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "a",
            type: "function",
            function: { name: "t", arguments: "{}" },
          },
          {
            id: "b",
            type: "function",
            function: { name: "t", arguments: "{}" },
          },
        ],
      } as never,
      { role: "tool", tool_call_id: "a", content: "ok" } as never,
    ]);
    const assistant = stored.find((m) => m.role === "assistant") as never as {
      tool_calls?: Array<{ id: string }>;
    };
    assert.deepEqual(
      (assistant?.tool_calls || []).map((c) => c.id),
      ["a"],
      "an unanswered call 400s the next request on OpenAI-compatible providers",
    );
  });

  it("drops an assistant turn that only announced unanswered calls", async function () {
    const stored = await roundTrip([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "a",
            type: "function",
            function: { name: "t", arguments: "{}" },
          },
        ],
      } as never,
    ]);
    assert.isUndefined(
      stored.find((m) => m.role === "assistant"),
      "nothing worth keeping remained on that turn",
    );
  });

  it("keeps the text when an assistant said something and its calls went unanswered", async function () {
    const stored = await roundTrip([
      {
        role: "assistant",
        content: "Let me file those.",
        tool_calls: [
          {
            id: "a",
            type: "function",
            function: { name: "t", arguments: "{}" },
          },
        ],
      } as never,
    ]);
    const assistant = stored.find((m) => m.role === "assistant") as never as {
      content?: string;
      tool_calls?: unknown[];
    };
    assert.equal(assistant?.content, "Let me file those.");
    assert.lengthOf(assistant?.tool_calls || [], 0);
  });
});

describe("transcript replacement durability", function () {
  it("keeps the previous segment when an atomic replacement fails", async function () {
    const previousZotero = (
      globalThis as typeof globalThis & { Zotero?: unknown }
    ).Zotero;
    const rows: Array<{
      conversationKey: number;
      compatibilityKey: string;
      sequence: number;
      messageJson: string;
      compactedAt?: number;
    }> = [];
    let failAtSequence: number | undefined;
    (
      globalThis as typeof globalThis & {
        Zotero?: unknown;
      }
    ).Zotero = {
      DB: {
        executeTransaction: async (task: () => Promise<unknown>) => {
          const snapshot = rows.map((row) => ({ ...row }));
          try {
            return await task();
          } catch (error) {
            rows.splice(0, rows.length, ...snapshot);
            throw error;
          }
        },
        queryAsync: async (sql: string, params: unknown[] = []) => {
          if (sql.includes("DELETE FROM llm_for_zotero_agent_transcript")) {
            for (let index = rows.length - 1; index >= 0; index -= 1) {
              if (
                rows[index].conversationKey === Number(params[0]) &&
                rows[index].compatibilityKey === params[1]
              ) {
                rows.splice(index, 1);
              }
            }
            return [];
          }
          if (sql.includes("INSERT INTO llm_for_zotero_agent_transcript")) {
            if (Number(params[2]) === failAtSequence) {
              throw new Error("simulated transcript insert failure");
            }
            rows.push({
              conversationKey: Number(params[0]),
              compatibilityKey: String(params[1]),
              sequence: Number(params[2]),
              messageJson: String(params[3]),
              compactedAt:
                typeof params[4] === "number" ? Number(params[4]) : undefined,
            });
            return [];
          }
          if (sql.includes("FROM llm_for_zotero_agent_transcript")) {
            return rows
              .filter(
                (row) =>
                  row.conversationKey === Number(params[0]) &&
                  row.compatibilityKey === params[1],
              )
              .sort((left, right) => left.sequence - right.sequence);
          }
          return [];
        },
      },
    };

    try {
      clearAgentTranscriptStore();
      const initialWrite = await replaceAgentTranscriptSegment({
        conversationKey: 5150,
        compatibilityKey: "atomic",
        messages: [{ role: "user", content: "previous checkpoint" }],
      });
      assert.equal(initialWrite, "persisted");

      failAtSequence = 1;
      const failedWrite = await replaceAgentTranscriptSegment({
        conversationKey: 5150,
        compatibilityKey: "atomic",
        messages: [
          { role: "user", content: "replacement first row" },
          { role: "user", content: "replacement second row" },
        ],
      });
      assert.equal(failedWrite, "failed");

      const cached = await loadAgentTranscriptSegment({
        conversationKey: 5150,
        compatibilityKey: "atomic",
      });
      assert.deepEqual(cached.messages, [
        { role: "user", content: "previous checkpoint" },
      ]);

      clearAgentTranscriptStore();
      const durable = await loadAgentTranscriptSegment({
        conversationKey: 5150,
        compatibilityKey: "atomic",
      });
      assert.deepEqual(durable.messages, [
        { role: "user", content: "previous checkpoint" },
      ]);
    } finally {
      clearAgentTranscriptStore();
      (
        globalThis as typeof globalThis & {
          Zotero?: unknown;
        }
      ).Zotero = previousZotero;
    }
  });
});
