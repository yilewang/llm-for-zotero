import type {
  AgentAction,
  ActionExecutionContext,
  ActionResult,
} from "./types";
import type {
  EditableArticleMetadataPatch,
  EditableArticleMetadataField,
  LibraryItemTarget,
} from "../services/zoteroGateway";
import { EDITABLE_ARTICLE_METADATA_FIELDS } from "../services/zoteroGateway";
import { callTool } from "./executor";
import {
  formatActionPageLabel,
  getPagedActionOptionsForStartOffset,
  getPagedActionOptions,
  getPagedActionPageCursorForOffset,
  getPagedActionPages,
  getPagedOperationId,
  isUserCancelledToolResult,
  normalizeActionPageSize,
  readToolConfirmationActionId,
  readToolConfirmationData,
  readToolResultError,
  type PagedActionInput,
} from "./pagedWorkflow";
import {
  getMetadataField,
  getMetadataTitle,
  hasMetadataCreators,
} from "./metadataSnapshot";

type AuditScope = "all" | "collection";

type AuditLibraryInput = PagedActionInput & {
  scope?: AuditScope;
  collectionId?: number;
  userQuery?: string;
  /** If true, saves an audit report note to the library. */
  saveNote?: boolean;
  /** Internal durable-batch target set. Never accepted from model input. */
  _batchItemIds?: number[];
};

export type AuditIssue = {
  itemId: number;
  title: string;
  missingFields: string[];
};

type AuditRecord = {
  itemId: number;
  itemType?: string;
  title: string;
  firstCreator?: string;
  year?: string;
  metadata: unknown;
  tags: string[];
  attachments: Array<{ contentType?: string }>;
};

type AuditLibraryOutput = {
  total: number;
  itemsWithIssues: number;
  issues: AuditIssue[];
  metadataFixed: number;
  fixable?: number;
  skipped?: number;
  remaining?: number;
  stopped?: boolean;
  noteId?: number;
};

type UpdateCandidate = {
  itemId: number;
  patch: EditableArticleMetadataPatch;
};

/**
 * Whole-library audit + metadata repair. The audit scans fresh bibliographic
 * parent items, then pages through metadata repair review cards. External
 * canonical metadata is resolved DOI-first through literature_search metadata.
 */
export const auditLibraryAction: AgentAction<
  AuditLibraryInput,
  AuditLibraryOutput
