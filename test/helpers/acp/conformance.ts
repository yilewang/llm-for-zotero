/**
 * ACP conformance checks: the protocol behaviors the plugin relies on.
 *
 * The same checks run against the fake agent and against the installed `agy`,
 * so the fake cannot drift from the real agent unnoticed. Checks marked
 * `info` record behavior the design depends on but does not assert, such as
 * where a relative file lands.
 */

import {
  ACP_METHODS,
  type AcpListSessionsResult,
  type AcpMcpServer,
  type AcpNewSessionResult,
  type AcpPromptResult,
  type AcpRequestPermissionParams,
  type AcpSessionNotification,
  type AcpSessionUpdate,
  type AcpSessionUpdateKind,
} from "../../../src/shared/acpProtocol";
import { AcpTestClient, type AcpByteDuplex } from "./acpTestClient";
import type { FakeAcpScenario } from "./fakeAcpAgent";

/** The stub Zotero tool every target is given. */
export const CONFORMANCE_MCP_SERVER_NAME = "zotero";
export const CONFORMANCE_MCP_TOOL = "zotero_lookup";
export const CONFORMANCE_ITEM_KEY = "ABCD1234";
export const CONFORMANCE_TOOL_RESULT = `Found: 'Attention Is All You Need' (Vaswani 2017), itemKey ${CONFORMANCE_ITEM_KEY}`;

const LOOKUP_PROMPT =
  `Call the ${CONFORMANCE_MCP_TOOL} tool with q set to "transformer". ` +
  "Then reply with only the itemKey it returns.";
const DENIED_PROMPT =
  `Call the ${CONFORMANCE_MCP_TOOL} tool with q set to "denied-probe". ` +
  "Then reply with only the itemKey it returns.";
const CANCEL_PROMPT = "Write a 400-word essay about libraries.";
const CWD_PROMPT =
  "Create a file named cwd-probe.txt containing the word probe, using a relative path " +
  "in your current working directory. Do not run any other command.";

/** Scenarios that make the fake agent answer the prompts above. */
export const CONFORMANCE_FAKE_SCENARIOS: FakeAcpScenario[] = [
  {
    match: /denied-probe/,
    title: "Denied Lookup",
    steps: [
      {
        type: "mcpTool",
        server: CONFORMANCE_MCP_SERVER_NAME,
        tool: CONFORMANCE_MCP_TOOL,
        args: { q: "denied-probe" },
      },
      { type: "text", text: "unreachable after a denial" },
    ],
  },
  {
    match: new RegExp(CONFORMANCE_MCP_TOOL),
    title: "Zotero Lookup",
    steps: [
      { type: "thought", text: "Looking the paper up." },
      {
        type: "mcpTool",
        server: CONFORMANCE_MCP_SERVER_NAME,
        tool: CONFORMANCE_MCP_TOOL,
        args: { q: "transformer" },
      },
      { type: "text", text: `The itemKey is ${CONFORMANCE_ITEM_KEY}.` },
    ],
  },
  {
    match: /essay/,
    title: "Essay",
    steps: [
      { type: "text", text: "Libraries " },
      { type: "wait", ms: 30_000 },
      { type: "text", text: "are memory." },
    ],
  },
];

export type ConformanceStatus = "pass" | "fail" | "info";

export type ConformanceResult = {
  name: string;
  status: ConformanceStatus;
  detail: string;
};

export type ConformanceTarget = {
  /** Starts a fresh agent process (or in-process agent) and returns its pipe. */
  connect(): Promise<AcpByteDuplex>;
  /** The `cwd` sent in `session/new`. */
  sessionCwd: string;
  /** The stub MCP server offering `zotero_lookup`. */
  mcpServer: AcpMcpServer;
  /** Readiness retry budget for "Authentication required". */
  readiness: { attempts: number; delayMs: number };
  /** Upper bound for one model turn. */
  turnTimeoutMs: number;
  /**
   * Live only: start an agent whose process runs in `processDir` while the
   * session asks for `sessionDir`, and report where a relative file lands.
   */
  workingDirectoryProbe?: {
    connectInDir(dir: string): Promise<AcpByteDuplex>;
    sessionDir: string;
    processDir: string;
    fileExists(path: string): Promise<boolean>;
  };
  log?(line: string): void;
};

