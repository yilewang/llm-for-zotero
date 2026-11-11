/**
 * The model request behind an Inline Ask card: a short system message, the
 * paper and the selection as context, and the card's earlier turns as
 * history, streamed through the direct chat path (with its empty-output
 * recovery). One provider request scope serves every turn of one card; the
 * model is read for each turn, so a follow-up uses the model the user picked
 * in the card since the last answer.
 * No usage is recorded and nothing is saved.
 */
import type { ReasoningConfig } from "../../../shared/llm";
import type { PaperContextRef } from "../../../shared/types";
import type { callLLMStream, ChatParams } from "../../../utils/llmClient";
import {
  createProviderRequestScope,
  type ProviderRequestScope,
} from "../../../utils/providerTransport";
import {
  callDirectChatTurnWithRecovery,
  resolveEmptyModelOutcomeMessage,
} from "../directChatCompletion";
import type { InlineAskModelTarget } from "./inlineAskModel";
import type { InlineAskTurnRunner } from "./inlineAskSession";

export const INLINE_ASK_SYSTEM_MESSAGE = [
  "Inline Ask: the user selected a passage in a paper they are reading and asks a quick question about it.",
  "Answer briefly and directly about the selected passage; use the surrounding paper text only to explain it.",
  "Reply in the language of the user's question.",
  "Do not add citation markers, quote tokens, or source lists.",
].join(" ");

/** How long the card waits for the selection's surrounding text. */
export const INLINE_ASK_CONTEXT_TIMEOUT_MS = 2000;
/** The most page text a card sends when it falls back to the cached page. */
export const INLINE_ASK_PAGE_TEXT_MAX_CHARS = 6000;

export function buildInlineAskContext(input: {
  paper: Pick<PaperContextRef, "title" | "firstCreator" | "year"> | null;
  selectedText: string;
  pageLabel?: string;
  surroundingText?: string;
}): string {
  const sections: string[] = [];
  const paper = input.paper;
  if (paper?.title?.trim()) {
    const byline = [paper.firstCreator?.trim(), paper.year?.trim()]
      .filter(Boolean)
      .join(", ");
    sections.push(
      `Paper: ${paper.title.trim()}${byline ? ` (${byline})` : ""}`,
    );
  }
  const where = input.pageLabel?.trim()
    ? ` (page ${input.pageLabel.trim()})`
    : "";
  sections.push(`Selected passage${where}:\n"""\n${input.selectedText}\n"""`);
  if (input.surroundingText?.trim()) {
    sections.push(
      `Surrounding text from the paper:\n"""\n${input.surroundingText.trim()}\n"""`,
    );
  }
  return sections.join("\n\n");
}

/**
 * The text around the selection: the resolved anchor text when it arrives
 * within `timeoutMs`, otherwise the cached text of the selection's page.
 */
export async function resolveInlineAskSurroundingText(input: {
  resolveAnchorText: () => Promise<string>;
  getCachedPageText: () => string;
  timeoutMs: number;
}): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(""), input.timeoutMs);
  });
  let anchorText = "";
  try {
    anchorText = await Promise.race([
      input.resolveAnchorText().catch(() => ""),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (anchorText.trim()) return anchorText.trim();
  try {
    return (input.getCachedPageText() || "")
      .trim()
      .slice(0, INLINE_ASK_PAGE_TEXT_MAX_CHARS);
  } catch {
    return "";
  }
}

export type InlineAskTurnModel = {
  target: InlineAskModelTarget;
  reasoning?: ReasoningConfig;
};

export function createInlineAskTurnRunner(input: {
  /** The model and effort for the next turn; null when none can answer. */
  getModel: () => InlineAskTurnModel | null;
  getContext: () => Promise<string>;
  /** The card's answer when getModel gives null. */
  noModelMessage?: string;
  /** Test seam: the streaming call. */
  call?: typeof callLLMStream;
}): InlineAskTurnRunner {
  const requestScope: ProviderRequestScope = createProviderRequestScope();
  let context: Promise<string> | null = null;
  return async ({ prompt, history, signal, onDelta }) => {
    const model = input.getModel();
    if (!model) return { text: "", errorMessage: input.noModelMessage || "" };
    const { target } = model;
    context ||= input.getContext().catch(() => "");
    const request: ChatParams = {
      prompt,
      context: (await context) || undefined,
      history: history.map((message) => ({ ...message })),
      signal,
      model: target.model,
      apiBase: target.apiBase,
      apiKey: target.apiKey,
      authMode: target.authMode,
      providerProtocol: target.providerProtocol,
      reasoning: model.reasoning,
      temperature: target.advanced?.temperature,
      outputTokenLimit: target.advanced?.outputTokenLimit,
      inputTokenCap: target.advanced?.inputTokenCap,
      inputMode: target.advanced?.inputMode,
      profileOverride: target.advanced?.profileOverride as
        | ChatParams["profileOverride"]
        | undefined,
      systemMessages: [INLINE_ASK_SYSTEM_MESSAGE],
      requestScope,
    };
    const outcome = await callDirectChatTurnWithRecovery({
      request,
      onDelta,
      call: input.call,
    });
    if (outcome.text.trim()) return { text: outcome.text };
    return {
      text: "",
      errorMessage: resolveEmptyModelOutcomeMessage(outcome.completion),
    };
  };
}