> = {
  name: "audit_library",
  modes: ["library"],
  description:
    "Scan the active library for bibliographic metadata issues, then fetch canonical metadata and page through review cards for supported fixes.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      scope: {
        type: "string",
        enum: ["all", "collection"],
        description: "Which items to audit. Default: 'all'.",
      },
      collectionId: {
        type: "number",
        description: "Required when scope is 'collection'.",
      },
      limit: {
        type: "number",
        description: "Optional total cap across all pages. Default: no limit.",
      },
      pageSize: {
        type: "number",
        description:
          "Items to show per review page. Default: 20; maximum: 100.",
      },
      startOffset: {
        type: "number",
        description:
          "Internal resume offset for paged workflows. Defaults to 0.",
      },
      saveNote: {
        type: "boolean",
        description:
          "If true, saves the audit report as a Zotero note. Default: false.",
      },
    },
  },

  async execute(
    input: AuditLibraryInput,
    ctx: ActionExecutionContext,
  ): Promise<ActionResult<AuditLibraryOutput>> {
    let options = getPagedActionOptions(input);
    const initialStartOffset = options.startOffset;
    const windowEndOffset =
      options.limit !== undefined
        ? options.startOffset + options.limit
        : undefined;
    const totalSteps = 3 + (input.saveNote ? 1 : 0);

    ctx.onProgress({
      type: "step_start",
      step: "Scanning library items",
      index: 1,
      total: totalSteps,
    });

    let auditableRecords: AuditRecord[] = [];
    let issues: AuditIssue[] = [];
    let issuePages = getPagedActionPages<AuditIssue>([], options);
    let recordByItemId = new Map<number, AuditRecord>();
    const reloadAuditPages = async (): Promise<void> => {
      ctx.zoteroGateway.invalidateLibrarySearchCache?.(ctx.libraryID);
      auditableRecords = await loadFreshAuditRecords(input, ctx);
      issues = auditableRecords
        .map((record) => analyzeAuditRecord(record))
        .filter((issue): issue is AuditIssue => Boolean(issue));
      issuePages = getPagedActionPages(issues, options);
      recordByItemId = new Map(
        auditableRecords.map((record) => [record.itemId, record] as const),
      );
    };
    const issueWindowCount = (): number => {
      const end =
        windowEndOffset !== undefined
          ? Math.min(windowEndOffset, issues.length)
          : issues.length;
      return Math.max(0, end - Math.min(initialStartOffset, end));
    };
    const remainingIssueIds = (nextOffset: number): number[] => {
      const end =
        windowEndOffset !== undefined
          ? Math.min(windowEndOffset, issues.length)
          : issues.length;
      return issues
        .slice(Math.max(initialStartOffset, nextOffset), end)
        .map((issue) => issue.itemId);
    };
    try {
      await reloadAuditPages();
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to scan library items",
      };
    }

    await ctx.checkpoint?.({
      cursor: 0,
      appliedCount: 0,
      totalCount: issueWindowCount(),
      plan: {
        remainingItemIds: remainingIssueIds(initialStartOffset),
        pageSize: options.pageSize,
      },
    });

    ctx.onProgress({
      type: "step_done",
      step: "Scanning library items",
      summary: `Found ${auditableRecords.length} bibliographic item${auditableRecords.length === 1 ? "" : "s"}`,
    });

    ctx.onProgress({
      type: "step_start",
      step: "Analyzing metadata",
      index: 2,
      total: totalSteps,
    });

    ctx.onProgress({
      type: "step_done",
      step: "Analyzing metadata",
      summary: `${issues.length} item${issues.length === 1 ? "" : "s"} with issues`,
    });

    let metadataFixed = 0;
    let fixable = 0;
    let skipped = 0;
    let stopped = false;
    let confirmed = false;

    ctx.onProgress({
      type: "step_start",
      step: "Reviewing metadata fixes",
      index: 3,
      total: totalSteps,
    });

    if (!issuePages.length) {
      ctx.onProgress({
        type: "step_done",
        step: "Reviewing metadata fixes",
        summary: "No metadata issues found",
      });
    }

    let pageCursor = 0;
    while (pageCursor < issuePages.length) {
      const page = issuePages[pageCursor];
      const pageLabel = formatActionPageLabel(page);
      const updateCandidates: UpdateCandidate[] = [];
      let pageUnfixable = 0;

      for (const issue of page.items) {
        const record = recordByItemId.get(issue.itemId);
        if (!record) continue;
        const patch = await fetchCanonicalPatchForRecord(record, ctx);
        if (!patch || Object.keys(patch).length === 0) {
          pageUnfixable += 1;
          continue;
        }
        updateCandidates.push({ itemId: issue.itemId, patch });
      }

      if (!updateCandidates.length) {
        skipped += page.items.length;
        await ctx.checkpoint?.({
          cursor: page.offset + page.items.length,
          appliedCount: metadataFixed,
          totalCount: issueWindowCount(),
          plan: {
            remainingItemIds: remainingIssueIds(
              page.offset + page.items.length,
            ),
            pageSize: options.pageSize,
          },
        });
        pageCursor += 1;
        continue;
      }

      const operations = updateCandidates.map(({ itemId, patch }) => ({
        id: `${getPagedOperationId("audit_library", page, {
          pageSize: options.pageSize,
        })}:item:${itemId}`,
        type: "update_metadata" as const,
        itemId,
        metadata: patch,
      }));

      const mutateResult = await callTool(
        "update_metadata",
        { operations },
        ctx,
        `${pageLabel}: Updating metadata`,
      );

      const confirmationActionId = readToolConfirmationActionId(mutateResult);
      const confirmationData = readToolConfirmationData(mutateResult);
      const requestedPageSize =
        confirmationData.pageSize !== undefined
          ? normalizeActionPageSize(confirmationData.pageSize)
          : options.pageSize;
      const refreshPages = async (
        targetOffset: number,
        refreshOptions?: { reloadTargets?: boolean },
      ): Promise<void> => {
        const pageSizeChanged = requestedPageSize !== options.pageSize;
        options = pageSizeChanged
          ? getPagedActionOptionsForStartOffset(
              { ...options, pageSize: requestedPageSize },
              targetOffset,
              windowEndOffset,
            )
          : { ...options, pageSize: requestedPageSize };
        if (refreshOptions?.reloadTargets) {
          await reloadAuditPages();
        } else {
          issuePages = getPagedActionPages(issues, options);
        }
        pageCursor = getPagedActionPageCursorForOffset(
          issuePages,
          targetOffset,
        );
      };
      if (confirmationActionId === "previous") {
        await refreshPages(
          Math.max(options.startOffset, page.offset - requestedPageSize),
        );
        continue;
      }
      if (confirmationActionId === "refresh") {
        await refreshPages(page.offset, { reloadTargets: true });
        continue;
      }
      if (confirmationActionId === "next") {
        await refreshPages(page.offset + page.items.length);
        continue;
      }
      if (confirmationActionId === "cancel") {
        stopped = true;
        ctx.onProgress({
          type: "step_done",
          step: `${pageLabel}: Reviewing metadata fixes`,
          summary: "Stopped by user",
        });
        break;
      }

      const mutateContent = mutateResult.content as Record<string, unknown>;
      const pageFixed = mutateResult.ok
        ? Number(
            mutateContent.appliedCount ||
              (Array.isArray(mutateContent.results)
                ? mutateContent.results.length
                : updateCandidates.length),
          )
        : 0;
      const mutateError = readToolResultError(mutateResult);

      if (mutateResult.ok) {
        fixable += updateCandidates.length;
        metadataFixed += pageFixed;
        skipped +=
          pageUnfixable + Math.max(0, updateCandidates.length - pageFixed);
        ctx.onProgress({
          type: "step_done",
          step: `${pageLabel}: Reviewing metadata fixes`,
          summary: `Fixed metadata for ${pageFixed} item${pageFixed === 1 ? "" : "s"}`,
        });
        await ctx.checkpoint?.({
          cursor: page.offset + page.items.length,
          appliedCount: metadataFixed,
          totalCount: issueWindowCount(),
          plan: {
            remainingItemIds: remainingIssueIds(
              page.offset + page.items.length,
            ),
            pageSize: options.pageSize,
          },
        });
        if (confirmationActionId === "confirm") {
          if (pageCursor >= issuePages.length - 1) {
            confirmed = true;
            break;
          }
          await refreshPages(page.offset + page.items.length);
          continue;
        }
        if (requestedPageSize !== options.pageSize) {
          await refreshPages(page.offset + page.items.length);
        } else {
          pageCursor += 1;
        }
        continue;
      }

      stopped = isUserCancelledToolResult(mutateResult);
      ctx.onProgress({
        type: "step_done",
        step: `${pageLabel}: Reviewing metadata fixes`,
        summary: stopped
          ? "Stopped by user"
          : `Metadata update failed: ${mutateError || "unknown error"}`,
      });

      if (!stopped) {
        return {
          ok: false,
          error: `Metadata update failed: ${mutateError || "unknown error"}`,
        };
      }
      break;
    }

    if (issuePages.length) {
      ctx.onProgress({
        type: "step_done",
        step: "Reviewing metadata fixes",
        summary: stopped
          ? `Stopped after fixing ${metadataFixed} item${metadataFixed === 1 ? "" : "s"}`
          : confirmed
            ? `Confirmed ${metadataFixed} metadata fix${metadataFixed === 1 ? "" : "es"}`
            : `Fixed ${metadataFixed} item${metadataFixed === 1 ? "" : "s"}; ${Math.max(0, issues.length - metadataFixed)} remaining`,
      });
    }

    let noteId: number | undefined;
    if (input.saveNote) {
      ctx.onProgress({
        type: "step_start",
        step: "Saving audit note",
        index: 4,
        total: totalSteps,
      });
      const reportLines = [
        "## Library Audit Report",
        "",
        `Total bibliographic items scanned: ${auditableRecords.length}`,
        `Items with issues: ${issues.length}`,
        `Metadata fixable: ${fixable}`,
        `Metadata fixed: ${metadataFixed}`,
        `Skipped or unsupported: ${skipped}`,
        "",
        "### Issues",
        ...issues.map(
          (issue) =>
            `- **${issue.title}** (ID: ${issue.itemId}): missing ${issue.missingFields.join(", ")}`,
        ),
      ];

      const saveResult = await callTool(
        "edit_current_note",
        {
          mode: "create",
          content: reportLines.join("\n"),
          target: "standalone",
        },
        ctx,
        "Saving audit report",
      );

      if (saveResult.ok) {
        const saveContent = saveResult.content as Record<string, unknown>;
        const resultObj = saveContent.result as
          | Record<string, unknown>
          | undefined;
        noteId =
          typeof resultObj?.noteId === "number" ? resultObj.noteId : undefined;
      }
      ctx.onProgress({ type: "step_done", step: "Saving audit note" });
    }

    return {
      ok: true,
      output: {
        total: auditableRecords.length,
        itemsWithIssues: issues.length,
        issues,
        metadataFixed,
        fixable,
        skipped,
        remaining: Math.max(0, issues.length - metadataFixed),
        stopped: stopped || undefined,
        noteId,
      },
    };
  },
};

