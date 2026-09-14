import type { AgentRuntimeRequest } from "../types";
import type { AgentActionIntent } from "../contracts/types";
import type { MaterialOutputIntent } from "../contracts/workflowDependencies";
import type { SemanticDecisions } from "./semanticDecisions";

type Reuse = NonNullable<SemanticDecisions["workflowReuse"]>;
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

/** Expand explicit model references from immutable host evidence before decoding ordinary action contracts. */
export function expandWorkflowReferences(
  request: AgentRuntimeRequest,
  value: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!record(value) || !record(value.decisions)) return value;
  const actions = Array.isArray(value.actionIntents) ? value.actionIntents : [];
  const outputs = Array.isArray(value.decisions.materialOutputs)
    ? value.decisions.materialOutputs
    : [];
  if (
    !actions.some((action) => record(action) && "reuseAction" in action) &&
    !outputs.some((output) => record(output) && "reuseOutput" in output)
  )
    return value;
  const checkpoint = request.workflowCheckpoint;
  const supplied = value.decisions.workflowReuse;
  if (
    !checkpoint ||
    !record(supplied) ||
    supplied.contractId !== checkpoint.contract.id ||
    checkpoint.progress.contractId !== checkpoint.contract.id
  )
    throw new Error(
      "Saved-work references require the exact supplied workflowReuse.contractId.",
    );
  const priorActions = checkpoint.contract.intent?.actionIntents || [];
  const priorOutputs =
    checkpoint.contract.intent?.semantic?.materialOutputs || [];
  const reuse: Reuse = {
    contractId: checkpoint.contract.id,
    actions: [],
    outputs: [],
  };
  const addAction = (link: Reuse["actions"][number]) => {
    if (
      !Number.isSafeInteger(link.actionIndex) ||
      !Number.isSafeInteger(link.previousActionIndex) ||
      link.actionIndex < 0 ||
      link.actionIndex >= actions.length ||
      link.previousActionIndex < 0 ||
      !priorActions[link.previousActionIndex]
    )
      throw new Error("A saved action reference is out of range.");
    const existing = reuse.actions.find(
      (entry) =>
        entry.actionIndex === link.actionIndex ||
        entry.previousActionIndex === link.previousActionIndex,
    );
    if (
      existing &&
      (existing.actionIndex !== link.actionIndex ||
        existing.previousActionIndex !== link.previousActionIndex)
    )
      throw new Error("Saved action references must map one to one.");
    if (!existing) reuse.actions.push(link);
  };
  const addOutput = (link: Reuse["outputs"][number]) => {
    if (
      typeof link.outputId !== "string" ||
      !link.outputId ||
      !priorOutputs.some((output) => output.id === link.previousOutputId)
    )
      throw new Error("A saved output reference is unavailable.");
    const existing = reuse.outputs.find(
      (entry) =>
        entry.outputId === link.outputId ||
        entry.previousOutputId === link.previousOutputId,
    );
    if (
      existing &&
      (existing.outputId !== link.outputId ||
        existing.previousOutputId !== link.previousOutputId)
    )
      throw new Error("Saved output references must map one to one.");
    if (!existing) reuse.outputs.push(link);
  };
  // Reference nodes alone own the mapping. Other model-supplied mapping fields
  // cannot add, replace, or authorize reuse of a saved action or output.
  actions.forEach((action, index) => {
    if (!record(action) || !("reuseAction" in action)) return;
    if (Object.keys(action).length !== 1)
      throw new Error(
        "A reuseAction reference cannot also change the saved action. Define a new action for revised work.",
      );
    addAction({
      actionIndex: index,
      previousActionIndex: action.reuseAction as number,
    });
  });
  outputs.forEach((output) => {
    if (!record(output) || !("reuseOutput" in output)) return;
    if (Object.keys(output).some((key) => !["reuseOutput", "id"].includes(key)))
      throw new Error(
        "A reuseOutput reference cannot also revise its immutable material.",
      );
    addOutput({
      outputId: (output.id || output.reuseOutput) as string,
      previousOutputId: output.reuseOutput as string,
    });
  });
  const actionIndex = (previous: number) => {
    const link = reuse.actions.find(
      (entry) => entry.previousActionIndex === previous,
    );
    if (!link)
      throw new Error(
        `Include {reuseAction:${previous}} for the saved prerequisite or material source; verified progress prevents replay.`,
      );
    return link.actionIndex;
  };
  const outputId = (previous: string) => {
    const link = reuse.outputs.find(
      (entry) => entry.previousOutputId === previous,
    );
    if (!link)
      throw new Error(
        `Include {reuseOutput:${JSON.stringify(previous)}} for the saved material consumed by this action.`,
      );
    return link.outputId;
  };
  return {
    ...value,
    actionIntents: actions.map((action) => {
      if (!record(action) || !("reuseAction" in action)) return action;
      const saved: AgentActionIntent = JSON.parse(
        JSON.stringify(priorActions[action.reuseAction as number]),
      );
      if (saved.dependsOn) saved.dependsOn = saved.dependsOn.map(actionIndex);
      if (saved.destinationFrom !== undefined)
        saved.destinationFrom = actionIndex(saved.destinationFrom);
      if (saved.contentFrom) saved.contentFrom = outputId(saved.contentFrom);
      return saved;
    }),
    decisions: {
      ...value.decisions,
      workflowReuse: reuse,
      materialOutputs: outputs.map((output) => {
        if (!record(output) || !("reuseOutput" in output)) return output;
        const saved: MaterialOutputIntent = JSON.parse(
          JSON.stringify(
            priorOutputs.find((entry) => entry.id === output.reuseOutput),
          ),
        );
        return {
          ...saved,
          id: outputId(saved.id),
          afterActions: saved.afterActions.map(actionIndex),
          sourceActionIndexes: saved.sourceActionIndexes.map(actionIndex),
        };
      }),
    },
  };
}
