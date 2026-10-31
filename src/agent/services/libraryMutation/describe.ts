import { formatPaperDisplayLabel } from "../../../shared/paperDisplayLabels";
import { operationLabel } from "../../contracts/operationCatalog";
import type { LibraryMutationOperation } from "./contracts";

/**
 * What a library mutation is called where a person reads it: the undo card,
 * the history list, a journal row. It is present tense ("Add tag X to ..."),
 * because the text is stored with the action before the write and read again
 * when the user decides whether to undo it.
 *
 * This file is pure. The names of items and collections come in through
 * `MutationLabels`, so a unit test needs no Zotero.
 */
export type MutationLabels = {
  /** A paper as the reader knows it, such as "(Krajeski et al., 2019)". */
  item(itemId: number): string;
  /** A collection by name; undefined when the id names none. */
  collection(collectionId: number): string | undefined;
};

type Loose = Record<string, unknown>;

const FIELD_WORDS: Record<string, string> = {
  abstractNote: "abstract",
  DOI: "DOI",
  ISSN: "ISSN",
  ISBN: "ISBN",
  url: "URL",
};

const PAST_TO_PRESENT: Record<string, string> = {
  Updated: "Update",
  Changed: "Change",
  Added: "Add",
  Removed: "Remove",
  Moved: "Move",
  Created: "Create",
  Set: "Set",
  Saved: "Save",
  Deleted: "Delete",
  Reparented: "Reparent",
  Related: "Relate",
  Imported: "Import",
  Restored: "Restore",
  Merged: "Merge",
  Renamed: "Rename",
  Relinked: "Relink",
  Attached: "Attach",
  Searched: "Search",
  Edited: "Edit",
  Wrote: "Write",
  Appended: "Append",
  Undid: "Undo",
  Reverted: "Revert",
  Ran: "Run",
  Read: "Read",
};

/** "Updated metadata" -> "Update metadata". */
function presentTense(label: string): string {
  const [first, ...rest] = label.split(" ");
  const present =
    PAST_TO_PRESENT[first] ||
    (/ed$/u.test(first) ? first.replace(/d$/u, "").replace(/e$/u, "") : first);
  return [present, ...rest].join(" ");
}

function ids(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is number => Number.isFinite(entry))
    : [];
}

function texts(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0,
      )
    : [];
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function quote(text: string): string {
  return `"${text}"`;
}

/** Up to three names in a row, then a count of the rest. */
function nameList(names: string[]): string {
  const shown = names.slice(0, 3).join(", ");
  return names.length > 3 ? `${shown} and ${names.length - 3} more` : shown;
}

function itemsPhrase(itemIds: number[], labels: MutationLabels): string {
  const distinct = unique(itemIds);
  if (distinct.length === 1) return labels.item(distinct[0]);
  if (distinct.length === 0) return "the selected items";
  return plural(distinct.length, "item");
}

function tagsPhrase(tags: string[]): string {
  const distinct = unique(tags);
  if (distinct.length === 0) return "tags";
  return `${distinct.length === 1 ? "tag" : "tags"} ${nameList(distinct)}`;
}

function collectionPhrase(
  collectionId: number | undefined,
  name: string | undefined,
  labels: MutationLabels,
): string {
  const given = name?.trim();
  const known =
    given ||
    (collectionId !== undefined ? labels.collection(collectionId) : undefined);
  return known ? quote(known) : "a collection";
}

function fieldWords(field: string): string {
  return (
    FIELD_WORDS[field] ??
    field.replace(/([a-z])([A-Z])/gu, "$1 $2").toLowerCase()
  );
}

function typeWords(itemType: string): string {
  const spaced = itemType
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .trim()
    .toLowerCase();
  return spaced
    ? spaced.charAt(0).toUpperCase() + spaced.slice(1)
    : "another type";
}

function destinationsOf(operation: Loose, labels: MutationLabels): string {
  const assignments = Array.isArray(operation.assignments)
    ? (operation.assignments as Loose[])
    : [];
  const targets = unique(
    [operation, ...assignments]
      .map((entry) =>
        entry.targetCollectionId !== undefined ||
        typeof entry.targetCollectionName === "string" ||
        typeof entry.targetCollectionPath === "string"
          ? collectionPhrase(
              Number(entry.targetCollectionId) || undefined,
              (entry.targetCollectionName as string | undefined) ||
                (entry.targetCollectionPath as string | undefined),
              labels,
            )
          : "",
      )
      .filter(Boolean),
  );
  if (targets.length === 1) return targets[0];
  if (targets.length > 1) return plural(targets.length, "collection");
  return "a collection";
}

/**
 * One operation in the reader's words. An operation this build does not
 * describe, or a journal row whose payload was dropped, falls back to the
 * catalog's label in present tense, so the line never shows a token such as
 * "apply_tags".
 */
