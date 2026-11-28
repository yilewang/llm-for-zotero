import type {
  EditableArticleCreator,
  EditableArticleMetadataField,
} from "../services/zoteroGateway";
import { recordOrNull, trimmedStringOrUndefined } from "../../core/values";

export function getMetadataField(
  metadata: unknown,
  fieldName: EditableArticleMetadataField,
): string | undefined {
  const record = recordOrNull(metadata);
  if (!record) return undefined;
  const direct = trimmedStringOrUndefined(record[fieldName]);
  if (direct) return direct;
  const fields = recordOrNull(record.fields);
  return trimmedStringOrUndefined(fields?.[fieldName]);
}

export function getMetadataTitle(metadata: unknown): string | undefined {
  return getMetadataField(metadata, "title");
}

function isCreator(value: unknown): value is EditableArticleCreator {
  const record = recordOrNull(value);
  if (!record) return false;
  return Boolean(
    trimmedStringOrUndefined(record.name) ||
    trimmedStringOrUndefined(record.firstName) ||
    trimmedStringOrUndefined(record.lastName),
  );
}

export function hasMetadataCreators(metadata: unknown): boolean {
  const record = recordOrNull(metadata);
  return (
    Array.isArray(record?.creators) &&
    record.creators.some((entry) => isCreator(entry))
  );
}
