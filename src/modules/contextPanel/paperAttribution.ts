import type { PaperContextRef } from "./types";

function normalizeText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractYearValue(value: unknown): string | undefined {
  const text = normalizeText(value);
  if (!text) return undefined;
  const match = text.match(/\b(19|20)\d{2}\b/);
  return match?.[0];
}

export function resolvePaperContextDisplayMetadata(
  paperContext: PaperContextRef,
): {
  firstCreator?: string;
  year?: string;
} {
  let firstCreator = normalizeText(paperContext.firstCreator || "");
  let year = extractYearValue(paperContext.year);
  if ((!firstCreator || !year) && typeof Zotero !== "undefined") {
    const zoteroItem = Zotero.Items.get(paperContext.itemId);
    if (zoteroItem?.isRegularItem?.()) {
      if (!firstCreator) {
        firstCreator = normalizeText(
          String(
            zoteroItem.getField("firstCreator") ||
              (zoteroItem as Zotero.Item).firstCreator ||
              "",
          ),
        );
      }
      if (!year) {
        year =
          extractYearValue(zoteroItem.getField("year")) ||
          extractYearValue(zoteroItem.getField("date")) ||
          extractYearValue(zoteroItem.getField("issued"));
      }
    }
  }
  return {
    firstCreator: firstCreator || undefined,
    year: year || undefined,
  };
}

function extractFirstAuthorLastName(paperContext: PaperContextRef): string {
  const metadata = resolvePaperContextDisplayMetadata(paperContext);
  let creator = normalizeText(metadata.firstCreator || "");
  if (!creator) return "Paper";
  creator = creator
    .replace(/\s+et\s+al\.?$/i, "")
    .replace(/\s+al\.?$/i, "")
    .replace(/[;,.]+$/g, "")
    .trim();
  if (!creator) return "Paper";
  const primaryAuthor =
    creator.split(/\s+(?:and|&)\s+/i).find((part) => part.trim()) || creator;
  const normalizedPrimary = primaryAuthor.replace(/[;,.]+$/g, "").trim();
  if (!normalizedPrimary) return "Paper";
  if (normalizedPrimary.includes(",")) {
    const commaSeparated = normalizedPrimary.split(",")[0]?.trim();
    if (commaSeparated) return commaSeparated;
  }
  const parts = normalizedPrimary.split(/\s+/g).filter(Boolean);
  if (!parts.length) return "Paper";
  if (parts.length === 1) return parts[0];
  const trailingToken = parts[parts.length - 1];
  if (/^[A-Z](?:\.[A-Z])?\.?$/i.test(trailingToken)) {
    return parts[parts.length - 2] || parts[0];
  }
  return trailingToken;
}

export function formatPaperCitationLabel(
  paperContext: PaperContextRef | null | undefined,
): string {
  if (!paperContext) return "Paper";
  const authorLastName = extractFirstAuthorLastName(paperContext);
  const year = resolvePaperContextDisplayMetadata(paperContext).year;
  if (authorLastName !== "Paper") {
    return year
      ? `${authorLastName} et al., ${year}`
      : `${authorLastName} et al.`;
  }
  const fallbackId =
    Number.isFinite(paperContext.itemId) && paperContext.itemId > 0
      ? Math.floor(paperContext.itemId)
      : Number.isFinite(paperContext.contextItemId) && paperContext.contextItemId > 0
        ? Math.floor(paperContext.contextItemId)
        : 0;
  return fallbackId > 0 ? `Paper ${fallbackId}` : "Paper";
}

export function formatOpenChatTextContextLabel(
  paperContext: PaperContextRef | null | undefined,
): string {
  return `${formatPaperCitationLabel(paperContext)} - Text Context`;
}

export function resolvePaperContextRefFromAttachment(
  contextItem: Zotero.Item | null | undefined,
): PaperContextRef | null {
  if (
    !contextItem ||
    !contextItem.isAttachment?.() ||
    contextItem.attachmentContentType !== "application/pdf"
  ) {
    return null;
  }
  const parentItem = contextItem.parentID
    ? Zotero.Items.get(contextItem.parentID) || null
    : null;
  const paperItem = parentItem || contextItem;
  const paperItemId = Number(paperItem.id);
  const contextItemId = Number(contextItem.id);
  if (!Number.isFinite(paperItemId) || !Number.isFinite(contextItemId)) {
    return null;
  }
  const normalizedPaperItemId = Math.floor(paperItemId);
  const normalizedContextItemId = Math.floor(contextItemId);
  if (normalizedPaperItemId <= 0 || normalizedContextItemId <= 0) {
    return null;
  }

  const title = normalizeText(
    String(
      paperItem.getField("title") ||
        contextItem.getField("title") ||
        `Paper ${normalizedPaperItemId}`,
    ),
  );
  const citationKey = normalizeText(String(paperItem.getField("citationKey") || ""));
  const firstCreator = normalizeText(
    String(
      paperItem.getField("firstCreator") ||
        (paperItem as Zotero.Item).firstCreator ||
        "",
    ),
  );
  const year = normalizeText(
    String(
      paperItem.getField("year") ||
        paperItem.getField("date") ||
        paperItem.getField("issued") ||
        "",
    ),
  );

  return {
    itemId: normalizedPaperItemId,
    contextItemId: normalizedContextItemId,
    title: title || `Paper ${normalizedPaperItemId}`,
    citationKey: citationKey || undefined,
    firstCreator: firstCreator || undefined,
    year: year || undefined,
  };
}
