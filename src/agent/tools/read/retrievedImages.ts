import { appLogger } from "../../../core/logging";
import { ensureAttachmentBlobFromPath } from "../../../services/attachmentStorage";
import { buildZoteroOpenPdfUri } from "../../documents/citationService";
import type { RetrievalImageResult } from "../../services/retrievalService";
import type { AgentToolArtifact } from "../../types";

/** What produced the image, in words the model can repeat. */
const IMAGE_KINDS = {
  mineru: "figure",
  vector: "figure region",
  embedded: "embedded image",
} as const;

export type RetrievedImageEntry = {
  displayLabel: string;
  /** 1-based. */
  page: number;
  kind: (typeof IMAGE_KINDS)[keyof typeof IMAGE_KINDS];
  label?: string;
  caption?: string;
  similarity: number;
  why: RetrievalImageResult["why"];
  /** Ready-made Markdown link that opens the image's page for the reader. */
  pageLink?: string;
};

type DeliveryDeps = {
  persistFromPath: (
    sourcePath: string,
    fileName: string,
  ) => Promise<{ storedPath: string; contentHash: string }>;
  /** 0-based page; null when the attachment cannot be resolved. */
  pageUri?: (contextItemId: number, pageIndex: number) => string | null;
};

/** Sits next to the images, where the model reads while it answers. */
const PAGE_LINK_NOTE =
  "When the answer refers to one of these images or its page, copy that image's pageLink into the answer unchanged; it opens the page for the reader.";

function zoteroPageUri(contextItemId: number, pageIndex: number) {
  const item = Zotero.Items.get(contextItemId);
  return item?.key
    ? buildZoteroOpenPdfUri(item.libraryID, item.key, pageIndex)
    : null;
}

const DEFAULT_DEPS: DeliveryDeps = {
  persistFromPath: ensureAttachmentBlobFromPath,
  pageUri: zoteroPageUri,
};

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "paper"
  );
}

/**
 * Turns selected paper images into model-facing result entries plus image
 * artifacts, which the runtime attaches for models that accept images.
 */
export async function buildRetrievedImageDelivery(
  images: RetrievalImageResult[],
  deps: DeliveryDeps = DEFAULT_DEPS,
): Promise<{
  entries: RetrievedImageEntry[];
  artifacts: AgentToolArtifact[];
  /** How to use the entries' page links; absent when none has one. */
  note?: string;
}> {
  const entries: RetrievedImageEntry[] = [];
  const artifacts: AgentToolArtifact[] = [];
  for (const image of images) {
    const page = image.pageIndex + 1;
    const kind = IMAGE_KINDS[image.source] ?? IMAGE_KINDS.embedded;
    const extension = image.mimeType === "image/jpeg" ? "jpg" : "png";
    let persisted: { storedPath: string; contentHash: string };
    try {
      persisted = await deps.persistFromPath(
        image.imagePath,
        `${slug(image.paperContext.title || "paper")}-p${page}-${slug(image.imageId)}.${extension}`,
      );
    } catch (error) {
      appLogger.debug("[Embedded images] Could not deliver an image", error);
      continue;
    }
    const uri = deps.pageUri?.(
      image.paperContext.contextItemId,
      image.pageIndex,
    );
    entries.push({
      displayLabel: image.sourceLabel,
      page,
      kind,
      ...(image.label ? { label: image.label } : {}),
      ...(image.caption ? { caption: image.caption } : {}),
      similarity: Math.round(image.score * 1000) / 1000,
      why: image.why,
      ...(uri ? { pageLink: `[p. ${page}](${uri})` } : {}),
    });
    artifacts.push({
      kind: "image",
      mimeType: image.mimeType,
      storedPath: persisted.storedPath,
      contentHash: persisted.contentHash,
      title: `${image.sourceLabel} — p. ${page} ${kind}${image.label ? ` — ${image.label}` : ""}`,
      pageIndex: image.pageIndex,
      pageLabel: `${page}`,
      paperContext: image.paperContext,
    });
  }
  return entries.some((entry) => entry.pageLink)
    ? { entries, artifacts, note: PAGE_LINK_NOTE }
    : { entries, artifacts };
}
