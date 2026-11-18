/**
 * The plugin's Agent Client Protocol (ACP) client: one connection to one
 * agent process such as `agy acp`.
 *
 * It owns the protocol, not policy:
 * - the handshake (`initialize`, protocol and minimum agent version);
 * - the readiness wait: agy answers "Authentication required" (-32000) for a
 *   short time after start while it loads credentials, so the client retries
 *   a read-only request until it succeeds or the wait runs out, and then
 *   reports that the user is not signed in;
 * - sessions (new, load, resume, list filtered by working directory, close),
 *   modes, models, and config options;
 * - prompts, one at a time per session, and cancellation;
 * - routing `session/update` notifications and `session/request_permission`
 *   requests to the listeners registered for each session.
 *
 * How a permission request is answered (a review card, an automatic allow)
 * belongs to the runtime adapter that registers the handler. A cancelled
 * prompt answers that session's open permission requests with `cancelled`,
 * as ACP requires.
 */

import {
  ACP_AUTH_REQUIRED_ERROR_CODE,
  ACP_METHOD_NOT_FOUND_ERROR_CODE,
  ACP_METHODS,
  ACP_PROTOCOL_VERSION,
  type AcpContentBlock,
  type AcpInitializeResult,
  type AcpListSessionsResult,
  type AcpLoadSessionParams,
  type AcpNewSessionParams,
  type AcpNewSessionResult,
  type AcpPromptResult,
  type AcpRequestPermissionParams,
  type AcpRequestPermissionResult,
  type AcpSessionInfo,
  type AcpSessionNotification,
  type AcpSessionState,
} from "../shared/acpProtocol";
import { appLogger } from "../core/logging";
import { createAbortController } from "../utils/apiHelpers";
import {
  JsonRpcResponseError,
  StdioJsonRpcConnection,
  type JsonRpcRequestId,
  type StdioJsonRpcChild,
  type StdioJsonRpcIncoming,
} from "../utils/stdioJsonRpcConnection";
import {
  LocalDocumentPathStreamRedactor,
  redactAllRememberedLocalDocumentPathsFromTerminalText,
} from "../agent/privacy/localDocumentPathRedaction";

/** The oldest agy whose behavior the client was checked against. */
export const ACP_MINIMUM_AGENT_VERSION = "1.5.10";

const DEFAULT_READINESS_TIMEOUT_MS = 15_000;
const DEFAULT_READINESS_DELAY_MS = 500;
const SESSION_LIST_PAGE_LIMIT = 50;

/** The agent is running but has no usable sign-in. */
export class AcpNotSignedInError extends Error {
  constructor(agentLabel: string) {
    super(
      `${agentLabel} is not signed in. Run \`agy\` in a terminal and sign in, then try again.`,
    );
    this.name = "AcpNotSignedInError";
  }
}

/** The agent speaks another protocol version or is older than supported. */
export class AcpUnsupportedAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpUnsupportedAgentError";
  }
}

export function isAcpAuthenticationPendingError(error: unknown): boolean {
  return (
    error instanceof JsonRpcResponseError &&
    error.code === ACP_AUTH_REQUIRED_ERROR_CODE &&
    /authenticat/i.test(error.message)
  );
}

