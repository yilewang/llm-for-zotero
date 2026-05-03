import type {
  ReasoningConfig,
  ReasoningEvent,
  UsageStats,
} from "../shared/llm";
import type {
  CodexAppServerHistoryItem,
  CodexAppServerUserInput,
} from "./codexAppServerInput";
import { getRuntimePlatformInfo } from "./runtimePlatform";
import { getReasoningDefaultLevelForModel } from "./reasoningProfiles";

const DEFAULT_CODEX_APP_SERVER_TURN_TIMEOUT_MS = 300_000;
const DEFAULT_CODEX_APP_SERVER_REQUEST_TIMEOUT_MS = 60_000;
const CODEX_APP_SERVER_STDERR_TAIL_WAIT_MS = 100;
const CODEX_APP_SERVER_DIAGNOSTIC_BUFFER_MAX = 4000;
const CODEX_APP_SERVER_DIAGNOSTIC_BUFFER_TRIM_THRESHOLD = 8000;
const CODEX_ENV_KEYS = [
  "CODEX_PATH",
  "HOME",
  "USERPROFILE",
  "NPM_CONFIG_PREFIX",
  "npm_config_prefix",
  "PREFIX",
  "APPDATA",
  "LOCALAPPDATA",
  "NVM_HOME",
  "NVM_SYMLINK",
  "NVM_DIR",
  "PATH",
  "Path",
];

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

type ActivityHandler = () => void;
type NotificationHandler = (params: unknown) => void;
type RequestHandler = (
  params: unknown,
  id: number,
) => unknown | Promise<unknown>;

export type CodexAppServerItemEvent = {
  id?: string;
  type?: string;
  role?: string;
  status?: string;
  summary?: string;
  details?: string;
  error?: string;
  name?: string;
  toolName?: string;
  title?: string;
  serverName?: string;
  arguments?: unknown;
  raw?: Record<string, unknown>;
};

export type CodexAppServerAgentMessageDeltaEvent = {
  itemId?: string;
  delta: string;
};

export type CodexAppServerInjectItemsSupport =
  | "unknown"
  | "supported"
  | "unsupported";

export type CodexAppServerProcessOptions = {
  codexPath?: string;
};

type CodexLaunchInvocation = {
  command: string;
  args: string[];
  environment?: Record<string, string>;
};

function createAbortError(): Error {
  const err = new Error("Aborted");
  (err as { name?: string }).name = "AbortError";
  return err;
}

export class CodexAppServerProcess {
  private proc: unknown;
  private nextId = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  private activityHandlers = new Set<ActivityHandler>();
  private notificationHandlers = new Map<string, Set<NotificationHandler>>();
  private requestHandlers = new Map<string, Set<RequestHandler>>();
  private closeHandlers = new Set<() => void>();
  private readLoopPromise: Promise<void> | null = null;
  private stderrLoopPromise: Promise<void> | null = null;
  private turnQueue = Promise.resolve();
  private lineBuffer = "";
  private diagnosticBuffer = "";
  private launchDescription = "";
  private destroyed = false;
  private didNotifyClose = false;
  private injectItemsSupport: CodexAppServerInjectItemsSupport = "unknown";

  private constructor(proc: unknown, launchDescription = "") {
    this.proc = proc;
    this.launchDescription = launchDescription;
  }

  static forTest(
    proc: unknown,
    launchDescription = "",
  ): CodexAppServerProcess {
    return new CodexAppServerProcess(proc, launchDescription);
  }

  static async loadSubprocessModule(): Promise<any> {
    const CU = (globalThis as any).ChromeUtils;
    let Subprocess: any;
    if (CU?.importESModule) {
      try {
        const mod = CU.importESModule(
          "resource://gre/modules/Subprocess.sys.mjs",
        );
        Subprocess = mod.Subprocess || mod.default || mod;
      } catch {
        /* fallback */
      }
    }
    if (!Subprocess?.call && CU?.import) {
      try {
        const mod = CU.import("resource://gre/modules/Subprocess.jsm");
        Subprocess = mod.Subprocess || mod;
      } catch {
        /* fallback */
      }
    }
    if (!Subprocess?.call) {
      throw new Error(
        "Subprocess module not available in this Zotero environment",
      );
    }
    return Subprocess;
  }

  static async spawn(
    options: CodexAppServerProcessOptions = {},
  ): Promise<CodexAppServerProcess> {
    const Subprocess = await CodexAppServerProcess.loadSubprocessModule();
    const info = getRuntimePlatformInfo();
    const binary = await resolveCodexBinary(options.codexPath);

    let command: string;
    let args: string[];
    let environment: Record<string, string> | undefined;
    if (info.platform === "windows") {
      const invocation = await buildWindowsCodexInvocation(binary, info);
      command = invocation.command;
      args = invocation.args;
      environment = invocation.environment;
    } else {
      const invocation = await buildPosixCodexInvocation(binary, info);
      command = invocation.command;
      args = invocation.args;
      environment = invocation.environment;
    }

    let proc: any;
    try {
      proc = await Subprocess.call({
        command,
        arguments: args,
        stderr: "pipe",
        ...(environment ? { environment, environmentAppend: true } : {}),
      });
    } catch (err) {
      throw new Error(
        `Failed to spawn codex app-server (command: ${command} ${args.join(" ")}): ${err instanceof Error ? err.message : JSON.stringify(err)}`,
      );
    }

    const instance = new CodexAppServerProcess(
      proc,
      formatLaunchDescription(command, args),
    );
    instance.startReadLoop();
    instance.startStderrReadLoop();
    await instance.initialize();
    return instance;
  }

