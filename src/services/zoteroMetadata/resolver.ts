import type { PaperContextRef } from "../../shared/types";
import type {
  ResolvedAttachmentItemMetadata,
  ResolvedAttachmentMetadata,
  ResolvedBibliographicItem,
  ResolvedItemMetadata,
  ResolvedItemMetadataResolution,
  ResolvedNoteMetadata,
  ResolvedPaperMetadataResolution,
  ResolvedRegularItemMetadata,
  ResolvedZoteroSystemMetadata,
  ZoteroBibliographicSemantics,
  ZoteroCreator,
  ZoteroItemIdentity,
  ZoteroMetadataResolver,
  ZoteroSemanticValue,
} from "./types";

type ZoteroItemFieldsApi = {
  getID?: (fieldName: string) => number | false;
  getFieldIDFromTypeAndBase?: (
    itemTypeId: number,
    baseFieldId: number,
  ) => number | false;
  getItemTypeFields?: (itemTypeId: number) => number[];
  getName?: (fieldId: number) => string;
};

const SYSTEM_FIELD_NAMES = new Set([
  "dateAdded",
  "dateModified",
  "version",
  "synced",
  "deleted",
  "parentItem",
  "parentID",
  "parentKey",
  "relations",
  "collections",
  "tags",
  "note",
]);

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function normalizePositiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function getItemFieldsApi(): ZoteroItemFieldsApi | undefined {
  if (typeof Zotero === "undefined") return undefined;
  return (Zotero as unknown as { ItemFields?: ZoteroItemFieldsApi }).ItemFields;
}

function getItemTypeName(item: Zotero.Item): string {
  const direct = normalizeText(
    (item as Zotero.Item & { itemType?: unknown }).itemType,
  );
  if (direct) return direct;
  if (typeof Zotero === "undefined") {
    if (item.isAttachment?.()) return "attachment";
    if ((item as Zotero.Item & { isNote?: () => boolean }).isNote?.()) {
      return "note";
    }
    return "item";
  }
  const itemTypes = (
    Zotero as unknown as {
      ItemTypes?: { getName?: (itemTypeId: number) => string };
    }
  ).ItemTypes;
  const fromSchema = normalizeText(itemTypes?.getName?.(item.itemTypeID));
  if (fromSchema) return fromSchema;
  if (item.isAttachment?.()) return "attachment";
  if ((item as Zotero.Item & { isNote?: () => boolean }).isNote?.()) {
    return "note";
  }
  return "item";
}

function getIdentity(item: Zotero.Item): ZoteroItemIdentity {
  const key = normalizeText((item as Zotero.Item & { key?: unknown }).key);
  return {
    itemId: Math.floor(Number(item.id)),
    libraryID: Math.floor(Number(item.libraryID) || 0),
    ...(key ? { key } : {}),
    itemType: getItemTypeName(item),
  };
}

function readExactField(item: Zotero.Item, fieldName: string): string {
  if (typeof item.getField !== "function") return "";
  return normalizeText(item.getField(fieldName));
}

function resolveMappedFieldName(
  item: Zotero.Item,
  baseFieldName: string,
): string | undefined {
  const itemFields = getItemFieldsApi();
  if (
    !itemFields?.getID ||
    !itemFields.getFieldIDFromTypeAndBase ||
    !itemFields.getName
  ) {
    return undefined;
  }
  const baseFieldId = itemFields.getID(baseFieldName);
  if (!baseFieldId) return undefined;
  const mappedFieldId = itemFields.getFieldIDFromTypeAndBase(
    item.itemTypeID,
    baseFieldId,
  );
  const fieldName = mappedFieldId
    ? normalizeText(itemFields.getName(mappedFieldId))
    : "";
  return fieldName || undefined;
}

