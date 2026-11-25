import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";
import type {
  AntigravityTurnResult,
  AntigravityTurnScenario,
} from "../src/modules/contextPanel/antigravityTurnReplay";
import {
  createMemoryFakeAcpSessionStore,
  type FakeAcpAgentOptions,
  type FakeAcpScenario,
  type FakeAcpSessionStore,
  type FakeAgyMcpConfig,
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
      match: /open the paper's page image/,
      title: "Page image",
      steps: [
        {
          type: "tool",
          name: "read_file",
          kind: "read",
          title: "File page.png",
          // Real agy asks before any read outside its own folder.
          askPermission: true,
          locations: [
            `${Zotero.DataDirectory.dir}/chat-attachments/blobs/abc/page 5.png`,
          ],
          result: "an image",
        },
        { type: "text", text: "Saw the page." },
      ],
    },
    {
      match: /read a file outside zotero/,
      title: "Outside file",
      steps: [
        {
          type: "tool",
          name: "read_file",
          kind: "read",
          title: "File secrets.txt",
          askPermission: true,
          locations: ["/tmp/llm-for-zotero-antigravity-test/secrets.txt"],
          result: "text",
        },
        { type: "text", text: "Read it." },
      ],
    },
    {
      match: /reread your saved output/,
      title: "Saved output",
      steps: [
        {
          type: "tool",
          name: "read_file",
          kind: "read",
          title: "File output.txt",
          locations: [
            "{{dataDir}}/brain/abc/.system_generated/steps/7/output.txt",
          ],
          result: "earlier result",
        },
        {
          type: "tool",
          name: "read_file",
          kind: "read",
          title: "File past_chat_search.json",
          locations: ["{{dataDir}}/mcp/zotero/past_chat_search.json"],
          result: "a tool definition",
        },
        { type: "text", text: "Done rereading." },
      ],
    },
    {
      match: /outline of this paper/,
      title: "Paper outline",
      steps: [
        {
          type: "mcpTool",
          server: "*",
          tool: "paper_read",
          args: { mode: "outline" },
        },
        { type: "text", text: "Read the paper." },
      ],
    },
    {
      match: /search my past chats/,
      title: "Past chats",
      steps: [
        {
          type: "mcpTool",
          server: "*",
          tool: "past_chat_search",
          args: { query: "attention" },
        },
        { type: "text", text: "Searched the chats." },
      ],
    },
    {
      match: /run a command through zotero/,
      title: "Zotero command",
      steps: [
        {
          type: "mcpTool",
          server: "*",
          tool: "run_command",
          args: { command: "echo hello" },
          // agy asks before every MCP tool, in every mode.
          askPermission: true,
        },
        { type: "text", text: "Ran it." },
      ],
    },
    {
      match: /read the attached notes/,
      title: "Attached notes",
      steps: [
        {
          type: "tool",
          name: "read_file",
          kind: "read",
          title: "File notes.txt",
          readsAttachments: true,
          // Reading a file outside agy's folder asks, as in the real agy.
          askPermission: true,
          result: "codename HARBOR",
        },
        { type: "text", text: "The notes say {{tool}}." },
      ],
    },
    {
      match: /^\/compact$/,
      title: "Compact",
      steps: [{ type: "text", text: "Compacted." }],
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

  type Launch = Parameters<
    NonNullable<AntigravityTurnScenario["createChild"]>
  >[0];

  /**
   * A fake agy started the way the plugin starts the real one: it reads the
   * MCP config the plugin wrote for the launch, as agy does at start.
   */
  function fakeAgy(launch: Launch, options: FakeAcpAgentOptions = {}) {
    return createFakeAcpChild({
      scenarios: SCENARIOS,
      store,
      skipPermissions: launch.skipPermissions,
      dataDir: launch.profile.dataDir,
      mcpConfig: () =>
        IOUtils.readJSON(
          PathUtils.join(launch.profile.configDir, "config", "mcp_config.json"),
        ) as Promise<FakeAgyMcpConfig>,
      ...options,
    });
  }

  function run(
    scenario: Omit<AntigravityTurnScenario, "createChild"> &
      Partial<Pick<AntigravityTurnScenario, "createChild">>,
  ): Promise<AntigravityTurnResult> {
    return api.exerciseAntigravityTurn({
      panelId,
      scenario: {
        createChild: (launch) => fakeAgy(launch),
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
    // Each conversation has its own agy config folder; the data is shared.
    assert.match(
      result.launches[0].profile.configDir,
      new RegExp(`[\\\\/]conversation-${result.conversationKey}$`),
    );
    assert.match(result.launches[0].profile.dataDir, /[\\/]data$/);
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

  it("starts a new agy session when agy's data no longer holds the chat's session", async function () {
    const first = await run({ question: "Say hello." });
    assert.equal(first.outcomeKind, "completed", JSON.stringify(first));
    // A chat from before the plugin ran agy on its own data folder: agy has
    // no record of the session the chat stored.
    store = createMemoryFakeAcpSessionStore();
    const second = await run({
      question: "Say hello again.",
      conversationKey: first.conversationKey,
      newProcess: true,
    });
    assert.equal(second.outcomeKind, "completed", JSON.stringify(second));
    assert.equal(second.deliveredText, "Hello from Antigravity.");
    // The chat now points at a session agy holds, with this turn only.
    const session = store.get(String(second.storedSessionId));
    const asked = (session?.history || []).filter(
      (update) => update.sessionUpdate === "user_message_chunk",
    );
    assert.lengthOf(asked, 1, JSON.stringify(session?.history));
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
      createChild: (launch) => fakeAgy(launch, { fetch: zoteroHttpFetch }),
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

  it("gives agy the whole Zotero catalog: the core tools directly, the rest on demand", async function () {
    const result = await run({
      question: "Give me an outline of this paper.",
      mcp: true,
      createChild: (launch) => fakeAgy(launch, { fetch: zoteroHttpFetch }),
    });
    assert.equal(result.outcomeKind, "completed", JSON.stringify(result));
    assert.equal(result.confirmations, 0);
    const session = store.get(String(result.storedSessionId));
    // The fake offers directly only what agy would: the tools marked eager
    // that fit agy's budget. The whole core set has to fit.
    assert.sameMembers(session?.directMcpTools || [], [
      "paper_read",
      "library_retrieve",
      "library_search",
      "library_read",
      "context_read",
      "read_attachment",
      "literature_search",
      "literature_read",
      "note_write",
      "undo",
      "library_cite",
    ]);
    // Every other tool stays reachable, as in Codex and Claude Code.
    assert.includeMembers(session?.callableMcpTools || [], [
      "annotate_pdf",
      "library_update",
      "past_chat_search",
      "file_io",
    ]);
    assert.equal(result.deliveredText, "Read the paper.");
    assert.include(result.deliveredEvents, "codex_tool_activity");
  });

  it("runs a Zotero tool agy calls on demand like one it calls directly", async function () {
    const result = await run({
      question: "Please search my past chats.",
      mcp: true,
      createChild: (launch) => fakeAgy(launch, { fetch: zoteroHttpFetch }),
    });
    assert.equal(result.outcomeKind, "completed", JSON.stringify(result));
    assert.equal(result.deliveredText, "Searched the chats.");
    const calls = (
      store.get(String(result.storedSessionId))?.history || []
    ).flatMap((update) =>
      update.sessionUpdate === "tool_call" ? [update.name] : [],
    );
    assert.deepEqual(calls, ["call_mcp_tool"], "agy's on-demand tool call");
    assert.equal(result.confirmations, 0, "a safe read runs without a card");
    assert.include(result.deliveredEvents, "codex_tool_activity");
    assert.notInclude(
      result.deliveredEvents,
      "tool_call",
      "agy's own row for a Zotero tool is left to the MCP activity row",
    );
  });

  it("lets agy read files in the Zotero data folder without a card, and still asks elsewhere", async function () {
    const inside = await run({
      question: "Please open the paper's page image.",
    });
    assert.equal(inside.outcomeKind, "completed", JSON.stringify(inside));
    assert.equal(inside.confirmations, 0, "a Zotero data file reads freely");
    assert.include(inside.deliveredText, "Saw the page.");

    const outside = await run({
      question: "Please read a file outside zotero.",
      approve: false,
    });
    assert.equal(outside.confirmations, 1, "any other file still asks");
  });

  it("shows no activity row for agy rereading its own saved output", async function () {
    const result = await run({ question: "Please reread your saved output." });
    assert.equal(result.outcomeKind, "completed", JSON.stringify(result));
    assert.equal(result.deliveredText, "Done rereading.");
    assert.notInclude(result.deliveredEvents, "tool_call");
  });

  it("offers paper_read without full mode when no reader model can run it", async function () {
    const result = await run({
      question: "Give me an outline of this paper.",
      mcp: true,
      createChild: (launch) => fakeAgy(launch, { fetch: zoteroHttpFetch }),
    });
    assert.equal(result.outcomeKind, "completed", JSON.stringify(result));
    const schema = store.get(String(result.storedSessionId))?.mcpToolSchemas
      ?.paper_read as { properties?: { mode?: { enum?: string[] } } };
    const modes = schema?.properties?.mode?.enum || [];
    assert.include(modes, "targeted");
    assert.notInclude(modes, "full");
  });

  it("runs a Zotero write without a card in Auto mode, and asks in Default", async function () {
    const writeNote: FakeAcpScenario = {
      match: /write the note/,
      title: "Note",
      steps: [
        {
          type: "mcpTool",
          server: "*",
          tool: "note_write",
          args: {
            mode: "create",
            target: "item",
            targetItemId: fixture.parentItemId,
            content: "Antigravity write-policy test note.",
          },
          // agy asks before every MCP tool, in every mode.
          askPermission: true,
        },
        { type: "text", text: "Wrote it." },
      ],
    };
    const child = (launch: Launch) =>
      fakeAgy(launch, {
        scenarios: [writeNote, ...SCENARIOS],
        fetch: zoteroHttpFetch,
      });
    const auto = await run({
      question: "Please write the note.",
      mcp: true,
      permissionMode: "auto",
      createChild: child,
    });
    assert.equal(auto.outcomeKind, "completed", JSON.stringify(auto));
    assert.equal(auto.confirmations, 0, "Auto runs a Zotero write unasked");
    assert.equal(auto.deliveredText, "Wrote it.");

    const ask = await run({
      question: "Please write the note.",
      mcp: true,
      permissionMode: "default",
      approve: false,
      newProcess: true,
      createChild: child,
    });
    assert.equal(ask.confirmations, 1, "Default asks before a Zotero write");
  });

  it("asks before a Zotero tool that reaches the computer, even in Auto mode", async function () {
    const result = await run({
      question: "Please run a command through zotero.",
      mcp: true,
      permissionMode: "auto",
      approve: false,
      createChild: (launch) => fakeAgy(launch, { fetch: zoteroHttpFetch }),
    });
    assert.equal(result.confirmations, 1, JSON.stringify(result));
    assert.notInclude(result.deliveredEvents, "codex_tool_activity");
  });

  it("applies the turn's model and thinking level to agy's session", async function () {
    const result = await run({
      question: "Say hello.",
      model: "gemini-4-hydrogen",
      thoughtLevel: "xhigh",
    });
    assert.equal(result.outcomeKind, "completed", JSON.stringify(result));
    const session = store.get(String(result.storedSessionId));
    assert.equal(session?.model, "gemini-4-hydrogen");
    assert.equal(session?.thoughtLevel, "xhigh");
  });

  it("gives a new agy session the Zotero instructions as its system prompt, not as prompt text", async function () {
    const result = await run({ question: "Say hello." });
    assert.equal(result.outcomeKind, "completed", JSON.stringify(result));
    const session = store.get(String(result.storedSessionId));
    assert.include(
      session?.systemPrompt || "",
      "Original agent-mode Zotero behavior",
    );
    const sent = (session?.history || []).flatMap((update) =>
      update.sessionUpdate === "user_message_chunk" &&
      update.content.type === "text"
        ? [update.content.text]
        : [],
    );
    assert.lengthOf(sent, 1, JSON.stringify(sent));
    assert.notInclude(sent[0], "Original agent-mode Zotero behavior");
    assert.include(sent[0], "Say hello.");
  });

  it("sends a screenshot as an image and a file as a link that agy reads without a card", async function () {
    const image =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
    const notesPath = "/tmp/llm-for-zotero-antigravity-test/notes v1.txt";
    const result = await run({
      question: "Please read the attached notes.",
      images: [image],
      attachments: [
        {
          id: "notes-1",
          name: "notes v1.txt",
          mimeType: "text/plain",
          sizeBytes: 12,
          category: "text",
          storedPath: notesPath,
        },
      ],
    });
    assert.equal(result.outcomeKind, "completed", JSON.stringify(result));
    assert.equal(result.confirmations, 0, "an attached file reads freely");
    assert.include(result.deliveredText, "The notes say codename HARBOR.");
    const blocks = (
      store.get(String(result.storedSessionId))?.history || []
    ).flatMap((update) =>
      update.sessionUpdate === "user_message_chunk" ? [update.content] : [],
    );
    const imageBlock = blocks.find((block) => block.type === "image");
    assert.deepInclude(imageBlock, { type: "image", mimeType: "image/png" });
    const link = blocks.find((block) => block.type === "resource_link");
    assert.deepInclude(link, {
      type: "resource_link",
      uri: "file:///tmp/llm-for-zotero-antigravity-test/notes%20v1.txt",
      name: "notes v1.txt",
    });
  });

  it("still asks before agy reads a file the user did not attach", async function () {
    const result = await run({
      question: "Please read the attached notes.",
      approve: false,
    });
    assert.equal(result.confirmations, 1, JSON.stringify(result));
    assert.notInclude(result.deliveredText, "codename HARBOR");
  });

  it("sends a slash message to agy alone and offers agy's commands", async function () {
    const result = await run({ question: "/compact" });
    assert.equal(result.outcomeKind, "completed", JSON.stringify(result));
    assert.equal(result.outcomeText, "Compacted.");
    const sent = (
      store.get(String(result.storedSessionId))?.history || []
    ).flatMap((update) =>
      update.sessionUpdate === "user_message_chunk" ? [update.content] : [],
    );
    assert.deepEqual(sent, [{ type: "text", text: "/compact" }]);
    assert.includeMembers(result.slashCommands, ["goal", "compact", "plan"]);
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
