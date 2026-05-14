import { assert } from "chai";
import {
  buildAgentResourceContextPlan,
  buildAgentResourceSignatureFromSnapshot,
  buildAgentResourceSnapshot,
  clearAgentReadLedger,
  clearAgentResourceLifecycleState,
  commitAgentResourceContextPlan,
  diffAgentResourceSnapshots,
  resolveAgentResourceLifecycleState,
} from "../src/agent/context/resourceLifecycle";
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

async function renderedUserMessage(
  req: AgentRuntimeRequest,
  plan = buildAgentResourceContextPlan(req),
): Promise<string> {
  const messages = await buildAgentInitialMessages(req, [], [], plan);
  return messageText(messages[messages.length - 1]);
}

describe("agent resource lifecycle", function () {
  beforeEach(function () {
    clearAgentResourceLifecycleState();
    clearAgentReadLedger();
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
        resourceSignature:
          buildAgentResourceSignatureFromSnapshot(changedBase),
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
    const text = await renderedUserMessage(req, plan);

    assert.equal(plan.lifecycleState, "setup-required");
    assert.equal(plan.injection, "full");
    assert.include(text, "Current Zotero context summary:");
    assert.include(text, "Retrieval-only paper refs:");
    assert.include(text, "Baseline Paper");
    assert.include(text, "User request:\nWhat should I do next?");
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
    assert.include(text, "Zotero resource update for this continued agent turn");
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
});
