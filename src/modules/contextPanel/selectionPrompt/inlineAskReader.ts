/**
 * Opens an Inline Ask card for a reader text selection: resolves the model
 * (inlineAskModel.ts) and reasoning effort, builds the turn runner with the
 * paper and selection context, and mounts the card.
 *
 * Model and effort: the model and effort the user picked in a card (Inline
 * Ask's own prefs, inlineAskModelEntryId and inlineAskReasoning) while that
 * entry is still an API model and the model offers that level; otherwise the
 * rule's model with the sidebar's effort for it. The effort menu offers the
 * levels the sidebar's reasoning menu offers for that model.
 *
 * The card keeps a snapshot taken when Zotero showed the selection popup:
 * the annotation draft, the reader item, and the paper context. Save as
 * annotation writes that draft through the agent API
 * (saveSelectionAnnotation), filed under the reader panel's conversation.
 * Continue in sidebar hands the finished turns to the reader's panel
 * (inlineAskContinue.ts).
 */
import { getAgentApi, initAgentSubsystem } from "../../../agent";
import { ZOTERO_HIGHLIGHT_COLORS } from "../../../agent/services/pdfAnnotationGeometry";
import type { ReasoningConfig } from "../../../shared/llm";
import { buildCodexReasoningConfig } from "../../../codex/catalogSelection";
import {
  getCodexDirectCatalogModel,
  getCodexDirectCatalogSnapshot,
  getCodexDirectReasoningChoices,
  loadCodexDirectCatalog,
  reconcileCodexDirectReasoningChoice,
} from "../../../codexAuth/modelCatalog";
import { getCachedPageTextForAttachment } from "../../../services/pdf/livePdfSelectionLocator";
import { getAbortController } from "../../../utils/apiHelpers";
import { t } from "../../../utils/i18n";
import { getModelProviderGroups } from "../../../utils/modelProviders";
import {
  detectReasoningProvider,
  getReasoningOptions,
  peekSelectedReasoningForItem,
} from "../chat";
import {
  getAvailableModelEntries,
  getNumberPref,
  getStringPref,
  setNumberPref,
  setStringPref,
} from "../prefHelpers";
import { resolveSelectedTextAnchors } from "../selectedTextAnchors";
import {
  getSelectedModelEntryForSurface,
  surfaceChoices,
} from "../surfaceChoices";
import {
  buildInlineAskModelMenu,
  inlineAskModelMenuNote,
  pickInlineAskEffort,
  resolveInlineAskModelTarget,
  type InlineAskEffortLevel,
  type InlineAskModelRuleInput,
  type InlineAskModelTarget,
} from "./inlineAskModel";
import {
  INLINE_ASK_TEXT_SIZES,
  openInlineAskOverlay,
  type InlineAskModelLine,
  type InlineAskModelPicker,
  type InlineAskOverlayHandle,
  type InlineAskSaveResult,
  type InlineAskSaveSetup,
} from "./inlineAskOverlay";
import {
  createInlineAskPromptEditing,
  getInlineAskQuickPrompts,
} from "./inlineAskPrompts";
import {
  createInlineAskContinueInSidebar,
  type InlineAskPanelReach,
} from "./inlineAskContinue";
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

/** Inline Ask's own model choice: the entry and effort picked in a card. */
export const INLINE_ASK_MODEL_ENTRY_PREF = "inlineAskModelEntryId";
export const INLINE_ASK_REASONING_PREF = "inlineAskReasoning";
export const INLINE_ASK_TEXT_SIZE_PREF = "inlineAskTextSize";

/** The saved text size in percent; an unknown value reads as 100. */
function readInlineAskTextSize(): number {
  const saved = getNumberPref(INLINE_ASK_TEXT_SIZE_PREF);
  return saved !== null && INLINE_ASK_TEXT_SIZES.includes(saved) ? saved : 100;
}

export type InlineAskModelChoice = {
  target: InlineAskModelTarget;
  reasoning?: ReasoningConfig;
  /** The effort in use (a level value) and the levels the model offers. */
  effort: string;
  levels: InlineAskEffortLevel[];
  line: InlineAskModelLine;
};

function isCodexDirectConfigured(): boolean {
  return getModelProviderGroups().some(
    (group) =>
      group.authMode === "codex_auth" &&
      group.models.some((row) => row.model.trim()),
  );
}

function readRuleInput(): InlineAskModelRuleInput {
  return {
    conversationSystem: surfaceChoices.conversationSystem.get(READER_SURFACE),
    sidebarEntry: getSelectedModelEntryForSurface(READER_SURFACE),
    entries: getAvailableModelEntries(),
    codexDirect: {
      configured: isCodexDirectConfigured(),
      runtimeModel: surfaceChoices.codexRuntimeModel.get(READER_SURFACE),
      isModelAvailable: (model) =>
        getCodexDirectCatalogSnapshot().status !== "ready" ||
        Boolean(getCodexDirectCatalogModel(model)),
    },
  };
}

