import { attachPlanMaterialEvidence } from "../src/agent/plans/materialEvidence";
import {
  semanticContractFixture,
  classifiedFixture,
} from "./helpers/semanticIntent";
import type { ActionConstraint } from "../src/agent/authorization/types";
const noExecution: ActionConstraint[] = [
  {
    kind: "deny_mechanisms",
    mechanisms: ["shell", "zotero_script"],
    description: "Do not execute commands or scripts.",
  },
];
const noZoteroWrites: ActionConstraint = {
  kind: "deny_effects",
  domains: ["zotero_library"],
  effects: ["create", "modify", "delete"],
  description: "Do not modify Zotero.",
};
const noExternalWrites: ActionConstraint = {
  kind: "deny_effects",
  domains: ["filesystem"],
  effects: ["create", "modify", "delete"],
  description: "Do not write external files.",
};
import {
  createNativeLifecycleTestProcess,
  installDirectPathTestPrefs,
} from "./helpers/codexNativeLifecycle";
import { runCodexAppServerNativeTurn } from "./helpers/preparedNativeTurn";
import {
  CodexAppServerProcess,
  destroyCachedCodexAppServerProcess,
} from "../src/utils/codexAppServerProcess";
import {
  registerMcpServer,
  unregisterMcpServer,
  invokeRegisteredZoteroMcpEndpoint,
  buildZoteroMcpConfigValue,
  resolveConversationScopeToken,
  registerScopedZoteroMcpScope,
} from "../src/agent/mcp/server";
import { getCodexProfileSignature } from "../src/codexAppServer/constants";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { createUpdatePlanTool } from "../src/agent/tools/plan/updatePlan";
import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import { PlanExecutionCoordinator } from "../src/agent/plans/coordinator";
import { deliverPendingPlanDocumentMessage } from "../src/agent/documents/publication";
import {
  initPlanDocumentStore,
  loadPlanDocumentOutbox,
  savePlanDocumentInTransaction,
} from "../src/agent/documents/store";
import type {
  PlanDocument,
  PlanDocumentOutboxRecord,
} from "../src/agent/documents/types";
import {
  initAgentPlanStore,
  loadPlanExecutionLedger,
  savePlanExecutionLedger,
  saveTaskEvidence,
} from "../src/agent/plans/store";
import type {
  ExecutionTask,
  PlanExecutionLedger,
  TaskEvidence,
} from "../src/agent/plans/types";
import { takePendingPlanExecution } from "../src/modules/contextPanel/planModeState";
import { PlanExecutionRunSession } from "../src/agent/plans/runSession";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";
import { createPreparePlanExecutionTool } from "../src/agent/tools/plan/preparePlanExecution";
import { finalizeNativePlanProposal } from "../src/agent/plans/nativePlanning";
import { loadPlanArtifact } from "../src/agent/plans/store";
import { initResearchStore } from "../src/agent/research/store";
import { createCodexNativeActivityTraceControllerForTests } from "../src/modules/contextPanel/chat";
import {
  initAgentTraceStore,
  getAgentRunTrace,
} from "../src/agent/store/traceStore";
import type { Message } from "../src/modules/contextPanel/types";
import { ensureConversationKeyLedgerEntry } from "../src/shared/conversationKeyLedger";

const globalScope = globalThis as typeof globalThis & { Zotero?: unknown };

function reasoningTask(): ExecutionTask {
  return {
    version: 2,
    taskId: "execution-1:task-1",
    executionId: "execution-1",
    planStepId: "step-1",
    kind: "required_step",
    content: "Synthesize the evidence",
    activeForm: "Synthesizing the evidence",
    acceptanceCriteria: [
      {
        criterionId: "criterion-1",
        description: "A bounded conclusion is recorded",
        verifier: "bounded_reasoning",
      },
    ],
    expectedEffect: "reasoning",
    completionRequirements: [
      {
        requirementId: "requirement-1",
        kind: "bounded_reasoning",
        criterionIds: ["criterion-1"],
        contractDigest: "sha256:contract",
      },
    ],
    obligationIds: [],
    status: "in_progress",
    attemptCount: 1,
    evidenceIds: [],
    failureReasons: [],
    createdAt: 1,
    updatedAt: 1,
    startedAt: 1,
  };
}

function execution(): PlanExecutionLedger {
  return {
    version: 2,
    executionId: "execution-1",
    planId: "plan-1",
    revision: 1,
    planDigest: "sha256:plan",
    conversationKey: 41,
    attempt: 1,
    provider: "original",
    grant: {
      version: 1,
      planId: "plan-1",
      revision: 1,
      planDigest: "sha256:plan",
      conversationKey: 41,
      conversationGeneration: 1,
      approvedAt: 1,
    },
    status: "running",
    activeTaskId: "execution-1:task-1",
    tasks: [reasoningTask()],
    createdAt: 1,
    updatedAt: 1,
  };
}

function reasoningEvidence(): TaskEvidence {
  return {
    version: 3,
    evidenceId: "evidence-1",
    executionId: "execution-1",
    taskId: "execution-1:task-1",
    kind: "reasoning_assertion",
    verified: true,
    requirementId: "requirement-1",
    criterionIds: ["criterion-1"],
    contractDigest: "sha256:contract",
    payload: {
      type: "bounded_reasoning",
      assertion: "The evidence supports the bounded conclusion.",
    },
    summary: "The evidence supports the bounded conclusion.",
    createdAt: 2,
  };
}

function hostVerifiedResearchExecution(): PlanExecutionLedger {
  const makeTask = (params: {
    suffix: string;
    content: string;
    status: ExecutionTask["status"];
    requirementKind:
      | "verified_read"
      | "research_coverage"
      | "document_integrity";
  }): ExecutionTask => ({
    version: 2,
    taskId: `execution-1:task-${params.suffix}`,
    executionId: "execution-1",
    planStepId: `step-${params.suffix}`,
    kind: "required_step",
    content: params.content,
    activeForm: params.content,
    acceptanceCriteria: [
      {
        criterionId: `criterion-${params.suffix}`,
        description: params.content,
        verifier: params.requirementKind,
      },
    ],
    expectedEffect:
      params.requirementKind === "document_integrity" ? "artifact" : "read",
    completionRequirements: [
      {
        requirementId: `requirement-${params.suffix}`,
        kind: params.requirementKind,
        criterionIds: [`criterion-${params.suffix}`],
        contractDigest: "sha256:contract",
      },
    ],
    obligationIds: [],
    status: params.status,
    attemptCount: params.status === "in_progress" ? 1 : 0,
    evidenceIds: [],
    failureReasons: [],
    createdAt: 1,
    updatedAt: 1,
    startedAt: params.status === "in_progress" ? 1 : undefined,
  });
  return {
    ...execution(),
    activeTaskId: "execution-1:task-1",
    tasks: [
      makeTask({
        suffix: "1",
        content: "Understand every paper",
        status: "in_progress",
        requirementKind: "verified_read",
      }),
      makeTask({
        suffix: "2",
        content: "Synthesize relationships",
        status: "pending",
        requirementKind: "research_coverage",
      }),
      makeTask({
        suffix: "3",
        content: "Publish the document",
        status: "pending",
        requirementKind: "document_integrity",
      }),
    ],
  };
}

