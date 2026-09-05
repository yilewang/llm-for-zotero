/**
 * Auto-summary cache for non-agent chat mode.
 *
 * Strategy
 * --------
 * When a conversation's LLM history grows past SUMMARY_TRIGGER_PAIRS Q&A pairs,
 * the oldest messages are compressed into a "Previous conversation" block:
 *
 *  1. Immediate rule-based compression is applied synchronously so no request
 *     is ever blocked.
 *  2. After each response completes, a background LLM call generates a richer
 *     natural-language summary which is stored in the cache.
 *  3. On the next request the richer summary replaces the rule-based one,
 *     gradually improving as the conversation lengthens.
 *
 * The compressed history is delivered as a [{ role:"user" }, { role:"assistant" }]
 * pair at the start of the history so it is compatible with all model APIs.
 */

import type { ChatMessage, ChatParams } from "../../utils/llmClient";
import { fingerprintSecret } from "../../utils/secretFingerprint";
import {
  callUtilityLLM,
  describeUtilityLLMFailure,
  type UtilityLLMFailure,
  type UtilityLLMFailureReason,
  type UtilityLLMParams,
} from "../../utils/utilityLLM";
import type { ModelProfileOverride } from "../../modelCapabilities";
import { sanitizeText } from "./textUtils";

// --- tunables ---
/** Start compressing once the history has this many Q&A pairs. */
export const SUMMARY_TRIGGER_PAIRS = 10;
/** Keep this many recent pairs verbatim after compression. */
export const SUMMARY_RETAIN_PAIRS = 5;
/**
 * Longest a background summary may run.
 *
 * Deliberately above the 20s the turn classifier allows: this has the largest
 * input of any internal call and it grows by two messages every turn, and
 * unlike the classifier nothing waits on the result. Kept below the 60s tier
 * because an in-flight summary suppresses the next turn's attempt.
 */
export const SUMMARY_TIMEOUT_MS = 30_000;
/**
 * Consecutive failures tolerated for the same config before the conversation
 * stops trying. Reasons that cannot change on a retry latch on the first one.
 */
const MAX_SUMMARY_ATTEMPTS = 2;
/** Max characters taken from each user turn for rule-based summary. */
const USER_EXCERPT_LEN = 250;
/** Max characters taken from each assistant turn for rule-based summary. */
const ASSISTANT_EXCERPT_LEN = 400;

// --- internal types ---
type SummaryEntry = {
  /** Human-readable summary text. */
  text: string;
  /**
   * Number of messages from the start of history that are covered by this
   * summary.  Used to detect whether the cache is still valid.
   */
  coversCount: number;
};

type LLMConfig = {
  model?: string;
  apiBase?: string;
  apiKey?: string;
  authMode?: ChatParams["authMode"];
  providerProtocol?: ChatParams["providerProtocol"];
  profileOverride?: ModelProfileOverride;
  /** Test seam: replaces the actual model call. */
  llmCall?: UtilityLLMParams["llmCall"];
};

type SummaryFailure = {
  configKey: string;
  reason: UtilityLLMFailureReason;
  attempts: number;
};

// --- module-level cache ---
const summaryCache = new Map<number, SummaryEntry>();
/** Tracks in-flight background summarisation tasks to avoid duplicates. */
const pendingSummaries = new Map<number, Promise<void>>();
/**
 * Conversations that have stopped attempting a summary, and the config they
 * gave up on. Without this a hard failure re-fires on every single turn
 * forever, because nothing is ever written to `summaryCache` to stop it.
 */
const summaryFailures = new Map<number, SummaryFailure>();

/**
 * Identity of everything that could change the outcome of a retry.
 *
 * Conversation length is deliberately absent: it grows every turn, so keying
 * on it would reset the latch every turn and make this a no-op. Switching
 * model, endpoint, credential or profile is what genuinely warrants another
 * try — and each of those changes this key.
 */
