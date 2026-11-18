/**
 * One JSON-RPC connection to a child process over its stdin and stdout, one
 * JSON message per line. Codex app-server and Antigravity's `agy acp` both
 * speak this framing; the protocol on top (methods, server requests, turn
 * semantics) belongs to the owner of the connection.
 *
 * The connection owns:
 * - line framing and parsing of the child's stdout;
 * - request ids, matching responses to requests, and request timeouts;
 * - a bounded, redacted tail of stderr (and unparsable stdout) for errors;
 * - the closing sequence: pending requests fail once, the child is killed,
 *   and close listeners hear one reason.
 *
 * It hands every request and notification from the child to the owner's
 * `onIncoming`, which answers requests with `respond` or `respondError`.
 */

import { appLogger } from "../core/logging";
import type { GeckoSubprocessProcess } from "./geckoSubprocess";

export type JsonRpcRequestId = string | number;

/** The child-process surface this connection reads and writes. */
export type StdioJsonRpcChild = Pick<
  GeckoSubprocessProcess,
  "stdin" | "stdout" | "stderr" | "kill" | "wait"
>;

export type StdioJsonRpcIncoming =
  | {
      kind: "request";
      id: JsonRpcRequestId;
      method: string;
      params: unknown;
    }
  | { kind: "notification"; method: string; params: unknown };

/** An error response from the child. `message` is redacted. */
export class JsonRpcResponseError extends Error {
  constructor(
    message: string,
    readonly code: number | undefined,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "JsonRpcResponseError";
  }
}

/** A streaming redactor for diagnostic text, split by channel. */
export type StdioDiagnosticRedactor = {
  push(channel: string, chunk: string): string;
  flushAll(): Iterable<{ text: string }>;
};

export type StdioJsonRpcConnectionOptions = {
  /** Names the program in errors and logs, such as "codex app-server". */
  label: string;
  /** The command line, appended to "closed unexpectedly" errors. */
  launchDescription?: string;
  /** The message requests fail with after `destroy()`. */
  destroyedMessage: string;
  /** Adds `"jsonrpc": "2.0"` to every outgoing message (ACP needs it). */
  includeJsonRpcVersion?: boolean;
  /** Removes private paths from text that reaches errors and logs. */
  redactText?: (text: string) => string;
  /** Redacts diagnostic text that may arrive split across chunks. */
  diagnosticRedactor?: StdioDiagnosticRedactor;
  onIncoming(message: StdioJsonRpcIncoming): void;
  /** Runs once, synchronously, when the connection starts closing. */
  onClosing?(): void;
};