function hostVerifiedResearchEvidence(): TaskEvidence[] {
  return [
    {
      version: 3,
      evidenceId: "evidence-read",
      executionId: "execution-1",
      taskId: "execution-1:task-1",
      kind: "verified_read",
      verified: true,
      requirementId: "requirement-1",
      criterionIds: ["criterion-1"],
      contractDigest: "sha256:contract",
      payload: {
        type: "verified_read",
        reference: "read-1",
        observations: [
          {
            version: 1,
            observationId: "observation-1",
            issuer: "zotero_host",
            toolName: "paper_read",
            callDigest: "sha256:call",
            inputDigest: "sha256:input",
            resultDigest: "sha256:result",
            libraryID: 1,
            itemKey: "AAAA1111",
            capabilities: ["body"],
            certificateDigest: "sha256:certificate",
          },
        ],
      },
      createdAt: 2,
    },
    {
      version: 3,
      evidenceId: "evidence-coverage",
      executionId: "execution-1",
      taskId: "execution-1:task-2",
      kind: "research_coverage",
      verified: true,
      requirementId: "requirement-2",
      criterionIds: ["criterion-2"],
      contractDigest: "sha256:contract",
      payload: {
        type: "research_coverage",
        researchJobId: "research-1",
        coverageStatus: "complete",
        totalItems: 1,
        screenedItems: 1,
        candidateItems: 1,
        deepReadCompleted: 1,
      },
      createdAt: 3,
    },
  ];
}

function documentExecution(): PlanExecutionLedger {
  const taskId = "execution-1:task-document";
  return {
    ...execution(),
    activeTaskId: taskId,
    tasks: [
      {
        ...reasoningTask(),
        taskId,
        planStepId: "step-document",
        content: "Publish the document",
        activeForm: "Publishing the document",
        acceptanceCriteria: [
          {
            criterionId: "criterion-document",
            description: "The document is validated and published",
            verifier: "document_published",
          },
        ],
        expectedEffect: "artifact",
        completionRequirements: [
          {
            requirementId: "requirement-integrity",
            kind: "document_integrity",
            criterionIds: ["criterion-document"],
            contractDigest: "sha256:contract",
          },
          {
            requirementId: "requirement-published",
            kind: "document_published",
            criterionIds: ["criterion-document"],
            contractDigest: "sha256:contract",
          },
        ],
        evidenceIds: [],
      },
    ],
  };
}

function plannedDocument(): {
  document: PlanDocument;
  outbox: PlanDocumentOutboxRecord;
} {
  const visibleMarkdown = "# Report\n\nComplete.";
  const document: PlanDocument = {
    version: 2,
    documentId: "document-1",
    documentVersion: 1,
    documentKind: "report",
    integrityPolicy: "authored",
    origin: {
      kind: "planned",
      planId: "plan-1",
      planRevision: 1,
      executionId: "execution-1",
      parentTaskId: "execution-1:task-document",
      contractDigest: "sha256:contract",
    },
    conversationKey: 41,
    title: "Report",
    visibleMarkdown,
    visibleHtml: "<h1>Report</h1><p>Complete.</p>",
    citationBundle: {
      clusters: [],
      bibliographyEntries: [],
      style: { id: "apa", title: "APA" },
      locale: "en-US",
    },
    verifiedQuotes: [],
    assets: [],
    coverageItems: [],
    validation: {
      integrityValidated: true,
      groundingReviewed: "not_run",
      quoteVerified: "not_applicable",
      issues: [],
    },
    contentHash: "sha256:document",
    createdAt: 2,
  };
  return {
    document,
    outbox: {
      version: 1,
      outboxId: "document-1:message",
      documentId: document.documentId,
      conversationKey: document.conversationKey,
      messageTimestamp: 2,
      visibleMarkdown,
      status: "pending",
      attemptCount: 0,
      createdAt: 2,
      updatedAt: 2,
    },
  };
}

function documentIntegrityEvidence(): TaskEvidence {
  return {
    version: 3,
    evidenceId: "document-1:integrity",
    executionId: "execution-1",
    taskId: "execution-1:task-document",
    kind: "document_integrity",
    verified: true,
    requirementId: "requirement-integrity",
    criterionIds: ["criterion-document"],
    contractDigest: "sha256:contract",
    payload: {
      type: "document_integrity",
      documentId: "document-1",
      contentHash: "sha256:document",
      integrityValidated: true,
    },
    summary: "Document integrity validated",
    createdAt: 2,
  };
}

