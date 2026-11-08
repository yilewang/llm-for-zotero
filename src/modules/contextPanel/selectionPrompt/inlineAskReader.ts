/**
 * Opens an Inline Ask card for a reader text selection: resolves the model
 * (inlineAskModel.ts) and reasoning effort from the sidebar's choices, builds
 * the turn runner with the paper and selection context, and mounts the card.
 *
 * The card keeps a snapshot taken when Zotero showed the selection popup:
 * the annotation draft, the reader item, and the paper context. Save as
 * annotation writes that draft through the agent API
 * (saveSelectionAnnotation), filed under the reader panel's conversation.
 */
import { getAgentApi, initAgentSubsystem } from "../../../agent";
import { ZOTERO_HIGHLIGHT_COLORS } from "../../../agent/services/pdfAnnotationGeometry";
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
  type InlineAskSaveResult,
  type InlineAskSaveSetup,
} from "./inlineAskOverlay";
import { getInlineAskQuickPrompts } from "./inlineAskPrompts";
import {
  buildInlineAskContext,
  createInlineAskTurnRunner,
  INLINE_ASK_CONTEXT_TIMEOUT_MS,
  resolveInlineAskSurroundingText,
} from "./inlineAskRequest";
import {
  checkInlineAskSave,
  readInlineAskSelectionDraft,
  type InlineAskPopupSnapshot,
  type InlineAskSaveBlock,
} from "./inlineAskSnapshot";
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

/** Zotero's highlight colors, yellow first (the default). */
const HIGHLIGHT_COLOR_LABELS: Record<
  keyof typeof ZOTERO_HIGHLIGHT_COLORS,
  string
> = {
  yellow: "Yellow",
  red: "Red",
  green: "Green",
  blue: "Blue",
  purple: "Purple",
  magenta: "Magenta",
  orange: "Orange",
  gray: "Gray",
};

function saveBlockReason(block: InlineAskSaveBlock): string {
  switch (block) {
    case "not_pdf":
      return t("Save as annotation works in PDF readers only.");
    case "trashed":
      return t("This PDF is in the trash.");
    case "read_only":
      return t("This library is read-only.");
    case "cross_page":
      return t(
        "This selection continues on the next page. Highlight it from Zotero's popup instead.",
      );
    case "no_position":
      return t("Zotero gave no position for this selection. Select it again.");
    case "no_conversation":
      return t("Open this PDF's chat panel to save annotations.");
  }
}

type ReaderAttachment = {
  libraryID?: number;
  deleted?: boolean;
  parentItemID?: number | false;
  isPDFAttachment?: () => boolean;
};

/** What Save needs from Zotero now, read on each check. */
function readSaveFacts(
  snapshot: InlineAskPopupSnapshot,
  resolveConversationKey: () => number | null,
) {
  const item = Zotero.Items.get(snapshot.readerItemId) as
    | ReaderAttachment
    | false
    | null;
  const attachment = item || null;
  const parent = attachment?.parentItemID
    ? (Zotero.Items.get(attachment.parentItemID) as
        | { deleted?: boolean }
        | false)
    : null;
  const libraryID = Number(attachment?.libraryID) || 0;
  let isPdf = false;
  try {
    isPdf = Boolean(attachment?.isPDFAttachment?.());
  } catch {
    isPdf = false;
  }
  let editable = false;
  try {
    editable = Boolean(libraryID && Zotero.Libraries.isEditable(libraryID));
  } catch {
    editable = false;
  }
  const draft = readInlineAskSelectionDraft(
    snapshot.annotation,
    snapshot.selectedText,
    snapshot.pageLabel,
  );
  const conversationKey = resolveConversationKey();
  const block = checkInlineAskSave({
    isPdf,
    trashed: Boolean(attachment?.deleted || (parent && parent.deleted)),
    editable,
    conversationKey,
    draft,
  });
  return { block, libraryID, conversationKey, draft };
}

function buildInlineAskSaveSetup(
  snapshot: InlineAskPopupSnapshot,
  resolveConversationKey: () => number | null,
): InlineAskSaveSetup {
  const draft = readInlineAskSelectionDraft(
    snapshot.annotation,
    snapshot.selectedText,
    snapshot.pageLabel,
  );
  const pageLabel =
    (draft.ok && draft.selection.pageLabel) || snapshot.pageLabel;
  return {
    colors: (
      Object.keys(ZOTERO_HIGHLIGHT_COLORS) as Array<
        keyof typeof ZOTERO_HIGHLIGHT_COLORS
      >
    ).map((name) => ({
      hex: ZOTERO_HIGHLIGHT_COLORS[name],
      label: t(HIGHLIGHT_COLOR_LABELS[name]),
    })),
    pageText: pageLabel ? t("Page {label}").replace("{label}", pageLabel) : "",
    labels: {
      color: t("Color"),
      back: t("Back"),
      cancel: t("Cancel"),
      save: t("Save"),
      addComment: t("Add comment"),
    },
    blockedReason: () => {
      const { block } = readSaveFacts(snapshot, resolveConversationKey);
      return block ? saveBlockReason(block) : null;
    },
    save: async (payload): Promise<InlineAskSaveResult> => {
      const facts = readSaveFacts(snapshot, resolveConversationKey);
      if (facts.block || !facts.draft.ok || facts.conversationKey === null)
        return {
          ok: false,
          error: saveBlockReason(facts.block || "no_position"),
        };
      await initAgentSubsystem();
      const outcome = await getAgentApi().saveSelectionAnnotation({
        attachmentId: snapshot.readerItemId,
        libraryID: facts.libraryID,
        conversationKey: facts.conversationKey,
        selection: facts.draft.selection,
        color: payload.color,
        comment: payload.comment,
      });
      if (outcome.ok) return { ok: true };
      // The tool ran but its receipt did not verify the native row.
      if (outcome.result?.ok)
        return {
          ok: false,
          error: t("Zotero did not confirm the saved annotation."),
        };
      return {
        ok: false,
        error: outcome.error || t("The annotation could not be saved."),
      };
    },
  };
}

export function openInlineAskCardForReader(params: {
  doc: Document;
  anchor: ReaderOverlayAnchor;
  snapshot: InlineAskPopupSnapshot;
  /** The item whose selected reasoning level applies (the paper). */
  reasoningItemId: number;
  /** The reader panel's conversation; Save files its change there. */
  resolveConversationKey: () => number | null;
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
    save: buildInlineAskSaveSetup(snapshot, params.resolveConversationKey),
    createAbortController: () => {
      const Controller = getAbortController();
      return Controller ? new Controller() : null;
    },
  });
  return Object.assign(handle, { snapshot });
}
