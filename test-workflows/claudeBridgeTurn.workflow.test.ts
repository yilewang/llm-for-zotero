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

  it("sends the Zotero context and each quoted passage with the user's words", async function () {
    const runId = `claude-run-${Date.now()}`;
    const quote = "Attention lets every token weigh every other token.";
    const result = await run({
      question: "I don't get this sentence.",
      selectedTextContexts: [{ text: quote, source: "model" }],
      steps: [start(runId), completed(runId, "It means...")],
    });
    assert.equal(result.outcomeKind, "completed", JSON.stringify(result));
    const payload = result.runTurnPayload!;
    assert.include(payload.turnContext, "Zotero context for this turn:");
    assert.include(
      payload.turnContext,
      `Selected text 1 [source=model response]:\n"""\n${quote}\n"""`,
    );
    assert.equal(payload.userText, "I don't get this sentence.");
  });

  it("asks for the attached questions when the composer was empty, without repeating them", async function () {
    const runId = `claude-run-${Date.now()}`;
    const result = await run({
      question: "Why sinusoids?",
      selectedTextContexts: [
        {
          text: "Positional encodings add order information.",
          source: "model",
          userQuery: "Why sinusoids?",
        },
      ],
      steps: [start(runId), completed(runId, "Because...")],
    });
    assert.equal(result.outcomeKind, "completed", JSON.stringify(result));
    const payload = result.runTurnPayload!;
    assert.include(
      payload.turnContext,
      'Positional encodings add order information.\n"""\nQuestion about this text:\nWhy sinusoids?',
    );
    assert.equal(
      payload.userText,
      "Answer the question attached to each selected text above.",
    );
  });

  it("a retry starts Claude without the answer it replaces", async function () {
    const firstRun = `claude-run-${Date.now()}`;
    const retryRun = `${firstRun}-retry`;
    const result = await run({
      question: "Pick a random whole number between 1 and 1000.",
      steps: [start(firstRun), completed(firstRun, "417")],
      retry: { steps: [start(retryRun), completed(retryRun, "88")] },
    });
    assert.equal(result.outcomeKind, "completed", JSON.stringify(result));
    assert.isNotNull(result.retryTurnPayload, JSON.stringify(result));
    // The Claude session holds the replaced question and answer, so the
    // retry has the bridge drop it before the new answer starts.
    assert.isAtLeast(
      result.invalidateSessionCalls.afterRetry,
      1,
      JSON.stringify(result),
    );
    assert.equal(result.retryTurnPayload!.providerSessionId, "");
    assert.equal(
      result.retryTurnPayload!.userText,
      "Pick a random whole number between 1 and 1000.",
    );
  });

  it("sends the paper's PDF file again when a turn that sent it is retried", async function () {
    const pdfPath = String(
      Zotero.Items.get(fixture.pdfAttachmentId).getFilePath() || "",
    );
    assert.isNotEmpty(pdfPath, "the fixture has a PDF file");
    const firstRun = `claude-run-${Date.now()}`;
    const retryRun = `${firstRun}-retry`;
    const result = await run({
      question: "What does the PDF say?",
      localPdf: true,
      steps: [start(firstRun), completed(firstRun, "It says A.")],
      retry: { steps: [start(retryRun), completed(retryRun, "It says B.")] },
    });
    assert.equal(result.outcomeKind, "completed", JSON.stringify(result));
    assert.deepEqual(
      result.localDocumentPaths,
      [[pdfPath], [pdfPath]],
      "the first turn and its retry both send the PDF file",
    );
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
  it("does not let a retry after a failed session reset resume the replaced session", async function () {
    // Its own paper, and last in the file: after a third retried chat in one
    // run, this fixture's next turn is not saved (seen 2026-11-27, also with
    // a plain retry here; the panel's own retry saves, live R4).
    const paper = await api.createPaperWithPdfFixture({
      title: "Claude failed reset fixture",
      pages: ["A disposable paper for a failed session reset."],
    });
    const ownPanelId = (await api.renderPanelForItem(paper.parentItemId))
      .panelId;
    const firstRun = `claude-run-${Date.now()}`;
    const retryRun = `${firstRun}-retry`;
    const result = await api
      .exerciseClaudeBridgeTurn({
        panelId: ownPanelId,
        scenario: {
          question: "Pick a random whole number between 1 and 1000.",
          steps: [start(firstRun), completed(firstRun, "417")],
          retry: [
            // The bridge cannot drop the session: the retry must not go out.
            {
              steps: [start(`${retryRun}-1`), completed(`${retryRun}-1`, "1")],
              invalidateFails: true,
            },
            // The user retries again once the bridge is back.
            {
              steps: [start(`${retryRun}-2`), completed(`${retryRun}-2`, "88")],
            },
          ],
        },
      })
      .finally(() => api.cleanupFixture(paper));
    const [failed, again] = result.retries;
    assert.isNull(failed.payload, JSON.stringify(result.retries));
    assert.isAtLeast(failed.invalidateCalls, 1);
    assert.isNotNull(again.payload, JSON.stringify(result.retries));
    // The bridge still maps the chat to the session holding "417": the
    // second retry must drop it there, or start a fresh session.
    assert.isTrue(
      again.invalidateCalls >= 1 || again.payload!.startedFresh,
      JSON.stringify(result.retries),
    );
    assert.equal(again.payload!.providerSessionId, "");
  });
  it("starts a fresh Claude session for the next message while a failed reset is pending", async function () {
    // Its own paper, as the failed-reset test above.
    const paper = await api.createPaperWithPdfFixture({
      title: "Claude pending reset fixture",
      pages: ["A disposable paper for a pending session reset."],
    });
    const ownPanelId = (await api.renderPanelForItem(paper.parentItemId))
      .panelId;
    const firstRun = `claude-run-${Date.now()}`;
    const result = await api
      .exerciseClaudeBridgeTurn({
        panelId: ownPanelId,
        scenario: {
          question: "Pick a random whole number between 1 and 1000.",
          steps: [start(firstRun), completed(firstRun, "417")],
          // An edit or retry whose reset the bridge refused.
          retry: {
            steps: [start(`${firstRun}-r`), completed(`${firstRun}-r`, "1")],
            invalidateFails: true,
          },
          // The user moves on with new messages instead of retrying, while
          // the reset still waits to be retried.
          followUps: [
            {
              question: "What number did you pick?",
              steps: [
                start(`${firstRun}-f1`),
                completed(`${firstRun}-f1`, "?"),
              ],
            },
            {
              question: "And another one?",
              steps: [
                start(`${firstRun}-f2`),
                completed(`${firstRun}-f2`, "5"),
              ],
            },
          ],
        },
      })
      .finally(() => api.cleanupFixture(paper));
    assert.isNull(result.retries[0].payload, JSON.stringify(result.retries));
    const [first, second] = result.followUpPayloads;
    const log = JSON.stringify(result.followUpPayloads);
    // The bridge still holds the session with the replaced answer: the
    // plugin names it, and the bridge, about to resume it, starts fresh.
    assert.lengthOf(first?.pendingResetSessionIds || [], 1, log);
    assert.isTrue(first?.startedFresh, log);
    // The next message continues the session that replaced it (the bridge
    // resumes its own mapping of the chat, now that session).
    assert.isFalse(second?.startedFresh, log);
  });
});
