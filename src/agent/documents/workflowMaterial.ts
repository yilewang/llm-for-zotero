import { getInterpretedTurnPapers } from "../context/turnPaperScope";
import type { AgentRuntimeRequest } from "../types";
import type { ZoteroGateway } from "../services/zoteroGateway";
import {
  actionIsComplete,
  obligationsForAction,
  type MaterialOutputIntent,
} from "../contracts/workflowDependencies";
import type { PlanDocument } from "./types";
import { loadPlanDocument } from "./store";

export function materialDocumentId(
  request: AgentRuntimeRequest,
  outputId: string,
): string {
  const identity =
    request.actionContract?.intent?.semantic?.id ||
    request.classifiedIntent?.semantic?.id;
  if (!identity)
    throw new Error("The authored material has no frozen semantic identity.");
  return `material:${identity}:${outputId}`;
}
export function resolveMaterialOutput(
  request: AgentRuntimeRequest,
  outputId?: string,
): MaterialOutputIntent | undefined {
  const outputs =
    request.actionContract?.intent?.semantic?.materialOutputs ||
    request.classifiedIntent?.semantic?.materialOutputs ||
    [];
  if (!outputs.length) {
    if (outputId)
      throw new Error("No authored output with that identity was requested.");
    return undefined;
  }
  const output = outputId
    ? outputs.find((entry) => entry.id === outputId)
    : outputs.length === 1
      ? outputs[0]
      : undefined;
  if (!output)
    throw new Error("Specify the materialOutputId from the frozen workflow.");
  return output;
}
export function assertMaterialReady(
  request: AgentRuntimeRequest,
  output: MaterialOutputIntent,
  gateway: ZoteroGateway,
): void {
  const contract = request.actionContract;
  if (
    !contract ||
    !output.afterActions.every((index) =>
      actionIsComplete(contract, request.actionProgress, index),
    )
  )
    throw new Error(
      `Complete and verify the prerequisite actions before producing '${output.id}'.`,
    );
  if (output.requiredEvidence === "none") return;
  const targetIds = [
    ...new Set(
      output.sourceActionIndexes.flatMap((index) =>
        obligationsForAction(contract, index).flatMap(
          (obligation) => obligation.targetBoundary?.frozenTargetIds || [],
        ),
      ),
    ),
  ];
  if (output.sourceActionIndexes.length && !targetIds.length)
    throw new Error(
      `The frozen paper sources for '${output.id}' are unresolved.`,
    );
  const sourceIds = output.sourceActionIndexes.length
    ? targetIds
    : (
        getInterpretedTurnPapers(
          request.turnPaperScope,
          request.classifiedIntent?.paperTargetIntent,
        ) || request.turnPaperScope.papers.map((entry) => entry.paper)
      ).map((paper) => paper.itemId);
  const sources = sourceIds.map((id) => gateway.getItem(id));
  if (sources.some((source) => !source || source.deleted))
    throw new Error(`A frozen source paper for '${output.id}' is unavailable.`);
  if (!sources.length)
    throw new Error(`Resolve the paper evidence sources for '${output.id}'.`);
  for (const source of sources) {
    if (
      !(request.documentReadObservations || []).some(
        (observation) =>
          observation.issuer === "zotero_host" &&
          observation.libraryID === source!.libraryID &&
          observation.itemKey === source!.key &&
          (output.requiredEvidence === "metadata"
            ? observation.capabilities.some((kind) =>
                ["metadata", "abstract", "body"].includes(kind),
              )
            : observation.capabilities.includes("body")),
      )
    )
      throw new Error(
        `Read the requested source paper through the host tools before generating '${output.id}'.`,
      );
  }
}
export function recordMaterialOutput(
  request: AgentRuntimeRequest,
  output: MaterialOutputIntent,
  document: PlanDocument,
): void {
  const progress = request.actionProgress;
  if (!progress || progress.contractId !== request.actionContract?.id)
    throw new Error("The output's action progress is unavailable.");
  const receipt = {
    outputId: output.id,
    documentId: document.documentId,
    documentVersion: document.documentVersion,
    contentHash: document.contentHash,
  };
  progress.materialOutputs = [
    ...(progress.materialOutputs || []).filter(
      (entry) => entry.outputId !== output.id,
    ),
    receipt,
  ];
}
export async function loadWorkflowMaterial(
  request: AgentRuntimeRequest,
  outputId?: string,
): Promise<PlanDocument | null> {
  const outputs =
    request.actionContract?.intent?.semantic?.materialOutputs ||
    request.classifiedIntent?.semantic?.materialOutputs ||
    [];
  for (const output of [...outputs].reverse()) {
    if (outputId && output.id !== outputId) continue;
    const receipt = request.actionProgress?.materialOutputs?.find(
      (entry) => entry.outputId === output.id,
    );
    const document = await loadPlanDocument(
      receipt?.documentId || materialDocumentId(request, output.id),
    );
    if (
      receipt &&
      (document?.contentHash !== receipt.contentHash ||
        document.documentVersion !== receipt.documentVersion)
    )
      continue;
    if (document?.conversationKey === request.conversationKey) return document;
  }
  return null;
}

/** Binds a save proposal to the material receipt and the frozen native parent. */
export async function resolveWorkflowNoteDocument(
  request: AgentRuntimeRequest,
  documentId: string,
  targetItemId?: number,
  mode: "create" | "edit" | "append" = "create",
): Promise<PlanDocument> {
  const progress = request.actionProgress;
  const receipt = progress?.materialOutputs?.find(
    (entry) => entry.documentId === documentId,
  );
  const obligation = request.actionContract?.obligations.find(
    (entry) =>
      entry.operation === `note_${mode}` &&
      entry.contentFrom === receipt?.outputId &&
      entry.targetBoundary?.frozenTargetIds.includes(targetItemId || 0),
  );
  if (
    !receipt ||
    !obligation ||
    progress?.contractId !== request.actionContract?.id
  )
    throw new Error(
      "The note must use the finalized workflow document and its exact authorized destination.",
    );
  const document = await loadPlanDocument(documentId);
  if (
    !document ||
    document.documentId !== documentId ||
    document.conversationKey !== request.conversationKey ||
    document.documentVersion !== receipt.documentVersion ||
    document.contentHash !== receipt.contentHash
  )
    throw new Error(
      "The finalized workflow document identity or content has changed.",
    );
  return document;
}
