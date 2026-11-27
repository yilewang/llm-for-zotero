/**
 * The material the user put into a turn, rendered for the model: the open
 * note's content and the selected passages (each quote's text, source,
 * location, and the question attached to it, with the page text around a
 * PDF selection).
 *
 * The turn context envelope (turnContextEnvelope.ts) names what the turn
 * refers to; this module carries the content itself. Every runtime that
 * writes its own prompt text renders the material here, so a quote the user
 * attached reaches the model whichever runtime answers.
 */

import type { AgentRuntimeRequest } from "../types";
import type { PaperPromptContext } from "./paperPromptContext";
import { getSelectedPassagePaper } from "./turnPaperScope";
import { NOTE_EDITING_QUOTE_BLOCK_GUIDANCE } from "../../shared/quoteGuidance";
import {
  findNoteEmbedTokensInSelection,
  hasNoteEmbedTokens,
  NOTE_EMBED_PLACEHOLDER_GUIDANCE,
} from "../../utils/noteEmbeds";
import { formatPaperSourceLabel } from "../../services/paperContent/paperAttribution";
import {
  buildQuoteAnchorPromptBlock,
  buildSelectedTextQuoteCitations,
} from "../../services/quotes/quoteCitations";
import { synthesizeSelectedTextContexts } from "../../services/context/normalizers";
import {
  formatSelectedTextLocator,
  formatSelectedTextQuestionSuffix,
  isPromptOnlySelectedTextQuestions,
  renderSelectedTextAnchorContext,
  SELECTED_TEXT_QUESTIONS_INSTRUCTION,
} from "../../services/context/selectedTextAnchorFormatting";

export type TurnMaterialOptions = {
  /** Where selections lie in a preloaded map (paper prompt context). */
  selectionLocations?: PaperPromptContext["selectionLocations"];
  /**
   * The model can call paper_read this turn, so a selection's page hint
   * names the call. False in raw-PDF turns, which have no paper_read.
   */
  readCalls: boolean;
};

function selectedTextContextsOf(request: AgentRuntimeRequest) {
  return synthesizeSelectedTextContexts({
    selectedTextContexts: request.selectedTextContexts,
    selectedTexts: request.selectedTexts,
    selectedTextSources: request.selectedTextSources,
    selectedTextPaperContexts: (request.selectedTextContexts || []).map(
      (_context, index) =>
        getSelectedPassagePaper(request.turnPaperScope, index),
    ),
    selectedTextNoteContexts: request.selectedTextNoteContexts,
  });
}

function sourceLabelOf(source: string | undefined): string {
  switch (source) {
    case "model":
      return "model response";
    case "note":
      return "Zotero note";
    case "note-edit":
      return "active note editing focus";
    case "sidechat":
      return "side chat transcript";
    case "inlineask":
      return "Inline Ask transcript";
    default:
      return "PDF reader";
  }
}

function renderActiveNote(request: AgentRuntimeRequest): string[] {
  const note = request.activeNoteContext;
  if (!note) return [];
  const blocks = [
    `Current note content for this turn:\n"""\n${note.noteText}\n"""`,
    NOTE_EDITING_QUOTE_BLOCK_GUIDANCE,
  ];
  if (hasNoteEmbedTokens(note.noteText))
    blocks.push(NOTE_EMBED_PLACEHOLDER_GUIDANCE);
  if (note.noteHtml) {
    blocks.push(`Original note HTML:\n"""\n${note.noteHtml}\n"""`);
  }
  return blocks;
}

