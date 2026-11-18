/**
 * A scripted, deterministic ACP agent that behaves like `agy acp` 1.5.10.
 *
 * It speaks newline-delimited JSON-RPC: feed it bytes with `write()` and read
 * its output through the `onOutput` callback. Turns are driven by scenarios
 * matched against the prompt text, so tests never need a network, a model, or
 * quota. The recorded quirks of the real agent are reproduced on purpose:
 *
 * - the first `authPendingRequests` requests after start fail with -32000
 *   "Authentication required" (credentials still loading);
 * - which tool kinds ask for permission depends on the session mode;
 * - a denied tool ends the turn with a `failed` update and no assistant text;
 * - `session/load` replays history as updates before it responds;
 * - `session/list` ignores its `cwd` filter;
 * - `session/cancel` ends the running prompt with `stopReason: "cancelled"`.
 *
 * `npm run check:acp-conformance -- --live` checks these against the real agy.
 */

import {
  ACP_AUTH_REQUIRED_ERROR_CODE,
  ACP_METHOD_NOT_FOUND_ERROR_CODE,
  ACP_METHODS,
  isJsonRpcRequest,
  isJsonRpcResponse,
  type AcpConfigOption,
  type AcpContentBlock,
  type AcpInitializeResult,
  type AcpMcpServer,
  type AcpNewSessionParams,
  type AcpNewSessionResult,
  type AcpPermissionOption,
  type AcpPromptParams,
  type AcpPromptResult,
  type AcpRequestPermissionResult,
  type AcpSessionUpdate,
  type AcpStopReason,
  type AcpToolCall,
  type AcpToolCallStatus,
  type JsonRpcError,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "../../../src/shared/acpProtocol";
import agyFixture from "../../fixtures/acp/agy-1.5.10.json";
import { createLineSplitter } from "./lineSplitter";

// ---------------------------------------------------------------- scenarios

export type FakeAcpStep =
  /** One `agent_message_chunk`. `{{tool}}` is replaced by the last tool result. */
  | { type: "text"; text: string }
  | { type: "thought"; text: string }
  /** A built-in tool the agent runs itself (file edit, shell command, ...). */
  | {
      type: "tool";
      name: string;
      kind: string;
      title?: string;
      args?: Record<string, unknown>;
      result?: string;
      /** Overrides the mode-based permission policy. */
      askPermission?: boolean;
      /**
       * Names the prompt's attached files (its `resource_link` blocks) as the
       * tool's locations, like agy's read_file on an attached file.
       */
      readsAttachments?: boolean;
      /** Absolute paths the tool touches (its `locations`). */
      locations?: string[];
    }
  /** A tool on an MCP server the client passed in `session/new`. */
  | {
      type: "mcpTool";
      /** The server's name, or "*" for the first server the session has. */
      server: string;
      tool: string;
      args: Record<string, unknown>;
      askPermission?: boolean;
    }
  | {
      type: "plan";
      entries: Array<{ content: string; status?: string; priority?: string }>;
    }
  /** Pause; a cancel during the pause ends the turn. */
  | { type: "wait"; ms: number };

export type FakeAcpScenario = {
  /** Matched against the concatenated prompt text; the first match wins. */
  match: RegExp;
  /** Sent as `session_info_update` on the session's first turn. */
  title?: string;
  steps: FakeAcpStep[];
};

export const DEFAULT_FAKE_ACP_SCENARIO: FakeAcpScenario = {
  match: /[\s\S]*/,
  title: "Fake Session",
  steps: [{ type: "text", text: "OK." }],
};

// ---------------------------------------------------------------- sessions

export type FakeAcpStoredSession = {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt: string;
  modeId: string;
  model: string;
  thoughtLevel: string;
  /**
   * The MCP tools the model could call on the last MCP use: those that fit
   * agy's tool budget (eagerMcpToolNames).
   */
  callableMcpTools?: string[];
  /** The input schema of each MCP tool on the last MCP use. */
  mcpToolSchemas?: Record<string, unknown>;
  /** `_meta.antigravity.systemPrompt.append` from session/new. */
  systemPrompt?: string;
  /** Updates replayed by `session/load`, in order. */
  history: AcpSessionUpdate[];
  usedTokens: number;
};

/**
 * Where sessions live. Share one store between two agents to simulate a
 * resume in a fresh process; the stdio wrapper persists it to a file.
 */
export type FakeAcpSessionStore = {
  get(sessionId: string): FakeAcpStoredSession | undefined;
  put(session: FakeAcpStoredSession): void;
  list(): FakeAcpStoredSession[];
};

export function createMemoryFakeAcpSessionStore(): FakeAcpSessionStore {
  const sessions = new Map<string, FakeAcpStoredSession>();
  return {
    get: (id) => sessions.get(id),
    put: (session) => void sessions.set(session.sessionId, session),
    list: () => [...sessions.values()],
  };
}

// ---------------------------------------------------------------- options

export type FakeAcpAgentOptions = {
  scenarios?: FakeAcpScenario[];
  store?: FakeAcpSessionStore;
  /** Number of requests after start that fail with -32000. */
  authPendingRequests?: number;
  /** Mirrors `--dangerously-skip-permissions`: no permission requests. */
  skipPermissions?: boolean;
  /** HTTP client for `mcpTool` steps; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Session id factory, for stable ids in tests. */
  newSessionId?: () => string;
  /** Clock for `updatedAt`. */
  now?: () => Date;
};

type PendingAgentRequest = {
  resolve: (result: unknown) => void;
  reject: (error: JsonRpcError) => void;
};

type RunningTurn = {
  cancelled: boolean;
  wake?: () => void;
};

const CONTEXT_WINDOW_TOKENS = 1_048_576;

/** Tool kinds that ask for permission in each mode, as observed in agy. */
const PERMISSION_KINDS_BY_MODE: Record<string, ReadonlySet<string>> = {
  default: new Set(["edit", "delete", "move", "execute", "mcp"]),
  plan: new Set(["edit", "delete", "move", "execute", "mcp"]),
  "accept-edits": new Set(["delete", "execute", "mcp"]),
  auto: new Set(["delete"]),
};

const THOUGHT_LEVEL_SUFFIX = /-(low|medium|high|xhigh)$/;

function cloneFixture<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function promptText(prompt: AcpContentBlock[]): string {
  return prompt
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");
}

/** The local paths of the prompt's `resource_link` file blocks. */
function attachedFileLocations(
  prompt: AcpContentBlock[],
): Array<{ path: string }> {
  return prompt.flatMap((block) =>
    block.type === "resource_link" && block.uri.startsWith("file://")
      ? [{ path: decodeURIComponent(block.uri.slice("file://".length)) }]
      : [],
  );
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export class FakeAcpAgent {
  private readonly options: Required<
    Omit<FakeAcpAgentOptions, "fetch" | "newSessionId" | "now">
  > &
    Pick<FakeAcpAgentOptions, "fetch">;
  private readonly newSessionId: () => string;
  private readonly now: () => Date;
  private readonly outputListeners: Array<(chunk: string) => void> = [];
  private readonly splitter: (chunk: string) => void;
  private readonly pendingAgentRequests = new Map<
    JsonRpcId,
    PendingAgentRequest
  >();
  private readonly runningTurns = new Map<string, RunningTurn>();
  /** MCP servers are per process, not persisted with the session. */
  private readonly sessionMcpServers = new Map<string, AcpMcpServer[]>();
  private authPendingRemaining: number;
  private nextAgentRequestId = 1000;
  private sessionCounter = 0;
  private closed = false;

  constructor(options: FakeAcpAgentOptions = {}) {
    this.options = {
      scenarios: options.scenarios ?? [],
      store: options.store ?? createMemoryFakeAcpSessionStore(),
      authPendingRequests: options.authPendingRequests ?? 0,
      skipPermissions: options.skipPermissions ?? false,
      fetch: options.fetch,
    };
    this.authPendingRemaining = this.options.authPendingRequests;
    this.newSessionId =
      options.newSessionId ??
      (() => {
        this.sessionCounter += 1;
        const suffix = String(this.sessionCounter).padStart(12, "0");
        return `fa4e0000-0000-4000-8000-${suffix}`;
      });
    this.now = options.now ?? (() => new Date());
    this.splitter = createLineSplitter((line) => this.receiveLine(line));
  }

  /** Bytes from the client (the agent's stdin). */
  write(chunk: string): void {
    if (this.closed) return;
    this.splitter(chunk);
  }

  /** Bytes to the client (the agent's stdout). */
  onOutput(listener: (chunk: string) => void): () => void {
    this.outputListeners.push(listener);
    return () => {
      const index = this.outputListeners.indexOf(listener);
      if (index >= 0) this.outputListeners.splice(index, 1);
    };
  }

  /** Mirrors the process exiting: running turns stop, nothing more is sent. */
  close(): void {
    this.closed = true;
    for (const turn of this.runningTurns.values()) {
      turn.cancelled = true;
      turn.wake?.();
    }
    for (const pending of this.pendingAgentRequests.values()) {
      pending.reject({ code: -32099, message: "Agent closed" });
    }
    this.pendingAgentRequests.clear();
  }

  // ------------------------------------------------------------ framing

  private send(message: JsonRpcMessage): void {
    if (this.closed) return;
    const line = `${JSON.stringify(message)}\n`;
    for (const listener of [...this.outputListeners]) listener(line);
  }

  private respond(id: JsonRpcId, result: unknown): void {
    this.send({ jsonrpc: "2.0", id, result });
  }

  private fail(id: JsonRpcId, error: JsonRpcError): void {
    this.send({ jsonrpc: "2.0", id, error });
  }

  private notifyUpdate(sessionId: string, update: AcpSessionUpdate): void {
    this.send({
      jsonrpc: "2.0",
      method: ACP_METHODS.sessionUpdate,
      params: { sessionId, update },
    });
  }

  private requestClient<R>(method: string, params: unknown): Promise<R> {
    const id = this.nextAgentRequestId++;
    return new Promise<R>((resolve, reject) => {
      this.pendingAgentRequests.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private receiveLine(line: string): void {
    if (!line.trim()) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.send({
        jsonrpc: "2.0",
        id: null as unknown as JsonRpcId,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }
    if (isJsonRpcResponse(message)) {
      this.receiveResponse(message);
      return;
    }
    if (isJsonRpcRequest(message)) {
      void this.receiveRequest(message);
      return;
    }
    if (message.method === ACP_METHODS.sessionCancel) {
      const sessionId = (message.params as { sessionId?: string })?.sessionId;
      const turn = sessionId ? this.runningTurns.get(sessionId) : undefined;
      if (turn) {
        turn.cancelled = true;
        turn.wake?.();
      }
    }
  }

  private receiveResponse(message: JsonRpcResponse): void {
    const pending = this.pendingAgentRequests.get(message.id);
    if (!pending) return;
    this.pendingAgentRequests.delete(message.id);
    if ("error" in message) pending.reject(message.error);
    else pending.resolve(message.result);
  }

  private async receiveRequest(request: JsonRpcRequest): Promise<void> {
    if (
      request.method !== ACP_METHODS.initialize &&
      this.authPendingRemaining > 0
    ) {
      this.authPendingRemaining -= 1;
      this.fail(request.id, {
        code: ACP_AUTH_REQUIRED_ERROR_CODE,
        message: "Authentication required",
      });
      return;
    }
    try {
      const result = await this.dispatch(request);
      this.respond(request.id, result);
    } catch (error) {
      this.fail(request.id, toJsonRpcError(error));
    }
  }

  private dispatch(request: JsonRpcRequest): Promise<unknown> | unknown {
    const params = (request.params ?? {}) as Record<string, unknown>;
    switch (request.method) {
      case ACP_METHODS.initialize:
        return this.initialize();
      case ACP_METHODS.sessionNew:
        return this.newSession(params as AcpNewSessionParams);
      case ACP_METHODS.sessionLoad:
        return this.loadSession(
          params as AcpNewSessionParams & { sessionId: string },
          true,
        );
      case ACP_METHODS.sessionResume:
        return this.loadSession(
          params as AcpNewSessionParams & { sessionId: string },
          false,
        );
      case ACP_METHODS.sessionList:
        return this.listSessions(params as { cwd?: string });
      case ACP_METHODS.sessionClose:
        this.requireSession(String(params.sessionId));
        return {};
      case ACP_METHODS.sessionSetMode:
        return this.setMode(String(params.sessionId), String(params.modeId));
      case ACP_METHODS.sessionSetConfigOption:
        return this.setConfigOption(
          String(params.sessionId),
          String(params.configId),
          String(params.value),
        );
      case ACP_METHODS.sessionSetModel:
        return this.setModel(String(params.sessionId), String(params.modelId));
      case ACP_METHODS.sessionPrompt:
        return this.prompt(params as AcpPromptParams);
      default:
        throw {
          code: ACP_METHOD_NOT_FOUND_ERROR_CODE,
          message: `Method not found: ${request.method}`,
        } satisfies JsonRpcError;
    }
  }

  // ------------------------------------------------------------ handlers

  private initialize(): AcpInitializeResult {
    return cloneFixture(agyFixture.initialize) as AcpInitializeResult;
  }

  private sessionState(session: FakeAcpStoredSession): AcpNewSessionResult {
    const base = cloneFixture(agyFixture.sessionNew) as AcpNewSessionResult;
    base.sessionId = session.sessionId;
    if (base.models) {
      base.models.currentModelId = `${session.model}-${session.thoughtLevel}`;
    }
    if (base.modes) base.modes.currentModeId = session.modeId;
    base.configOptions = this.configOptions(session);
    return base;
  }

  private configOptions(session: FakeAcpStoredSession): AcpConfigOption[] {
    const options = cloneFixture(
      agyFixture.sessionNew.configOptions,
    ) as AcpConfigOption[];
    for (const option of options) {
      if (option.id === "model") option.currentValue = session.model;
      if (option.id === "thought_level")
        option.currentValue = session.thoughtLevel;
      if (option.id === "mode") option.currentValue = session.modeId;
    }
    return options;
  }

  private newSession(params: AcpNewSessionParams): AcpNewSessionResult {
    if (typeof params.cwd !== "string" || !params.cwd) {
      throw { code: -32602, message: "cwd is required" } satisfies JsonRpcError;
    }
    const fixtureDefault = (id: string) =>
      String(
        agyFixture.sessionNew.configOptions.find((o) => o.id === id)
          ?.currentValue ?? "",
      );
    const session: FakeAcpStoredSession = {
      sessionId: this.newSessionId(),
      cwd: params.cwd,
      updatedAt: this.now().toISOString(),
      modeId: fixtureDefault("mode"),
      model: fixtureDefault("model"),
      thoughtLevel: fixtureDefault("thought_level"),
      ...(params._meta?.antigravity?.systemPrompt?.append
        ? { systemPrompt: params._meta.antigravity.systemPrompt.append }
        : {}),
      history: [],
      usedTokens: 0,
    };
    this.options.store.put(session);
    this.sessionMcpServers.set(session.sessionId, params.mcpServers ?? []);
    queueMicrotask(() => this.announceCommands(session.sessionId));
    return this.sessionState(session);
  }

  private announceCommands(sessionId: string): void {
    this.notifyUpdate(sessionId, {
      sessionUpdate: "available_commands_update",
      availableCommands: [
        {
          name: "goal",
          description: "Run until the specified goal is completely finished.",
        },
        { name: "compact", description: "Compact the conversation now." },
        {
          name: "plan",
          description: "Plan carefully before executing a task.",
        },
      ],
    });
  }

  private loadSession(
    params: AcpNewSessionParams & { sessionId: string },
    replay: boolean,
  ): AcpNewSessionResult {
    const session = this.requireSession(params.sessionId);
    this.sessionMcpServers.set(session.sessionId, params.mcpServers ?? []);
    if (replay) {
      for (const update of session.history) {
        this.notifyUpdate(session.sessionId, cloneFixture(update));
      }
      this.notifyUpdate(session.sessionId, {
        sessionUpdate: "usage_update",
        used: session.usedTokens,
        size: CONTEXT_WINDOW_TOKENS,
      });
    }
    return this.sessionState(session);
  }

  /** agy 1.5.10 ignores the `cwd` filter and lists every session. */
  private listSessions(_params: { cwd?: string }) {
    const sessions = this.options.store
      .list()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((session) => ({
        sessionId: session.sessionId,
        cwd: session.cwd,
        title: session.title,
        updatedAt: session.updatedAt,
      }));
    return { sessions };
  }

  private requireSession(sessionId: string): FakeAcpStoredSession {
    const session = this.options.store.get(sessionId);
    if (!session) {
      throw {
        code: -32602,
        message: `Session not found: ${sessionId}`,
      } satisfies JsonRpcError;
    }
    return session;
  }

  private emitConfig(session: FakeAcpStoredSession): void {
    this.notifyUpdate(session.sessionId, {
      sessionUpdate: "config_option_update",
      configOptions: this.configOptions(session),
    });
  }

  private setMode(sessionId: string, modeId: string): Record<string, never> {
    const session = this.requireSession(sessionId);
    if (!(modeId in PERMISSION_KINDS_BY_MODE)) {
      throw {
        code: -32602,
        message: `Unknown mode: ${modeId}`,
      } satisfies JsonRpcError;
    }
    session.modeId = modeId;
    this.options.store.put(session);
    this.notifyUpdate(sessionId, {
      sessionUpdate: "current_mode_update",
      currentModeId: modeId,
    });
    this.emitConfig(session);
    return {};
  }

  private setConfigOption(sessionId: string, configId: string, value: string) {
    const session = this.requireSession(sessionId);
    const option = this.configOptions(session).find((o) => o.id === configId);
    if (!option || !option.options.some((o) => o.value === value)) {
      throw {
        code: -32602,
        message: `Invalid config option ${configId}=${value}`,
      } satisfies JsonRpcError;
    }
    if (configId === "model") session.model = value;
    if (configId === "thought_level") session.thoughtLevel = value;
    if (configId === "mode") {
      session.modeId = value;
      this.notifyUpdate(sessionId, {
        sessionUpdate: "current_mode_update",
        currentModeId: value,
      });
    }
    this.options.store.put(session);
    this.emitConfig(session);
    return { configOptions: this.configOptions(session) };
  }

  private setModel(sessionId: string, modelId: string): Record<string, never> {
    const session = this.requireSession(sessionId);
    const known = agyFixture.sessionNew.models.availableModels.some(
      (model) => model.modelId === modelId,
    );
    if (!known) {
      throw {
        code: -32602,
        message: `Unknown model: ${modelId}`,
      } satisfies JsonRpcError;
    }
    const suffix = THOUGHT_LEVEL_SUFFIX.exec(modelId);
    session.model = suffix ? modelId.slice(0, suffix.index) : modelId;
    if (suffix) session.thoughtLevel = suffix[1];
    this.options.store.put(session);
    this.emitConfig(session);
    return {};
  }

  // ------------------------------------------------------------ turns

  private async prompt(params: AcpPromptParams): Promise<AcpPromptResult> {
    const session = this.requireSession(params.sessionId);
    if (this.runningTurns.has(session.sessionId)) {
      throw {
        code: -32603,
        message: "A prompt is already running",
      } satisfies JsonRpcError;
    }
    const turn: RunningTurn = { cancelled: false };
    this.runningTurns.set(session.sessionId, turn);
    try {
      return await this.runTurn(session, params.prompt, turn);
    } finally {
      this.runningTurns.delete(session.sessionId);
      session.updatedAt = this.now().toISOString();
      this.options.store.put(session);
    }
  }

  private async runTurn(
    session: FakeAcpStoredSession,
    prompt: AcpContentBlock[],
    turn: RunningTurn,
  ): Promise<AcpPromptResult> {
    const text = promptText(prompt);
    const scenario =
      this.options.scenarios.find((candidate) => candidate.match.test(text)) ??
      DEFAULT_FAKE_ACP_SCENARIO;
    const inputTokens = 12_000 + estimateTokens(text);
    let outputTokens = 0;
    let agentText = "";
    let lastToolResult = "";

    for (const block of prompt) {
      session.history.push({
        sessionUpdate: "user_message_chunk",
        content: block,
      });
    }
    this.notifyUpdate(session.sessionId, {
      sessionUpdate: "usage_update",
      used: session.usedTokens,
      size: CONTEXT_WINDOW_TOKENS,
    });
    if (!session.title && scenario.title) {
      session.title = scenario.title;
      this.notifyUpdate(session.sessionId, {
        sessionUpdate: "session_info_update",
        title: scenario.title,
      });
    }

    const finish = (stopReason: AcpStopReason): AcpPromptResult => {
      if (agentText) {
        session.history.push({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: agentText },
        });
      }
      session.usedTokens += inputTokens + outputTokens;
      this.notifyUpdate(session.sessionId, {
        sessionUpdate: "usage_update",
        used: session.usedTokens,
        size: CONTEXT_WINDOW_TOKENS,
      });
      return {
        stopReason,
        usage: {
          inputTokens,
          outputTokens,
          cachedReadTokens: 0,
          cachedWriteTokens: 0,
          thoughtTokens: 0,
          totalTokens: inputTokens + outputTokens,
        },
      };
    };

    for (const step of scenario.steps) {
      if (turn.cancelled || this.closed) return finish("cancelled");
      switch (step.type) {
        case "text": {
          const chunk = step.text.replace(/\{\{tool\}\}/g, lastToolResult);
          agentText += chunk;
          outputTokens += estimateTokens(chunk);
          this.notifyUpdate(session.sessionId, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: chunk },
          });
          break;
        }
        case "thought": {
          const update: AcpSessionUpdate = {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: step.text },
          };
          session.history.push(update);
          this.notifyUpdate(session.sessionId, update);
          break;
        }
        case "plan":
          this.notifyUpdate(session.sessionId, {
            sessionUpdate: "plan",
            entries: step.entries,
          });
          break;
        case "wait":
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, step.ms);
            turn.wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          turn.wake = undefined;
          break;
        case "tool":
        case "mcpTool": {
          const outcome = await this.runTool(session, step, turn, prompt);
          if (outcome.status === "cancelled") return finish("cancelled");
          // agy ends the turn silently after a denial: no assistant text.
          if (outcome.status === "denied") return finish("end_turn");
          lastToolResult = outcome.result;
          break;
        }
      }
    }
    return finish(turn.cancelled ? "cancelled" : "end_turn");
  }

  private needsPermission(
    session: FakeAcpStoredSession,
    kind: string,
    override: boolean | undefined,
  ): boolean {
    if (this.options.skipPermissions) return false;
    if (override !== undefined) return override;
    return PERMISSION_KINDS_BY_MODE[session.modeId]?.has(kind) ?? true;
  }

  private async runTool(
    session: FakeAcpStoredSession,
    step: Extract<FakeAcpStep, { type: "tool" | "mcpTool" }>,
    turn: RunningTurn,
    prompt: AcpContentBlock[],
  ): Promise<
    | { status: "completed"; result: string }
    | { status: "denied" }
    | { status: "cancelled" }
  > {
    const toolCallId = `call_${this.nextAgentRequestId++}`;
    const isMcp = step.type === "mcpTool";
    const serverName = isMcp
      ? step.server === "*"
        ? (this.sessionMcpServers.get(session.sessionId)?.[0]?.name ?? "")
        : step.server
      : "";
    const name = isMcp ? `mcp_${serverName}_${step.tool}` : step.name;
    const args = step.args ?? {};
    const kind = isMcp ? "other" : step.kind;
    const permissionKind = isMcp ? "mcp" : step.kind;
    const call: AcpToolCall = {
      toolCallId,
      name,
      args,
      rawInput: args,
      kind,
      title: isMcp ? `${serverName}: ${step.tool}` : (step.title ?? name),
      locations: isMcp
        ? []
        : step.readsAttachments
          ? attachedFileLocations(prompt)
          : (step.locations ?? []).map((path) => ({ path })),
      content: [],
    };
    const update = (
      status: AcpToolCallStatus,
      extra: Partial<AcpToolCall> = {},
    ) =>
      this.notifyUpdate(session.sessionId, {
        sessionUpdate: "tool_call_update",
        ...call,
        ...extra,
        status,
      });

    this.notifyUpdate(session.sessionId, {
      sessionUpdate: "tool_call",
      ...call,
      status: "in_progress",
    });

    if (this.needsPermission(session, permissionKind, step.askPermission)) {
      update("pending");
      const options: AcpPermissionOption[] = [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ];
      let answer: AcpRequestPermissionResult;
      try {
        answer = await this.requestClient<AcpRequestPermissionResult>(
          ACP_METHODS.sessionRequestPermission,
          {
            sessionId: session.sessionId,
            toolCall: {
              sessionUpdate: "tool_call",
              ...call,
              status: "pending",
            },
            options,
          },
        );
      } catch {
        return { status: "cancelled" };
      }
      if (answer.outcome.outcome === "cancelled" || turn.cancelled) {
        update("failed");
        this.recordTool(session, call, "failed");
        return { status: "cancelled" };
      }
      if (answer.outcome.optionId !== "allow") {
        update("in_progress");
        update("failed");
        this.recordTool(session, call, "failed");
        return { status: "denied" };
      }
      update("in_progress");
    }

    let result: string;
    try {
      result = isMcp
        ? await this.callMcpTool(session.sessionId, serverName, step.tool, args)
        : (step.result ?? "");
    } catch (error) {
      update("failed", {
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: String((error as Error)?.message ?? error),
            },
          },
        ],
      });
      this.recordTool(session, call, "failed");
      return { status: "completed", result: "" };
    }
    const content = [
      { type: "content", content: { type: "text", text: result } },
    ];
    update("completed", { content, rawOutput: result });
    this.recordTool(session, { ...call, content }, "completed");
    return { status: "completed", result };
  }

  private recordTool(
    session: FakeAcpStoredSession,
    call: AcpToolCall,
    status: AcpToolCallStatus,
  ): void {
    session.history.push({ sessionUpdate: "tool_call", ...call, status });
  }

  /** A minimal MCP-over-HTTP client: initialize, then tools/call. */
  private async callMcpTool(
    sessionId: string,
    serverName: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const server = (this.sessionMcpServers.get(sessionId) ?? []).find(
      (candidate) => candidate.name === serverName,
    );
    if (!server || !("url" in server)) {
      throw new Error(`MCP server not configured: ${serverName}`);
    }
    const fetchImpl = this.options.fetch ?? globalThis.fetch;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    for (const header of server.headers ?? [])
      headers[header.name] = header.value;
    const post = async (
      id: number | undefined,
      method: string,
      params: unknown,
    ) => {
      const body = {
        jsonrpc: "2.0",
        method,
        params,
        ...(id === undefined ? {} : { id }),
      };
      const response = await fetchImpl(server.url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (id === undefined) return undefined;
      if (!response.ok)
        throw new Error(`MCP ${method} failed: HTTP ${response.status}`);
      const reply = (await response.json()) as {
        result?: unknown;
        error?: JsonRpcError;
      };
      if (reply.error)
        throw new Error(`MCP ${method} failed: ${reply.error.message}`);
      return reply.result;
    };
    await post(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "fake-acp-agent", version: "0" },
    });
    await post(undefined, "notifications/initialized", {});
    const listed = (await post(3, "tools/list", {})) as {
      tools?: Array<{
        name: string;
        description?: string;
        inputSchema?: unknown;
      }>;
    };
    const callable = eagerMcpToolNames(listed?.tools ?? []);
    const session = this.options.store.get(sessionId);
    if (session) {
      session.callableMcpTools = callable;
      session.mcpToolSchemas = Object.fromEntries(
        (listed?.tools ?? []).map((entry) => [entry.name, entry.inputSchema]),
      );
      this.options.store.put(session);
    }
    // agy never offers the model a tool outside its budget.
    if (!callable.includes(tool)) {
      throw new Error(`MCP tool not callable in agy: ${tool}`);
    }
    const result = (await post(2, "tools/call", {
      name: tool,
      arguments: args,
    })) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text = (result?.content ?? [])
      .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
      .join("");
    if (result?.isError) throw new Error(text || "MCP tool failed");
    return text;
  }
}

