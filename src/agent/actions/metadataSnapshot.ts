import type {
  EditableArticleCreator,
  EditableArticleMetadataField,
} from "../services/zoteroGateway";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function getMetadataField(
  metadata: unknown,
  fieldName: EditableArticleMetadataField,
): string | undefined {
  const record = asRecord(metadata);
  if (!record) return undefined;
  const direct = readString(record[fieldName]);
  if (direct) return direct;
  const fields = asRecord(record.fields);
  return readString(fields?.[fieldName]);
}

export function getMetadataTitle(metadata: unknown): string | undefined {
  return getMetadataField(metadata, "title");
}

function isCreator(value: unknown): value is EditableArticleCreator {
  const record = asRecord(value);
  if (!record) return false;
  return Boolean(
    readString(record.name) ||
    readString(record.firstName) ||
    readString(record.lastName),
  );
}

export function hasMetadataCreators(metadata: unknown): boolean {
  const record = asRecord(metadata);
  return (
    Array.isArray(record?.creators) &&
    record.creators.some((entry) => isCreator(entry))
  );
}
