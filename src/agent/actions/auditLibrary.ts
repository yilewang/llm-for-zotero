import type {
  AgentAction,
  ActionExecutionContext,
  ActionResult,
} from "./types";
import type {
  EditableArticleMetadataPatch,
  EditableArticleMetadataField,
} from "../services/zoteroGateway";
import { EDITABLE_ARTICLE_METADATA_FIELDS } from "../services/zoteroGateway";
import { callTool } from "./executor";
import {
  getMetadataField,
  getMetadataTitle,
  hasMetadataCreators,
} from "./metadataSnapshot";

type AuditScope = "all" | "collection";

type AuditLibraryInput = {
  scope?: AuditScope;
  collectionId?: number;
  /** Max number of items to process. */
  limit?: number;
  /** If true, saves an audit report note to the library. */
  saveNote?: boolean;
};

export type AuditIssue = {
  itemId: number;
  title: string;
  missingFields: string[];
};

type AuditLibraryOutput = {
  total: number;
  itemsWithIssues: number;
  issues: AuditIssue[];
  metadataFixed: number;
  noteId?: number;
};

/**
 * Combined audit + sync action: scans the library for incomplete metadata,
 * fetches canonical metadata for items with issues, and applies fixes.
 */
export const auditLibraryAction: AgentAction<
  AuditLibraryInput,
  AuditLibraryOutput
