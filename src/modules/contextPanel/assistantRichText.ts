import type { Message } from "./types";
import type { WebSourceAnchor } from "../../webAccess/types";
import { stripWebSourceMarkersForDisplay } from "../../webAccess/attribution";
import { sanitizeText } from "./textUtils";
import {
  buildQuoteDisplayMarkdown,
  buildQuoteExpandedMarkdown,
  getMessageQuoteDisplay,
} from "./quoteRenderPlan";
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
  const hasWebSources = webSourceAnchors.length > 0;
  const display = hasWebSources
    ? { markdown: message.text || "", quoteCitations: message.quoteCitations }
    : getMessageQuoteDisplay(message);
  // Quote cards are finalized after streaming. Until then, keep their text
  // readable instead of publishing an unresolved interactive-render token.
  const buildDisplay = message.streaming
    ? buildQuoteExpandedMarkdown
    : buildQuoteDisplayMarkdown;
  return buildDisplay({
    markdown: injectWebSourceAnchorTokens(
      stripWebSourceMarkersForDisplay(sanitizeText(display.markdown)),
      webSourceAnchors,
    ),
    quoteCitations: display.quoteCitations,
    allowLegacyInference: !hasWebSources,
  });
}

export function decorateCompletedAssistantCitationLinks(
  params: AssistantCitationContext & {
    body: Element;
    bubble: HTMLDivElement;
    webSourceAnchors?: readonly WebSourceAnchor[];
  },
): void {
  const { assistantMessage, bubble, webSourceAnchors = [] } = params;
  if (assistantMessage.streaming || assistantMessage.compactMarker) return;
  if (!sanitizeText(bubble.textContent || assistantMessage.text || "").trim())
    return;
  try {
    renderQuoteCitationPlaceholders(params);
    if (!webSourceAnchors.length) decorateAssistantCitationLinks(params);
  } catch (error) {
    ztoolkit.log("LLM citation decoration error:", error);
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
    decorateWebSourceIndicators(params.bubble, doc, anchors);
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
