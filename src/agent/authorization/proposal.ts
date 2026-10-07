import { fnv1a32 } from "../../utils/fnv1a";
import type {
  AgentActionProposal,
  AgentInvocationPlan,
  AgentToolDefinition,
} from "../types";
import type { ActionProposal } from "./types";

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

function hashText(value: string): string {
  return `fnv1a:${fnv1a32(value)}`;
}

export function buildActionCallDigest(
  toolName: string,
  input: unknown,
): string {
  return hashText(JSON.stringify(stableValue({ toolName, input })));
}

/**
 * Convert the authoritative invocation plan into a durable proposal.
 *
 * Safety fields are copied verbatim. Typed action descriptors contribute only
 * operation and capability identity; they never reinterpret impact or risk.
 */
export function buildActionProposal(params: {
  tool: AgentToolDefinition<any, any>;
  input: unknown;
  plan: AgentInvocationPlan;
  typedProposals?: readonly AgentActionProposal[];
  targetLibraryIDs?: readonly number[];
  intentBinding?: {
    conversationKey?: number;
    conversationGeneration?: number;
    actionContractId?: string;
    userText?: string;
  };
}): ActionProposal {
  const typedProposals = params.typedProposals || [];
  const operations = [
    ...new Set(typedProposals.map((entry) => entry.operation)),
  ];
  const capabilities = [
    ...new Set(typedProposals.map((entry) => entry.capability)),
  ];
  const riskSignals = [
    ...new Set([
      ...params.plan.riskSignals,
      ...(typedProposals.some(
        (entry) =>
          entry.operation === "move_to_collection" &&
          entry.parameters?.sourceCollectionId === "all",
      )
        ? (["exclusive_replacement"] as const)
        : []),
    ]),
  ];
  const intentBinding = {
    conversationKey: params.intentBinding?.conversationKey,
    conversationGeneration: params.intentBinding?.conversationGeneration,
    actionContractId: params.intentBinding?.actionContractId,
    userIntentDigest: params.intentBinding?.userText
      ? hashText(params.intentBinding.userText)
      : undefined,
  };
  const invocationPlan: AgentInvocationPlan = {
    ...params.plan,
    domains: [...params.plan.domains],
    effects: [...params.plan.effects],
    targets: [...params.plan.targets],
    riskSignals,
  };
  const canonical = JSON.stringify(
    stableValue({
      toolName: params.tool.spec.name,
      input: params.input,
      invocationPlan,
      operations,
      capabilities,
      targetLibraryIDs: [...new Set(params.targetLibraryIDs || [])].sort(
        (left, right) => left - right,
      ),
      typedProposals,
      intentBinding,
    }),
  );
  return {
    version: 2,
    runtime: "original",
    toolName: params.tool.spec.name,
    operation: operations.length
      ? operations.join("+")
      : `${params.tool.spec.name}:${invocationPlan.impact}`,
    capabilities,
    domains: [...invocationPlan.domains],
    effects: [...invocationPlan.effects],
    targets: [...invocationPlan.targets],
    targetLibraryIDs: [...new Set(params.targetLibraryIDs || [])].sort(
      (left, right) => left - right,
    ),
    summary: invocationPlan.reason,
    reversibility: invocationPlan.reversibility,
    riskSignals,
    invocationPlan,
    intentBinding,
    payloadDigest: hashText(canonical),
  };
}