/** Compares dotted numeric versions; null when either is not one. */
export function compareAgentVersions(a: string, b: string): number | null {
  const parse = (value: string) => {
    const match = /^\s*v?(\d+(?:\.\d+)*)/.exec(value);
    return match ? match[1].split(".").map(Number) : null;
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return null;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function normalizeDirectory(path: string | undefined): string {
  const trimmed = String(path || "").trim();
  if (trimmed.length > 1) return trimmed.replace(/[\\/]+$/, "");
  return trimmed;
}

export type AcpSessionUpdateListener = (
  notification: AcpSessionNotification,
) => void;

/**
 * Answers one permission request. `signal` aborts when the prompt is
 * cancelled or the connection closes; the client then answers `cancelled`
 * itself and ignores the handler's result.
 */
export type AcpPermissionHandler = (
  params: AcpRequestPermissionParams,
  signal: AbortSignal,
) => Promise<AcpRequestPermissionResult>;

type OpenPermissionRequest = {
  id: JsonRpcRequestId;
  sessionId: string;
  controller: AbortController;
};

export type AcpClientOptions = {
  child: StdioJsonRpcChild;
  /** Names the agent in errors and logs. */
  label?: string;
  launchDescription?: string;
  readiness?: { timeoutMs?: number; delayMs?: number };
  minimumAgentVersion?: string;
};

const CANCELLED: AcpRequestPermissionResult = {
  outcome: { outcome: "cancelled" },
};

export class AcpClient {
  private readonly connection: StdioJsonRpcConnection;
  private readonly label: string;
  private initializeResult: AcpInitializeResult | null = null;
  private readonly updateListeners = new Map<
    string,
    Set<AcpSessionUpdateListener>
  >();
  private readonly permissionHandlers = new Map<string, AcpPermissionHandler>();
  private readonly openPermissionRequests = new Map<
    JsonRpcRequestId,
    OpenPermissionRequest
  >();
  private readonly activePrompts = new Set<string>();

  private constructor(options: AcpClientOptions) {
    this.label = options.label || "agy acp";
    this.connection = new StdioJsonRpcConnection(options.child, {
      label: this.label,
      launchDescription: options.launchDescription,
      destroyedMessage: `${this.label} connection closed`,
      includeJsonRpcVersion: true,
      redactText: redactAllRememberedLocalDocumentPathsFromTerminalText,
      diagnosticRedactor: new LocalDocumentPathStreamRedactor(0, {
        allConversations: true,
      }),
      onIncoming: (message) => this.handleIncoming(message),
      onClosing: () => {
        for (const request of this.openPermissionRequests.values()) {
          request.controller.abort();
        }
        this.openPermissionRequests.clear();
      },
    });
  }

  /**
   * Starts the connection, completes the handshake, and waits until the
   * agent is ready. The client closes the connection when this fails.
   */
  static async connect(options: AcpClientOptions): Promise<AcpClient> {
    const client = new AcpClient(options);
    client.connection.start();
    try {
      await client.initialize(options.minimumAgentVersion);
      await client.waitUntilReady(options.readiness);
      return client;
    } catch (error) {
      await client.destroyAndWait().catch(() => undefined);
      throw error;
    }
  }

  /** The agent's answer to `initialize`. */
  getInitializeResult(): AcpInitializeResult {
    if (!this.initializeResult) throw new Error("ACP client not initialized");
    return this.initializeResult;
  }

  private async initialize(minimumVersion?: string): Promise<void> {
    const result = (await this.connection.sendRequest(ACP_METHODS.initialize, {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "llm-for-zotero", title: "LLM for Zotero" },
    })) as AcpInitializeResult | undefined;
    if (!result || result.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new AcpUnsupportedAgentError(
        `${this.label} speaks ACP protocol version ${String(result?.protocolVersion)}; this plugin supports version ${ACP_PROTOCOL_VERSION}.`,
      );
    }
    const required = minimumVersion ?? ACP_MINIMUM_AGENT_VERSION;
    const version = result.agentInfo?.version;
    const comparison = version ? compareAgentVersions(version, required) : null;
    if (comparison !== null && comparison < 0) {
      throw new AcpUnsupportedAgentError(
        `${this.label} ${version} is older than the supported ${required}. Update agy, then try again.`,
      );
    }
    if (comparison === null) {
      appLogger.warn(
        `[llm-for-zotero] ${this.label}: unknown agent version "${String(version)}"; continuing`,
      );
    }
    this.initializeResult = result;
  }

  /**
   * Retries a read-only request while the agent answers "Authentication
   * required", for at most the readiness timeout.
   */
  private async waitUntilReady(
    readiness: AcpClientOptions["readiness"] = {},
  ): Promise<void> {
    const timeoutMs = readiness.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    const delayMs = readiness.delayMs ?? DEFAULT_READINESS_DELAY_MS;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await this.connection.sendRequest(ACP_METHODS.sessionList, {});
        return;
      } catch (error) {
        if (!isAcpAuthenticationPendingError(error)) throw error;
        if (Date.now() + delayMs > deadline) {
          throw new AcpNotSignedInError(this.label);
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  // ------------------------------------------------------------ sessions

  newSession(params: AcpNewSessionParams): Promise<AcpNewSessionResult> {
    return this.request(ACP_METHODS.sessionNew, params);
  }

  /**
   * Loads a stored session. The agent replays its history as
   * `session/update` notifications before it answers, so register an update
   * listener for the session first.
   */
  loadSession(params: AcpLoadSessionParams): Promise<AcpSessionState> {
    return this.request(ACP_METHODS.sessionLoad, params, 0);
  }

  /** Reattaches to a stored session without replaying its history. */
  resumeSession(params: AcpLoadSessionParams): Promise<AcpSessionState> {
    return this.request(ACP_METHODS.sessionResume, params);
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.request(ACP_METHODS.sessionClose, { sessionId });
  }

  /**
   * Lists stored sessions whose working directory is `cwd`. agy ignores the
   * `cwd` filter and lists every folder's sessions, so the client filters.
   */
  async listSessions(cwd: string): Promise<AcpSessionInfo[]> {
    const wanted = normalizeDirectory(cwd);
    const sessions: AcpSessionInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < SESSION_LIST_PAGE_LIMIT; page++) {
      const result = await this.request<AcpListSessionsResult>(
        ACP_METHODS.sessionList,
        cursor ? { cwd, cursor } : { cwd },
      );
      for (const session of result?.sessions ?? []) {
        if (normalizeDirectory(session.cwd) === wanted) sessions.push(session);
      }
      cursor = result?.nextCursor || undefined;
      if (!cursor) break;
    }
    return sessions;
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.request(ACP_METHODS.sessionSetMode, { sessionId, modeId });
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    await this.request(ACP_METHODS.sessionSetModel, { sessionId, modelId });
  }

  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<unknown> {
    return this.request(ACP_METHODS.sessionSetConfigOption, {
      sessionId,
      configId,
      value,
    });
  }

  // ------------------------------------------------------------ prompts

  /**
   * Runs one prompt turn and resolves with the agent's stop reason. Aborting
   * `signal` cancels the turn; the agent then ends it with `cancelled`.
   * A session runs one prompt at a time.
   */
  async prompt(
    sessionId: string,
    prompt: AcpContentBlock[],
    options: { signal?: AbortSignal } = {},
  ): Promise<AcpPromptResult> {
    if (this.activePrompts.has(sessionId)) {
      throw new Error(`A prompt is already running in session ${sessionId}`);
    }
    if (options.signal?.aborted) {
      return { stopReason: "cancelled" };
    }
    this.activePrompts.add(sessionId);
    const onAbort = () => this.cancel(sessionId);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await this.request<AcpPromptResult>(
        ACP_METHODS.sessionPrompt,
        { sessionId, prompt },
        0,
      );
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      this.activePrompts.delete(sessionId);
    }
  }

  isPromptRunning(sessionId: string): boolean {
    return this.activePrompts.has(sessionId);
  }

  /**
   * Cancels the session's running prompt. Its open permission requests are
   * answered `cancelled` first, as ACP requires.
   */
  cancel(sessionId: string): void {
    this.cancelPermissionRequests(sessionId);
    this.connection.sendNotification(ACP_METHODS.sessionCancel, { sessionId });
  }

  // ------------------------------------------------------------ listeners

  /** Receives the session's `session/update` notifications. */
  onSessionUpdate(
    sessionId: string,
    listener: AcpSessionUpdateListener,
  ): () => void {
    let listeners = this.updateListeners.get(sessionId);
    if (!listeners) {
      listeners = new Set();
      this.updateListeners.set(sessionId, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = this.updateListeners.get(sessionId);
      current?.delete(listener);
      if (current && !current.size) this.updateListeners.delete(sessionId);
    };
  }

  /**
   * Answers the session's permission requests. One handler per session;
   * removing it answers the requests still open with `cancelled`.
   */
  setPermissionHandler(
    sessionId: string,
    handler: AcpPermissionHandler,
  ): () => void {
    this.permissionHandlers.set(sessionId, handler);
    return () => {
      if (this.permissionHandlers.get(sessionId) !== handler) return;
      this.permissionHandlers.delete(sessionId);
      this.cancelPermissionRequests(sessionId);
    };
  }

  // ------------------------------------------------------------ lifecycle

  onClose(listener: (reason?: string) => void): () => void {
    return this.connection.onClose(listener);
  }

  isClosed(): boolean {
    return this.connection.isClosed();
  }

  destroy(): void {
    this.connection.destroy();
  }

  destroyAndWait(timeoutMs?: number): Promise<boolean> {
    return this.connection.destroyAndWait(timeoutMs);
  }

  // ------------------------------------------------------------ internals

  private request<T>(
    method: string,
    params: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    return this.connection.sendRequest(method, params, {
      timeoutMs,
      // A slow answer is the agent's problem with one call, not a dead pipe.
      failOnTimeout: false,
    }) as Promise<T>;
  }

  private handleIncoming(message: StdioJsonRpcIncoming): void {
    if (message.kind === "notification") {
      if (message.method !== ACP_METHODS.sessionUpdate) return;
      const notification = message.params as AcpSessionNotification;
      const listeners = this.updateListeners.get(notification?.sessionId);
      if (!listeners) return;
      for (const listener of [...listeners]) {
        try {
          listener(notification);
        } catch (error) {
          appLogger.warn(
            `[llm-for-zotero] ${this.label}: session update listener failed`,
            error,
          );
        }
      }
      return;
    }
    if (message.method === ACP_METHODS.sessionRequestPermission) {
      this.handlePermissionRequest(
        message.id,
        message.params as AcpRequestPermissionParams,
      );
      return;
    }
    // The client declares no file-system or terminal capability.
    this.connection.respondError(message.id, {
      code: ACP_METHOD_NOT_FOUND_ERROR_CODE,
      message: `Unsupported client method: ${message.method}`,
    });
  }

  private handlePermissionRequest(
    id: JsonRpcRequestId,
    params: AcpRequestPermissionParams,
  ): void {
    const sessionId = String(params?.sessionId || "");
    const handler = this.permissionHandlers.get(sessionId);
    if (!handler) {
      appLogger.warn(
        `[llm-for-zotero] ${this.label}: permission request for a session with no handler; answering cancelled`,
      );
      this.connection.respond(id, CANCELLED);
      return;
    }
    const request: OpenPermissionRequest = {
      id,
      sessionId,
      controller: createAbortController(),
    };
    this.openPermissionRequests.set(id, request);
    Promise.resolve()
      .then(() => handler(params, request.controller.signal))
      .then(
        (result) => {
          if (request.controller.signal.aborted) return;
          this.connection.respond(id, result);
        },
        (error) => {
          if (request.controller.signal.aborted) return;
          appLogger.warn(
            `[llm-for-zotero] ${this.label}: permission handler failed; answering cancelled`,
            error,
          );
          this.connection.respond(id, CANCELLED);
        },
      )
      .finally(() => {
        if (this.openPermissionRequests.get(id) === request) {
          this.openPermissionRequests.delete(id);
        }
      });
  }

  private cancelPermissionRequests(sessionId: string): void {
    for (const [id, request] of this.openPermissionRequests) {
      if (request.sessionId !== sessionId) continue;
      this.openPermissionRequests.delete(id);
      request.controller.abort();
      this.connection.respond(id, CANCELLED);
    }
  }
}
