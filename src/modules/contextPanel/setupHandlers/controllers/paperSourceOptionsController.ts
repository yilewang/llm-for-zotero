import type { PaperContentSourceMode } from "../../types";
import type { PdfSupport } from "../../../../providers";
import { resolveContextAttachmentSupport } from "../../contextAttachmentSupport";
import {
  getContextSourceModeBadgeLabel,
  getContextSourceModeDescriptor,
  getContextSourceModeHumanLabel,
} from "../../contextSourceModes";
import { sanitizeText } from "../../textUtils";
import type { PaperContextRef } from "../../types";

export type MineruSourceUiState = "cached" | "idle" | "processing" | "failed";

export type MineruSourceAction = "select" | "start" | "pause" | "retry";

export type MineruSourceStatusSnapshot =
  | {
      status?: "idle" | "processing" | "failed" | "cached";
    }
  | undefined;

export type MineruSourceOptionState = {
  state: MineruSourceUiState;
  action: MineruSourceAction;
  hideTextSource: boolean;
};

export type PaperSourceModeOption = {
  mode?: PaperContentSourceMode | null;
};

export type PaperSourceOption = {
  mode: PaperContentSourceMode;
  badge: string;
  paperContext: PaperContextRef;
  title: string;
  description: string;
  disabledReason?: string;
  mineruState?: MineruSourceUiState;
  mineruAction?: MineruSourceAction;
  mineruActionTitle?: string;
  hideTextSource?: boolean;
};

export type BuildPaperSourceOptionsParams = {
  paperContext: PaperContextRef;
  getItemById: (itemId: number) => Zotero.Item | null | undefined;
  webChatMode: boolean;
  pdfSupport: PdfSupport;
  isMineruEnabled: boolean;
  getItemStatus: (contextItemId: number) => MineruSourceStatusSnapshot;
  isPaperContextMineru: (paperContext: PaperContextRef) => boolean;
  mineruAvailableIds: Set<number>;
  fullPdfUnsupportedMessage: string;
  mineruDisabledParsingMessage: string;
  translate?: (text: string) => string;
};

export function filterPaperSourceOptionsForWebChat<
  T extends PaperSourceModeOption,
>(sourceOptions: readonly T[]): T[] {
  return sourceOptions.filter((sourceOption) => sourceOption.mode === "pdf");
}

export function resolveMineruSourceOptionState(input: {
  hasUsableMineru: boolean;
  itemStatus?: MineruSourceStatusSnapshot;
}): MineruSourceOptionState {
  const status = input.itemStatus?.status;
  const hasUsableMineru = input.hasUsableMineru || status === "cached";

  if (status === "processing") {
    return {
      state: "processing",
      action: "pause",
      hideTextSource: hasUsableMineru,
    };
  }

  if (status === "failed") {
    return {
      state: "failed",
      action: "retry",
      hideTextSource: hasUsableMineru,
    };
  }

  if (hasUsableMineru) {
    return {
      state: "cached",
      action: "select",
      hideTextSource: true,
    };
  }

  return {
    state: "idle",
    action: "start",
    hideTextSource: false,
  };
}

const translateDefault = (text: string): string => text;

function getAttachmentFilename(attachment: Zotero.Item): string {
  return sanitizeText(
    String(
      (attachment as unknown as { attachmentFilename?: unknown })
        .attachmentFilename || "",
    ),
  ).trim();
}

function getAttachmentCardTitle(attachment: Zotero.Item): string {
  return sanitizeText(
    String(
      attachment.getField("title") ||
        getAttachmentFilename(attachment) ||
        `Attachment ${attachment.id}`,
    ),
  ).trim();
}

function resolveParentItemForSourcePicker(
  paperContext: PaperContextRef,
  getItemById: BuildPaperSourceOptionsParams["getItemById"],
): Zotero.Item | null {
  const parent = getItemById(paperContext.itemId) || null;
  if (parent?.isRegularItem?.()) return parent;
  const attachment = getItemById(paperContext.contextItemId) || null;
  if (attachment?.isAttachment?.() && attachment.parentID) {
    const attachmentParent = getItemById(attachment.parentID) || null;
    if (attachmentParent?.isRegularItem?.()) return attachmentParent;
  }
  return null;
}

