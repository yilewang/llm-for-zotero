import { assert } from "chai";
import {
  ACP_PROTOCOL_VERSION,
  AcpProtocol,
  buildInitializeParams,
  buildNewSessionParams,
  buildPromptParams,
  parsePermissionRequest,
  parseSessionUpdate,
  pickDenyOption,
  readInitializeResult,
  readNewSessionResult,
} from "../src/acp/protocol";
import {
  acpUpdateToAgentEvents,
  isAcpStopReasonComplete,
} from "../src/acp/events";

/** Collects what the protocol writes and feeds replies back by hand. */
function harness() {
  const written: Array<Record<string, unknown>> = [];
  const protocol = new AcpProtocol((line) => {
    written.push(JSON.parse(line) as Record<string, unknown>);
  });
  const requestOfType = (method: string) =>
    written.find((message) => message.method === method);
  const idsOf = (method: string) =>
    written
      .filter((message) => message.method === method)
      .map((message) => message.id);
  return { protocol, written, requestOfType, idsOf };
}

describe("acp protocol", function () {
  it("frames one JSON object per line and correlates the reply", async function () {
    const { protocol, requestOfType, idsOf } = harness();
    const pending = protocol.request("session/new", { cwd: "/tmp" });
    const id = idsOf("session/new")[0];
    assert.isNumber(id);
    assert.deepEqual(requestOfType("session/new")?.params, { cwd: "/tmp" });

    protocol.handleLine(JSON.stringify({ jsonrpc: "2.0", id, result: { sessionId: "s1" } }));
    assert.deepEqual(await pending, { sessionId: "s1" });
    assert.equal(protocol.pendingCount, 0);
  });

  it("rejects the caller when the agent answers with an error", async function () {
    const { protocol, idsOf } = harness();
    const pending = protocol.request("session/prompt", {});
    protocol.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: idsOf("session/prompt")[0],
        error: { code: -32602, message: "Invalid params" },
      }),
    );
    let message = "";
    await pending.catch((error: Error) => {
      message = error.message;
    });
    assert.include(message, "Invalid params");
  });

  it("times a request out instead of hanging the turn", async function () {
    const { protocol } = harness();
    let message = "";
    await protocol.request("initialize", {}, 5).catch((error: Error) => {
      message = error.message;
    });
    assert.include(message, "timed out");
    assert.equal(protocol.pendingCount, 0);
  });

  it("dispatches notifications and ignores unparseable lines", function () {
    const { protocol } = harness();
    const seen: unknown[] = [];
    const unsubscribe = protocol.onNotification("session/update", (params) =>
      seen.push(params),
    );
    protocol.handleLine("not json at all");
    protocol.handleLine("");
    protocol.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk" } },
      }),
    );
    assert.lengthOf(seen, 1);
    unsubscribe();
    protocol.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk" } },
      }),
    );
    assert.lengthOf(seen, 1);
  });

  it("answers an agent-to-client request, and refuses one it does not serve", async function () {
    const { protocol, written } = harness();
    protocol.onRequest("session/request_permission", () => ({
      outcome: { outcome: "cancelled" },
    }));

    protocol.handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: 77, method: "session/request_permission", params: {} }),
    );
    await Promise.resolve();
    await Promise.resolve();
    const answered = written.find((message) => message.id === 77);
    assert.deepEqual(answered?.result, { outcome: { outcome: "cancelled" } });

    protocol.handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: 78, method: "fs/read_text_file", params: {} }),
    );
    await Promise.resolve();
    const refused = written.find((message) => message.id === 78) as {
      error?: { code?: number };
    };
    assert.equal(refused?.error?.code, -32601);
  });

  it("fails in-flight requests when the process closes", async function () {
    const { protocol } = harness();
    const pending = protocol.request("session/prompt", {}, 0);
    protocol.close(new Error("agent exited"));
    let message = "";
    await pending.catch((error: Error) => {
      message = error.message;
    });
    assert.equal(message, "agent exited");
  });

  it("builds the params this plugin's client sends", function () {
    const initialize = buildInitializeParams({
      name: "llm-for-zotero",
      version: "1.0",
    });
    assert.equal(initialize.protocolVersion, ACP_PROTOCOL_VERSION);
    // The plugin serves no filesystem surface to the agent.
    assert.deepEqual(initialize.clientCapabilities.fs, {
      readTextFile: false,
      writeTextFile: false,
    });

    assert.deepEqual(buildNewSessionParams({ cwd: "/tmp/x" }), {
      cwd: "/tmp/x",
      mcpServers: [],
    });
    assert.deepEqual(buildPromptParams({ sessionId: "s1", text: "hello" }), {
      sessionId: "s1",
      prompt: [{ type: "text", text: "hello" }],
    });
  });

  it("reads the session id and model catalog out of a session/new result", function () {
    assert.isNull(readNewSessionResult({}));
    const session = readNewSessionResult({
      sessionId: "abc",
      models: {
        currentModelId: "openrouter:x",
        availableModels: [
          { modelId: "openrouter:x", name: "X" },
          { name: "no model id" },
        ],
      },
    });
    assert.equal(session?.sessionId, "abc");
    assert.deepEqual(
      session?.models?.availableModels?.map((entry) => entry.modelId),
      ["openrouter:x"],
    );
  });

  it("reads the handshake, including whether the agent can resume sessions", function () {
    const info = readInitializeResult({
      protocolVersion: 1,
      agentInfo: { name: "hermes-agent", version: "0.21.5" },
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
      authMethods: [{ id: "custom", name: "custom runtime credentials" }],
    });
    assert.equal(info?.protocolVersion, 1);
    assert.equal(info?.agentInfo?.name, "hermes-agent");
    assert.equal(info?.agentCapabilities?.loadSession, true);
    assert.deepEqual(info?.authMethods?.map((method) => method.id), ["custom"]);
    // A result without a protocol version is not a handshake.
    assert.isNull(readInitializeResult({ agentInfo: {} }));
  });
});

