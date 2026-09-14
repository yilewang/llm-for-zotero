import { stateChangeInvocationPlan } from "../authorization/invocationPlan";
import { authorizeOriginalAction } from "../authorization/policy";
import type { ActionProposal } from "../authorization/types";
import type { AgentActionIntent } from "../contracts/types";
import { getOriginalAgentPermissionMode } from "../originalAgentPermissionMode";
import { canonicalJson } from "../services/libraryMutation/canonicalJson";
import type { AgentToolContext } from "../types";

export function researchMutationAuthorization(params: {
  context: AgentToolContext;
  intents: readonly AgentActionIntent[];
  operations: readonly {
    operation: string;
    capability: string;
    parameters?: unknown;
    targets: readonly { libraryID: number; itemKey: string }[];
  }[];
}) {
  const { context, intents, operations } = params;
  for (const operation of operations) {
    const matching = intents.filter(
      (intent) =>
        intent.operation === operation.operation &&
        intent.capability === operation.capability,
    );
    if (!matching.length)
      throw new Error(
        "The research-selected operation was not declared in the approved intent.",
      );
    if (
      !matching.some((intent) =>
        Object.entries(intent.parameters || {}).every(
          ([key, value]) =>
            canonicalJson(
              (operation.parameters as Record<string, unknown> | undefined)?.[
                key
              ],
            ) === canonicalJson(value),
        ),
      )
    )
      throw new Error(
        "The research-selected parameters differ from the values requested in the approved intent.",
      );
  }
  const applicable = intents.filter((intent) =>
    operations.some((operation) => operation.operation === intent.operation),
  );
  const review = applicable.some(
    (intent) => intent.reviewPreference === "review",
  );
  const plan = stateChangeInvocationPlan({
    domains: ["zotero_library"],
    effects: ["modify"],
    targets: operations.flatMap((operation) =>
      operation.targets.map(
        (target) => `${target.libraryID}:${target.itemKey}`,
      ),
    ),
    reversibility: "partial",
    reason: "Apply exact research-selected changes within the approved intent.",
  });
  const proposal: ActionProposal = {
    version: 2,
    runtime: "original",
    toolName: "approve_research_mutation",
    operation: operations.map((operation) => operation.operation).join("+"),
    capabilities: operations.map((operation) => operation.capability),
    domains: plan.domains,
    effects: plan.effects,
    targets: plan.targets,
    summary: plan.reason,
    reversibility: plan.reversibility,
    riskSignals: plan.riskSignals,
    invocationPlan: plan,
    intentBinding: { actionContractId: context.request.actionContract?.id },
    payloadDigest: canonicalJson(operations),
  };
  return authorizeOriginalAction(proposal, {
    mode: getOriginalAgentPermissionMode(),
    hasMatchingActionIntent: true,
    semantic: context.request.classifiedIntent?.semantic,
    constraints:
      context.request.actionContract?.hardConstraints?.filter(
        (entry): entry is import("../authorization/types").ActionConstraint =>
          entry.kind !== "no_write",
      ) || context.request.classifiedIntent?.semantic?.constraints,
    interaction: {
      entryPoint: context.request.actionEntryPoint || "conversation",
      reviewPreference: review ? "review" : "default",
    },
  });
}
