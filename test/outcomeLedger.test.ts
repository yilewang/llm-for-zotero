import { assert } from "chai";
import {
  createEmptyExecutionCheckpoint,
  ordinaryExecutionTaskId,
} from "../src/agent/execution/checkpoint";
import {
  applyOutcomeEvidence,
  declareOutcomes,
  decideRunEnd,
  markOutcomes,
  openDeclaredOutcomes,
  OUTCOME_REASONS,
  outcomeProgressSignature,
  papersAlreadyWritten,
  resumesOnContinue,
  settleDeclinedOutcomes,
  settleOutcomes,
  type OutcomeDeclaration,
  type OutcomeEvidence,
  type OutcomeModelMark,
} from "../src/agent/loop/outcomes";
import type { RunStopRule } from "../src/agent/loop/stopRules";
import type {
  AgentActionCapability,
  AgentActionProposal,
  AgentActionReceipt,
  AgentExecutionContext,
  ExecutionCheckpoint,
  ExecutionCheckpointTask,
} from "../src/agent/types";
import type { RunEndState } from "../src/agent/execution/types";
import {
  DISCOVER_IMPORT,
  RENAME_DELETE_FOLDER,
} from "./helpers/liveLedgerRuns";

const executionContext: AgentExecutionContext = {
  version: 1,
  executionId: "execution-direct-1",
  conversationKey: 41,
  conversationGeneration: 3,
  chatLibraryID: 1,
  permissionOwner: "original_agent",
  workspaceSnapshot: {
    selectedPapers: [],
    selectedCollections: [],
  },
  configuredAccess: { libraryIDs: [1], outputDirectories: [] },
};

const UNVERIFIED =
  "The change could not be verified; check the current state before retrying.";
const DECLINED = "You declined this change.";
const NOT_DONE = "Not done before the answer.";
const WRITE_FAILED = "The change was not applied.";

function taskId(local: string): string {
  return `execution-direct-1:task:${local}`;
}

/** Freeze a ledger deeply, so any mutation by the evaluator throws. */
function frozen<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) frozen(nested);
  }
  return value;
}

function emptyLedger(): ExecutionCheckpoint {
  return frozen(createEmptyExecutionCheckpoint(executionContext, 10));
}

function ledgerWith(
  ...declarations: OutcomeDeclaration[]
): ExecutionCheckpoint {
  return frozen(declareOutcomes(emptyLedger(), declarations, 20));
}

function withTasks(
  checkpoint: ExecutionCheckpoint,
  ...tasks: ExecutionCheckpointTask[]
): ExecutionCheckpoint {
  return frozen({ ...checkpoint, tasks: [...checkpoint.tasks, ...tasks] });
}

/** A task as the pre-outcome ordinary path wrote it: no effect, no origin. */
function legacyTask(
  local: string,
  overrides: Partial<ExecutionCheckpointTask> = {},
): ExecutionCheckpointTask {
  return {
    taskId: taskId(local),
    description: `Legacy ${local}`,
    dependencies: [],
    status: "pending",
    journalActionIds: [],
    verifiedReceiptIds: [],
    readEvidenceIds: [],
    materialRefs: [],
    createdAt: 5,
    updatedAt: 5,
    ...overrides,
  };
}

function receipt(
  overrides: Partial<AgentActionReceipt> = {},
): AgentActionReceipt {
  return {
    version: 2,
    id: "receipt-1",
    proposalId: "proposal-1",
    proofDomain: "zotero_state",
    capability: "zotero.notes",
    operation: "note_create",
    verification: "verified",
    status: "applied",
    requestedTargets: ["item:1"],
    appliedTargets: ["item:1"],
    alreadySatisfiedTargets: [],
    rejectedTargets: [],
    reasons: [],
    verifiedFacts: [],
    ...overrides,
  };
}

function rejection(
  id: string,
  rejectedTargets: string[],
  reasons: string[],
): AgentActionReceipt {
  return receipt({
    id,
    capability: "zotero.tags",
    operation: "apply_tags",
    verification: "not_applicable",
    status: "failed",
    requestedTargets: rejectedTargets,
    appliedTargets: [],
    rejectedTargets,
    reasons,
  });
}

/** A note write that ran and failed, as `finalizeProposal` stamps it. */
function failedWrite(id: string, reasons: string[]): AgentActionReceipt {
  return receipt({
    id,
    verification: "unverified",
    status: "failed",
    appliedTargets: [],
    reasons,
  });
}

function declined(
  callId: string,
  ...proposals: Pick<
    AgentActionProposal,
    "capability" | "operation" | "requestedTargets"
  >[]
): OutcomeEvidence {
  return { kind: "declined", callId, proposals };
}

function declineNote(callId: string): OutcomeEvidence {
  return declined(callId, {
    capability: "zotero.notes",
    operation: "note_create",
    requestedTargets: ["item:1"],
  });
}

function apply(
  checkpoint: ExecutionCheckpoint,
  evidence: OutcomeEvidence,
  now = 30,
): { checkpoint: ExecutionCheckpoint; changed: boolean } {
  const result = applyOutcomeEvidence(checkpoint, evidence, now);
  frozen(result.checkpoint);
  return result;
}

function find(
  checkpoint: ExecutionCheckpoint,
  local: string,
): ExecutionCheckpointTask {
  const task = checkpoint.tasks.find((entry) => entry.taskId === taskId(local));
  assert.exists(task, `outcome ${local}`);
  return task!;
}

const saveNote: OutcomeDeclaration = {
  taskId: "save",
  description: "Save it as a note on (Smith, 2021)",
  effect: "mutation",
  capability: "zotero.notes",
  targets: ["item:1"],
};

const tagAny: OutcomeDeclaration = {
  taskId: "tag",
  description: "Tag the papers",
  effect: "mutation",
  capability: "zotero.tags",
};

const material = {
  documentId: "document-1",
  documentVersion: 2,
  contentHash: "sha256:material",
};

describe("outcome ledger: model declarations", function () {
  it("creates a pending model outcome with its effect, capability and item targets", function () {
    const ledger = emptyLedger();
    const next = declareOutcomes(
      ledger,
      [
        {
          taskId: "save",
          description: "  Save the summary as a note ",
          effect: "mutation",
          capability: "zotero.notes",
          targets: ["12", "item:13", " 12 ", ""],
        },
        {
          taskId: "explain",
          description: "Explain the method",
          effect: "answer",
        },
      ],
      20,
    );

    assert.deepEqual(next.tasks, [
      {
        taskId: taskId("save"),
        description: "Save the summary as a note",
        dependencies: [],
        status: "pending",
        journalActionIds: [],
        verifiedReceiptIds: [],
        readEvidenceIds: [],
        materialRefs: [],
        createdAt: 20,
        updatedAt: 20,
        effect: "mutation",
        origin: "model",
        capability: "zotero.notes",
        targets: ["item:12", "item:13"],
      },
      {
        taskId: taskId("explain"),
        description: "Explain the method",
        dependencies: [],
        status: "pending",
        journalActionIds: [],
        verifiedReceiptIds: [],
        readEvidenceIds: [],
        materialRefs: [],
        createdAt: 20,
        updatedAt: 20,
        effect: "answer",
        origin: "model",
      },
    ]);
    assert.equal(next.updatedAt, 20);
    assert.equal(next.version, 1);
    assert.lengthOf(ledger.tasks, 0);
  });

  it("refuses a new outcome without an effect and leaves the ledger as it was", function () {
    const ledger = emptyLedger();
    assert.throws(
      () =>
        declareOutcomes(
          ledger,
          [
            {
              taskId: "save",
              description: "Save",
            } as unknown as OutcomeDeclaration,
          ],
          20,
        ),
      /effect/,
    );
    assert.lengthOf(ledger.tasks, 0);
  });

  it("refuses a duplicate or invalid task id, and a change to an existing part with progress", function () {
    const ledger = ledgerWith(saveNote);
    assert.throws(
      () =>
        declareOutcomes(
          emptyLedger(),
          [saveNote, { ...saveNote, description: "Save again" }],
          30,
        ),
      /only once/,
    );
    assert.throws(
      () =>
        declareOutcomes(ledger, [{ ...saveNote, taskId: "save the note" }], 30),
      /Task IDs must use/,
    );
    const written = apply(ledger, {
      kind: "receipt",
      receipt: receipt(),
    }).checkpoint;
    for (const change of [
      { ...saveNote, description: "Save somewhere else" },
      { ...saveNote, targets: ["item:2"] },
    ])
      assert.throws(
        () => declareOutcomes(written, [change], 30),
        /has progress/,
      );
    assert.strictEqual(
      declareOutcomes(ledger, [{ ...saveNote, taskId: taskId("save") }], 30),
      ledger,
      "re-declaring the same outcome changes nothing",
    );
  });

  it("changes a part with no progress in place: its id, place and creation stay", function () {
    const ledger = ledgerWith(saveNote, {
      taskId: "read",
      description: "Read it",
      effect: "read",
    });
    const changed = declareOutcomes(
      ledger,
      [{ ...saveNote, description: "Save it in the Drift folder's note" }],
      30,
    );
    assert.deepEqual(
      changed.tasks.map((task) => [task.taskId, task.description]),
      [
        [taskId("save"), "Save it in the Drift folder's note"],
        [taskId("read"), "Read it"],
      ],
    );
    assert.equal(find(changed, "save").createdAt, 20);
    assert.equal(find(changed, "save").updatedAt, 30);
    assert.deepEqual(find(changed, "save").targets, ["item:1"]);
  });

  it("marks a pending, in-progress or blocked outcome skipped, blocked or cancelled with the reason", function () {
    const ledger = withTasks(
      ledgerWith(
        saveNote,
        { taskId: "tag", description: "Tag it", effect: "mutation" },
        { taskId: "read", description: "Read it", effect: "read" },
      ),
      legacyTask("working", { status: "in_progress" }),
    );
    const blocked = apply(ledger, declineNote("call-note")).checkpoint;
    assert.equal(find(blocked, "save").status, "blocked");

    const marks: OutcomeModelMark[] = [
      {
        taskId: "save",
        status: "cancelled",
        reason: "The user chose not to save",
      },
      { taskId: "tag", status: "skipped", reason: " No tags were asked for " },
      { taskId: "working", status: "blocked", reason: "Needs the user's file" },
    ];
    const { checkpoint, ignored } = markOutcomes(blocked, marks, 40);

    assert.deepEqual(ignored, []);
    assert.deepEqual(
      checkpoint.tasks.map((task) => [task.taskId, task.status, task.reason]),
      [
        [taskId("save"), "cancelled", "The user chose not to save"],
        [taskId("tag"), "skipped", "No tags were asked for"],
        [taskId("read"), "pending", undefined],
        [taskId("working"), "blocked", "Needs the user's file"],
      ],
    );
    assert.equal(find(checkpoint, "tag").updatedAt, 40);
    assert.equal(checkpoint.updatedAt, 40);
  });

  it("refuses a skipped, blocked or cancelled mark without a reason", function () {
    const ledger = ledgerWith(saveNote);
    for (const status of ["skipped", "blocked", "cancelled"] as const) {
      assert.throws(
        () =>
          markOutcomes(ledger, [{ taskId: "save", status, reason: "  " }], 30),
        "A skipped, blocked, or cancelled task needs the reason.",
      );
    }
    assert.equal(find(ledger, "save").status, "pending");
  });

  it("ignores any other status and any mark the outcome's status does not allow", function () {
    const ledger = apply(ledgerWith(saveNote), {
      kind: "receipt",
      receipt: receipt(),
    }).checkpoint;
    assert.equal(find(ledger, "save").status, "completed");
    const withOpen = withTasks(ledger, legacyTask("open"));

    for (const status of ["completed", "in_progress", "pending"]) {
      const result = markOutcomes(
        withOpen,
        [
          {
            taskId: "open",
            status,
            reason: "The model says so",
          } as unknown as OutcomeModelMark,
        ],
        40,
      );
      assert.deepEqual(result.ignored, [taskId("open")]);
      assert.strictEqual(result.checkpoint, withOpen);
    }

    const done = markOutcomes(
      withOpen,
      [{ taskId: "save", status: "skipped", reason: "Changed my mind" }],
      40,
    );
    assert.deepEqual(done.ignored, [taskId("save")]);
    assert.strictEqual(done.checkpoint, withOpen);
    assert.throws(
      () =>
        markOutcomes(
          withOpen,
          [{ taskId: "missing", status: "skipped", reason: "Not there" }],
          40,
        ),
      /Unknown task/,
    );
  });

  it("never copies evidence identities or a status from a declaration", function () {
    const next = declareOutcomes(
      emptyLedger(),
      [
        {
          ...saveNote,
          status: "completed",
          journalActionIds: ["action-1"],
          verifiedReceiptIds: ["invented-receipt"],
          readEvidenceIds: ["invented-read"],
          materialRefs: [material],
          doneTargets: ["item:1"],
          receiptIds: ["invented-receipt"],
          origin: "host",
        } as unknown as OutcomeDeclaration,
      ],
      20,
    );
    const task = find(next, "save");
    assert.equal(task.status, "pending");
    assert.equal(task.origin, "model");
    assert.deepEqual(task.journalActionIds, []);
    assert.deepEqual(task.verifiedReceiptIds, []);
    assert.deepEqual(task.readEvidenceIds, []);
    assert.deepEqual(task.materialRefs, []);
    assert.notProperty(task, "doneTargets");
    assert.notProperty(task, "receiptIds");
  });
});

