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

import type { ChatMessage } from "../../utils/llmClient";
import { callLLMStream } from "../../utils/llmClient";
import { sanitizeText } from "./textUtils";

// --- tunables ---
/** Start compressing once the history has this many Q&A pairs. */
export const SUMMARY_TRIGGER_PAIRS = 10;
/** Keep this many recent pairs verbatim after compression. */
export const SUMMARY_RETAIN_PAIRS = 5;
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
  authMode?: string;
};

// --- module-level cache ---
const summaryCache = new Map<number, SummaryEntry>();
/** Tracks in-flight background summarisation tasks to avoid duplicates. */
const pendingSummaries = new Set<number>();

// --- public API ---

export function getConversationSummaryEntry(
  conversationKey: number,
): SummaryEntry | undefined {
  return summaryCache.get(Math.floor(conversationKey));
}

export function clearConversationSummary(conversationKey: number): void {
  summaryCache.delete(Math.floor(conversationKey));
  pendingSummaries.delete(Math.floor(conversationKey));
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

  pendingSummaries.add(key);
  void (async () => {
    try {
      const summaryText = await generateLLMSummary(toSummarize, llmConfig);
      if (summaryText) {
        summaryCache.set(key, {
          text: summaryText,
          coversCount: toSummarize.length,
        });
      }
    } catch {
      // background task — errors are silently ignored
    } finally {
      pendingSummaries.delete(key);
    }
  })();
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

async function generateLLMSummary(
  messages: ChatMessage[],
  llmConfig: LLMConfig,
): Promise<string> {
  const excerpts = buildRuleBasedSummary(messages);
  if (!excerpts) return "";

  const prompt =
    "Summarise the following conversation exchanges in 3–6 concise bullet points. " +
    "Focus on the key questions asked, main findings, and any conclusions reached. " +
    "Be factual and specific — preserve paper titles, author names, and technical terms.\n\n" +
    excerpts;

  let result = "";
  await callLLMStream(
    {
      prompt,
      context: "",
      history: [],
      systemMessages: [
        "You are a precise summariser. Output only the bullet-point summary, nothing else.",
      ],
      model: llmConfig.model,
      apiBase: llmConfig.apiBase,
      apiKey: llmConfig.apiKey,
      authMode: llmConfig.authMode as Parameters<
        typeof callLLMStream
      >[0]["authMode"],
      maxTokens: 400,
    },
    (delta) => {
      result += delta;
    },
  );
  return sanitizeText(result).trim()
    ? `Earlier conversation summary:\n${sanitizeText(result).trim()}`
    : "";
}
