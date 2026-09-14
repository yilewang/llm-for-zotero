import { assert } from "chai";
import {
  assertTaskCompletionEvidence,
  assertTaskTransitionRequest,
} from "../src/agent/plans/coordinator";
import type {
  ExecutionTask,
  PlanExecutionLedger,
  TaskEvidence,
} from "../src/agent/plans/types";
import type { AgentActionReceipt } from "../src/agent/contracts/types";
import {
  buildReasoningAssertionEvidence,
  createTaskUpdateTool,
} from "../src/agent/tools/plan/taskUpdate";
import { hasApprovedFullReadAuthorization } from "../src/agent/tools/read/paperRead";
import type { AgentToolContext } from "../src/agent/types";

function task(overrides: Partial<ExecutionTask> = {}): ExecutionTask {
  return {
    version: 1,
    taskId: "execution-1:step-1",
    executionId: "execution-1",
    planStepId: "step-1",
    kind: "required_step",
    content: "Apply the approved metadata change",
    activeForm: "Applying the approved metadata change",
    acceptanceCriteria: ["The target is changed and re-read"],
    expectedEffect: "mutation",
    obligationIds: ["obligation-1"],
    status: "in_progress",
    attemptCount: 1,
    evidenceIds: [],
    failureReasons: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function ledger(tasks: ExecutionTask[]): PlanExecutionLedger {
  return {
    version: 1,
    executionId: "execution-1",
    planId: "plan-1",
    revision: 1,
    planDigest: "sha256:test",
    conversationKey: 1,
    attempt: 1,
    provider: "original",
    grant: {
      version: 1,
      planId: "plan-1",
      revision: 1,
      planDigest: "sha256:test",
      conversationKey: 1,
      conversationGeneration: 1,
      approvedAt: 1,
    },
    status: "running",
    tasks,
    createdAt: 1,
    updatedAt: 1,
  };
}

function receipt(
  verification: AgentActionReceipt["verification"],
): AgentActionReceipt {
  return {
    version: 2,
    id: `receipt-${verification}`,
    obligationId: "obligation-1",
    proposalId: "proposal-1",
    proofDomain: "zotero_state",
    capability: "library.metadata.update",
    operation: "metadata_update",
    verification,
    status: "applied",
    requestedTargets: ["1"],
    appliedTargets: ["1"],
    alreadySatisfiedTargets: [],
    rejectedTargets: [],
    reasons: [],
    verifiedFacts: verification === "verified" ? ["target 1 re-read"] : [],
  };
}

function evidence(
  kind: TaskEvidence["kind"],
  verified: boolean,
  actionReceipt?: AgentActionReceipt,
): TaskEvidence {
  return {
    version: 1,
    evidenceId: `evidence-${kind}-${verified}`,
    executionId: "execution-1",
    taskId: "execution-1:step-1",
    kind,
    verified,
    receipt: actionReceipt,
    createdAt: 2,
  };
}

describe("PlanExecutionCoordinator invariants", function () {
  it("ignores a surplus reasoning assertion when verified evidence owns completion", function () {
    const readTask = task({
      expectedEffect: "read",
      completionRequirements: [
        {
          requirementId: "read-requirement",
          kind: "verified_read",
          criterionIds: ["read-complete"],
          contractDigest: "sha256:test",
        },
      ],
    });

    assert.isUndefined(
      buildReasoningAssertionEvidence({
        executionId: "execution-1",
        task: readTask,
        status: "completed",
        assertion: "The requested reads are complete.",
        createdAt: 3,
      }),
      "surplus narrative must not become completion evidence",
    );
  });

  it("accepts exactly one task transition per committed call", function () {
    const validated = createTaskUpdateTool().validate({
      task: { taskId: "execution-1:step-1", status: "completed" },
    });
    assert.isTrue(validated.ok);
    if (validated.ok) {
      assert.equal(validated.value.task.taskId, "execution-1:step-1");
      assert.equal(validated.value.task.status, "completed");
    }
    assert.isFalse(
      createTaskUpdateTool().validate({
        tasks: [
          { taskId: "execution-1:step-1", status: "completed" },
          { taskId: "execution-1:step-2", status: "in_progress" },
        ],
      }).ok,
    );
  });

  it("carries approved exhaustive-read authority into the synthetic execution turn", function () {
    const request = {
      planContext: {
        phase: "executing",
        planId: "plan-1",
        revision: 1,
        executionId: "execution-1",
        approvedDigest: "sha256:test",
        provider: "original",
      },
      actionContract: {
        version: 2,
        id: "contract-1",
        writeDisposition: "none",
        interpretationSource: "classifier",
        obligations: [
          {
            id: "read-full-1",
            capability: "zotero.read",
            operation: "read_full",
            proofDomain: "zotero_state",
            coverage: "one",
            targetKind: "papers",
            constraints: { readMode: "full" },
          },
        ],
      },
    } as AgentToolContext["request"];
    assert.isTrue(hasApprovedFullReadAuthorization(request));
    assert.isFalse(
      hasApprovedFullReadAuthorization({
        ...request,
        planContext: {
          phase: "planning",
          planId: "plan-1",
          revision: 1,
          provider: "original",
        },
      }),
    );
  });

  it("rejects a model assertion and an unverified receipt for a mutation task", function () {
    const mutationTask = task();
    assert.throws(
      () =>
        assertTaskCompletionEvidence(mutationTask, [
          evidence("reasoning_assertion", true),
        ]),
      /verified receipt/,
    );
    assert.throws(
      () =>
        assertTaskCompletionEvidence(mutationTask, [
          evidence("mutation_receipt", false, receipt("execution_only")),
        ]),
      /verified receipt/,
    );
    assert.doesNotThrow(() =>
      assertTaskCompletionEvidence(mutationTask, [
        evidence("mutation_receipt", true, receipt("verified")),
      ]),
    );
  });

  it("does not let provider task updates skip an approved step", function () {
    const requiredTask = task({ status: "pending" });
    assert.throws(
      () =>
        assertTaskTransitionRequest({
          ledger: ledger([requiredTask]),
          task: requiredTask,
          request: {
            executionId: "execution-1",
            taskId: requiredTask.taskId,
            toStatus: "skipped",
            requestedBy: "claude",
          },
        }),
      /Only the user may skip/,
    );
  });

  it("allows at most one user-visible active task", function () {
    const active = task({ taskId: "active", status: "in_progress" });
    const pending = task({ taskId: "pending", status: "pending" });
    assert.throws(
      () =>
        assertTaskTransitionRequest({
          ledger: ledger([active, pending]),
          task: pending,
          request: {
            executionId: "execution-1",
            taskId: pending.taskId,
            toStatus: "in_progress",
            requestedBy: "original",
          },
        }),
      /Only one user-visible task/,
    );
  });

  it("does not accept reasoning evidence for a verifiable read task", function () {
    const readTask = task({ expectedEffect: "read" });
    assert.throws(
      () =>
        assertTaskCompletionEvidence(readTask, [
          evidence("reasoning_assertion", true),
        ]),
      /verified read evidence/,
    );
  });
});
