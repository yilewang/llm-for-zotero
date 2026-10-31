import type {
  AgentToolContext,
  AgentToolInputValidation,
  AgentWriteToolDefinition,
} from "../../types";
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
  describeJournalSteps,
  gatewayMutationLabels,
  isLegacyActionDescription,
} from "../../services/libraryMutation/describe";
import {
  listJournalActions,
  listJournalSteps,
  selectRevertJournalActions,
  selectUndoJournalAction,
  type JournalAction,
  type JournalActionWithSteps,
} from "../../store/changeJournal";
import { fail, normalizePositiveInt, ok, validateObject } from "../shared";

const UNDO_TOOL_NAME = "undo";

/** Undo one action: the newest reversible one, or the exact `actionId`. */
type UndoOneInput = {
  /** Exact durable action, optionally supplied by a completed result card. */
  actionId?: string;
};

/** Revert several actions newest-first, or list them first with `dryRun`. */
type RevertManyInput = {
  count: number;
  actionIds?: string[];
  dryRun: boolean;
};

type UndoInput = UndoOneInput | RevertManyInput;

function isRevertMany(input: UndoInput): input is RevertManyInput {
  return "count" in input;
}

/** The hooks each branch owns; the tool dispatches every one of them. */
type UndoBranch<TInput> = Required<
  Pick<
    AgentWriteToolDefinition<TInput, unknown>,
    | "describeAction"
    | "planInvocation"
    | "createPendingAction"
    | "applyConfirmation"
    | "execute"
  >
>;

/**
 * Rows written before actions were described in words read "Apply <operation>"
 * or "library_update: 3 planned changes". Rebuild those from the steps the
 * row holds, so the card never shows an internal token.
 */
async function withReadableDescription<T extends JournalAction>(
  action: T,
  zoteroGateway: ZoteroGateway,
): Promise<T> {
  if (!isLegacyActionDescription(action.description)) return action;
  try {
    const steps =
      (action as Partial<JournalActionWithSteps>).steps ||
      (await listJournalSteps(action.actionId));
    const description = describeJournalSteps(
      steps,
      gatewayMutationLabels(zoteroGateway),
    );
    return description ? { ...action, description } : action;
  } catch {
    return action;
  }
}

async function withReadableDescriptions<T extends JournalAction>(
  actions: T[],
  zoteroGateway: ZoteroGateway,
): Promise<T[]> {
  return Promise.all(
    actions.map((action) => withReadableDescription(action, zoteroGateway)),
  );
}

async function selectActions(
  input: RevertManyInput,
  context: AgentToolContext,
  zoteroGateway: ZoteroGateway,
) {
  const selection = await selectRawActions(input, context);
  return {
    actions: await withReadableDescriptions(selection.actions, zoteroGateway),
    skippedIrreversible: await withReadableDescriptions(
      selection.skippedIrreversible,
      zoteroGateway,
    ),
  };
}

