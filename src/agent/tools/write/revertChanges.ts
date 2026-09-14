import type { AgentWriteToolDefinition, AgentToolContext } from "../../types";
import {
  readOnlyInvocationPlan,
  stateChangeInvocationPlan,
} from "../../authorization/invocationPlan";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import {
  analyzeJournalActions,
  revertActions,
} from "../../services/changeReverter";
import {
  selectRevertJournalActions,
  listJournalActions,
  type JournalAction,
  type JournalActionWithSteps,
} from "../../store/changeJournal";
import { ok, fail, validateObject, normalizePositiveInt } from "../shared";

type RevertChangesInput = {
  count: number;
  actionIds?: string[];
  dryRun: boolean;
};

async function selectActions(
  input: RevertChangesInput,
  context: AgentToolContext,
) {
  if (!input.actionIds) {
    if (context.authorization?.standalone)
      throw new Error(
        "Standalone MCP recovery requires explicit actionIds from write receipts.",
      );
    return selectRevertJournalActions({
      conversationKey: context.request.conversationKey,
      count: input.count,
    });
  }
  const actions = await listJournalActions({
    actionIds: input.actionIds,
    conversationKey: context.request.conversationKey,
    pendingOnly: true,
    limit: input.actionIds.length,
  });
  const missing = input.actionIds.filter(
    (id) => !actions.some((action) => action.actionId === id),
  );
  if (missing.length)
    throw new Error(
      `Journal actions ${missing.join(", ")} are unavailable in this execution history.`,
    );
  // The journal owns newest-first ordering, including equal timestamps.
  return {
    actions: actions.filter((action) => action.reversibility !== "none"),
    skippedIrreversible: actions.filter(
      (action) => action.reversibility === "none",
    ),
  };
}

/**
 * Reverts the agent's recent library changes from the durable journal.
 *
 * This is not the old `undo_last_action`. That popped one entry off a
 * ten-deep stack of closures held in RAM, wiped by a restart, which five of
 * fifteen operations never pushed to at all. This reads the journal, so it
 * survives a restart, has no depth ceiling, and can report the changes it
 * *cannot* undo instead of silently doing nothing.
 *
 * Deliberately agent-callable as well as user-facing: after a partial
 * failure the agent needs to be able to put the library back rather than
 * leaving it half-changed and reporting a mess.
 */