function buildPaperContextForChildAttachment(
  parentItem: Zotero.Item,
  attachment: Zotero.Item,
  mode: PaperContentSourceMode,
): PaperContextRef | null {
  const normalizedParentId = Math.floor(Number(parentItem.id));
  const normalizedAttachmentId = Math.floor(Number(attachment.id));
  if (
    !Number.isFinite(normalizedParentId) ||
    normalizedParentId <= 0 ||
    !Number.isFinite(normalizedAttachmentId) ||
    normalizedAttachmentId <= 0
  ) {
    return null;
  }
  const title = sanitizeText(
    String(parentItem.getField("title") || `Paper ${normalizedParentId}`),
  ).trim();
  const firstCreator = sanitizeText(
    String(
      parentItem.getField("firstCreator") ||
        (parentItem as Zotero.Item).firstCreator ||
        "",
    ),
  ).trim();
  const year = sanitizeText(
    String(
      parentItem.getField("year") ||
        parentItem.getField("date") ||
        parentItem.getField("issued") ||
        "",
    ),
  ).trim();
  const citationKey = sanitizeText(
    String(parentItem.getField("citationKey") || ""),
  ).trim();
  return {
    itemId: normalizedParentId,
    contextItemId: normalizedAttachmentId,
    contentSourceMode: mode,
    title: title || `Paper ${normalizedParentId}`,
    attachmentTitle: getAttachmentCardTitle(attachment) || undefined,
    citationKey: citationKey || undefined,
    firstCreator: firstCreator || undefined,
    year: year || undefined,
  };
}

function getMineruSourceDescription(input: {
  attachmentTitle: string;
  state: MineruSourceUiState;
  disabledReason?: string;
  translate: (text: string) => string;
}): string {
  if (input.disabledReason) {
    return `${input.attachmentTitle} - ${input.disabledReason}`;
  }
  if (input.state === "processing") {
    return `${input.attachmentTitle} - ${input.translate("MinerU parsing...")}`;
  }
  if (input.state === "failed") {
    return `${input.attachmentTitle} - ${input.translate(
      "MinerU parsing failed. Click to retry",
    )}`;
  }
  if (input.state === "idle") {
    return `${input.attachmentTitle} - ${input.translate(
      "Click to do MinerU parsing",
    )}`;
  }
  return `${input.attachmentTitle} - MinerU`;
}

function shouldDisableMineruParsingAction(input: {
  action?: MineruSourceAction;
  isMineruEnabled: boolean;
}): boolean {
  return (
    !input.isMineruEnabled &&
    (input.action === "start" || input.action === "retry")
  );
}

function getMineruActionTitle(input: {
  state: MineruSourceUiState;
  disabledReason?: string;
  isMineruEnabled: boolean;
  mineruDisabledParsingMessage: string;
  translate: (text: string) => string;
}): string {
  if (input.disabledReason) return input.disabledReason;
  if (input.state === "processing") {
    return input.translate("Click to stop MinerU parsing");
  }
  if (input.state === "failed") {
    return input.translate("MinerU parsing failed. Click to retry");
  }
  if (input.state === "idle" && !input.isMineruEnabled) {
    return input.mineruDisabledParsingMessage;
  }
  if (input.state === "idle") {
    return input.translate("Click to do MinerU parsing");
  }
  return "MinerU";
}

function resolveMineruOptionState(
  paperContext: PaperContextRef,
  params: BuildPaperSourceOptionsParams,
): ReturnType<typeof resolveMineruSourceOptionState> {
  const itemStatus = params.getItemStatus(paperContext.contextItemId);
  const hasUsableMineru =
    params.mineruAvailableIds.has(paperContext.contextItemId) ||
    itemStatus?.status === "cached" ||
    params.isPaperContextMineru(paperContext);
  const state = resolveMineruSourceOptionState({
    hasUsableMineru,
    itemStatus,
  });
  if (state.hideTextSource) {
    params.mineruAvailableIds.add(paperContext.contextItemId);
  }
  return state;
}