  private startReadLoop(): void {
    const proc = this.proc as any;
    this.readLoopPromise = (async () => {
      while (!this.destroyed) {
        let chunk: string;
        try {
          chunk = await proc.stdout.readString();
        } catch {
          break;
        }
        if (!chunk) break;
        this.lineBuffer += chunk;
        const lines = this.lineBuffer.split("\n");
        this.lineBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            this.handleMessage(JSON.parse(trimmed));
          } catch {
            this.appendDiagnostic(trimmed);
            Zotero.debug?.(
              `[llm-for-zotero] codex app-server: failed to parse line: ${trimmed}`,
            );
          }
        }
      }
      if (!this.destroyed) {
        await this.waitForStderrTail();
        const diagnostics = this.getDiagnosticTail();
        this.fail(
          new Error(
            `codex app-server process closed unexpectedly${diagnostics ? `: ${diagnostics}` : " with no stderr/stdout diagnostics"}${this.launchDescription ? ` (launched: ${this.launchDescription})` : ""}`,
          ),
          false,
        );
      }
    })();
  }

  private startStderrReadLoop(): void {
    const proc = this.proc as any;
    if (!proc.stderr?.readString) return;
    this.stderrLoopPromise = (async () => {
      while (!this.destroyed) {
        let chunk: string;
        try {
          chunk = await proc.stderr.readString();
        } catch {
          break;
        }
        if (!chunk) break;
        this.appendDiagnostic(chunk);
      }
    })();
  }

  private appendDiagnostic(chunk: string): void {
    this.diagnosticBuffer += `${chunk}\n`;
    if (
      this.diagnosticBuffer.length >
      CODEX_APP_SERVER_DIAGNOSTIC_BUFFER_TRIM_THRESHOLD
    ) {
      this.diagnosticBuffer = this.diagnosticBuffer.slice(
        -CODEX_APP_SERVER_DIAGNOSTIC_BUFFER_MAX,
      );
    }
  }

  private getDiagnosticTail(): string {
    const pendingStdout = this.lineBuffer.trim();
    const combined = `${this.diagnosticBuffer}${pendingStdout ? `\n${pendingStdout}` : ""}`;
    return combined.replace(/\s+/g, " ").trim();
  }

  private async waitForStderrTail(): Promise<void> {
    if (!this.stderrLoopPromise) return;
    await Promise.race([
      this.stderrLoopPromise.catch(() => undefined),
      new Promise<void>((resolve) =>
        setTimeout(resolve, CODEX_APP_SERVER_STDERR_TAIL_WAIT_MS),
      ),
    ]);
  }

  private handleMessage(msg: Record<string, unknown>): void {
    for (const handler of this.activityHandlers) {
      try {
        handler();
      } catch {
        /* ignore */
      }
    }

    if ("id" in msg && msg.id !== null && msg.id !== undefined) {
      const id = msg.id as number;
      const pending = this.pendingRequests.get(id);
      if (pending) {
        this.pendingRequests.delete(id);
        if ("error" in msg) {
          pending.reject(
            new Error(String((msg.error as any)?.message ?? msg.error)),
          );
        } else {
          pending.resolve(msg.result);
        }
        return;
      }

      if (typeof msg.method === "string") {
        const handlers = this.requestHandlers.get(msg.method);
        if (!handlers?.size) {
          try {
            ztoolkit.log("Codex app-server: unhandled server request", {
              method: msg.method,
              params: msg.params,
            });
          } catch {
            /* diagnostics must not affect protocol responses */
          }
          this.writeRawMessage({
            id,
            error: {
              code: -32601,
              message: `No handler registered for ${msg.method}`,
            },
          });
          return;
        }
        const handler = handlers.values().next().value as
          | RequestHandler
          | undefined;
        if (!handler) return;
        Promise.resolve()
          .then(() => handler(msg.params, id))
          .then((result) => {
            this.writeRawMessage({ id, result });
          })
          .catch((error) => {
            this.writeRawMessage({
              id,
              error: {
                code: -32000,
                message: error instanceof Error ? error.message : String(error),
              },
            });
          });
        return;
      }
    } else if (typeof msg.method === "string") {
      const handlers = this.notificationHandlers.get(msg.method);
      if (handlers) {
        for (const handler of handlers) {
          try {
            handler(msg.params);
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  sendRequest(
    method: string,
    params?: unknown,
    timeoutMs = DEFAULT_CODEX_APP_SERVER_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    if (this.destroyed) {
      return Promise.reject(new Error("CodexAppServerProcess destroyed"));
    }
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const pending: PendingRequest = {
        resolve: (value) => {
          if (timeoutId !== null) clearTimeout(timeoutId);
          resolve(value);
        },
        reject: (reason) => {
          if (timeoutId !== null) clearTimeout(timeoutId);
          reject(reason);
        },
      };
      this.pendingRequests.set(id, pending);
      const timeoutId =
        timeoutMs > 0
          ? setTimeout(() => {
              const activePending = this.pendingRequests.get(id);
              if (!activePending) return;
              this.pendingRequests.delete(id);
              const error = new Error(
                `Timed out waiting for codex app-server response to ${method} after ${timeoutMs}ms`,
              );
              activePending.reject(error);
              this.fail(error, true);
            }, timeoutMs)
          : null;
      try {
        this.writeRawMessage({
          method,
          id,
          params,
        });
      } catch (err) {
        if (timeoutId !== null) clearTimeout(timeoutId);
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  sendNotification(method: string, params?: unknown): void {
    if (this.destroyed) return;
    try {
      this.writeRawMessage({
        method,
        params,
      });
    } catch {
      /* ignore if process is gone */
    }
  }

  async runTurnExclusive<T>(callback: () => Promise<T>): Promise<T> {
    const previous = this.turnQueue;
    let release!: () => void;
    this.turnQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      if (this.destroyed) {
        throw new Error("CodexAppServerProcess destroyed");
      }
      return await callback();
    } finally {
      release();
    }
  }

  onNotification(method: string, handler: NotificationHandler): () => void {
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

  onActivity(handler: ActivityHandler): () => void {
    this.activityHandlers.add(handler);
    return () => {
      this.activityHandlers.delete(handler);
    };
  }

  onClose(handler: () => void): () => void {
    if (this.didNotifyClose || this.destroyed) {
      handler();
      return () => {};
    }
    this.closeHandlers.add(handler);
    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  onRequest(method: string, handler: RequestHandler): () => void {
    let handlers = this.requestHandlers.get(method);
    if (!handlers) {
      handlers = new Set();
      this.requestHandlers.set(method, handlers);
    }
    handlers.add(handler);
    return () => {
      this.requestHandlers.get(method)?.delete(handler);
    };
  }

  getInjectItemsSupport(): CodexAppServerInjectItemsSupport {
    return this.injectItemsSupport;
  }

  setInjectItemsSupport(value: CodexAppServerInjectItemsSupport): void {
    this.injectItemsSupport = value;
  }

  private async initialize(): Promise<void> {
    await this.sendRequest("initialize", {
      clientInfo: {
        name: "llm-for-zotero",
        title: "LLM for Zotero",
        version: "1.0",
      },
      capabilities: { experimentalApi: true },
    });
    this.sendNotification("initialized");
  }

  private writeRawMessage(message: Record<string, unknown>): void {
    const msg = JSON.stringify(message) + "\n";
    (this.proc as any).stdin.write(msg);
  }

  destroy(): void {
    this.fail(new Error("CodexAppServerProcess destroyed"), true);
  }

  private fail(error: Error, killProcess: boolean): void {
    if (!this.destroyed) {
      this.destroyed = true;
      for (const [, pending] of this.pendingRequests) {
        pending.reject(error);
      }
      this.pendingRequests.clear();
    }
    if (killProcess) {
      try {
        (this.proc as any).kill();
      } catch {
        /* ignore */
      }
    }
    if (this.didNotifyClose) return;
    this.didNotifyClose = true;
    for (const handler of this.closeHandlers) {
      try {
        handler();
      } catch {
        /* ignore */
      }
    }
    this.closeHandlers.clear();
  }
}

export function isCodexAppServerInjectItemsUnsupportedError(
  error: unknown,
): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  const normalized = message.toLowerCase();
  if (!normalized.includes("thread/inject_items")) return false;
  return (
    normalized.includes("unknown variant") ||
    normalized.includes("expected one of") ||
    normalized.includes("method not found") ||
    normalized.includes("unknown method") ||
    normalized.includes("no handler registered") ||
    normalized.includes("-32601")
  );
}

export function isCodexAppServerThreadStartInstructionsUnsupportedError(
  error: unknown,
): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  const normalized = message.toLowerCase();
  if (
    !normalized.includes("developerinstructions") &&
    !normalized.includes("developer instructions") &&
    !normalized.includes("baseinstructions") &&
    !normalized.includes("base instructions")
  ) {
    return false;
  }
  return (
    normalized.includes("unknown field") ||
    normalized.includes("unknown variant") ||
    normalized.includes("expected one of") ||
    normalized.includes("invalid request") ||
    normalized.includes("invalid params") ||
    normalized.includes("serde")
  );
}

export async function resolveCodexAppServerTurnInputWithFallback(params: {
  proc: CodexAppServerProcess;
  threadId: string;
  historyItemsToInject: CodexAppServerHistoryItem[];
  turnInput: CodexAppServerUserInput[];
  legacyInputFactory: () => Promise<CodexAppServerUserInput[]>;
  logContext: string;
}): Promise<CodexAppServerUserInput[]> {
  const support = params.proc.getInjectItemsSupport();
  if (!params.historyItemsToInject.length) {
    return params.turnInput;
  }
  if (support === "unsupported") {
    return params.legacyInputFactory();
  }

  try {
    await params.proc.sendRequest("thread/inject_items", {
      threadId: params.threadId,
      items: params.historyItemsToInject,
    });
    params.proc.setInjectItemsSupport("supported");
    return params.turnInput;
  } catch (error) {
    if (!isCodexAppServerInjectItemsUnsupportedError(error)) {
      throw error;
    }
    params.proc.setInjectItemsSupport("unsupported");
    ztoolkit.log(
      "Codex app-server: thread/inject_items unsupported; using legacy flattened input",
      { context: params.logContext },
    );
    return params.legacyInputFactory();
  }
}

function extractCodexAppServerId(
  result: unknown,
  nestedKey: "thread" | "turn",
): string {
  if (!result || typeof result !== "object") return "";
  const typed = result as {
    id?: unknown;
    thread?: { id?: unknown };
    turn?: { id?: unknown };
  };
  if (typeof typed.id === "string" && typed.id.trim()) {
    return typed.id.trim();
  }
  const nested = typed[nestedKey];
  if (nested && typeof nested.id === "string" && nested.id.trim()) {
    return nested.id.trim();
  }
  return "";
}

export function extractCodexAppServerThreadId(result: unknown): string {
  return extractCodexAppServerId(result, "thread");
}

export function extractCodexAppServerTurnId(result: unknown): string {
  return extractCodexAppServerId(result, "turn");
}

function normalizeCodexAppServerReasoningLevel(
  reasoning: ReasoningConfig,
  modelName?: string,
): "low" | "medium" | "high" | "xhigh" | null {
  const resolvedLevel =
    reasoning.level === "default"
      ? getReasoningDefaultLevelForModel(reasoning.provider, modelName) ||
        reasoning.level
      : reasoning.level;
  if (resolvedLevel === "minimal") return "low";
  if (resolvedLevel === "low") return "low";
  if (resolvedLevel === "medium") return "medium";
  if (resolvedLevel === "high") return "high";
  if (resolvedLevel === "xhigh") return "xhigh";
  return null;
}

export function resolveCodexAppServerReasoningParams(
  reasoning: ReasoningConfig | undefined,
  modelName?: string,
): { effort?: "low" | "medium" | "high" | "xhigh"; summary?: "detailed" } {
  if (!reasoning) return {};
  const effort = normalizeCodexAppServerReasoningLevel(reasoning, modelName);
  return {
    // OpenAI-backed app-server sessions usually expose readable reasoning only
    // through summary events, so request the richer summary mode explicitly.
    summary: "detailed",
    ...(effort ? { effort } : {}),
  };
}

function normalizeCodexAppServerText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeCodexAppServerText(entry)).join("");
  }
  if (!value || typeof value !== "object") return "";
  const row = value as {
    text?: unknown;
    content?: unknown;
    summary?: unknown;
    reasoning?: unknown;
    message?: unknown;
  };
  return (
    normalizeCodexAppServerText(row.text) ||
    normalizeCodexAppServerText(row.content) ||
    normalizeCodexAppServerText(row.summary) ||
    normalizeCodexAppServerText(row.reasoning) ||
    normalizeCodexAppServerText(row.message) ||
    ""
  );
}

function normalizeCodexAppServerFieldText(
  value: unknown,
  maxLength = 240,
): string | undefined {
  const text = normalizeCodexAppServerText(value).replace(/\s+/g, " ").trim();
  return text ? text.slice(0, maxLength) : undefined;
}

function readCodexAppServerObjectName(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return normalizeCodexAppServerFieldText(value);
  }
  const record = value as Record<string, unknown>;
  return (
    normalizeCodexAppServerFieldText(record.name) ||
    normalizeCodexAppServerFieldText(record.toolName) ||
    normalizeCodexAppServerFieldText(record.title) ||
    normalizeCodexAppServerFieldText(record.id)
  );
}

function copyCodexAppServerRawMetadata(
  source: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const keys = [
    "id",
    "type",
    "role",
    "status",
    "name",
    "tool",
    "toolName",
    "tool_name",
    "title",
    "server",
    "serverName",
    "server_name",
    "mcpServerName",
    "arguments",
    "args",
    "input",
    "error",
  ];
  const raw: Record<string, unknown> = {};
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    raw[key] = source[key];
  }
  return Object.keys(raw).length ? raw : undefined;
}

