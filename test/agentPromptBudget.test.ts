import { assert } from "chai";
import {
  AgentPromptBudgetError,
  enforceAgentPromptBudget,
  resolveAgentPromptBudgetLimits,
} from "../src/agent/context/promptBudget";
import type { AgentModelMessage } from "../src/agent/types";

function buildRows(count: number, detailLength = 500) {
  return Array.from({ length: count }, (_, index) => ({
    itemId: 10_000 + index,
    itemType: "journalArticle",
    title: `Very detailed paper ${index}`,
    firstCreator: `Author ${index}`,
    year: "2026",
    abstract: "A".repeat(detailLength),
    tags: [`tag-${index % 3}`],
    collectionIds: [42],
    attachments: Array.from({ length: 3 }, (__, attachmentIndex) => ({
      title: `Attachment ${attachmentIndex}`,
      path: `/tmp/${index}-${attachmentIndex}.pdf`,
    })),
  }));
}

function buildCatalogToolMessage(rowCount = 80): AgentModelMessage {
  return {
    role: "tool",
    tool_call_id: "call-1",
    name: "query_library",
    content: JSON.stringify({
      entity: "items",
      mode: "list",
      filters: { collectionId: 42, hasPdf: true },
      limit: rowCount,
      totalCount: rowCount,
      returnedCount: rowCount,
      limited: false,
      results: buildRows(rowCount),
      warnings: ["broad catalog result"],
    }),
  };
}

function buildEvidenceToolMessage(snippetCount = 50): AgentModelMessage {
  return {
    role: "tool",
    tool_call_id: "call-1",
    name: "library_retrieve",
    content: JSON.stringify({
      intent: "enumerate",
      depth: "evidence",
      resourcePool: {
        totalItems: 120,
        queryCoverage: {
          metadataInspected: 120,
          indexedTextScanned: 90,
          snippetsReturned: snippetCount,
        },
      },
      answerContract: {
        coverage: "indexed/searchable text scanned for the scoped pool",
      },
      paperMatches: Array.from({ length: snippetCount }, (_, index) => ({
        itemId: 20_000 + index,
        contextItemId: 30_000 + index,
        title: `Evidence paper ${index}`,
        matchStatus: "matched",
        score: 0.9,
      })),
      snippets: Array.from({ length: snippetCount }, (_, index) => ({
        text: `Evidence snippet ${index} ${"B".repeat(900)}`,
        sourceLabel: `Evidence paper ${index}`,
        citationLabel: `Citation ${index}`,
        pageLabel: `${index + 1}`,
        sectionLabel: "Results",
        chunkIndex: index,
        paperContext: {
          itemId: 20_000 + index,
          contextItemId: 30_000 + index,
          title: `Evidence paper ${index}`,
        },
      })),
      warnings: ["coverage is bounded by indexed text availability"],
    }),
  };
}