type TurnRecord = {
  updates: AcpSessionUpdate[];
  permissions: AcpRequestPermissionParams[];
  result?: AcpPromptResult;
  error?: string;
};

function kinds(updates: AcpSessionUpdate[]): AcpSessionUpdateKind[] {
  return updates.map((update) => update.sessionUpdate);
}

function agentText(updates: AcpSessionUpdate[]): string {
  return updates
    .map((update) =>
      update.sessionUpdate === "agent_message_chunk" &&
      update.content.type === "text"
        ? update.content.text
        : "",
    )
    .join("");
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms} ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function collectUpdates(client: AcpTestClient, sessionId: string) {
  const updates: AcpSessionUpdate[] = [];
  const stop = client.onUpdate((notification: AcpSessionNotification) => {
    if (notification.sessionId === sessionId) updates.push(notification.update);
  });
  return { updates, stop };
}

export async function runAcpConformance(
  target: ConformanceTarget,
): Promise<ConformanceResult[]> {
  const results: ConformanceResult[] = [];
  const record = (name: string, status: ConformanceStatus, detail: string) => {
    results.push({ name, status, detail });
    target.log?.(`${status.toUpperCase().padEnd(4)} ${name}: ${detail}`);
  };
  const check = (name: string, ok: boolean, detail: string) =>
    record(name, ok ? "pass" : "fail", detail);

  const runTurn = async (
    client: AcpTestClient,
    sessionId: string,
    text: string,
    options: {
      permission: "allow" | "deny";
      cancelOnFirstUpdate?: boolean;
    },
  ): Promise<TurnRecord> => {
    const turn: TurnRecord = { updates: [], permissions: [] };
    client.onPermissionRequest((params) => {
      turn.permissions.push(params);
      const kind =
        options.permission === "allow" ? "allow_once" : "reject_once";
      const option = params.options.find(
        (candidate) => candidate.kind === kind,
      );
      return option
        ? { outcome: { outcome: "selected", optionId: option.optionId } }
        : { outcome: { outcome: "cancelled" } };
    });
    let cancelled = false;
    const stop = client.onUpdate((notification) => {
      if (notification.sessionId !== sessionId) return;
      turn.updates.push(notification.update);
      const streaming =
        notification.update.sessionUpdate === "agent_message_chunk" ||
        notification.update.sessionUpdate === "agent_thought_chunk";
      if (options.cancelOnFirstUpdate && streaming && !cancelled) {
        cancelled = true;
        client.notify(ACP_METHODS.sessionCancel, { sessionId });
      }
    });
    try {
      turn.result = await withTimeout(
        client.request<AcpPromptResult>(ACP_METHODS.sessionPrompt, {
          sessionId,
          prompt: [{ type: "text", text }],
        }),
        target.turnTimeoutMs,
        "session/prompt",
      );
    } catch (error) {
      turn.error = String((error as Error)?.message ?? error);
    } finally {
      stop();
    }
    return turn;
  };

  // ---------------------------------------------------------- first process
  const first = new AcpTestClient(await target.connect());
  let sessionId = "";
  try {
    const init = await first.initialize();
    const caps = init.agentCapabilities ?? {};
    check(
      "initialize: protocol version 1",
      init.protocolVersion === 1,
      `got ${init.protocolVersion}`,
    );
    check(
      "initialize: session load, resume, and list",
      Boolean(
        caps.loadSession &&
        caps.sessionCapabilities?.load &&
        caps.sessionCapabilities?.resume &&
        caps.sessionCapabilities?.list,
      ),
      JSON.stringify({
        loadSession: caps.loadSession,
        sessionCapabilities: Object.keys(caps.sessionCapabilities ?? {}),
      }),
    );
    check(
      "initialize: image prompts",
      caps.promptCapabilities?.image === true,
      JSON.stringify(caps.promptCapabilities ?? {}),
    );
    record(
      "initialize: agent",
      "info",
      `${init.agentInfo?.name ?? "?"} ${init.agentInfo?.version ?? "?"}`,
    );

    let retries = 0;
    const created = await first.requestWhenReady<AcpNewSessionResult>(
      ACP_METHODS.sessionNew,
      { cwd: target.sessionCwd, mcpServers: [target.mcpServer] },
      { ...target.readiness, onRetry: () => (retries += 1) },
    );
    sessionId = created.sessionId;
    record(
      "readiness: retries before session/new succeeded",
      "info",
      String(retries),
    );
    check(
      "session/new: session id",
      typeof sessionId === "string" && sessionId.length > 0,
      sessionId,
    );
    const modeIds = created.modes?.availableModes.map((mode) => mode.id) ?? [];
    check(
      "session/new: four permission modes",
      ["default", "accept-edits", "auto", "plan"].every((id) =>
        modeIds.includes(id),
      ),
      modeIds.join(", "),
    );
    const optionIds = created.configOptions?.map((option) => option.id) ?? [];
    check(
      "session/new: model, thought_level, and mode options",
      ["model", "thought_level", "mode"].every((id) => optionIds.includes(id)),
      optionIds.join(", "),
    );

    // Mode switching.
    {
      const { updates, stop } = collectUpdates(first, sessionId);
      await first.request(ACP_METHODS.sessionSetMode, {
        sessionId,
        modeId: "plan",
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      stop();
      const modeUpdate = updates.find(
        (u) => u.sessionUpdate === "current_mode_update",
      );
      check(
        "session/set_mode: current_mode_update",
        modeUpdate?.sessionUpdate === "current_mode_update" &&
          modeUpdate.currentModeId === "plan",
        kinds(updates).join(", ") || "no updates",
      );
      await first.request(ACP_METHODS.sessionSetMode, {
        sessionId,
        modeId: "default",
      });
    }

    // Model switching: choose the cheapest-looking model to spend less quota.
    {
      const modelOption = created.configOptions?.find(
        (option) => option.id === "model",
      );
      const cheap =
        modelOption?.options.find((option) => /flash/i.test(option.value)) ??
        modelOption?.options[0];
      if (cheap) {
        const reply = await first.request<{
          configOptions?: AcpNewSessionResult["configOptions"];
        }>(ACP_METHODS.sessionSetConfigOption, {
          sessionId,
          configId: "model",
          value: cheap.value,
        });
        const current = reply.configOptions?.find(
          (option) => option.id === "model",
        )?.currentValue;
        check(
          "session/set_config_option: model",
          current === cheap.value,
          `${cheap.value} -> ${current}`,
        );
      } else {
        check("session/set_config_option: model", false, "no model option");
      }
    }

    // Zotero tool injection and an approved permission request.
    {
      const turn = await runTurn(first, sessionId, LOOKUP_PROMPT, {
        permission: "allow",
      });
      const toolCall = turn.updates.find(
        (u) =>
          u.sessionUpdate === "tool_call" &&
          String(u.name ?? u.title ?? "").includes(CONFORMANCE_MCP_TOOL),
      );
      check(
        "prompt: injected MCP tool is called",
        Boolean(toolCall),
        toolCall && "name" in toolCall
          ? String(toolCall.name)
          : (turn.error ?? kinds(turn.updates).join(", ")),
      );
      const options =
        turn.permissions[0]?.options.map(
          (option) => `${option.optionId}:${option.kind}`,
        ) ?? [];
      check(
        "permission: allow_once and reject_once offered in default mode",
        options.some((o) => o.endsWith(":allow_once")) &&
          options.some((o) => o.endsWith(":reject_once")),
        options.join(", ") || "no permission request",
      );
      const completed = turn.updates.some(
        (u) =>
          u.sessionUpdate === "tool_call_update" && u.status === "completed",
      );
      check(
        "prompt: tool completes after approval",
        completed,
        kinds(turn.updates).join(", "),
      );
      const text = agentText(turn.updates);
      check(
        "prompt: answer uses the tool result",
        text.includes(CONFORMANCE_ITEM_KEY),
        JSON.stringify(text.slice(0, 200)),
      );
      check(
        "prompt: stopReason end_turn",
        turn.result?.stopReason === "end_turn",
        String(turn.result?.stopReason ?? turn.error),
      );
      check(
        "prompt: usage reported",
        typeof turn.result?.usage?.totalTokens === "number",
        JSON.stringify(turn.result?.usage ?? {}),
      );
      check(
        "prompt: usage_update with context size",
        turn.updates.some(
          (u) => u.sessionUpdate === "usage_update" && u.size > 0,
        ),
        kinds(turn.updates).join(", "),
      );
    }

    // Denied permission.
    {
      const turn = await runTurn(first, sessionId, DENIED_PROMPT, {
        permission: "deny",
      });
      check(
        "deny: a permission request was made",
        turn.permissions.length > 0,
        String(turn.permissions.length),
      );
      const failed = turn.updates.some(
        (u) => u.sessionUpdate === "tool_call_update" && u.status === "failed",
      );
      check(
        "deny: tool reported failed",
        failed,
        kinds(turn.updates).join(", "),
      );
      const text = agentText(turn.updates);
      record(
        "deny: assistant text after a denial",
        "info",
        text
          ? JSON.stringify(text.slice(0, 120))
          : "none (the UI must explain the stop)",
      );
    }

    // Cancel.
    {
      const turn = await runTurn(first, sessionId, CANCEL_PROMPT, {
        permission: "deny",
        cancelOnFirstUpdate: true,
      });
      check(
        "cancel: stopReason cancelled",
        turn.result?.stopReason === "cancelled",
        String(turn.result?.stopReason ?? turn.error),
      );
    }
  } finally {
    first.close();
  }

  // ---------------------------------------------------------- fresh process
  const second = new AcpTestClient(await target.connect());
  try {
    await second.initialize();
    const listed = await second.requestWhenReady<AcpListSessionsResult>(
      ACP_METHODS.sessionList,
      { cwd: target.sessionCwd },
      target.readiness,
    );
    check(
      "resume: session/list in a fresh process lists the session",
      listed.sessions.some((session) => session.sessionId === sessionId),
      `${listed.sessions.length} sessions`,
    );
    const foreign = listed.sessions.filter(
      (session) =>
        session.cwd !== undefined && session.cwd !== target.sessionCwd,
    ).length;
    record(
      "resume: session/list sessions from other folders despite the cwd filter",
      "info",
      `${foreign} of ${listed.sessions.length} (the client must filter by cwd itself)`,
    );
    const { updates, stop } = collectUpdates(second, sessionId);
    await second.request<AcpNewSessionResult>(ACP_METHODS.sessionLoad, {
      sessionId,
      cwd: target.sessionCwd,
      mcpServers: [target.mcpServer],
    });
    stop();
    const replayed = new Set(kinds(updates));
    check(
      "resume: session/load replays user, tool, and agent messages before responding",
      replayed.has("user_message_chunk") &&
        replayed.has("tool_call") &&
        replayed.has("agent_message_chunk"),
      [...replayed].join(", "),
    );
    check(
      "resume: replay contains the earlier answer",
      agentText(updates).includes(CONFORMANCE_ITEM_KEY),
      JSON.stringify(agentText(updates).slice(0, 120)),
    );
  } finally {
    second.close();
  }

  // ---------------------------------------------------------- working dir
  const probe = target.workingDirectoryProbe;
  if (probe) {
    const client = new AcpTestClient(
      await probe.connectInDir(probe.processDir),
    );
    try {
      await client.initialize();
      const created = await client.requestWhenReady<AcpNewSessionResult>(
        ACP_METHODS.sessionNew,
        { cwd: probe.sessionDir, mcpServers: [] },
        target.readiness,
      );
      const turn = await runTurn(client, created.sessionId, CWD_PROMPT, {
        permission: "allow",
      });
      const inSession = await probe.fileExists(
        `${probe.sessionDir}/cwd-probe.txt`,
      );
      const inProcess = await probe.fileExists(
        `${probe.processDir}/cwd-probe.txt`,
      );
      const where =
        inSession && inProcess
          ? "both"
          : inSession
            ? "session cwd"
            : inProcess
              ? "process cwd"
              : "neither";
      const paths = turn.updates
        .filter((u) => u.sessionUpdate === "tool_call")
        .map((u) => JSON.stringify((u as { args?: unknown }).args ?? {}))
        .join(" ");
      record(
        "working directory: relative file landed in",
        "info",
        `${where}; tool args ${paths || "none"}`,
      );
    } finally {
      client.close();
    }
  }

  return results;
}
