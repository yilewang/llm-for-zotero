import type { ReasoningConfig } from "./llm";

/**
 * The one completion boundary that reader work (exhaustive batches now;
 * digests and a user-chosen reader model later) calls through. Each runtime
 * supplies its own implementation: the turn's provider, the Codex Responses
 * route, or the Claude Code bridge.
 */
export type ReaderCompletionUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  model?: string;
};

export type ReaderCompletionOptions = {
  /** The concrete model name. An empty name is refused, never defaulted. */
  model: string;
  signal?: AbortSignal;
  /**
   * Upper bound for the call once it is running. A call waiting for a free
   * slot is not charged; only Stop ends that wait.
   */
  timeoutMs?: number;
  reasoning?: ReasoningConfig;
  systemMessages?: string[];
  /** Honored only by adapters whose runtime accepts it. */
  maxTokens?: number;
  temperature?: number;
};

export type ReaderCompletionResult = {
  text: string;
  /** Present only when the runtime reported token counts. */
  usage?: ReaderCompletionUsage;
};

export type ReaderCompletion = (
  prompt: string,
  options: ReaderCompletionOptions,
) => Promise<ReaderCompletionResult>;

/**
 * Which runtime a reader completion goes through: the chat turn's own
 * provider, the Codex Responses route, or the Claude Code bridge.
 */
export type ReaderRoute = "turn_model" | "codex_responses" | "claude_bridge";

/**
 * Why a reader call gave no text. The categories a caller branches on:
 * `timeout` and `transport` may succeed on a retry, `not_configured` and
 * `budget_unavailable` never will for this reader, `output_limit` and
 * `empty` mean the model answered with nothing usable, and `aborted` is
 * Stop.
 */
export type ReaderCompletionFailureReason =
  | "not_configured"
  | "budget_unavailable"
  | "output_limit"
  | "empty"
  | "timeout"
  | "transport"
  | "aborted";

/**
 * A reader call that failed for a known reason. The message starts with the
 * HTTP status when there is one, and an output-limit failure names
 * `(output_limit)`, so the exhaustive reader's rate-limit backoff and its
 * split-on-truncation both recognize it.
 */
export class ReaderCompletionError extends Error {
  readonly reason: ReaderCompletionFailureReason;
  readonly status?: number;
  readonly detail?: string;

  constructor(params: {
    reason: ReaderCompletionFailureReason;
    status?: number;
    detail?: string;
  }) {
    const text = params.detail || params.reason;
    super(
      [
        params.status ? `${params.status}` : "",
        params.reason === "output_limit" ? "(output_limit)" : "",
        text,
      ]
        .filter(Boolean)
        .join(" "),
    );
    this.name = "ReaderCompletionError";
    this.reason = params.reason;
    if (params.status !== undefined) this.status = params.status;
    if (params.detail) this.detail = params.detail;
  }
}

export type ReaderCompletionFailure = {
  reason: ReaderCompletionFailureReason;
  status?: number;
  detail?: string;
};

function leadingStatus(message: string): number | undefined {
  const match = /^(\d{3})\b/.exec(message.trim());
  return match ? Number(match[1]) : undefined;
}

/**
 * The reason a reader call threw, for any adapter. A `ReaderCompletionError`
 * names its own; other errors are read from their name and message: an
 * abort, a deadline, a cut-off reply, a refused credential (401, 403) or a
 * missing model is a configuration failure, anything else a transport
 * failure that may pass on a retry.
 */
export function classifyReaderCompletionError(
  error: unknown,
): ReaderCompletionFailure {
  if (error instanceof ReaderCompletionError) {
    return {
      reason: error.reason,
      ...(error.status !== undefined ? { status: error.status } : {}),
      ...(error.detail ? { detail: error.detail } : {}),
    };
  }
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  const detail = message.length > 300 ? `${message.slice(0, 300)}…` : message;
  if (name === "AbortError") return { reason: "aborted" };
  const status = leadingStatus(message);
  const withStatus = (reason: ReaderCompletionFailureReason) => ({
    reason,
    ...(status !== undefined ? { status } : {}),
    ...(detail ? { detail } : {}),
  });
  if (/\(output_limit\)/.test(message)) return withStatus("output_limit");
  if (/timed out|did not answer within|timeout/i.test(message))
    return withStatus("timeout");
  if (status === 401 || status === 403) return withStatus("not_configured");
  if (
    /concrete .*model is required|no model is configured|cannot run tool-free|not signed in|not logged in/i.test(
      message,
    )
  )
    return withStatus("not_configured");
  if (/returned (an )?empty completion|returned no visible text/i.test(message))
    return withStatus("empty");
  return withStatus("transport");
}

/** At most `size` reader calls in flight; the rest wait in arrival order. */
export type ReaderCallLimiter = {
  readonly size: number;
  /** Calls running now. */
  active(): number;
  /** Calls waiting for a slot. */
  waiting(): number;
  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T>;
};

function abortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

export function createReaderCallLimiter(size: number): ReaderCallLimiter {
  const limit = Math.max(1, Math.floor(size) || 1);
  let running = 0;
  const queue: Array<() => void> = [];
  // A finished call hands its slot straight to the next waiter, so a call
  // that arrives meanwhile cannot take it too.
  const release = () => {
    const next = queue.shift();
    if (next) next();
    else running -= 1;
  };
  return {
    size: limit,
    active: () => running,
    waiting: () => queue.length,
    run: async (task, signal) => {
      if (signal?.aborted) throw abortError();
      if (running < limit) running += 1;
      else {
        // Resolved by `release` with its slot already counted.
        await new Promise<void>((resolve, reject) => {
          const start = () => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          };
          const onAbort = () => {
            const at = queue.indexOf(start);
            if (at >= 0) queue.splice(at, 1);
            reject(abortError());
          };
          signal?.addEventListener("abort", onAbort, { once: true });
          queue.push(start);
        });
      }
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}

/**
 * The longest one call may run once it holds a slot, when the caller names
 * no `timeoutMs`. It keeps a stalled call from holding a shared slot until
 * its chat is stopped.
 */
export const LIMITED_READER_CALL_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * `complete` behind `limiter`. The call's `timeoutMs` starts when the call
 * gets its slot: waiting in the queue ends only when the call runs or Stop
 * aborts it, so a long queue never fails a call that did not yet reach the
 * model. A call that names no `timeoutMs` gets
 * `LIMITED_READER_CALL_TIMEOUT_MS`; a named one is kept.
 */
export function limitReaderCompletion(
  complete: ReaderCompletion,
  limiter: ReaderCallLimiter,
): ReaderCompletion {
  return (prompt, options) =>
    limiter.run(
      () =>
        complete(
          prompt,
          options.timeoutMs === undefined
            ? { ...options, timeoutMs: LIMITED_READER_CALL_TIMEOUT_MS }
            : options,
        ),
      options.signal,
    );
}