describe("outcome ledger: host evidence binding", function () {
  it("read: completes an untargeted read outcome on the first read", function () {
    const ledger = ledgerWith({
      taskId: "read",
      description: "Read the paper",
      effect: "read",
    });
    const { checkpoint, changed } = apply(ledger, {
      kind: "read",
      targets: ["item:1", "item:2"],
      observationIds: ["obs-1"],
    });

    assert.isTrue(changed);
    const task = find(checkpoint, "read");
    assert.equal(task.status, "completed");
    assert.deepEqual(task.doneTargets, ["item:1", "item:2"]);
    assert.deepEqual(task.readEvidenceIds, ["obs-1"]);
    assert.equal(task.updatedAt, 30);
    assert.equal(checkpoint.updatedAt, 30);
    assert.equal(find(ledger, "read").status, "pending");
  });

  it("read: a targeted read outcome takes only its own targets and completes when all were read", function () {
    const ledger = ledgerWith({
      taskId: "read",
      description: "Read both papers",
      effect: "read",
      targets: ["item:1", "item:2"],
    });
    const unrelated = apply(ledger, {
      kind: "read",
      targets: ["item:9"],
      observationIds: ["obs-9"],
    });
    assert.isFalse(unrelated.changed);
    assert.strictEqual(unrelated.checkpoint, ledger);

    const first = apply(ledger, {
      kind: "read",
      targets: ["item:1", "item:3"],
      observationIds: ["obs-1"],
    });
    assert.isTrue(first.changed);
    assert.equal(find(first.checkpoint, "read").status, "pending");
    assert.deepEqual(find(first.checkpoint, "read").doneTargets, ["item:1"]);

    const second = apply(first.checkpoint, {
      kind: "read",
      targets: ["item:2"],
      observationIds: ["obs-2"],
    });
    const task = find(second.checkpoint, "read");
    assert.equal(task.status, "completed");
    assert.deepEqual(task.doneTargets, ["item:1", "item:2"]);
    assert.deepEqual(task.readEvidenceIds, ["obs-1", "obs-2"]);
  });

  it("read: one read applies to every pending read outcome that covers it", function () {
    const ledger = ledgerWith(
      {
        taskId: "read-a",
        description: "Read Smith 2021",
        effect: "read",
        targets: ["item:1"],
      },
      {
        taskId: "read-b",
        description: "Read Jones 2020 and Lee 2019",
        effect: "read",
        targets: ["item:2", "item:3"],
      },
      {
        taskId: "read-any",
        description: "Read the related work",
        effect: "read",
      },
      {
        taskId: "read-other",
        description: "Read Kim 2018",
        effect: "read",
        targets: ["item:9"],
      },
    );
    const { checkpoint, changed } = apply(ledger, {
      kind: "read",
      targets: ["item:1", "item:2"],
      observationIds: ["obs-1"],
    });

    assert.isTrue(changed);
    assert.deepEqual(
      checkpoint.tasks.map((task) => [
        task.status,
        task.doneTargets ?? [],
        task.readEvidenceIds,
      ]),
      [
        ["completed", ["item:1"], ["obs-1"]],
        ["pending", ["item:2"], ["obs-1"]],
        ["completed", ["item:1", "item:2"], ["obs-1"]],
        ["pending", [], []],
      ],
    );
  });

  it("receipt: completes an untargeted mutation outcome on its first verified receipt", function () {
    const ledger = ledgerWith({
      taskId: "save",
      description: "Save a note",
      effect: "mutation",
      capability: "zotero.notes",
    });
    const { checkpoint, changed } = apply(ledger, {
      kind: "receipt",
      receipt: receipt(),
    });

    assert.isTrue(changed);
    assert.lengthOf(checkpoint.tasks, 1);
    const task = find(checkpoint, "save");
    assert.equal(task.status, "completed");
    assert.deepEqual(task.doneTargets, ["item:1"]);
    assert.deepEqual(task.verifiedReceiptIds, ["receipt-1"]);
    assert.deepEqual(task.receiptIds, ["receipt-1"]);
    assert.deepEqual(task.journalActionIds, []);
    assert.notProperty(task, "exceptions");
    assert.notProperty(task, "reason");
  });

  it("receipt: a targeted mutation outcome completes when every target is done or excepted", function () {
    const ledger = ledgerWith({
      taskId: "tag",
      description: "Tag three papers",
      effect: "mutation",
      capability: "zotero.tags",
      targets: ["item:1", "item:2", "item:3"],
    });
    const first = apply(ledger, {
      kind: "receipt",
      receipt: receipt({
        id: "receipt-tags-1",
        capability: "zotero.tags",
        operation: "apply_tags",
        status: "partial",
        requestedTargets: ["item:1", "item:2"],
        appliedTargets: ["item:1"],
        rejectedTargets: ["item:2"],
        reasons: ["Item is locked"],
      }),
    });
    let task = find(first.checkpoint, "tag");
    assert.equal(task.status, "pending");
    assert.deepEqual(task.doneTargets, ["item:1"]);
    assert.deepEqual(task.exceptions, [
      { targets: ["item:2"], reason: "Item is locked" },
    ]);

    const second = apply(first.checkpoint, {
      kind: "receipt",
      receipt: receipt({
        id: "receipt-tags-2",
        capability: "zotero.tags",
        operation: "apply_tags",
        requestedTargets: ["item:3"],
        appliedTargets: [],
        alreadySatisfiedTargets: ["item:3"],
        status: "already_satisfied",
      }),
    });
    task = find(second.checkpoint, "tag");
    assert.equal(task.status, "completed");
    assert.deepEqual(task.doneTargets, ["item:1", "item:3"]);
    assert.deepEqual(task.verifiedReceiptIds, [
      "receipt-tags-1",
      "receipt-tags-2",
    ]);
    assert.lengthOf(second.checkpoint.tasks, 1);
  });

  it("receipt: a targeted outcome with every target rejected is skipped with its first exception's reason", function () {
    const ledger = ledgerWith({
      taskId: "tag",
      description: "Tag both papers",
      effect: "mutation",
      capability: "zotero.tags",
      targets: ["item:1", "item:2"],
    });
    const { checkpoint } = apply(ledger, {
      kind: "receipt",
      receipt: rejection(
        "rejected-all",
        ["item:1", "item:2"],
        ["In a group library you cannot edit"],
      ),
    });
    const task = find(checkpoint, "tag");
    assert.equal(task.status, "skipped");
    assert.equal(task.reason, "In a group library you cannot edit");
    assert.notProperty(task, "doneTargets");
    assert.equal(
      decideRunEnd(checkpoint, {
        status: "completed",
        stopRule: "final_answer",
      }),
      "completed_with_exceptions",
    );

    const hosted = apply(emptyLedger(), {
      kind: "receipt",
      receipt: rejection("rejected-host", ["item:5"], []),
    }).checkpoint;
    assert.equal(hosted.tasks[0].status, "skipped");
    assert.equal(hosted.tasks[0].reason, "Not applied");
  });

  it("receipt: rejected targets become one exception per distinct reason, and nothing proven keeps the outcome open", function () {
    let { checkpoint } = apply(ledgerWith(tagAny), {
      kind: "receipt",
      receipt: rejection("rejected-1", ["item:1"], ["Item is locked"]),
    });
    ({ checkpoint } = apply(checkpoint, {
      kind: "receipt",
      receipt: rejection(
        "rejected-2",
        ["item:2", "item:1"],
        ["Item is locked"],
      ),
    }));
    ({ checkpoint } = apply(checkpoint, {
      kind: "receipt",
      receipt: rejection("rejected-3", ["item:3"], []),
    }));

    const task = find(checkpoint, "tag");
    assert.equal(task.status, "pending");
    assert.deepEqual(task.exceptions, [
      { targets: ["item:1", "item:2"], reason: "Item is locked" },
      { targets: ["item:3"], reason: "Not applied" },
    ]);
    assert.deepEqual(task.verifiedReceiptIds, []);
    assert.notProperty(task, "doneTargets");
    assert.lengthOf(checkpoint.tasks, 1);
  });

  it("receipt: a failed or cancelled write leaves the status as it was and records why", function () {
    const ledger = ledgerWith(saveNote, tagAny);
    const failed = apply(ledger, {
      kind: "receipt",
      receipt: failedWrite("receipt-failed", [" Note not found "]),
    });
    assert.isTrue(failed.changed);
    const save = find(failed.checkpoint, "save");
    assert.equal(save.status, "pending");
    assert.equal(save.reason, "Note not found");
    assert.deepEqual(save.receiptIds, ["receipt-failed"]);
    assert.deepEqual(save.verifiedReceiptIds, []);

    const cancelled = apply(ledger, {
      kind: "receipt",
      receipt: receipt({
        id: "receipt-cancelled",
        capability: "zotero.tags",
        operation: "apply_tags",
        verification: "not_applicable",
        status: "cancelled",
        requestedTargets: ["item:4"],
        appliedTargets: [],
        rejectedTargets: ["item:4"],
      }),
    }).checkpoint;
    const tag = find(cancelled, "tag");
    assert.equal(tag.status, "pending");
    assert.equal(tag.reason, WRITE_FAILED);
    assert.deepEqual(tag.exceptions, [
      { targets: ["item:4"], reason: "Not applied" },
    ]);

    const blocked = apply(
      ledgerWith(saveNote),
      declineNote("call-1"),
    ).checkpoint;
    const stillBlocked = find(
      apply(blocked, {
        kind: "receipt",
        receipt: failedWrite("receipt-failed", ["Note not found"]),
      }).checkpoint,
      "save",
    );
    assert.equal(stillBlocked.status, "blocked");
    assert.equal(stillBlocked.reason, "Note not found");
  });

  it("receipt: a verified retry completes an outcome an unverified write or a decline blocked, and drops the reason", function () {
    const uncertain = apply(ledgerWith(saveNote), {
      kind: "receipt",
      receipt: receipt({
        id: "receipt-uncertain",
        verification: "unverified",
        status: "unverified",
        appliedTargets: [],
      }),
    }).checkpoint;
    assert.equal(find(uncertain, "save").reason, UNVERIFIED);
    const refused = apply(
      ledgerWith(saveNote),
      declineNote("call-1"),
    ).checkpoint;
    assert.equal(find(refused, "save").reason, DECLINED);

    for (const blocked of [uncertain, refused]) {
      assert.equal(find(blocked, "save").status, "blocked");
      const { checkpoint, changed } = apply(blocked, {
        kind: "receipt",
        receipt: receipt({ id: "receipt-retry" }),
      });
      assert.isTrue(changed);
      assert.lengthOf(checkpoint.tasks, 1, "no host outcome for the retry");
      const task = find(checkpoint, "save");
      assert.equal(task.status, "completed");
      assert.notProperty(task, "reason");
      assert.include(task.verifiedReceiptIds, "receipt-retry");
      assert.equal(
        decideRunEnd(checkpoint, {
          status: "completed",
          stopRule: "final_answer",
        }),
        "completed",
      );
    }
  });

  it("receipt: an execution-only receipt completes the outcome but is never recorded as verified", function () {
    const command = receipt({
      id: "command_execute:abc:unmatched:result",
      capability: "command.execute",
      operation: "command_execute",
      proofDomain: "execution",
      verification: "execution_only",
      status: "observed",
      requestedTargets: [],
      appliedTargets: [],
    });
    const hosted = apply(emptyLedger(), {
      kind: "receipt",
      receipt: command,
    }).checkpoint;
    assert.equal(hosted.tasks[0].status, "completed");
    assert.equal(hosted.tasks[0].description, "Ran command");
    assert.deepEqual(hosted.tasks[0].verifiedReceiptIds, []);
    assert.deepEqual(hosted.tasks[0].receiptIds, [command.id]);
    assert.equal(
      decideRunEnd(hosted, { status: "completed", stopRule: "final_answer" }),
      "completed",
    );

    const declared = apply(
      ledgerWith({
        taskId: "run",
        description: "Run the conversion",
        effect: "mutation",
        capability: "command.execute",
      }),
      { kind: "receipt", receipt: command },
    ).checkpoint;
    assert.equal(find(declared, "run").status, "completed");
    assert.deepEqual(find(declared, "run").verifiedReceiptIds, []);
  });

  it("receipt: binds every matching targeted outcome, before any untargeted one, with its own targets, and ignores targets none of them names", function () {
    const ledger = ledgerWith(
      { ...tagAny, taskId: "tag-any" },
      {
        taskId: "tag-a",
        description: "Tag Smith and Jones",
        effect: "mutation",
        capability: "zotero.tags",
        targets: ["item:1", "item:2"],
      },
      {
        taskId: "tag-b",
        description: "Tag Lee",
        effect: "mutation",
        capability: "zotero.tags",
        targets: ["item:3"],
      },
    );
    const { checkpoint } = apply(ledger, {
      kind: "receipt",
      receipt: receipt({
        id: "receipt-tags",
        capability: "zotero.tags",
        operation: "apply_tags",
        status: "partial",
        requestedTargets: ["item:1", "item:2", "item:3", "item:9"],
        appliedTargets: ["item:1", "item:3", "item:9"],
        rejectedTargets: ["item:2"],
        reasons: ["Item is locked"],
      }),
    });

    assert.lengthOf(checkpoint.tasks, 3, "no outcome for item:9");
    const a = find(checkpoint, "tag-a");
    assert.equal(a.status, "completed");
    assert.deepEqual(a.doneTargets, ["item:1"]);
    assert.deepEqual(a.exceptions, [
      { targets: ["item:2"], reason: "Item is locked" },
    ]);
    assert.deepEqual(a.verifiedReceiptIds, ["receipt-tags"]);
    const b = find(checkpoint, "tag-b");
    assert.equal(b.status, "completed");
    assert.deepEqual(b.doneTargets, ["item:3"]);
    assert.notProperty(b, "exceptions");
    assert.deepEqual(b.verifiedReceiptIds, ["receipt-tags"]);
    assert.equal(find(checkpoint, "tag-any").status, "pending");
  });

  it("receipt: with no targeted match it binds only the first untargeted outcome", function () {
    const ledger = ledgerWith(
      {
        taskId: "tag-a",
        description: "Tag Smith",
        effect: "mutation",
        capability: "zotero.tags",
        targets: ["item:1"],
      },
      { ...tagAny, taskId: "tag-first", description: "Tag one paper" },
      { ...tagAny, taskId: "tag-second", description: "Tag another paper" },
    );
    const { checkpoint } = apply(ledger, {
      kind: "receipt",
      receipt: receipt({
        id: "receipt-tags",
        capability: "zotero.tags",
        operation: "apply_tags",
        requestedTargets: ["item:5"],
        appliedTargets: ["item:5"],
      }),
    });
    assert.deepEqual(
      checkpoint.tasks.map((task) => task.status),
      ["pending", "completed", "pending"],
    );
    assert.deepEqual(find(checkpoint, "tag-first").doneTargets, ["item:5"]);
  });

  it("receipt: with no candidate it appends a host outcome and applies the row to it", function () {
    const rawId = "proposal-1:obligation-1:sha256:abc";
    const { checkpoint, changed } = apply(emptyLedger(), {
      kind: "receipt",
      receipt: receipt({
        id: rawId,
        requestedTargets: ["item:7"],
        appliedTargets: ["item:7"],
      }),
    });

    assert.isTrue(changed);
    assert.lengthOf(checkpoint.tasks, 1);
    const task = checkpoint.tasks[0];
    assert.equal(
      task.taskId,
      taskId("host-proposal-1-obligation-1-sha256-abc"),
    );
    assert.equal(task.origin, "host");
    assert.equal(task.effect, "mutation");
    assert.equal(task.capability, "zotero.notes");
    assert.equal(task.operation, "note_create");
    assert.equal(task.description, "Created note");
    assert.deepEqual(task.targets, ["item:7"]);
    assert.deepEqual(task.doneTargets, ["item:7"]);
    assert.equal(task.status, "completed");
    assert.deepEqual(task.verifiedReceiptIds, [rawId]);
    assert.equal(task.createdAt, 30);
  });

  it("receipt: derives a valid, distinct host task id from any receipt id", function () {
    const ids = [
      "file_write:fallback:/Users/me/My Notes/a b.md",
      "file_write:fallback:/Users/me/My Notes/a:b.md",
      `${"proposal-".repeat(20)}:obligation:sha256:${"f".repeat(64)}`,
      `${"proposal-".repeat(20)}:obligation:sha256:${"e".repeat(64)}`,
    ];
    let checkpoint = emptyLedger();
    for (const id of ids) {
      checkpoint = apply(checkpoint, {
        kind: "receipt",
        receipt: receipt({
          id,
          capability: "file.write",
          operation: "file_write",
          proofDomain: "file_state",
          requestedTargets: [`file:${id}`],
          appliedTargets: [`file:${id}`],
        }),
      }).checkpoint;
    }

    assert.lengthOf(checkpoint.tasks, ids.length);
    assert.lengthOf(
      new Set(checkpoint.tasks.map((task) => task.taskId)),
      ids.length,
    );
    for (const [index, task] of checkpoint.tasks.entries()) {
      assert.strictEqual(
        ordinaryExecutionTaskId("execution-direct-1", task.taskId),
        task.taskId,
      );
      assert.match(task.taskId, /^execution-direct-1:task:host-/);
      assert.deepEqual(task.verifiedReceiptIds, [ids[index]]);
      assert.equal(task.description, "Wrote file");
    }
  });

  it("receipt: a read receipt is not a write, so it binds nothing and creates nothing", function () {
    const ledger = ledgerWith({
      taskId: "write",
      description: "Make the change",
      effect: "mutation",
    });
    const { checkpoint, changed } = apply(ledger, {
      kind: "receipt",
      receipt: receipt({
        id: "read_full:0:unmatched:result",
        capability: "zotero.read",
        operation: "read_full",
        status: "observed",
        requestedTargets: [],
        appliedTargets: [],
        verifiedFacts: ["read_mode:full"],
      }),
    });
    assert.isFalse(changed);
    assert.strictEqual(checkpoint, ledger);
  });

  it("material: without taskId or a kind match it completes the first pending artifact outcome", function () {
    const ledger = ledgerWith(
      {
        taskId: "draft",
        description: "Write the synthesis",
        effect: "artifact",
      },
      {
        taskId: "second",
        description: "Write a second draft",
        effect: "artifact",
      },
    );
    const { checkpoint, changed } = apply(ledger, {
      kind: "material",
      materialRef: material,
    });
    assert.isTrue(changed);
    assert.equal(find(checkpoint, "draft").status, "completed");
    assert.deepEqual(find(checkpoint, "draft").materialRefs, [material]);
    assert.equal(find(checkpoint, "second").status, "pending");
  });

  it("material: binds to the part named by taskId", function () {
    const ledger = ledgerWith(
      {
        taskId: "summaries",
        description: "Per-paper summaries",
        effect: "artifact",
        targets: ["item:1", "item:2"],
      },
      {
        taskId: "review",
        description: "Write the literature review",
        effect: "artifact",
        targets: ["item:1", "item:2"],
      },
    );
    const { checkpoint } = apply(ledger, {
      kind: "material",
      materialRef: material,
      taskId: "review",
      documentKind: "literature_review",
      citedTargets: ["item:1", "item:2"],
    });
    assert.equal(find(checkpoint, "summaries").status, "pending");
    assert.equal(find(checkpoint, "review").status, "completed");
    assert.deepEqual(find(checkpoint, "review").doneTargets, [
      "item:1",
      "item:2",
    ]);
    assert.isUndefined(find(checkpoint, "review").exceptions);
    assert.deepEqual(find(checkpoint, "review").materialRefs, [material]);
  });

  it("material: without taskId it binds to the pending artifact part whose description matches the document kind", function () {
    const ledger = ledgerWith(
      {
        taskId: "summaries",
        description: "Per-paper summaries",
        effect: "artifact",
      },
      {
        taskId: "review",
        description: "Write the literature review",
        effect: "artifact",
      },
    );
    const { checkpoint } = apply(ledger, {
      kind: "material",
      materialRef: material,
      documentKind: "literature_review",
    });
    assert.equal(find(checkpoint, "summaries").status, "pending");
    assert.equal(find(checkpoint, "review").status, "completed");
  });

  it("material: a taskId naming no part, or malformed, falls back to the kind match", function () {
    const ledger = ledgerWith(
      {
        taskId: "summaries",
        description: "Per-paper summaries",
        effect: "artifact",
      },
      {
        taskId: "review",
        description: "Write the literature review",
        effect: "artifact",
      },
    );
    for (const named of ["nonexistent", "the review part"]) {
      const { checkpoint } = apply(ledger, {
        kind: "material",
        materialRef: material,
        taskId: named,
        documentKind: "literature_review",
      });
      assert.equal(find(checkpoint, "summaries").status, "pending", named);
      assert.equal(find(checkpoint, "review").status, "completed", named);
    }
  });

  it("material: a taskId naming a completed artifact part binds a revision to it, re-covers the papers it cites, and leaves the other parts alone", function () {
    const ledger = ledgerWith(
      {
        taskId: "summaries",
        description: "Per-paper summaries",
        effect: "artifact",
        targets: ["item:1", "item:2"],
      },
      {
        taskId: "review",
        description: "Write the literature review",
        effect: "artifact",
        targets: ["item:1", "item:2"],
      },
    );
    const first = apply(ledger, {
      kind: "material",
      materialRef: material,
      taskId: "review",
      citedTargets: ["item:1"],
    }).checkpoint;
    const revision = {
      ...material,
      documentVersion: 3,
      contentHash: "sha256:v3",
    };
    const { checkpoint, changed } = apply(first, {
      kind: "material",
      materialRef: revision,
      taskId: "review",
      documentKind: "literature_review",
      citedTargets: ["item:1", "item:2"],
    });
    assert.isTrue(changed);
    assert.equal(find(checkpoint, "summaries").status, "pending");
    assert.deepEqual(find(checkpoint, "summaries").materialRefs, []);
    const review = find(checkpoint, "review");
    assert.equal(review.status, "completed");
    assert.deepEqual(review.materialRefs, [material, revision]);
    // The revision cites item:2 too, so it is done and no longer excepted.
    assert.deepEqual(review.doneTargets, ["item:1", "item:2"]);
    assert.notProperty(review, "exceptions");
  });

  it("material: a revision that still leaves a paper uncited keeps it excepted, and a paper once covered stays done", function () {
    const ledger = ledgerWith({
      taskId: "review",
      description: "Write the literature review",
      effect: "artifact",
      targets: ["item:1", "item:2", "item:3"],
    });
    const first = apply(ledger, {
      kind: "material",
      materialRef: material,
      taskId: "review",
      citedTargets: ["item:1"],
    }).checkpoint;
    const { checkpoint } = apply(first, {
      kind: "material",
      materialRef: {
        ...material,
        documentVersion: 3,
        contentHash: "sha256:v3",
      },
      taskId: "review",
      citedTargets: ["item:2"],
    });
    const review = find(checkpoint, "review");
    assert.deepEqual(review.doneTargets, ["item:1", "item:2"]);
    assert.deepEqual(review.exceptions, [
      { targets: ["item:3"], reason: OUTCOME_REASONS.notCovered },
    ]);
  });

  it("material: an untagged document of the kind a part already holds binds to that part as a revision, never to the first pending artifact part", function () {
    const ledger = ledgerWith(
      {
        taskId: "summaries",
        description: "Per-paper summaries",
        effect: "artifact",
        targets: ["item:1", "item:2"],
      },
      {
        taskId: "review",
        description: "Write the literature review",
        effect: "artifact",
        targets: ["item:1", "item:2"],
      },
    );
    const first = apply(ledger, {
      kind: "material",
      materialRef: material,
      taskId: "review",
      documentKind: "literature_review",
      citedTargets: ["item:1"],
    }).checkpoint;
    const revised = {
      ...material,
      documentId: "document-2",
      contentHash: "sha256:revised",
    };
    const { checkpoint, changed } = apply(first, {
      kind: "material",
      materialRef: revised,
      documentKind: "literature_review",
      citedTargets: ["item:1", "item:2"],
    });
    assert.isTrue(changed);
    const summaries = find(checkpoint, "summaries");
    assert.equal(summaries.status, "pending");
    assert.deepEqual(summaries.materialRefs, []);
    const review = find(checkpoint, "review");
    assert.deepEqual(review.materialRefs, [material, revised]);
    assert.deepEqual(review.doneTargets, ["item:1", "item:2"]);
    assert.notProperty(review, "exceptions");
  });

  it("material: a taskId naming a part that is not an artifact binds nothing", function () {
    const ledger = ledgerWith(saveNote, {
      taskId: "review",
      description: "Write the literature review",
      effect: "artifact",
    });
    const result = apply(ledger, {
      kind: "material",
      materialRef: material,
      taskId: "save",
      documentKind: "literature_review",
      citedTargets: [],
    });
    assert.isFalse(result.changed);
    assert.strictEqual(result.checkpoint, ledger);
  });

  it("material: two documents, each naming its own part, complete each part with its own papers", function () {
    const ledger = ledgerWith(
      {
        taskId: "summaries",
        description: "Per-paper summaries",
        effect: "artifact",
        targets: ["item:1", "item:2"],
      },
      {
        taskId: "review",
        description: "Write the literature review",
        effect: "artifact",
        targets: ["item:1", "item:2"],
      },
    );
    const summaries = { ...material, documentId: "document-summaries" };
    const review = { ...material, documentId: "document-review" };
    const afterReview = apply(ledger, {
      kind: "material",
      materialRef: review,
      taskId: "review",
      documentKind: "literature_review",
      citedTargets: ["item:1", "item:2"],
    }).checkpoint;
    assert.equal(find(afterReview, "summaries").status, "pending");
    const { checkpoint } = apply(afterReview, {
      kind: "material",
      materialRef: summaries,
      taskId: "summaries",
      documentKind: "report",
      citedTargets: ["item:2"],
    });
    assert.deepEqual(find(checkpoint, "review").materialRefs, [review]);
    assert.deepEqual(find(checkpoint, "review").doneTargets, [
      "item:1",
      "item:2",
    ]);
    assert.deepEqual(find(checkpoint, "summaries").materialRefs, [summaries]);
    assert.deepEqual(find(checkpoint, "summaries").doneTargets, ["item:2"]);
    assert.deepEqual(find(checkpoint, "summaries").exceptions, [
      { targets: ["item:1"], reason: OUTCOME_REASONS.notCovered },
    ]);
  });

  it("coverage: unknown cited targets complete a targeted artifact part whole; an empty list excepts every target", function () {
    const ledger = ledgerWith({
      taskId: "summaries",
      description: "Summaries",
      effect: "artifact",
      targets: ["item:1", "item:2"],
    });
    const whole = find(
      apply(ledger, { kind: "material", materialRef: material }).checkpoint,
      "summaries",
    );
    assert.equal(whole.status, "completed");
    assert.isUndefined(whole.exceptions);
    const none = find(
      apply(ledger, {
        kind: "material",
        materialRef: material,
        citedTargets: [],
      }).checkpoint,
      "summaries",
    );
    assert.equal(none.status, "completed");
    assert.deepEqual(none.doneTargets, []);
    assert.deepEqual(none.exceptions, [
      { targets: ["item:1", "item:2"], reason: OUTCOME_REASONS.notCovered },
    ]);
  });

  it("material: a targeted part the document cites only partly completes with an exception for the rest", function () {
    const ledger = ledgerWith({
      taskId: "review",
      description: "Review",
      effect: "artifact",
      targets: ["item:1", "item:2", "item:3"],
    });
    const { checkpoint } = apply(ledger, {
      kind: "material",
      materialRef: material,
      taskId: "review",
      citedTargets: ["item:1", "item:3", "item:9"],
    });
    const task = find(checkpoint, "review");
    assert.equal(task.status, "completed");
    assert.deepEqual(task.doneTargets, ["item:1", "item:3"]);
    assert.deepEqual(task.exceptions, [
      { targets: ["item:2"], reason: OUTCOME_REASONS.notCovered },
    ]);
    assert.equal(
      decideRunEnd(checkpoint, {
        status: "completed",
        stopRule: "final_answer",
      }),
      "completed_with_exceptions",
    );
  });

  it("answer: an artifact part is delivered only as a document or a note, never by the answer", function () {
    for (const declaration of [
      {
        taskId: "summaries",
        description: "Summaries",
        effect: "artifact",
        targets: ["item:1", "item:2"],
      },
      { taskId: "summaries", description: "Summaries", effect: "artifact" },
    ] as OutcomeDeclaration[]) {
      const ledger = ledgerWith(declaration);
      for (const evidence of [
        { kind: "answer" },
        { kind: "answer", citedTargets: ["item:2"] },
        { kind: "answer", citedTargets: [] },
      ] as OutcomeEvidence[]) {
        const result = apply(ledger, evidence);
        assert.isFalse(result.changed);
        assert.strictEqual(result.checkpoint, ledger);
        assert.equal(find(result.checkpoint, "summaries").status, "pending");
      }
      assert.lengthOf(openDeclaredOutcomes(ledger), 1);
    }
    const untargeted = ledgerWith({
      taskId: "answer",
      description: "Answer",
      effect: "answer",
    });
    assert.equal(
      find(apply(untargeted, { kind: "answer" }).checkpoint, "answer").status,
      "completed",
    );
  });

  it("mark: refuses a skip that claims delivery for a part with no evidence", function () {
    const ledger = ledgerWith({
      taskId: "review",
      description: "Review",
      effect: "artifact",
    });
    const result = markOutcomes(
      ledger,
      [
        {
          taskId: taskId("review"),
          status: "skipped",
          reason: "Already delivered in this conversation",
        },
      ],
      30,
    );
    assert.strictEqual(result.checkpoint, ledger);
    assert.deepEqual(
      result.refused.map((entry) => entry.taskId),
      [taskId("review")],
    );
    assert.equal(find(ledger, "review").status, "pending");
    const bound = apply(ledger, {
      kind: "material",
      materialRef: material,
      taskId: "review",
    }).checkpoint;
    const accepted = markOutcomes(
      bound,
      [
        {
          taskId: taskId("review"),
          status: "skipped",
          reason: "Already delivered",
        },
      ],
      31,
    );
    assert.lengthOf(accepted.refused, 0);
  });

  it("mark: refuses a rephrased delivery claim on an artifact part with no evidence", function () {
    const ledger = ledgerWith({
      taskId: "review",
      description: "Review",
      effect: "artifact",
    });
    for (const reason of ["Delivered above", "See the review"]) {
      const result = markOutcomes(
        ledger,
        [{ taskId: "review", status: "skipped", reason }],
        30,
      );
      assert.strictEqual(result.checkpoint, ledger, reason);
      assert.deepEqual(
        result.refused.map((entry) => entry.taskId),
        [taskId("review")],
        reason,
      );
    }
  });

  it("mark: accepts a skip whose reason is the user's own instruction", function () {
    // User instructions come first (2026-10-31): the open-parts correction
    // sends a part the user's instruction rules out to skipped, so a chat
    // answer or a source limit is a reason, not a delivery claim.
    for (const [part, reason] of [
      [
        {
          taskId: "review",
          description: "Review",
          effect: "artifact" as const,
        },
        "The user asked for an answer in chat, not a document",
      ],
      [
        {
          taskId: "summaries",
          description: "Summarize each paper",
          effect: "digest" as const,
          targets: ["item:1"],
        },
        "The user asked for the abstracts only",
      ],
    ] as const) {
      const ledger = ledgerWith(part);
      const result = markOutcomes(
        ledger,
        [{ taskId: taskId(part.taskId), status: "skipped", reason }],
        30,
      );
      assert.lengthOf(result.refused, 0, reason);
      assert.equal(find(result.checkpoint, part.taskId).status, "skipped");
    }
  });

  it("mark: refuses a delivery-claiming skip on a digest part with no evidence", function () {
    const ledger = ledgerWith({
      taskId: "summaries",
      description: "Summarize each paper",
      effect: "digest",
      targets: ["item:1", "item:2"],
    });
    const result = markOutcomes(
      ledger,
      [
        {
          taskId: "summaries",
          status: "skipped",
          reason: "Already summarized above, see the answer",
        },
      ],
      30,
    );
    assert.strictEqual(result.checkpoint, ledger);
    assert.deepEqual(
      result.refused.map((entry) => entry.taskId),
      [taskId("summaries")],
    );
    // With a digested paper, the skip stands.
    const digested = apply(ledger, {
      kind: "digest",
      taskId: taskId("summaries"),
      done: ["item:1"],
      failed: [],
    }).checkpoint;
    const accepted = markOutcomes(
      digested,
      [{ taskId: "summaries", status: "skipped", reason: "Already done" }],
      31,
    );
    assert.lengthOf(accepted.refused, 0);
  });

  it("mark: accepts a delivery-worded skip on a mutation part", function () {
    const ledger = ledgerWith(saveNote);
    const result = markOutcomes(
      ledger,
      [
        {
          taskId: "save",
          status: "skipped",
          reason: "The note was previously created in an earlier session",
        },
      ],
      30,
    );
    assert.lengthOf(result.refused, 0);
    assert.equal(find(result.checkpoint, "save").status, "skipped");
  });

  it("mark: a skip with an ordinary reason is still accepted without evidence", function () {
    const ledger = ledgerWith({
      taskId: "review",
      description: "Review",
      effect: "artifact",
    });
    const result = markOutcomes(
      ledger,
      [{ taskId: "review", status: "skipped", reason: "User changed scope" }],
      30,
    );
    assert.lengthOf(result.refused, 0);
    assert.equal(find(result.checkpoint, "review").status, "skipped");
  });

  it("material: with no artifact outcome it creates nothing", function () {
    for (const ledger of [emptyLedger(), ledgerWith(saveNote)]) {
      const result = apply(ledger, { kind: "material", materialRef: material });
      assert.isFalse(result.changed);
      assert.strictEqual(result.checkpoint, ledger);
    }
  });

  it("declined: blocks the matching pending or in-progress mutation outcome", function () {
    const inProgress: ExecutionCheckpointTask = {
      ...legacyTask("tag", { status: "in_progress" }),
      effect: "mutation",
      origin: "model",
      capability: "zotero.tags",
    };
    const ledger = withTasks(ledgerWith(saveNote), inProgress);

    const notes = apply(ledger, declineNote("call-note"));
    assert.isTrue(notes.changed);
    const save = find(notes.checkpoint, "save");
    assert.equal(save.status, "blocked");
    assert.equal(save.reason, DECLINED);
    assert.deepEqual(save.receiptIds, ["declined:call-note"]);
    assert.equal(find(notes.checkpoint, "tag").status, "in_progress");

    const tags = apply(
      notes.checkpoint,
      declined("call-tags", {
        capability: "zotero.tags",
        operation: "apply_tags",
        requestedTargets: ["item:4"],
      }),
    );
    assert.equal(find(tags.checkpoint, "tag").status, "blocked");
    assert.equal(find(tags.checkpoint, "tag").reason, DECLINED);
    assert.lengthOf(tags.checkpoint.tasks, 2);
  });

  it("declined: with no candidate it appends a blocked host outcome, numbered in order", function () {
    const first = apply(
      emptyLedger(),
      declined(
        "call-1",
        {
          capability: "zotero.tags",
          operation: "apply_tags",
          requestedTargets: ["item:1", "item:2"],
        },
        {
          capability: "zotero.tags",
          operation: "apply_tags",
          requestedTargets: ["item:2", "item:3"],
        },
      ),
    );
    assert.isTrue(first.changed);
    assert.deepEqual(first.checkpoint.tasks[0], {
      taskId: taskId("host-declined-1"),
      // Nothing was added: the label names the work, not a result.
      description: "Add tags",
      dependencies: [],
      status: "blocked",
      journalActionIds: [],
      verifiedReceiptIds: [],
      readEvidenceIds: [],
      materialRefs: [],
      createdAt: 30,
      updatedAt: 30,
      effect: "mutation",
      origin: "host",
      capability: "zotero.tags",
      operation: "apply_tags",
      targets: ["item:1", "item:2", "item:3"],
      receiptIds: ["declined:call-1"],
      reason: DECLINED,
    });

    const second = apply(
      first.checkpoint,
      declined("call-2", {
        capability: "zotero.notes",
        operation: "save_note",
        requestedTargets: [],
      }),
    );
    assert.deepEqual(
      second.checkpoint.tasks.map((task) => [task.taskId, task.description]),
      [
        [taskId("host-declined-1"), "Add tags"],
        [taskId("host-declined-2"), "Save note"],
      ],
    );
    assert.notProperty(second.checkpoint.tasks[1], "targets");
  });

  it("declined: a later verified receipt for the declined write turns the label to the past tense", function () {
    const declinedOnce = apply(
      emptyLedger(),
      declined("call-script", {
        capability: "zotero.script",
        operation: "zotero_script_execute",
        requestedTargets: [],
      }),
    ).checkpoint;
    assert.equal(declinedOnce.tasks[0].description, "Run Zotero script");
    const ran = apply(declinedOnce, {
      kind: "receipt",
      receipt: receipt({
        id: "script-receipt",
        capability: "zotero.script",
        operation: "zotero_script_execute",
        proofDomain: "execution",
        verification: "verified",
        status: "applied",
        requestedTargets: [],
        appliedTargets: [],
      }),
    }).checkpoint;
    assert.lengthOf(ran.tasks, 1);
    assert.equal(ran.tasks[0].status, "completed");
    assert.equal(ran.tasks[0].description, "Ran Zotero script");
  });

  it("receipt: a write that did not apply names the intended work until a verified receipt", function () {
    const failed = apply(emptyLedger(), {
      kind: "receipt",
      receipt: failedWrite("note-failed", ["Zotero refused the note."]),
    }).checkpoint;
    assert.equal(failed.tasks[0].description, "Create note");
    assert.notEqual(failed.tasks[0].status, "completed");
    const saved = apply(failed, {
      kind: "receipt",
      receipt: receipt({ id: "note-saved" }),
    }).checkpoint;
    assert.lengthOf(saved.tasks, 1);
    assert.equal(saved.tasks[0].status, "completed");
    assert.equal(saved.tasks[0].description, "Created note");
  });

  it("declined: the same call declined again changes nothing", function () {
    const once = apply(ledgerWith(saveNote), declineNote("call-1"));
    const again = apply(once.checkpoint, declineNote("call-1"));
    assert.isFalse(again.changed);
    assert.strictEqual(again.checkpoint, once.checkpoint);

    const tags = {
      capability: "zotero.tags" as const,
      operation: "apply_tags" as const,
      requestedTargets: ["item:4"],
    };
    const hosted = apply(emptyLedger(), declined("call-2", tags)).checkpoint;
    const repeated = apply(hosted, declined("call-2", tags));
    assert.isFalse(repeated.changed);
    assert.strictEqual(repeated.checkpoint, hosted);
    const another = apply(hosted, declined("call-3", tags)).checkpoint;
    assert.deepEqual(
      another.tasks.map((task) => task.receiptIds),
      [["declined:call-2"], ["declined:call-3"]],
    );
  });

  it("answer: completes every pending answer outcome and nothing else", function () {
    const ledger = ledgerWith(
      {
        taskId: "explain",
        description: "Explain the method",
        effect: "answer",
      },
      {
        taskId: "compare",
        description: "Compare the results",
        effect: "answer",
      },
      saveNote,
    );
    const { checkpoint, changed } = apply(ledger, { kind: "answer" });
    assert.isTrue(changed);
    assert.deepEqual(
      checkpoint.tasks.map((task) => task.status),
      ["completed", "completed", "pending"],
    );
    const again = apply(checkpoint, { kind: "answer" });
    assert.isFalse(again.changed);
    assert.strictEqual(again.checkpoint, checkpoint);
  });
});

