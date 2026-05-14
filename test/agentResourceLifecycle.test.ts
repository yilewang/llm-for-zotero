import { assert } from "chai";
import {
  buildAgentPriorReadContextBlock,
  buildAgentResourceContextPlan,
  buildAgentResourceSignatureFromSnapshot,
  buildAgentResourceSnapshot,
  clearAgentReadLedger,
  clearAgentResourceLifecycleState,
  commitAgentReadActivities,
  commitAgentResourceContextPlan,
  diffAgentResourceSnapshots,
  resolveAgentResourceLifecycleState,
} from "../src/agent/context/resourceLifecycle";
import {
  clearPersistedAgentEvidence,
  hydrateAgentEvidenceCache,
} from "../src/agent/context/cacheManagement";
import { buildAgentInitialMessages } from "../src/agent/model/messageBuilder";
import {
  clearAgentMemory,
  recordAgentTurn,
} from "../src/agent/store/conversationMemory";
import { parseSkill, setUserSkills } from "../src/agent/skills";
import type {
  AgentModelMessage,
  AgentRuntimeRequest,
  AgentToolDefinition,
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
    conversationKey: 101,
    mode: "agent",
    userText: "What should I do next?",
    activeItemId: 1,
    libraryID: 1,
    selectedPaperContexts: [paper(1, 10, "Baseline Paper")],
    ...overrides,
  };
}