function buildSummaryConfigKey(llmConfig: LLMConfig): string {
  return [
    llmConfig.model || "",
    llmConfig.apiBase || "",
    llmConfig.authMode || "",
    llmConfig.providerProtocol || "",
    `auth=${fingerprintSecret(llmConfig.apiKey || "")}`,
    `profile=${JSON.stringify(llmConfig.profileOverride ?? null)}`,
  ].join("\u0000");
}

/**
 * How many times a reason is worth retrying.
 *
 * A timeout latches immediately rather than getting the extra attempt a
 * transport blip earns: the message set only grows, so a request that timed
 * out at this length is strictly harder next turn, not likelier to succeed.
 */
function attemptsAllowedFor(reason: UtilityLLMFailureReason): number {
  return reason === "transport" || reason === "empty"
    ? MAX_SUMMARY_ATTEMPTS
    : 1;
}

function recordSummaryFailure(
  key: number,
  configKey: string,
  failure: UtilityLLMFailure,
): void {
  const previous = summaryFailures.get(key);
  const attempts =
    previous && previous.configKey === configKey ? previous.attempts + 1 : 1;
  summaryFailures.set(key, { configKey, reason: failure.reason, attempts });
  if (attempts >= attemptsAllowedFor(failure.reason)) {
    // Logged once, at the point the conversation gives up — logging every
    // attempt would reintroduce the per-turn noise this exists to remove.
    if (typeof ztoolkit !== "undefined") {
      ztoolkit.log(
        `LLM: conversation ${key} stopped attempting background summaries after ${attempts} failure(s)`,
        describeUtilityLLMFailure(failure),
      );
    }
  }
}

function summaryAttemptsExhausted(key: number, configKey: string): boolean {
  const failure = summaryFailures.get(key);
  if (!failure || failure.configKey !== configKey) return false;
  return failure.attempts >= attemptsAllowedFor(failure.reason);
}

// --- public API ---

export function getConversationSummaryEntry(
  conversationKey: number,
): SummaryEntry | undefined {
  return summaryCache.get(Math.floor(conversationKey));
}

export function clearConversationSummary(conversationKey: number): void {
  summaryCache.delete(Math.floor(conversationKey));
  pendingSummaries.delete(Math.floor(conversationKey));
  // A new conversation can reuse a numeric key, and must not inherit a latch.
  summaryFailures.delete(Math.floor(conversationKey));
}

/** Test seam: awaits every in-flight background summary. */
export async function flushPendingSummaries(): Promise<void> {
  await Promise.all([...pendingSummaries.values()]);
}

/** Test seam: module state outlives a single mocha file otherwise. */
export function resetConversationSummaryStateForTests(): void {
  summaryCache.clear();
  pendingSummaries.clear();
  summaryFailures.clear();
}

/**
 * Applies history compression when needed.
 *
 * Returns the (possibly compressed) message array to pass to the LLM.
 * Returns the original array unchanged when it is short enough.
 */
export function applyHistoryCompression(
  conversationKey: number,
  messages: ChatMessage[],
): ChatMessage[] {
  const totalPairs = Math.floor(messages.length / 2);
  if (totalPairs <= SUMMARY_TRIGGER_PAIRS) return messages;

  const retainCount = SUMMARY_RETAIN_PAIRS * 2;
  const splitAt = messages.length - retainCount;
  const toSummarize = messages.slice(0, splitAt);
  const toKeep = messages.slice(splitAt);

  const cached = summaryCache.get(Math.floor(conversationKey));
  const summaryText =
    cached && cached.coversCount >= toSummarize.length
      ? cached.text
      : buildRuleBasedSummary(toSummarize);

  // Inject summary as a synthetic Q&A pair at the start so all model
  // APIs (which require alternating user/assistant) stay happy.
  const summaryPair: ChatMessage[] = [
    {
      role: "user",
      content: `[Earlier conversation — summarised]\n${summaryText}`,
    },
    {
      role: "assistant",
      content: "Understood. I have the earlier conversation context.",
    },
  ];
  return [...summaryPair, ...toKeep];
}

/**
 * Triggers a background LLM summary generation for the messages that would
 * be compressed next time.  Safe to call fire-and-forget.
 */
