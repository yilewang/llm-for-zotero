import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";
import type {
  AntigravityTurnResult,
  AntigravityTurnScenario,
} from "../src/modules/contextPanel/antigravityTurnReplay";
import {
  createMemoryFakeAcpSessionStore,
  type FakeAcpScenario,
  type FakeAcpSessionStore,
} from "../test/helpers/acp/fakeAcpAgent";
import { createFakeAcpChild } from "../test/helpers/acp/fakeAcpChild";
import { zoteroHttpFetch } from "../test/helpers/acp/zoteroHttpFetch";

/**
 * Antigravity turns through the real panel, agent engine, turn host,
 * Antigravity transport, and ACP client, against the scripted fake agy that
 * the conformance check holds to the real agy's behavior.
 */
describe("workflow: Antigravity turns", function () {
  this.timeout(120000);

  const SCENARIOS: FakeAcpScenario[] = [
    {
      match: /run the build/,
      title: "Build",
      steps: [
        {
          type: "tool",
          name: "run_command",
          kind: "execute",
          title: "npm run build",
          result: "built",
        },
        { type: "text", text: "Build output: {{tool}}" },
      ],
    },
    {
      match: /search my library/,
      title: "Library search",
      steps: [
        {
          type: "mcpTool",
          server: "*",
          tool: "library_search",
          args: { query: "attention" },
        },
        { type: "text", text: "Searched the library." },
      ],
    },
    {
      match: /take your time/,
      title: "Slow",
      steps: [
        { type: "text", text: "Starting " },
        { type: "wait", ms: 20_000 },
        { type: "text", text: "done." },
      ],
    },
    {
      match: /clear midway/,
      title: "Cleared",
      steps: [
        { type: "text", text: "before-clear " },
        { type: "wait", ms: 200 },
        { type: "text", text: "after-clear" },
      ],
    },
    {
      match: /[\s\S]*/,
      title: "Hello",
      steps: [
        { type: "thought", text: "Greeting the user." },
        { type: "text", text: "Hello from Antigravity." },
      ],
    },
  ];

  let api: WorkflowTestApi;
  let fixture: Awaited<
    ReturnType<WorkflowTestApi["createPaperWithPdfFixture"]>
  >;
  let panelId = "";
  let store: FakeAcpSessionStore;

  // Each test gets its own paper, so no test inherits another's chat.
  beforeEach(async function () {
    api = (Zotero as any).LLMForZotero.api.workflowTest as WorkflowTestApi;
    store = createMemoryFakeAcpSessionStore();
    fixture = await api.createPaperWithPdfFixture({
      title: "Antigravity turn fixture",
      pages: ["A disposable paper for Antigravity turn tests."],
    });
    panelId = (await api.renderPanelForItem(fixture.parentItemId)).panelId;
  });

  afterEach(async function () {
    await api.resetAntigravityReplay();
    await api.cleanupFixture(fixture);
  });

  after(async function () {
    await api.reset();
  });

  function run(
    scenario: Omit<AntigravityTurnScenario, "createChild"> &
      Partial<Pick<AntigravityTurnScenario, "createChild">>,
  ): Promise<AntigravityTurnResult> {
    return api.exerciseAntigravityTurn({
      panelId,
      scenario: {
        createChild: (launch) =>
          createFakeAcpChild({
            scenarios: SCENARIOS,
            store,
            skipPermissions: launch.skipPermissions,
          }),
        ...scenario,
      },
    });
  }

  it("streams an answer, records the run, and saves the agy session on the chat", async function () {
    const result = await run({ question: "Say hello." });
    assert.equal(result.outcomeKind, "completed", JSON.stringify(result));
    assert.equal(result.outcomeText, "Hello from Antigravity.");
    assert.equal(result.deliveredText, "Hello from Antigravity.");
    assert.include(result.deliveredEvents, "reasoning");
    assert.equal(result.runStatus, "completed");
    assert.include(result.storedEvents, "message_delta");
    assert.include(result.messageText || "", "Hello from Antigravity.");
    // The chat's history lives in the Antigravity store.
    assert.deepEqual(
      result.storedMessages.map((message) => message.role),
      ["user", "assistant"],
      JSON.stringify(result.storedMessages),
    );
    assert.equal(result.storedMessages[1].text, "Hello from Antigravity.");
    assert.equal(result.storedMessages[1].agentRunId, result.runId);
    assert.isString(result.storedSessionId);
    assert.match(result.storedCwd || "", /[\\/]antigravity$/);
    assert.deepEqual(
      result.launches.map((launch) => launch.skipPermissions),
      [false],
    );
    assert.match(result.launches[0].cwd, /[\\/]antigravity$/);
  });

  it("continues the same agy session in the same process, and resumes it in a fresh one", async function () {
    const first = await run({ question: "Say hello." });
    const second = await run({
      question: "Say hello again.",
      conversationKey: first.conversationKey,
    });
    assert.equal(second.outcomeKind, "completed", JSON.stringify(second));
    assert.equal(second.storedSessionId, first.storedSessionId);
    assert.equal(second.processes, 1);

    const resumed = await run({
      question: "Say hello after a restart.",
      conversationKey: first.conversationKey,
      newProcess: true,
    });
    assert.equal(resumed.outcomeKind, "completed", JSON.stringify(resumed));
    assert.equal(resumed.processes, 2);
    assert.equal(resumed.storedSessionId, first.storedSessionId);
  });

  it("shows agy's permission request as a review card and passes the answer on", async function () {
    const allowed = await run({
      question: "Please run the build.",
      approve: true,
    });
    assert.equal(allowed.outcomeKind, "completed", JSON.stringify(allowed));
    assert.equal(allowed.confirmations, 1);
    assert.equal(allowed.deliveredText, "Build output: built");
    assert.includeMembers(allowed.deliveredEvents, [
      "confirmation_required",
      "confirmation_resolved",
      "tool_call",
      "tool_result",
    ]);
  });

  it("explains a turn that agy ended after a declined tool", async function () {
    const denied = await run({
      question: "Please run the build.",
      approve: false,
    });
    assert.equal(denied.outcomeKind, "completed", JSON.stringify(denied));
    assert.equal(denied.confirmations, 1);
    assert.match(denied.outcomeText, /tool request was declined/);
    assert.include(denied.deliveredEvents, "tool_error");
  });

  it("asks nothing in full access, which runs in its own agy process", async function () {
    const result = await run({
      question: "Please run the build.",
      permissionMode: "full-access",
    });
    assert.equal(result.outcomeKind, "completed", JSON.stringify(result));
    assert.equal(result.confirmations, 0);
    assert.deepEqual(
      result.launches.map((launch) => launch.skipPermissions),
      [true],
    );
  });

  it("lets agy read the library through the Zotero MCP server without a card, and reports the read once", async function () {
    const result = await run({
      question: "Please search my library.",
      mcp: true,
      createChild: (launch) =>
        createFakeAcpChild({
          scenarios: SCENARIOS,
          store,
          skipPermissions: launch.skipPermissions,
          fetch: zoteroHttpFetch,
        }),
    });
    assert.equal(result.outcomeKind, "completed", JSON.stringify(result));
    assert.equal(result.confirmations, 0);
    assert.equal(result.deliveredText, "Searched the library.");
    assert.include(
      result.deliveredEvents,
      "codex_tool_activity",
      JSON.stringify(result),
    );
    assert.notInclude(
      result.deliveredEvents,
      "tool_call",
      "agy's own row for a Zotero tool is left to the MCP activity row",
    );
  });

  it("ends a stopped turn as cancelled", async function () {
    const result = await run({
      question: "Please take your time.",
      abortWhenText: "Starting",
    });
    assert.equal(result.outcomeKind, "cancelled", JSON.stringify(result));
    assert.equal(result.runStatus, "cancelled", JSON.stringify(result));
  });

  it("stops delivering once the chat is cleared mid-turn", async function () {
    const result = await run({
      question: "Please clear midway.",
      clearWhenText: "before-clear",
    });
    assert.include(result.deliveredText, "before-clear");
    assert.notInclude(
      result.deliveredText,
      "after-clear",
      JSON.stringify(result),
    );
  });

  it("reports a missing sign-in as a failed turn with the fix", async function () {
    const result = await run({
      question: "Say hello.",
      createChild: () =>
        createFakeAcpChild({
          scenarios: SCENARIOS,
          authPendingRequests: 100_000,
        }),
    });
    assert.equal(result.outcomeKind, "failed", JSON.stringify(result));
    assert.match(result.outcomeText, /not signed in.*agy/s);
    assert.includeMembers(result.deliveredEvents, ["status", "fallback"]);
    assert.equal(result.runStatus, "failed", JSON.stringify(result));
  });
});
