import type {
  AgentActionCapability,
  AgentActionIntent,
  AgentActionOperation,
  AgentActionParameters,
  AgentActionProofDomain,
  AgentRuntimeRequest,
} from "../types";
import {
  capabilityForLibraryMutation,
  isLibraryMutationOperationType,
} from "../services/libraryMutation/handlerOperations";
import type { WriteNoteDestination } from "../writeNoteDestination";

const EXTERNAL_OPERATION_DETAILS: Partial<
  Record<
    AgentActionOperation,
    { capability: AgentActionCapability; proofDomain: AgentActionProofDomain }
  >
> = {
  note_create: { capability: "zotero.notes", proofDomain: "zotero_state" },
  note_edit: { capability: "zotero.notes", proofDomain: "zotero_state" },
  note_append: { capability: "zotero.notes", proofDomain: "zotero_state" },
  annotation_write: {
    capability: "zotero.annotations",
    proofDomain: "zotero_state",
  },
  settings_update: {
    capability: "zotero.settings",
    proofDomain: "zotero_state",
  },
  undo: { capability: "zotero.undo", proofDomain: "zotero_state" },
  revert: { capability: "zotero.undo", proofDomain: "zotero_state" },
  file_write: { capability: "file.write", proofDomain: "file_state" },
  command_execute: {
    capability: "command.execute",
    proofDomain: "execution",
  },
  zotero_script_execute: {
    capability: "zotero.script",
    proofDomain: "execution",
  },
  read_full: { capability: "zotero.read", proofDomain: "zotero_state" },
};

function operationDetails(operation: string): {
  operation: AgentActionOperation;
  capability: AgentActionCapability;
  proofDomain: AgentActionProofDomain;
} | null {
  if (isLibraryMutationOperationType(operation)) {
    return {
      operation,
      capability: capabilityForLibraryMutation(operation),
      proofDomain: "zotero_state",
    };
  }
  const external =
    EXTERNAL_OPERATION_DETAILS[operation as AgentActionOperation];
  return external
    ? { operation: operation as AgentActionOperation, ...external }
    : null;
}

