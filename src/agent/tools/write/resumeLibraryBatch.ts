/**
 * Continues a checkpointed library_update batch that stopped before its end.
 *
 * The batch froze its per-item operations before it ran, so continuing it
 * needs only its id: the items it still owes are that list minus the ones
 * already done, and nothing is asked of the model again. The rest runs under
 * the batch's own journal action, so one undo still reverts all of it.
 */
import { describeLibraryMutationActions } from "../../contracts/actionOperationEvidence";
import { readOnlyInvocationPlan } from "../../authorization/invocationPlan";
import {
  CHECKPOINTED_OPERATION_TYPES,
  readCheckpointedBatch,
  type CheckpointedBatch,
} from "../../services/checkpointedBatch";
import {
  LibraryMutationService,
  type LibraryMutationOperation,
} from "../../services/libraryMutationService";
import { executeLibraryMutationAction } from "../../services/mutationCoordinator";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import type { AgentToolContext, AgentWriteToolDefinition } from "../../types";
import { fail, ok, validateObject } from "../shared";
import { checkpointResult, planLibraryMutations } from "./mutateLibraryShared";

type ResumeLibraryBatchInput = {
  resumeBatchId: string;
  /** The operations still owed, resolved during preparation. */
  operations?: LibraryMutationOperation[];
  /** Host-resolved batch state, set during preparation. */
  _batch?: CheckpointedBatch;
  /** This resume's own identity, so its receipts are not a repeat. */
  _attempt?: string;
};

export function createResumeLibraryBatchTool(
  zoteroGateway: ZoteroGateway,
): AgentWriteToolDefinition<ResumeLibraryBatchInput, unknown> {
  const mutationService = new LibraryMutationService(zoteroGateway);

  /** Only reads: the user may still cancel. */
  async function resolve(
    input: ResumeLibraryBatchInput,
    context: AgentToolContext,
  ): Promise<CheckpointedBatch> {
    if (input._batch) return input._batch;
    const batch = await readCheckpointedBatch({
      actionId: input.resumeBatchId,
      conversationKey: context.request.conversationKey,
    });
    input._batch = batch;
    input.operations = batch.remaining;
    input._attempt = `${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 10)}`;
    return batch;
  }

  function settled(batch: CheckpointedBatch) {
    const type = batch.frozen[0]?.type || "apply_tags";
    return checkpointResult(type, {
      batchId: batch.actionId,
      total: batch.frozen.length,
      done: batch.frozen.length - batch.remaining.length,
      changed: 0,
      failed: [],
      notStarted: 0,
      stopped: false,
      resumable: false,
    });
  }

  return {
    effectOperations: [...CHECKPOINTED_OPERATION_TYPES],
    spec: {
      name: "resume_library_batch",
      description:
        "Continue a stopped checkpointed library_update batch by its id.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["resumeBatchId"],
        properties: { resumeBatchId: { type: "string" } },
      },
      executionClass: "external_effect",
      workCategory: "zotero_action",
    },
    presentation: {
      label: "Continue Library Changes",
      summaries: {
        onCall: "Preparing to continue library changes",
        onPending: "Waiting for confirmation to continue library changes",
        onApproved: "Continuing library changes",
        onDenied: "Library changes not continued",
        onSuccess: "Library changes continued",
      },
    },

    validate(args: unknown) {
      if (!validateObject<Record<string, unknown>>(args))
        return fail("Expected an object with resumeBatchId");
      const resumeBatchId =
        typeof args.resumeBatchId === "string" ? args.resumeBatchId.trim() : "";
      return resumeBatchId
        ? ok({ resumeBatchId })
        : fail("resumeBatchId must name the batch to continue.");
    },

    async planInvocation(input, context) {
      const batch = await resolve(input, context);
      // Nothing left to write changes the library in no way, so it asks for
      // no confirmation.
      if (!batch.remaining.length)
        return readOnlyInvocationPlan({
          domains: [],
          reason:
            "Every item of this batch is already done, so continuing it changes nothing.",
        });
      return planLibraryMutations(mutationService, batch.remaining, context);
    },

    describeAction: (input) =>
      input.operations?.length
        ? describeLibraryMutationActions({ operations: input.operations }).map(
            (descriptor) => ({
              ...descriptor,
              id: `${descriptor.id}:resume:${input._attempt}`,
            }),
          )
        : [],

    createPendingAction(input) {
      const owed = input.operations?.length || 0;
      const total = input._batch?.frozen.length || owed;
      return {
        toolName: "resume_library_batch",
        title: `Continue ${owed} library change${owed === 1 ? "" : "s"}`,
        description: `${total - owed} of ${total} changes of this batch are already done and are skipped. This can be undone.`,
        confirmLabel: "Continue",
        cancelLabel: "Cancel",
        fields: [],
      };
    },

    async execute(input, context) {
      const batch = await resolve(input, context);
      const operations = input.operations || [];
      if (!operations.length)
        return {
          content: { actionId: batch.actionId, result: settled(batch) },
          effect: "none",
        };
      const coordinated = await executeLibraryMutationAction({
        service: mutationService,
        operations,
        context: {
          ...context,
          resumeJournalAction: { actionId: batch.actionId },
        },
        facadeToolName: "library_update",
      });
      return {
        content: {
          actionId: coordinated.actionId,
          result: coordinated.checkpoint
            ? checkpointResult(operations[0].type, coordinated.checkpoint)
            : settled(batch),
        },
        effect: coordinated.effect,
        actionEvidence: coordinated.actionEvidence,
      };
    },
  };
}