describe("outcome ledger: final gate inputs", function () {
  it("lists only the model's pending outcomes that need more than the answer", function () {
    let ledger = ledgerWith(
      saveNote,
      { taskId: "read", description: "Read it", effect: "read" },
      { taskId: "explain", description: "Explain it", effect: "answer" },
      { taskId: "draft", description: "Draft it", effect: "artifact" },
      { taskId: "tag", description: "Tag it", effect: "mutation" },
    );
    ledger = apply(ledger, {
      kind: "read",
      targets: ["item:1"],
      observationIds: ["obs-1"],
    }).checkpoint;
    ledger = markOutcomes(
      ledger,
      [{ taskId: "tag", status: "skipped", reason: "Not needed" }],
      40,
    ).checkpoint;
    ledger = apply(
      ledger,
      declined("call-trash", {
        capability: "zotero.trash",
        operation: "trash_items",
        requestedTargets: ["item:5"],
      }),
    ).checkpoint;
    ledger = withTasks(ledger, legacyTask("legacy"));

    assert.deepEqual(
      openDeclaredOutcomes(ledger).map((task) => task.taskId),
      [taskId("save"), taskId("draft")],
    );
    assert.deepEqual(openDeclaredOutcomes(undefined), []);
  });

  it("signs progress as each outcome's id, status and evidence counts, and its excluded papers", function () {
    const ledger = apply(
      ledgerWith(saveNote, {
        taskId: "read",
        description: "Read it",
        effect: "read",
      }),
      { kind: "read", targets: ["item:1"], observationIds: ["obs-1", "obs-2"] },
    ).checkpoint;
    assert.equal(
      outcomeProgressSignature(ledger),
      JSON.stringify([
        [taskId("save"), "pending", 0, 0, 0, 0, 0, 0],
        [taskId("read"), "completed", 1, 0, 0, 2, 0, 0],
      ]),
    );
    assert.equal(outcomeProgressSignature(undefined), "[]");
  });
});