export function createRevertChangesTool(
  zoteroGateway: ZoteroGateway,
): AgentWriteToolDefinition<RevertChangesInput, unknown> {
  return {
    describeAction: (input) =>
      input.dryRun
        ? []
        : [
            {
              id: `revert:${input.count}`,
              proofDomain: "zotero_state",
              capability: "zotero.undo",
              operation: "revert",
              source: "zotero_native",
              parameters: { revertCount: input.count },
              requestedTargets: (input.actionIds || []).map(
                (id) => `journal-action:${id}`,
              ),
              destinationCollectionIds: [],
            },
          ],
    spec: {
      name: "revert_changes",
      description:
        "Undo recent durable actions recorded in the agent's change history. Use dryRun first to analyze conflicts. Each action's steps are reverted newest-first.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          actionIds: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            description:
              "Exact journal action IDs from write receipts. Required for standalone MCP recovery; mutually exclusive with count.",
          },
          count: {
            type: "number",
            description:
              "How many of the most recent recorded changes to undo. Default 1.",
          },
          dryRun: {
            type: "boolean",
            description:
              "List what would be undone without changing anything. Prefer this before reverting more than one change.",
          },
        },
      },
      executionClass: "external_effect",
      requiresConfirmation: true,
    },

    presentation: {
      label: "Revert Changes",
      summaries: {
        onCall: "Preparing to undo recent library changes",
        onPending: "Waiting for confirmation to undo changes",
        onApproved: "Undoing changes",
        onDenied: "Undo cancelled",
        onSuccess: ({ content }) => {
          const record =
            content && typeof content === "object"
              ? (content as Record<string, unknown>)
              : {};
          if (record.dryRun) return "Listed the changes that can be undone";
          const reverted = Number(record.reverted) || 0;
          const partiallyReverted = Number(record.partiallyReverted) || 0;
          if (partiallyReverted) {
            return reverted
              ? `Undid ${reverted} change${reverted === 1 ? "" : "s"} fully and ${partiallyReverted} partially`
              : `Partially undid ${partiallyReverted} change${partiallyReverted === 1 ? "" : "s"}; some effects may remain`;
          }
          return `Undid ${reverted} change${reverted === 1 ? "" : "s"}`;
        },
      },
    },

    validate(args) {
      if (
        args !== undefined &&
        !validateObject<Record<string, unknown>>(args)
      ) {
        return fail("Expected an object, for example { count: 1 }");
      }
      const record = (args || {}) as Record<string, unknown>;
      if (
        record.actionIds !== undefined &&
        (!Array.isArray(record.actionIds) ||
          !record.actionIds.length ||
          record.actionIds.some((id) => typeof id !== "string" || !id.trim()) ||
          record.count !== undefined)
      )
        return fail(
          "actionIds must be a non-empty list of identities and cannot be combined with count.",
        );
      return ok({
        ...(Array.isArray(record.actionIds)
          ? {
              actionIds: [
                ...new Set(record.actionIds.map((id) => String(id).trim())),
              ],
            }
          : {}),
        count: normalizePositiveInt(record.count) ?? 1,
        dryRun: record.dryRun === true,
      });
    },

    async planInvocation(input, context) {
      const selection = await selectActions(input, context);
      if (input.dryRun) {
        return readOnlyInvocationPlan({
          reason: "A dry run reads journal state without applying inverses.",
        });
      }
      return selection.actions.length
        ? stateChangeInvocationPlan({
            targets: selection.actions.map(
              (action) => `journal-action:${action.actionId}`,
            ),
            reversibility: "none",
            reason:
              "Reverting history does not create redo entries, so the revert itself cannot be automatically undone.",
          })
        : readOnlyInvocationPlan({
            reason: "There are no journalled actions to revert.",
          });
    },

    async createPendingAction(input, context) {
      // Irreversible actions never consume the count budget; they are
      // disclosed as changes that will remain, matching undo_last_action.
      const selection = await selectActions(input, context);
      const pending = selection.actions;
      const summary = [
        describeEntries(pending),
        describeSkippedIrreversible(selection.skippedIrreversible),
      ]
        .filter(Boolean)
        .join("\n\n");
      return {
        toolName: "revert_changes",
        title: `Undo ${pending.length} change${pending.length === 1 ? "" : "s"}`,
        description: summary,
        confirmLabel: "Undo",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "text" as const,
            id: "summary",
            label: "Changes to undo",
            value: summary,
          },
        ],
      };
    },

    applyConfirmation(input) {
      return ok(input);
    },

    async execute(input, context) {
      const selection = await selectActions(input, context);
      const pending = selection.actions;
      const skippedIrreversible = selection.skippedIrreversible.map(
        (action) => ({
          entryId: action.actionId,
          reason: action.recovery || action.error || "No inverse was recorded",
        }),
      );

      if (input.dryRun) {
        const conflicts = await analyzeJournalActions({
          actions: pending,
          zoteroGateway,
          context,
        });
        return {
          content: {
            dryRun: true,
            changes: pending.map((action) => ({
              actionId: action.actionId,
              description: action.description,
              toolName: action.toolName,
              stepCount: action.steps.length,
              itemCount: action.affectedCount,
              reversibility: action.reversibility,
              reason: action.recovery,
            })),
            skipped: skippedIrreversible,
            conflicts,
          },
          effect: "none",
        };
      }

      if (!pending.length) {
        return {
          content: {
            reverted: 0,
            partiallyReverted: 0,
            residuals: [],
            skipped: skippedIrreversible,
            message: skippedIrreversible.length
              ? "The most recent changes cannot be undone automatically, and no older reversible change was requested."
              : "There are no recorded changes left to undo.",
          },
          effect: "none",
        };
      }

      const outcome = await revertActions({
        actions: pending,
        zoteroGateway,
        context,
      });
      return {
        content: {
          reverted: outcome.reverted,
          partiallyReverted: outcome.partiallyReverted,
          actionIds: pending.map((action) => action.actionId),
          residuals: outcome.residuals,
          // Named explicitly so the agent reports what it could NOT put back
          // rather than implying a clean rollback.
          skipped: [...skippedIrreversible, ...outcome.skipped],
          conflicts: outcome.conflicts,
        },
        effect:
          outcome.reverted + outcome.partiallyReverted === 0
            ? "none"
            : outcome.partiallyReverted > 0 ||
                outcome.skipped.length > 0 ||
                outcome.conflicts.length > 0
              ? "partial"
              : "applied",
      };
    },
  };
}

function describeEntries(entries: JournalActionWithSteps[]): string {
  return entries
    .map((entry) => {
      const suffix =
        entry.reversibility === "none"
          ? ` — cannot be undone: ${entry.recovery || "no inverse recorded"}`
          : entry.reversibility === "partial"
            ? " — partially reversible"
            : "";
      return `• ${entry.description}${suffix}`;
    })
    .join("\n");
}

function describeSkippedIrreversible(entries: JournalAction[]): string {
  if (!entries.length) return "";
  const lines = entries
    .map(
      (entry) =>
        `• ${entry.description} — ${entry.recovery || "no inverse recorded"}`,
    )
    .join("\n");
  return `Newer changes that will remain (cannot be undone):\n${lines}`;
}
