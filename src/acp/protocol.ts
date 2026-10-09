/**
 * The Agent Client Protocol (ACP) wire layer.
 *
 * ACP is JSON-RPC 2.0 over newline-delimited stdio: one JSON object per line,
 * no Content-Length framing. Nothing here touches Zotero or a subprocess — the
 * caller supplies the line writer and feeds lines back in — so the framing,
 * correlation and timeouts are exercisable without spawning an agent.
 *
 * Client-to-agent methods implemented here: `initialize`, `session/new`,
 * `session/load`, `session/prompt`, `session/cancel`. Agent-to-client traffic
 * is `session/update` notifications and `session/request_permission` requests;
 * ACP agents do not require the client to serve `fs/*` or `terminal/*`.
 */

export const ACP_PROTOCOL_VERSION = 1;

export type AcpJsonRpcId = number | string;

/** A line the protocol wants written to the agent's stdin. */
export type AcpLineWriter = (line: string) => void;

export type AcpClientInfo = {
  name: string;
  title?: string;
  version: string;
};

export type AcpAgentInfo = {
  name: string;
  title?: string;
  version: string;
};

export type AcpAuthMethod = {
  id?: string;
  name?: string;
  description?: string;
  type?: string;
  args?: string[];
};

export type AcpInitializeResult = {
  protocolVersion: number;
  agentInfo?: Partial<AcpAgentInfo>;
  agentCapabilities?: {
    loadSession?: boolean;
    promptCapabilities?: {
      image?: boolean;
      audio?: boolean;
      embeddedContext?: boolean;
    };
    sessionCapabilities?: {
      fork?: unknown;
      list?: unknown;
      resume?: unknown;
    };
  };
  authMethods?: AcpAuthMethod[];
};

export type AcpSessionModel = {
  modelId: string;
  name?: string;
  description?: string;
};

export type AcpNewSessionResult = {
  sessionId: string;
  models?: {
    currentModelId?: string;
    availableModels?: AcpSessionModel[];
  };
  modes?: {
    currentModeId?: string;
    availableModes?: Array<{ id?: string; name?: string; description?: string }>;
  };
};

export type AcpPromptResult = {
  stopReason?: string;
};

export type AcpPermissionOption = {
  optionId: string;
  name?: string;
  kind?: string;
};

export type AcpPermissionOutcome =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

/** One session plan entry, as `session/update` reports it. */
export type AcpPlanEntry = {
  content: string;
  status?: string;
  priority?: string;
};

/**
 * The `session/update` variants this plugin acts on, normalized to one shape.
 * Anything else is `other`, carried through with its own discriminant so a
 * future variant never has to be guessed at from the wire.
 */
export type AcpSessionUpdate =
  | { kind: "message_chunk"; text: string }
  | { kind: "thought_chunk"; text: string }
  | { kind: "user_chunk"; text: string }
  | {
      kind: "tool_call";
      toolCallId: string;
      title: string;
      status?: string;
      toolKind?: string;
      rawInput?: unknown;
      content?: unknown;
      locations?: unknown;
    }
  | {
      kind: "tool_call_update";
      toolCallId: string;
      title?: string;
      status?: string;
      content?: unknown;
      rawOutput?: unknown;
    }
  | { kind: "plan"; entries: AcpPlanEntry[] }
  | { kind: "available_commands"; names: string[] }
  | { kind: "current_mode"; modeId: string }
  | { kind: "usage"; used?: number; size?: number }
  | { kind: "other"; sessionUpdate: string };

