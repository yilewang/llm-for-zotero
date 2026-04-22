import type { ReasoningConfig, ReasoningEvent, UsageStats } from "./llmClient";
import { getRuntimePlatformInfo } from "./runtimePlatform";
import { getReasoningDefaultLevelForModel } from "./reasoningProfiles";

const DEFAULT_CODEX_APP_SERVER_TURN_TIMEOUT_MS = 300_000;
const DEFAULT_CODEX_APP_SERVER_REQUEST_TIMEOUT_MS = 60_000;

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
  private turnQueue = Promise.resolve();
  private lineBuffer = "";
  private destroyed = false;
  private didNotifyClose = false;

  private constructor(proc: unknown) {
    this.proc = proc;
  }

  static forTest(proc: unknown): CodexAppServerProcess {
    return new CodexAppServerProcess(proc);
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

  static async spawn(): Promise<CodexAppServerProcess> {
    const Subprocess = await CodexAppServerProcess.loadSubprocessModule();
    const info = getRuntimePlatformInfo();
    const binary = await resolveCodexBinary();

    // On Windows, npm shims are batch scripts that can't be exec'd directly.
    // Run the resolved binary through cmd.exe so CODEX_PATH and non-PATH installs work.
    let command: string;
    let args: string[];
    if (info.platform === "windows") {
      command = info.shellPath;
      args = [info.shellFlag, `"${binary}" app-server`];
    } else {
      command = binary;
      args = ["app-server"];
    }

    let proc: any;
    try {
      proc = await Subprocess.call({
        command,
        arguments: args,
      });
    } catch (err) {
      throw new Error(
        `Failed to spawn codex app-server (command: ${command} ${args.join(" ")}): ${err instanceof Error ? err.message : JSON.stringify(err)}`,
      );
    }

    const instance = new CodexAppServerProcess(proc);
    instance.startReadLoop();
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
            Zotero.debug?.(
              `[llm-for-zotero] codex app-server: failed to parse line: ${trimmed}`,
            );
          }
        }
      }
      if (!this.destroyed) {
        this.fail(
          new Error("codex app-server process closed unexpectedly"),
          false,
        );
      }
    })();
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
        this.writeRawMessage({ method, id, params });
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
      this.writeRawMessage({ method, params });
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

  private async initialize(): Promise<void> {
    await this.sendRequest("initialize", {
      clientInfo: { name: "llm-for-zotero", version: "1.0" },
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
  };
  return (
    normalizeCodexAppServerText(row.text) ||
    normalizeCodexAppServerText(row.content) ||
    normalizeCodexAppServerText(row.summary) ||
    normalizeCodexAppServerText(row.reasoning) ||
    ""
  );
}

function extractCodexAppServerItem(rawParams: unknown): {
  id?: string;
  type?: string;
  summary?: string;
  details?: string;
} | null {
  if (!rawParams || typeof rawParams !== "object") return null;
  const source =
    rawParams &&
    typeof (rawParams as { item?: unknown }).item === "object" &&
    (rawParams as { item?: unknown }).item
      ? (rawParams as { item: unknown }).item
      : rawParams;
  if (!source || typeof source !== "object") return null;
  const item = source as {
    id?: unknown;
    type?: unknown;
    summary?: unknown;
    content?: unknown;
    text?: unknown;
    reasoning?: unknown;
  };
  return {
    id:
      typeof item.id === "string" && item.id.trim()
        ? item.id.trim()
        : undefined,
    type:
      typeof item.type === "string" && item.type.trim()
        ? item.type.trim().toLowerCase()
        : undefined,
    summary: normalizeCodexAppServerText(item.summary) || undefined,
    details:
      normalizeCodexAppServerText(item.content) ||
      normalizeCodexAppServerText(item.reasoning) ||
      normalizeCodexAppServerText(item.text) ||
      undefined,
  };
}

export function waitForCodexAppServerTurnCompletion(params: {
  proc: CodexAppServerProcess;
  turnId: string;
  onTextDelta?: (delta: string) => void | Promise<void>;
  onReasoning?: (event: ReasoningEvent) => void | Promise<void>;
  onUsage?: (usage: UsageStats) => void | Promise<void>;
  signal?: AbortSignal;
  cacheKey?: string;
  timeoutMs?: number;
}): Promise<string> {
  const { proc, turnId, onTextDelta, onReasoning, onUsage, signal, cacheKey } =
    params;
  const timeoutMs =
    params.timeoutMs ?? DEFAULT_CODEX_APP_SERVER_TURN_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let accumulated = "";
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let lastEmittedUsageTotals: UsageStats | null = null;
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
      if (!summary && !details) return;
      Promise.resolve(onReasoning?.({ summary, details })).catch(() => {
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
          destroyCachedCodexAppServerProcess(cacheKey, proc);
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
      if (cacheKey) {
        destroyCachedCodexAppServerProcess(cacheKey, proc);
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

    // item/agentMessage/delta has no turnId — only one turn is active at a time
    const unsubDelta = proc.onNotification(
      "item/agentMessage/delta",
      (rawParams: unknown) => {
        const notification = rawParams as { delta?: string };
        const delta = notification.delta ?? "";
        if (!delta) return;
        accumulated += delta;
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
        const notification = rawParams as {
          itemId?: unknown;
          delta?: unknown;
          text?: unknown;
        };
        const summary = normalizeCodexAppServerText(
          notification.delta ?? notification.text,
        );
        if (!summary) return;
        if (
          typeof notification.itemId === "string" &&
          notification.itemId.trim()
        ) {
          getReasoningState(notification.itemId.trim()).sawSummaryDelta = true;
        }
        emitReasoning({ summary });
      },
    );

    const unsubReasoningDetails = proc.onNotification(
      "item/reasoning/textDelta",
      (rawParams: unknown) => {
        const notification = rawParams as {
          itemId?: unknown;
          delta?: unknown;
          text?: unknown;
        };
        const details = normalizeCodexAppServerText(
          notification.delta ?? notification.text,
        );
        if (!details) return;
        if (
          typeof notification.itemId === "string" &&
          notification.itemId.trim()
        ) {
          getReasoningState(notification.itemId.trim()).sawDetailsDelta = true;
        }
        emitReasoning({ details });
      },
    );

    const unsubUsage = proc.onNotification(
      "thread/tokenUsage/updated",
      (rawParams: unknown) => {
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
        const eventTurnId =
          typeof notification.turnId === "string" ? notification.turnId : "";
        if (eventTurnId && eventTurnId !== turnId) return;
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

    const unsubItemCompleted = proc.onNotification(
      "item/completed",
      (rawParams: unknown) => {
        const item = extractCodexAppServerItem(rawParams);
        if (!item || item.type !== "reasoning") return;
        const state = item.id ? getReasoningState(item.id) : undefined;
        if (item.summary && !state?.sawSummaryDelta) {
          emitReasoning({ summary: item.summary });
        }
        if (item.details && !state?.sawDetailsDelta) {
          emitReasoning({ details: item.details });
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
        if (status === "completed") {
          settle(() => resolve(accumulated));
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

async function resolveCodexBinary(): Promise<string> {
  const info = getRuntimePlatformInfo();
  const env = (globalThis as any).process?.env ?? {};

  // 1. CODEX_PATH env var
  if (env.CODEX_PATH?.trim()) return env.CODEX_PATH.trim();

  // 2. Locate via `which`/`where` using shell
  let Subprocess: any;
  try {
    Subprocess = await CodexAppServerProcess.loadSubprocessModule();
  } catch {
    Subprocess = null;
  }

  if (Subprocess?.call) {
    try {
      const lookupCmd =
        info.platform === "windows" ? "where codex" : "which codex";
      const proc = await Subprocess.call({
        command: info.shellPath,
        arguments: [info.shellFlag, lookupCmd],
      });
      let out = "";
      try {
        while (true) {
          const chunk = await proc.stdout.readString();
          if (!chunk) break;
          out += chunk;
        }
      } catch {
        /* ignore */
      }
      await proc.wait();
      const found = out.trim().split("\n")[0]?.trim();
      if (found) return found;
    } catch {
      /* continue to fallback */
    }
  }

  // 3. Common install paths
  const candidates =
    info.platform === "windows"
      ? [
          `${env.USERPROFILE ?? "C:\\Users\\User"}\\.cargo\\bin\\codex.exe`,
          "C:\\Program Files\\codex\\codex.exe",
        ]
      : info.platform === "macos"
        ? [
            `${env.HOME ?? "~"}/.cargo/bin/codex`,
            "/opt/homebrew/bin/codex",
            "/usr/local/bin/codex",
            "/usr/bin/codex",
          ]
        : [
            `${env.HOME ?? "~"}/.cargo/bin/codex`,
            "/usr/local/bin/codex",
            "/usr/bin/codex",
          ];

  const IOUtils = (globalThis as any).IOUtils;
  if (IOUtils?.exists) {
    for (const candidate of candidates) {
      try {
        if (await IOUtils.exists(candidate)) return candidate;
      } catch {
        /* continue */
      }
    }
  }

  throw new Error(
    "codex binary not found. Install Codex CLI (https://github.com/openai/codex) and ensure it is on your PATH, " +
      "or set the CODEX_PATH environment variable to the absolute path of the codex executable.",
  );
}

// Per-auth-mode singleton processes
const processCache = new Map<string, Promise<CodexAppServerProcess>>();

export function destroyCachedCodexAppServerProcess(
  cacheKey: string,
  proc?: CodexAppServerProcess,
): void {
  const existing = processCache.get(cacheKey);
  if (!existing) {
    proc?.destroy();
    return;
  }

  processCache.delete(cacheKey);
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
): Promise<CodexAppServerProcess> {
  const existing = processCache.get(cacheKey);
  if (existing) {
    return existing;
  }
  const promise = CodexAppServerProcess.spawn();
  promise.then((proc) => {
    proc.onClose(() => {
      if (processCache.get(cacheKey) === promise) {
        processCache.delete(cacheKey);
      }
    });
  });
  processCache.set(cacheKey, promise);
  promise.catch(() => processCache.delete(cacheKey));
  return promise;
}
