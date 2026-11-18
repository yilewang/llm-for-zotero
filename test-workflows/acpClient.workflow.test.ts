import { assert } from "chai";
import {
  AcpClient,
  AcpNotSignedInError,
  AcpUnsupportedAgentError,
  compareAgentVersions,
} from "../src/antigravity/acpClient";
import {
  AgyNotFoundError,
  AgyWorkingDirectoryError,
  buildAgyArguments,
  buildAgyEnvironment,
  buildAgyPoolKey,
  resolveAgyBinary,
  startAgyClient,
} from "../src/antigravity/agyProcess";
import type {
  AcpRequestPermissionParams,
  AcpSessionNotification,
  AcpSessionUpdate,
} from "../src/shared/acpProtocol";
import {
  createMemoryFakeAcpSessionStore,
  type FakeAcpScenario,
} from "../test/helpers/acp/fakeAcpAgent";
import {
  createFakeAcpChild,
  type FakeAcpChild,
} from "../test/helpers/acp/fakeAcpChild";
import {
  createFakeStdioProcess,
  settle,
} from "../test/helpers/fakeStdioProcess";

/**
 * The plugin's ACP client against the scripted fake agy (the same fake the
 * conformance check holds to the real agy's behavior), plus the agy launch
 * rules. Nothing here starts a real agy.
 */
