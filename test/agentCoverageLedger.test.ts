import { assert } from "chai";
import {
  buildAgentCoverageContextBlock,
  buildAgentCoverageEntriesForActivity,
  clearAgentCoverageLedger,
  clearPersistedAgentCoverage,
  commitAgentCoverageActivities,
  hydrateAgentCoverageLedger,
} from "../src/agent/context/coverageLedger";
import { buildAgentResourceContextPlan } from "../src/agent/context/resourceLifecycle";
import { buildAgentInitialMessages } from "../src/agent/model/messageBuilder";
import type {
  AgentModelMessage,
  AgentRuntimeRequest,
} from "../src/agent/types";
import type { PaperContextRef } from "../src/shared/types";

function paper(
  itemId: number,
  contextItemId: number,
  title = `Paper ${itemId}`,
): PaperContextRef {
  return {
    itemId,
    contextItemId,
    title,
    firstCreator: "Smith",
    year: "2024",
    citationKey: `smith${itemId}`,
  };
}

function request(
  overrides: Partial<AgentRuntimeRequest> = {},
): AgentRuntimeRequest {
  return {
    conversationKey: 901,
    mode: "agent",
    userText: "What methods evidence do we already have?",
    libraryID: 1,
    selectedPaperContexts: [paper(1, 10, "Coverage Paper")],
    ...overrides,
  };
}

