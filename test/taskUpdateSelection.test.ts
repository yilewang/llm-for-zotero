import { assert } from "chai";
import { createEmptyExecutionCheckpoint } from "../src/agent/execution/checkpoint";
import { readLongJob } from "../src/agent/loop/longJob";
import {
  applyOutcomeEvidence,
  declareOutcomes,
  decideRunEnd,
  OUTCOME_REASONS,
  outcomeProgressSignature,
  settleOutcomes,
  type OutcomeEvidence,
} from "../src/agent/loop/outcomes";
import { ToolInputRejection } from "../src/agent/tools/execution/failure";
import {
  applyOrdinaryTaskUpdates,
  createTaskUpdateTool,
} from "../src/agent/tools/control/taskUpdate";
import type {
  AgentExecutionContext,
  AgentToolContext,
  ExecutionCheckpoint,
  ExecutionCheckpointTask,
} from "../src/agent/types";
import type { TaskPaperScopeSet } from "../src/agent/context/taskPaperScopeListing";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

/**
 * The agent's own selection and revision of its parts: papers a synthesis
 * leaves out (`excluded`), a part changed in place before it has progress,
 * a part replaced once it has (`replaces`), and the user's question each
 * digest part keeps for the per-paper worker.
 */

const executionContext: AgentExecutionContext = {
  version: 1,
  executionId: "execution-select-1",
  conversationKey: 52,
  conversationGeneration: 1,
  chatLibraryID: 1,
  permissionOwner: "original_agent",
  workspaceSnapshot: { selectedPapers: [], selectedCollections: [] },
  configuredAccess: { libraryIDs: [1], outputDirectories: [] },
};

const SCOPE = { wholeLibrary: false, itemIds: [5, 6, 7], withText: 3 };
const RUN = { status: "completed", stopRule: "final_answer" } as const;

function taskId(local: string): string {
  return `execution-select-1:task:${local}`;
}

function empty(): ExecutionCheckpoint {
  return createEmptyExecutionCheckpoint(executionContext, 10);
}