async function loadFreshAuditRecords(
  input: AuditLibraryInput,
  ctx: ActionExecutionContext,
): Promise<AuditRecord[]> {
  if (Array.isArray(input._batchItemIds)) {
    return ctx.zoteroGateway
      .getBibliographicItemTargetsByItemIds(input._batchItemIds)
      .filter((target) => !isNonBibliographicTarget(target))
      .map((target) => auditRecordFromTarget(target, ctx));
  }
  if (typeof ctx.zoteroGateway.listBibliographicItemTargets === "function") {
    const result =
      input.scope === "collection" &&
      input.collectionId &&
      typeof ctx.zoteroGateway.listCollectionItemTargets === "function"
        ? await ctx.zoteroGateway.listCollectionItemTargets({
            libraryID: ctx.libraryID,
            collectionId: input.collectionId,
          })
        : await ctx.zoteroGateway.listBibliographicItemTargets({
            libraryID: ctx.libraryID,
          });
    return result.items
      .filter((target) => !isNonBibliographicTarget(target))
      .map((target) => auditRecordFromTarget(target, ctx));
  }

  const queryArgs: Record<string, unknown> = {
    entity: "items",
    mode: "list",
    include: ["metadata", "tags", "attachments"],
  };
  if (input.scope === "collection" && input.collectionId) {
    queryArgs.filters = { collectionId: input.collectionId };
  }

  const queryResult = await callTool(
    "query_library",
    queryArgs,
    ctx,
    "Scanning library items",
  );
  if (!queryResult.ok) {
    throw new Error(
      `Failed to query library: ${JSON.stringify(queryResult.content)}`,
    );
  }

  const content = queryResult.content as Record<string, unknown>;
  const items = Array.isArray(content.results) ? content.results : [];
  return items.filter(isAuditableBibliographicRecord).map(recordFromQueryItem);
}