function messageText(message: AgentModelMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

function stableSystemText(messages: AgentModelMessage[]): string {
  const message = messages.find(
    (entry) => entry.role === "system" && entry.cachePolicy === "stable-prefix",
  );
  return message ? messageText(message) : "";
}

function installCoverageMockDb() {
  type CoverageRow = {
    scopeKey: string;
    coverageKey: string;
    resourceKey: string;
    durable: number;
    originConversationKey?: number;
    entryJson: string;
    updatedAt: number;
  };
  const rows = new Map<string, CoverageRow>();
  const originalZotero = (
    globalThis as typeof globalThis & { Zotero?: unknown }
  ).Zotero;
  (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
    DB: {
      queryAsync: async (sql: string, params: unknown[] = []) => {
        if (!sql.includes("llm_for_zotero_agent_coverage")) return [];
        if (sql.includes("INSERT INTO")) {
          const scopeKey = String(params[0] || "");
          const coverageKey = String(params[1] || "");
          rows.set(`${scopeKey}:${coverageKey}`, {
            scopeKey,
            coverageKey,
            resourceKey: String(params[2] || ""),
            durable: Number(params[3]) || 0,
            originConversationKey: Number(params[4]) || undefined,
            entryJson: String(params[5] || ""),
            updatedAt: Number(params[6]) || 0,
          });
          return [];
        }
        if (sql.includes("SELECT entry_json AS entryJson")) {
          const scopeKey = String(params[0] || "");
          const limit = Math.max(0, Number(params[1]) || rows.size);
          return Array.from(rows.values())
            .filter((row) => row.scopeKey === scopeKey)
            .sort((left, right) => right.updatedAt - left.updatedAt)
            .slice(0, limit)
            .map((row) => ({ entryJson: row.entryJson }));
        }
        if (sql.includes("DELETE FROM")) {
          if (sql.includes("coverage_key NOT IN")) return [];
          if (sql.includes("WHERE scope_key = ?")) {
            const scopeKey = String(params[0] || "");
            const originConversationKey = Number(params[1]) || undefined;
            for (const key of Array.from(rows.keys())) {
              const row = rows.get(key);
              if (
                row?.scopeKey === scopeKey ||
                (originConversationKey &&
                  row?.originConversationKey === originConversationKey)
              ) {
                rows.delete(key);
              }
            }
          } else {
            rows.clear();
          }
        }
        return [];
      },
    },
  };
  return {
    rows,
    restore: () => {
      (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
        originalZotero;
    },
  };
}

describe("agent coverage ledger", function () {
  beforeEach(async function () {
    clearAgentCoverageLedger();
    await clearPersistedAgentCoverage();
  });

  it("derives compact coverage from library search, paper reads, MinerU file reads, and visual reads", function () {
    const req = request();
    const libraryEntries = buildAgentCoverageEntriesForActivity({
      toolName: "library_search",
      input: {
        entity: "items",
        mode: "search",
        text: "drift",
        include: ["abstract"],
      },
      content: {
        entity: "items",
        mode: "search",
        totalCount: 1,
        results: [
          {
            itemId: 1,
            title: "Coverage Paper",
            abstract: "A paper about drift.",
          },
        ],
      },
      request: req,
      timestamp: 1,
    });
    const paperEntries = buildAgentCoverageEntriesForActivity({
      toolName: "paper_read",
      input: { mode: "targeted", query: "methods" },
      content: {
        mode: "targeted",
        papers: [
          {
            paperContext: req.selectedPaperContexts?.[0],
            passages: [{ text: "The method used a stable readout." }],
          },
        ],
      },
      request: req,
      timestamp: 2,
    });
    const mineruEntries = buildAgentCoverageEntriesForActivity({
      toolName: "file_io",
      input: {
        action: "read",
        filePath: "/tmp/mineru/10/full.md",
        offset: 10,
        length: 50,
      },
      content: { content: "MinerU methods section." },
      request: {
        ...req,
        selectedPaperContexts: [
          {
            ...req.selectedPaperContexts![0],
            mineruCacheDir: "/tmp/mineru/10",
          },
        ],
      },
      timestamp: 3,
    });
    const visualEntries = buildAgentCoverageEntriesForActivity({
      toolName: "view_pdf_pages",
      input: {
        target: { paperContext: req.selectedPaperContexts?.[0] },
        pages: [3],
      },
      content: { pages: [{ pageLabel: "3", text: "figure page" }] },
      artifacts: [{ kind: "image", mimeType: "image/png", contentHash: "img" }],
      request: req,
      timestamp: 4,
    });

    assert.isTrue(
      libraryEntries.some(
        (entry) =>
          entry.resourceKey === "item:1" &&
          entry.sourceKind === "zotero_metadata" &&
          entry.granularity === "abstract",
      ),
    );
    assert.deepInclude(paperEntries[0], {
      resourceKey: "paper:1:10",
      sourceKind: "embedding_retrieval",
      granularity: "passage",
      coverage: "targeted",
    });
    assert.deepInclude(mineruEntries[0], {
      resourceKey: "paper:1:10",
      sourceKind: "mineru",
      granularity: "section",
    });
    assert.deepInclude(visualEntries[0], {
      resourceKey: "paper:1:10",
      sourceKind: "pdf_visual",
      granularity: "visual_page",
    });
  });

  it("persists, hydrates, renders, and clears conversation coverage", async function () {
    const { rows, restore } = installCoverageMockDb();
    try {
      const req = request();
      await commitAgentCoverageActivities({
        conversationKey: req.conversationKey,
        activities: [
          {
            toolName: "paper_read",
            input: { mode: "targeted", query: "methods" },
            content: {
              mode: "targeted",
              papers: [
                {
                  paperContext: req.selectedPaperContexts?.[0],
                  passages: [{ text: "Persisted coverage evidence." }],
                },
              ],
            },
            request: req,
            timestamp: 5,
          },
        ],
      });
      assert.isAbove(rows.size, 0);

      clearAgentCoverageLedger();
      await hydrateAgentCoverageLedger({
        conversationKey: req.conversationKey,
        request: req,
      });
      const block = buildAgentCoverageContextBlock({
        conversationKey: req.conversationKey,
        request: req,
      });
      assert.include(block, "Known coverage from prior agent reads");
      assert.include(block, "Coverage Paper");
      assert.include(block, "source=embedding_retrieval");
      assert.notInclude(block, "Persisted coverage evidence.");

      await clearPersistedAgentCoverage(req.conversationKey);
      clearAgentCoverageLedger();
      await hydrateAgentCoverageLedger({
        conversationKey: req.conversationKey,
        request: req,
      });
      assert.equal(
        buildAgentCoverageContextBlock({
          conversationKey: req.conversationKey,
          request: req,
        }),
        "",
      );
    } finally {
      restore();
    }
  });

  it("injects coverage outside the stable-prefix system block", async function () {
    const req = request({
      conversationKey: 902,
      model: "gpt-5.4",
      apiBase: "https://api.openai.com/v1/responses",
      providerProtocol: "responses_api",
      selectedPaperContexts: Array.from({ length: 70 }, (_, index) =>
        paper(
          1000 + index,
          2000 + index,
          `Stable cache paper ${index} ${"context ".repeat(8)}`,
        ),
      ),
    });
    const first = buildAgentResourceContextPlan(req);
    await commitAgentCoverageActivities({
      conversationKey: req.conversationKey,
      activities: [
        {
          toolName: "library_search",
          input: { entity: "items", mode: "search", text: "cache" },
          content: {
            entity: "items",
            mode: "search",
            results: [{ itemId: 1000, title: "Stable cache paper 0" }],
          },
          request: req,
          timestamp: 6,
        },
      ],
    });
    const second = buildAgentResourceContextPlan(req);
    const messages = await buildAgentInitialMessages(req, [], [], second);
    const userText = messageText(messages[messages.length - 1]);
    const stableText = stableSystemText(messages);

    assert.equal(
      second.contextCache?.contentHash,
      first.contextCache?.contentHash,
    );
    assert.include(userText, "Known coverage from prior agent reads");
    assert.include(userText, "source=zotero_metadata");
    assert.notInclude(stableText, "Known coverage from prior agent reads");
  });
});