function input(args: unknown) {
  const parsed = createTaskUpdateTool().validate(args);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

/** One ordinary call, applied to the ledger as the tool applies it. */
function update(
  checkpoint: ExecutionCheckpoint,
  args: unknown,
  options: { now?: number; userText?: string; scope?: TaskPaperScopeSet } = {},
) {
  return applyOrdinaryTaskUpdates(
    checkpoint,
    input(args),
    options.now ?? 30,
    options.scope ?? SCOPE,
    options.userText,
  );
}

function refusal(run: () => unknown): ToolInputRejection {
  try {
    run();
  } catch (error) {
    assert.instanceOf(error, ToolInputRejection);
    return error as ToolInputRejection;
  }
  throw new Error("expected task_update to refuse the call");
}

function find(
  checkpoint: ExecutionCheckpoint,
  local: string,
): ExecutionCheckpointTask {
  const task = checkpoint.tasks.find((entry) => entry.taskId === taskId(local));
  assert.exists(task, `part ${local}`);
  return task!;
}

function evidence(
  checkpoint: ExecutionCheckpoint,
  given: OutcomeEvidence,
  now = 40,
): ExecutionCheckpoint {
  return applyOutcomeEvidence(checkpoint, given, now).checkpoint;
}

const review = {
  taskId: "review",
  description: "Write the literature review",
  expectedEffect: "artifact",
  scope: true,
};
const summaries = {
  taskId: "summaries",
  description: "Summarize each paper",
  expectedEffect: "digest",
  scope: true,
};
const readAll = {
  taskId: "read-all",
  description: "Read each paper",
  expectedEffect: "read",
  scope: true,
};
const notes = {
  taskId: "notes",
  description: "Save a note on each paper",
  expectedEffect: "mutation",
  expectedCapability: "zotero.notes",
  scope: true,
};

function document(cited: string[], documentId = "doc-1"): OutcomeEvidence {
  return {
    kind: "material",
    materialRef: {
      documentId,
      documentVersion: 1,
      contentHash: `sha256:${documentId}`,
    },
    taskId: "review",
    citedTargets: cited,
  };
}

function noteReceipt(target: string): OutcomeEvidence {
  return {
    kind: "receipt",
    receipt: {
      version: 2,
      id: `receipt-${target}`,
      proposalId: `proposal-${target}`,
      proofDomain: "zotero_state",
      capability: "zotero.notes",
      operation: "note_create",
      verification: "verified",
      status: "applied",
      requestedTargets: [target],
      appliedTargets: [target],
      alreadySatisfiedTargets: [],
      rejectedTargets: [],
      reasons: [],
      verifiedFacts: [],
    },
  };
}

describe("task_update: papers a synthesis leaves out", function () {
  const off = "Chemistry paper; it does not address place-cell drift";

  it("takes excluded as a top-level list of parts, papers and reasons", function () {
    const tool = createTaskUpdateTool();
    const schema = tool.spec.inputSchema as any;
    assert.deepEqual(schema.properties.excluded.items.required, [
      "taskId",
      "targetIds",
      "reason",
    ]);
    assert.isFalse(schema.properties.excluded.items.additionalProperties);
    assert.isFalse(schema.additionalProperties);
    const parsed = tool.validate({
      excluded: [{ taskId: "review", targetIds: ["7"], reason: off }],
    });
    assert.isTrue(parsed.ok, "an exclusion alone is a call");
    for (const [entry, message] of [
      [{ taskId: "review", targetIds: ["7"] }, /reason/],
      [{ taskId: "review", targetIds: ["7"], reason: "  " }, /reason/],
      [{ taskId: "review", targetIds: [], reason: off }, /targetIds/],
      [{ targetIds: ["7"], reason: off }, /taskId/],
    ] as const) {
      const result = tool.validate({ excluded: [entry] });
      assert.isFalse(result.ok, JSON.stringify(entry));
      if (!result.ok) assert.match(result.error, message);
    }
  });

  it("refuses excluded on a digest, read or write part with the note, and changes nothing", function () {
    const declared = update(empty(), {
      tasks: [summaries, readAll, notes],
    }).checkpoint;
    for (const [local, kind] of [
      ["summaries", "digest"],
      ["read-all", "read"],
      ["notes", "mutation"],
    ]) {
      const error = refusal(() =>
        update(declared, {
          excluded: [{ taskId: local, targetIds: ["7"], reason: off }],
        }),
      );
      assert.include(error.message, `Task ${local} is a ${kind} part`);
      assert.include(error.message, "covers every paper it names");
      assert.include(error.message, "skipped or blocked");
    }
    // A reasoning part, like an artifact part, writes from a selection.
    const explained = update(empty(), {
      tasks: [
        {
          taskId: "explain",
          description: "Explain which papers bear on drift",
          expectedEffect: "reasoning",
          scope: true,
        },
      ],
      excluded: [{ taskId: "explain", targetIds: ["7"], reason: off }],
    }).checkpoint;
    assert.deepEqual(find(explained, "explain").excludedTargets, [
      { targets: ["item:7"], reason: off },
    ]);
  });

  it("refuses papers that are not the part's own or are already done, naming them", function () {
    const covered = evidence(
      update(empty(), { tasks: [review] }).checkpoint,
      document(["item:5"]),
    );
    const error = refusal(() =>
      update(covered, {
        excluded: [
          { taskId: "review", targetIds: ["5", "item:99", "7"], reason: off },
        ],
      }),
    );
    assert.include(error.message, "99");
    assert.include(error.message, "5");
    assert.notInclude(error.message, "item:7");
    assert.match(error.message, /not one of its papers/);
    assert.match(error.message, /already covered/);
  });

  it("never marks an excluded paper Not covered, so the run ends completed", function () {
    let ledger = update(empty(), { tasks: [review] }).checkpoint;
    const excluded = update(ledger, {
      tasks: [review],
      excluded: [{ taskId: "review", targetIds: ["item:7"], reason: off }],
    });
    assert.isFalse(excluded.ignored, "the repeat beside it is no lone repeat");
    ledger = excluded.checkpoint;
    assert.deepEqual(find(ledger, "review").excludedTargets, [
      { targets: ["item:7"], reason: off },
    ]);
    assert.isUndefined(find(ledger, "review").exceptions);
    ledger = evidence(ledger, document(["item:5", "item:6"]));
    const part = find(ledger, "review");
    assert.equal(part.status, "completed");
    assert.deepEqual(part.doneTargets, ["item:5", "item:6"]);
    assert.isUndefined(part.exceptions, "no paper is Not covered");
    assert.deepEqual(part.excludedTargets, [
      { targets: ["item:7"], reason: off },
    ]);
    assert.equal(decideRunEnd(ledger, RUN), "completed");
  });

  it("takes any paper as an exclusion on a review declared without papers, which still completes whole", function () {
    const open = {
      taskId: "review",
      description: "Write the literature review",
      expectedEffect: "artifact",
    };
    let ledger = update(empty(), { tasks: [open] }).checkpoint;
    assert.isUndefined(find(ledger, "review").targets);
    const excluded = update(ledger, {
      excluded: [{ taskId: "review", targetIds: ["7", "item:9"], reason: off }],
    });
    assert.isFalse(excluded.ignored);
    ledger = excluded.checkpoint;
    assert.deepEqual(find(ledger, "review").excludedTargets, [
      { targets: ["item:7", "item:9"], reason: off },
    ]);
    // A later exclusion adds to it and an excluded paper keeps its reason.
    ledger = update(ledger, {
      excluded: [
        { taskId: "review", targetIds: ["item:7", "8"], reason: "Duplicate" },
      ],
    }).checkpoint;
    assert.deepEqual(find(ledger, "review").excludedTargets, [
      { targets: ["item:7", "item:9"], reason: off },
      { targets: ["item:8"], reason: "Duplicate" },
    ]);
    // Only papers: a folder is no exclusion.
    const folder = refusal(() =>
      update(ledger, {
        excluded: [
          { taskId: "review", targetIds: ["collection:3"], reason: off },
        ],
      }),
    );
    assert.include(folder.message, "collection:3");
    // The document completes the part whole and keeps what it left out.
    ledger = evidence(ledger, document(["item:5", "item:6"]));
    const part = find(ledger, "review");
    assert.equal(part.status, "completed");
    assert.isUndefined(part.exceptions);
    assert.deepEqual(part.excludedTargets, [
      { targets: ["item:7", "item:9"], reason: off },
      { targets: ["item:8"], reason: "Duplicate" },
    ]);
    assert.equal(decideRunEnd(ledger, RUN), "completed");
    // A paper the document cites is one it used: no longer left out.
    const cited = evidence(
      update(update(empty(), { tasks: [open] }).checkpoint, {
        excluded: [{ taskId: "review", targetIds: ["7", "9"], reason: off }],
      }).checkpoint,
      document(["item:7"]),
    );
    assert.deepEqual(find(cited, "review").excludedTargets, [
      { targets: ["item:9"], reason: off },
    ]);
    // A part that names papers still refuses a paper that is not its own.
    const scoped = update(empty(), { tasks: [review] }).checkpoint;
    const refused = refusal(() =>
      update(scoped, {
        excluded: [{ taskId: "review", targetIds: ["99"], reason: off }],
      }),
    );
    assert.match(refused.message, /99 \(not one of its papers\)/);
  });

  it("drops a paper the accepted answer cites from a reasoning part's exclusions", function () {
    const explain = {
      taskId: "explain",
      description: "Explain which papers bear on drift",
      expectedEffect: "reasoning",
      scope: true,
    };
    const excludedSix = update(empty(), {
      tasks: [explain],
      excluded: [{ taskId: "explain", targetIds: ["6", "7"], reason: off }],
    }).checkpoint;
    const answered = evidence(excludedSix, {
      kind: "answer",
      citedTargets: ["item:5", "item:7"],
    });
    assert.equal(find(answered, "explain").status, "completed");
    assert.deepEqual(find(answered, "explain").excludedTargets, [
      { targets: ["item:6"], reason: off },
    ]);
    const allCited = evidence(excludedSix, {
      kind: "answer",
      citedTargets: ["item:6", "item:7"],
    });
    assert.notProperty(find(allCited, "explain"), "excludedTargets");
    // An answer whose citations are unknown leaves the decision as it was.
    const unknown = evidence(excludedSix, { kind: "answer" });
    assert.deepEqual(find(unknown, "explain").excludedTargets, [
      { targets: ["item:6", "item:7"], reason: off },
    ]);
  });

  it("an excluded paper the document cites anyway is done and no longer excluded", function () {
    let ledger = update(empty(), { tasks: [review] }).checkpoint;
    ledger = update(ledger, {
      excluded: [{ taskId: "review", targetIds: ["6", "7"], reason: off }],
    }).checkpoint;
    ledger = evidence(ledger, document(["item:5", "item:7"]));
    const part = find(ledger, "review");
    assert.deepEqual(part.doneTargets, ["item:5", "item:7"]);
    assert.deepEqual(part.excludedTargets, [
      { targets: ["item:6"], reason: off },
    ]);
    assert.isUndefined(part.exceptions);
    assert.equal(decideRunEnd(ledger, RUN), "completed");
    // The accepted answer delivers no artifact part: the review and its
    // exclusion stay as they were.
    const answered = evidence(
      update(empty(), {
        tasks: [{ ...review, taskId: "review" }],
        excluded: [{ taskId: "review", targetIds: ["6"], reason: off }],
      }).checkpoint,
      { kind: "answer", citedTargets: ["item:5", "item:6"] },
    );
    assert.equal(find(answered, "review").status, "pending");
    assert.notProperty(find(answered, "review"), "doneTargets");
    assert.deepEqual(find(answered, "review").excludedTargets, [
      { targets: ["item:6"], reason: off },
    ]);
  });

  it("an exclusion after the document moves its Not covered exception and leaves other reasons", function () {
    let ledger = update(empty(), { tasks: [review] }).checkpoint;
    ledger = evidence(ledger, document(["item:5"]));
    assert.deepEqual(find(ledger, "review").exceptions, [
      { targets: ["item:6", "item:7"], reason: OUTCOME_REASONS.notCovered },
    ]);
    assert.equal(decideRunEnd(ledger, RUN), "completed_with_exceptions");
    // Another reason on the part is the host's, and stays.
    ledger = {
      ...ledger,
      tasks: ledger.tasks.map((task) => ({
        ...task,
        exceptions: [
          ...(task.exceptions || []),
          { targets: ["item:8"], reason: "No readable text" },
        ],
        targets: [...task.targets!, "item:8"],
      })),
    };
    ledger = update(ledger, {
      excluded: [{ taskId: "review", targetIds: ["7"], reason: off }],
    }).checkpoint;
    let part = find(ledger, "review");
    assert.deepEqual(part.exceptions, [
      { targets: ["item:6"], reason: OUTCOME_REASONS.notCovered },
      { targets: ["item:8"], reason: "No readable text" },
    ]);
    assert.deepEqual(part.excludedTargets, [
      { targets: ["item:7"], reason: off },
    ]);
    ledger = update(ledger, {
      excluded: [
        { taskId: "review", targetIds: ["6", "8"], reason: "Off topic" },
      ],
    }).checkpoint;
    part = find(ledger, "review");
    assert.deepEqual(part.exceptions, [
      { targets: ["item:8"], reason: "No readable text" },
    ]);
    assert.deepEqual(part.excludedTargets, [
      { targets: ["item:7"], reason: off },
      { targets: ["item:6", "item:8"], reason: "Off topic" },
    ]);
    assert.equal(part.status, "completed");
    // With every Not covered paper excluded the run is complete.
    const clean = update(
      evidence(
        update(empty(), { tasks: [review] }).checkpoint,
        document(["item:5"]),
      ),
      {
        excluded: [{ taskId: "review", targetIds: ["6", "7"], reason: off }],
      },
    ).checkpoint;
    assert.notProperty(find(clean, "review"), "exceptions");
    assert.equal(decideRunEnd(clean, RUN), "completed");
  });

  it("reads back the excluded count and moves the progress signature", function () {
    const ledger = update(empty(), { tasks: [review] }).checkpoint;
    const before = outcomeProgressSignature(ledger);
    const excluded = update(ledger, {
      excluded: [{ taskId: "review", targetIds: ["6", "7"], reason: off }],
    }).checkpoint;
    assert.notEqual(outcomeProgressSignature(excluded), before);
    assert.equal(
      outcomeProgressSignature(
        update(excluded, {
          excluded: [{ taskId: "review", targetIds: ["7"], reason: off }],
        }).checkpoint,
      ),
      outcomeProgressSignature(excluded),
      "the same exclusion again changes nothing",
    );
  });

  it("an excluded paper of an open artifact part is not read for it", function () {
    const changes = (ledger: ExecutionCheckpoint) =>
      declareOutcomes(
        ledger,
        [
          {
            taskId: "tag",
            description: "Tag each paper",
            effect: "mutation",
            capability: "zotero.tags",
            targets: ["item:5", "item:6", "item:7"],
          },
        ],
        20,
      );
    const declared = changes(update(empty(), { tasks: [review] }).checkpoint);
    assert.deepEqual(
      [...readLongJob(declared)!.reading],
      ["item:5", "item:6", "item:7"],
    );
    const excluded = update(declared, {
      excluded: [{ taskId: "review", targetIds: ["7"], reason: off }],
    }).checkpoint;
    assert.deepEqual([...readLongJob(excluded)!.reading], ["item:5", "item:6"]);
  });
});

describe("task_update: a part changed before it has progress", function () {
  it("changes a part's description in place, keeping its id, place and creation", function () {
    const declared = update(
      empty(),
      { tasks: [review, readAll] },
      { now: 20 },
    ).checkpoint;
    const changed = update(declared, {
      tasks: [{ taskId: "review", description: "Write a short review" }],
    });
    assert.deepEqual(changed.changed, ["review"]);
    assert.isFalse(changed.ignored);
    assert.deepEqual(
      changed.checkpoint.tasks.map((task) => task.taskId),
      [taskId("review"), taskId("read-all")],
    );
    const part = find(changed.checkpoint, "review");
    assert.equal(part.description, "Write a short review");
    assert.equal(part.effect, "artifact");
    assert.equal(part.createdAt, 20);
    assert.deepEqual(part.targets, ["item:5", "item:6", "item:7"]);
    assert.isTrue(part.scope);
  });

  it("freezes new targets in place when the part names other papers or the scope", function () {
    const declared = update(empty(), {
      tasks: [{ ...readAll, scope: undefined, targetIds: ["5"] }],
    }).checkpoint;
    const narrowed = update(declared, {
      tasks: [{ taskId: "read-all", targetIds: ["6", "7"] }],
    });
    assert.deepEqual(narrowed.changed, ["read-all"]);
    assert.deepEqual(find(narrowed.checkpoint, "read-all").targets, [
      "item:6",
      "item:7",
    ]);
    const widened = update(narrowed.checkpoint, {
      tasks: [{ taskId: "read-all", scope: true }],
    });
    assert.deepEqual(find(widened.checkpoint, "read-all").targets, [
      "item:5",
      "item:6",
      "item:7",
    ]);
    assert.isTrue(find(widened.checkpoint, "read-all").scope);
    // The same papers in another order, or the scope it already has, are a
    // repeat.
    const repeated = update(widened.checkpoint, {
      tasks: [{ taskId: "read-all", targetIds: ["7", "item:5", "6"] }],
    });
    assert.deepEqual(repeated.changed, []);
    assert.isTrue(repeated.ignored);
    assert.strictEqual(repeated.checkpoint, widened.checkpoint);
  });

  it("keeps a word-for-word repeat a no-op", function () {
    const declared = update(empty(), { tasks: [review, notes] }).checkpoint;
    const repeated = update(declared, { tasks: [review, notes] });
    assert.isTrue(repeated.ignored);
    assert.deepEqual(repeated.changed, []);
    assert.strictEqual(repeated.checkpoint, declared);
  });

  it("refuses a new description once the part has progress, naming replaces", function () {
    const read = evidence(update(empty(), { tasks: [readAll] }).checkpoint, {
      kind: "read",
      targets: ["item:5"],
      observationIds: ["obs-5"],
    });
    for (const change of [
      { taskId: "read-all", description: "Read each paper's methods" },
      // Item 8 is no paper the part names: a change, not a repeat.
      { taskId: "read-all", targetIds: ["5", "8"] },
    ]) {
      const error = refusal(() => update(read, { tasks: [change] }));
      assert.include(error.message, "already has progress");
      assert.include(error.message, `replaces: "read-all"`);
      assert.include(error.message, "reason");
    }
  });

  it("ignores a repeat that only names papers the part already names, and says nothing changed", function () {
    // A part over the scope, one paper written, declared again on "continue"
    // over the papers it still owes.
    const written = evidence(
      update(empty(), { tasks: [notes] }).checkpoint,
      noteReceipt("item:5"),
    );
    const repeated = update(written, {
      tasks: [
        {
          taskId: "notes",
          expectedEffect: "mutation",
          expectedCapability: "zotero.notes",
          targetIds: ["6", "7"],
        },
      ],
    });
    assert.isTrue(repeated.ignored);
    assert.deepEqual(repeated.changed, []);
    assert.deepEqual(repeated.refused, []);
    assert.strictEqual(repeated.checkpoint, written);
    assert.lengthOf(repeated.checkpoint.tasks, 1, "no part is added");
    assert.deepEqual(find(repeated.checkpoint, "notes").targets, [
      "item:5",
      "item:6",
      "item:7",
    ]);

    // The scope, repeated over a part that named some papers, restates it.
    const partial = evidence(
      update(empty(), {
        tasks: [{ ...readAll, scope: undefined, targetIds: ["5"] }],
      }).checkpoint,
      { kind: "read", targets: ["item:5"], observationIds: ["obs-5"] },
    );
    const scoped = update(partial, {
      tasks: [{ taskId: "read-all", scope: true }],
    });
    assert.isTrue(scoped.ignored);
    assert.strictEqual(scoped.checkpoint, partial);
    // One that names a paper the part does not is a change, and refused.
    refusal(() =>
      update(partial, {
        tasks: [{ taskId: "read-all", targetIds: ["5", "6"] }],
      }),
    );
  });

  it("tells a write part with progress to stay as it is, and to take a new taskId only for papers it does not name", function () {
    const written = evidence(
      update(empty(), { tasks: [notes] }).checkpoint,
      noteReceipt("item:5"),
    );
    const error = refusal(() =>
      update(written, {
        tasks: [
          {
            taskId: "notes",
            expectedEffect: "mutation",
            expectedCapability: "zotero.notes",
            targetIds: ["6", "9"],
          },
        ],
      }),
    );
    assert.include(error.message, "Task notes holds writes");
    assert.include(error.message, "stays as it is");
    assert.include(
      error.message,
      "further writes on its own papers complete it",
    );
    assert.include(error.message, "only for papers it does not name");
    assert.notInclude(
      error.message,
      "Declare the further work as a part under a new taskId",
    );
  });

  it("takes a read capability repeated on a part with progress as a repeat, and still refuses a write capability", function () {
    const read = evidence(update(empty(), { tasks: [readAll] }).checkpoint, {
      kind: "read",
      targets: ["item:5"],
      observationIds: ["obs-5"],
    });
    const repeated = update(read, {
      tasks: [{ taskId: "read-all", expectedCapability: "zotero.read" }],
    });
    assert.isTrue(repeated.ignored);
    assert.deepEqual(repeated.changed, []);
    assert.strictEqual(repeated.checkpoint, read);
    const error = refusal(() =>
      update(read, {
        tasks: [{ taskId: "read-all", expectedCapability: "zotero.notes" }],
      }),
    );
    assert.include(error.message, "already has progress");
    // A digest part with progress still retries under the same repeat.
    const progressed = evidence(
      update(empty(), { tasks: [summaries] }).checkpoint,
      {
        kind: "digest",
        taskId: taskId("summaries"),
        done: ["item:5"],
        failed: [{ target: "item:6", reason: "No readable text" }],
      },
    );
    const retried = update(progressed, {
      tasks: [{ taskId: "summaries", expectedCapability: "zotero.read" }],
    });
    assert.lengthOf(retried.digestParts, 1);
    assert.strictEqual(retried.checkpoint, progressed);
  });

  it("refuses a change to a settled part without offering replaces", function () {
    const skipped = update(empty(), {
      tasks: [review],
      skipped: [{ taskId: "review", reason: "The user withdrew it" }],
    }).checkpoint;
    const error = refusal(() =>
      update(skipped, {
        tasks: [{ taskId: "review", description: "Write a short review" }],
      }),
    );
    assert.include(error.message, "is skipped");
    assert.include(error.message, "new taskId");
    assert.notInclude(error.message, "replaces");
  });

  it("runs a digest part changed in place again, with the new description and question", function () {
    const declared = update(
      empty(),
      { tasks: [summaries] },
      { userText: "Summarize these papers" },
    ).checkpoint;
    const changed = update(
      declared,
      {
        tasks: [
          {
            taskId: "summaries",
            description: "State each paper's evidence on drift",
          },
        ],
      },
      { userText: "What is the evidence for representational drift?" },
    );
    assert.deepEqual(changed.changed, ["summaries"]);
    assert.deepEqual(changed.digestParts, [
      {
        taskId: taskId("summaries"),
        targets: ["item:5", "item:6", "item:7"],
      },
    ]);
    const part = find(changed.checkpoint, "summaries");
    assert.equal(part.description, "State each paper's evidence on drift");
    assert.equal(
      part.question,
      "What is the evidence for representational drift?",
    );
  });

  it("still retries a digest part repeated as it is, over the papers its targetIds name", function () {
    const progressed = evidence(
      update(empty(), { tasks: [summaries] }).checkpoint,
      {
        kind: "digest",
        taskId: taskId("summaries"),
        done: ["item:5"],
        failed: [{ target: "item:6", reason: "No readable text" }],
      },
    );
    for (const repeat of [
      { taskId: "summaries" },
      summaries,
      { taskId: "summaries", targetIds: ["6"] },
    ]) {
      const retried = update(progressed, { tasks: [repeat] });
      assert.deepEqual(retried.changed, [], JSON.stringify(repeat));
      assert.strictEqual(retried.checkpoint, progressed);
      assert.lengthOf(retried.digestParts, 1);
    }
  });
});

describe("task_update: a part replaced once it has progress", function () {
  const reason = "The user narrowed the question to drift";

  function readWithProgress(): ExecutionCheckpoint {
    return evidence(update(empty(), { tasks: [readAll, review] }).checkpoint, {
      kind: "read",
      targets: ["item:5"],
      noText: ["item:6"],
      observationIds: ["obs-5"],
    });
  }

  it("takes replaces and reason on a declaration; reason is required with replaces", function () {
    const tool = createTaskUpdateTool();
    const declaration = (tool.spec.inputSchema as any).properties.tasks.items;
    assert.deepEqual(declaration.properties.replaces, { type: "string" });
    assert.deepEqual(declaration.properties.reason, { type: "string" });
    assert.isFalse(declaration.additionalProperties);
    const result = tool.validate({
      tasks: [{ ...readAll, taskId: "read-drift", replaces: "read-all" }],
    });
    assert.isFalse(result.ok);
    if (!result.ok) assert.match(result.error, /reason/);
  });

  it("cancels the old part with the reason and keeps what it has done", function () {
    const replaced = update(readWithProgress(), {
      tasks: [
        {
          taskId: "read-drift",
          description: "Read each paper's drift results",
          expectedEffect: "read",
          targetIds: ["5", "7"],
          replaces: "read-all",
          reason,
        },
      ],
    });
    assert.deepEqual(replaced.replaced, [
      { taskId: "read-drift", replaces: "read-all" },
    ]);
    const old = find(replaced.checkpoint, "read-all");
    assert.equal(old.status, "cancelled");
    assert.equal(old.reason, reason);
    assert.equal(old.supersededBy, taskId("read-drift"));
    assert.deepEqual(old.doneTargets, ["item:5"]);
    assert.deepEqual(old.readEvidenceIds, ["obs-5"]);
    assert.deepEqual(old.exceptions, [
      { targets: ["item:6"], reason: OUTCOME_REASONS.noText },
    ]);
    const successor = find(replaced.checkpoint, "read-drift");
    assert.equal(successor.status, "pending");
    assert.deepEqual(successor.targets, ["item:5", "item:7"]);
    assert.notProperty(successor, "doneTargets");
    assert.deepEqual(
      replaced.checkpoint.tasks.map((task) => task.taskId),
      [taskId("read-all"), taskId("review"), taskId("read-drift")],
    );
  });

  it("ends the run completed once the successor completes, and settling leaves the old part as it was", function () {
    let ledger = update(readWithProgress(), {
      tasks: [
        {
          taskId: "read-drift",
          description: "Read each paper's drift results",
          expectedEffect: "read",
          targetIds: ["5", "7"],
          replaces: "read-all",
          reason,
        },
      ],
    }).checkpoint;
    ledger = evidence(ledger, {
      kind: "read",
      targets: ["item:5", "item:7"],
      observationIds: ["obs-57"],
    });
    ledger = evidence(ledger, document(["item:5", "item:6", "item:7"]));
    assert.equal(find(ledger, "read-drift").status, "completed");
    assert.equal(decideRunEnd(ledger, RUN), "completed");
    const settled = settleOutcomes(ledger, "completed", 50);
    assert.deepEqual(find(settled, "read-all"), find(ledger, "read-all"));
    // A failed run still counts the old part's work as progress.
    assert.equal(
      decideRunEnd(ledger, {
        status: "failed",
        stopRule: "interrupted_by_error",
      }),
      "interrupted",
    );
  });

  it("refuses replaces on a write part that holds receipts, an id in use, an unknown or settled part", function () {
    const written = evidence(
      update(empty(), {
        tasks: [{ ...notes, scope: undefined, targetIds: ["5", "6"] }],
      }).checkpoint,
      noteReceipt("item:5"),
    );
    const replacement = {
      taskId: "notes-2",
      description: "Save a short note on each paper",
      expectedEffect: "mutation",
      expectedCapability: "zotero.notes",
      targetIds: ["6"],
      replaces: "notes",
      reason,
    };
    let error = refusal(() => update(written, { tasks: [replacement] }));
    assert.include(error.message, "notes");
    assert.include(error.message, "writes");
    assert.lengthOf(written.tasks, 1);

    const pending = update(empty(), { tasks: [review, readAll] }).checkpoint;
    error = refusal(() =>
      update(pending, {
        tasks: [{ ...readAll, replaces: "review", reason }],
      }),
    );
    assert.include(error.message, "new taskId");
    error = refusal(() =>
      update(pending, {
        tasks: [{ ...readAll, taskId: "read-2", replaces: "nothing", reason }],
      }),
    );
    assert.include(error.message, "nothing");
    const skipped = update(pending, {
      skipped: [{ taskId: "review", reason: "The user withdrew it" }],
    }).checkpoint;
    error = refusal(() =>
      update(skipped, {
        tasks: [{ ...review, taskId: "review-2", replaces: "review", reason }],
      }),
    );
    assert.include(error.message, "skipped");
    error = refusal(() =>
      update(pending, {
        tasks: [{ ...review, taskId: "review-2", replaces: "review", reason }],
        cancelled: [{ taskId: "review", reason: "Not needed" }],
      }),
    );
    assert.include(error.message, "only once");
  });

  it("gives a replaced digest part's successor a digest run of its own and no credit from the old one", function () {
    const digested = evidence(
      update(empty(), { tasks: [summaries] }, { userText: "Summarize them" })
        .checkpoint,
      {
        kind: "digest",
        taskId: taskId("summaries"),
        done: ["item:5", "item:6"],
        failed: [],
      },
    );
    const replaced = update(
      digested,
      {
        tasks: [
          {
            taskId: "drift-evidence",
            description: "State each paper's evidence on drift",
            expectedEffect: "digest",
            scope: true,
            replaces: "summaries",
            reason,
          },
        ],
      },
      { userText: "Which papers show drift?" },
    );
    assert.deepEqual(replaced.digestParts, [
      {
        taskId: taskId("drift-evidence"),
        targets: ["item:5", "item:6", "item:7"],
      },
    ]);
    const successor = find(replaced.checkpoint, "drift-evidence");
    assert.notProperty(successor, "doneTargets");
    assert.equal(successor.question, "Which papers show drift?");
    const old = find(replaced.checkpoint, "summaries");
    assert.equal(old.status, "cancelled");
    assert.deepEqual(old.doneTargets, ["item:5", "item:6"]);
    // Declaring the old part again runs nothing and names its successor.
    for (const repeat of [
      { taskId: "summaries" },
      { taskId: "summaries", description: "Summarize the drift papers" },
    ]) {
      const error = refusal(() =>
        update(replaced.checkpoint, { tasks: [repeat] }),
      );
      assert.include(error.message, "replaced by drift-evidence");
    }
    // Digest evidence for the old part moves it no more.
    const late = applyOutcomeEvidence(
      replaced.checkpoint,
      {
        kind: "digest",
        taskId: taskId("summaries"),
        done: ["item:7"],
        failed: [],
      },
      50,
    );
    assert.isFalse(late.changed);
  });

  it("binds a document that names the replaced part to its successor", function () {
    const declared = update(empty(), {
      tasks: [review],
      excluded: [{ taskId: "review", targetIds: ["7"], reason: "Off topic" }],
    }).checkpoint;
    const replaced = update(declared, {
      tasks: [
        {
          taskId: "review-2",
          description: "Write a review of the drift papers",
          expectedEffect: "artifact",
          targetIds: ["5", "6"],
          replaces: "review",
          reason,
        },
      ],
    }).checkpoint;
    assert.deepEqual(find(replaced, "review").excludedTargets, [
      { targets: ["item:7"], reason: "Off topic" },
    ]);
    const delivered = evidence(
      replaced,
      document(["item:5", "item:6"], "doc-2"),
    );
    assert.lengthOf(find(delivered, "review").materialRefs, 0);
    assert.equal(find(delivered, "review").status, "cancelled");
    assert.lengthOf(find(delivered, "review-2").materialRefs, 1);
    assert.equal(find(delivered, "review-2").status, "completed");
    assert.equal(decideRunEnd(delivered, RUN), "completed");
  });

  it("never pages a replaced part in a long job", function () {
    const replaced = update(readWithProgress(), {
      tasks: [
        {
          taskId: "read-drift",
          description: "Read each paper's drift results",
          expectedEffect: "read",
          targetIds: ["7"],
          replaces: "read-all",
          reason,
        },
      ],
    }).checkpoint;
    const job = readLongJob(replaced)!;
    assert.deepEqual(job.partIds, [taskId("read-drift")]);
    assert.deepEqual(job.notDone, ["item:7"]);
    // A pager that followed the old part settles its papers: none is paged.
    const followed = readLongJob(replaced, [taskId("read-all")])!;
    assert.deepEqual(followed.notDone, ["item:7"]);
  });
});

describe("task_update: the question a digest part serves", function () {
  it("saves the user's request on a new digest part, and on no other part", function () {
    const declared = update(
      empty(),
      { tasks: [summaries, review] },
      { userText: "  Which of these papers test drift?  " },
    ).checkpoint;
    assert.equal(
      find(declared, "summaries").question,
      "Which of these papers test drift?",
    );
    assert.notProperty(find(declared, "review"), "question");
  });

  it("copies the newest saved question on continue, and saves none when no part has one", function () {
    let ledger = update(
      empty(),
      { tasks: [summaries] },
      { userText: "Summarize the drift papers" },
    ).checkpoint;
    ledger = update(
      ledger,
      { tasks: [{ ...summaries, taskId: "methods" }] },
      { userText: "Now compare their methods" },
    ).checkpoint;
    const resumed = update(
      ledger,
      { tasks: [{ ...summaries, taskId: "limits" }] },
      { userText: "Continue." },
    ).checkpoint;
    assert.equal(find(resumed, "limits").question, "Now compare their methods");
    const bare = update(
      empty(),
      { tasks: [summaries] },
      { userText: "继续" },
    ).checkpoint;
    assert.notProperty(find(bare, "summaries"), "question");
  });

  it("keeps a part's question when it is repeated or retried", function () {
    const declared = update(
      empty(),
      { tasks: [summaries] },
      { userText: "Summarize the drift papers" },
    ).checkpoint;
    for (const repeat of [{ taskId: "summaries" }, summaries]) {
      const repeated = update(
        declared,
        { tasks: [repeat] },
        { userText: "continue" },
      );
      assert.strictEqual(repeated.checkpoint, declared);
      assert.equal(
        find(repeated.checkpoint, "summaries").question,
        "Summarize the drift papers",
      );
    }
  });

  it("keeps at most 2,000 characters, ending a shortened question with the marker", function () {
    const long = "Why does drift happen? ".repeat(200);
    const declared = update(
      empty(),
      { tasks: [summaries] },
      { userText: long },
    ).checkpoint;
    const question = find(declared, "summaries").question!;
    assert.isAtMost(question.length, 2_000);
    assert.match(question, / \[shortened\]$/);
    assert.isTrue(long.startsWith(question.slice(0, -" [shortened]".length)));
    const fits = "x".repeat(2_000);
    assert.equal(
      find(
        update(empty(), { tasks: [summaries] }, { userText: fits }).checkpoint,
        "summaries",
      ).question,
      fits,
    );
  });

  it("the tool saves the turn's request through its context", async function () {
    const request = resolvedAgentRequest({
      conversationKey: 52,
      mode: "agent",
      userText: "Which of these papers test drift?",
      libraryID: 1,
      executionContext,
    });
    request.turnScopePapers = SCOPE;
    const context = {
      request,
      runId: "run-select",
      item: null,
      currentAnswerText: "",
      modelName: "test",
      updateExecutionCheckpoint: async (
        apply: (checkpoint: ExecutionCheckpoint) => ExecutionCheckpoint,
      ) => {
        const next = apply(request.executionCheckpoint || empty());
        request.executionCheckpoint = next;
        return next;
      },
    } as unknown as AgentToolContext;
    const tool = createTaskUpdateTool();
    const answer = (await tool.execute(
      input({
        tasks: [summaries, review],
        excluded: [
          { taskId: "review", targetIds: ["7"], reason: "Off the question" },
        ],
      }),
      context,
    )) as { parts: Record<string, unknown>[] };
    assert.equal(
      find(request.executionCheckpoint!, "summaries").question,
      "Which of these papers test drift?",
    );
    assert.deepEqual(answer.parts[1], {
      taskId: "review",
      status: "pending",
      done: 0,
      total: 3,
      excluded: 1,
      scope: true,
    });
  });
});

describe("task_update with nothing attached: the agent names its papers", function () {
  /** A Library chat with an empty context bar: the scope is the library. */
  const LIBRARY: TaskPaperScopeSet = {
    wholeLibrary: true,
    itemIds: Array.from({ length: 16 }, (_, index) => 101 + index),
    withText: 15,
  };
  const inLibrary = (
    checkpoint: ExecutionCheckpoint,
    args: unknown,
    options: { now?: number } = {},
  ) => update(checkpoint, args, { ...options, scope: LIBRARY });
  const answer = {
    taskId: "answer",
    description: "Answer which papers test drift",
    expectedEffect: "reasoning",
    scope: true,
  };

  function assertScopeNote(error: ToolInputRejection, local: string) {
    assert.include(
      error.message,
      `Nothing is attached, so scope:true on task ${local} would cover the whole library (16 papers).`,
    );
    assert.include(error.message, "library_retrieve first");
    assert.include(error.message, "their targetIds");
    assert.include(error.message, "library_search");
    // Listing every id is offered only for an explicit every-paper request.
    assert.include(
      error.message,
      "only when the user explicitly asked for every paper in the library",
    );
  }

  it("refuses scope:true on a new read, digest, artifact or reasoning part, naming the library's size and the search to run first", function () {
    for (const part of [readAll, summaries, review, answer]) {
      const ledger = empty();
      const before = structuredClone(ledger);
      assertScopeNote(
        refusal(() => inLibrary(ledger, { tasks: [part] })),
        part.taskId,
      );
      assert.deepEqual(
        ledger,
        before,
        `${part.taskId}: the ledger is as it was`,
      );
    }
  });

  it("refuses the whole call: the other parts it declares are not declared", function () {
    const ledger = update(empty(), {
      tasks: [{ ...review, scope: undefined }],
    }).checkpoint;
    const before = structuredClone(ledger);
    assertScopeNote(
      refusal(() =>
        inLibrary(ledger, {
          tasks: [notes, { ...summaries, targetIds: undefined }],
          skipped: [{ taskId: "review", reason: "Not needed" }],
        }),
      ),
      "summaries",
    );
    assert.deepEqual(ledger, before);
  });

  it("keeps scope:true on a write part, which acts on the whole library", function () {
    const declared = inLibrary(empty(), { tasks: [notes] }).checkpoint;
    const part = find(declared, "notes");
    assert.equal(part.effect, "mutation");
    assert.isTrue(part.scope);
    assert.lengthOf(part.targets || [], 16);
    // A part a write capability makes a write takes it too.
    const tagged = inLibrary(empty(), {
      tasks: [
        {
          taskId: "tag",
          description: "Tag every paper read",
          expectedEffect: "read",
          expectedCapability: "zotero.tags",
          scope: true,
        },
      ],
    }).checkpoint;
    assert.equal(find(tagged, "tag").effect, "mutation");
    assert.isTrue(find(tagged, "tag").scope);
  });

  it("takes a part that names its papers with targetIds, with or without scope:true beside them", function () {
    const declared = inLibrary(empty(), {
      tasks: [
        { ...summaries, scope: undefined, targetIds: ["103", "item:107"] },
        { ...review, targetIds: ["103"] },
      ],
    });
    assert.deepEqual(declared.digestParts, [
      { taskId: taskId("summaries"), targets: ["item:103", "item:107"] },
    ]);
    assert.deepEqual(find(declared.checkpoint, "summaries").targets, [
      "item:103",
      "item:107",
    ]);
    assert.isUndefined(find(declared.checkpoint, "summaries").scope);
    assert.deepEqual(find(declared.checkpoint, "review").targets, ["item:103"]);
    assert.isUndefined(find(declared.checkpoint, "review").scope);
  });

  it("refuses scope:true as an in-place change and on a replacement", function () {
    const declared = inLibrary(empty(), {
      tasks: [{ ...readAll, scope: undefined, targetIds: ["103"] }],
    }).checkpoint;
    assertScopeNote(
      refusal(() =>
        inLibrary(declared, { tasks: [{ taskId: "read-all", scope: true }] }),
      ),
      "read-all",
    );
    assertScopeNote(
      refusal(() =>
        inLibrary(declared, {
          tasks: [
            {
              ...readAll,
              taskId: "read-all-2",
              replaces: "read-all",
              reason: "The question needs every paper",
            },
          ],
        }),
      ),
      "read-all-2",
    );
  });

  it("leaves a part declared over the whole scope before as it is when it is repeated", function () {
    // A part from a run saved before the rule, which froze the library's
    // papers: the same papers, frozen as a scope that is not the library's.
    const legacy = update(
      empty(),
      { tasks: [readAll] },
      { scope: { ...LIBRARY, wholeLibrary: false } },
    ).checkpoint;
    assert.lengthOf(find(legacy, "read-all").targets || [], 16);
    const repeated = inLibrary(legacy, { tasks: [readAll] });
    assert.isTrue(repeated.ignored);
    assert.strictEqual(repeated.checkpoint, legacy);
  });

  it("takes scope:true for every effect when context is attached, as before", function () {
    const declared = update(empty(), {
      tasks: [readAll, summaries, review, answer],
    });
    for (const local of ["read-all", "summaries", "review", "answer"]) {
      const part = find(declared.checkpoint, local);
      assert.deepEqual(part.targets, ["item:5", "item:6", "item:7"], local);
      assert.isTrue(part.scope, local);
    }
    assert.deepEqual(declared.digestParts, [
      {
        taskId: taskId("summaries"),
        targets: ["item:5", "item:6", "item:7"],
      },
    ]);
  });
});