function extractCodexAppServerItem(
  rawParams: unknown,
): CodexAppServerItemEvent | null {
  if (!rawParams || typeof rawParams !== "object") return null;
  const source =
    rawParams &&
    typeof (rawParams as { item?: unknown }).item === "object" &&
    (rawParams as { item?: unknown }).item
      ? (rawParams as { item: unknown }).item
      : rawParams;
  if (!source || typeof source !== "object") return null;
  const sourceRecord = source as Record<string, unknown>;
  const item = source as {
    id?: unknown;
    type?: unknown;
    role?: unknown;
    status?: unknown;
    summary?: unknown;
    content?: unknown;
    text?: unknown;
    reasoning?: unknown;
    error?: unknown;
    name?: unknown;
    tool?: unknown;
    toolName?: unknown;
    tool_name?: unknown;
    title?: unknown;
    server?: unknown;
    serverName?: unknown;
    server_name?: unknown;
    mcpServerName?: unknown;
    arguments?: unknown;
    args?: unknown;
    input?: unknown;
  };
  const status = typeof item.status === "string" ? item.status.trim() : "";
  return {
    id:
      typeof item.id === "string" && item.id.trim()
        ? item.id.trim()
        : undefined,
    type:
      typeof item.type === "string" && item.type.trim()
        ? item.type.trim().toLowerCase()
        : undefined,
    role:
      typeof item.role === "string" && item.role.trim()
        ? item.role.trim().toLowerCase()
        : undefined,
    status: status || undefined,
    summary: normalizeCodexAppServerText(item.summary) || undefined,
    details:
      normalizeCodexAppServerText(item.content) ||
      normalizeCodexAppServerText(item.reasoning) ||
      normalizeCodexAppServerText(item.text) ||
      undefined,
    error:
      normalizeCodexAppServerFieldText(item.error, 500) ||
      normalizeCodexAppServerFieldText(
        item.error && typeof item.error === "object"
          ? (item.error as Record<string, unknown>).message
          : undefined,
        500,
      ),
    name: normalizeCodexAppServerFieldText(item.name),
    toolName:
      readCodexAppServerObjectName(item.toolName) ||
      readCodexAppServerObjectName(item.tool_name) ||
      readCodexAppServerObjectName(item.tool),
    title: normalizeCodexAppServerFieldText(item.title),
    serverName:
      readCodexAppServerObjectName(item.serverName) ||
      readCodexAppServerObjectName(item.server_name) ||
      readCodexAppServerObjectName(item.mcpServerName) ||
      readCodexAppServerObjectName(item.server),
    arguments: item.arguments ?? item.args ?? item.input,
    raw: copyCodexAppServerRawMetadata(sourceRecord),
  };
}