function auditRecordFromTarget(
  target: LibraryItemTarget,
  ctx: ActionExecutionContext,
): AuditRecord {
  const item = ctx.zoteroGateway.getItem?.(target.itemId);
  const snapshot = ctx.zoteroGateway.getEditableArticleMetadata?.(item);
  return {
    itemId: target.itemId,
    itemType: target.itemType,
    title: target.title || snapshot?.title || `Item ${target.itemId}`,
    firstCreator: target.firstCreator,
    year: target.year,
    metadata: snapshot
      ? { fields: snapshot.fields, creators: snapshot.creators }
      : { fields: { title: target.title }, creators: [] },
    tags: Array.isArray(target.tags) ? target.tags : [],
    attachments: target.attachments || [],
  };
}

function recordFromQueryItem(entry: unknown): AuditRecord {
  const record = entry as Record<string, unknown>;
  const itemId = Number(record.itemId);
  const metadata = record.metadata;
  return {
    itemId,
    itemType: typeof record.itemType === "string" ? record.itemType : undefined,
    title:
      String(getMetadataTitle(metadata) || record.title || "").trim() ||
      `Item ${itemId}`,
    firstCreator:
      typeof record.firstCreator === "string" ? record.firstCreator : undefined,
    year: typeof record.year === "string" ? record.year : undefined,
    metadata,
    tags: Array.isArray(record.tags)
      ? record.tags.filter((tag): tag is string => typeof tag === "string")
      : [],
    attachments: Array.isArray(record.attachments)
      ? record.attachments
          .filter((attachment) => attachment && typeof attachment === "object")
          .map((attachment) => attachment as { contentType?: string })
      : [],
  };
}