function resolveSchemaFieldNames(
  item: Zotero.Item,
  baseFieldName: string,
  fallbackFieldNames: readonly string[],
): readonly string[] | undefined {
  const itemFields = getItemFieldsApi();
  if (!itemFields?.getItemTypeFields || !itemFields.getName) return undefined;
  const supportedNames = new Set(
    (itemFields.getItemTypeFields(item.itemTypeID) || [])
      .map((fieldId) => normalizeText(itemFields.getName?.(fieldId)))
      .filter(Boolean),
  );
  const mappedFieldName = resolveMappedFieldName(item, baseFieldName);
  const fieldNames = Array.from(
    new Set([mappedFieldName, baseFieldName, ...fallbackFieldNames]),
  ).filter(
    (fieldName): fieldName is string =>
      typeof fieldName === "string" && supportedNames.has(fieldName),
  );

  // Better BibTeX exposes citationKey through Zotero.Item#getField without
  // registering it as a native Zotero item-type field.
  if (baseFieldName === "citationKey" && !fieldNames.includes("citationKey")) {
    fieldNames.push("citationKey");
  }
  return fieldNames;
}

function readSemanticField(
  item: Zotero.Item,
  baseFieldName: string,
  fallbackFieldNames: readonly string[] = [],
): ZoteroSemanticValue | undefined {
  const fieldNames =
    resolveSchemaFieldNames(item, baseFieldName, fallbackFieldNames) ||
    Array.from(new Set([baseFieldName, ...fallbackFieldNames]));
  for (const fieldName of fieldNames) {
    const value = readExactField(item, fieldName);
    if (value) return { value, sourceField: fieldName };
  }
  return undefined;
}

function normalizeCreator(value: unknown): ZoteroCreator | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const creatorType = normalizeText(record.creatorType) || "author";
  const name = normalizeText(record.name);
  const firstName = normalizeText(record.firstName);
  const lastName = normalizeText(record.lastName);
  const fieldMode = Number(record.fieldMode) === 1 || name ? 1 : 0;
  if (!name && !firstName && !lastName) return null;
  return {
    creatorType,
    ...(firstName ? { firstName } : {}),
    ...(lastName ? { lastName } : {}),
    ...(name ? { name } : {}),
    fieldMode,
  };
}

function readCreators(item: Zotero.Item): readonly ZoteroCreator[] {
  const values = item.getCreatorsJSON?.() || [];
  return values
    .map((creator) => normalizeCreator(creator))
    .filter((creator): creator is ZoteroCreator => Boolean(creator));
}

function creatorDisplayName(creator: ZoteroCreator): string {
  if (creator.name) return creator.name;
  return [creator.firstName, creator.lastName].filter(Boolean).join(" ");
}

function readBibliography(item: Zotero.Item): ZoteroBibliographicSemantics {
  const title = readSemanticField(item, "title");
  const abstract = readSemanticField(item, "abstractNote");
  const publicationDate = readSemanticField(item, "date", ["issued"]);
  const citationKey = readSemanticField(item, "citationKey");
  const doi = readSemanticField(item, "DOI");
  const containerTitle = readSemanticField(item, "publicationTitle", [
    "bookTitle",
    "proceedingsTitle",
  ]);
  const eventTitle = readSemanticField(item, "conferenceName", ["meetingName"]);
  const journalAbbreviation = readSemanticField(item, "journalAbbreviation");
  const dateYear = publicationDate?.value.match(/\b(\d{4})\b/)?.[1];
  const year =
    dateYear && publicationDate
      ? { value: dateYear, sourceField: publicationDate.sourceField }
      : undefined;
  return {
    ...(title ? { title } : {}),
    ...(abstract ? { abstract } : {}),
    ...(publicationDate ? { publicationDate } : {}),
    ...(year ? { year } : {}),
    ...(citationKey ? { citationKey } : {}),
    ...(doi ? { doi } : {}),
    ...(containerTitle ? { containerTitle } : {}),
    ...(eventTitle ? { eventTitle } : {}),
    ...(journalAbbreviation ? { journalAbbreviation } : {}),
  };
}

function readBibliographicItem(item: Zotero.Item): ResolvedBibliographicItem {
  const creators = readCreators(item);
  const firstCreator = creators.map(creatorDisplayName).find(Boolean);
  const displayTitle = normalizeText(item.getDisplayTitle?.());
  return {
    identity: getIdentity(item),
    bibliography: readBibliography(item),
    creators,
    ...(displayTitle ? { displayTitle } : {}),
    ...(firstCreator ? { firstCreator } : {}),
  };
}