export type StdioJsonRpcRequestOptions = {
  /** 0 or less waits forever. */
  timeoutMs?: number;
  /** A timed-out request closes the connection unless this is false. */
  failOnTimeout?: boolean;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

const STDERR_TAIL_WAIT_MS = 100;
const DIAGNOSTIC_BUFFER_MAX = 4000;
const DIAGNOSTIC_BUFFER_TRIM_THRESHOLD = 8000;
const CLOSE_REASON_MAX = 400;
export const DEFAULT_STDIO_JSON_RPC_REQUEST_TIMEOUT_MS = 60_000;

export class StdioJsonRpcConnection {
  private nextId = 1;
  private readonly pendingRequests = new Map<
    JsonRpcRequestId,
    PendingRequest
  >();
  private readonly activityListeners = new Set<
    (message: Record<string, unknown>) => void
  >();
  private readonly closeListeners = new Set<(reason?: string) => void>();
  private readLoopPromise: Promise<void> | null = null;
  private stderrLoopPromise: Promise<void> | null = null;
  private lineBuffer = "";
  private diagnosticBuffer = "";
  private closeReason: string | undefined;
  private closed = false;
  private didNotifyClose = false;
  private readonly redact: (text: string) => string;

  constructor(
    private readonly child: StdioJsonRpcChild,
    private readonly options: StdioJsonRpcConnectionOptions,
  ) {
    this.redact = options.redactText ?? ((text) => text);
  }

  /** Starts reading the child's stdout and stderr. Call once. */
  start(): void {
    if (this.readLoopPromise) return;
    this.startReadLoop();
    this.startStderrReadLoop();
  }

  isClosed(): boolean {
    return this.closed;
  }

  getCloseReason(): string | undefined {
    return this.closeReason;
  }

  sendRequest(
    method: string,
    params?: unknown,
    options: StdioJsonRpcRequestOptions = {},
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error(this.options.destroyedMessage));
    }
    const timeoutMs =
      options.timeoutMs ?? DEFAULT_STDIO_JSON_RPC_REQUEST_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      this.pendingRequests.set(id, {
        resolve: (value) => {
          if (timeoutId !== null) clearTimeout(timeoutId);
          resolve(value);
        },
        reject: (reason) => {
          if (timeoutId !== null) clearTimeout(timeoutId);
          reject(reason);
        },
      });
      if (timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          const pending = this.pendingRequests.get(id);
          if (!pending) return;
          this.pendingRequests.delete(id);
          const error = new Error(
            `Timed out waiting for ${this.options.label} response to ${method} after ${timeoutMs}ms`,
          );
          pending.reject(error);
          if (options.failOnTimeout !== false) this.close(error, true);
        }, timeoutMs);
      }
      try {
        this.write({ method, id, params });
      } catch (error) {
        if (timeoutId !== null) clearTimeout(timeoutId);
        this.pendingRequests.delete(id);
        reject(error);
      }
    });
  }

  sendNotification(method: string, params?: unknown): void {
    if (this.closed) return;
    try {
      this.write({ method, params });
    } catch {
      /* the child is gone; its close is reported by the read loop */
    }
  }

  respond(id: JsonRpcRequestId, result: unknown): void {
    if (this.closed) return;
    try {
      this.write({ id, result });
    } catch {
      /* the child is gone */
    }
  }

  respondError(
    id: JsonRpcRequestId,
    error: { code: number; message: string; data?: unknown },
  ): void {
    if (this.closed) return;
    try {
      this.write({ id, error });
    } catch {
      /* the child is gone */
    }
  }

  /** Sees every parsed message from the child, responses included. */
  onActivity(listener: (message: Record<string, unknown>) => void): () => void {
    this.activityListeners.add(listener);
    return () => {
      this.activityListeners.delete(listener);
    };
  }

  /** Runs once with the close reason; at once if already closed. */
  onClose(listener: (reason?: string) => void): () => void {
    if (this.didNotifyClose || this.closed) {
      listener(this.closeReason);
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  destroy(): void {
    this.close(new Error(this.options.destroyedMessage), true);
  }

  /**
   * Destroys the connection and waits, at most `timeoutMs`, for the child to
   * exit and the read loops to end. Returns whether both happened in time.
   */
  async destroyAndWait(timeoutMs = 2_000): Promise<boolean> {
    this.destroy();
    const waitBounded = async (task: Promise<unknown>): Promise<boolean> => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          task.then(
            () => true,
            () => true,
          ),
          new Promise<boolean>((resolve) => {
            timeoutId = setTimeout(
              () => resolve(false),
              Math.max(0, timeoutMs),
            );
          }),
        ]);
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      }
    };
    const processExited =
      typeof this.child.wait === "function"
        ? await waitBounded(Promise.resolve(this.child.wait()))
        : true;
    const readLoops = [this.readLoopPromise, this.stderrLoopPromise].filter(
      (task): task is Promise<void> => Boolean(task),
    );
    if (!readLoops.length) return processExited;
    const loopsDrained = await waitBounded(Promise.allSettled(readLoops));
    return processExited && loopsDrained;
  }

  /**
   * Closes the connection: pending requests fail with `error`, the owner's
   * `onClosing` runs, the child is killed if asked, and close listeners hear
   * the reason. Later calls only kill the child, if asked.
   */
  close(error: Error, killProcess: boolean): void {
    if (this.closeReason === undefined) {
      const reason = this.redact(error.message || "")
        .replace(/\s+/g, " ")
        .trim();
      if (reason) {
        this.closeReason =
          reason.length > CLOSE_REASON_MAX
            ? `${reason.slice(0, CLOSE_REASON_MAX)}...`
            : reason;
      }
    }
    if (!this.closed) {
      this.closed = true;
      for (const pending of this.pendingRequests.values()) {
        pending.reject(error);
      }
      this.pendingRequests.clear();
      try {
        this.options.onClosing?.();
      } catch {
        /* closing must finish */
      }
    }
    if (killProcess) {
      try {
        void Promise.resolve(this.child.kill?.()).catch(() => undefined);
      } catch {
        /* already gone */
      }
    }
    if (this.didNotifyClose) return;
    this.didNotifyClose = true;
    if (this.closeReason) {
      appLogger.warn(
        `[llm-for-zotero] ${this.options.label} closed: ${this.closeReason}`,
      );
    }
    for (const listener of this.closeListeners) {
      try {
        listener(this.closeReason);
      } catch {
        /* one listener must not stop the others */
      }
    }
    this.closeListeners.clear();
  }

  private write(message: Record<string, unknown>): void {
    const wire = this.options.includeJsonRpcVersion
      ? { jsonrpc: "2.0", ...message }
      : message;
    const stdin = this.child.stdin;
    if (!stdin?.write) throw new Error(`${this.options.label} has no stdin`);
    const written = stdin.write(`${JSON.stringify(wire)}\n`) as unknown;
    // A write to a child that just exited rejects; the read loop reports it.
    if (written && typeof (written as Promise<unknown>).catch === "function") {
      (written as Promise<unknown>).catch(() => undefined);
    }
  }

  private startReadLoop(): void {
    const stdout = this.child.stdout;
    this.readLoopPromise = (async () => {
      while (!this.closed) {
        let chunk: string;
        try {
          chunk = (await stdout?.readString?.()) ?? "";
        } catch {
          break;
        }
        if (!chunk) break;
        this.lineBuffer += chunk;
        const lines = this.lineBuffer.split("\n");
        this.lineBuffer = lines.pop() ?? "";
        for (const line of lines) this.receiveLine(line);
      }
      if (!this.closed) {
        await this.waitForStderrTail();
        const diagnostics = this.getDiagnosticTail();
        const launched = this.options.launchDescription
          ? ` (launched: ${this.options.launchDescription})`
          : "";
        this.close(
          new Error(
            `${this.options.label} process closed unexpectedly${diagnostics ? `: ${diagnostics}` : " with no stderr/stdout diagnostics"}${launched}`,
          ),
          false,
        );
      }
    })();
  }

  private receiveLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      message = undefined;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      const redactedLine = this.redact(trimmed);
      this.appendDiagnostic(`${redactedLine}\n`, "stdout");
      appLogger.debug(
        `[llm-for-zotero] ${this.options.label}: failed to parse line: ${redactedLine}`,
      );
      return;
    }
    this.dispatch(message as Record<string, unknown>);
  }

  private dispatch(message: Record<string, unknown>): void {
    for (const listener of this.activityListeners) {
      try {
        listener(message);
      } catch {
        /* observers must not affect the protocol */
      }
    }
    const method = message.method;
    const hasId = message.id !== null && message.id !== undefined;
    if (hasId && typeof method !== "string") {
      this.settleResponse(message);
      return;
    }
    if (typeof method !== "string") return;
    try {
      this.options.onIncoming(
        hasId
          ? {
              kind: "request",
              id: message.id as JsonRpcRequestId,
              method,
              params: message.params,
            }
          : { kind: "notification", method, params: message.params },
      );
    } catch (error) {
      appLogger.warn(
        `[llm-for-zotero] ${this.options.label}: handling ${method} failed`,
        error,
      );
    }
  }

  private settleResponse(message: Record<string, unknown>): void {
    const id = message.id as JsonRpcRequestId;
    const pending = this.pendingRequests.get(id);
    if (!pending) return;
    this.pendingRequests.delete(id);
    if ("error" in message) {
      const raw = message.error as
        | { code?: unknown; message?: unknown; data?: unknown }
        | undefined;
      pending.reject(
        new JsonRpcResponseError(
          this.redact(String(raw?.message ?? raw)),
          typeof raw?.code === "number" ? raw.code : undefined,
          raw?.data,
        ),
      );
      return;
    }
    pending.resolve(message.result);
  }

  private startStderrReadLoop(): void {
    const stderr = this.child.stderr;
    if (!stderr?.readString) return;
    this.stderrLoopPromise = (async () => {
      while (!this.closed) {
        let chunk: string;
        try {
          chunk = (await stderr.readString?.()) ?? "";
        } catch {
          break;
        }
        if (!chunk) break;
        this.appendDiagnostic(chunk, "stderr");
      }
    })();
  }

  private appendDiagnostic(chunk: string, channel: string): void {
    this.diagnosticBuffer += this.options.diagnosticRedactor
      ? this.options.diagnosticRedactor.push(channel, chunk)
      : this.redact(chunk);
    if (this.diagnosticBuffer.length > DIAGNOSTIC_BUFFER_TRIM_THRESHOLD) {
      this.diagnosticBuffer = this.diagnosticBuffer.slice(
        -DIAGNOSTIC_BUFFER_MAX,
      );
    }
  }

  /** The recent diagnostics on one line, redacted. */
  getDiagnosticTail(): string {
    if (this.options.diagnosticRedactor) {
      for (const entry of this.options.diagnosticRedactor.flushAll()) {
        this.diagnosticBuffer += entry.text;
      }
    }
    const pendingStdout = this.redact(this.lineBuffer.trim());
    const combined = `${this.diagnosticBuffer}${pendingStdout ? `\n${pendingStdout}` : ""}`;
    return this.redact(combined).replace(/\s+/g, " ").trim();
  }

  private async waitForStderrTail(): Promise<void> {
    if (!this.stderrLoopPromise) return;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.stderrLoopPromise.catch(() => undefined),
      new Promise<void>((resolve) => {
        timeoutId = setTimeout(resolve, STDERR_TAIL_WAIT_MS);
      }),
    ]);
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