describe("outcome ledger: run end state", function () {
  const INTERRUPTING: RunStopRule[] = [
    "interrupted_by_error",
    "incomplete_step_limit",
    "segment_without_progress",
    "repeated_tool_errors",
  ];

  function withProgress(): ExecutionCheckpoint {
    return apply(
      ledgerWith(
        { taskId: "read", description: "Read it", effect: "read" },
        saveNote,
      ),
      { kind: "read", targets: ["item:1"], observationIds: ["obs-1"] },
    ).checkpoint;
  }

  it("a cancelled run ends cancelled and keeps its open outcomes pending", function () {
    const ledger = apply(
      withProgress(),
      declined("call-tags", {
        capability: "zotero.tags",
        operation: "apply_tags",
        requestedTargets: ["item:3"],
      }),
    ).checkpoint;
    for (const stopRule of [
      "cancelled_in_flight",
      "cancelled_before_step",
    ] as RunStopRule[]) {
      assert.equal(
        decideRunEnd(ledger, { status: "cancelled", stopRule }),
        "cancelled",
      );
    }
    const settled = settleOutcomes(ledger, "cancelled", 50);
    assert.deepEqual(settled.end, { state: "cancelled" });
    assert.equal(find(settled, "save").status, "pending");
    assert.isUndefined(find(settled, "save").reason);
    assert.isUndefined(ledger.end);
  });

  it("any blocked outcome ends the run blocked", function () {
    // A write that ran and could not be verified: the user must check it.
    const blocked = apply(ledgerWith(saveNote), {
      kind: "receipt",
      receipt: receipt({
        id: "note-unverified",
        verification: "unverified",
        status: "unverified",
      }),
    }).checkpoint;
    assert.equal(find(blocked, "save").status, "blocked");
    assert.equal(find(blocked, "save").reason, OUTCOME_REASONS.unverified);
    assert.equal(
      decideRunEnd(blocked, { status: "completed", stopRule: "final_answer" }),
      "blocked",
    );
    assert.equal(
      decideRunEnd(blocked, {
        status: "failed",
        stopRule: "interrupted_by_error",
      }),
      "blocked",
    );
  });

  it("a completed run settles a declined write as skipped and ends completed with exceptions", function () {
    const blocked = apply(
      ledgerWith(saveNote),
      declineNote("call-note"),
    ).checkpoint;
    assert.equal(find(blocked, "save").status, "blocked");
    const settled = settleDeclinedOutcomes(blocked, 50);
    const save = find(settled, "save");
    assert.equal(save.status, "skipped");
    assert.equal(save.reason, DECLINED);
    assert.equal(save.updatedAt, 50);
    assert.equal(
      decideRunEnd(settled, { status: "completed", stopRule: "final_answer" }),
      "completed_with_exceptions",
    );
    assert.equal(
      settleOutcomes(settled, "completed_with_exceptions", 60).tasks[0].status,
      "skipped",
    );
    // A blocked part for another reason keeps holding the run.
    const unverified = apply(ledgerWith(saveNote), {
      kind: "receipt",
      receipt: receipt({
        id: "note-unverified",
        verification: "unverified",
        status: "unverified",
      }),
    }).checkpoint;
    assert.strictEqual(settleDeclinedOutcomes(unverified, 50), unverified);
  });

  it("a failed run that made progress under an interrupting rule ends interrupted and keeps its open outcomes pending", function () {
    const ledger = withProgress();
    for (const stopRule of INTERRUPTING) {
      assert.equal(
        decideRunEnd(ledger, { status: "failed", stopRule }),
        "interrupted",
        stopRule,
      );
    }
    const settled = settleOutcomes(ledger, "interrupted", 50);
    assert.deepEqual(settled.end, { state: "interrupted" });
    assert.equal(find(settled, "save").status, "pending");
    assert.equal(find(settled, "read").status, "completed");
  });

  it("any other failed run ends failed", function () {
    assert.equal(
      decideRunEnd(ledgerWith(saveNote), {
        status: "failed",
        stopRule: "interrupted_by_error",
      }),
      "failed",
      "no outcome has evidence",
    );
    assert.equal(
      decideRunEnd(undefined, {
        status: "failed",
        stopRule: "incomplete_step_limit",
      }),
      "failed",
    );
    assert.equal(
      decideRunEnd(withProgress(), {
        status: "failed",
        stopRule: "tool_action_failed",
      }),
      "failed",
      "not an interrupting rule",
    );
  });

  it("a resumable incident ends interrupted with or without outcome evidence", function () {
    for (const stopRule of [
      "budget_reached",
      "connection_lost",
      "prompt_budget_exceeded",
    ] as RunStopRule[]) {
      assert.equal(
        decideRunEnd(undefined, { status: "failed", stopRule }),
        "interrupted",
        stopRule,
      );
      assert.equal(
        decideRunEnd(ledgerWith(saveNote), { status: "failed", stopRule }),
        "interrupted",
        stopRule,
      );
    }
  });

  it("an answer written after the search ran out ends completed with exceptions", function () {
    assert.equal(
      decideRunEnd(undefined, {
        status: "completed",
        stopRule: "search_exhausted",
      }),
      "completed_with_exceptions",
    );
  });

  it("a completed run with an open, skipped or excepted outcome ends completed with exceptions", function () {
    const run = { status: "completed", stopRule: "final_answer" } as const;
    const open = withProgress();
    assert.equal(decideRunEnd(open, run), "completed_with_exceptions");

    const skippedRead = markOutcomes(
      ledgerWith(
        { taskId: "read", description: "Read it", effect: "read" },
        { taskId: "explain", description: "Explain it", effect: "answer" },
      ),
      [{ taskId: "read", status: "skipped", reason: "No PDF attached" }],
      40,
    ).checkpoint;
    assert.equal(
      decideRunEnd(apply(skippedRead, { kind: "answer" }).checkpoint, run),
      "completed_with_exceptions",
    );

    const excepted = apply(emptyLedger(), {
      kind: "receipt",
      receipt: receipt({
        id: "receipt-partial",
        status: "partial",
        requestedTargets: ["item:1", "item:2"],
        appliedTargets: ["item:1"],
        rejectedTargets: ["item:2"],
        reasons: ["Item is locked"],
      }),
    }).checkpoint;
    assert.equal(excepted.tasks[0].status, "completed");
    assert.equal(decideRunEnd(excepted, run), "completed_with_exceptions");

    const settled = settleOutcomes(open, "completed_with_exceptions", 50);
    assert.equal(find(settled, "save").status, "skipped");
    assert.equal(find(settled, "save").reason, NOT_DONE);
    assert.equal(find(settled, "save").updatedAt, 50);
    assert.equal(find(settled, "read").status, "completed");
    assert.deepEqual(settled.end, { state: "completed_with_exceptions" });
    assert.equal(settled.updatedAt, 50);
  });

  it("settling as completed with exceptions keeps a pending outcome's own reason", function () {
    const ledger = apply(ledgerWith(saveNote, tagAny), {
      kind: "receipt",
      receipt: failedWrite("receipt-failed", ["Note not found"]),
    }).checkpoint;
    const settled = settleOutcomes(ledger, "completed_with_exceptions", 60);
    assert.deepEqual(
      settled.tasks.map((task) => [task.status, task.reason]),
      [
        ["skipped", "Note not found"],
        ["skipped", NOT_DONE],
      ],
    );
  });

  it("otherwise the run ends completed", function () {
    const run = { status: "completed", stopRule: "final_answer" } as const;
    const done = apply(
      apply(withProgress(), { kind: "receipt", receipt: receipt() }).checkpoint,
      { kind: "answer" },
    ).checkpoint;
    assert.equal(decideRunEnd(done, run), "completed");
    assert.equal(decideRunEnd(undefined, run), "completed");
    assert.equal(decideRunEnd(emptyLedger(), run), "completed");
    const settled = settleOutcomes(emptyLedger(), "completed", 50);
    assert.deepEqual(settled.tasks, []);
    assert.deepEqual(settled.end, { state: "completed" });
  });
});

describe("outcome ledger: host reasons", function () {
  it("exports every reason the host writes as one frozen object", function () {
    assert.isTrue(Object.isFrozen(OUTCOME_REASONS));
    assert.deepEqual(
      { ...OUTCOME_REASONS },
      {
        markReasonRequired:
          "A skipped, blocked, or cancelled task needs the reason.",
        unverified: UNVERIFIED,
        declined: DECLINED,
        notApplied: "Not applied",
        notDone: NOT_DONE,
        writeFailed: WRITE_FAILED,
        noText: "No readable text",
        notCovered: "Not covered by the delivered content",
      },
    );
  });
});