function parseParameters(value: unknown): AgentActionParameters | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const tags = Array.isArray(record.tags)
    ? record.tags
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.trim())
        .filter(Boolean)
    : undefined;
  const stringArray = (key: string): string[] | undefined => {
    if (!Array.isArray(record[key])) return undefined;
    const values = (record[key] as unknown[])
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean);
    return values.length ? values : undefined;
  };
  const numberArray = (key: string): number[] | undefined => {
    if (!Array.isArray(record[key])) return undefined;
    const values = (record[key] as unknown[])
      .map(Number)
      .filter((value) => Number.isInteger(value) && value > 0);
    return values.length ? values : undefined;
  };
  const stringValue = (key: string): string | undefined =>
    typeof record[key] === "string" && String(record[key]).trim()
      ? String(record[key]).trim()
      : undefined;
  const positiveNumber = (key: string): number | undefined => {
    const number = Number(record[key]);
    return Number.isInteger(number) && number > 0 ? number : undefined;
  };
  const parameters: AgentActionParameters = {
    ...(tags?.length ? { tags } : {}),
    ...(stringArray("metadataFields")
      ? { metadataFields: stringArray("metadataFields") }
      : {}),
    ...(stringValue("tag") ? { tag: stringValue("tag") } : {}),
    ...(stringValue("newTag") ? { newTag: stringValue("newTag") } : {}),
    ...(stringValue("collectionName")
      ? { collectionName: stringValue("collectionName") }
      : {}),
    ...(stringValue("filePath") ? { filePath: stringValue("filePath") } : {}),
    ...(stringValue("newName") ? { newName: stringValue("newName") } : {}),
    ...(stringValue("newPath") ? { newPath: stringValue("newPath") } : {}),
    ...(stringValue("savedSearchName")
      ? { savedSearchName: stringValue("savedSearchName") }
      : {}),
    ...(stringArray("identifiers")
      ? { identifiers: stringArray("identifiers") }
      : {}),
    ...(stringArray("filePaths")
      ? { filePaths: stringArray("filePaths") }
      : {}),
    ...(stringValue("contentHash")
      ? { contentHash: stringValue("contentHash") }
      : {}),
    ...(stringValue("settingsKey")
      ? { settingsKey: stringValue("settingsKey") }
      : {}),
    ...(stringValue("settingsValue")
      ? { settingsValue: stringValue("settingsValue") }
      : {}),
    ...(positiveNumber("destinationCollectionId")
      ? { destinationCollectionId: positiveNumber("destinationCollectionId") }
      : {}),
    ...(positiveNumber("collectionId")
      ? { collectionId: positiveNumber("collectionId") }
      : {}),
    ...(positiveNumber("savedSearchId")
      ? { savedSearchId: positiveNumber("savedSearchId") }
      : {}),
    ...(numberArray("collectionIds")
      ? { collectionIds: numberArray("collectionIds") }
      : {}),
    ...(positiveNumber("targetItemId")
      ? { targetItemId: positiveNumber("targetItemId") }
      : {}),
    ...(positiveNumber("targetNoteId")
      ? { targetNoteId: positiveNumber("targetNoteId") }
      : {}),
    ...(record.pageIndex === 0 || positiveNumber("pageIndex")
      ? { pageIndex: Math.max(0, Math.floor(Number(record.pageIndex))) }
      : {}),
    ...(positiveNumber("revertCount")
      ? { revertCount: positiveNumber("revertCount") }
      : {}),
    ...(record.parentCollectionId === null
      ? { parentCollectionId: null }
      : positiveNumber("parentCollectionId")
        ? { parentCollectionId: positiveNumber("parentCollectionId") }
        : {}),
    ...(record.sourceCollectionId === "all"
      ? { sourceCollectionId: "all" as const }
      : positiveNumber("sourceCollectionId")
        ? { sourceCollectionId: positiveNumber("sourceCollectionId") }
        : {}),
    ...(record.noteMode === "create" ||
    record.noteMode === "edit" ||
    record.noteMode === "append"
      ? { noteMode: record.noteMode }
      : {}),
    ...(record.semanticAction === "add" ||
    record.semanticAction === "remove" ||
    record.semanticAction === "rename" ||
    record.semanticAction === "merge" ||
    record.semanticAction === "delete" ||
    record.semanticAction === "setColor"
      ? { semanticAction: record.semanticAction }
      : {}),
    ...(typeof record.deleteItems === "boolean"
      ? { deleteItems: record.deleteItems }
      : {}),
    ...(typeof record.permanent === "boolean"
      ? { permanent: record.permanent }
      : {}),
  };
  return Object.keys(parameters).length ? parameters : undefined;
}

function parseActionIntent(value: unknown): AgentActionIntent | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const details =
    typeof record.operation === "string"
      ? operationDetails(record.operation)
      : null;
  if (!details) return null;
  if (
    record.coverage !== "one" &&
    record.coverage !== "some" &&
    record.coverage !== "all"
  ) {
    return null;
  }
  const rawScope = record.scope;
  const scope =
    rawScope &&
    typeof rawScope === "object" &&
    (rawScope as { kind?: unknown }).kind === "collection"
      ? {
          kind: "collection" as const,
          path:
            typeof (rawScope as { path?: unknown }).path === "string" &&
            (rawScope as { path: string }).path.trim()
              ? (rawScope as { path: string }).path.trim()
              : undefined,
          includeDescendants:
            (rawScope as { includeDescendants?: unknown })
              .includeDescendants === true,
        }
      : undefined;
  const constraintsValue = record.constraints;
  const constraintsRecord =
    constraintsValue && typeof constraintsValue === "object"
      ? (constraintsValue as Record<string, unknown>)
      : {};
  const tagPrefix =
    typeof constraintsRecord.tagPrefix === "string"
      ? constraintsRecord.tagPrefix.trim()
      : "";
  const readMode = constraintsRecord.readMode === "full" ? "full" : undefined;
  const collectionMode =
    constraintsRecord.collectionMode === "move" ? "move" : undefined;
  return {
    ...details,
    coverage: record.coverage,
    targetKind: record.targetKind === "items" ? "items" : "papers",
    scopeRole: record.scopeRole === "destination" ? "destination" : "source",
    parameters: parseParameters(record.parameters),
    ...(scope ? { scope } : {}),
    ...(tagPrefix || readMode || collectionMode
      ? {
          constraints: {
            ...(tagPrefix ? { tagPrefix } : {}),
            ...(readMode ? { readMode } : {}),
            ...(collectionMode ? { collectionMode } : {}),
          },
        }
      : {}),
  };
}

