import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";
import type {
  ExternalTurnResult,
  ExternalTurnScenario,
} from "../src/modules/contextPanel/externalTurnReplay";

/**
 * Claude Code turns through the real panel, agent engine, and turn host,
 * with only the bridge server scripted. These pin what the turn host does
 * for an external runtime (run records, write fence, review cards, the
 * per-turn Zotero MCP scope, cancel and failure reports), so it can move
 * into a host shared with Antigravity without changing Claude Code mode.
 */
describe("workflow: Claude Code turn host", function () {
  this.timeout(120000);

  let api: WorkflowTestApi;
  let fixture: Awaited<
    ReturnType<WorkflowTestApi["createPaperWithPdfFixture"]>
  >;
  let panelId = "";

  before(async function () {
    api = (Zotero as any).LLMForZotero.api.workflowTest as WorkflowTestApi;
    fixture = await api.createPaperWithPdfFixture({
      title: "Claude turn host fixture",
      pages: ["A disposable paper for Claude Code turn tests."],
    });
  });

  beforeEach(async function () {
    panelId = (await api.renderPanelForItem(fixture.parentItemId)).panelId;
  });

  after(async function () {
    await api.cleanupFixture(fixture);
    await api.reset();
  });

  function run(scenario: ExternalTurnScenario): Promise<ExternalTurnResult> {
    return api.exerciseClaudeBridgeTurn({ panelId, scenario });
  }

  const start = (runId: string) => ({ line: { type: "start", runId } });
  const delta = (text: string) => ({
    line: { type: "event", event: { type: "message_delta", text } },
  });
  const completed = (runId: string, text: string) => ({
    line: {
      type: "outcome",
      outcome: { kind: "completed", runId, text, usedFallback: false },
    },
  });

  it("streams a completed turn to the panel and records the run", async function () {
    const runId = `claude-run-${Date.now()}`;
    const result = await run({
      question: "Say hello.",
      steps: [
        start(runId),
        delta("Hello "),
        delta("there."),
        completed(runId, "Hello there."),
      ],
    });
    assert.equal(result.outcomeKind, "completed", JSON.stringify(result));
    assert.equal(result.runtimeCalls, 1, JSON.stringify(result));
    assert.equal(result.runTurnCalls, 1, JSON.stringify(result));
    assert.equal(result.outcomeText, "Hello there.");
    assert.includeMembers(result.deliveredEvents, ["message_delta"]);
    assert.include(result.storedEvents, "message_delta");
    assert.equal(result.runStatus, "completed");
    assert.equal(result.runFinalText, "Hello there.");
    assert.include(result.messageText || "", "Hello there.");
    assert.isNotNull(result.runTurnPayload);
    assert.isFalse(result.runTurnPayload!.hasMcpServers);
  });

  it("shows a bridge permission request as a review card and sends the answer back", async function () {
    const runId = `claude-run-${Date.now()}`;
    const requestId = `confirm-${Date.now()}`;
    const result = await run({
      question: "Run the tool.",
      approve: true,
      steps: [
        start(runId),
        {
          line: {
            type: "event",
            event: {
              type: "confirmation_required",
              requestId,
              action: {
                toolName: "/probe",
                title: "Approve /probe",
                mode: "approval",
                confirmLabel: "Run",
                cancelLabel: "Cancel",
                fields: [],
              },
            },
          },
        },
        { waitForConfirmation: true },
        delta("Ran it."),
        completed(runId, "Ran it."),
      ],
    });
    assert.equal(result.outcomeKind, "completed", JSON.stringify(result));
    assert.deepEqual(
      result.confirmationAnswers.map(({ requestId, approved }) => ({
        requestId,
        approved,
      })),
      [{ requestId, approved: true }],
      JSON.stringify(result.deliveredEvents),
    );
    const required = result.deliveredEvents.indexOf("confirmation_required");
    const resolved = result.deliveredEvents.indexOf("confirmation_resolved");
    assert.isAtLeast(required, 0);
    assert.isAbove(resolved, required);
    assert.includeMembers(result.storedEvents, [
      "confirmation_required",
      "confirmation_resolved",
    ]);
  });

  it("reports a bridge error as a failed turn with a status and a fallback", async function () {
    const runId = `claude-run-${Date.now()}`;
    const result = await run({
      question: "Fail please.",
      steps: [
        start(runId),
        { line: { type: "error", error: "Claude exploded" } },
      ],
    });
    assert.equal(result.outcomeKind, "failed", JSON.stringify(result));
    assert.include(result.outcomeText, "Claude exploded");
    const status = result.deliveredEvents.lastIndexOf("status");
    const fallback = result.deliveredEvents.lastIndexOf("fallback");
    assert.isAtLeast(status, 0);
    assert.isAbove(fallback, status);
    assert.equal(result.runStatus, "failed");
  });

  it("ends a stopped turn as cancelled", async function () {
    const runId = `claude-run-${Date.now()}`;
    const result = await run({
      question: "Take your time.",
      steps: [
        start(runId),
        delta("Partial "),
        { abort: true },
        completed(runId, "never"),
      ],
    });
    assert.equal(result.outcomeKind, "cancelled", JSON.stringify(result));
    assert.equal(result.runStatus, "cancelled");
    assert.notInclude(result.deliveredEvents, "final");
  });

  it("stops delivering and recording once the conversation is cleared mid-turn", async function () {
    const runId = `claude-run-${Date.now()}`;
    const result = await run({
      question: "Keep going.",
      steps: [
        start(runId),
        delta("before "),
        { bumpGeneration: true },
        delta("after-clear"),
        completed(runId, "before after-clear"),
      ],
    });
    const deltasDelivered = result.deliveredEvents.filter(
      (type) => type === "message_delta",
    ).length;
    assert.equal(deltasDelivered, 1, JSON.stringify(result));
    assert.equal(
      result.storedEvents.filter((type) => type === "message_delta").length,
      1,
    );
  });

  it("hands the bridge a per-turn Zotero MCP scope, runs tools through it, and closes it after the turn", async function () {
    const runId = `claude-run-${Date.now()}`;
    const tag = `claude-host-${Date.now()}`;
    const result = await run({
      question: "Tag this paper, then ask me something.",
      mcp: true,
      approve: true,
      steps: [
        start(runId),
        // An external runtime's own permission system gates its writes, so
        // the plugin applies this one without a card of its own.
        {
          mcpCall: {
            name: "library_update",
            arguments: {
              kind: "tags",
              itemIds: [fixture.parentItemId],
              tags: [tag],
            },
          },
        },
        // The same probe the result runs after the turn, here while it lives.
        { mcpCall: { name: "library_search", arguments: { query: "x" } } },
        // A question for the user always goes through the host's card.
        {
          mcpCall: {
            name: "request_user_input",
            arguments: {
              questions: [
                {
                  id: "q1",
                  question: "Which one?",
                  options: [
                    { id: "a", label: "A" },
                    { id: "b", label: "B" },
                  ],
                },
              ],
            },
          },
        },
        completed(runId, "Done."),
      ],
    });
    assert.equal(result.outcomeKind, "completed", JSON.stringify(result));
    const payload = result.runTurnPayload!;
    assert.isTrue(payload.hasMcpServers);
    assert.includeMembers(payload.mcpHeaderNames, [
      "Authorization",
      "X-LLM-For-Zotero-Scope",
    ]);
    assert.isNotEmpty(payload.scopeToken);
    assert.isNotEmpty(payload.allowedTools);
    assert.notInclude(payload.allowedTools.join(" "), "library_update");
    assert.lengthOf(result.mcpCallResults, 3);
    assert.isTrue(result.mcpCallResults[0].ok, result.mcpCallResults[0].text);
    assert.isTrue(result.mcpCallResults[1].ok, result.mcpCallResults[1].text);
    const item = Zotero.Items.get(fixture.parentItemId);
    await item.reload(undefined as never, true);
    assert.include(
      item.getTags().map((t: { tag: string }) => t.tag),
      tag,
      result.mcpCallResults[0].text,
    );
    const required = result.deliveredEvents.indexOf("confirmation_required");
    assert.isAtLeast(required, 0, JSON.stringify(result.deliveredEvents));
    assert.isAbove(
      result.deliveredEvents.indexOf("confirmation_resolved"),
      required,
    );
    assert.includeMembers(result.storedEvents, [
      "confirmation_required",
      "confirmation_resolved",
    ]);
    assert.isFalse(result.scopeLiveAfterTurn, "the scope closes with the turn");
  });
});
