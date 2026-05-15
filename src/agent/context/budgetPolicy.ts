import {
  estimateContextMessagesTokens,
  resolveContextWindowTokens,
  type ContextEstimateMessage,
} from "../../utils/modelInputCap";

export type AgentContextBudgetPolicy = {
  warningRatio: number;
  compactRatio: number;
  hardRatio: number;
  targetRatio: number;
  recentTailRatio: number;
  summaryRatio: number;
  evidenceRatio: number;
  hysteresisRatio: number;
  minRecentMessages: number;
};

export type AgentContextBudgetState = {
  policy: AgentContextBudgetPolicy;
  contextTokens: number;
  contextWindow: number;
  ratio: number;
  warning: boolean;
  shouldCompact: boolean;
  hardLimit: boolean;
  targetTokens: number;
  recentTailTokens: number;
  summaryTokens: number;
  evidenceTokens: number;
};

const DEFAULT_POLICY: AgentContextBudgetPolicy = {
  warningRatio: 0.72,
  compactRatio: 0.84,
  hardRatio: 0.92,
  targetRatio: 0.58,
  recentTailRatio: 0.18,
  summaryRatio: 0.08,
  evidenceRatio: 0.12,
  hysteresisRatio: 0.08,
  minRecentMessages: 4,
};

function clampRatio(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) return fallback;
  return value;
}

export function resolveAgentContextBudgetPolicy(
  overrides: Partial<AgentContextBudgetPolicy> = {},
): AgentContextBudgetPolicy {
  const policy = {
    ...DEFAULT_POLICY,
    ...overrides,
  };
  const warningRatio = clampRatio(
    policy.warningRatio,
    DEFAULT_POLICY.warningRatio,
  );
  const compactRatio = Math.max(
    warningRatio + 0.01,
    clampRatio(policy.compactRatio, DEFAULT_POLICY.compactRatio),
  );
  const hardRatio = Math.max(
    compactRatio + 0.01,
    clampRatio(policy.hardRatio, DEFAULT_POLICY.hardRatio),
  );
  const targetRatio = Math.min(
    compactRatio - 0.01,
    clampRatio(policy.targetRatio, DEFAULT_POLICY.targetRatio),
  );
  return {
    ...policy,
    warningRatio,
    compactRatio: Math.min(0.98, compactRatio),
    hardRatio: Math.min(0.99, hardRatio),
    targetRatio: Math.max(0.1, targetRatio),
    recentTailRatio: clampRatio(
      policy.recentTailRatio,
      DEFAULT_POLICY.recentTailRatio,
    ),
    summaryRatio: clampRatio(policy.summaryRatio, DEFAULT_POLICY.summaryRatio),
    evidenceRatio: clampRatio(
      policy.evidenceRatio,
      DEFAULT_POLICY.evidenceRatio,
    ),
    hysteresisRatio: clampRatio(
      policy.hysteresisRatio,
      DEFAULT_POLICY.hysteresisRatio,
    ),
    minRecentMessages: Math.max(1, Math.floor(policy.minRecentMessages || 1)),
  };
}

export function buildAgentContextBudgetState(params: {
  messages: ContextEstimateMessage[];
  model?: string;
  inputTokenCap?: number;
  policy?: Partial<AgentContextBudgetPolicy>;
  forceCompact?: boolean;
  recentlyCompacted?: boolean;
}): AgentContextBudgetState {
  const policy = resolveAgentContextBudgetPolicy(params.policy);
  const contextWindow = resolveContextWindowTokens(
    params.model || "",
    params.inputTokenCap,
  );
  const contextTokens = estimateContextMessagesTokens(params.messages);
  const ratio = contextWindow > 0 ? contextTokens / contextWindow : 0;
  const compactThreshold = params.recentlyCompacted
    ? policy.compactRatio + policy.hysteresisRatio
    : policy.compactRatio;
  const shouldCompact =
    params.forceCompact === true || ratio >= compactThreshold;
  return {
    policy,
    contextTokens,
    contextWindow,
    ratio,
    warning: ratio >= policy.warningRatio,
    shouldCompact,
    hardLimit: ratio >= policy.hardRatio,
    targetTokens: Math.max(1, Math.floor(contextWindow * policy.targetRatio)),
    recentTailTokens: Math.max(
      1,
      Math.floor(contextWindow * policy.recentTailRatio),
    ),
    summaryTokens: Math.max(1, Math.floor(contextWindow * policy.summaryRatio)),
    evidenceTokens: Math.max(
      1,
      Math.floor(contextWindow * policy.evidenceRatio),
    ),
  };
}