export type AcpSessionUpdatePayload = {
  sessionId: string;
  update: AcpSessionUpdate;
  raw: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => asText(entry)).join("");
  }
  const record = asRecord(value);
  if (!record) return "";
  for (const key of ["text", "content", "delta", "message"]) {
    const text = asText(record[key]);
    if (text) return text;
  }
  return "";
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Reads the `update` object of a `session/update` notification. */
export function parseSessionUpdate(
  params: unknown,
): AcpSessionUpdatePayload | null {
  const record = asRecord(params);
  if (!record) return null;
  const sessionId =
    typeof record.sessionId === "string" ? record.sessionId.trim() : "";
  const update = asRecord(record.update);
  if (!sessionId || !update) return null;
  const discriminant =
    typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
  if (!discriminant) return null;
  const base = { sessionId, raw: params };

  switch (discriminant) {
    case "agent_message_chunk":
      return { ...base, update: { kind: "message_chunk", text: asText(update.content) } };
    case "agent_thought_chunk":
      return { ...base, update: { kind: "thought_chunk", text: asText(update.content) } };
    case "user_message_chunk":
      return { ...base, update: { kind: "user_chunk", text: asText(update.content) } };
    case "tool_call": {
      const toolCallId =
        typeof update.toolCallId === "string" ? update.toolCallId.trim() : "";
      if (!toolCallId) return { ...base, update: { kind: "other", sessionUpdate: discriminant } };
      return {
        ...base,
        update: {
          kind: "tool_call",
          toolCallId,
          title: typeof update.title === "string" ? update.title : "",
          status: typeof update.status === "string" ? update.status : undefined,
          toolKind: typeof update.kind === "string" ? update.kind : undefined,
          rawInput: update.rawInput,
          content: update.content,
          locations: update.locations,
        },
      };
    }
    case "tool_call_update": {
      const toolCallId =
        typeof update.toolCallId === "string" ? update.toolCallId.trim() : "";
      if (!toolCallId) return { ...base, update: { kind: "other", sessionUpdate: discriminant } };
      return {
        ...base,
        update: {
          kind: "tool_call_update",
          toolCallId,
          title: typeof update.title === "string" ? update.title : undefined,
          status: typeof update.status === "string" ? update.status : undefined,
          content: update.content,
          rawOutput: update.rawOutput,
        },
      };
    }
    case "plan": {
      const rawEntries = Array.isArray(update.entries) ? update.entries : [];
      const entries: AcpPlanEntry[] = [];
      for (const raw of rawEntries) {
        const entry = asRecord(raw);
        if (!entry) continue;
        const content = asText(entry.content);
        if (!content) continue;
        entries.push({
          content,
          status: typeof entry.status === "string" ? entry.status : undefined,
          priority: typeof entry.priority === "string" ? entry.priority : undefined,
        });
      }
      return { ...base, update: { kind: "plan", entries } };
    }
    case "available_commands_update": {
      const rawCommands = Array.isArray(update.availableCommands)
        ? update.availableCommands
        : [];
      const names: string[] = [];
      for (const raw of rawCommands) {
        const command = asRecord(raw);
        const name = command ? asText(command.name) : "";
        if (name) names.push(name);
      }
      return { ...base, update: { kind: "available_commands", names } };
    }
    case "current_mode_update":
      return {
        ...base,
        update: {
          kind: "current_mode",
          modeId: typeof update.currentModeId === "string" ? update.currentModeId : "",
        },
      };
    case "usage_update":
      return {
        ...base,
        update: { kind: "usage", used: asNumber(update.used), size: asNumber(update.size) },
      };
    default:
      return { ...base, update: { kind: "other", sessionUpdate: discriminant } };
  }
}

/** Reads `session/request_permission` params into the fields the UI needs. */
export function parsePermissionRequest(params: unknown): {
  sessionId: string;
  toolCallId: string;
  title: string;
  options: AcpPermissionOption[];
} {
  const record = asRecord(params);
  const toolCall = record ? asRecord(record.toolCall) : null;
  const rawOptions = record && Array.isArray(record.options) ? record.options : [];
  const options: AcpPermissionOption[] = [];
  for (const raw of rawOptions) {
    const option = asRecord(raw);
    if (!option) continue;
    const optionId =
      typeof option.optionId === "string" ? option.optionId.trim() : "";
    if (!optionId) continue;
    options.push({
      optionId,
      name: typeof option.name === "string" ? option.name : undefined,
      kind: typeof option.kind === "string" ? option.kind : undefined,
    });
  }
  return {
    sessionId:
      record && typeof record.sessionId === "string" ? record.sessionId : "",
    toolCallId:
      toolCall && typeof toolCall.toolCallId === "string"
        ? toolCall.toolCallId
        : "",
    title: toolCall && typeof toolCall.title === "string" ? toolCall.title : "",
    options,
  };
}

/**
 * The option that refuses an ACP permission request, or undefined when the
 * agent offered no way to refuse (the caller then cancels the request).
 *
 * Refusing is the only safe default: an ACP permission covers the agent's own
 * shell and file access, which this plugin has not asked the user about.
 */
export function pickDenyOption(
  options: readonly AcpPermissionOption[],
): AcpPermissionOption | undefined {
  const byKind = (kind: string) =>
    options.find((option) => option.kind?.trim().toLowerCase() === kind);
  return (
    byKind("reject_once") ??
    byKind("reject_always") ??
    options.find((option) =>
      option.kind?.trim().toLowerCase().startsWith("reject"),
    )
  );
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  method: string;
};

export type AcpRequestHandler = (
  params: unknown,
) => unknown | Promise<unknown>;

