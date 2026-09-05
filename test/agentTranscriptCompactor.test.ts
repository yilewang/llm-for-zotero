import { assert } from "chai";
import { buildAgentContextBudgetState } from "../src/agent/context/budgetPolicy";
import { estimateTextTokens } from "../src/utils/modelInputCap";
import { compactAgentTranscript } from "../src/agent/context/transcriptCompactor";
import type { AgentModelMessage } from "../src/agent/types";

describe("agent transcript compactor", function () {
  it("uses the profile context limit when deciding compaction thresholds", function () {
    const budget = buildAgentContextBudgetState({
      messages: [{ role: "user", content: "current request" }],
      model: "claude-haiku-4-5",
      profileOverride: {
        forModel: "claude-haiku-4-5",
        limits: { contextWindowTokens: 10_000, inputTokens: 10_000 },
      },
    });

    assert.equal(budget.contextWindow, 10_000);
    assert.equal(budget.targetTokens, 5_800);
  });

  it("creates rehydratable handles for dropped tool messages", function () {
    const messages: AgentModelMessage[] = [
      { role: "user", content: "old catalog request" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "old-call",
            name: "library_search",
            arguments: { entity: "items", mode: "list" },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "old-call",
        name: "library_search",
        content: JSON.stringify({
          totalCount: 2,
          returnedCount: 2,
          results: [
            { itemId: 1, title: "Paper A" },
            { itemId: 2, title: "Paper B" },
          ],
        }),
      },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "current request" },
      { role: "assistant", content: "current answer" },
    ];
    const baseBudget = buildAgentContextBudgetState({
      messages,
      model: "claude-haiku-4-5",
      inputTokenCap: 32_000,
      forceCompact: true,
    });
    const budget = {
      ...baseBudget,
      recentTailTokens: 1,
      summaryTokens: 120,
      policy: {
        ...baseBudget.policy,
        minRecentMessages: 2,
      },
    };
    const result = compactAgentTranscript({
      messages,
      budget,
      force: true,
      conversationKey: 9,
      resourceSignature: "scope-a",
    });

    assert.isTrue(result.compacted);
    assert.lengthOf(result.handleRecords, 1);
    assert.match(result.handleRecords[0].handle, /^trh_/);
    assert.lengthOf(
      (result.handleRecords[0].content as { results: unknown[] }).results,
      2,
    );
    assert.include(
      String(result.summaryMessage?.content),
      result.handleRecords[0].handle,
    );
  });
});

describe("CJK summary budget", function () {
  it("keeps the compact checkpoint within its token budget for CJK content", function () {
    const messages: AgentModelMessage[] = Array.from(
      { length: 12 },
      (_, index) =>
        index % 2 === 0
          ? {
              role: "user" as const,
              content: `问题${index}：${"神经科学研究进展。".repeat(40)}`,
            }
          : {
              role: "assistant" as const,
              content: `回答${index}：${"表征漂移的证据分析。".repeat(40)}`,
            },
    );
    messages.push({ role: "user", content: "最后的问题" });

    const result = compactAgentTranscript({
      messages,
      budget: {
        policy: { minRecentMessages: 2 } as any,
        recentTailTokens: 200,
        summaryTokens: 400,
      } as any,
      force: true,
    });

    assert.isTrue(result.compacted);
    const summary = result.summaryMessage;
    assert.isOk(summary);
    assert.isAtMost(
      estimateTextTokens(
        typeof summary?.content === "string" ? summary.content : "",
      ),
      400,
    );
  });
});