export function parseActionIntents(value: unknown): AgentActionIntent[] {
  return Array.isArray(value)
    ? value
        .map(parseActionIntent)
        .filter((intent): intent is AgentActionIntent => Boolean(intent))
    : [];
}

function actionIntentKey(intent: AgentActionIntent): string {
  return [
    intent.operation,
    intent.coverage,
    intent.targetKind,
    intent.scope?.path || "",
    intent.scope?.includeDescendants ? "descendants" : "direct",
    intent.scopeRole || "source",
    JSON.stringify(intent.parameters || {}),
  ].join("|");
}

export function mergeActionIntents(
  primary: AgentActionIntent[],
  secondary: AgentActionIntent[],
): AgentActionIntent[] {
  const merged = new Map<string, AgentActionIntent>();
  for (const intent of [...primary, ...secondary]) {
    const key = actionIntentKey(intent);
    if (!merged.has(key)) merged.set(key, intent);
  }
  return [...merged.values()];
}

export function reconcileNoteDestinationActionIntents(
  intents: AgentActionIntent[],
  destination: WriteNoteDestination,
): AgentActionIntent[] {
  if (destination === "none") return intents;
  const wantsFile = destination === "file" || destination === "both";
  const wantsZotero = destination === "zotero" || destination === "both";
  const isZoteroNote = (intent: AgentActionIntent) =>
    intent.operation === "note_create" ||
    intent.operation === "note_edit" ||
    intent.operation === "note_append";
  const retained = intents.filter(
    (intent) =>
      (intent.operation !== "file_write" || wantsFile) &&
      (!isZoteroNote(intent) || wantsZotero),
  );
  const additions: AgentActionIntent[] = [];
  if (
    wantsFile &&
    !retained.some((intent) => intent.operation === "file_write")
  ) {
    additions.push({
      operation: "file_write",
      proofDomain: "file_state",
      capability: "file.write",
      coverage: "one",
      targetKind: "items",
    });
  }
  if (wantsZotero && !retained.some(isZoteroNote)) {
    additions.push({
      operation: "note_create",
      proofDomain: "zotero_state",
      capability: "zotero.notes",
      coverage: "one",
      targetKind: "items",
      parameters: { noteMode: "create" },
    });
  }
  return mergeActionIntents(retained, additions);
}

function requestedCoverage(text: string): AgentActionIntent["coverage"] {
  if (/\b(?:all|every|each)\b/i.test(text)) return "all";
  if (/\b(?:this|current|one|single)\b/i.test(text)) return "one";
  return "some";
}

function requestedCollectionScope(
  request: Pick<AgentRuntimeRequest, "userText" | "turnPaperScope">,
): AgentActionIntent["scope"] | undefined {
  const text = request.userText || "";
  const named = text.match(
    /\b(?:collection|folder)\s+(?:named\s+)?["“']([^"”']+)["”']/i,
  )?.[1];
  if (!named && !request.turnPaperScope.collections.length) return undefined;
  return {
    kind: "collection",
    ...(named && !request.turnPaperScope.collections.length
      ? { path: named.trim() }
      : {}),
    includeDescendants:
      /\b(?:subcollections?|descendants?|including children)\b/i.test(text),
  };
}

function quotedValueAfter(text: string, noun: string): string | undefined {
  return text
    .match(
      new RegExp(`\\b${noun}\\s+(?:named\\s+)?["“']([^"”']+)["”']`, "i"),
    )?.[1]
    ?.trim();
}