export function describeLibraryMutation(
  operation: LibraryMutationOperation | { type: string },
  labels: MutationLabels,
): string {
  const op = operation as Loose;
  switch (operation.type) {
    case "update_metadata": {
      const metadata = (op.metadata as Loose | undefined) || {};
      const fields = Object.keys(metadata).map(fieldWords);
      const itemId =
        Number(op.itemId) || Number((op.paperContext as Loose)?.itemId) || 0;
      const target = itemId ? labels.item(itemId) : "the item";
      return fields.length
        ? `Edit ${nameList(fields)} of ${target}`
        : `Edit ${target}`;
    }
    case "change_item_type": {
      const target = Number(op.itemId)
        ? labels.item(Number(op.itemId))
        : "the item";
      return `Change ${target} to ${typeWords(String(op.itemType || ""))}`;
    }
    case "apply_tags":
    case "set_item_tags": {
      const assignments = Array.isArray(op.assignments)
        ? (op.assignments as Loose[])
        : [];
      const itemIds = unique([
        ...ids(op.itemIds),
        ...assignments
          .map((entry) => Number(entry.itemId))
          .filter(Number.isFinite),
      ]);
      const tags = unique([
        ...texts(op.tags),
        ...assignments.flatMap((entry) => texts(entry.tags)),
      ]);
      if (operation.type === "set_item_tags")
        return `Set the tags of ${itemsPhrase(itemIds, labels)}`;
      // Different tags for different items stay short rather than guessed.
      const mixed =
        assignments.length > 1 &&
        new Set(assignments.map((entry) => texts(entry.tags).join("\u0000")))
          .size > 1;
      return mixed
        ? `Add tags to ${itemsPhrase(itemIds, labels)}`
        : `Add ${tagsPhrase(tags)} to ${itemsPhrase(itemIds, labels)}`;
    }
    case "remove_tags":
      return `Remove ${tagsPhrase(texts(op.tags))} from ${itemsPhrase(ids(op.itemIds), labels)}`;
    case "move_to_collection": {
      const assignments = Array.isArray(op.assignments)
        ? (op.assignments as Loose[])
        : [];
      const itemIds = unique([
        ...ids(op.itemIds),
        ...assignments
          .map((entry) => Number(entry.itemId))
          .filter(Number.isFinite),
      ]);
      const verb = op.mode === "move" ? "Move" : "Add";
      return `${verb} ${itemsPhrase(itemIds, labels)} to ${destinationsOf(op, labels)}`;
    }
    case "remove_from_collection":
      return `Remove ${itemsPhrase(ids(op.itemIds), labels)} from ${collectionPhrase(Number(op.collectionId) || undefined, undefined, labels)}`;
    case "create_collection":
      return typeof op.name === "string" && op.name.trim()
        ? `Create collection ${quote(op.name.trim())}`
        : "Create a collection";
    case "set_item_collections": {
      const assignments = Array.isArray(op.assignments)
        ? (op.assignments as Loose[])
        : [];
      return `Set the collections of ${itemsPhrase(
        assignments
          .map((entry) => Number(entry.itemId))
          .filter(Number.isFinite),
        labels,
      )}`;
    }
    case "save_notes_batch": {
      const notes = Array.isArray(op.notes) ? (op.notes as Loose[]) : [];
      return op.mode === "append"
        ? `Append to ${plural(notes.length, "note")}`
        : `Add a note to ${plural(notes.length, "item")}`;
    }
    case "save_saved_search":
      return typeof op.name === "string" && op.name.trim()
        ? `Save search ${quote(op.name.trim())}`
        : "Save a search";
    case "delete_saved_search":
      return "Delete a saved search";
    case "update_collection": {
      const target = collectionPhrase(
        Number(op.collectionId) || undefined,
        undefined,
        labels,
      );
      return typeof op.name === "string" && op.name.trim()
        ? `Rename collection ${target} to ${quote(op.name.trim())}`
        : `Move collection ${target}`;
    }
    case "update_library_tag": {
      const tag = quote(String(op.tag || ""));
      switch (op.action) {
        case "rename":
          return `Rename tag ${tag} to ${quote(String(op.newTag || ""))}`;
        case "merge":
          return `Merge tag ${tag} into ${quote(String(op.newTag || ""))}`;
        case "delete":
          return `Delete tag ${tag} from the library`;
        default:
          return `Set the color of tag ${tag}`;
      }
    }
    case "create_items": {
      const items = Array.isArray(op.items) ? op.items : [];
      return `Create ${plural(items.length, "item")}`;
    }
    case "reparent_items": {
      const assignments = Array.isArray(op.assignments)
        ? (op.assignments as Loose[])
        : [];
      return `Change the parent of ${plural(assignments.length, "item")}`;
    }
    case "relate_items": {
      const target = Number(op.itemId)
        ? labels.item(Number(op.itemId))
        : "the item";
      const related = plural(ids(op.relatedItemIds).length, "related item");
      return op.action === "remove"
        ? `Remove ${related} from ${target}`
        : `Relate ${target} to ${plural(ids(op.relatedItemIds).length, "item")}`;
    }
    case "delete_collection": {
      const target = collectionPhrase(
        Number(op.collectionId) || undefined,
        undefined,
        labels,
      );
      return op.deleteItems
        ? `Delete collection ${target} and its items`
        : `Delete collection ${target}`;
    }
    case "save_note": {
      const target = Number(op.targetItemId)
        ? ` on ${labels.item(Number(op.targetItemId))}`
        : "";
      return `Save a note${target}`;
    }
    case "import_identifiers":
      return `Import ${plural(texts(op.identifiers).length, "identifier")}`;
    case "import_local_files":
      return `Import ${plural(texts(op.filePaths).length, "file")}`;
    case "trash_items":
      return `Move ${itemsPhrase(ids(op.itemIds), labels)} to the trash`;
    case "restore_from_trash": {
      const count =
        ids(op.itemIds).length +
        ids(op.collectionIds).length +
        ids(op.savedSearchIds).length;
      return `Restore ${plural(count, "object")} from the trash`;
    }
    case "merge_items": {
      const master = Number(op.masterItemId)
        ? labels.item(Number(op.masterItemId))
        : "one item";
      return `Merge ${plural(ids(op.otherItemIds).length, "item")} into ${master}`;
    }
    case "delete_attachment":
      return "Delete an attachment";
    case "rename_attachment":
      return typeof op.newName === "string" && op.newName.trim()
        ? `Rename an attachment to ${quote(op.newName.trim())}`
        : "Rename an attachment";
    case "relink_attachment":
      return "Relink an attachment";
    case "attach_file": {
      const parent = Number(op.parentItemId)
        ? ` to ${labels.item(Number(op.parentItemId))}`
        : "";
      return `Attach a file${parent}`;
    }
    case "attach_url": {
      const parent = Number(op.parentItemId)
        ? ` to ${labels.item(Number(op.parentItemId))}`
        : "";
      return `Save a web page${parent}`;
    }
    case "find_pdf":
      return Number(op.itemId)
        ? `Search for a PDF for ${labels.item(Number(op.itemId))}`
        : "Search for a PDF";
    case "update_annotation":
      return "Edit an annotation";
    default:
      return presentTense(operationLabel(String(operation.type)));
  }
}