async function selectRawActions(
  input: RevertManyInput,
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
 * The single undo: the newest reversible action in this conversation, or the
 * exact action a result card names. Newer irreversible actions are disclosed
 * on its card and left unchanged.
 */
function undoOne(zoteroGateway: ZoteroGateway): UndoBranch<UndoOneInput> {
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
    planInvocation: async (input, context) => {
      if (context.authorization?.standalone && !input.actionId)
        throw new Error(
          "Standalone MCP undo requires an explicit actionId from a write receipt.",
        );
      const action = input.actionId
        ? (
            await listJournalActions({
              actionId: input.actionId,
              conversationKey: context.request.conversationKey,
              limit: 1,
              pendingOnly: true,
            })
          )[0]
        : (
            await selectUndoJournalAction({
              conversationKey: context.request.conversationKey,
            })
          ).action;
      return action
        ? stateChangeInvocationPlan({
            targets: [`journal-action:${action.actionId}`],
            reversibility: "none",
            reason:
              "Undo replays an inverse without creating a redo action, so the undo itself cannot be automatically undone.",
          })
        : readOnlyInvocationPlan({
            reason: "There is no journalled action to undo.",
          });
    },
    createPendingAction: async (_input, context) => {
      const selection = context.authorization?.standalone
        ? { action: undefined, newerIrreversible: [] }
        : await selectUndoJournalAction({
            conversationKey: context.request.conversationKey,
          });
      const newerIrreversible = await withReadableDescriptions(
        selection.newerIrreversible,
        zoteroGateway,
      );
      const found = _input.actionId
        ? (
            await listJournalActions({
              actionId: _input.actionId,
              conversationKey: context.request.conversationKey,
              limit: 1,
              pendingOnly: true,
            })
          )[0]
        : selection.action;
      const action = found
        ? await withReadableDescription(found, zoteroGateway)
        : found;
      _input.actionId = action?.actionId;
      return {
        toolName: UNDO_TOOL_NAME,
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
      if (context.authorization?.standalone && !_input.actionId)
        throw new Error(
          "Standalone MCP undo requires an explicit actionId from a write receipt.",
        );
      const selection = context.authorization?.standalone
        ? { action: undefined, newerIrreversible: [] }
        : await selectUndoJournalAction({
            conversationKey: context.request.conversationKey,
          });
      const found = _input.actionId
        ? (
            await listJournalActions({
              actionId: _input.actionId,
              conversationKey: context.request.conversationKey,
              limit: 1,
              pendingOnly: true,
            })
          )[0]
        : selection.action;
      const action = found
        ? await withReadableDescription(found, zoteroGateway)
        : found;
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
            skipped: (
              await withReadableDescriptions(
                selection.newerIrreversible,
                zoteroGateway,
              )
            ).map((entry) => ({
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
      if (
        !outcome.reverted &&
        !outcome.partiallyReverted &&
        !outcome.steps.length
      ) {
        // Nothing was replayed at all, so nothing changed and there is no
        // observation to report.
        throw new Error(
          outcome.skipped[0]?.reason ||
            "The latest action could not be safely undone",
        );
      }
      const incomplete =
        !outcome.reverted &&
        !outcome.partiallyReverted &&
        outcome.steps.length > 0;
      return {
        content: {
          // An inverse that ran but did not read back as restored is neither
          // "undone" nor "nothing happened". The action stays `revert_failed`
          // in the journal and can be undone again; saying so here is what
          // lets the receipt name the steps that did hold.
          status: incomplete
            ? "undo_incomplete"
            : outcome.partiallyReverted
              ? "partially_undone"
              : "undone",
          toolName: action.toolName,
          description: action.description,
          actionId: action.actionId,
          reverted: outcome.reverted,
          partiallyReverted: outcome.partiallyReverted,
          residuals: outcome.residuals,
          // The receipt's proof: how each replayed step read back from native
          // state, rather than the counters immediately above it.
          revertedSteps: outcome.steps,
          ...(incomplete ? { skipped: outcome.skipped } : {}),
        },
        effect: incomplete || outcome.partiallyReverted ? "partial" : "applied",
      };
    },
  };
}

/**
 * Reverts several of the agent's recent library changes from the durable
 * journal, newest-first, with conflict analysis on `dryRun`.
 *
 * The journal survives a restart, has no depth ceiling, and can report the
 * changes it *cannot* undo instead of silently doing nothing. Deliberately
 * agent-callable as well as user-facing: after a partial failure the agent
 * needs to be able to put the library back rather than leaving it
 * half-changed and reporting a mess.
 */
function revertMany(zoteroGateway: ZoteroGateway): UndoBranch<RevertManyInput> {
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
    async planInvocation(input, context) {
      const selection = await selectActions(input, context, zoteroGateway);
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
      // disclosed as changes that will remain, matching the single undo.
      const selection = await selectActions(input, context, zoteroGateway);
      const pending = selection.actions;
      const summary = [
        describeEntries(pending),
        describeSkippedIrreversible(selection.skippedIrreversible),
      ]
        .filter(Boolean)
        .join("\n\n");
      return {
        toolName: UNDO_TOOL_NAME,
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
      const selection = await selectActions(input, context, zoteroGateway);
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
          // The receipt's proof: how each replayed step read back from native
          // state, rather than the counters immediately above it.
          revertedSteps: outcome.steps,
          // Named explicitly so the agent reports what it could NOT put back
          // rather than implying a clean rollback.
          skipped: [...skippedIrreversible, ...outcome.skipped],
          conflicts: outcome.conflicts,
        },
        effect:
          outcome.reverted + outcome.partiallyReverted === 0
            ? // An inverse that ran without completing its action still
              // changed the library. Reporting "none" would hide that from
              // the final gate as well as from the user.
              outcome.steps.length
              ? "partial"
              : "none"
            : outcome.partiallyReverted > 0 ||
                outcome.skipped.length > 0 ||
                outcome.conflicts.length > 0
              ? "partial"
              : "applied",
      };
    },
  };
}

/**
 * The one recovery tool. No `count`, `actionIds`, or `dryRun:true` undoes one
 * action (the single-undo card); any of them reverts several newest-first
 * (the multi-revert card). Each branch keeps its own approval semantics.
 */
export function createUndoTool(
  zoteroGateway: ZoteroGateway,
): AgentWriteToolDefinition<UndoInput, unknown> {
  const one = undoOne(zoteroGateway);
  const many = revertMany(zoteroGateway);
  return {
    describeAction: (input, context) =>
      isRevertMany(input)
        ? many.describeAction(input, context)
        : one.describeAction(input, context),
    effectOperations: ["undo", "revert"],
    spec: {
      name: UNDO_TOOL_NAME,
      description:
        "Undo durable write actions recorded in the agent's change history for this conversation; the history survives restart and an action's steps are reverted newest-first. With no arguments, undo the newest reversible action (newer irreversible actions are disclosed and left unchanged); actionId undoes that exact action. count or actionIds revert several newest-first; dryRun lists them with conflicts without changing anything.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          actionId: {
            type: "string",
            description:
              "Exact journal action to undo; omit to select the latest reversible action. Cannot be combined with actionIds, count, or dryRun.",
          },
          actionIds: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            description:
              "Exact journal action IDs from write receipts to revert. Required for standalone MCP recovery of several actions; mutually exclusive with count.",
          },
          count: {
            type: "number",
            description:
              "How many of the most recent recorded changes to revert. Default 1.",
          },
          dryRun: {
            type: "boolean",
            description:
              "List what would be undone without changing anything. Prefer this before reverting more than one change.",
          },
        },
      },
      executionClass: "external_effect",
      workCategory: "zotero_action",
    },
    presentation: {
      label: "Undo",
      summaries: {
        onCall: "Preparing to undo",
        onPending: "Waiting for your confirmation to undo",
        onApproved: "Approval received - undoing",
        onDenied: "Undo cancelled",
        onSuccess: ({ content }) => {
          const record =
            content && typeof content === "object"
              ? (content as Record<string, unknown>)
              : {};
          return typeof record.status === "string"
            ? summarizeUndoOne(record)
            : summarizeRevertMany(record);
        },
      },
    },
    validate(args): AgentToolInputValidation<UndoInput> {
      if (
        args !== undefined &&
        !validateObject<Record<string, unknown>>(args)
      ) {
        return fail("Undo expects an object, for example {} or { count: 2 }");
      }
      const record = (args || {}) as Record<string, unknown>;
      if (record.dryRun !== undefined && typeof record.dryRun !== "boolean")
        return fail("dryRun must be a boolean");
      // An explicit dryRun:false asks for nothing a single undo lacks.
      const wantsMany =
        record.count !== undefined ||
        record.actionIds !== undefined ||
        record.dryRun === true;
      if (record.actionId !== undefined && wantsMany)
        return fail(
          "actionId undoes one exact action and cannot be combined with actionIds, count, or dryRun; use actionIds:[id] to revert or dry-run named actions.",
        );
      return wantsMany ? validateRevertMany(record) : validateUndoOne(record);
    },
    acceptInheritedApproval: (input, approval) =>
      !isRevertMany(input) &&
      approval.sourceToolName === "note_change" &&
      approval.sourceMode === "approval" &&
      approval.sourceActionId === input.actionId,
    planInvocation: (input, context) =>
      isRevertMany(input)
        ? many.planInvocation(input, context)
        : one.planInvocation(input, context),
    createPendingAction: (input, context) =>
      isRevertMany(input)
        ? many.createPendingAction(input, context)
        : one.createPendingAction(input, context),
    applyConfirmation: (input, resolutionData, context) =>
      isRevertMany(input)
        ? many.applyConfirmation(input, resolutionData, context)
        : one.applyConfirmation(input, resolutionData, context),
    execute: (input, context) =>
      isRevertMany(input)
        ? many.execute(input, context)
        : one.execute(input, context),
  };
}