type AcpProtocolOptions = {
  /** Milliseconds a request waits for its response; 0 waits forever. */
  requestTimeoutMs?: number;
  onProtocolError?: (error: Error) => void;
};

export const ACP_DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Correlation and framing for one agent process.
 *
 * Every message goes out as exactly one line. A line that is not JSON, or is
 * JSON carrying nothing addressable, is reported and dropped rather than
 * failing the process: an agent that writes a stray line must not take the
 * turn down with it.
 */
export class AcpProtocol {
  private nextId = 1;
  private readonly pendingRequests = new Map<AcpJsonRpcId, PendingRequest>();
  private readonly requestHandlers = new Map<string, AcpRequestHandler>();
  private readonly notificationHandlers = new Map<
    string,
    Set<(params: unknown) => void>
  >();
  private closed = false;

  constructor(
    private readonly writeLine: AcpLineWriter,
    private readonly options: AcpProtocolOptions = {},
  ) {}

  onNotification(
    method: string,
    handler: (params: unknown) => void,
  ): () => void {
    let handlers = this.notificationHandlers.get(method);
    if (!handlers) {
      handlers = new Set();
      this.notificationHandlers.set(method, handlers);
    }
    handlers.add(handler);
    return () => {
      this.notificationHandlers.get(method)?.delete(handler);
    };
  }

  /** Registers the handler that answers an agent-to-client request method. */
  onRequest(method: string, handler: AcpRequestHandler): () => void {
    this.requestHandlers.set(method, handler);
    return () => {
      if (this.requestHandlers.get(method) === handler) {
        this.requestHandlers.delete(method);
      }
    };
  }

  get pendingCount(): number {
    return this.pendingRequests.size;
  }

