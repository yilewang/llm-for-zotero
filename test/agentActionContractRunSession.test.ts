import { assert } from "chai";
import {
  ActionContractRunSession,
  readLatestActionContractCheckpoint,
  type ActionContractCheckpoint,
} from "../src/agent/contracts/actionContractRunSession";
import type {
  AgentActionContract,
  AgentActionProgressLedger,
  AgentActionReceipt,
} from "../src/agent/contracts/types";
import type { AgentEvent, AgentToolContext } from "../src/agent/types";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

function createContract(
  id = "contract-1",
  overrides: Partial<AgentActionContract> = {},
): AgentActionContract {
  return {
    version: 2,
    id,
    writeDisposition: "required",
    interpretationSource: "classifier",
    obligations: [
      {
        id: `${id}:obligation:0`,
        capability: "command.execute",
        operation: "command_execute",
        proofDomain: "execution",
        coverage: "all",
        targetKind: "items",
      },
    ],
    ...overrides,
  };
}

function createProgress(
  contract: AgentActionContract,
  overrides: Partial<AgentActionProgressLedger> = {},
): AgentActionProgressLedger {
  return {
    version: 1,
    contractId: contract.id,
    state: "pending",
    correctionCount: 0,
    obligations: contract.obligations.map((obligation) => ({
      obligationId: obligation.id,
      status: "open",
      verifiedTargetIds: [],
      unresolvedTargetIds: [],
      journalStepIds: [],
      failureReasons: [],
    })),
    appliedReceiptKeys: [],
    updatedAt: 1,
    ...overrides,
  };
}

function createReceipt(params: {
  id: string;
  obligationId?: string;
  operation?: AgentActionReceipt["operation"];
  proofDomain?: AgentActionReceipt["proofDomain"];
  status?: AgentActionReceipt["status"];
  verification?: AgentActionReceipt["verification"];
}): AgentActionReceipt {
  return {
    version: 2,
    id: params.id,
    obligationId: params.obligationId,
    proposalId: `proposal:${params.id}`,
    proofDomain: params.proofDomain || "execution",
    capability: "command.execute",
    operation: params.operation || "command_execute",
    verification: params.verification || "verified",
    status: params.status || "applied",
    requestedTargets: [],
    appliedTargets: [],
    alreadySatisfiedTargets: [],
    rejectedTargets: [],
    reasons: [],
    verifiedFacts: [],
  };
}

function checkpointEvent(contract: unknown, progress: unknown): AgentEvent {
  return {
    type: "provider_event",
    providerType: "agent_action_contract",
    payload: { contract, progress },
  };
}

function createHarness(
  params: {
    userText?: string;
    contract?: AgentActionContract | null;
    createError?: unknown;
  } = {},
) {
  const contract =
    params.contract === undefined ? createContract() : params.contract;
  const request = resolvedAgentRequest({
    conversationKey: 1,
    mode: "agent",
    userText: params.userText || "run the command",
    model: "test-model",
    apiBase: "https://example.invalid",
    apiKey: "test",
    libraryID: 1,
  });
  const events: AgentEvent[] = [];
  let createContractCalls = 0;
  let createProgressCalls = 0;
  const contracts = {
    async createActionContract() {
      createContractCalls += 1;
      if (params.createError !== undefined) throw params.createError;
      return contract;
    },
    createActionProgress(value: AgentActionContract) {
      createProgressCalls += 1;
      return createProgress(value);
    },
  };
  const session = new ActionContractRunSession({
    request,
    contracts,
    emit: async (event) => {
      events.push(event);
    },
  });
  return {
    request,
    events,
    session,
    get createContractCalls() {
      return createContractCalls;
    },
    get createProgressCalls() {
      return createProgressCalls;
    },
  };
}

describe("ActionContractRunSession checkpoint parsing", function () {
  const contract = createContract();
  const progress = createProgress(contract);

  const invalidCases: Array<{
    name: string;
    contract: unknown;
    progress: unknown;
  }> = [
    {
      name: "rejects the wrong contract version",
      contract: { ...contract, version: 1 },
      progress,
    },
    {
      name: "rejects a non-string contract id",
      contract: { ...contract, id: 1 },
      progress,
    },
    {
      name: "rejects non-array contract obligations",
      contract: { ...contract, obligations: null },
      progress,
    },
    {
      name: "rejects the wrong progress version",
      contract,
      progress: { ...progress, version: 2 },
    },
    {
      name: "rejects a mismatched progress contract id",
      contract,
      progress: { ...progress, contractId: "different" },
    },
    {
      name: "rejects non-array progress obligations",
      contract,
      progress: { ...progress, obligations: null },
    },
  ];

  for (const invalidCase of invalidCases) {
    it(invalidCase.name, function () {
      assert.isNull(
        readLatestActionContractCheckpoint([
          checkpointEvent(invalidCase.contract, invalidCase.progress),
        ]),
      );
    });
  }

  it("returns the latest valid checkpoint and ignores unrelated events", function () {
    const latestContract = createContract("contract-2");
    const latestProgress = createProgress(latestContract);
    const result = readLatestActionContractCheckpoint([
      checkpointEvent(contract, progress),
      { type: "status", text: "working" },
      {
        type: "provider_event",
        providerType: "different_provider",
        payload: { contract: latestContract, progress: latestProgress },
      },
      checkpointEvent(latestContract, latestProgress),
    ]);
    assert.strictEqual(result?.contract, latestContract);
    assert.strictEqual(result?.progress, latestProgress);
  });
});