describe("workflow: ACP client", function () {
  this.timeout(30000);

  const SCENARIOS: FakeAcpScenario[] = [
    {
      match: /run the build/,
      title: "Build",
      steps: [
        { type: "thought", text: "Running it." },
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
      match: /slow/,
      title: "Slow",
      steps: [
        { type: "text", text: "Starting " },
        { type: "wait", ms: 20_000 },
        { type: "text", text: "done." },
      ],
    },
  ];

  const clients: AcpClient[] = [];
  afterEach(async function () {
    await Promise.all(
      clients.splice(0).map((client) => client.destroyAndWait()),
    );
  });

  async function connect(
    options: Parameters<typeof createFakeAcpChild>[0] = {},
    readiness = { timeoutMs: 2_000, delayMs: 10 },
  ): Promise<{ client: AcpClient; child: FakeAcpChild }> {
    const child = createFakeAcpChild({ scenarios: SCENARIOS, ...options });
    const client = await AcpClient.connect({ child, readiness });
    clients.push(client);
    return { client, child };
  }

  function record(client: AcpClient, sessionId: string) {
    const updates: AcpSessionUpdate[] = [];
    client.onSessionUpdate(sessionId, (n: AcpSessionNotification) =>
      updates.push(n.update),
    );
    return updates;
  }

  function text(updates: AcpSessionUpdate[]): string {
    return updates
      .map((u) =>
        u.sessionUpdate === "agent_message_chunk" && u.content.type === "text"
          ? u.content.text
          : "",
      )
      .join("");
  }

  it("waits through agy's start-up 'Authentication required' answers", async function () {
    const { client } = await connect({ authPendingRequests: 3 });
    const info = client.getInitializeResult();
    assert.equal(info.protocolVersion, 1);
    assert.equal(info.agentInfo?.version, "1.5.10");
    const session = await client.newSession({ cwd: "/w", mcpServers: [] });
    assert.isString(session.sessionId);
  });

  it("reports a missing sign-in once the readiness wait runs out, and stops the process", async function () {
    const child = createFakeAcpChild({ authPendingRequests: 10_000 });
    let failure: unknown;
    await AcpClient.connect({
      child,
      readiness: { timeoutMs: 100, delayMs: 10 },
    }).catch((error) => (failure = error));
    assert.instanceOf(failure, AcpNotSignedInError);
    assert.match(String((failure as Error).message), /agy.*sign in/);
    assert.isTrue(child.killed());
  });

  it("refuses an agent older than the supported version or on another protocol", async function () {
    assert.equal(compareAgentVersions("1.5.10", "1.5.9"), 1);
    assert.equal(compareAgentVersions("1.5", "1.5.0"), 0);
    assert.isNull(compareAgentVersions("dev", "1.5.10"));
    for (const [answer, pattern] of [
      [
        { protocolVersion: 1, agentInfo: { version: "1.4.2" } },
        /1\.4\.2 is older than the supported 1\.5\.10/,
      ],
      [{ protocolVersion: 2 }, /protocol version 2/],
    ] as const) {
      const child = createFakeStdioProcess();
      child.onSent((message) => {
        if (message.method === "initialize")
          child.emit({
            jsonrpc: "2.0",
            id: message.id as number,
            result: answer,
          });
      });
      let failure: unknown;
      await AcpClient.connect({ child }).catch((error) => (failure = error));
      assert.instanceOf(failure, AcpUnsupportedAgentError);
      assert.match((failure as Error).message, pattern);
      assert.isTrue(child.killed());
    }
  });

  it("streams a turn to the session's listeners and returns the stop reason and usage", async function () {
    const { client } = await connect({ skipPermissions: true });
    const a = await client.newSession({ cwd: "/w", mcpServers: [] });
    const b = await client.newSession({ cwd: "/w", mcpServers: [] });
    const updatesA = record(client, a.sessionId);
    const updatesB = record(client, b.sessionId);
    const result = await client.prompt(a.sessionId, [
      { type: "text", text: "run the build" },
    ]);
    assert.equal(result.stopReason, "end_turn");
    assert.isAbove(Number(result.usage?.totalTokens), 0);
    assert.equal(text(updatesA), "Build output: built");
    const kinds = updatesA.map((u) => u.sessionUpdate);
    assert.includeMembers(kinds, [
      "agent_thought_chunk",
      "tool_call",
      "tool_call_update",
      "agent_message_chunk",
    ]);
    assert.notInclude(kinds, "user_message_chunk");
    assert.deepEqual(updatesB, [], "another session hears nothing");
  });

  it("asks the session's permission handler and passes its answer on", async function () {
    const { client } = await connect();
    const session = await client.newSession({ cwd: "/w", mcpServers: [] });
    const asked: AcpRequestPermissionParams[] = [];
    client.setPermissionHandler(session.sessionId, async (params) => {
      asked.push(params);
      return { outcome: { outcome: "selected", optionId: "allow" } };
    });
    const updates = record(client, session.sessionId);
    const allowed = await client.prompt(session.sessionId, [
      { type: "text", text: "run the build" },
    ]);
    assert.equal(allowed.stopReason, "end_turn");
    assert.lengthOf(asked, 1);
    assert.equal(asked[0].toolCall.kind, "execute");
    assert.sameMembers(
      asked[0].options.map((o) => o.kind),
      ["allow_once", "reject_once"],
    );
    assert.equal(text(updates), "Build output: built");

    // A denial ends the turn with a failed tool and no assistant text.
    client.setPermissionHandler(session.sessionId, async () => ({
      outcome: { outcome: "selected", optionId: "deny" },
    }));
    updates.length = 0;
    const denied = await client.prompt(session.sessionId, [
      { type: "text", text: "run the build" },
    ]);
    assert.equal(denied.stopReason, "end_turn");
    assert.equal(text(updates), "");
    assert.isTrue(
      updates.some(
        (u) => u.sessionUpdate === "tool_call_update" && u.status === "failed",
      ),
    );
  });

  it("answers an open permission request 'cancelled' when the turn is cancelled", async function () {
    const { client } = await connect();
    const session = await client.newSession({ cwd: "/w", mcpServers: [] });
    let handlerSignal: AbortSignal | null = null;
    client.setPermissionHandler(session.sessionId, (_params, signal) => {
      handlerSignal = signal;
      // A review card the user never answers.
      return new Promise(() => undefined);
    });
    const controller = new AbortController();
    const turn = client.prompt(
      session.sessionId,
      [{ type: "text", text: "run the build" }],
      { signal: controller.signal },
    );
    for (let i = 0; i < 100 && !handlerSignal; i++) await settle(10);
    assert.isNotNull(handlerSignal, "the handler was asked");
    controller.abort();
    const result = await turn;
    assert.equal(result.stopReason, "cancelled");
    assert.isTrue((handlerSignal as unknown as AbortSignal).aborted);
    assert.isFalse(client.isPromptRunning(session.sessionId));
  });

  it("cancels a streaming turn and runs one prompt at a time per session", async function () {
    const { client } = await connect({ skipPermissions: true });
    const session = await client.newSession({ cwd: "/w", mcpServers: [] });
    const updates = record(client, session.sessionId);
    const controller = new AbortController();
    const turn = client.prompt(
      session.sessionId,
      [{ type: "text", text: "slow" }],
      { signal: controller.signal },
    );
    for (let i = 0; i < 100 && !text(updates); i++) await settle(10);
    let concurrent: unknown;
    await client
      .prompt(session.sessionId, [{ type: "text", text: "again" }])
      .catch((error) => (concurrent = error));
    assert.match(String(concurrent), /already running/);
    controller.abort();
    assert.equal((await turn).stopReason, "cancelled");
    assert.equal(text(updates), "Starting ");
  });

  it("lists only the sessions in the asked folder, though agy lists every folder", async function () {
    const store = createMemoryFakeAcpSessionStore();
    const { client } = await connect({ store, skipPermissions: true });
    const inA = await client.newSession({ cwd: "/work/a", mcpServers: [] });
    await client.newSession({ cwd: "/work/b", mcpServers: [] });
    await client.prompt(inA.sessionId, [{ type: "text", text: "hello" }]);
    const listed = await client.listSessions("/work/a/");
    assert.deepEqual(
      listed.map((s) => s.sessionId),
      [inA.sessionId],
    );
  });

  it("replays a stored session to its listener before load returns, in a fresh process", async function () {
    const store = createMemoryFakeAcpSessionStore();
    const first = await connect({ store, skipPermissions: true });
    const session = await first.client.newSession({
      cwd: "/w",
      mcpServers: [],
    });
    await first.client.prompt(session.sessionId, [
      { type: "text", text: "run the build" },
    ]);
    await first.client.destroyAndWait();

    const second = await connect({ store, skipPermissions: true });
    const replayed = record(second.client, session.sessionId);
    const state = await second.client.loadSession({
      sessionId: session.sessionId,
      cwd: "/w",
      mcpServers: [],
    });
    assert.isObject(state);
    const kinds = replayed.map((u) => u.sessionUpdate);
    assert.include(kinds, "user_message_chunk");
    assert.equal(text(replayed), "Build output: built");
  });

  it("refuses requests for file-system and terminal methods it never declared", async function () {
    const child = createFakeStdioProcess();
    child.onSent((message) => {
      if (message.method === "initialize")
        child.emit({
          jsonrpc: "2.0",
          id: message.id as number,
          result: { protocolVersion: 1, agentInfo: { version: "1.5.10" } },
        });
      if (message.method === "session/list")
        child.emit({
          jsonrpc: "2.0",
          id: message.id as number,
          result: { sessions: [] },
        });
    });
    const client = await AcpClient.connect({ child });
    clients.push(client);
    child.emit({
      jsonrpc: "2.0",
      id: 99,
      method: "fs/read_text_file",
      params: { sessionId: "s", path: "/etc/hosts" },
    });
    await settle(20);
    assert.deepInclude(child.sent(), {
      jsonrpc: "2.0",
      id: 99,
      error: {
        code: -32601,
        message: "Unsupported client method: fs/read_text_file",
      },
    });
  });

  describe("agy launch rules", function () {
    it("gives each folder and permission level its own process", function () {
      const base = { cwd: "/w/a", skipPermissions: false };
      const keys = new Set([
        buildAgyPoolKey(base),
        buildAgyPoolKey({ ...base, cwd: "/w/b" }),
        buildAgyPoolKey({ ...base, skipPermissions: true }),
        buildAgyPoolKey({ ...base, agyPath: "/opt/agy" }),
      ]);
      assert.equal(keys.size, 4);
      assert.equal(buildAgyPoolKey(base), buildAgyPoolKey({ ...base }));
      assert.deepEqual(buildAgyArguments(false), ["acp"]);
      assert.deepEqual(buildAgyArguments(true), [
        "acp",
        "--dangerously-skip-permissions",
      ]);
    });

    it("puts agy's folder first on PATH and keeps loopback off any proxy", function () {
      const env = buildAgyEnvironment("/Users/me/.local/bin/agy");
      assert.match(env.PATH, /^\/Users\/me\/\.local\/bin[:;]/);
      for (const host of ["localhost", "127.0.0.1", "::1"]) {
        assert.include(env.NO_PROXY.split(","), host);
      }
      assert.equal(env.no_proxy, env.NO_PROXY);
    });

    it("refuses a missing working folder or a configured path that does not exist", async function () {
      let failure: unknown;
      await startAgyClient({
        cwd: `/nonexistent-${Date.now()}`,
        skipPermissions: false,
      }).catch((error) => (failure = error));
      assert.instanceOf(failure, AgyWorkingDirectoryError);

      failure = null;
      await resolveAgyBinary(`/nonexistent-${Date.now()}/agy`).catch(
        (error) => (failure = error),
      );
      assert.instanceOf(failure, AgyNotFoundError);
    });
  });
});