function analyzeAuditRecord(record: AuditRecord): AuditIssue | null {
  const meta = record.metadata;
  const missingFields: string[] = [];
  const title = getMetadataTitle(meta) || record.title;

  if (!title || /^item\s+\d+$/i.test(title)) missingFields.push("title");
  if (!hasMetadataCreators(meta)) missingFields.push("creators");
  if (!extractYear(getMetadataField(meta, "date") || record.year || "")) {
    missingFields.push("date/year");
  }
  if (!getMetadataField(meta, "abstractNote")) {
    missingFields.push("abstract");
  }
  if (!getMetadataField(meta, "DOI") && !getMetadataField(meta, "url")) {
    missingFields.push("DOI/URL");
  }
  if (
    !getMetadataField(meta, "publicationTitle") &&
    !getMetadataField(meta, "proceedingsTitle")
  ) {
    missingFields.push("publication venue");
  }
  if (record.tags.length === 0) missingFields.push("tags");
  if (
    !record.attachments.some((att) => att.contentType === "application/pdf")
  ) {
    missingFields.push("PDF");
  }

  return missingFields.length
    ? {
        itemId: record.itemId,
        title: title || `Item ${record.itemId}`,
        missingFields,
      }
    : null;
}

async function fetchCanonicalPatchForRecord(
  record: AuditRecord,
  ctx: ActionExecutionContext,
): Promise<EditableArticleMetadataPatch | null> {
  const meta = record.metadata;
  const doi = normalizeDoi(getMetadataField(meta, "DOI"));
  const title = getMetadataTitle(meta) || record.title;
  if (!doi && (!title || /^item\s+\d+$/i.test(title))) return null;

  const label = doi ? `DOI: ${doi}` : `title: ${title.slice(0, 50)}`;
  ctx.onProgress({
    type: "status",
    message: `Fetching metadata for ${label}`,
  });

  const searchArgs: Record<string, unknown> = {
    mode: "metadata",
    libraryID: ctx.libraryID,
  };
  if (doi) {
    searchArgs.doi = doi;
  } else {
    searchArgs.title = title;
    if (record.firstCreator) searchArgs.author = record.firstCreator;
  }

  const metaResult = await callTool(
    "search_literature_online",
    searchArgs,
    ctx,
    `Fetching metadata for ${label}`,
  );
  if (!metaResult.ok) return null;

  const metaContent = metaResult.content as Record<string, unknown>;
  const results = Array.isArray(metaContent.results) ? metaContent.results : [];
  const externalMeta = results[0] as Record<string, unknown> | undefined;
  const sourcePatch = externalMeta?.patch as
    | EditableArticleMetadataPatch
    | undefined;
  if (!sourcePatch || Object.keys(sourcePatch).length === 0) return null;
  return buildSupportedPatch(record, sourcePatch, ctx);
}

