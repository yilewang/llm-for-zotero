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
        snippetId: `lr_${20_000 + index}_${30_000 + index}_${index}_bm25`,
        itemId: `${20_000 + index}`,
        contextItemId: `${30_000 + index}`,
        chunkIndex: index,
        title: `Evidence paper ${index}`,
        sourceKind: "pdf_text",
        matchMethod: "bm25",
        sectionLabel: "Results",
        snippet: `Evidence snippet ${index} ${"B".repeat(900)}`,
        surroundingText: `Surrounding evidence ${index} ${"C".repeat(900)}`,
        score: 0.9,
        whyMatched: "Full-text BM25 retrieval ranked this passage highly",
        matchedQueryVariant: "representational drift",
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
    assert.equal(limits.inputLimitSource, "advanced");
    assert.equal(limits.softLimitTokens, 10_800);
    assert.notProperty(limits, "toolResultMaxTokens");
  });

  it("resolves the prompt budget from the matching profile override", function () {
    const limits = resolveAgentPromptBudgetLimits({
      model: "claude-haiku-4-5",
      profileOverride: {
        forModel: "claude-haiku-4-5",
        limits: { inputTokens: 18_000 },
      },
    });

    assert.equal(limits.contextWindow, 18_000);
    assert.equal(limits.inputLimitSource, "user");
    assert.equal(limits.softLimitTokens, 16_200);
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
    assert.deepEqual(result.handleRecords, []);
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
    assert.deepEqual(result.handleRecords, []);
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
      conversationKey: 1,
      resourceSignature: "scope-a",
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
    assert.match(modelFacing.toolResultHandle, /^trh_/);
    assert.lengthOf(result.handleRecords, 1);
    assert.equal(result.handleRecords[0].handle, modelFacing.toolResultHandle);
    assert.equal(result.handleRecords[0].conversationKey, 1);
    assert.equal(result.handleRecords[0].toolName, "query_library");
    assert.lengthOf(
      (result.handleRecords[0].content as { results: unknown[] }).results,
      160,
    );
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
      conversationKey: 2,
      resourceSignature: "scope-a",
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
    assert.match(modelFacing.toolResultHandle, /^trh_/);
    assert.lengthOf(result.handleRecords, 1);
    assert.equal(result.handleRecords[0].handle, modelFacing.toolResultHandle);
    assert.include(JSON.stringify(modelFacing), "queryCoverage");
    assert.include(modelFacing.snippets[0].text, "Evidence snippet 0");
    assert.equal(modelFacing.snippets[0].itemId, "20000");
    assert.equal(modelFacing.snippets[0].contextItemId, "30000");
    assert.equal(modelFacing.snippets[0].matchMethod, "bm25");
    assert.equal(modelFacing.snippets[0].paperContext.itemId, "20000");
    assert.equal(modelFacing.snippets[0].paperContext.contextItemId, "30000");
  });

  it("strips orphan quote citation ids when evidence must be reduced", function () {
    const evidenceMessage = buildEvidenceToolMessage(80);
    const content = JSON.parse(String(evidenceMessage.content));
    content.snippets = content.snippets.map(
      (snippet: Record<string, unknown>, index: number) => ({
        ...snippet,
        quoteCitationId: `Q_orphan_${index}`,
      }),
    );
    evidenceMessage.content = JSON.stringify(content);
    const result = enforceAgentPromptBudget({
      messages: [
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
        evidenceMessage,
      ],
      model: "claude-haiku-4-5",
      inputTokenCap: 10_000,
      conversationKey: 2,
      resourceSignature: "scope-a",
    });
    const tool = result.messages.find((message) => message.role === "tool");
    assert.equal(tool?.role, "tool");
    const modelFacing = JSON.parse((tool as { content: string }).content);

    assert.isTrue(modelFacing.modelContextCompacted);
    assert.notProperty(modelFacing.snippets[0], "quoteCitationId");
    assert.notProperty(modelFacing, "quoteCitations");
  });

  it("keeps compacted quote ids only with matching quote metadata", function () {
    const evidenceMessage = buildEvidenceToolMessage(80);
    const content = JSON.parse(String(evidenceMessage.content));
    content.snippets = content.snippets.map(
      (snippet: Record<string, unknown>, index: number) => ({
        ...snippet,
        quoteCitationId: index === 0 ? "Q_valid_0" : `Q_orphan_${index}`,
      }),
    );
    content.quoteCitations = [
      {
        id: "Q_valid_0",
        quoteText: "Evidence snippet 0",
        citationLabel: "(Evidence Paper 0, 2026)",
        itemId: 20_000,
        contextItemId: 30_000,
      },
    ];
    evidenceMessage.content = JSON.stringify(content);
    const result = enforceAgentPromptBudget({
      messages: [
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
        evidenceMessage,
      ],
      model: "claude-haiku-4-5",
      inputTokenCap: 10_000,
      conversationKey: 2,
      resourceSignature: "scope-a",
    });
    const tool = result.messages.find((message) => message.role === "tool");
    assert.equal(tool?.role, "tool");
    const modelFacing = JSON.parse((tool as { content: string }).content);

    assert.isTrue(modelFacing.modelContextCompacted);
    assert.equal(modelFacing.quoteCitations[0].id, "Q_valid_0");
    assert.equal(modelFacing.snippets[0].quoteCitationId, "Q_valid_0");
    assert.notInclude(JSON.stringify(modelFacing), "Q_orphan_1");
  });

  it("adds handles to history checkpoints for dropped older tool results", function () {
    const messages: AgentModelMessage[] = [
      { role: "system", content: "Use tools." },
      { role: "user", content: "Earlier catalog request." },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "old-call",
            name: "query_library",
            arguments: { entity: "items", mode: "list" },
          },
        ],
      },
      {
        ...buildCatalogToolMessage(80),
        tool_call_id: "old-call",
      } as AgentModelMessage,
      { role: "assistant", content: "Earlier synthesis." },
      { role: "user", content: "Current request." },
    ];
    const result = enforceAgentPromptBudget({
      messages,
      model: "claude-haiku-4-5",
      inputTokenCap: 4_000,
      conversationKey: 3,
      resourceSignature: "scope-a",
    });
    assert.isTrue(result.changed);
    assert.lengthOf(result.handleRecords, 1);
    assert.include(
      String(result.messages[1].content),
      result.handleRecords[0].handle,
    );
    assert.lengthOf(
      (result.handleRecords[0].content as { results: unknown[] }).results,
      80,
    );
  });

  it("preserves the latest generic tool result while reducing older tool output", function () {
    const latestReadContent = JSON.stringify({
      handle: "trh_latest",
      path: "results",
      returnedCount: 2,
      items: [
        { itemId: 51, title: "Stored row 50" },
        { itemId: 52, title: "Stored row 51" },
      ],
    });
    const messages: AgentModelMessage[] = [
      { role: "system", content: "Use tools." },
      { role: "user", content: "List papers, then inspect omitted rows." },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-library",
            name: "query_library",
            arguments: { entity: "items", mode: "list" },
          },
        ],
      },
      {
        ...buildCatalogToolMessage(160),
        tool_call_id: "call-library",
      } as AgentModelMessage,
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-read",
            name: "tool_result_read",
            arguments: {
              handle: "trh_latest",
              path: "results",
              offset: 50,
              limit: 2,
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call-read",
        name: "tool_result_read",
        content: latestReadContent,
      },
    ];

    const result = enforceAgentPromptBudget({
      messages,
      model: "claude-haiku-4-5",
      inputTokenCap: 8_000,
      conversationKey: 4,
      resourceSignature: "scope-b",
    });

    assert.isTrue(result.changed);
    const latestToolResult = result.messages.find(
      (message) =>
        message.role === "tool" && message.tool_call_id === "call-read",
    );
    assert.equal(latestToolResult?.content, latestReadContent);
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

describe("CJK convergence", function () {
  it("converges instead of throwing for CJK-heavy oversized tool results", function () {
    const messages: AgentModelMessage[] = [
      { role: "system", content: "System prompt" },
      { role: "user", content: "总结这些论文" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call-1", name: "library_retrieve", arguments: {} }],
      },
      {
        role: "tool",
        name: "library_retrieve",
        tool_call_id: "call-1",
        content: JSON.stringify({ text: "神经网络研究综述。".repeat(20000) }),
      },
      { role: "user", content: "继续" },
    ];

    const result = enforceAgentPromptBudget({
      messages,
      model: "gpt-4o-mini",
      inputTokenCap: 24_000,
    });

    assert.isAtMost(result.estimatedAfterTokens, result.softLimitTokens);
  });
});
