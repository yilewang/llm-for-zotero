import type { PaperContextRef } from "../../shared/types";
import type {
  LibraryReadMetadataV1,
  ProjectedPaperMetadata,
  ResolvedItemMetadata,
  ResolvedPaperMetadataResolution,
  ZoteroCreator,
  ZoteroTurnMetadataContext,
} from "./types";

function normalizeText(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function creatorName(creator: ZoteroCreator): string {
  return (
    normalizeText(creator.name) ||
    [creator.firstName, creator.lastName]
      .map(normalizeText)
      .filter(Boolean)
      .join(" ")
  );
}

function projectStoredPaperFallback(
  ref: PaperContextRef,
  warnings: ProjectedPaperMetadata["warnings"],
): ProjectedPaperMetadata {
  const title = normalizeText(ref.title);
  const firstCreator = normalizeText(ref.firstCreator);
  const year = normalizeText(ref.year);
  const citationKey = normalizeText(ref.citationKey);
  const attachmentTitle = normalizeText(ref.attachmentTitle);
  return {
    source: "stored_fallback",
    itemId: Math.floor(ref.itemId),
    contextItemId: Math.floor(ref.contextItemId),
    ...(title ? { title } : {}),
    creators: [],
    ...(firstCreator ? { creatorDisplay: firstCreator, firstCreator } : {}),
    ...(year ? { year } : {}),
    ...(citationKey ? { citationKey } : {}),
    ...(attachmentTitle
      ? {
          contentSource: {
            itemId: Math.floor(ref.contextItemId),
            title: attachmentTitle,
          },
        }
      : {}),
    warnings,
  };
}

export function projectPaperMetadata(
  resolution: ResolvedPaperMetadataResolution,
  fallbackRef: PaperContextRef,
): ProjectedPaperMetadata {
  if (resolution.status === "unavailable") {
    return projectStoredPaperFallback(fallbackRef, resolution.warnings);
  }
  const bibliography = resolution.value.bibliographicItem?.bibliography;
  const creators = resolution.value.bibliographicItem?.creators || [];
  const creatorDisplay = creators.map(creatorName).filter(Boolean).join(", ");
  const firstCreator =
    resolution.value.bibliographicItem?.firstCreator ||
    creators.map(creatorName).find(Boolean);
  const contentSource = resolution.value.contentSource;
  return {
    source: "live",
    itemId: Math.floor(fallbackRef.itemId),
    contextItemId: Math.floor(fallbackRef.contextItemId),
    ...(bibliography?.title?.value ? { title: bibliography.title.value } : {}),
    ...(bibliography?.abstract?.value
      ? { abstract: bibliography.abstract.value }
      : {}),
    creators,
    ...(creatorDisplay ? { creatorDisplay } : {}),
    ...(firstCreator ? { firstCreator } : {}),
    ...(bibliography?.publicationDate?.value
      ? { publicationDate: bibliography.publicationDate.value }
      : {}),
    ...(bibliography?.year?.value ? { year: bibliography.year.value } : {}),
    ...(bibliography?.citationKey?.value
      ? { citationKey: bibliography.citationKey.value }
      : {}),
    ...(bibliography?.doi?.value ? { doi: bibliography.doi.value } : {}),
    ...(bibliography?.containerTitle?.value
      ? {
          containerTitle: bibliography.containerTitle.value,
          containerSourceField: bibliography.containerTitle.sourceField,
        }
      : {}),
    ...(bibliography?.eventTitle?.value
      ? {
          eventTitle: bibliography.eventTitle.value,
          eventSourceField: bibliography.eventTitle.sourceField,
        }
      : {}),
    ...(bibliography?.journalAbbreviation?.value
      ? { journalAbbreviation: bibliography.journalAbbreviation.value }
      : {}),
    ...(contentSource
      ? {
          contentSource: {
            itemId: contentSource.identity.itemId,
            ...(contentSource.parentItemId
              ? { parentItemId: contentSource.parentItemId }
              : {}),
            ...(contentSource.title ? { title: contentSource.title } : {}),
            ...(contentSource.filename
              ? { filename: contentSource.filename }
              : {}),
            ...(contentSource.contentType
              ? { contentType: contentSource.contentType }
              : {}),
          },
        }
      : {}),
    warnings: resolution.warnings,
  };
}

export function createZoteroTurnMetadataContext(
  entries: readonly Readonly<{
    ref: PaperContextRef;
    resolution: ResolvedPaperMetadataResolution;
  }>[],
): ZoteroTurnMetadataContext {
  return {
    papers: entries.map(({ ref, resolution }) => ({
      itemId: Math.floor(ref.itemId),
      contextItemId: Math.floor(ref.contextItemId),
      metadata: projectPaperMetadata(resolution, ref),
    })),
  };
}

export function projectLibraryReadMetadata(
  item: ResolvedItemMetadata,
): LibraryReadMetadataV1 {
  const common = {
    schemaVersion: 1 as const,
    kind: item.kind,
    itemId: item.identity.itemId,
    libraryID: item.identity.libraryID,
    ...(item.identity.key ? { key: item.identity.key } : {}),
    itemType: item.identity.itemType,
    title: item.title,
    fields: item.fields || {},
    ...(item.system ? { system: item.system } : {}),
  };
  if (item.kind === "regular") {
    return { ...common, kind: "regular", creators: item.creators };
  }
  if (item.kind === "attachment") {
    return {
      ...common,
      kind: "attachment",
      ...(item.parentItemId ? { parentItemId: item.parentItemId } : {}),
      ...(item.filename ? { filename: item.filename } : {}),
      ...(item.contentType ? { contentType: item.contentType } : {}),
    };
  }
  return {
    ...common,
    kind: "note",
    noteKind: item.noteKind,
    ...(item.parentItemId ? { parentItemId: item.parentItemId } : {}),
  };
}