describe("outcome ledger: review cases", function () {
  it("wrong target: a receipt for another item leaves the declared outcome open and adds a host outcome", function () {
    const { checkpoint } = apply(ledgerWith(saveNote), {
      kind: "receipt",
      receipt: receipt({
        id: "receipt-item-2",
        requestedTargets: ["item:2"],
        appliedTargets: ["item:2"],
      }),
    });
    assert.equal(find(checkpoint, "save").status, "pending");
    assert.deepEqual(find(checkpoint, "save").verifiedReceiptIds, []);
    const host = find(checkpoint, "host-receipt-item-2");
    assert.equal(host.status, "completed");
    assert.equal(host.origin, "host");
    assert.deepEqual(host.targets, ["item:2"]);
    assert.deepEqual(openDeclaredOutcomes(checkpoint), [
      find(checkpoint, "save"),
    ]);
  });

  it("partial batch: 8 of 10 applied completes with one exception, and the run ends completed with exceptions", function () {
    const requested = Array.from(
      { length: 10 },
      (_, index) => `item:${index + 1}`,
    );
    const { checkpoint } = apply(emptyLedger(), {
      kind: "receipt",
      receipt: receipt({
        id: "receipt-batch",
        capability: "zotero.metadata",
        operation: "update_metadata",
        status: "partial",
        requestedTargets: requested,
        appliedTargets: requested.slice(0, 8),
        rejectedTargets: requested.slice(8),
        reasons: ["In a group library you cannot edit"],
      }),
    });

    assert.lengthOf(checkpoint.tasks, 1);
    const host = checkpoint.tasks[0];
    assert.equal(host.status, "completed");
    assert.lengthOf(host.targets!, 10);
    assert.deepEqual(host.doneTargets, requested.slice(0, 8));
    assert.deepEqual(host.exceptions, [
      {
        targets: ["item:9", "item:10"],
        reason: "In a group library you cannot edit",
      },
    ]);
    assert.equal(
      decideRunEnd(checkpoint, {
        status: "completed",
        stopRule: "final_answer",
      }),
      "completed_with_exceptions",
    );
  });

  it("capability mismatch: a tags receipt does not close a declared note outcome", function () {
    const { checkpoint } = apply(ledgerWith(saveNote), {
      kind: "receipt",
      receipt: receipt({
        id: "receipt-tags",
        capability: "zotero.tags",
        operation: "apply_tags",
      }),
    });
    assert.equal(find(checkpoint, "save").status, "pending");
    assert.equal(
      find(checkpoint, "host-receipt-tags").description,
      "Added tags",
    );
  });

  it("unverified receipt: only a possibly applied change blocks, and the run ends blocked even when it completed", function () {
    const ledger = ledgerWith(saveNote);
    for (const verification of ["unverified", "verified"] as const) {
      const { checkpoint } = apply(ledger, {
        kind: "receipt",
        receipt: receipt({
          verification,
          status: "unverified",
          appliedTargets: [],
          rejectedTargets: ["item:1"],
          reasons: ["This note_create write could not be verified."],
        }),
      });
      const task = find(checkpoint, "save");
      assert.equal(task.status, "blocked");
      assert.equal(task.reason, UNVERIFIED);
      assert.deepEqual(task.doneTargets ?? [], []);
      assert.deepEqual(task.verifiedReceiptIds, []);
      assert.deepEqual(task.exceptions, [
        {
          targets: ["item:1"],
          reason: "This note_create write could not be verified.",
        },
      ]);
      assert.equal(
        decideRunEnd(checkpoint, {
          status: "completed",
          stopRule: "final_answer",
        }),
        "blocked",
      );
    }
    const failed = apply(ledger, {
      kind: "receipt",
      receipt: failedWrite("receipt-failed", ["Note not found"]),
    }).checkpoint;
    assert.equal(find(failed, "save").status, "pending", "a failure is not");
  });

  it("idempotence: the same receipt, read or material applied twice changes nothing the second time", function () {
    const declaredReceipt = apply(ledgerWith(saveNote), {
      kind: "receipt",
      receipt: receipt(),
    }).checkpoint;
    const repeated = apply(declaredReceipt, {
      kind: "receipt",
      receipt: receipt(),
    });
    assert.isFalse(repeated.changed);
    assert.strictEqual(repeated.checkpoint, declaredReceipt);

    const unverified = receipt({
      id: "receipt-unverified",
      verification: "unverified",
      status: "unverified",
      appliedTargets: [],
    });
    const blocked = apply(ledgerWith(saveNote), {
      kind: "receipt",
      receipt: unverified,
    }).checkpoint;
    const blockedAgain = apply(blocked, {
      kind: "receipt",
      receipt: unverified,
    });
    assert.isFalse(blockedAgain.changed, "no host outcome for a bound receipt");
    assert.lengthOf(blockedAgain.checkpoint.tasks, 1);

    const hosted = apply(emptyLedger(), {
      kind: "receipt",
      receipt: receipt(),
    }).checkpoint;
    const hostedAgain = apply(hosted, { kind: "receipt", receipt: receipt() });
    assert.isFalse(hostedAgain.changed);
    assert.lengthOf(hostedAgain.checkpoint.tasks, 1);

    const read: OutcomeEvidence = {
      kind: "read",
      targets: ["item:1"],
      observationIds: ["obs-1"],
    };
    const readOnce = apply(
      ledgerWith({ taskId: "read-1", description: "Read one", effect: "read" }),
      read,
    ).checkpoint;
    const later = frozen(
      declareOutcomes(
        readOnce,
        [{ taskId: "read-2", description: "Read another", effect: "read" }],
        40,
      ),
    );
    const readAgain = apply(later, read);
    assert.isFalse(readAgain.changed);
    assert.strictEqual(readAgain.checkpoint, later);
    assert.equal(find(readAgain.checkpoint, "read-2").status, "pending");

    const drafts = ledgerWith(
      { taskId: "draft-1", description: "Draft one", effect: "artifact" },
      { taskId: "draft-2", description: "Draft another", effect: "artifact" },
    );
    const materialOnce = apply(drafts, {
      kind: "material",
      materialRef: material,
    }).checkpoint;
    const materialAgain = apply(materialOnce, {
      kind: "material",
      materialRef: { ...material },
    });
    assert.isFalse(materialAgain.changed);
    assert.equal(find(materialAgain.checkpoint, "draft-2").status, "pending");
  });

  it("settling as completed with exceptions marks a still-pending outcome not done before the answer", function () {
    const ledger = apply(
      ledgerWith(saveNote, {
        taskId: "explain",
        description: "Explain it",
        effect: "answer",
      }),
      { kind: "answer" },
    ).checkpoint;
    const end = decideRunEnd(ledger, {
      status: "completed",
      stopRule: "final_answer",
    });
    assert.equal(end, "completed_with_exceptions");
    const settled = settleOutcomes(ledger, end, 60);
    assert.deepEqual(
      settled.tasks.map((task) => [task.status, task.reason]),
      [
        ["skipped", NOT_DONE],
        ["completed", undefined],
      ],
    );
    assert.equal(find(ledger, "save").status, "pending");
  });

  it("a restored task without an effect completes on the answer", function () {
    const ledger = withTasks(
      emptyLedger(),
      legacyTask("summary"),
      legacyTask("saved", {
        status: "completed",
        verifiedReceiptIds: ["receipt-old"],
      }),
    );
    const { checkpoint, changed } = apply(ledger, { kind: "answer" });
    assert.isTrue(changed);
    assert.equal(find(checkpoint, "summary").status, "completed");
    assert.equal(find(checkpoint, "saved").updatedAt, 5);
    assert.equal(
      decideRunEnd(checkpoint, {
        status: "completed",
        stopRule: "final_answer",
      }),
      "completed",
    );
  });

  it("the progress signature changes when a receipt binds, not when an unrelated read arrives", function () {
    const ledger = ledgerWith(saveNote);
    const before = outcomeProgressSignature(ledger);

    const read = apply(ledger, {
      kind: "read",
      targets: ["item:1"],
      observationIds: ["obs-1"],
    });
    assert.isFalse(read.changed);
    assert.equal(outcomeProgressSignature(read.checkpoint), before);

    const bound = apply(ledger, { kind: "receipt", receipt: receipt() });
    assert.notEqual(outcomeProgressSignature(bound.checkpoint), before);
  });
});

describe("outcome ledger: how models declare saves (live run, 2026-09-30)", function () {
  it("records a part that names a write capability as a write, whatever effect it claims", function () {
    const ledger = ledgerWith({
      taskId: "save",
      description: "Save the summary as a note",
      effect: "artifact",
      capability: "zotero.notes",
    });
    assert.equal(ledger.tasks[0].effect, "mutation");
    const bound = apply(ledger, { kind: "receipt", receipt: receipt() });
    assert.lengthOf(bound.checkpoint.tasks, 1, "no separate host outcome");
    assert.equal(bound.checkpoint.tasks[0].status, "completed");
    assert.lengthOf(openDeclaredOutcomes(bound.checkpoint), 0);
  });

  it("closes an artifact part with a verified note write when no write part takes it", function () {
    const ledger = ledgerWith({
      taskId: "summary",
      description: "Write the summary",
      effect: "artifact",
    });
    const bound = apply(ledger, { kind: "receipt", receipt: receipt() });
    assert.lengthOf(bound.checkpoint.tasks, 1, "no separate host outcome");
    assert.equal(bound.checkpoint.tasks[0].status, "completed");
    assert.deepEqual(bound.checkpoint.tasks[0].verifiedReceiptIds, [
      "receipt-1",
    ]);
  });

  it("closes an artifact part with the saved note a write part takes, not with the answer", function () {
    const ledger = ledgerWith(
      {
        taskId: "summary",
        description: "Write the summary",
        effect: "artifact",
      },
      { taskId: "save", description: "Save it", effect: "mutation" },
    );
    assert.isFalse(apply(ledger, { kind: "answer" }).changed);
    const saved = apply(ledger, { kind: "receipt", receipt: receipt() });
    assert.deepEqual(
      saved.checkpoint.tasks.map((task) => task.status),
      ["completed", "completed"],
    );
    assert.deepEqual(find(saved.checkpoint, "summary").verifiedReceiptIds, [
      "receipt-1",
    ]);
  });

  it("does not close a targeted artifact part with a saved note on only some of its papers", function () {
    const ledger = ledgerWith(
      {
        taskId: "review",
        description: "Write the review",
        effect: "artifact",
        targets: ["item:1", "item:2"],
      },
      {
        taskId: "notes",
        description: "Save a note on each paper",
        effect: "mutation",
        capability: "zotero.notes",
        targets: ["item:1", "item:2"],
      },
    );
    const saved = apply(ledger, { kind: "receipt", receipt: receipt() });
    assert.equal(find(saved.checkpoint, "review").status, "pending");
    assert.deepEqual(find(saved.checkpoint, "notes").doneTargets, ["item:1"]);
  });

  it("does not close an artifact part with a write that is not note content", function () {
    const ledger = ledgerWith({
      taskId: "summary",
      description: "Write the summary",
      effect: "artifact",
    });
    const bound = apply(ledger, {
      kind: "receipt",
      receipt: receipt({ capability: "zotero.tags", operation: "add_tags" }),
    });
    assert.equal(bound.checkpoint.tasks[0].status, "pending");
    assert.lengthOf(
      bound.checkpoint.tasks,
      2,
      "the tag write is its own outcome",
    );
  });
});

describe("outcome ledger: parts over the turn's paper scope", function () {
  const SCOPE = ["item:30", "item:10", "item:20"];
  const readScope: OutcomeDeclaration = {
    taskId: "read-all",
    description: "Read each paper in Drift",
    effect: "read",
    targets: SCOPE,
    scope: true,
  };
  const noteScope: OutcomeDeclaration = {
    taskId: "note-all",
    description: "Write a note on each paper in Drift",
    effect: "mutation",
    capability: "zotero.notes",
    targets: SCOPE,
    scope: true,
  };

  function textRead(
    targets: string[],
    observationIds: string[] = [],
  ): OutcomeEvidence {
    return { kind: "read", targets, observationIds };
  }

  it("records a scope-wide part with its papers in frozen order", function () {
    const task = find(ledgerWith(readScope), "read-all");
    assert.isTrue(task.scope);
    assert.deepEqual(task.targets, SCOPE);
    assert.equal(task.status, "pending");
    assert.notProperty(
      find(ledgerWith({ ...readScope, scope: undefined }), "read-all"),
      "scope",
      "only a scope-wide declaration is marked",
    );
  });

  it("keeps the frozen papers when the part is declared again over a changed scope", function () {
    const ledger = ledgerWith(readScope);
    assert.strictEqual(
      declareOutcomes(
        ledger,
        [{ ...readScope, targets: ["item:10", "item:40"] }],
        40,
      ),
      ledger,
    );
  });

  it("a resumed ledger keeps its frozen papers, and reads still tick them", function () {
    // Run events persist the ledger as JSON; continue restores that copy.
    const persisted = JSON.parse(
      JSON.stringify(
        apply(ledgerWith(readScope), textRead(["item:30"], ["obs-1"]))
          .checkpoint,
      ),
    ) as ExecutionCheckpoint;
    const resumed = frozen(
      declareOutcomes(
        persisted,
        [{ ...readScope, targets: ["item:10", "item:99"] }],
        50,
      ),
    );
    const task = find(resumed, "read-all");
    assert.deepEqual(task.targets, SCOPE);
    assert.isTrue(task.scope);
    assert.deepEqual(task.doneTargets, ["item:30"]);
    const next = apply(resumed, textRead(["item:10", "item:20"], ["obs-2"]));
    assert.equal(find(next.checkpoint, "read-all").status, "completed");
  });

  it("a read that returned a paper's text ticks it; the part completes when every paper is read", function () {
    const first = apply(
      ledgerWith(readScope),
      textRead(["item:10", "item:77"], ["obs-1"]),
    );
    const task = find(first.checkpoint, "read-all");
    assert.equal(task.status, "pending");
    assert.deepEqual(task.doneTargets, ["item:10"]);
    assert.deepEqual(task.readEvidenceIds, ["obs-1"]);
    const done = find(
      apply(first.checkpoint, textRead(["item:20", "item:30"], ["obs-2"]))
        .checkpoint,
      "read-all",
    );
    assert.equal(done.status, "completed");
    assert.deepEqual(done.doneTargets, ["item:10", "item:20", "item:30"]);
  });

  it("an abstract, an outline or a metadata row does not tick a part that names papers", function () {
    const ledger = ledgerWith(readScope, {
      taskId: "read-two",
      description: "Read both papers",
      effect: "read",
      targets: ["item:10", "item:20"],
    });
    const shallow = apply(ledger, {
      kind: "read",
      targets: [],
      shallow: ["item:10", "item:20", "item:30"],
      observationIds: ["obs-abstracts"],
    });
    assert.isFalse(shallow.changed);
    assert.strictEqual(shallow.checkpoint, ledger);
    assert.equal(
      outcomeProgressSignature(shallow.checkpoint),
      outcomeProgressSignature(ledger),
      "a shallow read is no progress on a part that names papers",
    );
  });

  it("a part that names no papers still completes on any read, an abstract included", function () {
    const ledger = ledgerWith({
      taskId: "look",
      description: "Look up papers on drift",
      effect: "read",
    });
    const { checkpoint } = apply(ledger, {
      kind: "read",
      targets: [],
      shallow: ["item:10"],
      observationIds: [],
    });
    const task = find(checkpoint, "look");
    assert.equal(task.status, "completed");
    assert.deepEqual(task.doneTargets, ["item:10"]);
  });

  it("finding that a paper has no text completes no part that names no papers", function () {
    const ledger = ledgerWith({
      taskId: "look",
      description: "Look up papers on drift",
      effect: "read",
    });
    const { changed } = apply(ledger, {
      kind: "read",
      targets: [],
      noText: ["item:10"],
      observationIds: [],
    });
    assert.isFalse(changed);
  });

  it("a paper the host reports has no readable text is excepted, and the part completes with the rest read", function () {
    const missing = apply(ledgerWith(readScope), {
      kind: "read",
      targets: ["item:10"],
      noText: ["item:30"],
      observationIds: ["obs-1"],
    });
    const open = find(missing.checkpoint, "read-all");
    assert.equal(open.status, "pending");
    assert.deepEqual(open.doneTargets, ["item:10"]);
    assert.deepEqual(open.exceptions, [
      { targets: ["item:30"], reason: OUTCOME_REASONS.noText },
    ]);
    const { checkpoint } = apply(
      missing.checkpoint,
      textRead(["item:20"], ["obs-2"]),
    );
    const task = find(checkpoint, "read-all");
    assert.equal(task.status, "completed");
    assert.deepEqual(task.exceptions, [
      { targets: ["item:30"], reason: OUTCOME_REASONS.noText },
    ]);
    assert.equal(
      decideRunEnd(checkpoint, {
        status: "completed",
        stopRule: "final_answer",
      }),
      "completed_with_exceptions",
    );
  });

  it("a paper read after it was excepted is done, not excepted", function () {
    const excepted = apply(ledgerWith(readScope), {
      kind: "read",
      targets: [],
      noText: ["item:30"],
      observationIds: ["obs-1"],
    }).checkpoint;
    const { checkpoint } = apply(
      excepted,
      textRead(["item:30", "item:10"], ["obs-2"]),
    );
    const task = find(checkpoint, "read-all");
    assert.equal(task.status, "pending");
    assert.deepEqual(task.doneTargets, ["item:30", "item:10"]);
    assert.notProperty(task, "exceptions");
  });

  it("a part none of whose papers has text is skipped with the reason", function () {
    const { checkpoint } = apply(
      ledgerWith({ ...readScope, targets: ["item:10", "item:20"] }),
      {
        kind: "read",
        targets: [],
        noText: ["item:10", "item:20"],
        observationIds: [],
      },
    );
    const task = find(checkpoint, "read-all");
    assert.equal(task.status, "skipped");
    assert.equal(task.reason, OUTCOME_REASONS.noText);
  });

  it("counts every excepted paper as progress", function () {
    const one = apply(ledgerWith(readScope), {
      kind: "read",
      targets: [],
      noText: ["item:10"],
      observationIds: [],
    }).checkpoint;
    const two = apply(one, {
      kind: "read",
      targets: [],
      noText: ["item:20"],
      observationIds: [],
    }).checkpoint;
    assert.notEqual(
      outcomeProgressSignature(two),
      outcomeProgressSignature(one),
    );
  });

  it("a read another part already holds still reaches a part declared after it", function () {
    // The read completed a part that names no papers before the scope part
    // was declared; replaying it (a back-fill, or a re-read the cache
    // answers) ticks the new part, and replaying it again changes nothing.
    const evidence = textRead(["item:10"], ["obs-1"]);
    const looked = apply(
      ledgerWith({ taskId: "look", description: "Look it up", effect: "read" }),
      evidence,
    ).checkpoint;
    const declared = frozen(declareOutcomes(looked, [readScope], 40));
    const replayed = apply(declared, evidence);
    assert.isTrue(replayed.changed);
    assert.deepEqual(find(replayed.checkpoint, "read-all").doneTargets, [
      "item:10",
    ]);
    const again = apply(replayed.checkpoint, evidence);
    assert.isFalse(again.changed);
  });

  it("a scope-wide write part closes paper by paper from the receipts", function () {
    const note = (id: string, target: string) =>
      receipt({
        id,
        requestedTargets: [target],
        appliedTargets: [target],
      });
    let ledger = ledgerWith(noteScope);
    ledger = apply(ledger, {
      kind: "receipt",
      receipt: note("r-10", "item:10"),
    }).checkpoint;
    ledger = apply(ledger, {
      kind: "receipt",
      receipt: note("r-30", "item:30"),
    }).checkpoint;
    let task = find(ledger, "note-all");
    assert.equal(task.status, "pending");
    assert.deepEqual(task.doneTargets, ["item:10", "item:30"]);
    assert.deepEqual(task.verifiedReceiptIds, ["r-10", "r-30"]);

    // A note on a paper outside the frozen scope is its own outcome.
    ledger = apply(ledger, {
      kind: "receipt",
      receipt: note("r-99", "item:99"),
    }).checkpoint;
    assert.lengthOf(ledger.tasks, 2);
    assert.deepEqual(find(ledger, "note-all").doneTargets, [
      "item:10",
      "item:30",
    ]);

    ledger = apply(ledger, {
      kind: "receipt",
      receipt: note("r-20", "item:20"),
    }).checkpoint;
    task = find(ledger, "note-all");
    assert.equal(task.status, "completed");
    assert.deepEqual(task.doneTargets, ["item:10", "item:30", "item:20"]);
  });
});