function validateUndoOne(
  record: Record<string, unknown>,
): AgentToolInputValidation<UndoInput> {
  if (
    record.actionId !== undefined &&
    (typeof record.actionId !== "string" || !record.actionId.trim())
  )
    return fail("actionId must be a non-empty journal identity");
  return ok<UndoInput>(
    typeof record.actionId === "string" ? { actionId: record.actionId } : {},
  );
}

function validateRevertMany(
  record: Record<string, unknown>,
): AgentToolInputValidation<UndoInput> {
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
  return ok<UndoInput>({
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
}

function summarizeUndoOne(record: Record<string, unknown>): string {
  const description = String(record.description || "");
  if (record.status === "nothing_reversible") {
    return String(
      record.message || "There are no reversible actions left to undo",
    );
  }
  if (record.status === "undo_incomplete") {
    return description
      ? `Could not finish undoing: ${description}; it is still in the history and can be undone again`
      : "The recorded inverse ran but the change was not restored; it can be undone again";
  }
  if (record.status === "partially_undone") {
    return description
      ? `Partially undone: ${description}; some effects may remain`
      : "The recorded inverse ran, but some effects may remain";
  }
  return description
    ? `Undone: ${description}`
    : "Last action undone successfully";
}

function summarizeRevertMany(record: Record<string, unknown>): string {
  if (record.dryRun) return "Listed the changes that can be undone";
  const reverted = Number(record.reverted) || 0;
  const partiallyReverted = Number(record.partiallyReverted) || 0;
  if (partiallyReverted) {
    return reverted
      ? `Undid ${reverted} change${reverted === 1 ? "" : "s"} fully and ${partiallyReverted} partially`
      : `Partially undid ${partiallyReverted} change${partiallyReverted === 1 ? "" : "s"}; some effects may remain`;
  }
  return `Undid ${reverted} change${reverted === 1 ? "" : "s"}`;
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
