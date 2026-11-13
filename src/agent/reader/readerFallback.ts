/**
 * The chosen reader, with the main model as its fallback.
 *
 * A reader the user picked can fail for a reason that has nothing to do with
 * the paper: no credential, a refused key (401, 403), no model set. Then the
 * main model's route reads instead, once for the whole run, and the switch is
 * recorded as a typed note. A failure about the paper's reading itself
 * (timeout, a cut-off or empty answer, a transport error) does not fall back:
 * it is the reader's result, and a different model would change the answer
 * without the user knowing.
 */
import {
  classifyReaderCompletionError,
  type ReaderCompletionOptions,
  type ReaderRoute,
} from "../../shared/readerCompletion";
import {
  resolveReaderCompletion,
  type ReaderChoice,
  type ReaderRequest,
  type ReaderResolution,
  type ResolvedReader,
} from "./resolveReader";

export type ReaderFallbackReason =
  /** The chosen reader has no usable configuration (or no model). */
  | "not_configured"
  /** The chosen reader's provider refused the credential (401, 403). */
  | "unauthorized"
  /** The chosen reader could not be set up at all. */
  | "unavailable";

/**
 * Written to the trace as a typed note when the main model read instead of
 * the chosen reader. It names models and routes only: never a key or a URL.
 */
export type ReaderFallbackNote = {
  type: "reader_fallback";
  chosen: { route: ReaderRoute; model: string };
  usedInstead: { route: ReaderRoute; model: string };
  reason: ReaderFallbackReason;
  status?: number;
};

/**
 * The fallback reason a reader failure gives, or null when it is not a
 * configuration or credential failure (and so keeps its own result).
 */
export function readerFallbackReason(
  error: unknown,
): { reason: "not_configured" | "unauthorized"; status?: number } | null {
  const failure = classifyReaderCompletionError(error);
  if (failure.reason === "aborted") return null;
  if (failure.status === 401 || failure.status === 403) {
    return { reason: "unauthorized", status: failure.status };
  }
  if (failure.reason === "not_configured") {
    return {
      reason: "not_configured",
      ...(failure.status !== undefined ? { status: failure.status } : {}),
    };
  }
  return null;
}

export type ReaderWithFallback = {
  resolution: ReaderResolution;
  /** The switch to the main model, once it happened (or was needed). */
  fallbackNote: () => ReaderFallbackNote | undefined;
};

function describe(reader: ResolvedReader) {
  return { route: reader.route, model: reader.model };
}

/**
 * Resolves the chosen reader with the request's main model as fallback.
 * Without a choice this is exactly the main reader and never falls back.
 * If the chosen reader cannot be built, the main reader is used from the
 * start and the note says so.
 */
export function resolveReaderWithFallback(params: {
  request: ReaderRequest;
  choice?: ReaderChoice;
  llmCall?: Parameters<typeof resolveReaderCompletion>[0]["llmCall"];
  factories?: Parameters<typeof resolveReaderCompletion>[0]["factories"];
}): ReaderWithFallback {
  const main = resolveReaderCompletion({ ...params, choice: undefined });
  if (!params.choice) {
    return { resolution: main, fallbackNote: () => undefined };
  }
  const chosen = resolveReaderCompletion(params);
  if (!main.ok) {
    // No main model to fall back to: the chosen reader stands alone.
    return { resolution: chosen, fallbackNote: () => undefined };
  }
  if (!chosen.ok) {
    const note: ReaderFallbackNote = {
      type: "reader_fallback",
      chosen: { route: params.choice.route, model: params.choice.model },
      usedInstead: describe(main.reader),
      reason: "unavailable",
    };
    return { resolution: main, fallbackNote: () => note };
  }
  const primary = chosen.reader;
  const fallback = main.reader;
  let note: ReaderFallbackNote | undefined;
  const readFrom = () => (note ? fallback : primary);
  const base: ResolvedReader = {
    get route() {
      return readFrom().route;
    },
    get model() {
      return readFrom().model;
    },
    // Batches are sized for the smaller of the two windows, so a batch the
    // chosen reader took still fits the main model after a fallback.
    windowTokens: Math.min(primary.windowTokens, fallback.windowTokens),
    get maxOutputTokens() {
      return readFrom().maxOutputTokens;
    },
    complete: async (prompt, options: ReaderCompletionOptions) => {
      const through = (reader: ResolvedReader) => ({
        ...options,
        model: reader.model,
        ...(options.maxTokens !== undefined &&
        reader.maxOutputTokens !== undefined
          ? { maxTokens: Math.min(options.maxTokens, reader.maxOutputTokens) }
          : {}),
      });
      if (note) return fallback.complete(prompt, through(fallback));
      try {
        return await primary.complete(prompt, through(primary));
      } catch (error) {
        const why = readerFallbackReason(error);
        if (!why || options.signal?.aborted) throw error;
        // Concurrent calls may all fail the same way: one note, one switch.
        note = note || {
          type: "reader_fallback",
          chosen: describe(primary),
          usedInstead: describe(fallback),
          reason: why.reason,
          ...(why.status !== undefined ? { status: why.status } : {}),
        };
        return fallback.complete(prompt, through(fallback));
      }
    },
  };
  return {
    resolution: { ok: true, reader: base },
    fallbackNote: () => note,
  };
}
