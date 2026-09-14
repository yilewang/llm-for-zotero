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
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
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
    riskSignals: [...params.plan.riskSignals],
  };
  const canonical = JSON.stringify(
    stableValue({
      toolName: params.tool.spec.name,
      input: params.input,
      invocationPlan,
      operations,
      capabilities,
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
    summary: invocationPlan.reason,
    reversibility: invocationPlan.reversibility,
    riskSignals: [...invocationPlan.riskSignals],
    invocationPlan,
    intentBinding,
    payloadDigest: hashText(canonical),
  };
}
