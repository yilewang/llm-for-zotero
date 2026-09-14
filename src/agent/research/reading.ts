import { buildPaperDisplayLabels } from "../../shared/paperDisplayLabels";
import type {
  TaskEvidence,
  TrustedReadObservation,
  VerifiedReadSource,
} from "../plans/types";
import type {
  LibraryItemTargetAttachment,
  ZoteroGateway,
} from "../services/zoteroGateway";
import type { ResearchCorpusItem, ResearchEvidenceRecord } from "./types";

export function selectPreferredReadingAttachment(
  attachments: readonly LibraryItemTargetAttachment[],
): LibraryItemTargetAttachment | undefined {
  const pdfs = attachments.filter((attachment) => {
    const contentType = String(attachment.contentType || "")
      .trim()
      .toLowerCase();
    const title = String(attachment.title || "")
      .trim()
      .toLowerCase();
    return contentType === "application/pdf" || title.endsWith(".pdf");
  });
  return pdfs
    .map((attachment, ordinal) => ({
      attachment,
      ordinal,
      score:
        (attachment.mineruCacheDir?.trim() ? 4 : 0) +
        (attachment.indexingState === "indexed"
          ? 3
          : attachment.indexingState === "partial"
            ? 2
            : 0),
    }))
    .sort(
      (left, right) => right.score - left.score || left.ordinal - right.ordinal,
    )[0]?.attachment;
}
export type ReadingManifestEntry = {
  identity: string;
  libraryID: number;
  itemKey: string;
  ordinal: number;
  title: string;
  firstCreator?: string;
  year?: string;
  displayLabel?: string;
  hasAbstract: boolean;
  readable: boolean;
  indexed: boolean;
  evidenceDepthTarget: "metadata" | "abstract" | "body";
  target?: { itemId: number; contextItemId: number };
};
export async function buildReadingManifest(params: {
  corpus: readonly ResearchCorpusItem[];
  gateway: ZoteroGateway;
  requiredEvidenceDepth: "metadata" | "abstract" | "body";
  preferredContextItemIds?: ReadonlyMap<string, number>;
  displayLabels?: ReadonlyMap<string, string>;
}): Promise<ReadingManifestEntry[]> {
  const manifest: ReadingManifestEntry[] = [];
  for (const entry of [...params.corpus].sort(
    (left, right) => left.ordinal - right.ordinal,
  )) {
    const identity = `${entry.libraryID}:${entry.itemKey}`;
    const item =
      Zotero.Items.getByLibraryAndKey(entry.libraryID, entry.itemKey) ||
      undefined;
    let preferredContextItemId = params.preferredContextItemIds?.get(identity);
    if (!preferredContextItemId && item) {
      const attachments = await params.gateway.getAllChildAttachmentInfos(
        item.id,
      );
      preferredContextItemId =
        selectPreferredReadingAttachment(attachments)?.contextItemId;
    }
    const attachment = preferredContextItemId
      ? Zotero.Items.get(preferredContextItemId) || undefined
      : undefined;
    manifest.push({
      identity,
      libraryID: entry.libraryID,
      itemKey: entry.itemKey,
      ordinal: entry.ordinal,
      title:
        String(
          item?.getField?.("title") || item?.getDisplayTitle?.() || "",
        ).trim() || "Untitled item",
      firstCreator:
        String(item?.getField?.("firstCreator") || "").trim() || undefined,
      year: String(item?.getField?.("date") || "").match(/\b\d{4}\b/)?.[0],
      hasAbstract: entry.hasAbstract,
      readable: entry.readable,
      indexed: entry.indexed,
      evidenceDepthTarget: entry.readable
        ? params.requiredEvidenceDepth
        : entry.hasAbstract
          ? "abstract"
          : "metadata",
      ...(item
        ? {
            target: {
              itemId: Number(item.id),
              contextItemId: Number(attachment?.id || item.id),
            },
          }
        : {}),
    });
  }
  const labels = params.displayLabels || buildPaperDisplayLabels(manifest);
  return manifest.map((entry) => ({
    ...entry,
    displayLabel: labels.get(entry.identity),
  }));
}
export function verifiedReadDepth(
  observations: readonly TrustedReadObservation[],
) {
  if (
    observations.some((entry) =>
      entry.capabilities.some((capability) =>
        ["body", "figure", "quote"].includes(capability),
      ),
    )
  ) {
    return "body";
  }
  return observations.some((entry) => entry.capabilities.includes("abstract"))
    ? "abstract"
    : "metadata";
}
export function resolveTrustedPdfLocator(params: {
  evidenceKey: string;
  sourceKind: ResearchEvidenceRecord["sourceKind"];
  requested: Readonly<{ attachmentItemKey: string; pageIndex: number }>;
  observations: readonly TrustedReadObservation[];
  fallbackFingerprint: string;
}): ResearchEvidenceRecord["locator"] {
  const locatable = params.observations.filter(
    (observation) =>
      Boolean(observation.attachmentItemKey) &&
      Number.isFinite(observation.pageIndex),
  );
  if (!locatable.length && params.sourceKind === "body") return undefined;
  const trusted = locatable.find(
    (observation) =>
      observation.attachmentItemKey === params.requested.attachmentItemKey &&
      observation.pageIndex === params.requested.pageIndex,
  );
  if (!trusted) {
    throw new Error(
      `Evidence ${params.evidenceKey} locator was not emitted by its verified read`,
    );
  }
  return {
    kind: "pdf_page",
    attachmentItemKey: params.requested.attachmentItemKey,
    pageIndex: params.requested.pageIndex,
    sourceFingerprint: trusted.sourceFingerprint || params.fallbackFingerprint,
  };
}
export function selectPreferredVerifiedReads(
  evidence: readonly TaskEvidence[],
  corpusIdentities: ReadonlySet<string>,
): Map<string, PreferredVerifiedRead> {
  const selected = new Map<
    string,
    PreferredVerifiedRead & Readonly<{ createdAt: number }>
  >();
  for (const entry of evidence) {
    if (
      entry.kind !== "verified_read" ||
      !entry.verified ||
      !entry.reference ||
      entry.payload?.type !== "verified_read"
    ) {
      continue;
    }
    const observations = entry.payload.observations || [];
    for (const observation of observations) {
      const identity = `${observation.libraryID}:${observation.itemKey}`;
      if (!corpusIdentities.has(identity)) continue;
      const matchingObservations = observations.filter(
        (candidate) =>
          candidate.libraryID === observation.libraryID &&
          candidate.itemKey === observation.itemKey,
      );
      const matchingSources = matchingObservations.map(
        ({
          libraryID,
          itemKey,
          attachmentItemKey,
          pageIndex,
          sourceFingerprint,
        }) => ({
          libraryID,
          itemKey,
          attachmentItemKey,
          pageIndex,
          sourceFingerprint,
        }),
      );
      const candidate = {
        sourceReadRef: entry.reference,
        sources: matchingSources,
        observationIds: matchingObservations.map(
          (candidate) => candidate.observationId,
        ),
        evidenceDepth: verifiedReadDepth(matchingObservations),
        createdAt: entry.createdAt,
      } as const;
      const current = selected.get(identity);
      if (
        !current ||
        ["metadata", "abstract", "body"].indexOf(candidate.evidenceDepth) >
          ["metadata", "abstract", "body"].indexOf(current.evidenceDepth) ||
        (current.evidenceDepth === candidate.evidenceDepth &&
          candidate.createdAt >= current.createdAt)
      ) {
        selected.set(identity, candidate);
      }
    }
  }
  return new Map(
    [...selected.entries()].map(([identity, entry]) => [
      identity,
      {
        sourceReadRef: entry.sourceReadRef,
        sources: entry.sources,
        observationIds: entry.observationIds,
        evidenceDepth: entry.evidenceDepth,
      },
    ]),
  );
}

type PreferredVerifiedRead = Readonly<{
  sourceReadRef: string;
  sources: readonly VerifiedReadSource[];
  observationIds: readonly string[];
  evidenceDepth: "metadata" | "abstract" | "body";
}>;
