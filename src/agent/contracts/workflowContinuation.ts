import type { AgentRuntimeRequest } from "../types";
import type {
  AgentActionContract,
  AgentActionIntent,
  AgentActionProgressLedger,
} from "./types";
import { canonicalJson } from "../services/libraryMutation/canonicalJson";
import {
  actionDependencies,
  actionIsComplete,
  obligationsForAction,
} from "./workflowDependencies";
import { loadPlanDocument } from "../documents/store";

function meaning(action: AgentActionIntent) {
  const {
    dependsOn: _dependencies,
    contentFrom: _material,
    destinationFrom: _destination,
    ...requested
  } = action;
  return canonicalJson(requested);
}

/** Reuse links name exact prior evidence; a resume label alone grants no authority. */
export function validatedWorkflowReuse(request: AgentRuntimeRequest) {
  const reuse = request.classifiedIntent?.semantic?.workflowReuse;
  if (!reuse) return undefined;
  const checkpoint = request.workflowCheckpoint;
  if (
    !checkpoint ||
    checkpoint.contract.id !== reuse.contractId ||
    checkpoint.progress.contractId !== reuse.contractId ||
    request.classifiedIntent?.semantic?.continuation === "new"
  )
    throw new Error(
      "The prior workflow identity does not match the requested continuation.",
    );
  const previousActions = checkpoint.contract.intent?.actionIntents || [];
  const currentActions = request.classifiedIntent!.actionIntents;
  if (request.classifiedIntent?.semantic?.continuation === "resume") {
    const previousOutputs =
      checkpoint.contract.intent?.semantic?.materialOutputs || [];
    const currentOutputs =
      request.classifiedIntent.semantic.materialOutputs || [];
    if (
      previousActions.length !== currentActions.length ||
      previousOutputs.length !== currentOutputs.length ||
      previousActions.some(
        (_, index) =>
          !reuse.actions.some((link) => link.previousActionIndex === index),
      ) ||
      previousOutputs.some(
        (output) =>
          !reuse.outputs.some((link) => link.previousOutputId === output.id),
      )
    )
      throw new Error(
        "Resume must retain and explicitly link every original action and material output, including completed prerequisites. Do not repeat completed work means reuse its verified progress, not remove its definition. Use revise for changed outcomes.",
      );
  }

  for (const entry of reuse.actions) {
    const previous = previousActions[entry.previousActionIndex];
    const current = currentActions[entry.actionIndex];
    if (
      !previous ||
      !current ||
      meaning(previous) !== meaning(current) ||
      !obligationsForAction(checkpoint.contract, entry.previousActionIndex)
        .length
    )
      throw new Error(
        "A revised action cannot reuse superseded action authority.",
      );
    const previousDependencies = actionDependencies(current).map(
      (index) =>
        reuse.actions.find((link) => link.actionIndex === index)
          ?.previousActionIndex,
    );
    if (
      canonicalJson(previousDependencies) !==
      canonicalJson(actionDependencies(previous))
    )
      throw new Error("The reused action's prerequisites changed.");
    if (
      current.destinationFrom !== undefined ||
      previous.destinationFrom !== undefined
    ) {
      const destination = reuse.actions.find(
        (link) => link.actionIndex === current.destinationFrom,
      );
      if (
        !destination ||
        destination.previousActionIndex !== previous.destinationFrom
      )
        throw new Error(
          "The reused action references a different created destination.",
        );
    }
    if (current.contentFrom || previous.contentFrom) {
      const output = reuse.outputs.find(
        (link) => link.outputId === current.contentFrom,
      );
      if (!output || output.previousOutputId !== previous.contentFrom)
        throw new Error("The reused action consumes different material.");
    }
  }
  for (const entry of reuse.outputs) {
    const previous =
      checkpoint.contract.intent?.semantic?.materialOutputs?.find(
        (output) => output.id === entry.previousOutputId,
      );
    const current = request.classifiedIntent?.semantic?.materialOutputs?.find(
      (output) => output.id === entry.outputId,
    );
    if (
      !previous ||
      !current ||
      previous.description !== current.description ||
      previous.requiredEvidence !== current.requiredEvidence
    )
      throw new Error("Revised material must be generated as a new version.");
    for (const field of ["afterActions", "sourceActionIndexes"] as const) {
      const mapped = current[field].map(
        (index) =>
          reuse.actions.find((link) => link.actionIndex === index)
            ?.previousActionIndex,
      );
      if (canonicalJson(mapped) !== canonicalJson(previous[field]))
        throw new Error(
          "The reused material's sources or prerequisites changed.",
        );
    }
  }
  return { reuse, checkpoint };
}

export async function carryWorkflowProgress(
  request: AgentRuntimeRequest,
  contract: AgentActionContract,
  progress: AgentActionProgressLedger,
): Promise<void> {
  const previous = validatedWorkflowReuse(request);
  if (!previous) return;
  const { reuse, checkpoint } = previous;
  for (const link of reuse.actions) {
    const prior = obligationsForAction(
      checkpoint.contract,
      link.previousActionIndex,
    );
    const current = obligationsForAction(contract, link.actionIndex);
    if (prior.length !== current.length)
      throw new Error("The reused action's frozen coverage changed.");
    for (const [index, obligation] of current.entries()) {
      const receipt = checkpoint.progress.obligations.find(
        (entry) => entry.obligationId === prior[index].id,
      );
      if (!receipt) continue;
      const target = progress.obligations.find(
        (entry) => entry.obligationId === obligation.id,
      );
      if (target)
        Object.assign(target, JSON.parse(JSON.stringify(receipt)), {
          obligationId: obligation.id,
        });
    }
  }
  for (const link of reuse.outputs) {
    const receipt = checkpoint.progress.materialOutputs?.find(
      (entry) => entry.outputId === link.previousOutputId,
    );
    if (!receipt) continue;
    const output = request.classifiedIntent?.semantic?.materialOutputs?.find(
      (entry) => entry.id === link.outputId,
    );
    if (
      !output?.afterActions.every((index) =>
        actionIsComplete(contract, progress, index),
      )
    )
      throw new Error(
        "The reused material's prerequisite work is not verified.",
      );
    const document = await loadPlanDocument(receipt.documentId);
    if (
      !document ||
      document.conversationKey !== request.conversationKey ||
      document.documentVersion !== receipt.documentVersion ||
      document.contentHash !== receipt.contentHash
    )
      throw new Error(
        "The prior finalized document is unavailable or changed.",
      );
    progress.materialOutputs = [
      ...(progress.materialOutputs || []).filter(
        (entry) => entry.outputId !== link.outputId,
      ),
      { ...receipt, outputId: link.outputId },
    ];
  }
  // Consent belongs to this execution and its current restrictions.
  progress.authorizationGrants = [];
  progress.appliedReceiptKeys = [];
  progress.updatedAt = Date.now();
}
