import type {
  AgentActionContract,
  AgentActionIntent,
  AgentActionObligation,
  AgentActionProgressLedger,
  AgentActionProposal,
} from "./types";

/** Durable authored output, distinct from the action that eventually saves it. */
export type MaterialOutputIntent = {
  id: string;
  description: string;
  afterActions: number[];
  sourceActionIndexes: number[];
  requiredEvidence: "none" | "metadata" | "body";
};
export type MaterialOutputReceipt = {
  outputId: string;
  documentId: string;
  documentVersion: number;
  contentHash: string;
};
export function isActionIndexList(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every((index) => Number.isSafeInteger(index) && index >= 0) &&
    new Set(value).size === value.length
  );
}
export function validMaterialOutputs(
  value: unknown,
): value is MaterialOutputIntent[] {
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  return value.every((output) => {
    if (
      !output ||
      typeof output !== "object" ||
      typeof output.id !== "string" ||
      !output.id.trim() ||
      output.id.length > 100 ||
      ids.has(output.id) ||
      typeof output.description !== "string" ||
      !output.description.trim() ||
      !isActionIndexList(output.afterActions) ||
      !isActionIndexList(output.sourceActionIndexes) ||
      !["none", "metadata", "body"].includes(output.requiredEvidence)
    )
      return false;
    ids.add(output.id);
    return true;
  });
}
export function actionDependencies(
  action: Pick<AgentActionIntent, "dependsOn" | "destinationFrom">,
): number[] {
  return [
    ...new Set([
      ...(action.dependsOn || []),
      ...(action.destinationFrom === undefined ? [] : [action.destinationFrom]),
    ]),
  ];
}
/** Actions are supplied in dependency order; forward/self edges are malformed. */
export function validWorkflowDependencies(
  actions: readonly AgentActionIntent[],
  outputs: readonly MaterialOutputIntent[] = [],
): boolean {
  if (
    !outputs.every((output) =>
      [...output.afterActions, ...output.sourceActionIndexes].every(
        (index) => index < actions.length,
      ),
    )
  )
    return false;
  return actions.every((action, index) => {
    if (
      action.destinationFrom !== undefined &&
      (action.operation !== "move_to_collection" ||
        !Number.isSafeInteger(action.destinationFrom) ||
        action.destinationFrom < 0 ||
        actions[action.destinationFrom]?.operation !== "create_collection" ||
        action.parameters?.destinationCollectionId !== undefined)
    )
      return false;
    if (actionDependencies(action).some((dependency) => dependency >= index))
      return false;
    if (!action.contentFrom) return true;
    const output = outputs.find(
      (candidate) => candidate.id === action.contentFrom,
    );
    return Boolean(
      output &&
      output.afterActions.every((dependency) => dependency < index) &&
      ["note_create", "note_edit", "note_append", "file_write"].includes(
        action.operation,
      ),
    );
  });
}
export function obligationsForAction(
  contract: AgentActionContract,
  index: number,
): AgentActionObligation[] {
  return contract.obligations.filter(
    (obligation, position) =>
      (obligation.sourceActionIndex ?? position) === index,
  );
}
export function actionIsComplete(
  contract: AgentActionContract,
  progress: AgentActionProgressLedger | undefined,
  index: number,
): boolean {
  const obligations = obligationsForAction(contract, index);
  return Boolean(
    obligations.length &&
    progress?.contractId === contract.id &&
    obligations.every((obligation) =>
      progress.obligations.some(
        (entry) =>
          entry.obligationId === obligation.id &&
          ["fulfilled", "already_satisfied"].includes(entry.status),
      ),
    ),
  );
}
export function workflowDependencyIssue(
  contract: AgentActionContract,
  obligation: AgentActionObligation,
  proposal: AgentActionProposal,
  progress?: AgentActionProgressLedger,
): string | undefined {
  const pending = (obligation.dependsOn || []).filter(
    (index) => !actionIsComplete(contract, progress, index),
  );
  if (pending.length)
    return `Complete and verify prerequisite action(s) ${pending.join(", ")} before ${obligation.operation}.`;
  if (!obligation.contentFrom) return undefined;
  const material = progress?.materialOutputs?.find(
    (entry) => entry.outputId === obligation.contentFrom,
  );
  if (!material)
    return `Finalize the requested material '${obligation.contentFrom}' with submit_document before saving it.`;
  if (
    proposal.parameters?.documentId !== material.documentId ||
    proposal.parameters?.contentHash !== material.contentHash
  )
    return `Save the exact finalized document ${material.documentId}; reconstructed or substituted content cannot satisfy '${obligation.contentFrom}'.`;
  return undefined;
}