> = {
  name: "audit_library",
  modes: ["library"],
  description:
    "Scan the library for items with incomplete metadata, then fetch and fill missing fields " +
    "(abstract, DOI, tags) from external sources after user review.",
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
        description: "Max number of items to process.",
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
    const STEPS = 4 + (input.saveNote ? 1 : 0);
    let step = 0;

    // Step 1: query items
    ctx.onProgress({
      type: "step_start",
      step: "Querying library items",
      index: ++step,
      total: STEPS,
    });
    const queryArgs: Record<string, unknown> = {
      entity: "items",
      mode: "list",
      include: ["metadata", "tags", "attachments"],
    };
    if (input.scope === "collection" && input.collectionId) {
      (queryArgs as { filters?: unknown }).filters = {
        collectionId: input.collectionId,
      };
    }
    if (input.limit) queryArgs.limit = input.limit;

    const queryResult = await callTool(
      "query_library",
      queryArgs,
      ctx,
      "Querying library items",
    );
    if (!queryResult.ok) {
      return {
        ok: false,
        error: `Failed to query library: ${JSON.stringify(queryResult.content)}`,
      };
    }

    const content = queryResult.content as Record<string, unknown>;
    const items = Array.isArray(content.results) ? content.results : [];
    ctx.onProgress({
      type: "step_done",
      step: "Querying library items",
      summary: `Found ${items.length} item${items.length === 1 ? "" : "s"}`,
    });

    // Step 2: analyze metadata gaps
    ctx.onProgress({
      type: "step_start",
      step: "Analyzing metadata",
      index: ++step,
      total: STEPS,
    });
    const issues: AuditIssue[] = [];

    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const itemId = typeof record.itemId === "number" ? record.itemId : null;
      if (!itemId) continue;

      const meta = record.metadata;
      const title = getMetadataTitle(meta) || record.title || `Item ${itemId}`;
      const missingFields: string[] = [];

      if (!getMetadataField(meta, "abstractNote"))
        missingFields.push("abstract");
      if (!getMetadataField(meta, "DOI") && !getMetadataField(meta, "url")) {
        missingFields.push("DOI/URL");
      }

      const tags = Array.isArray(record.tags) ? record.tags : [];
      if (tags.length === 0) missingFields.push("tags");

      const attachments = Array.isArray(record.attachments)
        ? record.attachments
        : [];
      const hasPdf = attachments.some(
        (att: unknown) =>
          att &&
          typeof att === "object" &&
          (att as Record<string, unknown>).contentType === "application/pdf",
      );
      if (!hasPdf) missingFields.push("PDF");

      if (missingFields.length > 0) {
        issues.push({ itemId, title: String(title), missingFields });
      }
    }

    ctx.onProgress({
      type: "step_done",
      step: "Analyzing metadata",
      summary: `${issues.length} item${issues.length === 1 ? "" : "s"} with issues`,
    });

    // Step 3: fetch canonical metadata for items with fixable issues
    ctx.onProgress({
      type: "step_start",
      step: "Fetching canonical metadata",
      index: ++step,
      total: STEPS,
    });

    // Build candidates from items that have issues and have a DOI or title
    type UpdateCandidate = {
      itemId: number;
      patch: EditableArticleMetadataPatch;
    };
    const updateCandidates: UpdateCandidate[] = [];
    const MAX_METADATA_FETCHES = 20;
    let fetchCount = 0;

    for (const issue of issues) {
      if (fetchCount >= MAX_METADATA_FETCHES) break;
      const record = items.find((i) => {
        if (!i || typeof i !== "object") return false;
        return (i as Record<string, unknown>).itemId === issue.itemId;
      }) as Record<string, unknown> | undefined;
      if (!record) continue;

      const meta = record.metadata;
      const doi =
        getMetadataField(meta, "DOI")?.replace(/^https?:\/\/doi\.org\//i, "") ||
        undefined;
      const title = getMetadataTitle(meta) || undefined;
      if (!doi && !title) continue;

      const label = doi
        ? `DOI: ${doi}`
        : `title: ${(title || "").slice(0, 50)}`;
      ctx.onProgress({
        type: "status",
        message: `Fetching metadata for ${label}`,
      });

      const searchArgs: Record<string, unknown> = {
        mode: "metadata",
        libraryID: ctx.libraryID,
      };
      if (doi) searchArgs.doi = doi;
      else if (title) searchArgs.title = title;

      const metaResult = await callTool(
        "search_literature_online",
        searchArgs,
        ctx,
        `Fetching metadata for ${label}`,
      );
      fetchCount++;
      if (!metaResult.ok) continue;

      const metaContent = metaResult.content as Record<string, unknown>;
      const results = Array.isArray(metaContent.results)
        ? metaContent.results
        : [];
      const externalMeta = results[0] as Record<string, unknown> | undefined;
      if (!externalMeta) continue;

      const sourcePatch = externalMeta.patch as
        | EditableArticleMetadataPatch
        | undefined;
      if (!sourcePatch || Object.keys(sourcePatch).length === 0) continue;

      // Only fill in fields that are currently empty
      const patch: EditableArticleMetadataPatch = {};
      for (const fieldName of EDITABLE_ARTICLE_METADATA_FIELDS) {
        const currentValue = getMetadataField(meta, fieldName);
        const newValue = sourcePatch[fieldName as EditableArticleMetadataField];
        if (!currentValue && newValue) {
          patch[fieldName as EditableArticleMetadataField] = newValue;
        }
      }
      if (!hasMetadataCreators(meta) && sourcePatch.creators?.length) {
        patch.creators = sourcePatch.creators;
      }

      if (Object.keys(patch).length > 0) {
        updateCandidates.push({ itemId: issue.itemId, patch });
      }
    }

    ctx.onProgress({
      type: "step_done",
      step: "Fetching canonical metadata",
      summary: `${updateCandidates.length} item${updateCandidates.length === 1 ? "" : "s"} can be fixed`,
    });

    // Step 4: apply updates with HITL review
    let metadataFixed = 0;
    if (updateCandidates.length > 0) {
      ctx.onProgress({
        type: "step_start",
        step: "Applying metadata updates",
        index: ++step,
        total: STEPS,
      });

      const operations = updateCandidates.map(({ itemId, patch }) => ({
        type: "update_metadata" as const,
        itemId,
        metadata: patch,
      }));

      const mutateResult = await callTool(
        "update_metadata",
        { operations },
        ctx,
        "Updating metadata",
      );

      const mutateContent = mutateResult.content as Record<string, unknown>;
      metadataFixed = mutateResult.ok
        ? Number(
            mutateContent.appliedCount ||
              (Array.isArray(mutateContent.results)
                ? mutateContent.results.length
                : updateCandidates.length),
          )
        : 0;

      ctx.onProgress({
        type: "step_done",
        step: "Applying metadata updates",
        summary: mutateResult.ok
          ? `Fixed ${metadataFixed} item${metadataFixed === 1 ? "" : "s"}`
          : "Update was denied or failed",
      });
    } else {
      ctx.onProgress({
        type: "step_start",
        step: "Applying metadata updates",
        index: ++step,
        total: STEPS,
      });
      ctx.onProgress({
        type: "step_done",
        step: "Applying metadata updates",
        summary: "No fixable items found",
      });
    }

    // Optional: save audit note
    let noteId: number | undefined;
    if (input.saveNote) {
      ctx.onProgress({
        type: "step_start",
        step: "Saving audit note",
        index: ++step,
        total: STEPS,
      });
      const reportLines = [
        `## Library Audit Report`,
        ``,
        `Total items scanned: ${items.length}`,
        `Items with issues: ${issues.length}`,
        `Metadata fixed: ${metadataFixed}`,
        ``,
        `### Issues`,
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
        total: items.length,
        itemsWithIssues: issues.length,
        issues,
        metadataFixed,
        noteId,
      },
    };
  },
};