describe("acp session updates", function () {
  it("normalizes the variants the panel acts on", function () {
    const chunk = parseSessionUpdate({
      sessionId: "s1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
    });
    assert.deepEqual(chunk?.update, { kind: "message_chunk", text: "hi" });

    const thought = parseSessionUpdate({
      sessionId: "s1",
      update: { sessionUpdate: "agent_thought_chunk", content: { text: "thinking" } },
    });
    assert.deepEqual(thought?.update, { kind: "thought_chunk", text: "thinking" });

    const tool = parseSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Read a file",
        kind: "read",
        status: "pending",
        rawInput: { path: "x" },
      },
    });
    assert.equal(tool?.update.kind, "tool_call");
    assert.equal((tool?.update as { title: string }).title, "Read a file");

    const usage = parseSessionUpdate({
      sessionId: "s1",
      update: { sessionUpdate: "usage_update", used: 9850, size: 1048576 },
    });
    assert.deepEqual(usage?.update, { kind: "usage", used: 9850, size: 1048576 });

    const unknown = parseSessionUpdate({
      sessionId: "s1",
      update: { sessionUpdate: "something_new" },
    });
    assert.deepEqual(unknown?.update, {
      kind: "other",
      sessionUpdate: "something_new",
    });
  });

  it("refuses updates it cannot attribute to a session", function () {
    assert.isNull(parseSessionUpdate({ update: { sessionUpdate: "x" } }));
    assert.isNull(parseSessionUpdate({ sessionId: "s1", update: {} }));
    assert.isNull(parseSessionUpdate(null));
  });

  it("maps updates onto the panel's own event stream", function () {
    assert.deepEqual(
      acpUpdateToAgentEvents({ kind: "message_chunk", text: "hi" }),
      [{ type: "message_delta", text: "hi" }],
    );
    assert.deepEqual(
      acpUpdateToAgentEvents({ kind: "thought_chunk", text: "why" }),
      [{ type: "reasoning", round: 1, details: "why" }],
    );
    assert.deepEqual(
      acpUpdateToAgentEvents({
        kind: "tool_call",
        toolCallId: "t1",
        title: "Read a file",
        rawInput: { path: "x" },
      }),
      [
        {
          type: "tool_call",
          callId: "t1",
          name: "Read a file",
          args: { path: "x" },
          toolLabel: "Read a file",
        },
      ],
    );
    // An open tool card stays open: only a terminal status closes it.
    assert.deepEqual(
      acpUpdateToAgentEvents({
        kind: "tool_call_update",
        toolCallId: "t1",
        status: "in_progress",
      }),
      [],
    );
    const closed = acpUpdateToAgentEvents({
      kind: "tool_call_update",
      toolCallId: "t1",
      title: "Read a file",
      status: "completed",
      rawOutput: "ok",
    });
    assert.equal(closed[0]?.type, "tool_result");
    assert.equal((closed[0] as { ok: boolean }).ok, true);

    const failed = acpUpdateToAgentEvents({
      kind: "tool_call_update",
      toolCallId: "t1",
      status: "failed",
    });
    assert.equal((failed[0] as { ok: boolean }).ok, false);

    // Variants with nowhere to go yet are dropped rather than approximated.
    assert.deepEqual(
      acpUpdateToAgentEvents({ kind: "plan", entries: [{ content: "step" }] }),
      [],
    );
    assert.deepEqual(acpUpdateToAgentEvents({ kind: "user_chunk", text: "me" }), []);
  });

  it("treats an absent stop reason as a clean end of turn", function () {
    assert.isTrue(isAcpStopReasonComplete(undefined));
    assert.isTrue(isAcpStopReasonComplete("end_turn"));
    assert.isFalse(isAcpStopReasonComplete("refusal"));
  });

  it("reads a permission request, including a missing tool call", function () {
    const parsed = parsePermissionRequest({
      sessionId: "s1",
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
        { name: "no id" },
      ],
      toolCall: { toolCallId: "t1", title: "Run a command" },
    });
    assert.equal(parsed.title, "Run a command");
    assert.deepEqual(parsed.options.map((option) => option.optionId), [
      "allow",
      "deny",
    ]);
    assert.deepEqual(parsePermissionRequest(undefined).options, []);
  });

  it("refuses a permission request with the narrowest refusal offered", function () {
    const once = pickDenyOption([
      { optionId: "a", kind: "allow_once" },
      { optionId: "r1", kind: "reject_once" },
      { optionId: "r2", kind: "reject_always" },
    ]);
    assert.equal(once?.optionId, "r1");
    // No reject_once offered: reject_always still refuses.
    assert.equal(
      pickDenyOption([{ optionId: "r2", kind: "reject_always" }])?.optionId,
      "r2",
    );
    // An unfamiliar rejection kind is still a rejection.
    assert.equal(
      pickDenyOption([{ optionId: "r3", kind: "REJECT_SESSION" }])?.optionId,
      "r3",
    );
    // Nothing to refuse with: the caller cancels the request instead.
    assert.isUndefined(pickDenyOption([{ optionId: "a", kind: "allow_once" }]));
    assert.isUndefined(pickDenyOption([]));
  });
});