describe("transactional Plan task transitions", function () {
  let originalZotero: unknown;
  let db: DatabaseSync;
  let failTransitionInsert = false;

  before(function () {
    originalZotero = globalScope.Zotero;
  });

  it("rejects a native mutation handoff when the request has no frozen write obligations", async function () {
    const request = resolvedAgentRequest({
      conversationKey: 41,
      userText:
        'Native batch acceptance D. Add the tag "codex-native-plan-20260906" to exactly Zotero items 3900, 3920, and 3930 in library 1. Preserve every existing tag, note, attachment, and collection membership. Plan this first for review. Do not modify any other items. Do not write external files. Do not execute commands or scripts.',
      planContext: {
        phase: "planning",
        provider: "codex",
        planId: "empty-native-mutation",
        revision: 1,
        nativePlanning: {
          attemptId: "attempt",
          threadId: "thread",
          turnId: "turn",
          ephemeral: false,
        },
      },
    });
    // A missing semantic interpretation cannot be replaced by a native proposal.
    assert.isUndefined(request.classifiedIntent);
    request.actionContract = {
      version: 3,
      id: "unresolved-request",
      writeDisposition: "none",
      interpretationSource: "deterministic_fallback",
      obligations: [],
      hardConstraints: [noExternalWrites, ...noExecution],
    };
    const tool = createPreparePlanExecutionTool();
    const input = tool.validate({
      contract: {
        deliverable: { kind: "completion_report" },
        effects: { libraryMutation: { approval: "initial" } },
      },
      steps: [
        {
          content: "Add and verify the requested tag on the three exact items",
          activeForm: "Adding and verifying tags",
          expectedEffect: "mutation",
          acceptanceCriteria: [
            {
              criterionId: "tag-receipts",
              description: "Each exact item has a verified tag receipt",
              verifier: "mutation_receipts",
            },
          ],
        },
      ],
    });
    assert.isTrue(input.ok);
    if (!input.ok) return;
    let failure: unknown;
    try {
      await tool.execute(input.value, { request, runId: "turn" } as any);
    } catch (error) {
      failure = error;
    }
    assert.instanceOf(failure, Error);
    assert.include((failure as Error).message, "frozen write obligations");
    assert.isNull(await loadPlanArtifact("empty-native-mutation", 1));
  });

  it("retains an unchanged typed mutation scope across native proposal-only revisions", async function () {
    const initialRequest = resolvedAgentRequest({
      conversationKey: 41,
      userText: 'Add the tag "review" to item 3900.',
      planContext: {
        phase: "planning",
        provider: "codex",
        planId: "native-tag-revision",
        revision: 1,
        nativePlanning: {
          attemptId: "first",
          threadId: "thread",
          turnId: "first",
          ephemeral: false,
        },
      },
      actionContract: {
        version: 3,
        id: "initial-tags",
        writeDisposition: "required",
        interpretationSource: "deterministic_fallback",
        obligations: [
          {
            id: "tag-obligation",
            operation: "apply_tags",
            capability: "zotero.tags",
            proofDomain: "zotero_state",
            coverage: "one",
            targetKind: "papers",
            scopeRole: "source",
            parameters: { tags: ["review"] },
            targetBoundary: {
              kind: "selection",
              libraryID: 1,
              frozenTargetIds: [3900],
              scopeDigest: "sha256:scope",
            },
          },
        ],
      },
    });
    const tool = createPreparePlanExecutionTool();
    const validated = tool.validate({
      contract: {
        deliverable: { kind: "completion_report" },
        effects: { libraryMutation: { approval: "initial" } },
      },
      steps: [
        {
          content: "Add the tag and verify its native receipt",
          activeForm: "Adding and verifying",
          expectedEffect: "mutation",
          acceptanceCriteria: [
            {
              criterionId: "tag",
              description: "The exact target has a verified tag receipt",
              verifier: "mutation_receipts",
            },
          ],
        },
      ],
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    await tool.execute(validated.value, {
      request: initialRequest,
      runId: "first",
    } as any);
    const original = (await loadPlanArtifact("native-tag-revision", 1))!;
    const constraints = noExecution;
    const revisionRequest = resolvedAgentRequest({
      ...initialRequest,
      userText:
        "Keep the same tag and target, but shorten the proposal. Do not execute commands or scripts.",
      planContext: {
        ...initialRequest.planContext!,
        phase: "planning",
        revision: 2,
        nativePlanning: {
          attemptId: "second",
          threadId: "thread",
          turnId: "second",
          ephemeral: false,
        },
      },
      actionContract: {
        version: 3,
        id: "feedback",
        writeDisposition: "none",
        interpretationSource: "deterministic_fallback",
        obligations: [],
        hardConstraints: constraints,
      },
    });
    await tool.execute({ ...validated.value, contract: original.contract }, {
      request: revisionRequest,
      runId: "second",
    } as any);
    const revised = (await loadPlanArtifact("native-tag-revision", 2))!;
    assert.deepEqual(
      revised.actionContract?.obligations,
      original.actionContract?.obligations,
    );
    assert.deepEqual(revised.actionContract?.hardConstraints, constraints);
    assert.equal(
      (await loadPlanArtifact("native-tag-revision", 1))?.status,
      "superseded",
    );
    // Removing the mutation from the typed proposal removes its old authority.
    await tool.execute(
      {
        ...validated.value,
        contract: { deliverable: { kind: "answer" } },
        steps: [
          {
            ...validated.value.steps[0],
            expectedEffect: "reasoning",
            acceptanceCriteria: [
              {
                criterionId: "explanation",
                description: "Explain the request",
                verifier: "bounded_reasoning",
              },
            ],
          },
        ],
      },
      { request: revisionRequest, runId: "second" } as any,
    );
    assert.isEmpty(
      (await loadPlanArtifact("native-tag-revision", 2))?.actionContract
        ?.obligations,
    );
  });

  it("stages native execution requirements and approves only the completed proposal", async function () {
    const nativePlanning = {
      attemptId: "attempt",
      threadId: "thread",
      turnId: "turn",
      ephemeral: false,
    };
    const plan = {
      phase: "planning" as const,
      provider: "codex" as const,
      planId: "native-plan",
      revision: 1,
      nativePlanning,
    };
    const tool = createPreparePlanExecutionTool();
    const validated = tool.validate({
      contract: { deliverable: { kind: "answer" } },
      steps: [
        {
          content: "Explain the result",
          activeForm: "Explaining the result",
          expectedEffect: "reasoning",
          acceptanceCriteria: [
            {
              criterionId: "answer",
              description: "A bounded explanation",
              verifier: "bounded_reasoning",
            },
          ],
        },
      ],
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    assert.isFalse(
      tool.validate({ ...validated.value, contract: undefined }).ok,
    );
    const cancelled = new AbortController();
    cancelled.abort();
    let cancelledError: unknown;
    try {
      await tool.execute(validated.value, {
        request: resolvedAgentRequest({
          conversationKey: 41,
          userText: "Plan an explanation",
          planContext: plan,
        }),
        runId: "turn",
        signal: cancelled.signal,
      } as any);
    } catch (error) {
      cancelledError = error;
    }
    assert.instanceOf(cancelledError, Error);
    assert.isNull(await loadPlanArtifact(plan.planId, 1));
    await tool.execute(validated.value, {
      request: resolvedAgentRequest({
        conversationKey: 41,
        userText: "Plan an explanation. Do not execute commands or scripts.",
        planContext: plan,
        actionContract: {
          version: 3,
          id: "native-no-execution",
          writeDisposition: "none",
          interpretationSource: "deterministic_fallback",
          obligations: [],
          hardConstraints: noExecution,
        },
      }),
      runId: "turn",
    } as any);
    const staged = await loadPlanArtifact(plan.planId, 1);
    assert.equal(staged?.status, "drafting");
    assert.deepEqual(staged?.actionContract?.hardConstraints, noExecution);
    let approvalError: unknown;
    try {
      await new PlanExecutionCoordinator().approve({
        planId: plan.planId,
        revision: 1,
        conversationGeneration: 1,
      });
    } catch (error) {
      approvalError = error;
    }
    assert.instanceOf(approvalError, Error);
    let staleError: unknown;
    try {
      await finalizeNativePlanProposal({
        plan,
        conversationKey: 41,
        proposal: {
          threadId: "wrong-thread",
          turnId: "turn",
          itemId: "proposal",
          text: "Wrong proposal",
        },
      });
    } catch (error) {
      staleError = error;
    }
    assert.instanceOf(staleError, Error);
    const ready = await finalizeNativePlanProposal({
      plan,
      conversationKey: 41,
      proposal: {
        threadId: "thread",
        turnId: "turn",
        itemId: "proposal",
        text: "# Exact native proposal",
      },
    });
    assert.equal(ready.status, "awaiting_approval");
    assert.notEqual(ready.digest, staged?.digest);
    let staleApprovalError: unknown;
    try {
      await new PlanExecutionCoordinator().approve({
        planId: plan.planId,
        revision: 1,
        conversationGeneration: 1,
        expectedDigest: staged!.digest,
      });
    } catch (error) {
      staleApprovalError = error;
    }
    assert.instanceOf(staleApprovalError, Error);
    assert.equal(
      (await loadPlanArtifact(plan.planId, 1))?.nativePlanning?.proposal
        ?.markdown,
      "# Exact native proposal",
    );
    const approvals = await Promise.allSettled(
      [1, 2].map(() =>
        new PlanExecutionCoordinator().approve({
          planId: plan.planId,
          revision: 1,
          expectedDigest: ready.digest,
          conversationGeneration: 1,
        }),
      ),
    );
    assert.equal(
      approvals.filter((result) => result.status === "fulfilled").length,
      1,
      "duplicate approval cannot create a second execution ledger",
    );
    const approvedResult = approvals.find(
      (result) => result.status === "fulfilled",
    );
    if (approvedResult?.status !== "fulfilled")
      throw new Error("Approval failed");
    const ledger = approvedResult.value;
    assert.equal(ledger.planDigest, ready.digest);
    assert.equal(ledger.providerContinuationId, "thread");
    let immutableError: unknown;
    try {
      await finalizeNativePlanProposal({
        plan,
        conversationKey: 41,
        proposal: {
          threadId: "thread",
          turnId: "turn",
          itemId: "different-proposal",
          text: "Changed after approval",
        },
      });
    } catch (error) {
      immutableError = error;
    }
    assert.instanceOf(immutableError, Error);
    assert.equal(
      (await loadPlanArtifact(plan.planId, 1))?.digest,
      ready.digest,
    );
  });

  beforeEach(async function () {
    failTransitionInsert = false;
    db = new DatabaseSync(":memory:");
    const bindable = (params: unknown[] | undefined) =>
      (params || []).map((value) => (value === undefined ? null : value));
    globalScope.Zotero = {
      DB: {
        queryAsync: async (sql: string, params?: unknown[]) => {
          if (
            failTransitionInsert &&
            sql.includes("INSERT INTO llm_for_zotero_plan_task_transitions")
          ) {
            throw new Error("injected transition write failure");
          }
          const statement = db.prepare(sql);
          const normalized = sql.trimStart().toUpperCase();
          if (
            normalized.startsWith("SELECT") ||
            normalized.startsWith("PRAGMA") ||
            normalized.startsWith("WITH")
          ) {
            return statement.all(...(bindable(params) as never[]));
          }
          statement.run(...(bindable(params) as never[]));
          return [];
        },
        executeTransaction: async (task: () => Promise<unknown>) => {
          db.exec("BEGIN");
          try {
            const result = await task();
            db.exec("COMMIT");
            return result;
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
        },
      },
    } as unknown as typeof Zotero;
    await initAgentPlanStore();
    await initPlanDocumentStore();
    await initResearchStore();
    await initAgentTraceStore();
    await savePlanExecutionLedger(execution());
  });

  it("ends planning at the persisted reviewable plan without a second approval question", async function () {
    const artifact = await new PlanExecutionCoordinator().updateDraft({
      planId: "ready-terminal",
      conversationKey: 41,
      provider: "original",
      revision: 1,
      ready: true,
      explanation: "Read the paper and explain it.",
      contract: { deliverable: { kind: "answer" } },
      steps: [
        {
          content: "Read the paper",
          activeForm: "Reading",
          expectedEffect: "read",
          acceptanceCriteria: [
            {
              criterionId: "read",
              description: "Read the paper body",
              verifier: "verified_read",
            },
          ],
        },
      ],
    });
    const tool = createUpdatePlanTool();
    const result = {
      callId: "ready",
      name: "update_plan",
      ok: true,
      actionReceipts: [],
      content: { artifact },
    };
    const terminal = await tool.resolveTerminalResult?.(
      { ready: true } as never,
      result,
      {} as never,
    );
    assert.isOk(
      terminal,
      "A persisted reviewable plan is a host-owned terminal result",
    );
    assert.include(terminal!.finalText, "Read the paper");
    assert.equal(terminal!.providerTranscript, "tool_only");
    assert.isNull(
      await tool.resolveTerminalResult?.(
        { ready: false } as never,
        result,
        {} as never,
      ),
    );
  });

  it("reloads a native proposal and retry context from its saved activity trace", async function () {
    await ensureConversationKeyLedgerEntry({
      conversationKey: 41,
      instanceID: "trace-instance",
      conversationID: "trace-conversation",
      system: "upstream",
      kind: "paper",
      profileSignature: "trace-profile",
      libraryID: 1,
      paperItemID: 41,
      issuedAt: 1,
    });
    const message: Message = {
      role: "assistant",
      text: "Ready for review",
      timestamp: Date.now(),
      runMode: "agent",
    };
    const trace = createCodexNativeActivityTraceControllerForTests(
      message,
      () => {},
    );
    trace.appendPlanEvent({
      type: "provider_event",
      providerType: "codex_plan_context",
      payload: {
        planContext: { phase: "planning", planId: "saved-native", revision: 1 },
      },
    });
    trace.appendAgentMessageDelta({
      itemId: "preview",
      delta: "Preview",
      phase: "commentary",
    } as any);
    await new Promise((resolve) => setTimeout(resolve, 2));
    trace.finish(message.text);
    await trace.persist(41, 0);
    assert.isString(message.agentRunId);
    const saved = await getAgentRunTrace(message.agentRunId!);
    assert.equal(saved.run?.status, "completed");
    assert.deepEqual(
      saved.events.map((e) => e.payload),
      message.pendingAgentTraceEvents!.map((e) => e.payload),
    );
    assert.equal(saved.events[0].payload.type, "provider_event");
    assert.deepEqual(
      saved.events.map((e) => e.createdAt),
      message.pendingAgentTraceEvents!.map((e) => e.createdAt),
      "Reload must retain native activity timing",
    );
    await trace.persist(41, 0);
    assert.equal(
      (await getAgentRunTrace(message.agentRunId!)).events.length,
      saved.events.length,
      "Repeated persistence must not duplicate trace events",
    );
    const cancelled: Message = {
      role: "assistant",
      text: "[Cancelled]",
      timestamp: message.timestamp + 1,
      runMode: "agent",
    };
    const cancelledTrace = createCodexNativeActivityTraceControllerForTests(
      cancelled,
      () => {},
    );
    cancelledTrace.appendPlanEvent({
      type: "provider_event",
      providerType: "codex_plan_context",
      payload: {
        planContext: { phase: "planning", planId: "saved-native", revision: 1 },
      },
    });
    const expected = cancelled.pendingAgentTraceEvents!.map((e) => e.payload);
    cancelled.pendingAgentTraceEvents = undefined;
    await cancelledTrace.persist(41, 0, "cancelled");
    const cancelledSaved = await getAgentRunTrace(cancelled.agentRunId!);
    assert.equal(cancelledSaved.run?.status, "cancelled");
    assert.deepEqual(
      cancelledSaved.events.map((e) => e.payload),
      expected,
      "Cancelling the visible stream must preserve native retry context",
    );
  });

  it("preserves typed restrictions when native feedback revises the explanation", async function () {
    const tool = createPreparePlanExecutionTool();
    const input = tool.validate({
      contract: { deliverable: { kind: "answer" } },
      steps: [
        {
          content: "Explain",
          activeForm: "Explaining",
          expectedEffect: "reasoning",
          acceptanceCriteria: [
            {
              criterionId: "answer",
              description: "Explain the example",
              verifier: "bounded_reasoning",
            },
          ],
        },
      ],
    });
    if (!input.ok) throw new Error(input.error);
    const restrictions = [noZoteroWrites, ...noExecution];
    for (const [attempt, revision] of [1, 1, 2].entries()) {
      await tool.execute(input.value, {
        runId: "turn",
        request: resolvedAgentRequest({
          conversationKey: 41,
          userText:
            revision === 1
              ? "Plan an explanation"
              : "Revise the numeric example and retain the restrictions",
          planContext: {
            phase: "planning",
            provider: "codex",
            planId: "restrictions",
            revision,
            nativePlanning: {
              attemptId: `attempt-${revision}`,
              threadId: "thread",
              turnId: `turn-${revision}`,
              ephemeral: false,
            },
          },
          actionContract: {
            version: 3,
            id: `action-${revision}`,
            writeDisposition: "none",
            interpretationSource: "deterministic_fallback",
            obligations: [],
            hardConstraints: attempt === 0 ? restrictions : [],
          },
        }),
      } as any);
    }
    assert.deepEqual(
      (await loadPlanArtifact("restrictions", 2))?.actionContract
        ?.hardConstraints,
      restrictions,
    );
    assert.deepEqual(
      (await loadPlanArtifact("restrictions", 1))?.actionContract
        ?.hardConstraints,
      restrictions,
    );
  });

  afterEach(function () {
    db.close();
    globalScope.Zotero = originalZotero;
  });

  it("runs native planning, revision, approval and resumed execution through the scoped MCP contract", async function () {
    this.timeout(15000);
    const requests: Array<{ method: string; params: Record<string, any> }> = [];
    const restorePrefs = installDirectPathTestPrefs(
      "off",
      ":danger-full-access",
    );
    const zotero = globalScope.Zotero as any;
    const oldGet = zotero.Prefs.get;
    const prefs = new Map<string, unknown>();
    zotero.Prefs.get = (key: string) =>
      key.endsWith(".codexAppServerZoteroMcpToolsEnabled")
        ? true
        : prefs.has(key)
          ? prefs.get(key)
          : oldGet(key);
    zotero.Prefs.set = (key: string, value: unknown) => prefs.set(key, value);
    zotero.Server = { Endpoints: {} };
    zotero.Libraries = { userLibraryID: 1 };
    zotero.Items = { get: () => null };
    const registry = new AgentToolRegistry();
    const prepareTool = createPreparePlanExecutionTool();
    const stagedContexts: Array<Parameters<typeof prepareTool.execute>[1]> = [];
    registry.register({
      ...prepareTool,
      execute: async (input, context) => {
        stagedContexts.push(context);
        return prepareTool.execute(input, context);
      },
    });
    registry.register(createUpdatePlanTool());
    for (const name of [
      "library_search",
      "library_read",
      "paper_read",
      "task_update",
    ])
      registry.register({
        spec: {
          name,
          description: name,
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          executionClass: "read",
        },
        validate: () => ({ ok: true, value: {} }),
        execute: async () => ({}),
      } as any);
    registerMcpServer({ toolRegistry: registry, zoteroGateway: {} as any });
    let nativeFailure: unknown;
    const callMcp = async (method: string, params: unknown) => {
      const response = await invokeRegisteredZoteroMcpEndpoint({
        method: "POST",
        data: { jsonrpc: "2.0", id: 1, method, params },
        headers: currentHeaders,
      });
      const body = JSON.parse(response?.[2] || "{}");
      if (body.error || body.result?.isError)
        throw new Error(JSON.stringify(body));
      return body.result;
    };
    let cachedToolNames: string[] | undefined;
    const refreshToolCatalog = async () => {
      const list = await callMcp("tools/list", {});
      cachedToolNames = list.tools.map((tool: any) => tool.name);
    };
    const proc = createNativeLifecycleTestProcess({
      newThreadIds: ["native-lifecycle"],
      onTurnBeforeResponse: true,
      onMcpReload: refreshToolCatalog,
      requests,
      permissionProfilesResult: {
        data: [
          { id: ":read-only", description: "Read only" },
          { id: ":danger-full-access", description: "Full access" },
        ],
      },
      onTurn: ({ threadId, turnId, turnNumber, emit }) => {
        void (async () => {
          try {
            if (!cachedToolNames) await refreshToolCatalog();
            if (turnNumber === 2) {
              assert.equal(
                (await loadPlanArtifact("native-lifecycle", 1))?.status,
                "superseded",
                "Starting a revision must invalidate the old review before new requirements arrive",
              );
            }
            if (turnNumber <= 2) {
              assert.include(cachedToolNames!, "prepare_plan_execution");
              assert.notInclude(cachedToolNames!, "task_update");
            } else {
              assert.notInclude(
                cachedToolNames!,
                "prepare_plan_execution",
                "The resumed thread must refresh its planning catalog before execution",
              );
              if (turnNumber <= 6)
                assert.include(cachedToolNames!, "task_update");
              else assert.notInclude(cachedToolNames!, "task_update");
            }
            if (turnNumber <= 2) {
              const tools = await callMcp("tools/list", {});
              assert.include(
                tools.tools.map((tool: any) => tool.name),
                "prepare_plan_execution",
              );
              assert.notInclude(
                tools.tools.map((tool: any) => tool.name),
                "update_plan",
              );
              emit({
                method: "turn/plan/updated",
                params: {
                  threadId,
                  turnId,
                  plan: [
                    {
                      step: "All checklist entries complete",
                      status: "completed",
                    },
                  ],
                },
              });
              emit({
                method: "item/plan/delta",
                params: {
                  threadId,
                  turnId,
                  itemId: "proposal",
                  delta: "Unapproved preview",
                },
              });
              await callMcp("tools/call", {
                name: "prepare_plan_execution",
                arguments: {
                  contract: { deliverable: { kind: "answer" } },
                  steps: [
                    {
                      content: "Explain the concept",
                      activeForm: "Explaining the concept",
                      expectedEffect: "reasoning",
                      acceptanceCriteria: [
                        {
                          criterionId: "answer",
                          description: "A bounded explanation",
                          verifier: "bounded_reasoning",
                        },
                      ],
                    },
                    {
                      content: "Check the requested caveat",
                      activeForm: "Checking the caveat",
                      expectedEffect: "reasoning",
                      acceptanceCriteria: [
                        {
                          criterionId: "caveat",
                          description: "The caveat is explained",
                          verifier: "bounded_reasoning",
                        },
                      ],
                    },
                  ],
                },
              });
              assert.equal(
                (await loadPlanArtifact("native-lifecycle", turnNumber))
                  ?.status,
                "drafting",
              );
              emit({
                method: "item/completed",
                params: {
                  threadId,
                  turnId,
                  item: {
                    type: "plan",
                    id: "proposal",
                    text: `# Proposal ${turnNumber}\n\nExplain the agreed concept.`,
                  },
                },
              });
            }
            emit({
              method: "turn/completed",
              params: { threadId, turn: { id: turnId, status: "completed" } },
            });
          } catch (error) {
            nativeFailure = error;
            emit({
              method: "turn/completed",
              params: { threadId, turn: { id: turnId, status: "failed" } },
            });
          }
        })();
      },
    });
    const originalSpawn = CodexAppServerProcess.spawn;
    CodexAppServerProcess.spawn = async () => proc;
    let sessionId: string | undefined;
    const base = {
      scope: { conversationKey: 41, libraryID: 1, kind: "global" as const },
      processKey: "native-plan-lifecycle",
      model: "gpt-5.6",
      reasoning: { effort: "high" } as any,
      messages: [{ role: "user" as const, content: "Plan an explanation" }],
      hooks: {
        loadProviderSessionId: async () => sessionId,
        persistProviderSessionId: async (id: string) => {
          sessionId = id;
        },
      },
    };
    const currentHeaders = buildZoteroMcpConfigValue({
      scopeToken: resolveConversationScopeToken({
        profileSignature: getCodexProfileSignature(),
        conversationKey: 41,
      }),
    }).http_headers as Record<string, string>;
    try {
      const first = await runCodexAppServerNativeTurn({
        ...base,
        planContext: {
          phase: "planning",
          planId: "native-lifecycle",
          revision: 1,
          provider: "codex",
        },
      });
      assert.equal(first.text, "# Proposal 1\n\nExplain the agreed concept.");
      const firstArtifact = await loadPlanArtifact("native-lifecycle", 1);
      assert.isTrue(
        stagedContexts[0].signal?.aborted,
        "finished native scopes invalidate pending contract preparation",
      );
      const second = await runCodexAppServerNativeTurn({
        ...base,
        planContext: {
          phase: "planning",
          planId: "native-lifecycle",
          revision: 2,
          provider: "codex",
        },
      });
      assert.equal(second.text, "# Proposal 2\n\nExplain the agreed concept.");
      assert.equal(
        (await loadPlanArtifact("native-lifecycle", 1))?.status,
        "superseded",
      );
      assert.equal(
        (await loadPlanArtifact("native-lifecycle", 1))?.digest,
        firstArtifact?.digest,
      );
      const artifact = (await loadPlanArtifact("native-lifecycle", 2))!;
      const ledger = await new PlanExecutionCoordinator().approve({
        planId: artifact.planId,
        revision: 2,
        conversationGeneration: 0,
        expectedDigest: artifact.digest,
      });
      const execution = {
        phase: "executing" as const,
        planId: ledger.planId,
        revision: ledger.revision,
        executionId: ledger.executionId,
        approvedDigest: ledger.planDigest,
        provider: "codex" as const,
      };
      const unfinished = await runCodexAppServerNativeTurn({
        ...base,
        planContext: execution,
      });
      assert.isString(
        unfinished.verificationFailure,
        "An incomplete native plan cannot claim completion",
      );
      assert.include(
        requests.filter((r) => r.method === "turn/start").at(-1)!.params
          .additionalContext?.zotero_plan?.value || "",
        ledger.tasks[1].taskId,
        "Each native execution turn must receive the saved task identities even when thread/resume keeps its original instructions",
      );
      await runCodexAppServerNativeTurn({ ...base, planContext: execution });
      await runCodexAppServerNativeTurn(base);
      assert.deepEqual(
        requests
          .filter((r) => r.method === "turn/start")
          .map((r) => r.params.collaborationMode.mode),
        ["plan", "plan", "default", "default", "default", "default", "default"],
      );
      assert.isAtLeast(
        requests.filter((r) => r.method === "thread/resume").length,
        3,
      );
      assert.equal(
        (await loadPlanExecutionLedger(ledger.executionId))?.planDigest,
        artifact.digest,
      );
      assert.equal(
        (await loadPlanArtifact("native-lifecycle", 2))?.nativePlanning
          ?.proposal?.markdown,
        second.text,
      );
    } catch (error) {
      throw nativeFailure || error;
    } finally {
      destroyCachedCodexAppServerProcess(base.processKey, proc);
      CodexAppServerProcess.spawn = originalSpawn;
      unregisterMcpServer();
      restorePrefs();
    }
  });

  it("resumes and interrupts an existing structured Codex plan without rewriting its proposal or digest", async function () {
    const coordinator = new PlanExecutionCoordinator();
    const artifact = await coordinator.updateDraft({
      planId: "structured-codex",
      conversationKey: 41,
      provider: "codex",
      revision: 1,
      explanation: "Original saved proposal",
      ready: true,
      contract: { deliverable: { kind: "answer" } },
      steps: [1, 2, 3].map((index) => ({
        content: `Explain part ${index}`,
        activeForm: `Explaining part ${index}`,
        expectedEffect: "reasoning" as const,
        acceptanceCriteria: [
          {
            criterionId: `criterion-${index}`,
            description: "A bounded explanation",
            verifier: "bounded_reasoning" as const,
          },
        ],
      })),
    });
    const ledger = await coordinator.approve({
      planId: artifact.planId,
      revision: 1,
      conversationGeneration: 0,
      providerContinuationId: "existing-structured-thread",
    });
    const restorePrefs = installDirectPathTestPrefs();
    const requests: Array<{ method: string; params: Record<string, any> }> = [];
    const proc = createNativeLifecycleTestProcess({
      newThreadIds: [],
      requests,
      onTurn: ({ threadId, turnId, emit }) => {
        emit({
          method: "turn/completed",
          params: { threadId, turn: { id: turnId, status: "interrupted" } },
        });
      },
    });
    const spawn = CodexAppServerProcess.spawn;
    CodexAppServerProcess.spawn = async () => proc;
    try {
      let failure: unknown;
      await runCodexAppServerNativeTurn({
        scope: { conversationKey: 41, libraryID: 1, kind: "global" },
        model: "gpt-5.6",
        processKey: "structured-plan-compatibility",
        messages: [{ role: "user", content: "Continue the approved plan" }],
        planContext: {
          phase: "executing",
          planId: artifact.planId,
          revision: 1,
          executionId: ledger.executionId,
          approvedDigest: ledger.planDigest,
          provider: "codex",
        },
        hooks: {
          loadProviderSessionId: async () => "existing-structured-thread",
          persistProviderSessionId: async () => {},
        },
      }).catch((error) => {
        failure = error;
      });
      assert.equal(
        (failure as Error)?.name,
        "AbortError",
        (failure as Error)?.message,
      );
      const interrupted = await loadPlanExecutionLedger(ledger.executionId);
      assert.equal(interrupted?.status, "interrupted");
      assert.equal(interrupted?.tasks[0].status, "interrupted");
      const turn = requests.find((request) => request.method === "turn/start")!;
      assert.include(
        turn.params.additionalContext.zotero_plan.value,
        ledger.tasks[1].taskId,
      );
      assert.equal(turn.params.collaborationMode.mode, "default");
      const saved = await loadPlanArtifact(artifact.planId, 1);
      assert.equal(saved?.explanation, artifact.explanation);
      assert.equal(saved?.digest, artifact.digest);
      assert.isUndefined(saved?.nativePlanning);
    } finally {
      destroyCachedCodexAppServerProcess("structured-plan-compatibility", proc);
      CodexAppServerProcess.spawn = spawn;
      restorePrefs();
    }
  });

  it("binds MCP document submission to the current durable task after research advances", async function () {
    await savePlanExecutionLedger(documentExecution());
    const restorePrefs = installDirectPathTestPrefs();
    const zotero = globalScope.Zotero as any;
    const originalGet = zotero.Prefs.get;
    const prefs = new Map<string, unknown>();
    zotero.Prefs.get = (key: string) =>
      prefs.has(key) ? prefs.get(key) : originalGet(key);
    zotero.Prefs.set = (key: string, value: unknown) => prefs.set(key, value);
    zotero.Server = { Endpoints: {} };
    zotero.Libraries = { userLibraryID: 1 };
    zotero.Items = { get: () => null };
    const registry = new AgentToolRegistry();
    let activeTaskId: string | undefined;
    registry.register({
      spec: {
        name: "submit_document",
        description: "Publish the document",
        executionClass: "read",
        inputSchema: { type: "object", properties: {} },
      },
      validate: () => ({ ok: true, value: {} }),
      execute: async (_input, context) => {
        activeTaskId =
          context.request.planContext?.phase === "executing"
            ? context.request.planContext.activeTaskId
            : undefined;
        return {};
      },
    });
    registerMcpServer({ toolRegistry: registry, zoteroGateway: {} as any });
    const scope = registerScopedZoteroMcpScope({
      conversationKey: 41,
      libraryID: 1,
      profileSignature: "plan-task-binding",
      runtimeAuthority: "codex",
      documentOutcomePolicy: { required: true } as any,
      planContext: {
        phase: "executing",
        planId: "plan-1",
        revision: 1,
        executionId: "execution-1",
        approvedDigest: "sha256:plan",
        provider: "codex",
        activeTaskId: "execution-1:task-1",
      },
    });
    try {
      const headers = buildZoteroMcpConfigValue({ scopeToken: scope.token })
        .http_headers as Record<string, string>;
      const result = await invokeRegisteredZoteroMcpEndpoint({
        method: "POST",
        headers,
        data: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "submit_document", arguments: {} },
        },
      });
      assert.equal(activeTaskId, "execution-1:task-document", result?.[2]);
    } finally {
      scope.clear();
      unregisterMcpServer();
      restorePrefs();
    }
  });

  it("commits bounded evidence and completion together", async function () {
    const coordinator = new PlanExecutionCoordinator();
    const updated = await coordinator.requestTransitionWithEvidence({
      request: {
        executionId: "execution-1",
        taskId: "execution-1:task-1",
        toStatus: "completed",
        requestedBy: "original",
      },
      evidence: reasoningEvidence(),
      now: 2,
    });

    assert.equal(updated.tasks[0].status, "completed");
    assert.deepEqual(updated.tasks[0].evidenceIds, ["evidence-1"]);
    assert.equal(
      Number(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM llm_for_zotero_plan_task_evidence",
          )
          .get()?.count,
      ),
      1,
    );
  });

  it("advances sequential host-verified research tasks without model bookkeeping", async function () {
    await savePlanExecutionLedger(hostVerifiedResearchExecution());
    for (const evidence of hostVerifiedResearchEvidence()) {
      await saveTaskEvidence(evidence);
    }

    const updated = await new PlanExecutionCoordinator().advanceVerifiedTasks({
      executionId: "execution-1",
      requirementKinds: ["verified_read", "research_coverage"],
      now: 4,
    });

    assert.deepEqual(
      updated.tasks.map((task) => task.status),
      ["completed", "completed", "in_progress"],
    );
    assert.equal(updated.activeTaskId, "execution-1:task-3");
  });

  it("refreshes the runtime active task after a same-run transition", async function () {
    const first = reasoningTask();
    const second: ExecutionTask = {
      ...reasoningTask(),
      taskId: "execution-1:task-2",
      planStepId: "step-2",
      content: "Publish the document",
      activeForm: "Publishing the document",
      status: "pending",
      attemptCount: 0,
      startedAt: undefined,
    };
    await savePlanExecutionLedger({
      ...execution(),
      tasks: [first, second],
    });
    const coordinator = new PlanExecutionCoordinator();
    await coordinator.requestTransitionWithEvidence({
      request: {
        executionId: "execution-1",
        taskId: first.taskId,
        toStatus: "completed",
        requestedBy: "original",
      },
      evidence: reasoningEvidence(),
      now: 2,
    });
    await coordinator.startNextTask("execution-1", 3);
    const request = resolvedAgentRequest({
      conversationKey: 41,
      mode: "agent",
      userText: "Continue the plan",
      libraryID: 1,
      planContext: {
        phase: "executing",
        planId: "plan-1",
        revision: 1,
        executionId: "execution-1",
        approvedDigest: "sha256:plan",
        activeTaskId: first.taskId,
        provider: "original",
      },
    });
    const session = new PlanExecutionRunSession(request, async () => {});

    await session.recordToolResult({
      toolName: "task_update",
      executionClass: "control",
      result: {
        callId: "call-1",
        name: "task_update",
        ok: true,
        actionReceipts: [],
        content: { status: "completed" },
      },
      runId: "run-1",
    });

    assert.equal(
      request.planContext?.phase === "executing"
        ? request.planContext.activeTaskId
        : undefined,
      second.taskId,
    );
  });

  it("advances an intermediate material task from stored document evidence before the later save", async function () {
    const first = {
      ...reasoningTask(),
      expectedEffect: "artifact",
      materialOutputId: "summary",
      completionRequirements: [
        {
          requirementId: "material",
          kind: "material_integrity",
          criterionIds: ["material"],
          contractDigest: "sha256:contract",
        },
      ],
      acceptanceCriteria: [
        {
          criterionId: "material",
          description: "Stored summary",
          verifier: "material_integrity",
        },
      ],
    } as ExecutionTask;
    const second = {
      ...reasoningTask(),
      taskId: "execution-1:save",
      planStepId: "save",
      status: "pending",
      attemptCount: 0,
      startedAt: undefined,
    } as ExecutionTask;
    await savePlanExecutionLedger({ ...execution(), tasks: [first, second] });
    const request = resolvedAgentRequest({
      conversationKey: 41,
      mode: "agent",
      userText: "Execute approved workflow",
      libraryID: 1,
      planContext: {
        phase: "executing",
        planId: "plan-1",
        revision: 1,
        executionId: "execution-1",
        approvedDigest: "sha256:plan",
        activeTaskId: first.taskId,
        provider: "original",
      },
    });
    await attachPlanMaterialEvidence(request, "summary", {
      documentId: "durable-summary",
      conversationKey: 41,
      contentHash: "sha256:summary",
      validation: { integrityValidated: true },
    } as PlanDocument);
    const session = new PlanExecutionRunSession(request, async () => {});
    await session.recordToolResult({
      toolName: "submit_document",
      executionClass: "control",
      result: {
        callId: "submit",
        name: "submit_document",
        ok: true,
        actionReceipts: [],
        content: { documentId: "durable-summary" },
      },
      runId: "run",
    });
    const ledger = await loadPlanExecutionLedger("execution-1");
    assert.equal(ledger?.tasks[0].status, "completed");
    assert.equal(ledger?.activeTaskId, second.taskId);
  });

  it("rolls back evidence and progress when the transition write fails", async function () {
    const coordinator = new PlanExecutionCoordinator();
    failTransitionInsert = true;
    let failure = "";
    try {
      await coordinator.requestTransitionWithEvidence({
        request: {
          executionId: "execution-1",
          taskId: "execution-1:task-1",
          toStatus: "completed",
          requestedBy: "original",
        },
        evidence: reasoningEvidence(),
        now: 2,
      });
    } catch (error) {
      failure = String(error);
    }

    assert.match(failure, /injected transition write failure/);
    assert.equal(
      Number(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM llm_for_zotero_plan_task_evidence",
          )
          .get()?.count,
      ),
      0,
    );
    const persisted = await loadPlanExecutionLedger("execution-1");
    assert.equal(persisted?.tasks[0].status, "in_progress");
    assert.deepEqual(persisted?.tasks[0].evidenceIds, []);
  });

  for (const attachment of ["evidence", "receipts"] as const) {
    it(`rolls back ${attachment} when saving its task ledger fails, then retries once`, async function () {
      const coordinator = new PlanExecutionCoordinator();
      const attach = () =>
        attachment === "evidence"
          ? coordinator.attachEvidence(reasoningEvidence())
          : coordinator.attachReceiptEvidence({
              executionId: "execution-1",
              taskId: "execution-1:task-1",
              now: 2,
              receipts: [
                {
                  version: 2,
                  id: "receipt-1",
                  obligationId: "obligation-1",
                  proposalId: "proposal-1",
                  proofDomain: "zotero_state",
                  capability: "zotero.metadata",
                  operation: "update_metadata",
                  verification: "verified",
                  status: "applied",
                  requestedTargets: ["1"],
                  appliedTargets: ["1"],
                  alreadySatisfiedTargets: [],
                  rejectedTargets: [],
                  reasons: [],
                  verifiedFacts: ["target 1 re-read"],
                },
              ],
            });
      const before = await loadPlanExecutionLedger("execution-1");
      const originalQuery = Zotero.DB.queryAsync;
      Zotero.DB.queryAsync = (async (sql: string, params?: unknown[]) => {
        if (
          sql.includes(
            "INSERT OR REPLACE INTO llm_for_zotero_plan_execution_tasks",
          )
        )
          throw new Error("injected ledger write failure");
        return originalQuery(sql, params);
      }) as typeof Zotero.DB.queryAsync;
      let failure = "";
      try {
        await attach();
      } catch (error) {
        failure = String(error);
      } finally {
        Zotero.DB.queryAsync = originalQuery;
      }
      assert.match(failure, /injected ledger write failure/);
      const rows = () =>
        Number(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM llm_for_zotero_plan_task_evidence",
            )
            .get()?.count,
        );
      assert.equal(rows(), 0);
      assert.deepEqual(await loadPlanExecutionLedger("execution-1"), before);
      await attach();
      await attach();
      assert.equal(rows(), 1);
      const persisted = await loadPlanExecutionLedger("execution-1");
      assert.lengthOf(persisted!.tasks[0].evidenceIds, 1);
    });
  }

  it("uses the same transition state with preattached or simultaneous evidence", async function () {
    const coordinator = new PlanExecutionCoordinator();
    const request = {
      executionId: "execution-1",
      taskId: "execution-1:task-1",
      toStatus: "completed",
      requestedBy: "original",
    } as const;
    await coordinator.attachEvidence(reasoningEvidence());
    const separate = await coordinator.requestTransition(request, 3);
    await savePlanExecutionLedger(execution());
    const together = await coordinator.requestTransitionWithEvidence({
      request,
      evidence: reasoningEvidence(),
      now: 3,
    });
    assert.deepEqual(together, separate);
  });

  it("reattaches the durable non-terminal execution after in-memory state is gone", async function () {
    const resumable = { ...execution(), conversationKey: 9041 };
    await savePlanExecutionLedger(resumable);

    assert.deepInclude(await takePendingPlanExecution(9041), {
      phase: "executing",
      executionId: resumable.executionId,
      planId: resumable.planId,
      revision: resumable.revision,
    });

    await savePlanExecutionLedger({
      ...resumable,
      status: "completed",
      activeTaskId: undefined,
      completedAt: 3,
      updatedAt: 3,
      tasks: resumable.tasks.map((task) => ({
        ...task,
        status: "completed",
        completedAt: 3,
        updatedAt: 3,
      })),
    });
    assert.isUndefined(await takePendingPlanExecution(9041));
  });

  it("commits document delivery and terminal Plan progress together", async function () {
    db.exec("DELETE FROM llm_for_zotero_plan_execution_tasks");
    const staged = plannedDocument();
    const integrity = documentIntegrityEvidence();
    const ledger = documentExecution();
    ledger.tasks[0].evidenceIds = [integrity.evidenceId];
    await savePlanExecutionLedger(ledger);
    await saveTaskEvidence(integrity);
    await savePlanDocumentInTransaction(staged);

    await deliverPendingPlanDocumentMessage({
      conversationKey: 41,
      visibleMarkdown: staged.document.visibleMarkdown,
      messageTimestamp: 3,
      documentId: staged.document.documentId,
    });

    assert.equal(
      (await loadPlanDocumentOutbox(staged.document.documentId))?.status,
      "delivered",
    );
    assert.equal(
      (await loadPlanExecutionLedger("execution-1"))?.tasks[0].status,
      "completed",
    );

    // Simulate the legacy crash gap: the outbox is already delivered, but
    // the terminal transition was never persisted. A replay must reconcile it.
    const completed = await loadPlanExecutionLedger("execution-1");
    assert.exists(completed);
    const regressed: PlanExecutionLedger = {
      ...completed!,
      status: "running",
      activeTaskId: "execution-1:task-document",
      completedAt: undefined,
      tasks: completed!.tasks.map((task) => ({
        ...task,
        status: "in_progress",
        completedAt: undefined,
      })),
    };
    await savePlanExecutionLedger(regressed);
    await deliverPendingPlanDocumentMessage({
      conversationKey: 41,
      visibleMarkdown: staged.document.visibleMarkdown,
      messageTimestamp: 3,
      documentId: staged.document.documentId,
    });
    assert.equal(
      (await loadPlanExecutionLedger("execution-1"))?.tasks[0].status,
      "completed",
    );
  });

  it("rolls back document delivery when terminal progress cannot commit", async function () {
    db.exec("DELETE FROM llm_for_zotero_plan_execution_tasks");
    const staged = plannedDocument();
    await savePlanExecutionLedger(documentExecution());
    await savePlanDocumentInTransaction(staged);

    let failure = "";
    try {
      await deliverPendingPlanDocumentMessage({
        conversationKey: 41,
        visibleMarkdown: staged.document.visibleMarkdown,
        messageTimestamp: 3,
        documentId: staged.document.documentId,
      });
    } catch (error) {
      failure = String(error);
    }

    assert.match(failure, /document_integrity/);
    assert.equal(
      (await loadPlanDocumentOutbox(staged.document.documentId))?.status,
      "pending",
    );
    assert.equal(
      (await loadPlanExecutionLedger("execution-1"))?.tasks[0].status,
      "in_progress",
    );
    assert.equal(
      Number(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM llm_for_zotero_plan_task_evidence WHERE kind = 'document_published'",
          )
          .get()?.count,
      ),
      0,
    );
  });
});