export function scheduleLLMSummary(
  conversationKey: number,
  messages: ChatMessage[],
  llmConfig: LLMConfig,
): void {
  const key = Math.floor(conversationKey);
  const totalPairs = Math.floor(messages.length / 2);
  if (totalPairs <= SUMMARY_TRIGGER_PAIRS) return;
  if (pendingSummaries.has(key)) return;

  const retainCount = SUMMARY_RETAIN_PAIRS * 2;
  const splitAt = messages.length - retainCount;
  const toSummarize = messages.slice(0, splitAt);

  const cached = summaryCache.get(key);
  if (cached && cached.coversCount >= toSummarize.length) return;

  const configKey = buildSummaryConfigKey(llmConfig);
  if (summaryAttemptsExhausted(key, configKey)) return;

  const task = (async () => {
    try {
      const result = await generateLLMSummary(toSummarize, llmConfig);
      if (result.ok) {
        summaryFailures.delete(key);
        if (result.text) {
          summaryCache.set(key, {
            text: result.text,
            coversCount: toSummarize.length,
          });
        }
      } else {
        recordSummaryFailure(key, configKey, result.failure);
      }
    } catch {
      // background task — errors are silently ignored
    } finally {
      pendingSummaries.delete(key);
    }
  })();
  pendingSummaries.set(key, task);
}

// --- internal helpers ---

function buildRuleBasedSummary(messages: ChatMessage[]): string {
  const pairs: string[] = [];
  for (let i = 0; i + 1 < messages.length; i += 2) {
    const user = messages[i];
    const assistant = messages[i + 1];
    if (!user || !assistant) continue;
    const userText = sanitizeText(
      typeof user.content === "string" ? user.content : "",
    ).slice(0, USER_EXCERPT_LEN);
    const assistantText = sanitizeText(
      typeof assistant.content === "string" ? assistant.content : "",
    ).slice(0, ASSISTANT_EXCERPT_LEN);
    pairs.push(
      `User: ${userText}${userText.length >= USER_EXCERPT_LEN ? "…" : ""}\n` +
        `Assistant: ${assistantText}${assistantText.length >= ASSISTANT_EXCERPT_LEN ? "…" : ""}`,
    );
  }
  if (!pairs.length) return "";
  return `Earlier conversation (${pairs.length} exchange${pairs.length === 1 ? "" : "s"}):\n\n${pairs.join("\n\n")}`;
}

type SummaryAttempt =
  | { ok: true; text: string }
  | { ok: false; failure: UtilityLLMFailure };

async function generateLLMSummary(
  messages: ChatMessage[],
  llmConfig: LLMConfig,
): Promise<SummaryAttempt> {
  const excerpts = buildRuleBasedSummary(messages);
  // Nothing to summarise is a success with no text, not a failed attempt —
  // it must never count toward the failure latch.
  if (!excerpts) return { ok: true, text: "" };

  const prompt =
    "Summarise the following conversation exchanges in 3–6 concise bullet points. " +
    "Focus on the key questions asked, main findings, and any conclusions reached. " +
    "Be factual and specific — preserve paper titles, author names, and technical terms.\n\n" +
    excerpts;

  const result = await callUtilityLLM({
    prompt,
    model: llmConfig.model,
    apiBase: llmConfig.apiBase,
    apiKey: llmConfig.apiKey,
    authMode: llmConfig.authMode,
    providerProtocol: llmConfig.providerProtocol,
    profileOverride: llmConfig.profileOverride,
    temperature: 0,
    jsonBudget: 400,
    timeoutMs: SUMMARY_TIMEOUT_MS,
    llmCall: llmConfig.llmCall,
    systemMessages: [
      "You are a precise summariser. Output only the bullet-point summary, nothing else.",
    ],
  });
  if (!result.ok) return { ok: false, failure: result };
  const summary = sanitizeText(result.text).trim();
  return {
    ok: true,
    text: summary ? `Earlier conversation summary:\n${summary}` : "",
  };
}
