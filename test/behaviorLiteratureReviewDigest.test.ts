import { assert } from "chai";
import type { AgentEvent } from "../src/agent/types";
import { selectSteps } from "../test-behavior/catalog";
import {
  assertLibraryScopeReached,
  assertLiteratureReviewDigest,
  assertLiteratureReviewLibrary,
  literatureReviewLibraryReport,
  literatureReviewReport,
} from "../test-behavior/literatureReviewDigest";

function call(name: string, args: unknown, id = `${name}-call`): AgentEvent {
  return { type: "tool_call", callId: id, name, args };
}

function result(
  name: string,
  content: unknown,
  ok = true,
  id = `${name}-call`,
): AgentEvent {
  return {
    type: "tool_result",
    callId: id,
    name,
    ok,
    actionReceipts: [],
    content,
  };
}

const PASSING: AgentEvent[] = [
  call("task_update", {
    tasks: [
      { taskId: "papers", expectedEffect: "digest", scope: true },
      { taskId: "review", expectedEffect: "artifact" },
    ],
  }),
  result("task_update", {
    parts: [],
    digests: "...",
    digestHandles: [{ itemId: 1, handle: "trh_1" }],
  }),
  call("submit_document", {
    title: "Review",
    markdown: "Claim [[cite:C1]].",
    citations: [{ id: "C1", libraryID: 1, itemKey: "ABCD1234" }],
  }),
  result("submit_document", { documentId: "doc-1" }),
];

function turn(events: AgentEvent[]) {
  return { events, result: { kind: "completed" }, prompt: "" };
}

function withoutDocument(events: AgentEvent[]): AgentEvent[] {
  return events.filter(
    (event) => !("name" in event && event.name === "submit_document"),
  );
}

describe("behavior step skills.literature-review-digest", function () {
  it("is selectable by id and by its journey", function () {
    assert.deepEqual(
      selectSteps("full", ["skills.literature-review-digest"]).map(
        (step) => step.id,
      ),
      ["skills.literature-review-digest"],
    );
    assert.deepEqual(
      selectSteps("full", ["skills"]).map((step) => step.id),
      [
        "skills.literature-review-digest",
        "skills.literature-review-library",
        "skills.literature-review-outside-cite",
        "skills.literature-review-outside-import",
        "skills.literature-review-outside-later-import",
        "skills.literature-review-ambiguous-chat",
      ],
    );
    assert.notInclude(
      selectSteps("smoke").map((step) => step.id),
      "skills.literature-review-digest",
    );
  });

  it("passes a digest part, finished digests and a cited submit_document", function () {
    assertLiteratureReviewDigest(turn(PASSING));
  });

  it("fails without a declared digest part", function () {
    const events = PASSING.map((event) =>
      event.type === "tool_call" && event.name === "task_update"
        ? call("task_update", {
            tasks: [{ taskId: "papers", expectedEffect: "read" }],
          })
        : event,
    );
    assert.throws(
      () => assertLiteratureReviewDigest(turn(events)),
      /digest part/,
    );
  });

  it("fails when digests are left pending", function () {
    const events = [
      ...PASSING.slice(0, 2),
      result("task_update", { parts: [], digestPending: ["item:2"] }),
      ...PASSING.slice(2),
    ];
    assert.throws(() => assertLiteratureReviewDigest(turn(events)), /pending/);
  });

  it("fails without any submit_document call", function () {
    assert.throws(
      () => assertLiteratureReviewDigest(turn(withoutDocument(PASSING))),
      /never called with a citation/,
    );
  });

  it("fails when the review cites nothing", function () {
    const events = PASSING.map((event) =>
      event.type === "tool_call" && event.name === "submit_document"
        ? call("submit_document", { title: "Review", citations: [] })
        : event,
    );
    assert.throws(() => assertLiteratureReviewDigest(turn(events)), /citation/);
  });

  it("fails when submit_document does not succeed", function () {
    const events = PASSING.map((event) =>
      event.type === "tool_result" && event.name === "submit_document"
        ? result("submit_document", { error: "no" }, false)
        : event,
    );
    assert.throws(
      () => assertLiteratureReviewDigest(turn(events)),
      /never succeeded/,
    );
  });

  it("names the document stages in the Held and Not held line", function () {
    const report = literatureReviewReport(turn(withoutDocument(PASSING)));
    assert.include(
      report,
      "Not held: submit_document called with a citation; submit_document succeeded.",
    );
    assert.notInclude(report, "Bonus");
    assert.include(
      literatureReviewReport(turn(PASSING)),
      "submit_document succeeded. Not held: none.",
    );
  });

  it("reports whether the literature-review skill was loaded", function () {
    assert.include(literatureReviewReport(turn(PASSING)), "Skill loaded: no.");
    const events = [
      call("load_skill", { id: "literature-review" }),
      ...PASSING,
    ];
    assert.include(literatureReviewReport(turn(events)), "Skill loaded: yes.");
  });

  it("reports the parts open at the last task_update", function () {
    assert.include(
      literatureReviewReport(turn(PASSING)),
      "Parts open at the last task_update: none.",
    );
    const events = [
      ...PASSING,
      result("task_update", {
        parts: [
          { taskId: "papers", status: "completed" },
          { taskId: "review", status: "in_progress" },
          { taskId: "extra", status: "skipped" },
        ],
      }),
    ];
    assert.include(
      literatureReviewReport(turn(events)),
      "Parts open at the last task_update: review.",
    );
  });

  it("reports the parts open at the end from the ledger before it settled", function () {
    const task = (taskId: string, status: string) => ({
      taskId,
      status,
      origin: "model",
      effect: "read",
    });
    const ledger = (tasks: unknown[], end?: unknown) =>
      ({
        type: "execution_checkpoint",
        checkpoint: {
          version: 1,
          executionId: "e",
          tasks,
          ...(end ? { end } : {}),
        },
      }) as unknown as AgentEvent;
    assert.include(
      literatureReviewReport(turn(PASSING)),
      "Parts open at the end: unknown",
    );
    const settled = [
      ...PASSING,
      ledger([task("papers", "completed"), task("review", "pending")]),
      ledger([task("papers", "completed"), task("review", "skipped")], {
        state: "completed_with_exceptions",
      }),
    ];
    assert.include(
      literatureReviewReport(turn(settled)),
      "Parts open at the end: review (run end: completed_with_exceptions).",
    );
    const closed = [
      ledger([task("papers", "completed")]),
      ledger([task("papers", "completed")], { state: "completed" }),
    ];
    assert.include(
      literatureReviewReport(turn(closed)),
      "Parts open at the end: none (run end: completed).",
    );
  });
});