/** The first change in words, then how many more the action holds. */
export function withMoreChanges(first: string, total: number): string {
  return total > 1
    ? `${first} and ${total - 1} more change${total === 2 ? "" : "s"}`
    : first;
}

/** Several operations as one line: the first, and a count of the rest. */
export function describeLibraryMutations(
  operations: ReadonlyArray<LibraryMutationOperation | { type: string }>,
  labels: MutationLabels,
): string {
  return operations.length
    ? withMoreChanges(
        describeLibraryMutation(operations[0], labels),
        operations.length,
      )
    : "Change the library";
}

/**
 * Whether a stored action description is one of the earlier, token-like
 * forms: "Apply apply_tags", "library_update: 3 planned changes",
 * "library_update: 12 item changes".
 */
export function isLegacyActionDescription(description: string): boolean {
  return (
    /^Apply [a-z_]+$/u.test(description) ||
    /^[a-z_]+: \d+ (?:planned|item) changes$/u.test(description)
  );
}

/** Rebuilds a legacy description from the journal steps' forward payloads. */
export function describeJournalSteps(
  steps: ReadonlyArray<{ operation: string; forwardJson?: string }>,
  labels: MutationLabels,
): string | null {
  if (!steps.length) return null;
  const operations = steps.map((step) => {
    try {
      const parsed = JSON.parse(step.forwardJson || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        return { ...parsed, type: parsed.type || step.operation };
    } catch {
      // A payload that no longer parses still names its operation.
    }
    return { type: step.operation };
  });
  return describeLibraryMutations(operations, labels);
}

/** The reader's name for a paper, from the fields Zotero keeps on it. */
export function paperLabelFromFields(fields: {
  title?: string;
  firstCreator?: string;
  date?: string;
}): string {
  return formatPaperDisplayLabel({
    title: fields.title?.trim(),
    firstCreator: fields.firstCreator?.trim(),
    year: fields.date?.match(/\b\d{4}\b/u)?.[0],
  });
}

type LabelGateway = {
  getItem(itemId: number | undefined): Zotero.Item | null;
  getCollectionSummary(
    collectionId: number | undefined,
  ): { name?: string; path?: string } | null;
};

/** Labels read from the live library. A missing item reads as "item N". */
export function gatewayMutationLabels(gateway: LabelGateway): MutationLabels {
  return {
    item(itemId) {
      try {
        const item = gateway.getItem(itemId);
        if (!item) return `item ${itemId}`;
        const field = (name: string) =>
          String(item.getField?.(name as never) || "").trim();
        if (item.isRegularItem?.()) {
          return paperLabelFromFields({
            title: field("title") || item.getDisplayTitle?.() || "",
            firstCreator: field("firstCreator"),
            date: field("date"),
          });
        }
        return quote(
          field("title") || item.getDisplayTitle?.() || `item ${itemId}`,
        );
      } catch {
        return `item ${itemId}`;
      }
    },
    collection(collectionId) {
      try {
        const summary = gateway.getCollectionSummary(collectionId);
        return summary?.name || summary?.path || undefined;
      } catch {
        return undefined;
      }
    },
  };
}