function extractCodexAppServerMessageItemId(rawParams: unknown): string {
  if (!rawParams || typeof rawParams !== "object") return "";
  const source =
    rawParams &&
    typeof (rawParams as { item?: unknown }).item === "object" &&
    (rawParams as { item?: unknown }).item
      ? (rawParams as { item: unknown }).item
      : rawParams;
  if (!source || typeof source !== "object") return "";
  const typed = source as {
    itemId?: unknown;
    messageId?: unknown;
    outputItemId?: unknown;
    id?: unknown;
    message?: { id?: unknown };
  };
  for (const value of [
    typed.itemId,
    typed.messageId,
    typed.outputItemId,
    typed.id,
    typed.message?.id,
  ]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function isCodexAppServerAgentMessageItem(item: {
  type?: string;
  role?: string;
}): boolean {
  const normalized = (item.type || "").replace(/[-_\s]+/g, "").toLowerCase();
  const role = (item.role || "").replace(/[-_\s]+/g, "").toLowerCase();
  return (
    normalized === "agentmessage" ||
    normalized === "assistantmessage" ||
    (normalized === "message" && (role === "assistant" || role === "agent"))
  );
}

function extractCodexAppServerNotificationTurnId(rawParams: unknown): string {
  if (!rawParams || typeof rawParams !== "object") return "";
  const typed = rawParams as {
    turnId?: unknown;
    turn?: { id?: unknown };
  };
  if (typeof typed.turnId === "string" && typed.turnId.trim()) {
    return typed.turnId.trim();
  }
  if (typeof typed.turn?.id === "string" && typed.turn.id.trim()) {
    return typed.turn.id.trim();
  }
  return "";
}

export function waitForCodexAppServerTurnCompletion(params: {
  proc: CodexAppServerProcess;
  turnId: string;
  threadId?: string;
  onTextDelta?: (delta: string) => void | Promise<void>;
  onReasoning?: (event: ReasoningEvent) => void | Promise<void>;
  onUsage?: (usage: UsageStats) => void | Promise<void>;
  onAgentMessageDelta?: (
    event: CodexAppServerAgentMessageDeltaEvent,
  ) => void | Promise<void>;
  onItemStarted?: (event: CodexAppServerItemEvent) => void | Promise<void>;
  onItemCompleted?: (event: CodexAppServerItemEvent) => void | Promise<void>;
  onTurnCompleted?: (event: {
    turnId: string;
    status?: string;
  }) => void | Promise<void>;
  signal?: AbortSignal;
  interruptOnAbort?: boolean;
  cacheKey?: string;
  processOptions?: CodexAppServerProcessOptions;
  timeoutMs?: number;
}): Promise<string> {
  const {
    proc,
    turnId,
    onTextDelta,
    onReasoning,
    onUsage,
    onAgentMessageDelta,
    onItemStarted,
    onItemCompleted,
    onTurnCompleted,
    signal,
    cacheKey,
  } = params;
  const timeoutMs =
    params.timeoutMs ?? DEFAULT_CODEX_APP_SERVER_TURN_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let accumulated = "";
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let lastEmittedUsageTotals: UsageStats | null = null;
    let lastMessageItemId = "";
    const messageTextByItemId = new Map<string, string>();
    const getResolvedMessageText = () => {
      if (lastMessageItemId) {
        const text = messageTextByItemId.get(lastMessageItemId);
        if (typeof text === "string") return text;
      }
      return accumulated;
    };
    const reasoningState = new Map<
      string,
      { sawSummaryDelta: boolean; sawDetailsDelta: boolean }
    >();
    const getReasoningState = (itemId: string) => {
      let state = reasoningState.get(itemId);
      if (!state) {
        state = { sawSummaryDelta: false, sawDetailsDelta: false };
        reasoningState.set(itemId, state);
      }
      return state;
    };
    const emitReasoning = (event: ReasoningEvent) => {
      const summary =
        typeof event.summary === "string" && event.summary.length > 0
          ? event.summary
          : undefined;
      const details =
        typeof event.details === "string" && event.details.length > 0
          ? event.details
          : undefined;
      const stepId =
        typeof event.stepId === "string" && event.stepId.trim()
          ? event.stepId.trim()
          : undefined;
      const stepLabel =
        typeof event.stepLabel === "string" && event.stepLabel.trim()
          ? event.stepLabel.trim()
          : undefined;
      if (!summary && !details) return;
      Promise.resolve(
        onReasoning?.({
          summary,
          details,
          ...(stepId ? { stepId } : {}),
          ...(stepLabel ? { stepLabel } : {}),
        }),
      ).catch(() => {
        // Ignore downstream consumer errors so the transport can finish cleanly.
      });
    };
    const emitUsage = (usage: UsageStats) => {
      const nextUsage: UsageStats = {
        promptTokens: Math.max(0, usage.promptTokens || 0),
        completionTokens: Math.max(0, usage.completionTokens || 0),
        totalTokens: Math.max(0, usage.totalTokens || 0),
      };
      if (lastEmittedUsageTotals) {
        const deltaPrompt = Math.max(
          0,
          nextUsage.promptTokens - lastEmittedUsageTotals.promptTokens,
        );
        const deltaCompletion = Math.max(
          0,
          nextUsage.completionTokens - lastEmittedUsageTotals.completionTokens,
        );
        const deltaTotal = Math.max(
          0,
          nextUsage.totalTokens - lastEmittedUsageTotals.totalTokens,
        );
        lastEmittedUsageTotals = nextUsage;
        if (deltaTotal <= 0) return;
        Promise.resolve(
          onUsage?.({
            promptTokens: deltaPrompt,
            completionTokens: deltaCompletion,
            totalTokens: deltaTotal,
          }),
        ).catch(() => {
          // Ignore downstream consumer errors so the transport can finish cleanly.
        });
        return;
      }
      lastEmittedUsageTotals = nextUsage;
      if (nextUsage.totalTokens <= 0) return;
      Promise.resolve(onUsage?.(nextUsage)).catch(() => {
        // Ignore downstream consumer errors so the transport can finish cleanly.
      });
    };
    const scheduleTimeout = () => {
      if (timeoutMs <= 0 || settled) return;
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      timeoutId = setTimeout(() => {
        if (cacheKey) {
          destroyCachedCodexAppServerProcess(
            cacheKey,
            proc,
            params.processOptions,
          );
        }
        settle(() =>
          reject(
            new Error(
              `Timed out waiting for codex app-server turn completion after ${timeoutMs}ms`,
            ),
          ),
        );
      }, timeoutMs);
    };
    const abortHandler = () => {
      if (params.interruptOnAbort && params.threadId) {
        void proc
          .sendRequest(
            "turn/interrupt",
            { threadId: params.threadId, turnId },
            5000,
          )
          .catch((error) => {
            ztoolkit.log(
              "Codex app-server: turn/interrupt failed; destroying process",
              error,
            );
            if (cacheKey) {
              destroyCachedCodexAppServerProcess(
                cacheKey,
                proc,
                params.processOptions,
              );
            }
          });
      } else if (cacheKey) {
        destroyCachedCodexAppServerProcess(
          cacheKey,
          proc,
          params.processOptions,
        );
      }
      settle(() => reject(createAbortError()));
    };

    function settle(fn: () => void) {
      if (settled) return;
      settled = true;
      unsubActivity();
      unsubDelta();
      unsubReasoningSummary();
      unsubReasoningDetails();
      unsubUsage();
      unsubItemStarted();
      unsubItemCompleted();
      unsubCompleted();
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      signal?.removeEventListener("abort", abortHandler);
      fn();
    }

    const unsubActivity = proc.onActivity(() => {
      scheduleTimeout();
    });
    scheduleTimeout();

    const unsubDelta = proc.onNotification(
      "item/agentMessage/delta",
      (rawParams: unknown) => {
        const eventTurnId = extractCodexAppServerNotificationTurnId(rawParams);
        if (eventTurnId && eventTurnId !== turnId) return;
        const notification = rawParams as { delta?: unknown; text?: unknown };
        const delta = normalizeCodexAppServerText(
          notification.delta ?? notification.text,
        );
        if (!delta) return;
        const itemId = extractCodexAppServerMessageItemId(rawParams);
        accumulated += delta;
        if (itemId) {
          lastMessageItemId = itemId;
          messageTextByItemId.set(
            itemId,
            `${messageTextByItemId.get(itemId) || ""}${delta}`,
          );
          if (onAgentMessageDelta) {
            Promise.resolve(onAgentMessageDelta({ itemId, delta })).catch(
              () => {
                // Ignore downstream consumer errors so the transport can finish cleanly.
              },
            );
            return;
          }
        } else {
          lastMessageItemId = "";
        }
        try {
          onTextDelta?.(delta);
        } catch {
          // Ignore downstream consumer errors so the transport can finish cleanly.
        }
      },
    );

    const unsubReasoningSummary = proc.onNotification(
      "item/reasoning/summaryTextDelta",
      (rawParams: unknown) => {
        const eventTurnId = extractCodexAppServerNotificationTurnId(rawParams);
        if (eventTurnId && eventTurnId !== turnId) return;
        const notification = rawParams as {
          itemId?: unknown;
          delta?: unknown;
          text?: unknown;
        };
        const summary = normalizeCodexAppServerText(
          notification.delta ?? notification.text,
        );
        if (!summary) return;
        const itemId =
          typeof notification.itemId === "string" && notification.itemId.trim()
            ? notification.itemId.trim()
            : undefined;
        if (itemId) {
          getReasoningState(itemId).sawSummaryDelta = true;
        }
        emitReasoning({ summary, stepId: itemId });
      },
    );

    const unsubReasoningDetails = proc.onNotification(
      "item/reasoning/textDelta",
      (rawParams: unknown) => {
        const eventTurnId = extractCodexAppServerNotificationTurnId(rawParams);
        if (eventTurnId && eventTurnId !== turnId) return;
        const notification = rawParams as {
          itemId?: unknown;
          delta?: unknown;
          text?: unknown;
        };
        const details = normalizeCodexAppServerText(
          notification.delta ?? notification.text,
        );
        if (!details) return;
        const itemId =
          typeof notification.itemId === "string" && notification.itemId.trim()
            ? notification.itemId.trim()
            : undefined;
        if (itemId) {
          getReasoningState(itemId).sawDetailsDelta = true;
        }
        emitReasoning({ details, stepId: itemId });
      },
    );

    const unsubUsage = proc.onNotification(
      "thread/tokenUsage/updated",
      (rawParams: unknown) => {
        const eventTurnId = extractCodexAppServerNotificationTurnId(rawParams);
        if (eventTurnId && eventTurnId !== turnId) return;
        const notification = rawParams as {
          turnId?: unknown;
          tokenUsage?: {
            last?: {
              totalTokens?: unknown;
              inputTokens?: unknown;
              outputTokens?: unknown;
            };
            total?: {
              totalTokens?: unknown;
              inputTokens?: unknown;
              outputTokens?: unknown;
            };
          };
        };
        const usage =
          notification.tokenUsage?.total || notification.tokenUsage?.last;
        if (!usage) return;
        const totalTokens =
          typeof usage.totalTokens === "number" ? usage.totalTokens : 0;
        const promptTokens =
          typeof usage.inputTokens === "number" ? usage.inputTokens : 0;
        const completionTokens =
          typeof usage.outputTokens === "number" ? usage.outputTokens : 0;
        if (totalTokens <= 0) return;
        emitUsage({
          promptTokens,
          completionTokens,
          totalTokens,
        });
      },
    );

    const unsubItemStarted = proc.onNotification(
      "item/started",
      (rawParams: unknown) => {
        const eventTurnId = extractCodexAppServerNotificationTurnId(rawParams);
        if (eventTurnId && eventTurnId !== turnId) return;
        const item = extractCodexAppServerItem(rawParams);
        if (!item) return;
        Promise.resolve(onItemStarted?.(item)).catch(() => {
          // Ignore downstream consumer errors so the transport can finish cleanly.
        });
      },
    );

    const unsubItemCompleted = proc.onNotification(
      "item/completed",
      (rawParams: unknown) => {
        const eventTurnId = extractCodexAppServerNotificationTurnId(rawParams);
        if (eventTurnId && eventTurnId !== turnId) return;
        const item = extractCodexAppServerItem(rawParams);
        if (!item) return;
        Promise.resolve(onItemCompleted?.(item)).catch(() => {
          // Ignore downstream consumer errors so the transport can finish cleanly.
        });
        if (isCodexAppServerAgentMessageItem(item)) {
          const text = item.details || item.summary || "";
          if (text && item.id) {
            lastMessageItemId = item.id;
            messageTextByItemId.set(item.id, text);
          }
          return;
        }
        if (item.type !== "reasoning") return;
        const state = item.id ? getReasoningState(item.id) : undefined;
        if (item.summary && !state?.sawSummaryDelta) {
          emitReasoning({ summary: item.summary, stepId: item.id });
        }
        if (item.details && !state?.sawDetailsDelta) {
          emitReasoning({ details: item.details, stepId: item.id });
        }
      },
    );

    const unsubCompleted = proc.onNotification(
      "turn/completed",
      (rawParams: unknown) => {
        const notification = rawParams as {
          turn?: { id?: string; status?: string };
          turnId?: string;
          status?: string;
        };
        const completedTurnId =
          typeof notification.turn?.id === "string"
            ? notification.turn.id
            : typeof notification.turnId === "string"
              ? notification.turnId
              : "";
        if (completedTurnId !== turnId) return;
        const status =
          typeof notification.turn?.status === "string"
            ? notification.turn.status
            : typeof notification.status === "string"
              ? notification.status
              : undefined;
        Promise.resolve(
          onTurnCompleted?.({ turnId: completedTurnId, status }),
        ).catch(() => {
          // Ignore downstream consumer errors so the transport can finish cleanly.
        });
        if (status === "completed") {
          settle(() => resolve(getResolvedMessageText()));
          return;
        }
        settle(() =>
          reject(new Error(`Turn ended with status: ${status ?? "unknown"}`)),
        );
      },
    );

    signal?.addEventListener("abort", abortHandler, { once: true });
  });
}

