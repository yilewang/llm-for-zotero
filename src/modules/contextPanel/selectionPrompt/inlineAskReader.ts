/**
 * Opens an Inline Ask card for a reader text selection: resolves the model
 * (inlineAskModel.ts) and reasoning effort from the sidebar's choices, builds
 * the turn runner with the paper and selection context, and mounts the card.
 *
 * The card keeps a snapshot taken when Zotero showed the selection popup:
 * the annotation draft, the reader item, and the paper context. Save as
 * annotation (M2) works from that snapshot.
 */
import type { ReasoningConfig } from "../../../shared/llm";
import { buildCodexReasoningConfig } from "../../../codex/catalogSelection";
import {
  getCodexDirectCatalogModel,
  getCodexDirectCatalogSnapshot,
  reconcileCodexDirectReasoningChoice,
} from "../../../codexAuth/modelCatalog";
import { getCachedPageTextForAttachment } from "../../../services/pdf/livePdfSelectionLocator";
import { getAbortController } from "../../../utils/apiHelpers";
import { t } from "../../../utils/i18n";
import { getModelProviderGroups } from "../../../utils/modelProviders";
import { getSelectedReasoningForItem } from "../chat";
import { getAvailableModelEntries } from "../prefHelpers";
import { resolveSelectedTextAnchors } from "../selectedTextAnchors";
import {
  getSelectedModelEntryForSurface,
  surfaceChoices,
} from "../surfaceChoices";
import {
  resolveInlineAskModelTarget,
  type InlineAskModelTarget,
} from "./inlineAskModel";
import {
  openInlineAskOverlay,
  type InlineAskModelLine,
  type InlineAskOverlayHandle,
} from "./inlineAskOverlay";
import { getInlineAskQuickPrompts } from "./inlineAskPrompts";
import {
  buildInlineAskContext,
  createInlineAskTurnRunner,
  INLINE_ASK_CONTEXT_TIMEOUT_MS,
  resolveInlineAskSurroundingText,
} from "./inlineAskRequest";
import type { InlineAskPopupSnapshot } from "./inlineAskSnapshot";
import type { ReaderOverlayAnchor } from "./readerOverlayShared";

/** The reader sidebar panels are the "embedded" selection surface. */
const READER_SURFACE = "embedded" as const;

export type InlineAskCardHandle = InlineAskOverlayHandle & {
  snapshot: InlineAskPopupSnapshot;
};

export type InlineAskModelChoice = {
  target: InlineAskModelTarget;
  reasoning?: ReasoningConfig;
  line: InlineAskModelLine;
};

/** The model, effort and model line for a card opened now. */
export function resolveInlineAskModelChoice(
  reasoningItemId: number,
): InlineAskModelChoice | null {
  const target = resolveInlineAskModelTarget({
    conversationSystem: surfaceChoices.conversationSystem.get(READER_SURFACE),
    sidebarEntry: getSelectedModelEntryForSurface(READER_SURFACE),
    entries: getAvailableModelEntries(),
    codexDirect: {
      configured: getModelProviderGroups().some(
        (group) =>
          group.authMode === "codex_auth" &&
          group.models.some((row) => row.model.trim()),
      ),
      runtimeModel: surfaceChoices.codexRuntimeModel.get(READER_SURFACE),
      isModelAvailable: (model) =>
        getCodexDirectCatalogSnapshot().status !== "ready" ||
        Boolean(getCodexDirectCatalogModel(model)),
    },
  });
  if (!target) return null;
  let reasoning: ReasoningConfig | undefined;
  let effort: string | undefined;
  if (target.authMode === "codex_auth") {
    const stored =
      target.source === "codex_runtime"
        ? surfaceChoices.codexReasoningMode.get(READER_SURFACE)
        : surfaceChoices.codexDirectReasoningSelection.get(
            target.model,
            READER_SURFACE,
          );
    const selection = reconcileCodexDirectReasoningChoice(target.model, stored);
    reasoning = buildCodexReasoningConfig(selection);
    effort = selection;
  } else {
    reasoning = getSelectedReasoningForItem(
      reasoningItemId,
      target.model,
      target.apiBase,
      target.providerProtocol,
      target.advanced?.profileOverride as Parameters<
        typeof getSelectedReasoningForItem
      >[4],
      READER_SURFACE,
    );
    effort = reasoning?.level;
  }
  return {
    target,
    reasoning,
    line: {
      label: target.displayLabel,
      effort,
      title: `${target.providerLabel} · ${target.model}`,
    },
  };
}

function readCachedPageText(
  contextItemId: number,
  pageIndex: number | null,
): string {
  if (pageIndex === null) return "";
  const cache = getCachedPageTextForAttachment(contextItemId);
  return cache?.pages.find((page) => page.pageIndex === pageIndex)?.text || "";
}

async function resolveAnchorText(
  snapshot: InlineAskPopupSnapshot,
): Promise<string> {
  const anchors = await resolveSelectedTextAnchors({
    selectedTextContexts: [
      {
        text: snapshot.selectedText,
        source: "pdf",
        paperContext: snapshot.paperContext || undefined,
        contextItemId: snapshot.readerItemId,
        pageIndex: snapshot.pageIndex ?? undefined,
        pageLabel: snapshot.pageLabel,
      },
    ],
    paperContexts: snapshot.paperContext ? [snapshot.paperContext] : [],
  });
  return anchors
    .map((anchor) => anchor.contextText || "")
    .filter((text) => text.trim())
    .join("\n\n");
}

export function openInlineAskCardForReader(params: {
  doc: Document;
  anchor: ReaderOverlayAnchor;
  snapshot: InlineAskPopupSnapshot;
  /** The item whose selected reasoning level applies (the paper). */
  reasoningItemId: number;
}): InlineAskCardHandle {
  const { snapshot } = params;
  const choice = resolveInlineAskModelChoice(params.reasoningItemId);
  const runTurn = choice
    ? createInlineAskTurnRunner({
        target: choice.target,
        reasoning: choice.reasoning,
        getContext: async () =>
          buildInlineAskContext({
            paper: snapshot.paperContext,
            selectedText: snapshot.selectedText,
            pageLabel: snapshot.pageLabel,
            surroundingText: await resolveInlineAskSurroundingText({
              resolveAnchorText: () => resolveAnchorText(snapshot),
              getCachedPageText: () =>
                readCachedPageText(snapshot.readerItemId, snapshot.pageIndex),
              timeoutMs: INLINE_ASK_CONTEXT_TIMEOUT_MS,
            }),
          }),
      })
    : async () => ({
        text: "",
        errorMessage: t("Inline Ask needs an API model."),
      });
  const handle = openInlineAskOverlay({
    doc: params.doc,
    anchor: params.anchor,
    selectedText: snapshot.selectedText,
    prompts: getInlineAskQuickPrompts(),
    model: choice?.line ?? null,
    labels: {
      selectedText: t("Selected text"),
      placeholder: t("Ask about this selection…"),
      followUpPlaceholder: t("Ask a follow-up…"),
      hint: t("Enter to send · Shift+Enter for a new line · Esc to close"),
      send: t("Send"),
      reading: t("Reading the selection…"),
      discard: t("Discard"),
      continueInSidebar: t("Continue in sidebar"),
      saveAsAnnotation: t("Save as annotation"),
      reasoningEffort: t("Reasoning effort"),
      modelUnavailable: t("Inline Ask needs an API model."),
    },
    runTurn,
    createAbortController: () => {
      const Controller = getAbortController();
      return Controller ? new Controller() : null;
    },
  });
  return Object.assign(handle, { snapshot });
}