describe("ActionContractRunSession initialization", function () {
  const resumeTexts = [
    "continue",
    "resume the task",
    "keep going please",
    "go on",
    "pick up where you left off",
    "  CoNtInUe from the checkpoint",
  ];

  for (const userText of resumeTexts) {
    it(`restores a checkpoint for ${JSON.stringify(userText)}`, async function () {
      const restoredContract = createContract("restored");
      const restoredProgress = createProgress(restoredContract);
      const harness = createHarness({ userText });
      const result = await harness.session.initialize({
        checkpoint: {
          contract: restoredContract,
          progress: restoredProgress,
        },
      });
      assert.deepEqual(result, { kind: "ready" });
      assert.strictEqual(harness.request.actionContract, restoredContract);
      assert.strictEqual(harness.request.actionProgress, restoredProgress);
      assert.equal(harness.createContractCalls, 0);
      assert.equal(harness.createProgressCalls, 0);
    });
  }

  it("creates a fresh contract for non-resume text despite a checkpoint", async function () {
    const freshContract = createContract("fresh");
    const restoredContract = createContract("restored");
    const harness = createHarness({ contract: freshContract });
    await harness.session.initialize({
      checkpoint: {
        contract: restoredContract,
        progress: createProgress(restoredContract),
      },
    });
    assert.strictEqual(harness.request.actionContract, freshContract);
    assert.equal(harness.createContractCalls, 1);
    assert.equal(harness.createProgressCalls, 1);
  });

  it("creates a fresh contract when resume text has no checkpoint", async function () {
    const harness = createHarness({ userText: "continue" });
    await harness.session.initialize({ checkpoint: null });
    assert.equal(harness.createContractCalls, 1);
    assert.equal(harness.createProgressCalls, 1);
  });

  it("emits the initial ready snapshot", async function () {
    const harness = createHarness();
    await harness.session.initialize({ checkpoint: null });
    assert.lengthOf(harness.events, 1);
    assert.deepEqual(harness.events[0], {
      type: "provider_event",
      providerType: "agent_action_contract",
      payload: {
        contract: harness.request.actionContract,
        progress: harness.request.actionProgress,
      },
    });
  });

  it("returns the exact user message while emitting the raw failure reason", async function () {
    const harness = createHarness({ createError: new Error("scope exploded") });
    const result = await harness.session.initialize({ checkpoint: null });
    assert.deepEqual(result, {
      kind: "failed",
      userMessage:
        "I could not safely resolve the requested action scope: scope exploded",
    });
    assert.deepEqual(harness.events, [
      {
        type: "provider_event",
        providerType: "agent_action_contract",
        payload: {
          state: "failed",
          retryable: true,
          reason: "scope exploded",
        },
      },
    ]);
  });
});

