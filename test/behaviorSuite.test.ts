import { assert } from "chai";
import { readFileSync } from "node:fs";
import type { AgentPendingAction } from "../src/agent/types";
import {
  runSteps,
  redact,
  confirmationDecision,
  assertExact,
  reportExitCode,
  appendTurnHistory,
  assertApprovalProposal,
  failedTurnError,
  type BehaviorStep,
} from "../test-behavior/core";
import { selectSteps, catalog } from "../test-behavior/catalog";
import {
  normalizeNative,
  diff,
  exactFieldChange,
} from "../test-behavior/native";
import {
  createEvidenceWriter,
  validateReportLocation,
} from "../test-behavior/evidence";
import {
  assertConversationSummary,
  assertHumanCitationLabels,
  snapshotFiles,
} from "../test-behavior/oracles";

describe("manually invoked behavior suite contract", function () {
  it("exercises research publication through the real chat sender, never by marking the outbox delivered", function () {
    const journey = readFileSync("test-behavior/research.ts", "utf8");
    assert.include(journey, "harness.askStandalone(planningPrompt)");
    assert.include(journey, "harness.askStandalone(executionPrompt)");
    assert.include(journey, "publication.status");
    assert.notInclude(journey, "deliverPendingPlanDocumentMessage");
    assert.notInclude(journey, "markPlanDocumentDelivered");
  });
  it("requires direct note creation in every mode, without turning the suite into a release gate", function () {
    for (const mode of ["safe", "auto", "yolo"] as const) {
      const note = catalog.find((row) => row.id === `modes.${mode}.note`)!;
      assert.include(note.acceptance, "without confirmation");
      assert.include(note.acceptance, "saved-note card");
      assert.exists(confirmationDecision(mode, "none", "review", true).failure);
    }
    const runner = readFileSync("scripts/run-behavior-tests.mjs", "utf8");
    assert.match(
      runner,
      /git\("diff", "HEAD", "--"\)/,
      "source evidence covers tracked CSS and all other changed build inputs",
    );
  });
  it("keeps the original assertion visible when cancelling a failed live turn", async function () {
    const results = await runSteps([
      {
        id: "unexpected-card",
        dependsOn: [],
        run: async () => {
          throw failedTurnError(new Error("Aborted"), [
            "Unexpected confirmation: note_write",
          ]);
        },
      },
    ]);
    assert.equal(results[0].status, "FAIL");
    assert.include(results[0].detail, "Unexpected confirmation: note_write");
    assert.include(results[0].detail, "Aborted");
  });
  it("rejects flattened or internal-ID citations even when the saved note content passes", function () {
    assert.throws(() => assertHumanCitationLabels([], 1), /count/);
    assert.throws(
      () => assertHumanCitationLabels(["Paper 3890"], 1),
      /internal/,
    );
    assertHumanCitationLabels(["Fixture, 2024"], 1);
  });
  it("classifies an effectful content-review card as Safe approval, not paper discovery", function () {
    assert.deepEqual(confirmationDecision("safe", "approval", "review", true), {
      approve: true,
    });
    assert.deepEqual(confirmationDecision("safe", "cancel", "review", true), {
      approve: false,
    });
    assert.isString(
      confirmationDecision("auto", "none", "review", true).failure,
    );
    assert.isString(
      confirmationDecision("yolo", "review", "review", true).failure,
    );
    assert.deepEqual(confirmationDecision("yolo", "review", "review", false), {
      approve: false,
    });
  });
  it("keeps direct multi-turn history in the model's content schema", function () {
    const first = appendTurnHistory([], "First question", "First answer");
    const second = appendTurnHistory(first, "Follow-up", "Second answer");
    assert.deepEqual(second, [
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
      { role: "user", content: "Follow-up" },
      { role: "assistant", content: "Second answer" },
    ]);
    assert.lengthOf(first, 2);
  });
  it("only approves a note content-review bound to the exact requested item and proposed content", function () {
    const action: AgentPendingAction = {
      toolName: "note_write",
      title: "Review new note",
      confirmLabel: "Create note",
      cancelLabel: "Cancel",
      fields: [
        {
          type: "textarea",
          id: "content",
          label: "Final note content",
          value: "Exact content",
        },
      ],
    };
    const args = {
      mode: "create",
      target: "item",
      targetItemId: 42,
      content: "Exact content",
    };
    assertApprovalProposal(action, args, 42);
    assert.throws(() => assertApprovalProposal(action, args, 43));
    assert.throws(() =>
      assertApprovalProposal(action, { ...args, content: "Changed" }, 42),
    );
  });
  it("checks the native Safe file card path and payload without requiring a targets field", function () {
    const action: AgentPendingAction = {
      toolName: "file_io",
      title: "Write file: safe.md",
      confirmLabel: "Write",
      cancelLabel: "Cancel",
      fields: [
        { type: "text", id: "path", label: "File", value: "/vault/safe.md" },
        {
          type: "textarea",
          id: "preview",
          label: "Content preview",
          value: "Mode safe file probe.",
        },
      ],
    };
    const args = {
      action: "write",
      filePath: "/vault/safe.md",
      content: "Mode safe file probe.",
    };
    assertApprovalProposal(action, args);
    assert.throws(() =>
      assertApprovalProposal(action, { ...args, filePath: "/vault/wrong.md" }),
    );
    assert.throws(() =>
      assertApprovalProposal(action, { ...args, content: "Changed payload" }),
    );
    assert.throws(() =>
      assertApprovalProposal(action, { ...args, action: "delete" }),
    );
  });
  it("checks the native Safe metadata review title, item identity and changed fields", function () {
    const action: AgentPendingAction = {
      toolName: "library_update",
      title: "Update metadata for Fixture paper",
      mode: "review",
      confirmLabel: "Apply",
      cancelLabel: "Cancel",
      fields: [
        {
          type: "review_table",
          id: "metadataReview:undefined",
          rows: [
            {
              key: "publicationTitle",
              label: "Journal",
              before: "Before",
              after: "After",
            },
          ],
        },
      ],
    };
    const args = {
      kind: "metadata",
      itemId: 42,
      metadata: { publicationTitle: "After" },
    };
    assertApprovalProposal(action, args, 42, "Fixture paper");
    assert.throws(() =>
      assertApprovalProposal(action, args, 43, "Fixture paper"),
    );
    assert.throws(() =>
      assertApprovalProposal(action, args, 42, "Different paper"),
    );
    assert.throws(() =>
      assertApprovalProposal(
        action,
        { ...args, metadata: { publicationTitle: "Wrong" } },
        42,
        "Fixture paper",
      ),
    );
    assert.throws(() =>
      assertApprovalProposal(
        action,
        {
          ...args,
          metadata: { publicationTitle: "After", title: "Extra edit" },
        },
        42,
        "Fixture paper",
      ),
    );
    assert.throws(() =>
      assertApprovalProposal(
        { ...action, fields: [] },
        args,
        42,
        "Fixture paper",
      ),
    );
  });
  it("detects file effects before approval, including changed existing bytes", async function () {
    let contents = new Uint8Array([1, 2, 3]);
    const io = {
      getChildren: async () => ["/vault/note.md"],
      stat: async () => ({ type: "regular" }),
      read: async () => contents,
    };
    const hash = async (bytes: Uint8Array) => [...bytes].join(":");
    const before = await snapshotFiles("/vault", io, hash);
    contents = new Uint8Array([4, 5, 6]);
    const after = await snapshotFiles("/vault", io, hash);
    assert.throws(() =>
      assertExact(after, before, "External state before approval"),
    );
  });
  it("does not let a paper-only summary masquerade as retained conversation memory", function () {
    const paperOnly =
      "Hypothesis amber Methods cobalt Figure violet Results silver Limitations copper Implications jade 0.80 0.52";
    assert.throws(() => assertConversationSummary(paperOnly), /teal/);
    assertConversationSummary(
      paperOnly +
        " Our proposed teal-extension uses 23 sessions. Our ochre-no-causality caution is a discussion decision.",
    );
  });
  it("accepts a normalized report root and rejects traversal", function () {
    validateReportLocation(
      "/repo/",
      "/repo/tmp/behavior-reports/run",
      "/repo/tmp/behavior-reports/run/request.json",
    );
    assert.throws(() =>
      validateReportLocation(
        "/repo",
        "/repo/tmp/behavior-reports/../other",
        "/repo/tmp/behavior-reports/../other/request.json",
      ),
    );
  });

  it("creates the event log before appending and preserves incremental evidence", async function () {
    const files = new Map<string, string>();
    const write = createEvidenceWriter("/report", ["SECRET"], {
      makeDirectory: async () => {},
      exists: async (path) => files.has(path),
      writeUTF8: async (path, value, options) => {
        if (options?.mode === "append" && !files.has(path))
          throw new Error("NS_ERROR_FILE_NOT_FOUND");
        files.set(
          path,
          (options?.mode === "append" ? files.get(path) : "") + value,
        );
      },
    });
    await write("events.jsonl", { type: "start", text: "SECRET" });
    await write("events.jsonl", { type: "done" });
    const text = files.get("/report/events.jsonl")!;
    assert.equal(text.trim().split("\n").length, 2);
    assert.notInclude(text, "SECRET");
  });
  it("rejects unknown selections and has unique, covered contract IDs", function () {
    assert.throws(() => selectSteps("smoke", ["typo"]), /Unknown/);
    assert.equal(new Set(catalog.map((s) => s.id)).size, catalog.length);
    assert.isAbove(selectSteps("full").length, selectSteps("smoke").length);
    for (const step of catalog) {
      assert.isNotEmpty(step.acceptance);
      assert.isNotEmpty(step.evidence);
    }
  });

  it("never approves an unexpected Auto or YOLO confirmation", function () {
    for (const mode of ["auto", "yolo"] as const) {
      assert.deepEqual(confirmationDecision(mode, "none", "approval"), {
        approve: false,
        failure: "Unexpected confirmation",
      });
    }
    assert.equal(
      confirmationDecision("safe", "approval", "approval").approve,
      true,
    );
    assert.equal(
      confirmationDecision("safe", "cancel", "approval").approve,
      false,
    );
    assert.equal(
      confirmationDecision("yolo", "review", "approval").approve,
      false,
    );
    assert.equal(
      confirmationDecision("yolo", "review", "review").approve,
      false,
    );
    assert.isUndefined(
      confirmationDecision("yolo", "review", "review").failure,
    );
  });

  it("requires exact native state, not a percentage threshold", function () {
    assert.throws(() => assertExact([1, 2], [1, 2, 3], "members"), /members/);
    assertExact([1, 2, 3], [1, 2, 3], "members");
  });

  it("reports dependencies without preventing independent steps", async function () {
    const executed: string[] = [];
    const steps: BehaviorStep[] = [
      {
        id: "a",
        dependsOn: [],
        run: async () => {
          throw new Error("broken");
        },
      },
      {
        id: "b",
        dependsOn: ["a"],
        run: async () => {
          executed.push("b");
        },
      },
      {
        id: "c",
        dependsOn: [],
        run: async () => {
          executed.push("c");
        },
      },
    ];
    const checkpoints: string[] = [];
    const results = await runSteps(steps, async (rows) => {
      checkpoints.push(rows.at(-1)!.id);
    });
    assert.deepEqual(
      results.map((r) => r.status),
      ["FAIL", "BLOCKED_BY_DEPENDENCY", "PASS"],
    );
    assert.deepEqual(executed, ["c"]);
    assert.deepEqual(checkpoints, ["a", "b", "c"]);
    assert.equal(reportExitCode(results), 1);
  });

  it("does not confuse missing prerequisites or human review with a pass", async function () {
    const results = await runSteps([
      {
        id: "credentials",
        dependsOn: [],
        run: async () => ({ status: "BLOCKED", detail: "No credentials" }),
      },
      {
        id: "quality",
        dependsOn: [],
        run: async () => ({
          status: "REVIEW_REQUIRED",
          detail: "Read review.md",
        }),
      },
    ]);
    assert.deepEqual(
      results.map((r) => r.status),
      ["BLOCKED", "REVIEW_REQUIRED"],
    );
    assert.equal(reportExitCode(results), 1);
    assert.equal(reportExitCode([results[1]]), 0);
  });

  it("redacts credential fields, authorization headers and known secret substrings", function () {
    const clean = JSON.stringify(
      redact(
        {
          apiKey: "abc",
          nested: [{ authorization: "Bearer xyz" }],
          error: "Oops SECRET URL https://a.test/?api_key=foo",
          text: "Bearer private-value",
        },
        ["SECRET"],
      ),
    );
    for (const secret of ["abc", "xyz", "SECRET", "foo", "private-value"])
      assert.notInclude(clean, secret);
  });

  it("keeps automatic checks and release paths independent of live behavior runs", function () {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    for (const name of [
      "test",
      "build",
      "release",
      "test:workflow",
      "test:unit",
    ]) {
      assert.notMatch(pkg.scripts[name], /test:behavior|run-behavior/);
    }
    assert.equal(
      pkg.scripts["test:behavior"],
      "node scripts/run-behavior-tests.mjs",
    );
    assert.equal(
      pkg.scripts["test:behavior:smoke"],
      "node scripts/run-behavior-tests.mjs --tier smoke",
    );
  });

  it("normalizes unordered memberships without hiding reordered authors", function () {
    const a = {
      tags: [{ tag: "z" }, { tag: "a" }],
      collections: ["B", "A"],
      creators: [{ lastName: "First" }, { lastName: "Second" }],
    };
    const b = {
      ...a,
      tags: [...a.tags].reverse(),
      collections: [...a.collections].reverse(),
    };
    assert.deepEqual(normalizeNative(a), normalizeNative(b));
    assert.notDeepEqual(
      normalizeNative(a),
      normalizeNative({ ...a, creators: [...a.creators].reverse() }),
    );
  });

  it("rejects both collateral field changes and changes outside the exact target", function () {
    const item = { libraryID: 1, key: "A" };
    const before = {
      "item:1:A": { title: "Old", date: "2024" },
      "item:2:A": { title: "Sentinel" },
    };
    const after = { ...before, "item:1:A": { title: "New", date: "2025" } };
    assert.throws(() => exactFieldChange(before, after, item, "title", "New"));
    assert.equal(diff(before, after).length, 1);
    const otherLibrary = {
      ...before,
      "item:1:A": normalizeNative({ title: "New", date: "2024" }),
      "item:2:A": { title: "Changed" },
    };
    assert.throws(
      () => exactFieldChange(before, otherLibrary, item, "title", "New"),
      /Unexpected native changes/,
    );
  });
});