function readAttachment(item: Zotero.Item): ResolvedAttachmentMetadata {
  const title =
    readExactField(item, "title") || normalizeText(item.getDisplayTitle?.());
  const attachment = item as Zotero.Item & {
    attachmentFilename?: unknown;
    attachmentContentType?: unknown;
    getFilename?: () => string;
  };
  const filename =
    normalizeText(attachment.attachmentFilename) ||
    normalizeText(attachment.getFilename?.());
  const contentType = normalizeText(attachment.attachmentContentType);
  const parentItemId = normalizePositiveInt(item.parentID);
  return {
    identity: getIdentity(item),
    ...(parentItemId ? { parentItemId } : {}),
    ...(title ? { title } : {}),
    ...(filename ? { filename } : {}),
    ...(contentType ? { contentType } : {}),
  };
}

function readCompleteFields(
  item: Zotero.Item,
): Readonly<Record<string, string>> {
  const fields: Record<string, string> = {};
  const itemFields = getItemFieldsApi();
  if (itemFields?.getItemTypeFields && itemFields.getName) {
    const fieldIds = itemFields.getItemTypeFields(item.itemTypeID) || [];
    for (const fieldId of fieldIds) {
      const fieldName = normalizeText(itemFields.getName(fieldId));
      if (!fieldName || SYSTEM_FIELD_NAMES.has(fieldName)) continue;
      const value = readExactField(item, fieldName);
      if (value) fields[fieldName] = value;
    }
    return fields;
  }

  const json = (item as Zotero.Item & { toJSON?: () => unknown }).toJSON?.();
  if (!json || typeof json !== "object" || Array.isArray(json)) return fields;
  for (const [fieldName, rawValue] of Object.entries(json)) {
    if (SYSTEM_FIELD_NAMES.has(fieldName)) continue;
    if (
      fieldName === "creators" ||
      fieldName === "itemType" ||
      fieldName === "key" ||
      fieldName === "libraryID"
    ) {
      continue;
    }
    const value = normalizeText(rawValue);
    if (value) fields[fieldName] = value;
  }
  return fields;
}

function readSystemMetadata(item: Zotero.Item): ResolvedZoteroSystemMetadata {
  const dateAdded =
    readExactField(item, "dateAdded") ||
    normalizeText((item as Zotero.Item & { dateAdded?: unknown }).dateAdded);
  const dateModified =
    readExactField(item, "dateModified") ||
    normalizeText(
      (item as Zotero.Item & { dateModified?: unknown }).dateModified,
    );
  const version = normalizePositiveInt(
    (item as Zotero.Item & { version?: unknown }).version,
  );
  return {
    ...(dateAdded ? { dateAdded } : {}),
    ...(dateModified ? { dateModified } : {}),
    ...(version ? { version } : {}),
  };
}

function readItemMetadata(
  item: Zotero.Item,
  options: {
    detail: "summary" | "complete";
    includeSystemMetadata?: boolean;
  },
): ResolvedItemMetadata {
  const identity = getIdentity(item);
  const displayTitle = normalizeText(item.getDisplayTitle?.());
  const fields =
    options.detail === "complete" ? readCompleteFields(item) : undefined;
  const system = options.includeSystemMetadata
    ? readSystemMetadata(item)
    : undefined;
  const common = {
    identity,
    title:
      readExactField(item, "title") ||
      displayTitle ||
      `${identity.itemType} ${identity.itemId}`,
    ...(fields ? { fields } : {}),
    ...(system ? { system } : {}),
  };

  if (item.isAttachment?.()) {
    const attachment = readAttachment(item);
    const resolved: ResolvedAttachmentItemMetadata = {
      ...common,
      kind: "attachment",
      ...(attachment.parentItemId
        ? { parentItemId: attachment.parentItemId }
        : {}),
      ...(attachment.filename ? { filename: attachment.filename } : {}),
      ...(attachment.contentType
        ? { contentType: attachment.contentType }
        : {}),
    };
    return resolved;
  }

  if ((item as Zotero.Item & { isNote?: () => boolean }).isNote?.()) {
    const parentItemId = normalizePositiveInt(item.parentID);
    const noteTitle = normalizeText(
      (item as Zotero.Item & { getNoteTitle?: () => string }).getNoteTitle?.(),
    );
    const resolved: ResolvedNoteMetadata = {
      ...common,
      title: noteTitle || common.title,
      kind: "note",
      noteKind: parentItemId ? "item" : "standalone",
      ...(parentItemId ? { parentItemId } : {}),
    };
    return resolved;
  }

  const resolved: ResolvedRegularItemMetadata = {
    ...common,
    kind: "regular",
    bibliography: readBibliography(item),
    creators: readCreators(item),
  };
  return resolved;
}

