/**
 * The one reading of which run events move Task progress, shared by the live
 * agent engine and the rebuild of a stored conversation.
 */
import { assert } from "chai";
import { describe, it } from "mocha";
import type { AgentEvent } from "../src/agent/types";
import {
  TASK_PROGRESS_LIVE_EVENT_TYPES,
  TASK_PROGRESS_REPLAY_EVENT_TYPES,
  taskProgressEffect,
} from "../src/modules/contextPanel/taskProgress/runFold";
import { TASK_PROGRESS_HISTORY_EVENT_TYPES } from "../src/modules/contextPanel/taskProgress/history";
import { ledgerDelta, outcomeCheckpoint } from "./helpers/taskProgressFixtures";

const event = (payload: Record<string, unknown>) =>
  payload as unknown as AgentEvent;

/** One event of each kind that moves Task progress. */
const SAMPLES: Record<string, AgentEvent> = {
  paper_ledger_update: event({
    type: "paper_ledger_update",
    callId: "c1",
    delta: ledgerDelta("c1", [[1, "read"]], "run-1"),
  }),
  material_finalized: event({
    type: "material_finalized",
    materialRef: { documentId: "d", documentVersion: 1, contentHash: "h" },
    citedSources: [{ citationId: "c1", libraryID: 1, itemKey: "PAPER001" }],
  }),
  codex_progress: event({
    type: "codex_progress",
    itemId: "codex-plan-checklist",
    steps: [{ content: "Inspect", status: "completed" }],
  }),
  plan_updated: event({ type: "plan_updated" }),
  plan_ready: event({ type: "plan_ready" }),
  plan_execution_updated: event({ type: "plan_execution_updated" }),
  execution_checkpoint: event({
    type: "execution_checkpoint",
    checkpoint: outcomeCheckpoint([]),
  }),
  execution_checkpoint_delta: event({
    type: "execution_checkpoint_delta",
    delta: {},
  }),
  message_delta: event({ type: "message_delta", text: "Two" }),
  confirmation_required: event({
    type: "confirmation_required",
    requestId: "r",
    action: {},
  }),
  confirmation_resolved: event({
    type: "confirmation_resolved",
    requestId: "r",
    approved: true,
  }),
  final: event({ type: "final", text: "Done." }),
};

describe("task progress run fold", function () {
  it("names an effect for every kind it lists, and only those", function () {
    const listed = [
      ...TASK_PROGRESS_REPLAY_EVENT_TYPES,
      ...TASK_PROGRESS_LIVE_EVENT_TYPES,
    ];
    assert.sameMembers(Object.keys(SAMPLES), listed);
    for (const type of listed) {
      assert.isNotNull(taskProgressEffect(SAMPLES[type]), type);
    }
    for (const other of [
      event({ type: "status", text: "Working" }),
      event({ type: "reasoning", round: 1, summary: "s" }),
      event({ type: "tool_result", ok: true }),
      event({ type: "plan_research_progress" }),
    ]) {
      assert.isNull(taskProgressEffect(other));
    }
  });

  it("reads each event as the effect its consumers apply", function () {
    const effects = Object.fromEntries(
      Object.entries(SAMPLES).map(([type, sample]) => [
        type,
        taskProgressEffect(sample)?.kind,
      ]),
    );
    assert.deepEqual(effects, {
      paper_ledger_update: "paper_delta",
      material_finalized: "document_citations",
      codex_progress: "codex_checklist",
      plan_updated: "plan_seen",
      plan_ready: "plan_seen",
      plan_execution_updated: "plan_seen",
      execution_checkpoint: "outcomes",
      execution_checkpoint_delta: "outcomes",
      message_delta: "answering",
      confirmation_required: "waiting",
      confirmation_resolved: "waiting",
      final: "final",
    });
    assert.deepEqual(taskProgressEffect(SAMPLES.confirmation_required), {
      kind: "waiting",
      waiting: true,
    });
    assert.deepEqual(taskProgressEffect(SAMPLES.confirmation_resolved), {
      kind: "waiting",
      waiting: false,
    });
    assert.deepEqual(taskProgressEffect(SAMPLES.codex_progress), {
      kind: "codex_checklist",
      steps: [{ label: "Inspect", status: "completed" }],
    });
  });

  it("reads no plan from a Codex item that carries none", function () {
    assert.isNull(
      taskProgressEffect(
        event({ type: "codex_progress", itemId: "codex-reasoning", text: "x" }),
      ),
    );
    assert.isNull(
      taskProgressEffect(
        event({
          type: "codex_progress",
          itemId: "codex-plan-checklist",
          text: "",
        }),
      ),
    );
  });

  it("is where the rebuild's stored event kinds come from", function () {
    assert.strictEqual(
      TASK_PROGRESS_HISTORY_EVENT_TYPES,
      TASK_PROGRESS_REPLAY_EVENT_TYPES,
    );
  });
});