function requestedFilePath(text: string): string | undefined {
  const quoted = text.match(/["“'](\/[^"”'\r\n]+\.[A-Za-z0-9]+)["”']/)?.[1];
  if (quoted) return quoted.trim();
  return text
    .match(/(?:^|\s)(\/[^\s"'<>|]+\.[A-Za-z0-9]+)(?=\s|$)/)?.[1]
    ?.trim();
}

function mutationRequestIsExplicit(text: string): boolean {
  if (
    /\b(?:do not|don't|dont|never|without (?:changing|modifying|writing)|only a question|hypothetical|for advice)\b/i.test(
      text,
    )
  ) {
    return false;
  }
  if (/^\s*(?:what|which|why|how|should|would|could|if)\b/i.test(text)) {
    return false;
  }
  return /^\s*(?:please\s+)?(?:add|apply|assign|remove|replace|set|tag|update|edit|change|correct|create|write|save|append|import|trash|restore|delete|rename|relink|move|file|merge|relate|unrelate|annotate|undo|revert|run|execute|export)\b/i.test(
    text,
  );
}

/** High-confidence fallback used only when the classifier call fails. */
export function inferActionIntentsFromRequest(
  request: Pick<AgentRuntimeRequest, "userText" | "turnPaperScope">,
): AgentActionIntent[] {
  const text = (request.userText || "").trim();
  if (!text) return [];
  const coverage = requestedCoverage(text);
  const scope = requestedCollectionScope(request);
  const intents: AgentActionIntent[] = [];
  const add = (
    operation: AgentActionOperation,
    parameters?: AgentActionParameters,
    options: Partial<
      Pick<
        AgentActionIntent,
        "targetKind" | "scopeRole" | "scope" | "constraints"
      >
    > = {},
  ) => {
    const details = operationDetails(operation);
    if (!details) return;
    intents.push({
      ...details,
      coverage,
      targetKind: options.targetKind || "papers",
      scopeRole: options.scopeRole || "source",
      scope: Object.prototype.hasOwnProperty.call(options, "scope")
        ? options.scope
        : scope,
      parameters,
      constraints: options.constraints,
    });
  };

  if (mutationRequestIsExplicit(text)) {
    const tagSegment = text.split(
      /\b(?:to|in|for)\s+(?:the\s+)?(?:collection|folder)\b/i,
    )[0];
    const tags = [...tagSegment.matchAll(/["“']([^"”']+)["”']/g)]
      .map((match) => match[1].trim())
      .filter(Boolean);
    if (
      /\b(?:add|apply|assign|tag)\b[\s\S]{0,60}\btags?\b|^\s*(?:please\s+)?tag\b/i.test(
        text,
      )
    ) {
      add("apply_tags", tags.length ? { tags } : undefined);
    } else if (/\bremove\b[\s\S]{0,60}\btags?\b/i.test(text)) {
      add("remove_tags", tags.length ? { tags } : undefined);
    } else if (/\b(?:replace|set)\b[\s\S]{0,60}\btags?\b/i.test(text)) {
      add("set_item_tags", tags.length ? { tags } : undefined);
    }

    if (
      /^\s*(?:please\s+)?create\b[\s\S]{0,50}\b(?:collection|folder)\b/i.test(
        text,
      )
    ) {
      add(
        "create_collection",
        {
          collectionName: quotedValueAfter(text, "(?:collection|folder)"),
        },
        { targetKind: "items", scope: undefined },
      );
    } else if (
      /^\s*(?:please\s+)?delete\b[\s\S]{0,50}\b(?:collection|folder)\b/i.test(
        text,
      )
    ) {
      add("delete_collection", undefined, {
        targetKind: "items",
      });
    } else if (
      /^\s*(?:please\s+)?(?:rename|move)\b[\s\S]{0,50}\b(?:collection|folder)\b/i.test(
        text,
      )
    ) {
      add("update_collection", undefined, {
        targetKind: "items",
      });
    } else if (
      /\b(?:move|file|add)\b[\s\S]{0,60}\b(?:papers?|items?)\b[\s\S]{0,60}\b(?:collection|folder)\b/i.test(
        text,
      )
    ) {
      add("move_to_collection", undefined, {
        targetKind: "items",
        constraints: /\bmove\b/i.test(text)
          ? { collectionMode: "move" }
          : undefined,
      });
    } else if (
      /\bremove\b[\s\S]{0,60}\b(?:papers?|items?)\b[\s\S]{0,60}\b(?:collection|folder)\b/i.test(
        text,
      )
    ) {
      add("remove_from_collection", undefined, { targetKind: "items" });
    }

    if (
      /\b(?:update|edit|change|correct|set|replace|enrich)\b[\s\S]{0,100}\b(?:metadata|fields?|extra|title|abstract|doi|date|year|authors?|creators?|publication)\b/i.test(
        text,
      )
    ) {
      add("update_metadata");
    }
    if (/\b(?:create|write|save)\b[\s\S]{0,50}\bnotes?\b/i.test(text)) {
      add("note_create", { noteMode: "create" }, { targetKind: "items" });
    } else if (/\bappend\b[\s\S]{0,50}\bnotes?\b/i.test(text)) {
      add("note_append", { noteMode: "append" }, { targetKind: "items" });
    } else if (
      /\b(?:edit|update|replace)\b[\s\S]{0,50}\bnotes?\b/i.test(text)
    ) {
      add("note_edit", { noteMode: "edit" }, { targetKind: "items" });
    }
    if (/\bimport\b[\s\S]{0,50}\b(?:files?|pdfs?)\b/i.test(text)) {
      add("import_local_files", undefined, {
        targetKind: "items",
        scopeRole: "destination",
      });
    } else if (
      /\bimport\b[\s\S]{0,50}\b(?:doi|isbn|pmid|arxiv|identifiers?)\b/i.test(
        text,
      )
    ) {
      add("import_identifiers", undefined, {
        targetKind: "items",
        scopeRole: "destination",
      });
    }
    if (/\btrash\b[\s\S]{0,40}\b(?:papers?|items?|entries)\b/i.test(text)) {
      add("trash_items", undefined, { targetKind: "items" });
    } else if (
      /\b(?:restore|undelete)\b[\s\S]{0,40}\b(?:papers?|items?|entries)\b/i.test(
        text,
      )
    ) {
      add("restore_from_trash", undefined, { targetKind: "items" });
    } else if (
      /\bmerge\b[\s\S]{0,40}\b(?:papers?|items?|entries|duplicates?)\b/i.test(
        text,
      )
    ) {
      add("merge_items", undefined, { targetKind: "items" });
    }
    if (/\bdelete\b[\s\S]{0,40}\battachments?\b/i.test(text)) {
      add("delete_attachment", undefined, { targetKind: "items" });
    } else if (/\brename\b[\s\S]{0,40}\battachments?\b/i.test(text)) {
      add("rename_attachment", undefined, { targetKind: "items" });
    } else if (/\brelink\b[\s\S]{0,40}\battachments?\b/i.test(text)) {
      add("relink_attachment", undefined, { targetKind: "items" });
    }
    if (/\bannotate\b[\s\S]{0,50}\b(?:pdf|paper|document)\b/i.test(text)) {
      add("annotation_write", undefined, { targetKind: "items" });
    }
    if (/^\s*(?:please\s+)?undo\b/i.test(text))
      add("undo", undefined, { targetKind: "items", scope: undefined });
    if (/^\s*(?:please\s+)?revert\b/i.test(text))
      add("revert", undefined, { targetKind: "items", scope: undefined });
    if (
      /\b(?:write|save|export)\b[\s\S]{0,80}\b(?:file|markdown|csv|json|vault)\b/i.test(
        text,
      )
    ) {
      const filePath = requestedFilePath(text);
      add("file_write", filePath ? { filePath } : undefined, {
        targetKind: "items",
        scope: undefined,
      });
    }
    if (
      /^\s*(?:please\s+)?(?:run|execute)\b[\s\S]{0,40}\b(?:command|shell)\b/i.test(
        text,
      )
    ) {
      add("command_execute", undefined, {
        targetKind: "items",
        scope: undefined,
      });
    } else if (
      /^\s*(?:please\s+)?(?:run|execute)\b[\s\S]{0,40}\bzotero\b[\s\S]{0,20}\bscript\b/i.test(
        text,
      )
    ) {
      add("zotero_script_execute", undefined, {
        targetKind: "items",
        scope: undefined,
      });
    }
  }

  if (
    /^\s*(?:please\s+)?(?:read|review|analy[sz]e|inspect)\b[\s\S]{0,50}\b(?:full|entire|complete|exhaustive)\b[\s\S]{0,30}\b(?:paper|text|pdf|document)\b/i.test(
      text,
    )
  ) {
    add("read_full", undefined, { constraints: { readMode: "full" } });
  }
  return mergeActionIntents([], intents);
}