function renderSelectedTexts(
  request: AgentRuntimeRequest,
  options: TurnMaterialOptions,
): string[] {
  const selectedTextContexts = selectedTextContextsOf(request);
  if (!selectedTextContexts.length) return [];
  const selectedTexts = selectedTextContexts.map((context) => context.text);
  const selectedTextSources = selectedTextContexts.map(
    (context) => context.source,
  );
  const selectedTextPaperContexts = selectedTextContexts.map(
    (_context, index) => getSelectedPassagePaper(request.turnPaperScope, index),
  );
  const anchorsByIndex = new Map(
    (request.resolvedSelectedTextAnchors || []).map((anchor) => [
      anchor.contextIndex,
      anchor,
    ]),
  );
  const quoteAnchors = buildQuoteAnchorPromptBlock(
    buildSelectedTextQuoteCitations(
      selectedTexts,
      selectedTextSources,
      selectedTextPaperContexts,
    ),
  );
  const quotes = selectedTexts
    .map((entry, index) => {
      const source = selectedTextSources[index];
      const paperContext = selectedTextPaperContexts[index];
      const noteContext = selectedTextContexts[index]?.noteContext;
      const sourceMeta =
        source === "pdf" && paperContext
          ? `, paper=${paperContext.title}, source_label=${formatPaperSourceLabel(paperContext)}`
          : source === "note-edit" && noteContext
            ? [
                `, note=${noteContext.title}`,
                noteContext.noteItemId
                  ? `note_id=${noteContext.noteItemId}`
                  : "",
                `note_kind=${noteContext.noteKind}`,
                noteContext.parentItemId
                  ? `parent_item_id=${noteContext.parentItemId}`
                  : "",
              ]
                .filter(Boolean)
                .join(", ")
            : "";
      const locator = formatSelectedTextLocator(
        selectedTextContexts[index],
        anchorsByIndex.get(index),
      );
      const question = formatSelectedTextQuestionSuffix(
        selectedTextContexts[index]?.userQuery,
      );
      const embedTokens =
        source === "note-edit" && request.activeNoteContext
          ? findNoteEmbedTokensInSelection(
              request.activeNoteContext.noteText,
              entry,
            )
          : [];
      const embedHint = embedTokens.length
        ? `\nThis selection contains embedded note items. Keep each placeholder in your replacement where its item belongs: ${embedTokens.join(" ")}`
        : "";
      return `Selected text ${index + 1} [source=${sourceLabelOf(source)}${sourceMeta}]${locator ? ` ${locator}` : ""}:\n"""\n${entry}\n"""${question}${embedHint}`;
    })
    .join("\n\n");
  const blocks = [[...quoteAnchors, quotes].filter(Boolean).join("\n\n")];
  const anchorContext = renderSelectedTextAnchorContext({
    selectedTextContexts,
    // The turn scope holds each passage's paper; the page hint's read call
    // names it when it owns the anchor's attachment.
    anchors: (request.resolvedSelectedTextAnchors || []).map((anchor) => {
      const paper = selectedTextPaperContexts[anchor.contextIndex];
      return paper?.contextItemId === anchor.contextItemId
        ? { ...anchor, paperContext: paper }
        : anchor;
    }),
    locations: options.selectionLocations,
    readCalls: options.readCalls,
  });
  if (anchorContext) blocks.push(anchorContext);
  return blocks;
}

/**
 * The turn's material as prompt blocks, in order: the open note, then the
 * selected passages and the page text around them. Empty when the user
 * attached neither.
 */
export function renderTurnMaterialForModel(
  request: AgentRuntimeRequest,
  options: TurnMaterialOptions,
): string[] {
  return [
    ...renderActiveNote(request),
    ...renderSelectedTexts(request, options),
  ];
}

/**
 * The user's request as the prompt states it. A send from an empty composer
 * carries only the questions attached to the selections, which the
 * material already shows under each quote, so a short instruction replaces
 * them instead of repeating them.
 */
export function resolveTurnUserRequestText(
  request: AgentRuntimeRequest,
): string {
  return isPromptOnlySelectedTextQuestions(
    request.userText,
    selectedTextContextsOf(request),
  )
    ? SELECTED_TEXT_QUESTIONS_INSTRUCTION
    : request.userText;
}