describe("ActionContractRunSession state machine", function () {
  it("keeps checkpointing inert without an active contract", async function () {
    const harness = createHarness({ contract: null });
    await harness.session.initialize({ checkpoint: null });
    const checkpointActionProgress = () => harness.session.checkpoint();
    const callback: AgentToolContext["checkpointActionProgress"] =
      checkpointActionProgress;
    await callback?.();
    assert.isEmpty(harness.events);
  });

  it("checkpoints through the explicitly wrapped tool-context callback", async function () {
    const harness = createHarness();
    await harness.session.initialize({ checkpoint: null });
    harness.events.splice(0);
    const context: Pick<AgentToolContext, "checkpointActionProgress"> = {
      checkpointActionProgress: () => harness.session.checkpoint(),
    };
    const callback = context.checkpointActionProgress;
    await callback?.();
    assert.deepEqual(harness.events, [
      {
        type: "provider_event",
        providerType: "agent_action_contract",
        payload: {
          contract: harness.request.actionContract,
          progress: harness.request.actionProgress,
        },
      },
    ]);
  });

  it("records receipts in order without applying them to progress", async function () {
    const harness = createHarness();
    await harness.session.initialize({ checkpoint: null });
    harness.events.splice(0);
    const obligationId = harness.request.actionContract!.obligations[0].id;
    const first = createReceipt({ id: "first", obligationId });
    const second = createReceipt({
      id: "second",
      obligationId,
      status: "already_satisfied",
    });
    await harness.session.recordToolReceipts([first]);
    await harness.session.recordToolReceipts([second]);

    assert.equal(harness.createContractCalls, 1);
    assert.equal(harness.createProgressCalls, 1);
    assert.equal(harness.request.actionProgress!.obligations[0].status, "open");
    assert.isEmpty(harness.request.actionProgress!.appliedReceiptKeys);
    assert.equal(
      harness.session.receiptStatus(),
      [
        "[Action status: command_execute — applied; verified; proof:execution]",
        "[Action status: command_execute — already_satisfied; verified; proof:execution]",
      ].join("\n"),
    );
    assert.lengthOf(harness.events, 2);
  });

  it("filters unrelated receipts from the status block", async function () {
    const harness = createHarness();
    await harness.session.initialize({ checkpoint: null });
    await harness.session.recordToolReceipts([
      createReceipt({ id: "unrelated", operation: "file_write" }),
    ]);
    assert.equal(harness.session.receiptStatus(), "");
  });

  it("accepts satisfied and cancelled evaluations", async function () {
    for (const status of ["fulfilled", "cancelled"] as const) {
      const contract = createContract(`contract-${status}`);
      const progress = createProgress(contract);
      progress.obligations[0].status = status;
      const harness = createHarness({
        userText: "continue",
        contract: createContract("unused"),
      });
      await harness.session.initialize({ checkpoint: { contract, progress } });
      const decision = await harness.session.evaluateFinal({
        canCorrect: true,
      });
      assert.deepEqual(decision, { kind: "accept" });
      assert.equal(
        progress.state,
        status === "fulfilled" ? "satisfied" : "cancelled",
      );
      const terminal = harness.events.at(-1);
      assert.equal(
        terminal?.type === "provider_event"
          ? terminal.payload?.state
          : undefined,
        progress.state,
      );
    }
  });

  it("commits a correction only after terminal evaluation", async function () {
    const harness = createHarness();
    await harness.session.initialize({ checkpoint: null });
    const progress = harness.request.actionProgress!;
    const decision = await harness.session.evaluateFinal({ canCorrect: true });
    assert.equal(decision.kind, "correct");
    assert.equal(progress.state, "pending");
    assert.equal(progress.correctionCount, 0);
    assert.equal(
      harness.events.at(-1)?.type === "provider_event"
        ? harness.events.at(-1)?.payload?.state
        : undefined,
      "pending",
    );
    if (decision.kind !== "correct") return;
    harness.session.commitRejectedFinal(decision);
    assert.equal(progress.correctionCount, 1);
    assert.isAbove(progress.updatedAt, 1);

    const nextDecision = await harness.session.evaluateFinal({
      canCorrect: true,
    });
    assert.equal(nextDecision.kind, "fail");
  });

  it("commits terminal failure only after evaluation and without a round", async function () {
    const harness = createHarness();
    await harness.session.initialize({ checkpoint: null });
    const progress = harness.request.actionProgress!;
    const decision = await harness.session.evaluateFinal({
      canCorrect: false,
    });
    assert.equal(decision.kind, "fail");
    assert.equal(progress.state, "pending");
    assert.equal(progress.correctionCount, 0);
    if (decision.kind !== "fail") return;
    harness.session.commitRejectedFinal(decision);
    assert.equal(progress.state, "failed");
    assert.equal(progress.correctionCount, 0);
    assert.isAbove(progress.updatedAt, 1);
  });

  it("reports a failed evaluation without committing terminal progress", async function () {
    const contract = createContract("uncertain-contract", {
      writeDisposition: "uncertain",
      obligations: [],
    });
    const harness = createHarness({ contract });
    await harness.session.initialize({ checkpoint: null });
    const progress = harness.request.actionProgress!;

    const decision = await harness.session.evaluateFinal({ canCorrect: false });

    assert.equal(decision.kind, "fail");
    assert.equal(progress.state, "pending");
    assert.equal(
      harness.events.at(-1)?.type === "provider_event"
        ? harness.events.at(-1)?.payload?.state
        : undefined,
      "failed",
    );
    if (decision.kind !== "fail") return;
    harness.session.commitRejectedFinal(decision);
    assert.equal(progress.state, "failed");
  });
});