  request(
    method: string,
    params?: unknown,
    timeoutMs = this.options.requestTimeoutMs ??
      ACP_DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error(`ACP protocol closed (${method})`));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              if (!this.pendingRequests.has(id)) return;
              this.pendingRequests.delete(id);
              reject(
                new Error(`ACP ${method} timed out after ${timeoutMs}ms`),
              );
            }, timeoutMs)
          : null;
      this.pendingRequests.set(id, { resolve, reject, timer, method });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        if (timer) clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    try {
      this.send({ jsonrpc: "2.0", method, params });
    } catch (error) {
      this.report(error);
    }
  }

  /** Feeds one line of the agent's stdout into the protocol. */
  handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      this.report(new Error(`ACP: ignoring non-JSON stdout line: ${trimmed.slice(0, 300)}`));
      return;
    }
    const record = asRecord(message);
    if (!record) return;

    const id = record.id;
    const hasId = typeof id === "number" || typeof id === "string";
    const method = typeof record.method === "string" ? record.method : "";

    if (hasId && !method) {
      this.settleResponse(id as AcpJsonRpcId, record);
      return;
    }
    if (hasId && method) {
      void this.answerRequest(id as AcpJsonRpcId, method, record.params);
      return;
    }
    if (method) {
      const handlers = this.notificationHandlers.get(method);
      if (!handlers) return;
      for (const handler of handlers) {
        try {
          handler(record.params);
        } catch (error) {
          this.report(error);
        }
      }
    }
  }

  /** Fails every in-flight request; called when the agent process is gone. */
  close(error: Error): void {
    this.closed = true;
    for (const [id, pending] of this.pendingRequests) {
      this.pendingRequests.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private settleResponse(
    id: AcpJsonRpcId,
    record: Record<string, unknown>,
  ): void {
    const pending = this.pendingRequests.get(id);
    if (!pending) return;
    this.pendingRequests.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    const errorRecord = asRecord(record.error);
    if (errorRecord) {
      const message = asText(errorRecord.message) || "ACP request failed";
      const data = errorRecord.data;
      pending.reject(
        new Error(
          data === undefined ? message : `${message} (${JSON.stringify(data)})`,
        ),
      );
      return;
    }
    pending.resolve(record.result);
  }

  private async answerRequest(
    id: AcpJsonRpcId,
    method: string,
    params: unknown,
  ): Promise<void> {
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      this.send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not supported: ${method}` },
      });
      return;
    }
    try {
      const result = await handler(params);
      this.send({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (error) {
      this.send({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private send(message: Record<string, unknown>): void {
    this.writeLine(JSON.stringify(message));
  }

  private report(error: unknown): void {
    const normalized =
      error instanceof Error ? error : new Error(String(error));
    this.options.onProtocolError?.(normalized);
  }
}

/** `initialize` params for this plugin as an ACP client. */
export function buildInitializeParams(clientInfo: AcpClientInfo): {
  protocolVersion: number;
  clientCapabilities: { fs: { readTextFile: boolean; writeTextFile: boolean } };
  clientInfo: AcpClientInfo;
} {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    // The plugin reads and writes Zotero items, not the agent's workspace, so
    // it serves none of ACP's filesystem surface.
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    clientInfo,
  };
}

/** `session/new` params. `cwd` is required by the protocol. */
export function buildNewSessionParams(params: {
  cwd: string;
  mcpServers?: unknown[];
}): { cwd: string; mcpServers: unknown[] } {
  return { cwd: params.cwd, mcpServers: params.mcpServers ?? [] };
}

export function buildLoadSessionParams(params: {
  cwd: string;
  sessionId: string;
  mcpServers?: unknown[];
}): { cwd: string; sessionId: string; mcpServers: unknown[] } {
  return {
    cwd: params.cwd,
    sessionId: params.sessionId,
    mcpServers: params.mcpServers ?? [],
  };
}

/** `session/prompt` params: the turn's text as one content block. */
export function buildPromptParams(params: {
  sessionId: string;
  text: string;
}): { sessionId: string; prompt: Array<{ type: "text"; text: string }> } {
  return {
    sessionId: params.sessionId,
    prompt: [{ type: "text", text: params.text }],
  };
}

export function readNewSessionResult(
  result: unknown,
): AcpNewSessionResult | null {
  const record = asRecord(result);
  if (!record) return null;
  const sessionId =
    typeof record.sessionId === "string" ? record.sessionId.trim() : "";
  if (!sessionId) return null;
  const models = asRecord(record.models);
  const rawModels = models && Array.isArray(models.availableModels)
    ? models.availableModels
    : [];
  const availableModels: AcpSessionModel[] = [];
  for (const raw of rawModels) {
    const entry = asRecord(raw);
    const modelId = entry ? asText(entry.modelId) : "";
    if (!modelId) continue;
    availableModels.push({
      modelId,
      name: entry && typeof entry.name === "string" ? entry.name : undefined,
      description:
        entry && typeof entry.description === "string"
          ? entry.description
          : undefined,
    });
  }
  return {
    sessionId,
    models:
      models || availableModels.length
        ? {
            currentModelId:
              models && typeof models.currentModelId === "string"
                ? models.currentModelId
                : undefined,
            availableModels,
          }
        : undefined,
  };
}

export function readInitializeResult(
  result: unknown,
): AcpInitializeResult | null {
  const record = asRecord(result);
  if (!record) return null;
  const protocolVersion = asNumber(record.protocolVersion);
  if (protocolVersion === undefined) return null;
  const capabilities = asRecord(record.agentCapabilities);
  const agentInfo = asRecord(record.agentInfo);
  const promptCapabilities = capabilities
    ? asRecord(capabilities.promptCapabilities)
    : null;
  const sessionCapabilities = capabilities
    ? asRecord(capabilities.sessionCapabilities)
    : null;
  const authMethods = Array.isArray(record.authMethods)
    ? record.authMethods.flatMap((raw) => {
        const entry = asRecord(raw);
        if (!entry) return [];
        return [
          {
            id: typeof entry.id === "string" ? entry.id : undefined,
            name: typeof entry.name === "string" ? entry.name : undefined,
            description:
              typeof entry.description === "string"
                ? entry.description
                : undefined,
            type: typeof entry.type === "string" ? entry.type : undefined,
          },
        ];
      })
    : undefined;
  return {
    protocolVersion,
    agentInfo: agentInfo
      ? {
          name: asText(agentInfo.name),
          title: typeof agentInfo.title === "string" ? agentInfo.title : undefined,
          version: asText(agentInfo.version),
        }
      : undefined,
    agentCapabilities: capabilities
      ? {
          loadSession:
            typeof capabilities.loadSession === "boolean"
              ? capabilities.loadSession
              : undefined,
          promptCapabilities: promptCapabilities
            ? {
                image:
                  typeof promptCapabilities.image === "boolean"
                    ? promptCapabilities.image
                    : undefined,
                audio:
                  typeof promptCapabilities.audio === "boolean"
                    ? promptCapabilities.audio
                    : undefined,
                embeddedContext:
                  typeof promptCapabilities.embeddedContext === "boolean"
                    ? promptCapabilities.embeddedContext
                    : undefined,
              }
            : undefined,
          sessionCapabilities: sessionCapabilities ?? undefined,
        }
      : undefined,
    authMethods,
  };
}
