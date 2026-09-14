import type { ActionProposal } from "../../authorization/types";
import { createUnverifiedReceipt } from "../../contracts/actionEvaluation";
import type {
  AgentActionEvidence,
  AgentInvocationPlan,
  AgentToolArtifact,
  AgentToolCall,
  AgentToolContinuationCheckpoint,
  AgentToolDefinition,
  AgentToolEffect,
  AgentToolExecutionOutput,
  PreparedToolExecution,
} from "../../types";
export function invocationExpands(
  displayed: AgentInvocationPlan,
  candidate: AgentInvocationPlan,
): boolean {
  const impactRank = {
    read_only: 0,
    state_change: 1,
    ambiguous: 2,
    prohibited: 3,
  } as const;
  const assuranceRank = {
    runtime_enforced: 0,
    statically_recognized: 1,
    unknown: 2,
  } as const;
  const reversibilityRank = { full: 0, partial: 1, none: 2 } as const;
  const adds = <T>(before: readonly T[], after: readonly T[]) =>
    after.some((entry) => !before.includes(entry));
  return (
    impactRank[candidate.impact] > impactRank[displayed.impact] ||
    assuranceRank[candidate.assurance] > assuranceRank[displayed.assurance] ||
    reversibilityRank[candidate.reversibility] >
      reversibilityRank[displayed.reversibility] ||
    candidate.mechanism !== displayed.mechanism ||
    adds(displayed.domains, candidate.domains) ||
    adds(displayed.effects, candidate.effects) ||
    adds(displayed.targets, candidate.targets) ||
    adds(displayed.riskSignals, candidate.riskSignals)
  );
}

export function createSyntheticErrorResult(
  call: AgentToolCall,
  message: string,
  options: { inputRejected?: boolean } = {},
): PreparedToolExecution {
  const syntheticTool: AgentToolDefinition<any, any> = {
    spec: {
      name: call.name,
      description: message,
      inputSchema: { type: "object" },
      executionClass: "read",
      requiresConfirmation: false,
    },
    validate: () => ({ ok: true, value: {} }),
    execute: async () => ({ error: message }),
  };
  return {
    kind: "result",
    execution: {
      tool: syntheticTool,
      input: call.arguments,
      result: {
        callId: call.id,
        name: call.name,
        ok: false,
        ...(options.inputRejected ? { inputRejected: true as const } : {}),
        actionReceipts: [createUnverifiedReceipt({ reason: message })],
        content: { error: message },
      },
    },
  };
}

export function createRequestId(): string {
  return `confirm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createProposalConfirmationAction(
  proposal: ActionProposal,
): import("../../types").AgentPendingAction {
  return {
    toolName: proposal.toolName,
    title: `Review ${proposal.toolName.replace(/_/g, " ")}`,
    description: proposal.summary,
    confirmLabel: "Allow once",
    cancelLabel: "Cancel",
    fields: [
      {
        type: "text",
        id: "operation",
        label: "Operation",
        value: proposal.operation,
      },
      ...(proposal.targets.length
        ? [
            {
              type: "text" as const,
              id: "targets",
              label: "Exact targets",
              value: proposal.targets.join("\n"),
            },
          ]
        : []),
      ...(proposal.riskSignals.length
        ? [
            {
              type: "text" as const,
              id: "invocationRisks",
              label: "Risk signals",
              value: proposal.riskSignals.join(", "),
            },
          ]
        : []),
    ],
  };
}

export function normalizeExecutionOutput(
  value: AgentToolExecutionOutput<any>,
): {
  content: unknown;
  artifacts?: AgentToolArtifact[];
  effect?: AgentToolEffect;
  actionEvidence?: AgentActionEvidence[];
  continuationCheckpoint?: AgentToolContinuationCheckpoint;
} {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as {
      content?: unknown;
      artifacts?: unknown;
      effect?: unknown;
      actionEvidence?: unknown;
      continuationCheckpoint?: unknown;
    };
    if (Object.prototype.hasOwnProperty.call(record, "content")) {
      return {
        content: record.content,
        artifacts: Array.isArray(record.artifacts)
          ? (record.artifacts as AgentToolArtifact[])
          : undefined,
        effect:
          record.effect === "applied" ||
          record.effect === "partial" ||
          record.effect === "none"
            ? record.effect
            : undefined,
        actionEvidence: Array.isArray(record.actionEvidence)
          ? (record.actionEvidence as AgentActionEvidence[])
          : undefined,
        continuationCheckpoint:
          record.continuationCheckpoint &&
          typeof record.continuationCheckpoint === "object" &&
          !Array.isArray(record.continuationCheckpoint) &&
          typeof (record.continuationCheckpoint as Record<string, unknown>)
            .reason === "string" &&
          typeof (record.continuationCheckpoint as Record<string, unknown>)
            .instruction === "string"
            ? (record.continuationCheckpoint as AgentToolContinuationCheckpoint)
            : undefined,
      };
    }
  }
  return {
    content: value,
  };
}
