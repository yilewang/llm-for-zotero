import { Marked } from "marked";
import {
  PLAN_DOCUMENT_ASSET_MAX_BYTES,
  PLAN_DOCUMENT_ASSETS_MAX_BYTES,
  type PlanDocumentAsset,
} from "./types";
import { ToolInputRejection } from "../tools/execution/failure";
export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function validateVisibleDocumentPrivacy(markdown: string): void {
  const parser = new Marked();
  parser.walkTokens(parser.lexer(markdown), (token) => {
    if (token.type === "image") {
      throw new ToolInputRejection(
        "Document figures must be supplied in assets, not as Markdown image paths. Copy the selected figure's documentAsset from paper_read into assets; the host renders its image, caption and provenance.",
      );
    }
  });
  if (
    /(?:file:\/\/|(?:^|[\s("'])\/(?:Users|home|private|tmp|var)\/|[A-Za-z]:\\(?:Users|Documents|Desktop)\\)/m.test(
      markdown,
    )
  ) {
    throw new ToolInputRejection(
      "Document Markdown contains a local filesystem path; use relative asset links or Zotero links",
    );
  }
}

export function validateAssets(
  assets: readonly PlanDocumentAsset[],
  requireEvidence = true,
): void {
  let total = 0;
  const ids = new Set<string>();
  for (const asset of assets) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(asset.assetId) ||
      asset.assetId.includes("..") ||
      ids.has(asset.assetId)
    ) {
      throw new ToolInputRejection(
        `Duplicate or empty document asset ID: ${asset.assetId}`,
      );
    }
    ids.add(asset.assetId);
    if (!asset.contentHash.trim() || !asset.durablePath.trim()) {
      throw new ToolInputRejection(
        `Document asset ${asset.assetId} lacks durable provenance`,
      );
    }
    if (!/^sha256:[a-f0-9]{64}$/i.test(asset.contentHash)) {
      throw new ToolInputRejection(
        `Document asset ${asset.assetId} has an invalid content hash`,
      );
    }
    if (!/^image\/(?:png|jpeg|gif|webp|svg\+xml)$/i.test(asset.mimeType)) {
      throw new ToolInputRejection(
        `Document asset ${asset.assetId} is not a supported figure`,
      );
    }
    if (
      !Number.isInteger(asset.width) ||
      Number(asset.width) <= 0 ||
      !Number.isInteger(asset.height) ||
      Number(asset.height) <= 0
    ) {
      throw new ToolInputRejection(
        `Document asset ${asset.assetId} requires dimensions`,
      );
    }
    if (!asset.caption.trim()) {
      throw new ToolInputRejection(
        `Document asset ${asset.assetId} requires a caption`,
      );
    }
    if (
      requireEvidence &&
      asset.provenance.origin === "generated" &&
      !asset.provenance.evidenceRefs.length
    ) {
      throw new ToolInputRejection(
        `Generated asset ${asset.assetId} requires evidence references`,
      );
    }
    if (
      asset.byteLength <= 0 ||
      asset.byteLength > PLAN_DOCUMENT_ASSET_MAX_BYTES
    ) {
      throw new ToolInputRejection(
        `Document asset ${asset.assetId} exceeds the 25 MiB limit`,
      );
    }
    total += asset.byteLength;
  }
  if (total > PLAN_DOCUMENT_ASSETS_MAX_BYTES) {
    throw new ToolInputRejection(
      "Document assets exceed the 100 MiB per-document limit",
    );
  }
}
