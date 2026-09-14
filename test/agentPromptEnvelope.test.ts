import { assert } from "chai";
import {
  buildAgentInitialMessages,
  composeAgentModelInput,
  renderAgentPromptEnvelope,
} from "../src/agent/model/messageBuilder";
import type { PlanExecutionLedger } from "../src/agent/plans/types";
import { COVERAGE_DISCLOSURE_REQUIREMENT } from "../src/agent/documents/draftValidation";
import type { AgentModelMessage } from "../src/agent/types";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";
import { classifiedFixture, semanticFixture } from "./helpers/semanticIntent";

function messageText(message: AgentModelMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

describe("agent prompt envelope", function () {
  it("tells the model that host-verifiable research and document tasks advance without task_update", async function () {
    const ledger: PlanExecutionLedger = {
      version: 1,
      executionId: "execution-host-owned",
      planId: "plan-host-owned",
      revision: 1,
      planDigest: "sha256:host-owned",
      conversationKey: 705,
      attempt: 1,
      provider: "original",
      grant: {
        version: 1,
        planId: "plan-host-owned",
        revision: 1,
        planDigest: "sha256:host-owned",
        conversationKey: 705,
        conversationGeneration: 1,
        approvedAt: 1,
      },
      status: "running",
      activeTaskId: "read",
      tasks: [
        {
          version: 2,
          taskId: "read",
          executionId: "execution-host-owned",
          planStepId: "s1",
          kind: "required_step",
          content: "Read every paper",
          activeForm: "Reading every paper",
          acceptanceCriteria: [],
          expectedEffect: "read",
          completionRequirements: [
            {
              requirementId: "read:verified",
              kind: "verified_read",
              criterionIds: [],
              contractDigest: "sha256:host-owned",
            },
          ],
          obligationIds: [],
          status: "in_progress",
          attemptCount: 1,
          evidenceIds: [],
          failureReasons: [],
          createdAt: 1,
          updatedAt: 1,
        },
        {
          version: 2,
          taskId: "document",
          executionId: "execution-host-owned",
          planStepId: "s2",
          kind: "required_step",
          content: "Publish the review",
          activeForm: "Publishing the review",
          acceptanceCriteria: [],
          expectedEffect: "artifact",
          completionRequirements: [
            {
              requirementId: "document:integrity",
              kind: "document_integrity",
              criterionIds: [],
              contractDigest: "sha256:host-owned",
            },
            {
              requirementId: "document:published",
              kind: "document_published",
              criterionIds: [],
              contractDigest: "sha256:host-owned",
            },
          ],
          obligationIds: [],
          status: "pending",
          attemptCount: 0,
          evidenceIds: [],
          failureReasons: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      createdAt: 1,
      updatedAt: 1,
    };
    const request = resolvedAgentRequest({
      conversationKey: 705,
      mode: "agent",
      userText: "Execute the approved review",
      model: "test-model",
      planContext: {
        phase: "executing",
        planId: ledger.planId,
        revision: ledger.revision,
        executionId: ledger.executionId,
        approvedDigest: ledger.planDigest,
        provider: "original",
      },
      metadata: { planExecutionLedger: ledger },
    });

    const messages = await buildAgentInitialMessages(request, [], []);
    const prompt = messages.map(messageText).join("\n");
    assert.include(prompt, "Do not call task_update for these tasks");
    assert.include(
      prompt,
      "verified reads, mutation receipts, and finalized material",
    );
    assert.notInclude(
      prompt,
      "After evidence exists, call task_update with only the task",
    );
  });

  it("keeps host-owned execution identities out of the final answer", async function () {
    const ledger: PlanExecutionLedger = {
      version: 1,
      executionId: "execution-secret",
      planId: "plan-secret",
      revision: 1,
      planDigest: "sha256:secret",
      conversationKey: 703,
      attempt: 1,
      provider: "original",
      grant: {
        version: 1,
        planId: "plan-secret",
        revision: 1,
        planDigest: "sha256:secret",
        conversationKey: 703,
        conversationGeneration: 1,
        approvedAt: 1,
      },
      status: "running",
      tasks: [],
      createdAt: 1,
      updatedAt: 1,
    };
    const request = resolvedAgentRequest({
      conversationKey: 703,
      mode: "agent",
      userText: "Execute the approved plan",
      model: "test-model",
      planContext: {
        phase: "executing",
        planId: ledger.planId,
        revision: ledger.revision,
        executionId: ledger.executionId,
        approvedDigest: ledger.planDigest,
        provider: "original",
      },
      metadata: { planExecutionLedger: ledger },
    });

    const messages = await buildAgentInitialMessages(request, [], []);
    const prompt = messages.map(messageText).join("\n");
    assert.include(
      prompt,
      "Your final answer should answer the original request naturally",
    );
    assert.include(prompt, "Do not expose plan IDs");
    assert.include(prompt, "the host renders progress separately");
  });

  it("exposes the exact approved document contract during execution", async function () {
    const ledger: PlanExecutionLedger = {
      version: 1,
      executionId: "execution-document",
      planId: "plan-document",
      revision: 1,
      planDigest: "sha256:document",
      conversationKey: 704,
      attempt: 1,
      provider: "original",
      grant: {
        version: 1,
        planId: "plan-document",
        revision: 1,
        planDigest: "sha256:document",
        conversationKey: 704,
        conversationGeneration: 1,
        approvedAt: 1,
      },
      status: "running",
      tasks: [],
      createdAt: 1,
      updatedAt: 1,
    };
    const request = resolvedAgentRequest({
      conversationKey: 704,
      mode: "agent",
      userText: "Execute the approved plan",
      model: "test-model",
      planContext: {
        phase: "executing",
        planId: ledger.planId,
        revision: ledger.revision,
        executionId: ledger.executionId,
        approvedDigest: ledger.planDigest,
        provider: "original",
      },
      metadata: {
        planExecutionLedger: ledger,
        approvedPlanContract: {
          deliverable: {
            kind: "document",
            spec: {
              kind: "literature_review",
              title: "Exact approved review title",
              requiredSections: ["Findings", "Scope and limitations"],
              requiresReferences: true,
              requiresCoverageSection: true,
              allowFigures: false,
              citationStyle: {
                styleId: "apa",
                styleTitle: "APA",
                locale: "en-US",
              },
            },
          },
        },
      },
    });
    const messages = await buildAgentInitialMessages(request, [], []);
    const prompt = messages.map(messageText).join("\n");
    assert.include(prompt, "Exact title: Exact approved review title");
    assert.include(
      prompt,
      "Required sections: Findings; Scope and limitations",
    );
    assert.include(prompt, "submit_document.title must match");
    assert.include(prompt, COVERAGE_DISCLOSURE_REQUIREMENT);
    assert.notInclude(prompt, "Coverage section required");
  });

  it("lets the approved investigation own reading guidance instead of the chat turn rule", async function () {
    const ledger: PlanExecutionLedger = {
      version: 1,
      executionId: "execution-investigation",
      planId: "plan-investigation",
      revision: 1,
      planDigest: "sha256:investigation",
      conversationKey: 706,
      attempt: 1,
      provider: "original",
      grant: {
        version: 1,
        planId: "plan-investigation",
        revision: 1,
        planDigest: "sha256:investigation",
        conversationKey: 706,
        conversationGeneration: 1,
        approvedAt: 1,
      },
      status: "running",
      tasks: [],
      createdAt: 1,
      updatedAt: 1,
    };
    const request = resolvedAgentRequest({
      conversationKey: 706,
      mode: "agent",
      userText: "Execute the approved plan",
      model: "test-model",
      planContext: {
        phase: "executing",
        planId: ledger.planId,
        revision: ledger.revision,
        executionId: ledger.executionId,
        approvedDigest: ledger.planDigest,
        provider: "original",
      },
      classifiedIntent: classifiedFixture({
        semantic: semanticFixture({
          reading: { source: "document_text", coverage: "targeted" },
        }),
      }),
      metadata: {
        planExecutionLedger: ledger,
        approvedPlanContract: {
          deliverable: { kind: "answer" },
          investigation: {
            question: "How is belief updating modeled?",
            subquestions: [],
            criteria: [],
            reviewMode: "narrative",
            readingStrategy: "adaptive",
            scopeAmendmentPolicy: "fixed",
            scope: { libraryID: 1, kind: "items", itemKeys: ["AAAA1111"] },
            requiredEvidenceDepth: "body",
            estimatedDeepReadPapers: 0,
            approvedLargeCorpus: false,
          },
        },
      },
    });
    const messages = await buildAgentInitialMessages(request, [], []);
    const prompt = messages.map(messageText).join("\n");
    assert.notInclude(prompt, "TURN RULE");
    assert.notInclude(prompt, "The shared reading intent requires");
    assert.include(
      prompt,
      "Reading guidance (owned by the approved investigation)",
    );
    assert.include(
      prompt,
      "narrative review, adaptive reading, body evidence depth",
    );
    assert.include(prompt, "paper_read mode 'overview'");
    assert.include(prompt, "No per-turn read budget applies");
  });

  it("distinguishes omitted transcript history from an explicit empty override", async function () {
    const request = resolvedAgentRequest({
      conversationKey: 701,
      mode: "agent",
      userText: "Current request",
      model: "test-model",
      history: [
        { role: "user", content: "Prior user message" },
        { role: "assistant", content: "Prior assistant message" },
      ],
    });

    const derivedHistory = await buildAgentInitialMessages(request, [], []);
    const noHistory = await buildAgentInitialMessages(
      request,
      [],
      [],
      undefined,
      { transcriptMessages: [] },
    );

    assert.include(JSON.stringify(derivedHistory), "Prior user message");
    assert.notInclude(JSON.stringify(noHistory), "Prior user message");
    assert.notInclude(JSON.stringify(noHistory), "Prior assistant message");
    assert.include(JSON.stringify(noHistory), "Current request");
  });

  it("freezes the rendered turn and composes fresh ordered message values", async function () {
    const request = resolvedAgentRequest({
      conversationKey: 702,
      mode: "agent",
      userText: "Inspect the supplied image",
      model: "test-model",
      systemPrompt: "SYSTEM_SENTINEL",
      customInstructions: "CUSTOM_SENTINEL",
      screenshots: ["data:image/png;base64,ZmFrZQ=="],
    });
    const rendered = await renderAgentPromptEnvelope(
      request,
      [],
      [],
      undefined,
      {
        contentInputs: {
          images: true,
          pdfDocuments: false,
          nativeFiles: false,
        },
      },
    );
    const transcript: AgentModelMessage[] = [
      { role: "assistant", content: "Prior answer" },
    ];
    const checkpoint: AgentModelMessage = {
      role: "user",
      content: "Agent semantic continuation checkpoint: continue safely.",
    };

    const first = composeAgentModelInput(rendered.envelope, {
      transcriptMessages: transcript,
      postTurnMessages: [checkpoint],
    });
    request.systemPrompt = "CHANGED_SYSTEM";
    request.customInstructions = "CHANGED_CUSTOM";
    request.userText = "Changed request";
    request.screenshots![0] = "data:image/png;base64,Y2hhbmdlZA==";
    const second = composeAgentModelInput(rendered.envelope, {
      transcriptMessages: transcript,
      postTurnMessages: [checkpoint],
    });

    assert.deepEqual(second, first);
    assert.notStrictEqual(second, first);
    for (let index = 0; index < first.length; index += 1) {
      assert.notStrictEqual(second[index], first[index]);
    }
    const turnIndex = first.length - 2;
    assert.equal(first[turnIndex - 1].role, "assistant");
    assert.equal(first[turnIndex].role, "user");
    assert.equal(first.at(-1)?.role, "user");
    assert.include(messageText(first[0]), "SYSTEM_SENTINEL");
    assert.include(messageText(first[0]), "CUSTOM_SENTINEL");
    assert.include(messageText(first[turnIndex]), "Inspect the supplied image");
    assert.equal(
      typeof first[turnIndex].content === "string"
        ? ""
        : first[turnIndex].content.find((part) => part.type === "image_url")
            ?.type,
      "image_url",
    );
    assert.include(
      messageText(first.at(-1)!),
      "Agent semantic continuation checkpoint",
    );

    if (typeof first[turnIndex].content !== "string") {
      const textPart = first[turnIndex].content.find(
        (part) => part.type === "text",
      );
      if (textPart?.type === "text") textPart.text = "Mutated composed copy";
    }
    const third = composeAgentModelInput(rendered.envelope);
    assert.include(messageText(third.at(-1)!), "Inspect the supplied image");
    assert.notInclude(messageText(third.at(-1)!), "Mutated composed copy");
  });

  describe("permission mode guidance", function () {
    const originalZotero = globalThis.Zotero;
    afterEach(function () {
      globalThis.Zotero = originalZotero;
    });

    function contentText(
      content: string | Array<{ type: string; text?: string }>,
    ) {
      return typeof content === "string"
        ? content
        : content
            .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
            .join("\n");
    }

    async function promptText(
      mode: "safe" | "auto" | "yolo",
      assumptions?: string[],
    ) {
      // Only the permission pref is stubbed; every other pref read stays undefined.
      globalThis.Zotero = {
        Prefs: {
          get: (key: string) =>
            key.endsWith("originalAgentPermissionMode") ? mode : undefined,
        },
      } as never;
      const request = resolvedAgentRequest({
        conversationKey: 9,
        mode: "agent",
        userText: "tidy this folder",
        classifiedIntent: classifiedFixture(),
        actionContract: {
          version: 4,
          id: "contract:mode",
          writeDisposition: "none",
          interpretationSource: "semantic",
          intent: classifiedFixture(),
          obligations: [],
          ...(assumptions ? { assumptions } : {}),
        },
      });
      const rendered = await renderAgentPromptEnvelope(request, [], []);
      return [
        ...rendered.envelope.systemMessages.map((message) =>
          contentText(message.content),
        ),
        contentText(rendered.envelope.turnMessage.content),
      ].join("\n");
    }

    it("tells the agent the current mode and how much to ask", async function () {
      const yolo = await promptText("yolo", ["Assumed append."]);
      assert.include(yolo, "Permission mode: yolo");
      assert.include(yolo, "Do not ask for confirmation or clarification");
      // The guidance must not read as unlimited authority: the rails that
      // still block in yolo belong in the same sentence.
      assert.include(yolo, "chat-only memory");
      assert.include(
        yolo,
        "importing discovered papers without the user's selection",
      );
      assert.include(yolo, "Interpretation assumptions: Assumed append.");
      const auto = await promptText("auto");
      assert.include(auto, "Permission mode: auto");
      assert.include(auto, "only for genuine ambiguity");
      const safe = await promptText("safe");
      assert.include(safe, "Permission mode: safe");
      assert.include(safe, "do not ask for permission in text");
      assert.notInclude(safe, "Interpretation assumptions");
    });
  });
});

describe("agent prompt envelope evidence sufficiency", function () {
  const paperContext = {
    itemId: 3928,
    contextItemId: 3931,
    title: "Variability and stability in visual processing",
  };
  function request(withAnchor: boolean) {
    return resolvedAgentRequest({
      conversationKey: 4102,
      mode: "agent",
      conversationKind: "paper",
      libraryID: 1,
      activeItemId: paperContext.itemId,
      selectedPaperContexts: [paperContext],
      userText: "can you explain this part of result to me?",
      model: "test-model",
      ...(withAnchor
        ? {
            selectedTextContexts: [
              {
                text: "Consistency in categorization of object category over longer time scales",
                source: "pdf" as const,
                paperContext,
                contextItemId: 3931,
                pageIndex: 5,
                pageLabel: "6",
              },
            ],
            resolvedSelectedTextAnchors: [
              {
                contextIndex: 0,
                contextItemId: 3931,
                pageIndex: 5,
                pageLabel: "6",
                paperContext,
                resolution: "chunks" as const,
                primaryChunkIndex: 41,
                preferredChunkIndexes: [40, 41, 42],
                contextText:
                  "Consistency in categorization of object category over longer time scales. We asked whether...",
                injectedChars: 100,
              },
            ],
          }
        : {}),
      classifiedIntent: classifiedFixture({
        semantic: semanticFixture({
          reading: { source: "document_text", coverage: "targeted" },
        }),
      }),
    });
  }

  it("renders held selection context as satisfying targeted coverage instead of mandating a read", async function () {
    const messages = await buildAgentInitialMessages(request(true), [], []);
    const prompt = messages.map(messageText).join("\n");
    assert.include(prompt, "Already held");
    assert.include(prompt, "selected text 1");
    assert.include(prompt, "only for a specific claim in your draft");
    assert.notInclude(prompt, "requires document_text evidence");
  });

  it("keeps the mandatory read rule when no evidence is held", async function () {
    const messages = await buildAgentInitialMessages(request(false), [], []);
    const prompt = messages.map(messageText).join("\n");
    assert.include(
      prompt,
      "requires document_text evidence at targeted coverage",
    );
    assert.notInclude(prompt, "Already held");
  });

  it("explains the answer_now retrieval state in the stable persona", async function () {
    const messages = await buildAgentInitialMessages(request(false), [], []);
    const prompt = messages.map(messageText).join("\n");
    assert.include(prompt, "answer_now");
    assert.include(prompt, "answer_or_self_check");
    assert.notInclude(
      prompt,
      "when unchanged, do not repeat the read and retrieve again only for a specifically named missing dimension",
    );
  });
});