describe("outcome ledger: how models declare folder writes and imports (live run, 2026-10-01)", function () {
  type LiveTask = {
    taskId: string;
    description: string;
    expectedEffect: string;
    expectedCapability?: string;
    targetIds?: string[];
  };

  /** The parts task_update records from these arguments. */
  function declared(...tasks: LiveTask[]): ExecutionCheckpoint {
    return ledgerWith(
      ...tasks.map(
        (task): OutcomeDeclaration => ({
          taskId: task.taskId,
          description: task.description,
          effect: task.expectedEffect as OutcomeDeclaration["effect"],
          // task_update keeps only an action capability.
          ...(task.expectedCapability?.startsWith("zotero.")
            ? {
                capability: task.expectedCapability as AgentActionCapability,
              }
            : {}),
          ...(task.targetIds ? { targets: task.targetIds } : {}),
        }),
      ),
    );
  }

  function receiptsInto(
    ledger: ExecutionCheckpoint,
    receipts: readonly AgentActionReceipt[],
  ): ExecutionCheckpoint {
    return receipts.reduce(
      (current, entry) =>
        apply(current, { kind: "receipt", receipt: entry }).checkpoint,
      ledger,
    );
  }

  const ended = (ledger: ExecutionCheckpoint) =>
    decideRunEnd(ledger, { status: "completed", stopRule: "final_answer" });

  it("closes a rename part that names its folder by a bare id, and leaves the delete receipt to the delete part", function () {
    const ledger = declared(...RENAME_DELETE_FOLDER.taskUpdate.tasks);
    assert.deepEqual(
      find(ledger, "rename").targets,
      ["11"],
      "under zotero.collections a bare id may name an item or a folder",
    );
    const [rename, remove] = RENAME_DELETE_FOLDER.receipts;
    const after = receiptsInto(ledger, RENAME_DELETE_FOLDER.receipts);
    assert.lengthOf(after.tasks, 2, "no host outcome");
    assert.include(find(after, "rename"), { status: "completed" });
    assert.deepEqual(find(after, "rename").doneTargets, ["11"]);
    assert.deepEqual(find(after, "rename").verifiedReceiptIds, [rename.id]);
    assert.include(find(after, "delete"), { status: "completed" });
    assert.deepEqual(find(after, "delete").verifiedReceiptIds, [remove.id]);
    assert.equal(ended(after), "completed");
  });

  it("matches a bare id to the one target a receipt names with it, and not when it names two", function () {
    const ledger = declared({
      taskId: "file",
      description: "Add paper 5 to Drift",
      expectedEffect: "mutation",
      expectedCapability: "zotero.collections",
      targetIds: ["5"],
    });
    const move = (targets: string[]) =>
      receipt({
        id: `move-${targets.join("-")}`,
        capability: "zotero.collections",
        operation: "move_to_collection",
        requestedTargets: targets,
        appliedTargets: targets,
      });
    const moved = receiptsInto(ledger, [move(["item:5"])]);
    assert.include(find(moved, "file"), { status: "completed" });
    assert.deepEqual(find(moved, "file").doneTargets, ["5"]);
    const both = receiptsInto(ledger, [move(["item:5", "collection:5"])]);
    assert.equal(
      find(both, "file").status,
      "pending",
      "a receipt naming item 5 and folder 5 leaves the bare 5 unresolved",
    );
    assert.lengthOf(both.tasks, 2, "the write is its own host outcome");
  });

  it("still reads a bare id as an item under every other capability and in a read part", function () {
    const ledger = declared(
      {
        taskId: "tag",
        description: "Tag paper 11",
        expectedEffect: "mutation",
        expectedCapability: "zotero.tags",
        targetIds: ["11"],
      },
      {
        taskId: "read",
        description: "Read paper 11",
        expectedEffect: "read",
        targetIds: ["11"],
      },
    );
    assert.deepEqual(find(ledger, "tag").targets, ["item:11"]);
    assert.deepEqual(find(ledger, "read").targets, ["item:11"]);
  });

  it('leaves out a target no receipt can carry, such as "new collection" or a DOI', function () {
    const ledger = declared(...DISCOVER_IMPORT.taskUpdate.tasks, {
      taskId: "tag",
      description: "Tag the two papers",
      expectedEffect: "mutation",
      expectedCapability: "zotero.tags",
      targetIds: ["10.1101/2025.02.04.636428", "doi:10.1101/x", "item:517"],
    });
    assert.notProperty(find(ledger, "import"), "targets");
    assert.deepEqual(find(ledger, "tag").targets, ["item:517"]);
  });

  it("closes the import part with the import, and the search and folder parts as before", function () {
    const ledger = declared(...DISCOVER_IMPORT.taskUpdate.tasks);
    const [create, imported] = DISCOVER_IMPORT.receipts;
    const searched = apply(ledger, {
      kind: "read",
      targets: [],
      observationIds: ["obs-search"],
    }).checkpoint;
    const after = receiptsInto(searched, DISCOVER_IMPORT.receipts);
    assert.lengthOf(after.tasks, 3, "no host outcome");
    assert.deepEqual(
      after.tasks.map((task) => task.status),
      ["completed", "completed", "completed"],
    );
    assert.deepEqual(find(after, "collection").verifiedReceiptIds, [create.id]);
    assert.deepEqual(find(after, "import").verifiedReceiptIds, [imported.id]);
    assert.equal(ended(after), "completed");
  });

  it("closes a part asking for a folder's papers with the import that filed them there", function () {
    const imported = DISCOVER_IMPORT.receipts[1];
    for (const targetIds of [["9"], ["collection:9"], ["517", "519"]]) {
      const after = receiptsInto(
        declared(
          {
            taskId: "import",
            description: "Import the two papers",
            expectedEffect: "mutation",
            expectedCapability: "zotero.import",
          },
          {
            taskId: "file",
            description: "File them in the new folder",
            expectedEffect: "mutation",
            expectedCapability: "zotero.collections",
            targetIds,
          },
        ),
        [imported],
      );
      assert.lengthOf(after.tasks, 2, JSON.stringify(targetIds));
      assert.deepEqual(
        after.tasks.map((task) => task.status),
        ["completed", "completed"],
        JSON.stringify(targetIds),
      );
      assert.deepEqual(find(after, "file").verifiedReceiptIds, [imported.id]);
    }
    const elsewhere = receiptsInto(
      declared({
        taskId: "file",
        description: "File them in Drift",
        expectedEffect: "mutation",
        expectedCapability: "zotero.collections",
        targetIds: ["collection:10"],
      }),
      [imported],
    );
    assert.equal(
      find(elsewhere, "file").status,
      "pending",
      "an import into folder 9 is no membership in folder 10",
    );
    const anyFolder = receiptsInto(
      declared({
        taskId: "file",
        description: "Put the imported papers in the new folder",
        expectedEffect: "mutation",
        expectedCapability: "zotero.collections",
      }),
      [imported],
    );
    assert.include(find(anyFolder, "file"), { status: "completed" });
    assert.lengthOf(anyFolder.tasks, 1, "no host outcome");
  });

  it("gives the membership only to a part that asks for folders or names it, never to a second vague part", function () {
    const vague = (taskId: string, description: string): LiveTask => ({
      taskId,
      description,
      expectedEffect: "mutation",
    });
    const after = receiptsInto(
      declared(
        vague("import", "Import the two papers"),
        vague("tag", "Tag them as drift"),
      ),
      [DISCOVER_IMPORT.receipts[1]],
    );
    assert.deepEqual(
      after.tasks.map((task) => task.status),
      ["completed", "pending"],
      "one import closes one part that names no capability",
    );
  });

  it("ends completed when the model marks skipped a part the import already did, and with exceptions when no receipt did", function () {
    const parts = (folder: string): LiveTask[] => [
      DISCOVER_IMPORT.taskUpdate.tasks[1],
      {
        taskId: "import",
        description: "Import the two papers",
        expectedEffect: "mutation",
        expectedCapability: "zotero.import",
      },
      {
        taskId: "file",
        description: "File them in the new folder",
        expectedEffect: "mutation",
        expectedCapability: "zotero.collections",
        targetIds: [folder],
      },
    ];
    const skip: OutcomeModelMark[] = [
      {
        taskId: "file",
        status: "skipped",
        reason: "The import already filed them in the folder.",
      },
    ];
    const done = receiptsInto(
      declared(...parts("9")),
      DISCOVER_IMPORT.receipts,
    );
    const marked = markOutcomes(done, skip, 40);
    assert.deepEqual(marked.ignored, [taskId("file")]);
    assert.include(find(marked.checkpoint, "file"), { status: "completed" });
    assert.equal(ended(marked.checkpoint), "completed");

    const unproven = markOutcomes(
      receiptsInto(
        declared(...parts("collection:10")),
        DISCOVER_IMPORT.receipts,
      ),
      skip,
      40,
    ).checkpoint;
    assert.include(find(unproven, "file"), { status: "skipped" });
    assert.equal(ended(unproven), "completed_with_exceptions");
  });
});

