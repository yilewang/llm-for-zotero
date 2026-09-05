import type { AgentWriteToolDefinition } from "../../types";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import {
  analyzeJournalActions,
  revertActions,
} from "../../services/changeReverter";
import {
  selectRevertJournalActions,
  type JournalAction,
  type JournalActionWithSteps,
} from "../../store/changeJournal";
import { ok, fail, validateObject, normalizePositiveInt } from "../shared";

type RevertChangesInput = {
  count: number;
  dryRun: boolean;
};

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
              requestedTargets: [],
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
      mutability: "write",
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
      return ok({
        count: normalizePositiveInt(record.count) ?? 1,
        dryRun: record.dryRun === true,
      });
    },

    /**
     * A dry run changes nothing, so it needs no card; and there is nothing to
     * confirm when the journal has no pending entries.
     */
    async shouldRequireConfirmation(input, context) {
      if (input.dryRun) return false;
      const selection = await selectRevertJournalActions({
        conversationKey: context.request.conversationKey,
        count: input.count,
      });
      return selection.actions.length > 0;
    },

    async planMutation(input, context) {
      if (input.dryRun) {
        return { effect: "none", reversibility: "full" };
      }
      const selection = await selectRevertJournalActions({
        conversationKey: context.request.conversationKey,
        count: input.count,
      });
      return selection.actions.length
        ? {
            effect: "write",
            reversibility: "none",
            reason:
              "Reverting history does not create redo entries, so the revert itself cannot be automatically undone.",
            requiresConfirmation: true,
          }
        : { effect: "none", reversibility: "full" };
    },

    async createPendingAction(input, context) {
      // Irreversible actions never consume the count budget; they are
      // disclosed as changes that will remain, matching undo_last_action.
      const selection = await selectRevertJournalActions({
        conversationKey: context.request.conversationKey,
        count: input.count,
      });
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
      const selection = await selectRevertJournalActions({
        conversationKey: context.request.conversationKey,
        count: input.count,
      });
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
