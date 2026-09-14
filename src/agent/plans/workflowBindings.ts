import {
  actionDependencies,
  isActionIndexList,
} from "../contracts/workflowDependencies";
import type { AgentActionContract } from "../contracts/types";
import type { PlanContract, PlanStep } from "./types";

/** Bind visible Plan steps to the already interpreted workflow, without reinterpreting text. */
export function validatePlanWorkflowBindings(
  contract: PlanContract,
  steps: readonly PlanStep[],
): void {
  const effect = contract.effects?.libraryMutation;
  const actions = effect?.approval === "initial" ? effect.contract : undefined;
  const outputs = actions?.intent?.semantic?.materialOutputs || [];
  const outputOwners = new Map<string, number>();
  const actionOwners = new Map<number, number>();
  steps.forEach((step, stepIndex) => {
    if (step.actionIndexes !== undefined) {
      if (!isActionIndexList(step.actionIndexes) || !step.actionIndexes.length)
        throw new Error("actionIndexes must be unique frozen action indexes");
      for (const index of step.actionIndexes) {
        const obligations =
          actions?.obligations.filter(
            (entry, position) =>
              (entry.sourceActionIndex ?? position) === index,
          ) || [];
        if (
          !obligations.length ||
          obligations.some(
            (entry) =>
              step.expectedEffect !==
              (entry.operation === "read_full" ? "read" : "mutation"),
          ) ||
          actionOwners.has(index)
        )
          throw new Error(
            "Each frozen action must have one matching Plan step owner",
          );
        actionOwners.set(index, stepIndex);
      }
    }
    if (step.materialOutputId) {
      if (
        outputOwners.has(step.materialOutputId) ||
        !outputs.some((output) => output.id === step.materialOutputId) ||
        step.expectedEffect !== "artifact" ||
        !step.completionRequirements?.some(
          (requirement) => requirement.kind === "material_integrity",
        )
      )
        throw new Error(
          "Each workflow material needs one artifact step with its exact materialOutputId and material_integrity verifier",
        );
      outputOwners.set(step.materialOutputId, stepIndex);
    }
    if (
      step.completionRequirements?.some(
        (requirement) => requirement.kind === "material_integrity",
      ) &&
      !step.materialOutputId
    )
      throw new Error(
        "material_integrity requires the frozen materialOutputId on its artifact step",
      );
  });
  if (outputs.some((output) => !outputOwners.has(output.id)))
    throw new Error(
      "Add an intermediate artifact step for each requested materialOutputId with verifier material_integrity, before its save action. Use completion_report for a workflow ending in a saved note or file.",
    );
  if (
    outputs.length &&
    steps.some(
      (step) =>
        step.expectedEffect === "mutation" && !step.actionIndexes?.length,
    )
  )
    throw new Error(
      "Bind each workflow mutation step using actionIndexes from the frozen semantic action list",
    );
  const interpreted = actions?.intent?.actionIntents || [];
  for (const [index, action] of interpreted.entries()) {
    const owner = actionOwners.get(index);
    if (
      outputs.length &&
      action.operation !== "read_full" &&
      owner === undefined
    )
      throw new Error(
        "Every requested workflow action needs an explicit Plan step owner",
      );
    if (owner === undefined) continue;
    for (const dependency of actionDependencies(action)) {
      const prerequisite = actionOwners.get(dependency);
      if (prerequisite === undefined || prerequisite > owner)
        throw new Error(
          "Plan action order violates a frozen workflow dependency",
        );
    }
    if (action.contentFrom) {
      const materialOwner = outputOwners.get(action.contentFrom);
      if (materialOwner === undefined || materialOwner >= owner)
        throw new Error(
          "The save dependency requires generating its exact material first",
        );
    }
  }
  for (const output of outputs) {
    for (const dependency of output.afterActions) {
      const prerequisite = actionOwners.get(dependency);
      if (
        prerequisite === undefined ||
        prerequisite >= outputOwners.get(output.id)!
      )
        throw new Error(
          "Material generation violates a frozen action dependency",
        );
    }
  }
}

export function planStepObligationIds(
  step: PlanStep,
  contract?: AgentActionContract,
): string[] {
  return (
    contract?.obligations
      .filter((obligation, index) =>
        step.actionIndexes
          ? step.actionIndexes.includes(obligation.sourceActionIndex ?? index)
          : step.expectedEffect ===
              (obligation.operation === "read_full" ? "read" : "mutation") &&
            (!step.expectedCapability ||
              obligation.capability === step.expectedCapability),
      )
      .map((entry) => entry.id) || []
  );
}
