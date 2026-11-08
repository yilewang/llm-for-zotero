import { getAbortController } from "../utils/apiHelpers";
import type {
  ReaderCompletion,
  ReaderCompletionUsage,
} from "../shared/readerCompletion";
import { claudeBridgeFetch } from "./bridgeProcess";
import { getClaudeBridgeUrl } from "./prefs";

export const STRUCTURED_COMPLETION_CAPABILITY = "structured_completion_v1";
/** One reader call: a long paper batch can take minutes on a subscription. */
export const CLAUDE_BRIDGE_COMPLETION_TIMEOUT_MS = 180_000;
/** The bridge refuses a deadline above this. */
const BRIDGE_MAX_TIMEOUT_MS = 300_000;
const BRIDGE_MIN_TIMEOUT_MS = 1_000;
/** The bridge answers its own deadline first; this only guards a hung socket. */
const CLIENT_DEADLINE_GRACE_MS = 15_000;

function abortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

function readCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function readUsage(value: unknown): ReaderCompletionUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const inputTokens = readCount(record.inputTokens);
  const outputTokens = readCount(record.outputTokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const cacheCreationInputTokens = readCount(record.cacheCreationInputTokens);
  const cacheReadInputTokens = readCount(record.cacheReadInputTokens);
  const model =
    typeof record.model === "string" && record.model.trim()
      ? record.model.trim()
      : undefined;
  return {
    inputTokens,
    outputTokens,
    ...(cacheCreationInputTokens !== undefined
      ? { cacheCreationInputTokens }
      : {}),
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(model ? { model } : {}),
  };
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed?.error === "string" && parsed.error.trim()) {
        return parsed.error.trim();
      }
    } catch {
      // Not JSON: fall through to the raw text.
    }
    return text.trim().slice(0, 500);
  } catch {
    return "";
  }
}

/**
 * The Claude Code bridge as a reader completion: one tool-free query on the
 * user's Claude login (`POST /structured-completion`).
 *
 * The bridge accepts a prompt, a model and a deadline only. System messages
 * are folded into the prompt; reasoning, temperature and maxTokens are not
 * sent. A failed call throws an Error whose message starts with the HTTP
 * status, so the reader's rate-limit backoff (429) recognizes it.
 */
export function createClaudeBridgeCompletion(
  params: {
    /** Defaults to the configured bridge URL, read at call time. */
    bridgeUrl?: () => string;
    fetchImpl?: typeof fetch;
    defaultTimeoutMs?: number;
  } = {},
): ReaderCompletion {
  const fetchImpl = params.fetchImpl ?? (claudeBridgeFetch as typeof fetch);
  const getBaseUrl = params.bridgeUrl ?? getClaudeBridgeUrl;
  let capabilityConfirmed = false;

  return async (prompt, options) => {
    const model = (options.model || "").trim();
    if (!model) {
      throw new Error(
        "A concrete Claude model is required for tool-free reader completions",
      );
    }
    const systemText = (options.systemMessages || [])
      .map((message) => message.trim())
      .filter(Boolean)
      .join("\n\n");
    const fullPrompt = systemText ? `${systemText}\n\n${prompt}` : prompt;
    if (!fullPrompt.trim()) {
      throw new Error("A prompt is required for a reader completion");
    }
    if (options.signal?.aborted) throw abortError();

    const timeoutMs = Math.min(
      BRIDGE_MAX_TIMEOUT_MS,
      Math.max(
        BRIDGE_MIN_TIMEOUT_MS,
        Math.floor(
          options.timeoutMs ??
            params.defaultTimeoutMs ??
            CLAUDE_BRIDGE_COMPLETION_TIMEOUT_MS,
        ),
      ),
    );
    const base = getBaseUrl().replace(/\/+$/, "");
    const Controller = getAbortController();
    const controller = Controller ? new Controller() : undefined;
    let timedOut = false;
    const abort = () => controller?.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = controller
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs + CLIENT_DEADLINE_GRACE_MS)
      : undefined;
    try {
      if (!capabilityConfirmed) {
        const health = await fetchImpl(`${base}/healthz`, {
          signal: controller?.signal,
        });
        if (!health.ok) {
          throw new Error(
            `${health.status} The Claude Code bridge did not answer its health check`,
          );
        }
        const body = (await health.json()) as { capabilities?: unknown };
        const capabilities = Array.isArray(body?.capabilities)
          ? body.capabilities
          : [];
        if (!capabilities.includes(STRUCTURED_COMPLETION_CAPABILITY)) {
          throw new Error(
            "The Claude Code bridge cannot run tool-free completions (structured_completion_v1 is missing). Update the bridge.",
          );
        }
        capabilityConfirmed = true;
      }
      const response = await fetchImpl(`${base}/structured-completion`, {
        method: "POST",
        signal: controller?.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: fullPrompt, model, timeoutMs }),
      });
      if (!response.ok) {
        const detail = await readErrorDetail(response);
        throw new Error(
          `${response.status} ${detail || "The Claude Code bridge could not complete the request"}`,
        );
      }
      const result = (await response.json()) as {
        text?: unknown;
        usage?: unknown;
      };
      if (typeof result.text !== "string" || !result.text.trim()) {
        throw new Error("The Claude Code bridge returned an empty completion");
      }
      const usage = readUsage(result.usage);
      return usage ? { text: result.text, usage } : { text: result.text };
    } catch (error) {
      if (options.signal?.aborted) throw abortError();
      if (timedOut) {
        throw new Error(
          `The Claude Code bridge did not answer within ${Math.round(timeoutMs / 1000)} seconds`,
        );
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  };
}