const REVIEW_DOCUMENT: AgentEvent[] = [
  call("submit_document", {
    title: "Review",
    markdown: "Claim [[cite:C1]].",
    citations: [{ id: "C1", libraryID: 1, itemKey: "ABCD1234" }],
  }),
  result("submit_document", { documentId: "doc-1" }),
];

const LIBRARY_DIGEST: AgentEvent[] = [
  call("task_update", {
    tasks: [
      {
        taskId: "papers",
        expectedEffect: "digest",
        targetIds: ["1", "item:2"],
      },
      { taskId: "review", expectedEffect: "artifact" },
    ],
  }),
  result("task_update", {
    parts: [],
    digestHandles: [{ itemId: 1, handle: "trh_1" }],
  }),
  ...REVIEW_DOCUMENT,
];

function paperRead(args: unknown, callId: string, ok = true): AgentEvent[] {
  return [
    call("paper_read", args, callId),
    result("paper_read", { status: "ok" }, ok, callId),
  ];
}

function libraryReadTurn(declared: string[], read: number[]): AgentEvent[] {
  return [
    call("task_update", {
      tasks: [
        { taskId: "papers", expectedEffect: "read", targetIds: declared },
        { taskId: "review", expectedEffect: "artifact" },
      ],
    }),
    ...read.flatMap((itemId) =>
      paperRead({ mode: "overview", target: { itemId } }, `read-${itemId}`),
    ),
    ...REVIEW_DOCUMENT,
  ];
}