function reasoningProviderFor(target: InlineAskModelTarget) {
  return detectReasoningProvider(target.model, target.apiBase);
}

/** The levels the sidebar's reasoning menu offers for the target's model. */
export function inlineAskEffortLevels(
  target: InlineAskModelTarget,
): InlineAskEffortLevel[] {
  if (target.authMode === "codex_auth") {
    return getCodexDirectReasoningChoices(target.model).map((choice) => ({
      value: choice.value,
      label: choice.label,
    }));
  }
  const levels = getReasoningOptions(
    reasoningProviderFor(target),
    target.model,
    target.apiBase,
    target.providerProtocol,
    target.advanced?.profileOverride as Parameters<
      typeof getReasoningOptions
    >[4],
  )
    .filter((option) => option.enabled)
    .map((option) => ({
      value: option.level,
      label: option.label || option.level,
    }));
  return levels.length ? levels : [{ value: "auto", label: "Auto" }];
}

/** The sidebar's effort for the target's model (the rule's effort). */
function ruleEffort(
  target: InlineAskModelTarget,
  reasoningItemId: number,
): string {
  if (target.authMode === "codex_auth") {
    const stored =
      target.source === "codex_runtime"
        ? surfaceChoices.codexReasoningMode.get(READER_SURFACE)
        : surfaceChoices.codexDirectReasoningSelection.get(
            target.model,
            READER_SURFACE,
          );
    return reconcileCodexDirectReasoningChoice(target.model, stored);
  }
  // Read only: remembering the level here would overwrite the sidebar's
  // per-item choice with one resolved for Inline Ask's model.
  return (
    peekSelectedReasoningForItem(
      reasoningItemId,
      target.model,
      target.apiBase,
      target.providerProtocol,
      target.advanced?.profileOverride as Parameters<
        typeof peekSelectedReasoningForItem
      >[4],
      READER_SURFACE,
    ).level || "auto"
  );
}

function reasoningFor(
  target: InlineAskModelTarget,
  effort: string,
): ReasoningConfig | undefined {
  if (target.authMode === "codex_auth") {
    return buildCodexReasoningConfig(effort);
  }
  const provider = reasoningProviderFor(target);
  return {
    provider: provider === "unsupported" ? "customized" : provider,
    level: effort,
  } as ReasoningConfig;
}

/** The model, effort and model line for a card opened (or picked) now. */
export function resolveInlineAskModelChoice(
  reasoningItemId: number,
): InlineAskModelChoice | null {
  const target = resolveInlineAskModelTarget({
    ...readRuleInput(),
    chosenEntryId: getStringPref(INLINE_ASK_MODEL_ENTRY_PREF),
  });
  if (!target) return null;
  const levels = inlineAskEffortLevels(target);
  const effort = pickInlineAskEffort(
    levels,
    getStringPref(INLINE_ASK_REASONING_PREF),
    ruleEffort(target, reasoningItemId),
  );
  return {
    target,
    reasoning: reasoningFor(target, effort),
    effort,
    levels,
    line: {
      label: target.displayLabel,
      effort: levels.find((level) => level.value === effort)?.label || effort,
      title: `${target.providerLabel} · ${target.model}`,
    },
  };
}

function inlineAskModelNoteText(
  note: ReturnType<typeof inlineAskModelMenuNote>,
): string | null {
  if (note === "claude_code")
    return t(
      "Claude Code runs only in the sidebar. Inline Ask uses an API model from this list.",
    );
  if (note === "webchat")
    return t(
      "WebChat runs only in the sidebar. Inline Ask uses an API model from this list.",
    );
  return null;
}

/**
 * The card's model and effort menus. A pick is saved in Inline Ask's own
 * prefs and re-resolved, so a gone entry or an unoffered level falls back.
 */
