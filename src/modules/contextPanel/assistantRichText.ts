import { appLogger } from "../../core/logging";
import type { Message } from "./types";
import type { WebSourceAnchor } from "../../webAccess/types";
import { stripWebSourceMarkersForDisplay } from "../../webAccess/attribution";
import { sanitizeText } from "../../utils/textSanitization";
import { stripReceiptStatusForDisplay } from "../../agent/contracts/actionEvaluation";
import {
  buildQuoteExpandedMarkdown,
  buildQuoteRenderPlan,
  getAssistantRenderDisplay,
  type QuoteRenderOccurrence,
} from "./quoteRenderPlan";
import { stripPartialTrailingCitationToken } from "../../services/quotes/paragraphCitations";
import {
  decorateAssistantCitationLinks,
  renderQuoteCitationPlaceholders,
} from "./assistantCitationLinks";
import {
  decorateWebSourceIndicators,
  injectWebSourceAnchorTokens,
} from "./webSourceIndicators";
import { renderRenderedMarkdownInto } from "./renderedMarkdown";
import {
  disposeStreamingMarkdown,
  renderStreamingMarkdownInto,
} from "./streamingMarkdown";

export type AssistantCitationContext = {
  panelItem: Zotero.Item;
  assistantMessage: Message;
  pairedUserMessage?: Message | null;
};

export function buildAssistantDisplayMarkdownForRender(
  message: Pick<
    Message,
    "text" | "quoteCitations" | "quoteDisplayOverride" | "streaming"
  >,
  webSourceAnchors: readonly WebSourceAnchor[] = [],
): string {
  return buildAssistantDisplayRenderPlan(message, webSourceAnchors).markdown;
}

/** Same markdown, plus the occurrences its quote tokens refer to. */
export function buildAssistantDisplayRenderPlan(
  message: Pick<
    Message,
    "text" | "quoteCitations" | "quoteDisplayOverride" | "streaming"
  >,
  webSourceAnchors: readonly WebSourceAnchor[] = [],
  occurrenceIdScope?: string,
): { markdown: string; occurrences: QuoteRenderOccurrence[] } {
  const hasWebSources = webSourceAnchors.length > 0;
  const display = getAssistantRenderDisplay(message, { hasWebSources });
  // The action-status block the runtime appends is written for the model
  // that reads the transcript; the reader is shown the same receipts as
  // the summary card at the end of the trace.
  const markdown = stripReceiptStatusForDisplay(sanitizeText(display.markdown));
  // Quote cards are finalized after streaming. Until then, keep their text
  // readable instead of publishing an unresolved interactive-render token;
  // paragraph citations show nothing until their marks at the final render,
  // and neither does a token still being written at the tail.
  const input = {
    markdown: injectWebSourceAnchorTokens(
      stripWebSourceMarkersForDisplay(
        message.streaming
          ? stripPartialTrailingCitationToken(markdown)
          : markdown,
      ),
      webSourceAnchors,
    ),
    quoteCitations: display.quoteCitations,
    allowLegacyInference: !hasWebSources,
    occurrenceIdScope,
  };
  if (message.streaming) {
    return {
      markdown: buildQuoteExpandedMarkdown(input, {
        paragraphCitations: "omit",
      }),
      occurrences: [],
    };
  }
  const plan = buildQuoteRenderPlan(input);
  return { markdown: plan.displayMarkdown, occurrences: plan.occurrences };
}

export function decorateCompletedAssistantCitationLinks(
  params: AssistantCitationContext & {
    body: Element;
    bubble: HTMLDivElement;
    webSourceAnchors?: readonly WebSourceAnchor[];
  },
): void {
  const { assistantMessage, bubble } = params;
  if (assistantMessage.streaming || assistantMessage.compactMarker) return;
  if (!sanitizeText(bubble.textContent || assistantMessage.text || "").trim())
    return;
  try {
    renderQuoteCitationPlaceholders(params);
    // Library citations keep their chips beside the web and paper markers.
    decorateAssistantCitationLinks(params);
  } catch (error) {
    appLogger.warn("LLM citation decoration error:", error);
  }
}

/** Response/document surfaces share chat's provenance and interaction rules. */
export function renderAssistantRichText(
  params: AssistantCitationContext & {
    body: Element;
    bubble: HTMLDivElement;
    webSourceAnchors?: readonly WebSourceAnchor[];
    incremental?: boolean;
    onContentRendered?: () => void;
  },
): void {
  const doc = params.bubble.ownerDocument;
  const anchors = params.webSourceAnchors || [];
  const source = buildAssistantDisplayMarkdownForRender(
    params.assistantMessage,
    anchors,
  );
  const decorate = () => {
    decorateWebSourceIndicators(
      params.bubble,
      doc,
      anchors,
      params.assistantMessage.agentRunId,
    );
    decorateCompletedAssistantCitationLinks(params);
  };
  if (params.incremental && params.assistantMessage.streaming) {
    renderStreamingMarkdownInto(params.bubble, source, doc, () => {
      decorate();
      params.onContentRendered?.();
    });
  } else {
    disposeStreamingMarkdown(params.bubble);
    renderRenderedMarkdownInto(params.bubble, source, doc, {
      onAsyncContentRendered: params.onContentRendered,
    });
    decorate();
  }
}