function getNonEmptyEnvValue(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const value = env[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getRuntimeEnvValue(key: string): string | undefined {
  const processValue = (globalThis as any).process?.env?.[key];
  if (typeof processValue === "string" && processValue.trim()) {
    return processValue.trim();
  }
  try {
    const servicesValue = (globalThis as any).Services?.env?.get?.(key);
    if (typeof servicesValue === "string" && servicesValue.trim()) {
      return servicesValue.trim();
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function getCodexRuntimeEnv(): Record<string, string | undefined> {
  const processEnv = (globalThis as any).process?.env ?? {};
  const env: Record<string, string | undefined> = { ...processEnv };
  for (const key of CODEX_ENV_KEYS) {
    env[key] = getRuntimeEnvValue(key);
  }
  return env;
}

function joinRuntimePath(
  separator: "/" | "\\",
  base: string,
  ...parts: string[]
): string {
  let current = base.replace(/[\\/]+$/, "");
  for (const part of parts) {
    const normalized = part.replace(/^[\\/]+|[\\/]+$/g, "");
    if (!normalized) continue;
    current = current ? `${current}${separator}${normalized}` : normalized;
  }
  return current;
}

function resolveListedChildPath(
  separator: "/" | "\\",
  parent: string,
  child: string,
): string {
  const trimmed = child.trim();
  if (!trimmed) return trimmed;
  if (
    trimmed.startsWith(parent) ||
    trimmed.includes(separator) ||
    (separator === "\\" && /^[a-z]:\\/i.test(trimmed))
  ) {
    return trimmed;
  }
  return joinRuntimePath(separator, parent, trimmed);
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    const normalized = path.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

async function pathExists(path: string): Promise<boolean> {
  const IOUtils = (globalThis as any).IOUtils;
  if (IOUtils?.exists) {
    try {
      return Boolean(await IOUtils.exists(path));
    } catch {
      return false;
    }
  }
  const OSFile = (globalThis as any).OS?.File;
  if (OSFile?.exists) {
    try {
      return Boolean(await OSFile.exists(path));
    } catch {
      return false;
    }
  }
  return false;
}

async function readSubprocessStdout(proc: any): Promise<string> {
  return readSubprocessString(proc.stdout);
}

async function readSubprocessString(stream: any): Promise<string> {
  let out = "";
  try {
    while (true) {
      const chunk = await stream?.readString?.();
      if (!chunk) break;
      out += chunk;
    }
  } catch {
    /* ignore */
  }
  return out;
}

async function waitForSubprocessExitCode(
  proc: any,
): Promise<number | undefined> {
  try {
    const result = await proc.wait?.();
    const exitCode = result?.exitCode;
    return typeof exitCode === "number" ? exitCode : undefined;
  } catch {
    return undefined;
  }
}

async function listChildren(path: string): Promise<string[]> {
  const IOUtils = (globalThis as any).IOUtils;
  if (!IOUtils?.getChildren) return [];
  try {
    const children = await IOUtils.getChildren(path);
    return Array.isArray(children)
      ? children.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function buildPrefixCodexCandidates(params: {
  prefix: string;
  platform: "windows" | "macos" | "linux";
  separator: "/" | "\\";
}): string[] {
  const prefix = params.prefix.trim();
  if (!prefix) return [];
  if (params.platform === "windows") {
    return [
      joinRuntimePath(params.separator, prefix, "codex.cmd"),
      joinRuntimePath(params.separator, prefix, "codex.exe"),
      joinRuntimePath(params.separator, prefix, "bin", "codex.cmd"),
      joinRuntimePath(params.separator, prefix, "bin", "codex.exe"),
    ];
  }
  return [
    joinRuntimePath(params.separator, prefix, "bin", "codex"),
    joinRuntimePath(params.separator, prefix, "codex"),
  ];
}

function buildWindowsShellCommand(binary: string): string {
  return /\s/.test(binary)
    ? `""${binary}" app-server"`
    : `${binary} app-server`;
}

function splitWindowsCommandLine(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] || "";
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function isWslAbsolutePath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//");
}

function isUnsupportedWindowsWslCodexReference(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("wsl:codex:")) return true;
  if (isWslAbsolutePath(trimmed)) return true;
  const command = splitWindowsCommandLine(trimmed)[0] || "";
  return /(^|[\\/])wsl(?:\.exe)?$/i.test(command);
}

function createWindowsWslCodexUnsupportedError(): Error {
  return new Error(
    "WSL Codex is not supported on Windows for Zotero Codex App Server. Zotero MCP uses Windows-local loopback, so install native Windows Codex, run `codex login` from PowerShell or Command Prompt, and leave the Codex path blank or set it to a native path such as C:\\Users\\<user>\\AppData\\Roaming\\npm\\codex.cmd.",
  );
}

function formatLaunchDescription(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

function getPathDirectory(path: string): string {
  const index = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  if (index < 0) return "";
  return path.slice(0, index) || "/";
}

function getWindowsDirectory(path: string): string {
  return getPathDirectory(path);
}

async function buildWindowsCodexInvocation(
  binary: string,
  info: ReturnType<typeof getRuntimePlatformInfo>,
): Promise<CodexLaunchInvocation> {
  if (isUnsupportedWindowsWslCodexReference(binary)) {
    throw createWindowsWslCodexUnsupportedError();
  }

  const directory = getWindowsDirectory(binary);
  if (directory && /\.cmd$/i.test(binary)) {
    const nativeInvocation =
      await resolveWindowsNpmNativeCodexInvocation(directory);
    if (nativeInvocation) return nativeInvocation;

    const nodePath = joinRuntimePath("\\", directory, "node.exe");
    const codexJsPath = getWindowsNpmCodexJsPath(directory);
    if ((await pathExists(nodePath)) && (await pathExists(codexJsPath))) {
      return {
        command: nodePath,
        args: [codexJsPath, "app-server"],
      };
    }
  }

  if (/\.(exe|com)$/i.test(binary)) {
    return {
      command: binary,
      args: ["app-server"],
    };
  }

  // npm shims are usually batch scripts, and bare `codex` needs PATHEXT lookup.
  return {
    command: info.shellPath,
    args: ["/d", "/s", info.shellFlag, buildWindowsShellCommand(binary)],
  };
}

async function buildPosixCodexInvocation(
  binary: string,
  info: ReturnType<typeof getRuntimePlatformInfo>,
): Promise<CodexLaunchInvocation> {
  const env = getCodexRuntimeEnv();
  const homeDir = getNonEmptyEnvValue(env, "HOME") || "";
  const prefixCandidates = uniquePaths(
    [
      getNonEmptyEnvValue(env, "NPM_CONFIG_PREFIX"),
      getNonEmptyEnvValue(env, "npm_config_prefix"),
      getNonEmptyEnvValue(env, "PREFIX"),
    ]
      .filter((entry): entry is string => Boolean(entry))
      .flatMap((prefix) =>
        buildPrefixCodexCandidates({
          prefix,
          platform: info.platform,
          separator: "/",
        }),
      ),
  );
  const nvmCandidates = homeDir
    ? await listNvmCodexCandidates({
        homeDir,
        nvmDir: getNonEmptyEnvValue(env, "NVM_DIR"),
        separator: "/",
      })
    : [];
  const pathEntries = uniquePaths([
    getPathDirectory(binary),
    ...prefixCandidates.map(getPathDirectory),
    homeDir ? joinRuntimePath("/", homeDir, ".cargo", "bin") : "",
    homeDir ? joinRuntimePath("/", homeDir, ".npm-global", "bin") : "",
    homeDir ? joinRuntimePath("/", homeDir, ".local", "bin") : "",
    homeDir ? joinRuntimePath("/", homeDir, ".volta", "bin") : "",
    homeDir ? joinRuntimePath("/", homeDir, ".asdf", "shims") : "",
    ...nvmCandidates.map(getPathDirectory),
    ...(info.platform === "macos" ? ["/opt/homebrew/bin"] : []),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ]);
  const inheritedPath = getNonEmptyEnvValue(env, "PATH") || "";
  const path = uniquePaths([...pathEntries, ...inheritedPath.split(":")]).join(
    ":",
  );
  return {
    command: binary,
    args: ["app-server"],
    ...(path ? { environment: { PATH: path } } : {}),
  };
}

function getWindowsNpmCodexJsPath(directory: string): string {
  return joinRuntimePath(
    "\\",
    directory,
    "node_modules",
    "@openai",
    "codex",
    "bin",
    "codex.js",
  );
}

async function resolveWindowsNpmNativeCodexInvocation(
  directory: string,
): Promise<{
  command: string;
  args: string[];
  environment?: Record<string, string>;
} | null> {
  const codexPackageRoot = joinRuntimePath(
    "\\",
    directory,
    "node_modules",
    "@openai",
    "codex",
  );
  const targetTriple = "x86_64-pc-windows-msvc";
  const nativeRoots = [
    joinRuntimePath(
      "\\",
      codexPackageRoot,
      "node_modules",
      "@openai",
      "codex-win32-x64",
      "vendor",
      targetTriple,
    ),
    joinRuntimePath("\\", codexPackageRoot, "vendor", targetTriple),
  ];

  for (const nativeRoot of nativeRoots) {
    const nativeBinary = joinRuntimePath(
      "\\",
      nativeRoot,
      "codex",
      "codex.exe",
    );
    if (!(await pathExists(nativeBinary))) continue;

    const pathDir = joinRuntimePath("\\", nativeRoot, "path");
    const runtimePath =
      getRuntimeEnvValue("PATH") || getRuntimeEnvValue("Path") || "";
    const environment: Record<string, string> = {
      CODEX_MANAGED_BY_NPM: "1",
    };
    if (await pathExists(pathDir)) {
      environment.PATH = runtimePath ? `${pathDir};${runtimePath}` : pathDir;
    }
    return {
      command: nativeBinary,
      args: ["app-server"],
      environment,
    };
  }

  return null;
}

function buildWindowsCodexCandidates(
  env: Record<string, string | undefined>,
): string[] {
  const userProfile = getNonEmptyEnvValue(env, "USERPROFILE");
  // Fall back to %USERPROFILE%\AppData\... when APPDATA / LOCALAPPDATA are
  // missing (some sandboxed runtimes drop them) — but only when USERPROFILE
  // is real, so we never fabricate a fake user name.
  const appData =
    getNonEmptyEnvValue(env, "APPDATA") ??
    (userProfile
      ? joinRuntimePath("\\", userProfile, "AppData", "Roaming")
      : undefined);
  const localAppData =
    getNonEmptyEnvValue(env, "LOCALAPPDATA") ??
    (userProfile
      ? joinRuntimePath("\\", userProfile, "AppData", "Local")
      : undefined);
  const nvmHome = getNonEmptyEnvValue(env, "NVM_HOME");
  const nvmSymlink = getNonEmptyEnvValue(env, "NVM_SYMLINK");
  const candidates: string[] = [];

  if (userProfile) {
    candidates.push(
      joinRuntimePath("\\", userProfile, ".cargo", "bin", "codex.exe"),
    );
  }
  if (appData) {
    candidates.push(
      joinRuntimePath("\\", appData, "npm", "codex.cmd"),
      joinRuntimePath("\\", appData, "npm", "codex.exe"),
    );
  }
  if (localAppData) {
    candidates.push(
      joinRuntimePath("\\", localAppData, "Volta", "bin", "codex.cmd"),
      joinRuntimePath("\\", localAppData, "Volta", "bin", "codex.exe"),
    );
  }
  for (const nvmRoot of [nvmSymlink, nvmHome]) {
    if (!nvmRoot) continue;
    candidates.push(
      joinRuntimePath("\\", nvmRoot, "codex.cmd"),
      joinRuntimePath("\\", nvmRoot, "codex.exe"),
      joinRuntimePath("\\", nvmRoot, "codex"),
    );
  }
  candidates.push("C:\\Program Files\\codex\\codex.exe");
  return uniquePaths(candidates);
}

export async function listNvmCodexCandidates(params: {
  homeDir: string;
  nvmDir?: string;
  separator: "/";
}): Promise<string[]> {
  const root =
    params.nvmDir?.trim() || joinRuntimePath("/", params.homeDir, ".nvm");
  const versionsDir = joinRuntimePath(
    params.separator,
    root,
    "versions",
    "node",
  );
  const versionDirs = await listChildren(versionsDir);
  return versionDirs
    .map((entry) =>
      resolveListedChildPath(params.separator, versionsDir, entry),
    )
    .sort((a, b) => b.localeCompare(a))
    .map((versionDir) =>
      joinRuntimePath(params.separator, versionDir, "bin", "codex"),
    );
}

export function resolveCodexAppServerBinaryPath(
  value?: string | null,
): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return undefined;
  if (/^https?:\/\//i.test(trimmed)) return undefined;
  const quoted = trimmed.match(/^(['"])(.*)\1$/);
  if (quoted?.[2]?.trim()) return quoted[2].trim();
  return trimmed;
}

export function selectCodexLookupResult(
  output: string,
  platform: "windows" | "macos" | "linux",
): string {
  const candidates = output
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const first = candidates[0] || "";
  if (platform !== "windows" || !first) return first;
  // Preserve PATH precedence: only swap to a same-directory `.cmd` sibling
  // (e.g. when `where codex` lists `…\codex` and `…\codex.cmd` for the same
  // npm shim, the `.cmd` is the one we know how to dispatch through the
  // npm-native fast path). Never jump to a `.cmd` from a different install
  // that sits later on PATH.
  if (/\.cmd$/i.test(first)) return first;
  const firstDir = getWindowsDirectory(first).toLowerCase();
  const sameDirCmd = candidates.find(
    (candidate) =>
      /\.cmd$/i.test(candidate) &&
      getWindowsDirectory(candidate).toLowerCase() === firstDir,
  );
  return sameDirCmd || first;
}

function createCodexBinaryNotFoundError(
  platform: "windows" | "macos" | "linux",
) {
  const windowsHint =
    platform === "windows"
      ? " On Windows, only native Windows Codex is supported because Zotero MCP uses Windows-local loopback; install Codex from PowerShell or Command Prompt and run `codex login` there. WSL Codex is not supported."
      : "";
  return new Error(
    "codex binary not found. Install Codex CLI (https://github.com/openai/codex) and ensure it is on your PATH, " +
      "or set the CODEX_PATH environment variable to the absolute path of the codex executable." +
      windowsHint,
  );
}

function isWindowsPathLike(path: string): boolean {
  return (
    /^[a-z]:[\\/]/i.test(path) || path.includes("\\") || path.includes("/")
  );
}

async function resolveWindowsCodexShimPath(path: string): Promise<string> {
  if (!isWindowsPathLike(path)) return path;

  const ps1Match = path.match(/\.ps1$/i);
  const extensionlessMatch = path.match(/[\\/]codex$/i);
  if (!ps1Match && !extensionlessMatch) return path;

  const base = ps1Match ? path.slice(0, -4) : path;
  for (const candidate of [`${base}.cmd`, `${base}.exe`]) {
    if (await pathExists(candidate)) return candidate;
  }
  return path;
}

async function resolveCodexBinaryFromShellPathLookup(
  info: ReturnType<typeof getRuntimePlatformInfo>,
  Subprocess: any,
): Promise<string | undefined> {
  if (!Subprocess?.call) return undefined;
  try {
    const lookupCmd = info.platform === "windows" ? "where codex" : "which codex";
    const proc = await Subprocess.call({
      command: info.shellPath,
      arguments: [info.shellFlag, lookupCmd],
    });
    const out = await readSubprocessStdout(proc);
    const exitCode = await waitForSubprocessExitCode(proc);
    const found =
      exitCode === undefined || exitCode === 0
        ? selectCodexLookupResult(out, info.platform)
        : "";
    return found || undefined;
  } catch {
    return undefined;
  }
}

async function resolveWindowsNativeCodexBinary(params: {
  env: Record<string, string | undefined>;
  Subprocess: any;
}): Promise<string | undefined> {
  const info = getRuntimePlatformInfo();
  const lookupResult = await resolveCodexBinaryFromShellPathLookup(
    info,
    params.Subprocess,
  );
  if (lookupResult) {
    return await resolveWindowsCodexShimPath(lookupResult);
  }

  const prefixCandidates = uniquePaths(
    [
      getNonEmptyEnvValue(params.env, "NPM_CONFIG_PREFIX"),
      getNonEmptyEnvValue(params.env, "npm_config_prefix"),
      getNonEmptyEnvValue(params.env, "PREFIX"),
    ]
      .filter((entry): entry is string => Boolean(entry))
      .flatMap((prefix) =>
        buildPrefixCodexCandidates({
          prefix,
          platform: "windows",
          separator: "\\",
        }),
      ),
  );
  for (const candidate of [
    ...prefixCandidates,
    ...buildWindowsCodexCandidates(params.env),
  ]) {
    if (await pathExists(candidate)) return candidate;
  }

  return undefined;
}

export async function resolveCodexBinary(
  explicitPath?: string,
): Promise<string> {
  const normalizedExplicitPath = resolveCodexAppServerBinaryPath(explicitPath);
  const info = getRuntimePlatformInfo();
  const env = getCodexRuntimeEnv();

  let Subprocess: any;
  try {
    Subprocess = await CodexAppServerProcess.loadSubprocessModule();
  } catch {
    Subprocess = null;
  }

  if (normalizedExplicitPath) {
    if (info.platform === "windows") {
      if (isUnsupportedWindowsWslCodexReference(normalizedExplicitPath)) {
        throw createWindowsWslCodexUnsupportedError();
      }
      return await resolveWindowsCodexShimPath(normalizedExplicitPath);
    }
    return normalizedExplicitPath;
  }

  // 1. CODEX_PATH env var
  const codexPath = resolveCodexAppServerBinaryPath(env.CODEX_PATH);
  if (codexPath) {
    if (info.platform === "windows") {
      if (isUnsupportedWindowsWslCodexReference(codexPath)) {
        throw createWindowsWslCodexUnsupportedError();
      }
      return await resolveWindowsCodexShimPath(codexPath);
    }
    return codexPath;
  }

  // 2. Locate via `which`/`where` using shell
  if (info.platform === "windows") {
    const nativeCodex = await resolveWindowsNativeCodexBinary({
      env,
      Subprocess,
    });
    if (nativeCodex) return nativeCodex;
  } else {
    const found = await resolveCodexBinaryFromShellPathLookup(info, Subprocess);
    if (found) return found;
  }

  if (info.platform === "windows") {
    throw createCodexBinaryNotFoundError(info.platform);
  }

  // 3. Deterministic common install paths
  const homeDir =
    getNonEmptyEnvValue(env, "HOME") ||
    getNonEmptyEnvValue(env, "USERPROFILE") ||
    "";
  const prefixCandidates = uniquePaths(
    [
      getNonEmptyEnvValue(env, "NPM_CONFIG_PREFIX"),
      getNonEmptyEnvValue(env, "npm_config_prefix"),
      getNonEmptyEnvValue(env, "PREFIX"),
    ]
      .filter((entry): entry is string => Boolean(entry))
      .flatMap((prefix) =>
        buildPrefixCodexCandidates({
          prefix,
          platform: info.platform,
          separator: info.pathSeparator,
        }),
      ),
  );
  const commonCandidates = uniquePaths([
    homeDir
      ? joinRuntimePath(info.pathSeparator, homeDir, ".cargo", "bin", "codex")
      : "",
    homeDir
      ? joinRuntimePath(
          info.pathSeparator,
          homeDir,
          ".npm-global",
          "bin",
          "codex",
        )
      : "",
    homeDir
      ? joinRuntimePath(info.pathSeparator, homeDir, ".local", "bin", "codex")
      : "",
    homeDir
      ? joinRuntimePath(info.pathSeparator, homeDir, ".volta", "bin", "codex")
      : "",
    homeDir
      ? joinRuntimePath(info.pathSeparator, homeDir, ".asdf", "shims", "codex")
      : "",
    ...(info.platform === "macos" ? ["/opt/homebrew/bin/codex"] : []),
    "/usr/local/bin/codex",
    "/usr/bin/codex",
  ]);

  const nvmCandidates = !homeDir
    ? []
    : await listNvmCodexCandidates({
        homeDir,
        nvmDir: getNonEmptyEnvValue(env, "NVM_DIR"),
        separator: "/",
      });

  for (const candidate of [
    ...prefixCandidates,
    ...commonCandidates,
    ...nvmCandidates,
  ]) {
    if (await pathExists(candidate)) return candidate;
  }

  throw createCodexBinaryNotFoundError(info.platform);
}

// Per-auth-mode singleton processes
const processCache = new Map<string, Promise<CodexAppServerProcess>>();

function buildProcessCacheKey(
  cacheKey: string,
  options: CodexAppServerProcessOptions = {},
): string {
  const codexPath = resolveCodexAppServerBinaryPath(options.codexPath);
  return codexPath ? `${cacheKey}\u0000${codexPath}` : cacheKey;
}

export function destroyCachedCodexAppServerProcess(
  cacheKey: string,
  proc?: CodexAppServerProcess,
  options: CodexAppServerProcessOptions = {},
): void {
  const effectiveCacheKey = buildProcessCacheKey(cacheKey, options);
  const existing = processCache.get(effectiveCacheKey);
  if (!existing) {
    proc?.destroy();
    return;
  }

  processCache.delete(effectiveCacheKey);
  existing
    .then((cachedProc) => {
      if (proc && cachedProc !== proc) return;
      cachedProc.destroy();
    })
    .catch(() => {
      if (proc) {
        proc.destroy();
      }
    });
}

export async function getOrCreateCodexAppServerProcess(
  cacheKey: string,
  options: CodexAppServerProcessOptions = {},
): Promise<CodexAppServerProcess> {
  const effectiveCacheKey = buildProcessCacheKey(cacheKey, options);
  const existing = processCache.get(effectiveCacheKey);
  if (existing) {
    return existing;
  }
  const promise = CodexAppServerProcess.spawn(options);
  promise.then((proc) => {
    proc.onClose(() => {
      if (processCache.get(effectiveCacheKey) === promise) {
        processCache.delete(effectiveCacheKey);
      }
    });
  });
  processCache.set(effectiveCacheKey, promise);
  promise.catch(() => processCache.delete(effectiveCacheKey));
  return promise;
}