export function createInlineAskModelPicker(
  reasoningItemId: number,
  state: { choice: InlineAskModelChoice | null },
): InlineAskModelPicker {
  const refresh = () => {
    state.choice = resolveInlineAskModelChoice(reasoningItemId);
  };
  return {
    line: () => state.choice?.line ?? null,
    modelMenu: () => {
      const rule = readRuleInput();
      return {
        note: inlineAskModelNoteText(inlineAskModelMenuNote(rule)),
        groups: buildInlineAskModelMenu(
          rule.entries,
          state.choice?.target.entryId,
        ),
      };
    },
    pickModel: (entryId) => {
      setStringPref(INLINE_ASK_MODEL_ENTRY_PREF, entryId);
      refresh();
    },
    effortMenu: () => ({
      title: t("Reasoning"),
      levels: (state.choice?.levels || []).map((level) => ({
        ...level,
        selected: level.value === state.choice?.effort,
      })),
    }),
    pickEffort: (value) => {
      setStringPref(INLINE_ASK_REASONING_PREF, value);
      refresh();
    },
    // Until the Codex Direct catalog loads, a Codex Direct model offers
    // Auto only; the sidebar loads it when its own menu opens, and so does
    // the card. A load already running is shared.
    prepareMenu: (onChange) => {
      if (!isCodexDirectConfigured()) return;
      if (getCodexDirectCatalogSnapshot().status === "ready") return;
      void loadCodexDirectCatalog().then(
        () => {
          refresh();
          onChange();
        },
        () => undefined,
      );
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
      return t("Zotero could not find the paper for this PDF.");
  }
}

type ReaderAttachment = {
  libraryID?: number;
  deleted?: boolean;
  parentItemID?: number | false;
  isPDFAttachment?: () => boolean;
};

type SourceLabelItem = {
  getField?: (name: string) => unknown;
};

/**
 * "Ratzon et al., 2024": Zotero's firstCreator ("Smith", "Smith and Lee",
 * "Smith et al.") and the year of the date field, from the paper (the
 * attachment's parent). One part alone is shown alone; none gives "".
 */
export function readInlineAskSourceLabel(attachmentId: number): string {
  try {
    const attachment = Zotero.Items.get(attachmentId) as
      | ReaderAttachment
      | false
      | null;
    const parentId = attachment ? attachment.parentItemID : 0;
    if (!parentId) return "";
    const parent = Zotero.Items.get(parentId) as SourceLabelItem | false | null;
    if (!parent) return "";
    const field = (name: string): string => {
      try {
        const value = parent.getField?.(name);
        return typeof value === "string" ? value.trim() : "";
      } catch {
        return "";
      }
    };
    const creator = field("firstCreator");
    const year = (field("date").match(/\b(\d{4})\b/) || [])[1] || "";
    return [creator, year].filter(Boolean).join(", ");
  } catch {
    return "";
  }
}

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
  /** Runs Continue in sidebar in the reader's panel. */
  reachPanel?: InlineAskPanelReach;
}): InlineAskCardHandle {
  const { snapshot } = params;
  const state = {
    choice: resolveInlineAskModelChoice(params.reasoningItemId),
  };
  const runTurn = createInlineAskTurnRunner({
    getModel: () =>
      state.choice
        ? { target: state.choice.target, reasoning: state.choice.reasoning }
        : null,
    noModelMessage: t("Inline Ask needs an API model."),
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
  });
  const handle = openInlineAskOverlay({
    doc: params.doc,
    anchor: params.anchor,
    selectedText: snapshot.selectedText,
    sourceLabel: readInlineAskSourceLabel(snapshot.readerItemId),
    prompts: getInlineAskQuickPrompts(),
    model: state.choice?.line ?? null,
    modelPicker: createInlineAskModelPicker(params.reasoningItemId, state),
    promptEditing: {
      api: createInlineAskPromptEditing(),
      labels: {
        edit: t("Edit"),
        delete: t("Delete"),
        add: t("Add"),
        reset: t("Reset"),
        label: t("Label"),
        prompt: t("Prompt, sent with the selected text"),
        cancel: t("Cancel"),
        save: t("Save"),
      },
    },
    labels: {
      placeholder: t("Ask about the selection"),
      followUpPlaceholder: t("Ask a follow-up"),
      hint: t("Enter to send · Shift+Enter for a new line · Esc to close"),
      send: t("Send"),
      reading: t("Reading the selection…"),
      discard: t("Discard"),
      continueInSidebar: t("Continue in sidebar"),
      saveAsAnnotation: t("Save as annotation"),
      reasoningEffort: t("Reasoning effort"),
      more: t("More"),
      textSize: t("Text size"),
      resetTextSize: t("Reset to 100%"),
      modelUnavailable: t("Inline Ask needs an API model."),
    },
    textSize: readInlineAskTextSize(),
    onTextSizeChange: (size) => setNumberPref(INLINE_ASK_TEXT_SIZE_PREF, size),
    runTurn,
    save: buildInlineAskSaveSetup(snapshot, params.resolveConversationKey),
    continueInSidebar: params.reachPanel
      ? createInlineAskContinueInSidebar({
          snapshot,
          getModel: () =>
            state.choice
              ? {
                  name: state.choice.target.model,
                  entryId: state.choice.target.entryId,
                  providerLabel: state.choice.target.providerLabel,
                }
              : null,
          reachPanel: params.reachPanel,
        })
      : undefined,
    createAbortController: () => {
      const Controller = getAbortController();
      return Controller ? new Controller() : null;
    },
  });
  return Object.assign(handle, { snapshot });
}