describe("outcome ledger: batches over a part's papers (reorganization)", function () {
  const PAPERS = ["item:1", "item:2", "item:3", "item:4", "item:5", "item:6"];
  const [BATCH_A, BATCH_B, BATCH_C] = [
    PAPERS.slice(0, 2),
    PAPERS.slice(2, 4),
    PAPERS.slice(4),
  ];
  const REFUSED =
    "Zotero refused the move (The current operation may have applied; inspect journal state before retrying.)";
  const moveAll: OutcomeDeclaration = {
    taskId: "move",
    description: "Move papers into the collections",
    effect: "mutation",
    capability: "zotero.collections",
    targets: PAPERS,
    scope: true,
  };

  function moved(id: string, targets: string[]): OutcomeEvidence {
    return {
      kind: "receipt",
      receipt: receipt({
        id,
        capability: "zotero.collections",
        operation: "move_to_collection",
        requestedTargets: targets,
        appliedTargets: targets,
      }),
    };
  }

  /** A batch that ran and threw, as `finalizeProposal` stamps it. */
  function failedMove(id: string, targets: string[]): OutcomeEvidence {
    return {
      kind: "receipt",
      receipt: receipt({
        id,
        capability: "zotero.collections",
        operation: "move_to_collection",
        verification: "unverified",
        status: "failed",
        requestedTargets: targets,
        appliedTargets: [],
        reasons: [REFUSED],
      }),
    };
  }

  /** A denied call: its cancelled receipt, then the decline, as the runtime records them. */
  function deniedMove(callId: string, targets: string[]): OutcomeEvidence[] {
    return [
      {
        kind: "receipt",
        receipt: receipt({
          id: `${callId}:receipt`,
          capability: "zotero.collections",
          operation: "move_to_collection",
          verification: "not_applicable",
          status: "cancelled",
          requestedTargets: targets,
          appliedTargets: [],
          reasons: ["User denied action"],
        }),
      },
      declined(callId, {
        capability: "zotero.collections",
        operation: "move_to_collection",
        requestedTargets: targets,
      }),
    ];
  }

  /** Rows the user left untouched in a card it approved. */
  function leftUntouched(callId: string, targets: string[]): OutcomeEvidence {
    return {
      kind: "declined",
      callId,
      proposals: [
        {
          capability: "zotero.collections",
          operation: "move_to_collection",
          requestedTargets: targets,
        },
      ],
      narrowed: true,
    };
  }

  function applyAll(
    checkpoint: ExecutionCheckpoint,
    ...evidence: OutcomeEvidence[]
  ): ExecutionCheckpoint {
    return evidence.reduce(
      (ledger, entry) => apply(ledger, entry).checkpoint,
      checkpoint,
    );
  }

  function endOf(checkpoint: ExecutionCheckpoint) {
    return decideRunEnd(checkpoint, {
      status: "completed",
      stopRule: "final_answer",
    });
  }

  it("each batch's receipt closes its own papers, and the last batch completes the part", function () {
    let ledger = applyAll(ledgerWith(moveAll), moved("batch-a", BATCH_A));
    let task = find(ledger, "move");
    assert.equal(task.status, "pending");
    assert.deepEqual(task.doneTargets, BATCH_A);

    ledger = applyAll(
      ledger,
      moved("batch-b", BATCH_B),
      moved("batch-c", BATCH_C),
    );
    task = find(ledger, "move");
    assert.equal(task.status, "completed");
    assert.deepEqual(task.doneTargets, PAPERS);
    assert.deepEqual(task.verifiedReceiptIds, [
      "batch-a",
      "batch-b",
      "batch-c",
    ]);
    assert.lengthOf(ledger.tasks, 1);
    assert.equal(endOf(ledger), "completed");
  });

  it("a declined batch excepts its papers and leaves the part open for the next batch", function () {
    let ledger = applyAll(
      ledgerWith(moveAll),
      moved("batch-a", BATCH_A),
      ...deniedMove("call-b", BATCH_B),
    );
    let task = find(ledger, "move");
    assert.equal(task.status, "pending", "one declined batch blocks nothing");
    assert.notProperty(task, "reason", "each paper's exception says why");
    assert.deepEqual(task.doneTargets, BATCH_A);
    assert.deepEqual(task.exceptions, [{ targets: BATCH_B, reason: DECLINED }]);
    assert.include(task.receiptIds, "declined:call-b");
    assert.deepEqual(openDeclaredOutcomes(ledger), [task]);

    ledger = applyAll(ledger, moved("batch-c", BATCH_C));
    task = find(ledger, "move");
    assert.equal(task.status, "completed");
    assert.notProperty(task, "reason");
    assert.deepEqual(task.doneTargets, [...BATCH_A, ...BATCH_C]);
    assert.deepEqual(task.exceptions, [{ targets: BATCH_B, reason: DECLINED }]);
    assert.lengthOf(ledger.tasks, 1, "no host outcome for the decline");
    assert.equal(endOf(ledger), "completed_with_exceptions");
  });

  it("a failed batch excepts its papers with the failure's reason, and the part completes with the rest", function () {
    let ledger = applyAll(
      ledgerWith(moveAll),
      moved("batch-a", BATCH_A),
      failedMove("batch-b", BATCH_B),
    );
    let task = find(ledger, "move");
    assert.equal(task.status, "pending");
    assert.notProperty(task, "reason", "each paper's exception says why");
    assert.deepEqual(task.exceptions, [{ targets: BATCH_B, reason: REFUSED }]);

    ledger = applyAll(ledger, moved("batch-c", BATCH_C));
    task = find(ledger, "move");
    assert.equal(task.status, "completed");
    assert.deepEqual(task.exceptions, [{ targets: BATCH_B, reason: REFUSED }]);
    assert.equal(endOf(ledger), "completed_with_exceptions");
  });

  it("a later success clears a paper's exception, even after the part settled", function () {
    const settledWithFailure = applyAll(
      ledgerWith(moveAll),
      moved("batch-a", BATCH_A),
      failedMove("batch-b", BATCH_B),
      moved("batch-c", BATCH_C),
    );
    assert.equal(find(settledWithFailure, "move").status, "completed");

    const retried = apply(settledWithFailure, moved("batch-b-retry", BATCH_B));
    assert.isTrue(retried.changed);
    assert.lengthOf(
      retried.checkpoint.tasks,
      1,
      "no host outcome for the retry",
    );
    const task = find(retried.checkpoint, "move");
    assert.equal(task.status, "completed");
    assert.notProperty(task, "exceptions");
    assert.deepEqual(task.doneTargets, [...BATCH_A, ...BATCH_C, ...BATCH_B]);
    assert.equal(endOf(retried.checkpoint), "completed");

    // A part every paper of which was excepted is skipped; a success revives it.
    const allFailed = applyAll(
      ledgerWith({ ...moveAll, targets: BATCH_A }),
      failedMove("batch-a", BATCH_A),
    );
    assert.equal(find(allFailed, "move").status, "skipped");
    assert.equal(find(allFailed, "move").reason, REFUSED);
    const revived = find(
      apply(allFailed, moved("batch-a-retry", BATCH_A)).checkpoint,
      "move",
    );
    assert.equal(revived.status, "completed");
    assert.notProperty(revived, "reason");
    assert.notProperty(revived, "exceptions");
  });

  it("rows the user left untouched in an approved card are excepted on the part that names them", function () {
    let ledger = applyAll(
      ledgerWith(moveAll),
      moved("batch-a", ["item:1"]),
      leftUntouched("call-a", ["item:2"]),
    );
    let task = find(ledger, "move");
    assert.equal(task.status, "pending");
    assert.deepEqual(task.doneTargets, ["item:1"]);
    assert.deepEqual(task.exceptions, [
      { targets: ["item:2"], reason: DECLINED },
    ]);

    ledger = applyAll(
      ledger,
      moved("batch-b", BATCH_B),
      moved("batch-c", BATCH_C),
    );
    task = find(ledger, "move");
    assert.equal(task.status, "completed");
    assert.equal(endOf(ledger), "completed_with_exceptions");

    // With no part that names them, an edit in review records nothing.
    for (const ledgerWithout of [
      emptyLedger(),
      ledgerWith({ ...moveAll, targets: undefined, scope: undefined }),
    ]) {
      const result = apply(ledgerWithout, leftUntouched("call-x", ["item:2"]));
      assert.isFalse(result.changed);
      assert.strictEqual(result.checkpoint, ledgerWithout);
    }
  });

  it("a part whose every batch was declined is blocked, as a declined write is", function () {
    const ledger = applyAll(
      ledgerWith(moveAll),
      ...deniedMove("call-a", BATCH_A),
      ...deniedMove("call-b", BATCH_B),
      ...deniedMove("call-c", BATCH_C),
    );
    const task = find(ledger, "move");
    assert.equal(task.status, "blocked");
    assert.equal(task.reason, DECLINED);
    assert.deepEqual(task.exceptions, [{ targets: PAPERS, reason: DECLINED }]);
    assert.equal(endOf(ledger), "blocked");
  });

  it("each paper is excepted once, under the first reason given for it", function () {
    const ledger = applyAll(
      ledgerWith(moveAll),
      ...deniedMove("call-b", BATCH_B),
      failedMove("batch-b-again", BATCH_B),
    );
    assert.deepEqual(find(ledger, "move").exceptions, [
      { targets: BATCH_B, reason: DECLINED },
    ]);
  });

  it("a part that names its papers by bare id, as models write targetIds, takes batches the same way", function () {
    const bare: OutcomeDeclaration = {
      ...moveAll,
      targets: ["1", "2", "3", "4", "5", "6"],
      scope: undefined,
    };
    let ledger = applyAll(
      ledgerWith(bare),
      moved("batch-a", BATCH_A),
      ...deniedMove("call-b", BATCH_B),
      failedMove("batch-c", BATCH_C),
    );
    let task = find(ledger, "move");
    assert.deepEqual(task.targets, ["1", "2", "3", "4", "5", "6"]);
    assert.equal(task.status, "completed");
    assert.deepEqual(task.doneTargets, ["1", "2"]);
    assert.deepEqual(task.exceptions, [
      { targets: ["3", "4"], reason: DECLINED },
      { targets: ["5", "6"], reason: REFUSED },
    ]);

    ledger = applyAll(ledger, moved("batch-c-retry", BATCH_C));
    task = find(ledger, "move");
    assert.equal(task.status, "completed");
    assert.deepEqual(task.doneTargets, ["1", "2", "5", "6"]);
    assert.deepEqual(task.exceptions, [
      { targets: ["3", "4"], reason: DECLINED },
    ]);
    assert.lengthOf(ledger.tasks, 1);
  });

  it("a one-paper write keeps the single-write rules: a failure leaves the part open, a decline blocks it", function () {
    const failed = find(
      applyAll(ledgerWith(moveAll), failedMove("one-failed", ["item:1"])),
      "move",
    );
    assert.equal(failed.status, "pending");
    assert.equal(failed.reason, REFUSED);
    assert.notProperty(failed, "exceptions");

    const refused = find(
      applyAll(ledgerWith(moveAll), ...deniedMove("call-one", ["item:1"])),
      "move",
    );
    assert.equal(refused.status, "blocked");
    assert.equal(refused.reason, DECLINED);
    assert.notProperty(refused, "exceptions");
  });
});

describe("outcome ledger: papers the host gave up on", function () {
  const SCOPE = ["item:1", "item:2", "item:3"];
  const readAll: OutcomeDeclaration = {
    taskId: "read-all",
    description: "Read each paper in Drift",
    effect: "read",
    targets: SCOPE,
    scope: true,
  };
  const noteAll: OutcomeDeclaration = {
    taskId: "note-all",
    description: "Write a note on each",
    effect: "mutation",
    capability: "zotero.notes",
    targets: SCOPE,
  };
  const BROKEN = "The PDF could not be opened";

  it("records the failure as each naming part's exception, and the job goes on", function () {
    const ledger = ledgerWith(readAll, noteAll);
    const { checkpoint, changed } = apply(ledger, {
      kind: "failed",
      targets: ["item:2"],
      reason: BROKEN,
    });
    assert.isTrue(changed);
    for (const local of ["read-all", "note-all"]) {
      const task = find(checkpoint, local);
      assert.equal(task.status, "pending", local);
      assert.deepEqual(task.exceptions, [
        { targets: ["item:2"], reason: BROKEN },
      ]);
    }
  });

  it("settles a part once every paper is done or given up on", function () {
    let ledger = apply(ledgerWith(readAll), {
      kind: "read",
      targets: ["item:1", "item:3"],
      observationIds: ["obs-1"],
    }).checkpoint;
    ledger = apply(ledger, {
      kind: "failed",
      targets: ["item:2"],
      reason: BROKEN,
    }).checkpoint;
    assert.include(find(ledger, "read-all"), { status: "completed" });
    assert.equal(
      decideRunEnd(ledger, { status: "completed", stopRule: "final_answer" }),
      "completed_with_exceptions",
    );
    // Only failures: skipped, with the failure as the reason.
    const failedAll = apply(ledgerWith(readAll), {
      kind: "failed",
      targets: SCOPE,
      reason: BROKEN,
    }).checkpoint;
    assert.include(find(failedAll, "read-all"), {
      status: "skipped",
      reason: BROKEN,
    });
  });

  it("leaves a paper already done alone, and changes nothing the second time", function () {
    const read = apply(ledgerWith(readAll), {
      kind: "read",
      targets: ["item:2"],
      observationIds: ["obs-1"],
    }).checkpoint;
    const failure: OutcomeEvidence = {
      kind: "failed",
      targets: ["item:2"],
      reason: BROKEN,
    };
    assert.isFalse(apply(read, failure).changed, "item 2 was read");
    const once = apply(ledgerWith(readAll), failure).checkpoint;
    assert.isFalse(apply(once, failure).changed);
  });

  it("ends a run stopped by a failed page as interrupted", function () {
    const ledger = apply(ledgerWith(readAll), {
      kind: "failed",
      targets: ["item:1", "item:2"],
      reason: BROKEN,
    }).checkpoint;
    assert.equal(
      decideRunEnd(ledger, { status: "failed", stopRule: "page_failed" }),
      "interrupted",
    );
  });
});

describe("outcome ledger: resuming a job, and the notes it already wrote", function () {
  const SCOPE = ["item:1", "item:2", "item:3"];
  const readAll: OutcomeDeclaration = {
    taskId: "read-all",
    description: "Read each paper in Drift",
    effect: "read",
    targets: SCOPE,
    scope: true,
  };
  const noteAll: OutcomeDeclaration = {
    taskId: "note-all",
    description: "Save a note on each paper",
    effect: "mutation",
    capability: "zotero.notes",
    targets: SCOPE,
    scope: true,
  };
  /** A note created on each of `targets`, one proposal per paper. */
  const notesOn = (...targets: string[]) =>
    targets.map((target) => ({
      capability: "zotero.notes" as const,
      operation: "note_create" as const,
      requestedTargets: [target],
    }));
  /** The verified receipt of a note created on `target`. */
  const noted = (checkpoint: ExecutionCheckpoint, target: string) =>
    apply(checkpoint, {
      kind: "receipt",
      receipt: receipt({
        id: `note:${target}`,
        requestedTargets: [target],
        appliedTargets: [target],
      }),
    }).checkpoint;

  it("names the papers a note write would write a second time, and those it still owes", function () {
    let ledger = noted(ledgerWith(readAll, noteAll), "item:1");
    assert.deepEqual(papersAlreadyWritten(ledger, notesOn("item:1")), {
      written: ["item:1"],
      left: [],
      parts: ["Save a note on each paper"],
    });
    // A batch over a written paper and one still owed.
    assert.deepEqual(
      papersAlreadyWritten(ledger, [
        {
          capability: "zotero.notes",
          operation: "save_notes_batch",
          requestedTargets: ["item:1", "item:2"],
        },
      ]),
      {
        written: ["item:1"],
        left: ["item:2"],
        parts: ["Save a note on each paper"],
      },
    );
    assert.isNull(papersAlreadyWritten(ledger, notesOn("item:2")));
    // Once the part is done, a note on any of its papers is a second one.
    for (const target of ["item:2", "item:3"]) ledger = noted(ledger, target);
    assert.equal(find(ledger, "note-all").status, "completed");
    assert.deepEqual(papersAlreadyWritten(ledger, notesOn("item:3"))?.written, [
      "item:3",
    ]);
  });

  it("leaves a write alone that another open part still needs, or that writes no note on a paper", function () {
    const second: OutcomeDeclaration = {
      ...noteAll,
      taskId: "methods",
      description: "Save a methods note on each paper",
    };
    // A part declared after paper 1's note was written still owes it one;
    // two parts declared up front are in "one part per note" below.
    const one = noted(ledgerWith(noteAll), "item:1");
    const ledger = frozen(declareOutcomes(one, [second], 40));
    assert.isNull(
      papersAlreadyWritten(ledger, notesOn("item:1")),
      "the methods part still owes paper 1 a note",
    );
    // Editing or appending to a note, and tagging a paper, write no new
    // note on it; a job that never declared notes holds none.
    for (const proposal of [
      {
        capability: "zotero.notes" as const,
        operation: "note_append" as const,
        requestedTargets: ["item:1"],
      },
      {
        capability: "zotero.tags" as const,
        operation: "apply_tags" as const,
        requestedTargets: ["item:1"],
      },
    ])
      assert.isNull(papersAlreadyWritten(one, [proposal]));
    assert.isNull(papersAlreadyWritten(undefined, notesOn("item:1")));
    const undeclared = apply(emptyLedger(), {
      kind: "receipt",
      receipt: receipt({ id: "note:host" }),
    }).checkpoint;
    assert.isNull(
      papersAlreadyWritten(undeclared, notesOn("item:1")),
      "a host part is no job",
    );
  });

  it("picks a stopped job back up on continue, as an interrupted one", function () {
    const ledger = noted(ledgerWith(readAll, noteAll), "item:1");
    const ended = (state: RunEndState, checkpoint = ledger) =>
      frozen({ ...checkpoint, end: { state } });
    assert.isTrue(resumesOnContinue(ended("interrupted")));
    assert.isTrue(resumesOnContinue(ended("cancelled")), "Stop is no end");
    const done = ["item:1", "item:2", "item:3"].reduce(
      (checkpoint, target) => noted(checkpoint, target),
      apply(ledgerWith(noteAll), {
        kind: "read",
        targets: SCOPE,
        observationIds: ["obs-1"],
      }).checkpoint,
    );
    assert.isFalse(
      resumesOnContinue(ended("cancelled", done)),
      "a stopped run with nothing left has nothing to resume",
    );
    for (const state of [
      "completed",
      "completed_with_exceptions",
      "blocked",
      "failed",
    ] as const)
      assert.isFalse(resumesOnContinue(ended(state)), state);
  });
});

