import type { AgentWriteToolDefinition } from "../../types";
import { fail, ok, validateObject } from "../shared";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { revertActions } from "../../services/changeReverter";
import {
  listJournalActions,
  selectUndoJournalAction,
} from "../../store/changeJournal";

type UndoLastActionInput = {
  /** Internal confirmation witness; this is not part of the tool schema. */
  actionId?: string;
};

export function createUndoLastActionTool(
  zoteroGateway: ZoteroGateway,
): AgentWriteToolDefinition<UndoLastActionInput, unknown> {
  return {
    describeAction: (input) => [
      {
        id: `undo:${input.actionId || "latest"}`,
        proofDomain: "zotero_state",
        capability: "zotero.undo",
        operation: "undo",
        source: "zotero_native",
        requestedTargets: input.actionId
          ? [`journal-action:${input.actionId}`]
          : [],
        destinationCollectionIds: [],
      },
    ],
    spec: {
      name: "undo_last_action",
      description:
        "Undo the newest reversible durable write action performed by the agent in this conversation. Newer irreversible actions are disclosed and left unchanged. The history survives restart and an action's steps are reverted newest-first.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      mutability: "write",
      requiresConfirmation: true,
    },
    presentation: {
      label: "Undo Last Action",
      summaries: {
        onCall: "Preparing to undo the last action",
        onPending: "Waiting for your confirmation to undo",
        onApproved: "Approval received - undoing the action",
        onDenied: "Undo cancelled",
        onSuccess: ({ content }) => {
          const record =
            content && typeof content === "object"
              ? (content as Record<string, unknown>)
              : {};
          const description = String(record.description || "");
          if (record.status === "nothing_reversible") {
            return String(
              record.message || "There are no reversible actions left to undo",
            );
          }
          if (record.status === "partially_undone") {
            return description
              ? `Partially undone: ${description}; some effects may remain`
              : "The recorded inverse ran, but some effects may remain";
          }
          return description
            ? `Undone: ${description}`
            : "Last action undone successfully";
        },
      },
    },
    validate: (_args) => {
      return ok<UndoLastActionInput>({});
    },
    shouldRequireConfirmation: async (_input, context) => {
      const selection = await selectUndoJournalAction({
        conversationKey: context.request.conversationKey,
      });
      return Boolean(selection.action);
    },
    planMutation: async (_input, context) => {
      const selection = await selectUndoJournalAction({
        conversationKey: context.request.conversationKey,
      });
      return selection.action
        ? {
            effect: "write",
            reversibility: "none",
            reason:
              "Undo replays an inverse without creating a redo action, so the undo itself cannot be automatically undone.",
            requiresConfirmation: true,
          }
        : { effect: "none", reversibility: "full" };
    },
    createPendingAction: async (_input, context) => {
      const selection = await selectUndoJournalAction({
        conversationKey: context.request.conversationKey,
      });
      const { action, newerIrreversible } = selection;
      _input.actionId = action?.actionId;
      return {
        toolName: "undo_last_action",
        title: action ? "Confirm undo" : "Nothing to undo",
        description: action?.description,
        confirmLabel: "Undo",
        cancelLabel: "Cancel",
        fields: action
          ? [
              {
                type: "select" as const,
                id: "actionId",
                label: "Action to undo",
                value: action.actionId,
                options: [{ id: action.actionId, label: action.description }],
              },
              ...(newerIrreversible.length
                ? [
                    {
                      type: "review_table" as const,
                      id: "newerIrreversible",
                      label: "Newer changes that will remain",
                      rows: newerIrreversible.map((entry) => ({
                        key: entry.actionId,
                        label: entry.description,
                        after:
                          entry.recovery ||
                          "This action has no durable inverse and cannot be undone automatically.",
                      })),
                    },
                  ]
                : []),
            ]
          : [
              {
                type: "text" as const,
                id: "description",
                label: "Action to undo",
                value: "There are no reversible actions left to undo.",
              },
            ],
      };
    },
    applyConfirmation(input, resolutionData) {
      const confirmedActionId =
        validateObject<Record<string, unknown>>(resolutionData) &&
        typeof resolutionData.actionId === "string"
          ? resolutionData.actionId.trim()
          : "";
      if (
        input.actionId &&
        confirmedActionId &&
        confirmedActionId !== input.actionId
      ) {
        return fail(
          "The confirmed journal action does not match the reviewed action",
        );
      }
      const actionId = input.actionId;
      if (!actionId) {
        return fail("The confirmed journal action was not identified");
      }
      return ok({ ...input, actionId });
    },
    execute: async (_input, context) => {
      const selection = await selectUndoJournalAction({
        conversationKey: context.request.conversationKey,
      });
      const action = _input.actionId
        ? (
            await listJournalActions({
              actionId: _input.actionId,
              conversationKey: context.request.conversationKey,
              limit: 1,
              pendingOnly: true,
            })
          )[0]
        : selection.action;
      if (!action) {
        if (_input.actionId) {
          throw new Error(
            "The confirmed action changed before undo could start. Nothing was changed; review the current history and confirm again.",
          );
        }
        return {
          content: {
            status: "nothing_reversible",
            message: selection.newerIrreversible.length
              ? "The remaining recorded actions have no durable inverse and cannot be undone automatically."
              : "There are no reversible actions left to undo.",
            skipped: selection.newerIrreversible.map((entry) => ({
              actionId: entry.actionId,
              description: entry.description,
              reason: entry.recovery || "No inverse was recorded",
            })),
          },
          effect: "none",
        };
      }
      if (action.reversibility === "none") {
        throw new Error(
          "The confirmed action is no longer reversible. Nothing was changed.",
        );
      }
      const outcome = await revertActions({
        actions: [action],
        zoteroGateway,
        context,
      });
      if (!outcome.reverted && !outcome.partiallyReverted) {
        throw new Error(
          outcome.skipped[0]?.reason ||
            "The latest action could not be safely undone",
        );
      }
      return {
        content: {
          status: outcome.partiallyReverted ? "partially_undone" : "undone",
          toolName: action.toolName,
          description: action.description,
          actionId: action.actionId,
          reverted: outcome.reverted,
          partiallyReverted: outcome.partiallyReverted,
          residuals: outcome.residuals,
        },
        effect: outcome.partiallyReverted ? "partial" : "applied",
      };
    },
  };
}
