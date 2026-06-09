import type { PaperContentSourceMode } from "./types";

export type ContextSourceModeDescriptor = {
  mode: PaperContentSourceMode;
  badgeLabel: string;
  humanLabel: string;
  sourceTitle: string;
  cssClassName: string;
  attachmentSourceTypeLabel: string;
  isPdfBacked: boolean;
  isReaderNavigable: boolean;
  isTextLikeAttachment: boolean;
};

const CONTEXT_SOURCE_MODE_DESCRIPTORS: Record<
  PaperContentSourceMode,
  ContextSourceModeDescriptor
> = {
  pdf: {
    mode: "pdf",
    badgeLabel: "PDF",
    humanLabel: "PDF file",
    sourceTitle: "Source: PDF file",
    cssClassName: "llm-paper-context-chip-pdf",
    attachmentSourceTypeLabel: "PDF attachment",
    isPdfBacked: true,
    isReaderNavigable: true,
    isTextLikeAttachment: false,
  },
  text: {
    mode: "text",
    badgeLabel: "Text",
    humanLabel: "extracted text",
    sourceTitle: "Source: Extracted text",
    cssClassName: "llm-paper-context-chip-text",
    attachmentSourceTypeLabel: "extracted text",
    isPdfBacked: true,
    isReaderNavigable: true,
    isTextLikeAttachment: false,
  },
  mineru: {
    mode: "mineru",
    badgeLabel: "MD",
    humanLabel: "MinerU",
    sourceTitle: "Source: MinerU (enhanced markdown)",
    cssClassName: "llm-paper-context-chip-mineru",
    attachmentSourceTypeLabel: "MinerU markdown",
    isPdfBacked: true,
    isReaderNavigable: true,
    isTextLikeAttachment: false,
  },
  markdown: {
    mode: "markdown",
    badgeLabel: "MD",
    humanLabel: "Markdown attachment",
    sourceTitle: "Source: Markdown attachment",
    cssClassName: "llm-paper-context-chip-mineru",
    attachmentSourceTypeLabel: "Markdown attachment",
    isPdfBacked: false,
    isReaderNavigable: false,
    isTextLikeAttachment: true,
  },
  html: {
    mode: "html",
    badgeLabel: "HTML",
    humanLabel: "HTML attachment",
    sourceTitle: "Source: HTML attachment",
    cssClassName: "llm-paper-context-chip-html",
    attachmentSourceTypeLabel: "HTML attachment",
    isPdfBacked: false,
    isReaderNavigable: false,
    isTextLikeAttachment: true,
  },
  txt: {
    mode: "txt",
    badgeLabel: "TXT",
    humanLabel: "TXT attachment",
    sourceTitle: "Source: TXT attachment",
    cssClassName: "llm-paper-context-chip-text",
    attachmentSourceTypeLabel: "TXT attachment",
    isPdfBacked: false,
    isReaderNavigable: false,
    isTextLikeAttachment: true,
  },
  docx: {
    mode: "docx",
    badgeLabel: "DOCX",
    humanLabel: "Word attachment",
    sourceTitle: "Source: Word attachment",
    cssClassName: "llm-paper-context-chip-text",
    attachmentSourceTypeLabel: "DOCX attachment",
    isPdfBacked: false,
    isReaderNavigable: false,
    isTextLikeAttachment: true,
  },
};

export function getContextSourceModeDescriptor(
  mode: PaperContentSourceMode | undefined | null,
): ContextSourceModeDescriptor | null {
  return mode ? CONTEXT_SOURCE_MODE_DESCRIPTORS[mode] || null : null;
}

export function getContextSourceModeBadgeLabel(
  mode: PaperContentSourceMode | undefined | null,
): string | null {
  return getContextSourceModeDescriptor(mode)?.badgeLabel || null;
}

export function getContextSourceModeCssClassName(
  mode: PaperContentSourceMode | undefined | null,
): string {
  return (
    getContextSourceModeDescriptor(mode)?.cssClassName ||
    "llm-paper-context-chip-text"
  );
}

export function getContextSourceModeHumanLabel(
  mode: PaperContentSourceMode | undefined | null,
): string {
  return getContextSourceModeDescriptor(mode)?.humanLabel || "Attachment";
}

export function getContextSourceModeSourceTitle(
  mode: PaperContentSourceMode | undefined | null,
): string {
  return getContextSourceModeDescriptor(mode)?.sourceTitle || "";
}

export function formatContextAttachmentSourceType(
  mode: PaperContentSourceMode | undefined | null,
): string {
  return (
    getContextSourceModeDescriptor(mode)?.attachmentSourceTypeLabel ||
    "Attachment"
  );
}

export function isContextSourceModeReaderNavigable(
  mode: PaperContentSourceMode | undefined | null,
): boolean {
  return getContextSourceModeDescriptor(mode)?.isReaderNavigable === true;
}

export function isContextSourceModeTextLikeAttachment(
  mode: PaperContentSourceMode | undefined | null,
): boolean {
  return getContextSourceModeDescriptor(mode)?.isTextLikeAttachment === true;
}
