import type { PlanDocument } from "./types";
import { sha256Bytes } from "../store/journalRecoveryBlobStore";

export async function readVerifiedAssetBytes(
  asset: PlanDocument["assets"][number],
): Promise<Uint8Array> {
  const io = (globalThis as unknown as { IOUtils?: any }).IOUtils;
  if (typeof io?.read !== "function") {
    throw new Error(
      "Document asset storage is unavailable in this Zotero build",
    );
  }
  const source = await io.read(asset.durablePath);
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  const checksum = await sha256Bytes(bytes);
  const expected = asset.contentHash.replace(/^sha256:/, "");
  if (checksum !== expected || bytes.byteLength !== asset.byteLength) {
    throw new Error(
      `Document asset ${asset.assetId} failed integrity validation`,
    );
  }
  return bytes;
}

function extensionForMime(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    default:
      return "bin";
  }
}

export function pathParts(path: string): { directory: string; stem: string } {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const directory = slash >= 0 ? path.slice(0, slash) : ".";
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const stem = name.replace(/\.md$/i, "") || "plan-document";
  return { directory, stem };
}

/** Prepare immutable bytes and exact sibling destinations before authorization. */
export async function prepareDocumentMarkdownExport(
  document: PlanDocument,
  outputPath: string,
) {
  const { directory, stem } = pathParts(outputPath);
  const separator = outputPath.includes("\\") ? "\\" : "/";
  const assets = await Promise.all(
    document.assets.map(async (asset) => {
      if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(asset.assetId))
        throw new Error("Invalid document asset identity");
      const fileName = `${asset.assetId}.${extensionForMime(asset.mimeType)}`;
      return {
        asset,
        bytes: await readVerifiedAssetBytes(asset),
        fileName,
        path: `${directory}${separator}${stem}_assets${separator}${fileName}`,
      };
    }),
  );
  const figureMarkdown = assets.length
    ? `\n\n## Figures\n\n${assets.map(({ asset, fileName }) => `![${asset.caption.replace(/\[|\]/g, "")}](${encodeURIComponent(stem + "_assets")}/${encodeURIComponent(fileName)})`).join("\n\n")}\n`
    : "\n";
  const bytes = new TextEncoder().encode(
    `${document.visibleMarkdown.trimEnd()}${figureMarkdown}`,
  );
  return { documentId: document.documentId, path: outputPath, bytes, assets };
}
