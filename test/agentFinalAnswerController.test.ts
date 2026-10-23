import { assert } from "chai";
import { AgentFinalAnswerController } from "../src/agent/finalization/finalAnswerController";
import {
  applyOutcomeEvidence,
  declareOutcomes,
} from "../src/agent/loop/outcomes";
import { createEmptyExecutionCheckpoint } from "../src/agent/execution/checkpoint";
import type {
  AgentRuntimeRequest,
  ExecutionCheckpoint,
} from "../src/agent/types";

function makeRequest(
  overrides: Partial<AgentRuntimeRequest> = {},
): AgentRuntimeRequest {
  return {
    conversationKey: 1,
    mode: "agent",
    userText: "Answer the question",
    model: "test-model",
    turnPaperScope: {
      active: [],
      added: [],
      pinned: [],
      selected: [],
      collections: [],
      tags: [],
    },
    ...overrides,
  } as AgentRuntimeRequest;
}

describe("AgentFinalAnswerController", function () {
  for (const canCorrect of [true, false]) {
    it(`accepts the first grounded paper answer with canCorrect=${canCorrect}`, async function () {
      const controller = new AgentFinalAnswerController(
        makeRequest({ conversationKind: "paper" }),
      );
      const decision = await controller.evaluate({
        candidateText:
          "The paper reports 0.80 intact and 0.52 shuffled accuracy. It supplies neither a class count nor a chance baseline.",
        canCorrect,
        toolExecutionRecords: [{ name: "paper_read", ok: true }],
      });
      assert.equal(decision.kind, "accept");
    });
  }

  it("accepts completed paper actions and finalized documents", async function () {
    const controller = new AgentFinalAnswerController(
      makeRequest({ conversationKind: "paper" }),
    );
    const result = await controller.evaluate({
      candidateText: "Saved.",
      canCorrect: true,
      toolExecutionRecords: [
        { name: "paper_read", ok: true },
        { name: "submit_document", ok: true },
      ],
    });
    assert.equal(result.kind, "accept");
  });

  it("does not invent action obligations for a fresh direct turn", async function () {
    const controller = new AgentFinalAnswerController(
      makeRequest({
        executionContext: {
          version: 1,
          executionId: "direct-1",
          conversationKey: 1,
          conversationGeneration: 0,
          chatLibraryID: 1,
          permissionOwner: "original_agent",
          workspaceSnapshot: {
            selectedPapers: [],
            selectedCollections: [],
          },
          configuredAccess: { libraryIDs: [1], outputDirectories: [] },
        },
      }),
    );

    const decision = await controller.evaluate({
      candidateText: "Here is the answer.",
      canCorrect: true,
      toolExecutionRecords: [],
    });

    assert.equal(decision.kind, "accept");
  });

  it("fails a direct applied write whose concrete effect is unverified", async function () {
    const controller = new AgentFinalAnswerController(makeRequest());

    const decision = await controller.evaluate({
      candidateText: "Saved.",
      canCorrect: false,
      toolExecutionRecords: [
        {
          name: "library_mutation",
          ok: true,
          mutability: "write",
          effect: "applied",
          actionReceipts: [],
        },
      ],
    });

    assert.deepEqual(decision, {
      kind: "fail",
      userMessage:
        "library_mutation ran, but its concrete effect could not be verified. Inspect current state before retrying it.",
    });
  });

  /**
   * The two values the final gate treats differently, pinned side by side.
   *
   * `unverified` means a re-read was possible and did not confirm the effect,
   * so the turn cannot claim it. `execution_only` means there is no state to
   * re-read at all — a shell command — and failing every such turn would make
   * `run_command` unusable while proving nothing. Phase 3 keeps that split
   * deliberately, so changing it has to change this test.
   */
  for (const scenario of [
    {
      verification: "unverified" as const,
      expected: "fail" as const,
      why: "a re-read was possible and did not confirm the effect",
    },
    {
      verification: "execution_only" as const,
      expected: "accept" as const,
      why: "a shell command leaves no state to re-read",
    },
  ]) {
    it(`${scenario.expected}s an applied write whose receipt is ${scenario.verification} because ${scenario.why}`, async function () {
      const controller = new AgentFinalAnswerController(makeRequest());

      const decision = await controller.evaluate({
        candidateText: "Ran it.",
        canCorrect: false,
        toolExecutionRecords: [
          {
            name: "run_command",
            ok: true,
            mutability: "write",
            effect: "applied",
            actionReceipts: [
              {
                verification: scenario.verification,
                status: "observed",
              },
            ],
          } as never,
        ],
      });

      assert.equal(decision.kind, scenario.expected);
    });
  }
  it("returns a clean assistant copy for a web-attribution correction", async function () {
    const controller = new AgentFinalAnswerController(makeRequest());

    const decision = await controller.evaluate({
      candidateText: "An unsupported current claim.",
      canCorrect: true,
      toolExecutionRecords: [
        { name: "web_search", ok: true, content: { results: [] } },
      ],
    });

    assert.equal(decision.kind, "correct");
    if (decision.kind !== "correct") return;
    assert.equal(decision.assistantContent, "An unsupported current claim.");
    assert.include(decision.correction, "Correct the web attribution");
  });

  it("preserves the first answer when an attribution retry returns no text", async function () {
    const controller = new AgentFinalAnswerController(makeRequest());
    const toolExecutionRecords = [
      { name: "web_search", ok: true, content: { results: [] } },
    ];

    const first = await controller.evaluate({
      candidateText: "The original answer.",
      canCorrect: true,
      toolExecutionRecords,
    });
    assert.equal(first.kind, "correct");

    const retry = await controller.evaluate({
      candidateText: "",
      canCorrect: true,
      toolExecutionRecords,
    });

    assert.equal(retry.kind, "fail");
    if (retry.kind !== "fail") return;
    assert.include(retry.userMessage, "The original answer.");
    assert.include(retry.userMessage, "not source-verified");
  });
});

