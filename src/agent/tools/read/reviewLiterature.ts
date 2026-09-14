import { readOnlyInvocationPlan } from "../../authorization/invocationPlan";
import { isExplicitLiteratureImport } from "../../model/literatureIntent";
import { getOriginalAgentPermissionMode } from "../../originalAgentPermissionMode";
import {
  createSearchLiteratureReviewAction,
  resolveSearchLiteratureReview,
} from "../../reviewCards";
import {
  type LiteratureReviewInput,
  discoveryContent,
  getLiteratureDiscovery,
  prepareLiteratureDiscoveryReview,
  resolveLiteratureDiscoveryReview,
} from "../../services/literatureDiscovery";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import type { AgentToolDefinition } from "../../types";
import { fail, normalizePositiveInt, ok, validateObject } from "../shared";

export function createLiteratureReviewTool(
  gateway: ZoteroGateway,
): AgentToolDefinition<LiteratureReviewInput, unknown> {
  return {
    spec: {
      name: "literature_review",
      description:
        "Show a ranked paper-only import-selection card after literature_search. Select the requested number using saved candidate references and evidence-based relevance reasons. Use this card when the user requests selection or review. Ordinary discovery returns ranked results without importing. Explicit import requests use library_import directly instead.",
      executionClass: "read",
      requiresConfirmation: false,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["selections"],
        properties: {
          selections: {
            type: "array",
            minItems: 0,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["candidateSetId", "candidateIndex", "reason"],
              properties: {
                candidateSetId: {
                  type: "string",
                  description:
                    "Exact candidateSetId returned by literature_search in this turn.",
                },
                candidateIndex: {
                  type: "integer",
                  minimum: 1,
                  description:
                    "One-based candidateIndex from that saved candidate set.",
                },
                reason: {
                  type: "string",
                  description:
                    "Brief relevance explanation grounded in the retrieved title/abstract, not invented findings.",
                },
              },
            },
          },
          sessionId: {
            type: "string",
            description:
              "Discovery sessionId from search results or Find more.",
          },
          revision: {
            type: "integer",
            minimum: 0,
            description:
              "Current discovery revision from search results or Find more.",
          },
          outcome: {
            type: "string",
            enum: ["complete", "no_more", "search_failed"],
            description:
              "Use no_more for exhausted relevant matches or search_failed for retrieval errors. Explain either in shortfallReason.",
          },
          targetCollectionId: {
            type: "integer",
            minimum: 1,
            description:
              "Requested destination, after resolving its native collection identity. Otherwise use the one scoped collection or the current library.",
          },
          shortfallReason: {
            type: "string",
            description:
              "Only when fewer genuinely relevant papers can be found than requested: explain the shortfall. Never pad the shortlist with irrelevant papers.",
          },
        },
      },
    },
    presentation: {
      label: "Review relevant papers",
      summaries: {
        onCall: "Preparing ranked paper shortlist",
        onPending: "Choose papers to import",
      },
    },
    validate(args) {
      if (
        !validateObject<Record<string, unknown>>(args) ||
        !Array.isArray(args.selections)
      )
        return fail("Provide a ranked selections list.");
      const selections: LiteratureReviewInput["selections"] = [];
      for (const entry of args.selections) {
        if (
          !validateObject<Record<string, unknown>>(entry) ||
          typeof entry.candidateSetId !== "string" ||
          !/^trh_[a-z0-9]+$/i.test(entry.candidateSetId) ||
          !Number.isSafeInteger(entry.candidateIndex) ||
          Number(entry.candidateIndex) < 1 ||
          typeof entry.reason !== "string" ||
          !entry.reason.trim()
        )
          return fail(
            "Each selection requires a saved candidateSetId, one-based candidateIndex and relevance reason.",
          );
        selections.push({
          candidateSetId: entry.candidateSetId,
          candidateIndex: Number(entry.candidateIndex),
          reason: entry.reason.trim(),
        });
      }
      const targetCollectionId = normalizePositiveInt(args.targetCollectionId);
      if (args.targetCollectionId !== undefined && !targetCollectionId)
        return fail("Invalid targetCollectionId.");
      if (
        args.sessionId !== undefined &&
        (typeof args.sessionId !== "string" ||
          !/^trh_[a-z0-9]+$/i.test(args.sessionId))
      )
        return fail("Invalid discovery sessionId.");
      if (
        args.revision !== undefined &&
        (!Number.isSafeInteger(args.revision) || Number(args.revision) < 0)
      )
        return fail("Invalid discovery revision.");
      if (
        args.outcome !== undefined &&
        !["complete", "no_more", "search_failed"].includes(String(args.outcome))
      )
        return fail("Invalid discovery outcome.");
      if (
        (args.outcome === "no_more" ||
          args.outcome === "search_failed" ||
          !selections.length) &&
        !(
          typeof args.shortfallReason === "string" &&
          args.shortfallReason.trim()
        )
      )
        return fail("Explain the shortfall or search failure.");
      return ok({
        selections,
        sessionId: args.sessionId as string | undefined,
        revision: args.revision as number | undefined,
        outcome: args.outcome as LiteratureReviewInput["outcome"],
        targetCollectionId,
        shortfallReason:
          typeof args.shortfallReason === "string"
            ? args.shortfallReason.trim() || undefined
            : undefined,
      });
    },
    planInvocation: () =>
      readOnlyInvocationPlan({
        domains: ["zotero_library"],
        effects: ["read"],
        targets: [],
        reason:
          "Review saved scholarly candidates without changing the library.",
      }),
    execute: async (input, context) => {
      if (isExplicitLiteratureImport(context.request))
        throw new Error(
          "This is an explicit import request. Use library_import for the requested count and destination; do not substitute a discovery card.",
        );
      const active = await getLiteratureDiscovery(context, true);
      const targetCollectionId =
        active?.session.targetCollectionId ||
        input.targetCollectionId ||
        (context.request.turnPaperScope.collections.length === 1
          ? context.request.turnPaperScope.collections[0].collectionId
          : undefined);
      if (
        active?.session.revision &&
        input.targetCollectionId !== undefined &&
        input.targetCollectionId !== active.session.targetCollectionId
      )
        throw new Error("Find more cannot change the import destination.");
      const collection = targetCollectionId
        ? gateway.getCollectionSummary(targetCollectionId)
        : null;
      if (
        targetCollectionId &&
        (!collection || collection.libraryID !== context.request.libraryID)
      )
        throw new Error(
          "The destination collection is unavailable or outside the current library.",
        );
      const library = globalThis.Zotero?.Libraries?.get?.(
        context.request.libraryID!,
      );
      const libraryName =
        (library && library.name) || `Library ${context.request.libraryID}`;
      const discovery = await prepareLiteratureDiscoveryReview(input, context, {
        targetCollectionId,
        destinationLabel: collection
          ? `${libraryName} › ${collection.path || collection.name}`
          : libraryName,
      });
      return discoveryContent(discovery.record);
    },
    createResultReviewAction: (_input, result, context) =>
      context.request.actionEntryPoint === "action_ui" ||
      getOriginalAgentPermissionMode() === "safe" ||
      context.request.classifiedIntent?.semantic?.literature ===
        "select_then_import"
        ? createSearchLiteratureReviewAction(result, context, result.content)
        : null,
    resolveResultReview: async (_input, result, resolution, context) => {
      const content = result.content as {
        sessionId?: string;
        revision?: number;
      };
      const actionId =
        resolution.actionId || (resolution.approved ? "import" : "cancel");
      if (!["find_more", "import", "cancel"].includes(actionId))
        throw new Error("Unknown discovery action.");
      const action = !resolution.approved ? "cancel" : actionId;
      const continuation = await resolveLiteratureDiscoveryReview(
        content,
        action,
        (resolution.data as { selectedPaperIds?: unknown } | undefined)
          ?.selectedPaperIds,
        context,
      );
      if (action === "find_more") {
        return { kind: "deliver", toolMessageContent: continuation };
      }
      return resolveSearchLiteratureReview(
        result.content as never,
        result,
        resolution,
        context,
      );
    },
  };
}