describe("agent prompt budget", function () {
  it("resolves context limits from the model input cap override", function () {
    const limits = resolveAgentPromptBudgetLimits({
      model: "claude-haiku-4-5",
      inputTokenCap: 12_000,
    });
    assert.equal(limits.contextWindow, 12_000);
    assert.equal(limits.softLimitTokens, 10_800);
    assert.notProperty(limits, "toolResultMaxTokens");
  });

  it("leaves small prompts unchanged", function () {
    const messages: AgentModelMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Summarize this paper." },
    ];
    const result = enforceAgentPromptBudget({
      messages,
      model: "claude-haiku-4-5",
      inputTokenCap: 12_000,
    });
    assert.isFalse(result.changed);
    assert.deepEqual(result.messages, messages);
    assert.deepEqual(result.reductions, []);
  });

  it("keeps a full large tool result when the complete prompt fits a 200k budget", function () {
    const messages: AgentModelMessage[] = [
      { role: "system", content: "Use tools." },
      { role: "user", content: "Search my library." },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-1",
            name: "query_library",
            arguments: { entity: "items", mode: "list" },
          },
        ],
      },
      buildCatalogToolMessage(120),
    ];
    const result = enforceAgentPromptBudget({
      messages,
      model: "claude-haiku-4-5",
      inputTokenCap: 200_000,
    });
    assert.isFalse(result.changed);
    const serialized = JSON.stringify(result.messages);
    assert.include(serialized, "A".repeat(300));
    assert.notInclude(serialized, "modelContextCompacted");
  });

  it("compacts catalog rows only under actual send pressure", function () {
    const messages: AgentModelMessage[] = [
      { role: "system", content: "Use tools." },
      { role: "user", content: "Search my library." },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-1",
            name: "query_library",
            arguments: { entity: "items", mode: "list" },
          },
        ],
      },
      buildCatalogToolMessage(160),
    ];
    const result = enforceAgentPromptBudget({
      messages,
      model: "claude-haiku-4-5",
      inputTokenCap: 8_000,
    });
    assert.isTrue(result.changed);
    assert.isAtMost(result.estimatedAfterTokens, result.softLimitTokens);
    assert.deepInclude(result.reductions, {
      kind: "catalog_compacted",
      count: 1,
    });
    const tool = result.messages.find((message) => message.role === "tool");
    assert.equal(tool?.role, "tool");
    const modelFacing = JSON.parse((tool as { content: string }).content);
    assert.isTrue(modelFacing.modelContextCompacted);
    assert.equal(modelFacing.totalCount, 160);
    assert.equal(modelFacing.filters.collectionId, 42);
    assert.isBelow(modelFacing.results.length, 160);
    assert.notInclude(JSON.stringify(modelFacing), "A".repeat(200));
  });

  it("preserves assistant tool-call and tool-result ordering while reducing", function () {
    const messages: AgentModelMessage[] = [
      { role: "system", content: "Use tools." },
      { role: "user", content: "Search my library." },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-1",
            name: "query_library",
            arguments: { entity: "items", mode: "list" },
          },
        ],
      },
      buildCatalogToolMessage(120),
    ];
    const result = enforceAgentPromptBudget({
      messages,
      model: "claude-haiku-4-5",
      inputTokenCap: 4_000,
    });
    assert.isTrue(result.changed);
    const assistant = result.messages.find(
      (message) => message.role === "assistant",
    );
    const tool = result.messages.find((message) => message.role === "tool");
    assert.equal(assistant?.role, "assistant");
    assert.equal(tool?.role, "tool");
    assert.equal(tool?.tool_call_id, "call-1");
    assert.equal(assistant?.tool_calls?.[0]?.id, "call-1");
  });

  it("keeps the root user request when a tool follow-up user message exists", function () {
    const messages: AgentModelMessage[] = [
      { role: "system", content: "Use tools." },
      { role: "user", content: "Old context ".repeat(10_000) },
      { role: "assistant", content: "Old answer." },
      { role: "user", content: "Search my library for drift papers." },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-1",
            name: "query_library",
            arguments: { entity: "items", mode: "list" },
          },
        ],
      },
      buildCatalogToolMessage(20),
      { role: "user", content: "Tool artifact summary." },
    ];
    const result = enforceAgentPromptBudget({
      messages,
      model: "claude-haiku-4-5",
      inputTokenCap: 3_200,
    });
    assert.isTrue(result.changed);
    assert.isAtMost(result.estimatedAfterTokens, result.softLimitTokens);
    assert.deepEqual(
      result.messages.map((message) => message.role),
      ["system", "user", "user", "assistant", "tool", "user"],
    );
    assert.include(
      String(result.messages[1].content),
      "Agent context checkpoint",
    );
    assert.equal(
      result.messages[2].content,
      "Search my library for drift papers.",
    );
  });

  it("preserves evidence snippets and anchors when evidence must be reduced", function () {
    const messages: AgentModelMessage[] = [
      { role: "system", content: "Use tools." },
      { role: "user", content: "Find evidence." },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-1",
            name: "library_retrieve",
            arguments: { query: "representational drift" },
          },
        ],
      },
      buildEvidenceToolMessage(80),
    ];
    const result = enforceAgentPromptBudget({
      messages,
      model: "claude-haiku-4-5",
      inputTokenCap: 10_000,
    });
    assert.isTrue(result.changed);
    assert.isAtMost(result.estimatedAfterTokens, result.softLimitTokens);
    assert.deepInclude(result.reductions, {
      kind: "evidence_compacted",
      count: 1,
    });
    const tool = result.messages.find((message) => message.role === "tool");
    assert.equal(tool?.role, "tool");
    const modelFacing = JSON.parse((tool as { content: string }).content);
    assert.isTrue(modelFacing.modelContextCompacted);
    assert.include(JSON.stringify(modelFacing), "queryCoverage");
    assert.include(JSON.stringify(modelFacing), "Evidence snippet");
    assert.include(JSON.stringify(modelFacing), "pageLabel");
    assert.include(JSON.stringify(modelFacing), "sectionLabel");
    assert.include(JSON.stringify(modelFacing), "paperContext");
  });

  it("throws a graceful local over-budget error when protected context cannot fit", function () {
    const messages: AgentModelMessage[] = [
      { role: "system", content: "Use tools." },
      { role: "user", content: "X".repeat(30_000) },
    ];
    assert.throws(
      () =>
        enforceAgentPromptBudget({
          messages,
          model: "claude-haiku-4-5",
          inputTokenCap: 2_000,
        }),
      AgentPromptBudgetError,
      "raise the Input cap",
    );
  });
});