export function buildPaperSourceOptions(
  params: BuildPaperSourceOptionsParams,
): PaperSourceOption[] {
  const translate = params.translate || translateDefault;
  const parentItem = resolveParentItemForSourcePicker(
    params.paperContext,
    params.getItemById,
  );
  if (!parentItem) {
    const fallbackMode = params.webChatMode
      ? "pdf"
      : params.paperContext.contentSourceMode || "text";
    return [
      {
        mode: fallbackMode,
        badge: getContextSourceModeBadgeLabel(fallbackMode) || "Text",
        paperContext: {
          ...params.paperContext,
          contentSourceMode: fallbackMode,
        },
        title: params.paperContext.title,
        description:
          params.paperContext.attachmentTitle ||
          getContextSourceModeHumanLabel(fallbackMode),
      },
    ];
  }

  const attachmentIds = parentItem.getAttachments?.() || [];
  const options: PaperSourceOption[] = [];
  for (const attachmentId of attachmentIds) {
    const attachment = params.getItemById(attachmentId) || null;
    if (!attachment?.isAttachment?.()) continue;
    const attachmentTitle = getAttachmentCardTitle(attachment);
    const attachmentSupport = resolveContextAttachmentSupport(attachment);
    if (attachmentSupport?.kind === "pdf") {
      const baseContext = buildPaperContextForChildAttachment(
        parentItem,
        attachment,
        "text",
      );
      if (!baseContext) continue;
      const pdfOption: PaperSourceOption = {
        mode: "pdf",
        badge: getContextSourceModeBadgeLabel("pdf") || "PDF",
        paperContext: { ...baseContext, contentSourceMode: "pdf" },
        title: baseContext.title,
        description: `${attachmentTitle} - ${getContextSourceModeHumanLabel(
          "pdf",
        )}`,
        disabledReason:
          params.pdfSupport === "native" || params.webChatMode
            ? undefined
            : params.fullPdfUnsupportedMessage,
      };
      if (params.webChatMode) {
        options.push(pdfOption);
        continue;
      }
      const mineruOptionState = resolveMineruOptionState(baseContext, params);
      const mineruDisabledReason = shouldDisableMineruParsingAction({
        action: mineruOptionState.action,
        isMineruEnabled: params.isMineruEnabled,
      })
        ? params.mineruDisabledParsingMessage
        : undefined;
      options.push({
        mode: "mineru",
        badge: getContextSourceModeBadgeLabel("mineru") || "MD",
        paperContext: { ...baseContext, contentSourceMode: "mineru" },
        title: baseContext.title,
        description: getMineruSourceDescription({
          attachmentTitle,
          state: mineruOptionState.state,
          disabledReason: mineruDisabledReason,
          translate,
        }),
        disabledReason: mineruDisabledReason,
        mineruState: mineruOptionState.state,
        mineruAction: mineruOptionState.action,
        mineruActionTitle: getMineruActionTitle({
          state: mineruOptionState.state,
          disabledReason: mineruDisabledReason,
          isMineruEnabled: params.isMineruEnabled,
          mineruDisabledParsingMessage: params.mineruDisabledParsingMessage,
          translate,
        }),
        hideTextSource: mineruOptionState.hideTextSource,
      });
      if (!mineruOptionState.hideTextSource) {
        options.push({
          mode: "text",
          badge: getContextSourceModeBadgeLabel("text") || "Text",
          paperContext: { ...baseContext, contentSourceMode: "text" },
          title: baseContext.title,
          description: `${attachmentTitle} - ${getContextSourceModeHumanLabel(
            "text",
          )}`,
        });
      }
      options.push(pdfOption);
      continue;
    }
    if (attachmentSupport?.kind !== "text") continue;
    const textSourceMode = attachmentSupport.contentSourceMode;
    const context = buildPaperContextForChildAttachment(
      parentItem,
      attachment,
      textSourceMode,
    );
    if (!context) continue;
    const descriptor = getContextSourceModeDescriptor(textSourceMode);
    options.push({
      mode: textSourceMode,
      badge: descriptor?.badgeLabel || "Text",
      paperContext: { ...context, contentSourceMode: textSourceMode },
      title: attachmentTitle,
      description: `${attachmentTitle} - ${
        descriptor?.humanLabel || "Attachment"
      }`,
    });
  }
  return params.webChatMode
    ? filterPaperSourceOptionsForWebChat(options)
    : options;
}