describe("behavior step skills.literature-review-library", function () {
  it("is selectable by id, and is not in smoke", function () {
    assert.deepEqual(
      selectSteps("full", ["skills.literature-review-library"]).map(
        (step) => step.id,
      ),
      ["skills.literature-review-library"],
    );
    assert.notInclude(
      selectSteps("smoke").map((step) => step.id),
      "skills.literature-review-library",
    );
  });

  it("passes the digest branch", function () {
    assertLiteratureReviewLibrary(turn(LIBRARY_DIGEST));
    assert.include(
      literatureReviewLibraryReport(turn(LIBRARY_DIGEST)),
      "Branch: digest; targets: 2.",
    );
  });

  it("fails a digest part that names no targetIds", function () {
    const events = LIBRARY_DIGEST.map((event) =>
      event.type === "tool_call" && event.name === "task_update"
        ? call("task_update", {
            tasks: [
              { taskId: "papers", expectedEffect: "digest", scope: true },
            ],
          })
        : event,
    );
    assert.throws(
      () => assertLiteratureReviewLibrary(turn(events)),
      /digest part with targetIds/,
    );
  });

  it("fails the digest branch with a digest left pending", function () {
    const events = [
      ...LIBRARY_DIGEST.slice(0, 2),
      result("task_update", { parts: [], digestPending: ["item:2"] }),
      ...LIBRARY_DIGEST.slice(2),
    ];
    assert.throws(() => assertLiteratureReviewLibrary(turn(events)), /pending/);
  });

  it("passes the read branch with four papers or fewer", function () {
    const events = libraryReadTurn(["1", "item:2", "3"], [1, 2, 3]);
    assertLiteratureReviewLibrary(turn(events));
    assert.include(
      literatureReviewLibraryReport(turn(events)),
      "Branch: read; targets: 3. Papers read: 3.",
    );
  });

  it("counts papers read from target and targets, and ignores failed reads", function () {
    const events = [
      ...libraryReadTurn(["1", "2", "3", "4"], []).slice(0, 1),
      ...paperRead(
        { mode: "overview", targets: [{ itemId: 1 }, { itemId: 2 }] },
        "a",
      ),
      ...paperRead(
        { mode: "overview", target: { itemId: 3, contextItemId: 9 } },
        "b",
      ),
      ...paperRead({ mode: "overview", target: { itemId: 4 } }, "c"),
      ...paperRead({ mode: "overview", target: { itemId: 5 } }, "d", false),
      ...paperRead({ mode: "targeted", target: { itemId: 1 } }, "e"),
      ...REVIEW_DOCUMENT,
    ];
    assertLiteratureReviewLibrary(turn(events));
    assert.include(
      literatureReviewLibraryReport(turn(events)),
      "Papers read: 4.",
    );
  });

  it("fails the read branch when a declared target was not read", function () {
    assert.throws(
      () =>
        assertLiteratureReviewLibrary(
          turn(libraryReadTurn(["1", "2", "3"], [1, 2])),
        ),
      /read every declared target/,
    );
  });

  it("fails the read branch declaring more than four targets", function () {
    assert.throws(
      () =>
        assertLiteratureReviewLibrary(
          turn(libraryReadTurn(["1", "2", "3", "4", "5"], [1, 2, 3, 4, 5])),
        ),
      /read part with 1 to 4 targetIds/,
    );
  });

  it("fails more than four papers read with no digest part", function () {
    assert.throws(
      () =>
        assertLiteratureReviewLibrary(
          turn(libraryReadTurn(["1", "2", "3"], [1, 2, 3, 4, 5])),
        ),
      /at most 4 papers/,
    );
    const noParts = [
      ...[1, 2, 3, 4, 5].flatMap((itemId) =>
        paperRead({ mode: "overview", target: { itemId } }, `read-${itemId}`),
      ),
      ...REVIEW_DOCUMENT,
    ];
    assert.throws(
      () => assertLiteratureReviewLibrary(turn(noParts)),
      /digest part or a read part/,
    );
    assert.include(
      literatureReviewLibraryReport(turn(noParts)),
      "Branch: none; targets: 0.",
    );
  });

  it("fails the read branch when the document cites more than four papers", function () {
    const events = [
      ...libraryReadTurn(["1", "2"], [1, 2]).slice(0, -REVIEW_DOCUMENT.length),
      call("submit_document", {
        title: "Review",
        markdown: "Claims.",
        citations: Array.from({ length: 8 }, (_, i) => ({
          id: `C${i + 1}`,
          libraryID: 1,
          itemKey: `KEY${i}`,
        })),
      }),
      result("submit_document", { documentId: "doc-1" }),
    ];
    assert.throws(
      () => assertLiteratureReviewLibrary(turn(events)),
      /the document cites at most 4 papers/,
    );
  });

  it("fails on either branch without a successful cited submit_document", function () {
    assert.throws(
      () =>
        assertLiteratureReviewLibrary(turn(withoutDocument(LIBRARY_DIGEST))),
      /submit_document called with a citation/,
    );
    const read = libraryReadTurn(["1", "2"], [1, 2]);
    assert.throws(
      () => assertLiteratureReviewLibrary(turn(withoutDocument(read))),
      /submit_document called with a citation/,
    );
    const failed = read.map((event) =>
      event.type === "tool_result" && event.name === "submit_document"
        ? result("submit_document", { error: "no" }, false)
        : event,
    );
    assert.throws(
      () => assertLiteratureReviewLibrary(turn(failed)),
      /submit_document succeeded/,
    );
  });

  it("checks that nothing was attached to the turn", function () {
    const envelope = (payload: Record<string, number>): AgentEvent => ({
      type: "provider_event",
      providerType: "agent_context_envelope",
      payload,
    });
    const none = {
      selectedPaperCount: 0,
      selectedCollectionCount: 0,
      selectedTagCount: 0,
    };
    assertLibraryScopeReached(turn([envelope(none)]));
    for (const attached of [
      { selectedPaperCount: 1 },
      { selectedCollectionCount: 1 },
      { selectedTagCount: 1 },
    ])
      assert.throws(
        () =>
          assertLibraryScopeReached(turn([envelope({ ...none, ...attached })])),
        /attached/,
      );
    assert.throws(() => assertLibraryScopeReached(turn([])), /envelope/);
  });
});