export function createZoteroMetadataResolver(
  options: {
    getItem?: (itemId: number) => Zotero.Item | null | undefined;
  } = {},
): ZoteroMetadataResolver {
  const itemCache = new Map<number, Zotero.Item | null>();

  const getItem = (itemId: number): Zotero.Item | null => {
    const normalizedItemId = normalizePositiveInt(itemId);
    if (!normalizedItemId) return null;
    if (itemCache.has(normalizedItemId)) {
      return itemCache.get(normalizedItemId) || null;
    }
    const items =
      typeof Zotero === "undefined"
        ? undefined
        : (
            Zotero as unknown as {
              Items?: {
                get?: (itemId: number) => Zotero.Item | null | undefined;
              };
            }
          ).Items;
    const item =
      (options.getItem
        ? options.getItem(normalizedItemId)
        : items?.get?.(normalizedItemId)) || null;
    itemCache.set(normalizedItemId, item);
    return item;
  };

  const resolveItemMetadata = (
    itemId: number,
    options: {
      detail: "summary" | "complete";
      includeSystemMetadata?: boolean;
    },
  ): ResolvedItemMetadataResolution => {
    const normalizedItemId = normalizePositiveInt(itemId);
    if (!normalizedItemId) {
      return {
        status: "unavailable",
        reason: "invalid_item_id",
        warnings: [],
      };
    }
    const item = getItem(normalizedItemId);
    if (!item) {
      return { status: "unavailable", reason: "missing_item", warnings: [] };
    }
    return {
      status: "resolved",
      value: readItemMetadata(item, options),
      warnings: [],
    };
  };

  const resolvePaperMetadata = (
    ref: PaperContextRef,
  ): ResolvedPaperMetadataResolution => {
    const itemId = normalizePositiveInt(ref.itemId);
    if (!itemId) {
      return {
        status: "unavailable",
        reason: "invalid_item_id",
        warnings: [],
      };
    }
    const primaryItem = getItem(itemId);
    if (!primaryItem) {
      return { status: "unavailable", reason: "missing_item", warnings: [] };
    }
    if ((primaryItem as Zotero.Item & { isNote?: () => boolean }).isNote?.()) {
      return {
        status: "unavailable",
        reason: "unsupported_item_kind",
        warnings: [],
      };
    }
    if (primaryItem.isAttachment?.()) {
      return {
        status: "resolved",
        value: { contentSource: readAttachment(primaryItem) },
        warnings: [],
      };
    }
    if (
      !(
        primaryItem as Zotero.Item & { isRegularItem?: () => boolean }
      ).isRegularItem?.()
    ) {
      return {
        status: "unavailable",
        reason: "unsupported_item_kind",
        warnings: [],
      };
    }

    const bibliographicItem = readBibliographicItem(primaryItem);
    const contextItemId = normalizePositiveInt(ref.contextItemId);
    if (!contextItemId || contextItemId === itemId) {
      return {
        status: "resolved",
        value: { bibliographicItem },
        warnings: [],
      };
    }
    const contentItem = getItem(contextItemId);
    if (!contentItem) {
      return {
        status: "resolved",
        value: { bibliographicItem },
        warnings: [
          {
            code: "missing_content_source",
            message: `Content source item ${contextItemId} was not found`,
          },
        ],
      };
    }
    if (
      !contentItem.isAttachment?.() ||
      normalizePositiveInt(contentItem.parentID) !== itemId
    ) {
      return {
        status: "resolved",
        value: { bibliographicItem },
        warnings: [
          {
            code: "invalid_content_source_relationship",
            message: `Item ${contextItemId} is not a child attachment of item ${itemId}`,
          },
        ],
      };
    }
    return {
      status: "resolved",
      value: {
        bibliographicItem,
        contentSource: readAttachment(contentItem),
      },
      warnings: [],
    };
  };

  return { resolvePaperMetadata, resolveItemMetadata };
}