function buildSupportedPatch(
  record: AuditRecord,
  sourcePatch: EditableArticleMetadataPatch,
  ctx: ActionExecutionContext,
): EditableArticleMetadataPatch | null {
  const patch: EditableArticleMetadataPatch = {};
  for (const fieldName of EDITABLE_ARTICLE_METADATA_FIELDS) {
    const newValue = sourcePatch[fieldName as EditableArticleMetadataField];
    if (!newValue) continue;
    if (!shouldFillField(record, fieldName)) continue;
    if (!isMetadataFieldSupported(ctx, record.itemId, fieldName)) continue;
    patch[fieldName as EditableArticleMetadataField] = newValue;
  }
  if (
    !hasMetadataCreators(record.metadata) &&
    sourcePatch.creators?.length &&
    areMetadataCreatorsSupported(ctx, record.itemId)
  ) {
    patch.creators = sourcePatch.creators;
  }
  return Object.keys(patch).length ? patch : null;
}

function shouldFillField(
  record: AuditRecord,
  fieldName: EditableArticleMetadataField,
): boolean {
  const currentValue = getMetadataField(record.metadata, fieldName);
  if (!currentValue) return true;
  if (fieldName === "title" && /^item\s+\d+$/i.test(currentValue)) {
    return true;
  }
  if (fieldName === "date" && !extractYear(currentValue)) {
    return true;
  }
  if (fieldName === "DOI" && !normalizeDoi(currentValue)) {
    return true;
  }
  return false;
}

function normalizeDoi(value: string | undefined): string | undefined {
  const normalized = (value || "")
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
  if (!normalized || !/^10\.\S+\/\S+$/i.test(normalized)) return undefined;
  return normalized;
}

function extractYear(value: string): string | undefined {
  return value.match(/\b(18|19|20)\d{2}\b/)?.[0];
}

function isNonBibliographicTarget(target: LibraryItemTarget): boolean {
  if (target.noteKind) return true;
  const itemType = (target.itemType || "").toLowerCase();
  return (
    itemType === "note" ||
    itemType === "attachment" ||
    itemType === "annotation"
  );
}

function isAuditableBibliographicRecord(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const record = entry as Record<string, unknown>;
  if (typeof record.itemId !== "number") return false;
  if (record.noteKind) return false;
  const itemType =
    typeof record.itemType === "string" ? record.itemType.toLowerCase() : "";
  if (
    itemType === "note" ||
    itemType === "attachment" ||
    itemType === "annotation"
  ) {
    return false;
  }
  return Boolean(record.metadata && typeof record.metadata === "object");
}

function isMetadataFieldSupported(
  ctx: ActionExecutionContext,
  itemId: number,
  fieldName: EditableArticleMetadataField,
): boolean {
  const gateway = ctx.zoteroGateway as {
    getItem?: (itemId: number) => Zotero.Item | null | undefined;
    isEditableArticleMetadataFieldSupported?: (
      item: Zotero.Item | null | undefined,
      fieldName: EditableArticleMetadataField,
    ) => boolean;
  };
  if (
    typeof gateway.getItem !== "function" ||
    typeof gateway.isEditableArticleMetadataFieldSupported !== "function"
  ) {
    return true;
  }
  return gateway.isEditableArticleMetadataFieldSupported(
    gateway.getItem(itemId),
    fieldName,
  );
}

function areMetadataCreatorsSupported(
  ctx: ActionExecutionContext,
  itemId: number,
): boolean {
  const gateway = ctx.zoteroGateway as {
    getItem?: (itemId: number) => Zotero.Item | null | undefined;
    supportsEditableArticleCreators?: (
      item: Zotero.Item | null | undefined,
    ) => boolean;
  };
  if (
    typeof gateway.getItem !== "function" ||
    typeof gateway.supportsEditableArticleCreators !== "function"
  ) {
    return true;
  }
  return gateway.supportsEditableArticleCreators(gateway.getItem(itemId));
}