describe("outcome ledger: one part per note", function () {
  const SCOPE = ["item:1", "item:2", "item:3"];
  const SUMMARY = "Save a summary note on each paper";
  const METHODS = "Save a methods note on each paper";
  const summaryAll: OutcomeDeclaration = {
    taskId: "summary-all",
    description: SUMMARY,
    effect: "mutation",
    capability: "zotero.notes",
    targets: SCOPE,
    scope: true,
  };
  const methodsAll: OutcomeDeclaration = {
    ...summaryAll,
    taskId: "methods-all",
    description: METHODS,
  };
  const notesOn = (...targets: string[]) =>
    targets.map((target) => ({
      capability: "zotero.notes" as const,
      operation: "note_create" as const,
      requestedTargets: [target],
    }));
  const batchOver = (...targets: string[]) => [
    {
      capability: "zotero.notes" as const,
      operation: "save_notes_batch" as const,
      requestedTargets: targets,
    },
  ];
  let notes = 0;
  /** The verified receipt of one more note created on `target`. */
  const noted = (checkpoint: ExecutionCheckpoint, target: string) =>
    apply(checkpoint, {
      kind: "receipt",
      receipt: receipt({
        id: `note-${(notes += 1)}:${target}`,
        requestedTargets: [target],
        appliedTargets: [target],
      }),
    }).checkpoint;

  it("binds a note to the first part that still owes its paper one, and the next note to the next part", function () {
    let ledger = noted(ledgerWith(summaryAll, methodsAll), "item:1");
    assert.deepEqual(find(ledger, "summary-all").doneTargets, ["item:1"]);
    assert.isUndefined(
      find(ledger, "methods-all").doneTargets,
      "one note is one part's note",
    );
    assert.isUndefined(find(ledger, "methods-all").receiptIds);
    assert.isNull(
      papersAlreadyWritten(ledger, notesOn("item:1")),
      "the methods part still owes paper 1 its note",
    );

    ledger = noted(ledger, "item:1");
    assert.deepEqual(find(ledger, "methods-all").doneTargets, ["item:1"]);
    assert.lengthOf(
      find(ledger, "summary-all").receiptIds!,
      1,
      "the second note binds the methods part alone",
    );
    assert.deepEqual(papersAlreadyWritten(ledger, notesOn("item:1")), {
      written: ["item:1"],
      left: [],
      parts: [SUMMARY, METHODS],
    });

    // Setting a tag twice changes nothing, so a tag still binds every part
    // that names its paper.
    const tagged = apply(
      ledgerWith(
        { ...tagAny, taskId: "tag-method", targets: SCOPE },
        { ...tagAny, taskId: "tag-topic", targets: SCOPE },
      ),
      {
        kind: "receipt",
        receipt: receipt({
          id: "tags-1",
          capability: "zotero.tags",
          operation: "apply_tags",
          requestedTargets: ["item:1"],
          appliedTargets: ["item:1"],
        }),
      },
    ).checkpoint;
    for (const local of ["tag-method", "tag-topic"])
      assert.deepEqual(find(tagged, local).doneTargets, ["item:1"], local);
  });

  it("splits a note batch paper by paper among the parts that owe each", function () {
    const ledger = apply(noted(ledgerWith(summaryAll, methodsAll), "item:1"), {
      kind: "receipt",
      receipt: receipt({
        id: "batch-1",
        operation: "save_notes_batch",
        requestedTargets: SCOPE,
        appliedTargets: SCOPE,
      }),
    }).checkpoint;
    const summary = find(ledger, "summary-all");
    assert.equal(summary.status, "completed");
    assert.deepEqual(summary.doneTargets, SCOPE);
    const methods = find(ledger, "methods-all");
    assert.equal(methods.status, "pending");
    assert.deepEqual(methods.doneTargets, ["item:1"]);
    assert.include(methods.receiptIds!, "batch-1");
    assert.deepEqual(papersAlreadyWritten(ledger, batchOver(...SCOPE)), {
      written: ["item:1"],
      left: ["item:2", "item:3"],
      parts: [SUMMARY, METHODS],
    });
  });

  it("lets a part that takes any write take every note on its papers, as before, so it never opens the guard", function () {
    // A part with no capability may be a tag's or a folder's: a note fills
    // no slot of it, and it owes no note once a note named its paper.
    const updateAll: OutcomeDeclaration = {
      taskId: "update-all",
      description: "Update each paper",
      effect: "mutation",
      targets: SCOPE,
    };
    let ledger = noted(ledgerWith(updateAll, summaryAll, methodsAll), "item:1");
    assert.deepEqual(find(ledger, "update-all").doneTargets, ["item:1"]);
    assert.deepEqual(find(ledger, "summary-all").doneTargets, ["item:1"]);
    assert.isUndefined(find(ledger, "methods-all").doneTargets);
    ledger = noted(ledger, "item:1");
    assert.deepEqual(find(ledger, "methods-all").doneTargets, ["item:1"]);
    assert.deepEqual(papersAlreadyWritten(ledger, notesOn("item:1"))?.written, [
      "item:1",
    ]);
    const one = noted(ledgerWith(updateAll, summaryAll), "item:1");
    assert.deepEqual(papersAlreadyWritten(one, notesOn("item:1"))?.written, [
      "item:1",
    ]);
  });

  it("asks a one-part job for a part of its own before a second note on a paper, then counts each note once", function () {
    // "A summary and a methods note on each paper", declared as one part:
    // the part holds one done flag a paper, so it cannot count two notes.
    const both = { ...summaryAll, description: "Save two notes on each paper" };
    let ledger = noted(ledgerWith(both), "item:1");
    assert.deepEqual(
      papersAlreadyWritten(ledger, notesOn("item:1"))?.written,
      ["item:1"],
      "the second note is refused until a part asks for it",
    );
    ledger = frozen(declareOutcomes(ledger, [methodsAll], 40));
    assert.isNull(papersAlreadyWritten(ledger, notesOn("item:1")));

    ledger = noted(ledger, "item:1");
    assert.deepEqual(find(ledger, "methods-all").doneTargets, ["item:1"]);
    assert.lengthOf(find(ledger, "summary-all").receiptIds!, 1);
    // Paper 2's first note is the first part's, so its second still runs.
    ledger = noted(ledger, "item:2");
    assert.deepEqual(find(ledger, "summary-all").doneTargets, [
      "item:1",
      "item:2",
    ]);
    assert.deepEqual(find(ledger, "methods-all").doneTargets, ["item:1"]);
    assert.isNull(papersAlreadyWritten(ledger, notesOn("item:2")));
    ledger = noted(ledger, "item:2");
    assert.deepEqual(find(ledger, "methods-all").doneTargets, [
      "item:1",
      "item:2",
    ]);
  });

  it("still skips a note sent again after Stop once every part has its paper, and names the papers a batch has left", function () {
    let ledger = ledgerWith(summaryAll, methodsAll);
    for (const target of ["item:1", "item:1", "item:2"])
      ledger = noted(ledger, target);
    // The user stops the job; "continue" picks the ledger back up.
    const stopped = frozen({ ...ledger, end: { state: "cancelled" as const } });
    assert.isTrue(resumesOnContinue(stopped));
    const { end: _end, ...resumed } = stopped;
    assert.deepEqual(papersAlreadyWritten(resumed, notesOn("item:1")), {
      written: ["item:1"],
      left: [],
      parts: [SUMMARY, METHODS],
    });
    // Paper 2 still owes its methods note, and paper 3 both of its notes.
    assert.deepEqual(papersAlreadyWritten(resumed, batchOver(...SCOPE)), {
      written: ["item:1"],
      left: ["item:2", "item:3"],
      parts: [SUMMARY, METHODS],
    });
  });
});

describe("outcome ledger: digest parts", function () {
  const digestPart: OutcomeDeclaration = {
    taskId: "summaries",
    description: "Summarize each selected paper",
    effect: "digest",
    targets: ["item:1", "item:2", "item:3"],
    scope: true,
  };
  const evidence = (
    done: string[],
    failed: Array<{ target: string; reason: string }> = [],
    local = "summaries",
  ): OutcomeEvidence => ({
    kind: "digest",
    taskId: taskId(local),
    done,
    failed,
  });

  it("declares a digest part pending with its frozen targets", function () {
    const ledger = ledgerWith(digestPart);
    const task = ledger.tasks[0];
    assert.equal(task.effect, "digest");
    assert.equal(task.status, "pending");
    assert.deepEqual(task.targets, ["item:1", "item:2", "item:3"]);
    assert.isTrue(task.scope);
  });

  it("grows doneTargets one paper at a time and completes on the last", function () {
    let ledger = ledgerWith(digestPart);
    ledger = frozen(
      applyOutcomeEvidence(ledger, evidence(["item:1"]), 30).checkpoint,
    );
    assert.deepEqual(ledger.tasks[0].doneTargets, ["item:1"]);
    assert.equal(ledger.tasks[0].status, "pending");
    ledger = frozen(
      applyOutcomeEvidence(ledger, evidence(["item:2"]), 31).checkpoint,
    );
    ledger = frozen(
      applyOutcomeEvidence(ledger, evidence(["item:3"]), 32).checkpoint,
    );
    assert.equal(ledger.tasks[0].status, "completed");
    assert.deepEqual(ledger.tasks[0].doneTargets, [
      "item:1",
      "item:2",
      "item:3",
    ]);
    assert.isUndefined(ledger.tasks[0].exceptions);
    assert.equal(ledger.tasks[0].updatedAt, 32);
  });

  it("is idempotent: the same paper's digest again changes nothing", function () {
    const once = frozen(
      applyOutcomeEvidence(ledgerWith(digestPart), evidence(["item:1"]), 30)
        .checkpoint,
    );
    const again = applyOutcomeEvidence(once, evidence(["item:1"]), 31);
    assert.isFalse(again.changed);
    assert.strictEqual(again.checkpoint, once);
  });

  it("completes with an exception naming the paper that failed", function () {
    let ledger = ledgerWith(digestPart);
    ledger = frozen(
      applyOutcomeEvidence(ledger, evidence(["item:1", "item:2"]), 30)
        .checkpoint,
    );
    ledger = frozen(
      applyOutcomeEvidence(
        ledger,
        evidence([], [{ target: "item:3", reason: OUTCOME_REASONS.noText }]),
        31,
      ).checkpoint,
    );
    assert.equal(ledger.tasks[0].status, "completed");
    assert.deepEqual(ledger.tasks[0].exceptions, [
      { targets: ["item:3"], reason: OUTCOME_REASONS.noText },
    ]);
    assert.equal(
      decideRunEnd(ledger, {
        status: "completed",
        stopRule: "final_answer" as RunStopRule,
      }),
      "completed_with_exceptions",
    );
  });

  it("stays pending while a failure leaves papers unaccounted", function () {
    const ledger = applyOutcomeEvidence(
      ledgerWith(digestPart),
      evidence([], [{ target: "item:1", reason: "Timed out" }]),
      30,
    ).checkpoint;
    assert.equal(ledger.tasks[0].status, "pending");
    assert.isUndefined(ledger.tasks[0].doneTargets);
    assert.deepEqual(ledger.tasks[0].exceptions, [
      { targets: ["item:1"], reason: "Timed out" },
    ]);
  });

  it("is skipped with the first reason when every paper failed", function () {
    const ledger = applyOutcomeEvidence(
      ledgerWith(digestPart),
      evidence(
        [],
        [
          { target: "item:1", reason: "No readable text" },
          { target: "item:2", reason: "No readable text" },
          { target: "item:3", reason: "Timed out" },
        ],
      ),
      30,
    ).checkpoint;
    assert.equal(ledger.tasks[0].status, "skipped");
    assert.equal(ledger.tasks[0].reason, "No readable text");
    assert.deepEqual(ledger.tasks[0].exceptions, [
      { targets: ["item:1", "item:2"], reason: "No readable text" },
      { targets: ["item:3"], reason: "Timed out" },
    ]);
  });

  it("a blank failure reason falls back to the host's reason", function () {
    const ledger = applyOutcomeEvidence(
      ledgerWith(digestPart),
      evidence([], [{ target: "item:1", reason: "  " }]),
      30,
    ).checkpoint;
    assert.deepEqual(ledger.tasks[0].exceptions, [
      { targets: ["item:1"], reason: OUTCOME_REASONS.notApplied },
    ]);
  });

  it("never excepts a paper already done", function () {
    let ledger = frozen(
      applyOutcomeEvidence(ledgerWith(digestPart), evidence(["item:1"]), 30)
        .checkpoint,
    );
    const result = applyOutcomeEvidence(
      ledger,
      evidence([], [{ target: "item:1", reason: "Timed out" }]),
      31,
    );
    assert.isFalse(result.changed);
    ledger = frozen(
      applyOutcomeEvidence(
        ledger,
        evidence(["item:2"], [{ target: "item:2", reason: "Timed out" }]),
        32,
      ).checkpoint,
    );
    assert.deepEqual(ledger.tasks[0].doneTargets, ["item:1", "item:2"]);
    assert.isUndefined(ledger.tasks[0].exceptions);
  });

  it("a retry that digests an excepted paper clears its exception", function () {
    let ledger = ledgerWith(digestPart);
    ledger = frozen(
      applyOutcomeEvidence(ledger, evidence(["item:1", "item:2"]), 30)
        .checkpoint,
    );
    ledger = frozen(
      applyOutcomeEvidence(
        ledger,
        evidence([], [{ target: "item:3", reason: "Timed out" }]),
        31,
      ).checkpoint,
    );
    assert.equal(ledger.tasks[0].status, "completed");
    ledger = frozen(
      applyOutcomeEvidence(ledger, evidence(["item:3"]), 32).checkpoint,
    );
    assert.equal(ledger.tasks[0].status, "completed");
    assert.isUndefined(ledger.tasks[0].exceptions);
    assert.isUndefined(ledger.tasks[0].reason);
  });

  it("a retry turns a part skipped for failures into a completed one", function () {
    let ledger = frozen(
      applyOutcomeEvidence(
        ledgerWith(digestPart),
        evidence(
          [],
          ["item:1", "item:2", "item:3"].map((target) => ({
            target,
            reason: "Timed out",
          })),
        ),
        30,
      ).checkpoint,
    );
    assert.equal(ledger.tasks[0].status, "skipped");
    ledger = frozen(
      applyOutcomeEvidence(ledger, evidence(["item:2"]), 31).checkpoint,
    );
    assert.equal(ledger.tasks[0].status, "completed");
    assert.isUndefined(ledger.tasks[0].reason);
    assert.deepEqual(ledger.tasks[0].doneTargets, ["item:2"]);
    assert.deepEqual(ledger.tasks[0].exceptions, [
      { targets: ["item:1", "item:3"], reason: "Timed out" },
    ]);
  });

  it("touches only the part it names and ignores papers it does not name", function () {
    const ledger = ledgerWith(digestPart, {
      taskId: "other",
      description: "Summarize the rest",
      effect: "digest",
      targets: ["item:9"],
    });
    const { checkpoint, changed } = applyOutcomeEvidence(
      ledger,
      evidence(
        ["item:1"],
        [{ target: "item:2", reason: "Timed out" }],
        "other",
      ),
      30,
    );
    assert.isFalse(changed);
    assert.strictEqual(checkpoint, ledger);
  });

  it("moves no part of another effect, nor a blocked or cancelled digest part", function () {
    const read = ledgerWith({
      taskId: "summaries",
      description: "Read each paper",
      effect: "read",
      targets: ["item:1"],
    });
    assert.isFalse(
      applyOutcomeEvidence(read, evidence(["item:1"]), 30).changed,
    );
    const cancelled = frozen(
      markOutcomes(
        ledgerWith(digestPart),
        [{ taskId: "summaries", status: "cancelled", reason: "User stopped" }],
        25,
      ).checkpoint,
    );
    assert.isFalse(
      applyOutcomeEvidence(cancelled, evidence(["item:1"]), 30).changed,
    );
  });

  it("reads and papers given up on leave a digest part alone", function () {
    const ledger = ledgerWith(digestPart);
    for (const other of [
      {
        kind: "read",
        targets: ["item:1"],
        observationIds: ["obs-1"],
      },
      { kind: "failed", targets: ["item:1"], reason: "Timed out" },
    ] as OutcomeEvidence[]) {
      assert.isFalse(applyOutcomeEvidence(ledger, other, 30).changed);
    }
  });

  it("the answer does not complete a digest part; the run ends with exceptions", function () {
    const ledger = applyOutcomeEvidence(
      ledgerWith(digestPart),
      { kind: "answer" },
      30,
    ).checkpoint;
    assert.equal(ledger.tasks[0].status, "pending");
    assert.lengthOf(openDeclaredOutcomes(ledger), 1);
    assert.equal(
      decideRunEnd(ledger, {
        status: "completed",
        stopRule: "final_answer" as RunStopRule,
      }),
      "completed_with_exceptions",
    );
    assert.equal(
      settleOutcomes(ledger, "completed_with_exceptions", 40).tasks[0].status,
      "skipped",
    );
  });

  it("each paper's digest moves the progress signature", function () {
    const before = ledgerWith(digestPart);
    const after = applyOutcomeEvidence(
      before,
      evidence(["item:1"]),
      30,
    ).checkpoint;
    assert.notEqual(
      outcomeProgressSignature(before),
      outcomeProgressSignature(after),
    );
  });
});