function messageText(message: AgentModelMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

function installEvidenceMockDb() {
  type EvidenceRow = {
    conversationKey: number;
    evidenceKey: string;
    resourceSignature?: string;
    entryJson: string;
    firstSeenAt: number;
    lastSeenAt: number;
  };
  const rows = new Map<string, EvidenceRow>();
  const originalZotero = (
    globalThis as typeof globalThis & { Zotero?: unknown }
  ).Zotero;
  (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
    DB: {
      queryAsync: async (sql: string, params: unknown[] = []) => {
        if (!sql.includes("llm_for_zotero_agent_evidence")) return [];
        if (sql.includes("INSERT INTO")) {
          const conversationKey = Number(params[0]);
          const evidenceKey = String(params[1] || "");
          rows.set(`${conversationKey}:${evidenceKey}`, {
            conversationKey,
            evidenceKey,
            resourceSignature:
              typeof params[2] === "string" ? params[2] : undefined,
            entryJson: String(params[3] || ""),
            firstSeenAt: Number(params[4]) || 0,
            lastSeenAt: Number(params[5]) || 0,
          });
          return [];
        }
        if (sql.includes("SELECT entry_json AS entryJson")) {
          const conversationKey = Number(params[0]);
          const limit = Math.max(0, Number(params[1]) || rows.size);
          return Array.from(rows.values())
            .filter((row) => row.conversationKey === conversationKey)
            .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
            .slice(0, limit)
            .map((row) => ({
              entryJson: row.entryJson,
              resourceSignature: row.resourceSignature,
            }));
        }
        if (sql.includes("DELETE FROM")) {
          if (sql.includes("evidence_key NOT IN")) return [];
          if (sql.includes("WHERE conversation_key = ?")) {
            const conversationKey = Number(params[0]);
            for (const key of Array.from(rows.keys())) {
              if (rows.get(key)?.conversationKey === conversationKey) {
                rows.delete(key);
              }
            }
          } else {
            rows.clear();
          }
          return [];
        }
        return [];
      },
    },
  };
  return () => {
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
      originalZotero;
  };
}

async function renderedUserMessage(
  req: AgentRuntimeRequest,
  plan = buildAgentResourceContextPlan(req),
): Promise<string> {
  const messages = await buildAgentInitialMessages(req, [], [], plan);
  return messageText(messages[messages.length - 1]);
}

async function renderedInitialMessages(
  req: AgentRuntimeRequest,
  plan = buildAgentResourceContextPlan(req),
): Promise<AgentModelMessage[]> {
  return buildAgentInitialMessages(req, [], [], plan);
}

function stableSystemText(messages: AgentModelMessage[]): string {
  const message = messages.find(
    (entry) => entry.role === "system" && entry.cachePolicy === "stable-prefix",
  );
  return message ? messageText(message) : "";
}

function allSystemText(messages: AgentModelMessage[]): string {
  return messages
    .filter((message) => message.role === "system")
    .map(messageText)
    .join("\n\n");
}

describe("agent resource lifecycle", function () {
  beforeEach(async function () {
    clearAgentResourceLifecycleState();
    clearAgentReadLedger();
    await clearAgentMemory(101);
    await clearAgentMemory(202);
  });

  it("builds deterministic resource signatures", function () {
    const first = buildAgentResourceSnapshot(
      request({
        selectedPaperContexts: [
          paper(2, 20, "Second Paper"),
          paper(1, 10, "First Paper"),
        ],
        selectedCollectionContexts: [
          { collectionId: 9, libraryID: 1, name: "Z" },
          { collectionId: 3, libraryID: 1, name: "A" },
        ],
      }),
    );
    const second = buildAgentResourceSnapshot(
      request({
        selectedPaperContexts: [
          paper(1, 10, "First Paper"),
          paper(2, 20, "Second Paper"),
        ],
        selectedCollectionContexts: [
          { collectionId: 3, libraryID: 1, name: "A" },
          { collectionId: 9, libraryID: 1, name: "Z" },
        ],
      }),
    );

    assert.equal(
      buildAgentResourceSignatureFromSnapshot(first),
      buildAgentResourceSignatureFromSnapshot(second),
    );
  });

  it("diffs added, removed, changed, and unchanged resources", function () {
    const previous = buildAgentResourceSnapshot(
      request({
        selectedPaperContexts: [
          paper(1, 10, "Original Title"),
          paper(2, 20, "Removed Paper"),
        ],
      }),
    );
    const current = buildAgentResourceSnapshot(
      request({
        selectedPaperContexts: [
          paper(1, 10, "Updated Title"),
          paper(3, 30, "Added Paper"),
        ],
      }),
    );

    const delta = diffAgentResourceSnapshots({ previous, current });

    assert.equal(delta.added.length, 1);
    assert.equal(delta.removed.length, 1);
    assert.equal(delta.changed.length, 1);
    assert.equal(delta.unchanged, 0);
    assert.include(delta.added[0].line, "Added Paper");
    assert.include(delta.removed[0].line, "Removed Paper");
    assert.include(delta.changed[0].line, "Updated Title");
  });

  it("resolves lifecycle states conservatively", function () {
    const initial = buildAgentResourceSnapshot(request());
    const initialSignature = buildAgentResourceSignatureFromSnapshot(initial);
    const lifecycleEntry = {
      resourceSnapshot: initial,
      resourceSignature: initialSignature,
      lastCompletedAt: 1,
    };

    assert.equal(
      resolveAgentResourceLifecycleState({
        resourceSnapshot: initial,
        resourceSignature: initialSignature,
      }),
      "setup-required",
    );
    assert.equal(
      resolveAgentResourceLifecycleState({
        lifecycleEntry,
        resourceSnapshot: initial,
        resourceSignature: initialSignature,
      }),
      "thin-followup",
    );

    const changedPaper = buildAgentResourceSnapshot({
      ...request(),
      selectedPaperContexts: [paper(2, 20, "Another Paper")],
    });
    assert.equal(
      resolveAgentResourceLifecycleState({
        lifecycleEntry,
        resourceSnapshot: changedPaper,
        resourceSignature:
          buildAgentResourceSignatureFromSnapshot(changedPaper),
      }),
      "resources-delta",
    );

    const changedBase = buildAgentResourceSnapshot(
      request({ activeItemId: 999 }),
    );
    assert.equal(
      resolveAgentResourceLifecycleState({
        lifecycleEntry,
        resourceSnapshot: changedBase,
        resourceSignature: buildAgentResourceSignatureFromSnapshot(changedBase),
      }),
      "resources-changed",
    );
    assert.equal(
      resolveAgentResourceLifecycleState({
        lifecycleEntry,
        resourceSnapshot: initial,
        resourceSignature: initialSignature,
        forcedSkillIds: ["write-note"],
      }),
      "resources-changed",
    );

    const fullTextChanged = buildAgentResourceSnapshot(
      request({ fullTextPaperContexts: [paper(3, 30, "Full Text")] }),
    );
    assert.equal(
      resolveAgentResourceLifecycleState({
        lifecycleEntry,
        resourceSnapshot: fullTextChanged,
        resourceSignature:
          buildAgentResourceSignatureFromSnapshot(fullTextChanged),
      }),
      "resources-changed",
    );
  });

  it("renders full context on first turns", async function () {
    const req = request();
    const plan = buildAgentResourceContextPlan(req);
    const messages = await renderedInitialMessages(req, plan);
    const stableText = stableSystemText(messages);
    const userText = messageText(messages[messages.length - 1]);

    assert.equal(plan.lifecycleState, "setup-required");
    assert.equal(plan.injection, "full");
    assert.include(stableText, "Stable Zotero resource context:");
    assert.include(stableText, "Current Zotero context summary:");
    assert.include(stableText, "Retrieval-only paper refs:");
    assert.include(stableText, "Baseline Paper");
    assert.notInclude(userText, "Retrieval-only paper refs:");
    assert.include(userText, "User request:\nWhat should I do next?");
  });

  it("places stable resource context before volatile history and current guidance", async function () {
    const req = request({
      userText: "Current volatile request",
      history: [
        { role: "user", content: "Older volatile question" },
        { role: "assistant", content: "Older volatile answer" },
      ],
    });
    const guidedTool: AgentToolDefinition<unknown, unknown> = {
      spec: {
        name: "guided_tool",
        description: "guided test tool",
        inputSchema: { type: "object" },
        mutability: "read",
        requiresConfirmation: false,
      },
      guidance: {
        matches: () => true,
        instruction: "Current-turn volatile guidance.",
      },
      validate: () => ({ ok: true, value: {} }),
      execute: async () => ({}),
    };

    const messages = await buildAgentInitialMessages(
      req,
      [guidedTool],
      [],
      buildAgentResourceContextPlan(req),
    );

    assert.equal(messages[0].role, "system");
    assert.equal(messages[1].role, "system");
    assert.equal(messages[1].cachePolicy, "stable-prefix");
    assert.include(messageText(messages[1]), "Baseline Paper");
    assert.equal(messages[2].role, "user");
    assert.include(messageText(messages[2]), "Older volatile question");
    assert.equal(messages[messages.length - 1].role, "user");
    assert.include(
      messageText(messages[messages.length - 1]),
      "Current-turn volatile guidance.",
    );
    assert.notInclude(
      allSystemText(messages),
      "Current-turn volatile guidance",
    );
  });

  it("renders thin context for same-resource follow-ups", async function () {
    const req = request();
    const first = buildAgentResourceContextPlan(req);
    commitAgentResourceContextPlan(first);

    const second = buildAgentResourceContextPlan({
      ...req,
      userText: "Now summarize the implication.",
    });
    const text = await renderedUserMessage(
      { ...req, userText: "Now summarize the implication." },
      second,
    );

    assert.equal(second.lifecycleState, "thin-followup");
    assert.equal(second.injection, "thin");
    assert.include(text, "same Zotero resources");
    assert.notInclude(text, "Retrieval-only paper refs:");
    assert.include(text, "User request:\nNow summarize the implication.");
  });

  it("renders delta context for selected paper and collection changes", async function () {
    const firstReq = request({
      selectedCollectionContexts: [
        { collectionId: 1, libraryID: 1, name: "Old Collection" },
      ],
    });
    commitAgentResourceContextPlan(buildAgentResourceContextPlan(firstReq));

    const secondReq = request({
      selectedPaperContexts: [paper(2, 20, "New Paper")],
      selectedCollectionContexts: [
        { collectionId: 2, libraryID: 1, name: "New Collection" },
      ],
    });
    const second = buildAgentResourceContextPlan(secondReq);
    const text = await renderedUserMessage(secondReq, second);

    assert.equal(second.lifecycleState, "resources-delta");
    assert.equal(second.injection, "delta");
    assert.include(
      text,
      "Zotero resource update for this continued agent turn",
    );
    assert.include(text, "New Paper");
    assert.include(text, "Old Collection");
    assert.include(text, "New Collection");
  });

  it("forces full injection for contentful resources", function () {
    const cases: Array<Partial<AgentRuntimeRequest>> = [
      { selectedTexts: ["quoted text"] },
      {
        activeNoteContext: {
          noteId: 1,
          title: "Note",
          noteKind: "item",
          noteText: "Body",
        },
      },
      { screenshots: ["data:image/png;base64,abc"] },
      {
        attachments: [
          {
            id: "a1",
            name: "paper.pdf",
            mimeType: "application/pdf",
            sizeBytes: 10,
            category: "pdf",
            storedPath: "/tmp/paper.pdf",
          },
        ],
      },
      { fullTextPaperContexts: [paper(9, 90, "Full Text Paper")] },
    ];

    for (const override of cases) {
      clearAgentResourceLifecycleState();
      const initialReq = request(override);
      commitAgentResourceContextPlan(buildAgentResourceContextPlan(initialReq));
      const followup = buildAgentResourceContextPlan({
        ...initialReq,
        userText: "follow up",
      });
      assert.equal(followup.lifecycleState, "thin-followup");
      assert.equal(followup.injection, "full");
    }
  });

  it("uses thin follow-ups for repeated full-text resources when prompt cache is available", async function () {
    const initialReq = request({
      model: "gpt-5.4",
      apiBase: "https://api.openai.com/v1/responses",
      providerProtocol: "responses_api",
      fullTextPaperContexts: [paper(9, 90, "Full Text Paper")],
    });
    commitAgentResourceContextPlan(buildAgentResourceContextPlan(initialReq));

    const followupReq = {
      ...initialReq,
      userText: "Now compare the implication.",
    };
    const followup = buildAgentResourceContextPlan(followupReq);
    const text = await renderedUserMessage(followupReq, followup);

    assert.equal(followup.lifecycleState, "thin-followup");
    assert.equal(followup.injection, "thin");
    assert.include(text, "same Zotero resources");
    assert.notInclude(text, "Full-text paper refs for this turn:");
  });

  it("preserves paper_read evidence snippets for cache-friendly follow-ups", async function () {
    const req = request({
      conversationKey: 202,
      model: "gpt-5.4",
      apiBase: "https://api.openai.com/v1/responses",
      providerProtocol: "responses_api",
      selectedPaperContexts: [paper(1, 10, "Baseline Paper")],
    });
    await commitAgentReadActivities({
      conversationKey: req.conversationKey,
      activities: [
        {
          toolName: "paper_read",
          toolLabel: "Read Paper",
          input: {
            mode: "targeted",
            query: "What is the key mechanism?",
            target: { itemId: 1, contextItemId: 10, title: "Baseline Paper" },
          },
          content: {
            mode: "targeted",
            papers: [
              {
                paperContext: paper(1, 10, "Baseline Paper"),
                sourceKind: "paper_text",
                passages: [
                  {
                    text: "The intervention selectively changed the readout while preserving the measured evidence.",
                    sourceLabel: "(Smith, 2024)",
                    citationLabel: "Smith, 2024",
                    sectionLabel: "Results",
                    pageLabel: "p. 4",
                    chunkIndex: 2,
                  },
                ],
              },
            ],
            results: [],
          },
          request: req,
          timestamp: 1,
        },
      ],
    });

    const block = buildAgentPriorReadContextBlock({
      conversationKey: req.conversationKey,
    });
    assert.include(block, "Preserved evidence from prior agent tool reads");
    assert.include(block, "Baseline Paper");
    assert.include(block, "source=(Smith, 2024)");
    assert.include(block, "intervention selectively changed");

    const plan = buildAgentResourceContextPlan(req);
    const text = await renderedUserMessage(req, plan);
    assert.include(text, "Preserved evidence from prior agent tool reads");
    assert.include(text, "intervention selectively changed");
    assert.isAbove(plan.contextCache?.contextTokens || 0, 0);
  });

  it("keeps conversation memory and skill guidance out of the system prompt", async function () {
    const req = request({
      conversationKey: 101,
      userText: "Summarize this paper",
    });
    await recordAgentTurn(
      req.conversationKey,
      "Earlier question",
      ["paper_read"],
      "Earlier answer",
    );

    setUserSkills([
      parseSkill(
        [
          "---",
          "id: simple-paper-qa",
          "description: test skill",
          "---",
          "Use one paper_read overview before answering.",
        ].join("\n"),
      ),
    ]);
    const guidedTool: AgentToolDefinition<unknown, unknown> = {
      spec: {
        name: "guided_tool",
        description: "guided test tool",
        inputSchema: { type: "object" },
        mutability: "read",
        requiresConfirmation: false,
      },
      guidance: {
        matches: () => true,
        instruction: "Use the mock guided tool only for this test.",
      },
      validate: () => ({ ok: true, value: {} }),
      execute: async () => ({}),
    };
    let messages!: AgentModelMessage[];
    try {
      messages = await buildAgentInitialMessages(
        req,
        [guidedTool],
        ["simple-paper-qa"],
        buildAgentResourceContextPlan(req),
      );
    } finally {
      setUserSkills([]);
    }
    const systemText = allSystemText(messages);
    const userText = messageText(messages[messages.length - 1]);

    assert.notInclude(systemText, "Conversation continuity notes");
    assert.notInclude(systemText, "Skill guidance loaded for this turn");
    assert.notInclude(systemText, "mock guided tool");
    assert.include(userText, "Conversation continuity notes");
    assert.include(userText, "Skill guidance loaded for this turn");
    assert.include(userText, "Use one paper_read overview before answering.");
    assert.include(userText, "Use the mock guided tool only for this test.");
    assert.include(userText, "Current-turn dynamic agent guidance");
  });

  it("keys prompt-cache planning to stable resources instead of evidence or history", async function () {
    const manyPapers = Array.from({ length: 70 }, (_, index) =>
      paper(
        1000 + index,
        2000 + index,
        `Stable cache paper ${index} with a deliberately long title for token threshold ${"context ".repeat(
          8,
        )}`,
      ),
    );
    const req = request({
      conversationKey: 505,
      model: "gpt-5.4",
      apiBase: "https://api.openai.com/v1/responses",
      providerProtocol: "responses_api",
      selectedPaperContexts: manyPapers,
      userText: "First volatile question",
      history: [{ role: "user", content: "old history" }],
    });
    const first = buildAgentResourceContextPlan(req);
    assert.isTrue(first.contextCache?.enabled);
    assert.isAbove(first.contextCache?.contextTokens || 0, 1024);

    await commitAgentReadActivities({
      conversationKey: req.conversationKey,
      resourceSignature: first.resourceSignature,
      activities: [
        {
          toolName: "paper_read",
          toolLabel: "Read Paper",
          input: {
            mode: "targeted",
            query: "volatile evidence",
            target: {
              itemId: manyPapers[0].itemId,
              contextItemId: manyPapers[0].contextItemId,
              title: manyPapers[0].title,
            },
          },
          content: {
            mode: "targeted",
            papers: [
              {
                paperContext: manyPapers[0],
                passages: [
                  { text: "New evidence should not re-key resources." },
                ],
              },
            ],
          },
          request: req,
          timestamp: 4,
        },
      ],
    });

    const second = buildAgentResourceContextPlan({
      ...req,
      userText: "Second volatile question",
      history: [{ role: "user", content: "different history" }],
    });

    assert.equal(second.stableContextBlock, first.stableContextBlock);
    assert.equal(
      second.contextCache?.contentHash,
      first.contextCache?.contentHash,
    );
    assert.include(
      second.priorReadBlock || "",
      "New evidence should not re-key",
    );
  });

  it("persists, hydrates, and filters evidence snippets by resource scope", async function () {
    const restoreDb = installEvidenceMockDb();
    try {
      const req = request({
        conversationKey: 303,
        selectedPaperContexts: [paper(1, 10, "Persisted Paper")],
      });
      const signature = buildAgentResourceContextPlan(req).resourceSignature;
      await clearPersistedAgentEvidence(req.conversationKey);
      await commitAgentReadActivities({
        conversationKey: req.conversationKey,
        resourceSignature: signature,
        activities: [
          {
            toolName: "paper_read",
            toolLabel: "Read Paper",
            input: {
              mode: "targeted",
              query: "persistent evidence",
              target: {
                itemId: 1,
                contextItemId: 10,
                title: "Persisted Paper",
              },
            },
            content: {
              mode: "targeted",
              papers: [
                {
                  paperContext: paper(1, 10, "Persisted Paper"),
                  sourceKind: "paper_text",
                  passages: [
                    {
                      text: "Persisted evidence survives a plugin restart.",
                      sourceLabel: "(Persisted, 2024)",
                      sectionLabel: "Discussion",
                      pageLabel: "p. 9",
                    },
                  ],
                },
              ],
            },
            request: req,
            timestamp: 2,
          },
        ],
      });

      clearAgentReadLedger();
      await hydrateAgentEvidenceCache(req.conversationKey);
      const hydrated = buildAgentPriorReadContextBlock({
        conversationKey: req.conversationKey,
        request: req,
        resourceSignature: signature,
      });
      assert.include(hydrated, "Persisted Paper");
      assert.include(hydrated, "Persisted evidence survives");
      assert.include(hydrated, "source=(Persisted, 2024)");
      assert.include(hydrated, "section=Discussion");
      assert.include(hydrated, "page=p. 9");

      const staleReq = request({
        conversationKey: req.conversationKey,
        activeItemId: 2,
        selectedPaperContexts: [paper(2, 20, "Different Paper")],
      });
      const staleSignature =
        buildAgentResourceContextPlan(staleReq).resourceSignature;
      const stale = buildAgentPriorReadContextBlock({
        conversationKey: req.conversationKey,
        request: staleReq,
        resourceSignature: staleSignature,
      });
      assert.notInclude(stale, "Persisted evidence survives");
    } finally {
      restoreDb();
      clearAgentReadLedger();
    }
  });

  it("filters untargeted evidence by resource signature", async function () {
    const req = request({
      conversationKey: 404,
      activeItemId: undefined,
      selectedPaperContexts: [],
    });
    await commitAgentReadActivities({
      conversationKey: req.conversationKey,
      resourceSignature: "resource-a",
      activities: [
        {
          toolName: "read_attachment",
          toolLabel: "Read Attachment",
          input: {},
          content: { text: "Untargeted attachment evidence" },
          request: req,
          timestamp: 3,
        },
      ],
    });

    const matching = buildAgentPriorReadContextBlock({
      conversationKey: req.conversationKey,
      resourceSignature: "resource-a",
    });
    assert.include(matching, "Untargeted attachment evidence");

    const mismatched = buildAgentPriorReadContextBlock({
      conversationKey: req.conversationKey,
      resourceSignature: "resource-b",
    });
    assert.notInclude(mismatched, "Untargeted attachment evidence");
  });
});
