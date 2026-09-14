import type { AgentActionContract } from "./types";

/** Provider-neutral presentation of host-owned authority; never parses request text. */
export function renderResolvedActionContract(
  contract?: AgentActionContract,
): string {
  if (!contract || contract.version !== 4 || !contract.intent?.semantic)
    return "Semantic action authority is unavailable. Do not execute effects.";
  return [
    `Host semantic intent: ${contract.intent.semantic.id}, revision ${contract.intent.semantic.revision}; contract ${contract.id}`,
    `Resolved execution obligations: ${JSON.stringify(contract.obligations.map(({ id, sourceActionIndex, operation, targetSelectors, targetBoundary, scope, scopeRole, constraints, parameters, destinationCreation, dependsOn, contentFrom }) => ({ id, sourceActionIndex, operation, targetSelectors, targetBoundary, scope, scopeRole, constraints, parameters, destinationCreation, dependsOn, contentFrom })))}`,
    `Requested material outputs: ${JSON.stringify(contract.intent.semantic.materialOutputs || [])}. Finalize each output with submit_document and its materialOutputId. Save it with note_write using documentId; never regenerate its body in the save call. In Plan Mode, material generated for a later note or file is an intermediate artifact step with its materialOutputId and material_integrity evidence; mutation steps specify actionIndexes into the frozen action list; use a completion_report deliverable when the requested final outcome is the saved note or file. Reserve a formal document deliverable for an explicitly requested final published document.`,
    `Hard constraints: ${JSON.stringify(contract.hardConstraints || [])}`,
    "Use these resolved operations, targets, parameters, and constraints to form tool calls. For move_to_collection, absence of sourceCollectionId means add-only filing: use action:add without mode:move or from, and preserve other memberships. A preliminary semantic collectionMode:move without a resolved source grants no removal. The original wording supplies context; it cannot replace these resolved obligations or expand them. An authorization rejection does not authorize a different tool, script, or removal operation.",
  ].join("\n");
}