/**
 * agy 1.5.10 lets the model call only the MCP tools whose definitions fit
 * about 42 KB per session, filled smallest first, measured as agy stores a
 * tool: `{name, description, parameters}` as JSON (probed 2026-11-18: 20
 * tools of 3,000 bytes gave 14 callable, 20 of 400 bytes gave 20, and a
 * second server got none once the first had filled the budget).
 */
export const AGY_EAGER_MCP_TOOL_BUDGET_BYTES = 42_000;

export function eagerMcpToolNames(
  tools: ReadonlyArray<{
    name: string;
    description?: string;
    inputSchema?: unknown;
  }>,
): string[] {
  const sized = tools
    .map((tool) => ({
      name: tool.name,
      bytes: JSON.stringify({
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.inputSchema ?? {},
      }).length,
    }))
    .sort((a, b) => a.bytes - b.bytes);
  const callable: string[] = [];
  let used = 0;
  for (const tool of sized) {
    if (used + tool.bytes > AGY_EAGER_MCP_TOOL_BUDGET_BYTES) break;
    used += tool.bytes;
    callable.push(tool.name);
  }
  return callable;
}

function toJsonRpcError(error: unknown): JsonRpcError {
  if (
    error &&
    typeof error === "object" &&
    typeof (error as JsonRpcError).code === "number" &&
    typeof (error as JsonRpcError).message === "string"
  ) {
    return error as JsonRpcError;
  }
  return { code: -32603, message: String((error as Error)?.message ?? error) };
}
