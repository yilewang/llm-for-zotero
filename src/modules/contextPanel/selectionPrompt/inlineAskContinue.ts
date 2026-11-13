/**
 * Inline Ask's Continue in sidebar, on the card's side: the request the
 * reader panel gets (the selection, the finished turns, the model that
 * answered) and the reason the card shows when the panel did not take it.
 * The caller reaches the panel (reveals the reader's chat, finds its handle).
 */
import type { SelectedTextContext } from "../../../shared/types";
import { t } from "../../../utils/i18n";
import type {
  SeedPaperConversationFailure,
  SeedPaperConversationInput,
  SeedPaperConversationResult,
  SeededConversationModel,
} from "../seededConversation";
import type {
  InlineAskContinueInSidebar,
  InlineAskContinueTurn,
} from "./inlineAskOverlay";
import type { InlineAskPopupSnapshot } from "./inlineAskSnapshot";

/** Runs the request in the reader's panel; null when no panel was reached. */
export type InlineAskPanelReach = (
  input: SeedPaperConversationInput,
) => Promise<SeedPaperConversationResult | null>;

export function buildInlineAskContinueInput(
  snapshot: InlineAskPopupSnapshot,
  model: SeededConversationModel | null,
  turns: InlineAskContinueTurn[],
): SeedPaperConversationInput {
  const selectedTextContext: SelectedTextContext = {
    text: snapshot.selectedText,
    source: "pdf",
    contextItemId: snapshot.readerItemId,
  };
  if (snapshot.pageIndex !== null) {
    selectedTextContext.pageIndex = snapshot.pageIndex;
  }
  if (snapshot.pageLabel) selectedTextContext.pageLabel = snapshot.pageLabel;
  if (snapshot.paperContext) {
    selectedTextContext.paperContext = { ...snapshot.paperContext };
  }
  const input: SeedPaperConversationInput = {
    selectedTextContext,
    turns: turns.map((turn) => ({ role: turn.role, text: turn.text })),
  };
  if (snapshot.paperContext) input.paperItemId = snapshot.paperContext.itemId;
  if (model) input.model = { ...model };
  return input;
}

/** "unreachable": no panel answered (none mounted, even after revealing). */
export function inlineAskContinueFailureText(
  reason: SeedPaperConversationFailure | "unreachable",
): string {
  switch (reason) {
    case "busy":
      return t("The sidebar is answering. Try again when it finishes.");
    case "webchat":
      return t("Continue in sidebar does not work in WebChat mode.");
    case "failed":
      return t("The conversation could not be saved to the sidebar.");
    case "unavailable":
    case "unreachable":
      return t(
        "The sidebar chat for this PDF is not available. Open it and try again.",
      );
  }
}

export function createInlineAskContinueInSidebar(params: {
  snapshot: InlineAskPopupSnapshot;
  /** The model that answered, read when the user continues. */
  getModel: () => SeededConversationModel | null;
  reachPanel: InlineAskPanelReach;
}): InlineAskContinueInSidebar {
  return async (turns) => {
    const result = await params.reachPanel(
      buildInlineAskContinueInput(params.snapshot, params.getModel(), turns),
    );
    if (!result)
      return { ok: false, error: inlineAskContinueFailureText("unreachable") };
    if (result.ok) return { ok: true };
    return { ok: false, error: inlineAskContinueFailureText(result.reason) };
  };
}