describe("AgentFinalAnswerController declared outcomes", function () {
  const execution: NonNullable<AgentRuntimeRequest["executionContext"]> = {
    version: 1,
    executionId: "execution-gate",
    conversationKey: 1,
    conversationGeneration: 0,
    permissionOwner: "original_agent",
    workspaceSnapshot: { selectedPapers: [], selectedCollections: [] },
    configuredAccess: { libraryIDs: [1], outputDirectories: [] },
  };
  const SAVE = "Save it as a note on (Smith, 2021)";

  function declared(): ExecutionCheckpoint {
    return declareOutcomes(
      createEmptyExecutionCheckpoint(execution, 1),
      [
        {
          taskId: "save",
          description: SAVE,
          effect: "mutation",
          capability: "zotero.notes",
        },
        { taskId: "tag", description: "Tag it", effect: "mutation" },
        { taskId: "explain", description: "Explain it", effect: "answer" },
      ],
      2,
    );
  }

  async function decide(
    controller: AgentFinalAnswerController,
    canCorrect = true,
  ) {
    return controller.evaluate({
      candidateText: "Saved.",
      canCorrect,
      toolExecutionRecords: [],
    });
  }

  it("asks to finish the declared parts still open, quoting each", async function () {
    const controller = new AgentFinalAnswerController(
      makeRequest({
        executionContext: execution,
        executionCheckpoint: declared(),
      }),
    );
    const decision = await decide(controller);
    assert.equal(decision.kind, "correct");
    if (decision.kind !== "correct") return;
    assert.equal(
      decision.correction,
      `Before answering, finish the parts of this request you declared that are still open: “${SAVE}”; “Tag it”. Do them now with the tools. If one cannot be done, list it under task_update's skipped or blocked with the reason, then answer.`,
    );
  });

  it("corrects again only after new evidence since the last correction", async function () {
    const request = makeRequest({
      executionContext: execution,
      executionCheckpoint: declared(),
    });
    const controller = new AgentFinalAnswerController(request);
    assert.equal((await decide(controller)).kind, "correct");
    assert.equal(
      (await decide(controller)).kind,
      "accept",
      "nothing moved, so the answer is accepted",
    );
    request.executionCheckpoint = applyOutcomeEvidence(
      request.executionCheckpoint!,
      {
        kind: "receipt",
        receipt: {
          version: 2,
          id: "receipt-tags",
          proposalId: "proposal-tags",
          proofDomain: "zotero_state",
          capability: "zotero.tags",
          operation: "apply_tags",
          verification: "verified",
          status: "applied",
          requestedTargets: ["item:1"],
          appliedTargets: ["item:1"],
          alreadySatisfiedTargets: [],
          rejectedTargets: [],
          reasons: [],
          verifiedFacts: [],
        },
      },
      3,
    ).checkpoint;
    const again = await decide(controller);
    assert.equal(again.kind, "correct", "the tags receipt is new evidence");
    if (again.kind !== "correct") return;
    assert.include(again.correction, `“${SAVE}”`);
    assert.notInclude(again.correction, "“Tag it”");
  });

  it("never corrects for an answer part, or when it cannot correct", async function () {
    const answerOnly = declareOutcomes(
      createEmptyExecutionCheckpoint(execution, 1),
      [{ taskId: "explain", description: "Explain it", effect: "answer" }],
      2,
    );
    for (const [request, canCorrect] of [
      [
        makeRequest({
          executionContext: execution,
          executionCheckpoint: answerOnly,
        }),
        true,
      ],
      [
        makeRequest({
          executionContext: execution,
          executionCheckpoint: declared(),
        }),
        false,
      ],
    ] as const) {
      const controller = new AgentFinalAnswerController(request);
      assert.equal((await decide(controller, canCorrect)).kind, "accept");
    }
  });
});
