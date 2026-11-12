import type { ActionProposal } from "../../authorization/types";
import type {
  TaskPaperDecisionInput,
  TaskPaperDocumentCitation,
} from "../../context/taskPaperLedger";
import {
  readFlatMaterialRef,
  type MaterialRef,
} from "../../documents/materialRef";
import type {
  AgentActionEvidence,
  AgentActionProposal,
  AgentBatchItemOutcome,
  AgentInvocationPlan,
  AgentPendingAction,
  AgentToolArtifact,
  AgentToolCall,
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
      workCategory: "retrieval",
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
        // No invocation ran, so this rejection cannot report an action receipt.
        actionReceipts: [],
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

/**
 * The exact material version a confirmation would consume, read from the
 * frozen proposal the user is about to authorize. The host owns this stamp so
 * every confirmation card carries it, whichever tool built the card.
 */
export function pendingActionMaterial(
  proposals: readonly AgentActionProposal[] | undefined,
): AgentPendingAction["material"] | undefined {
  for (const proposal of proposals || []) {
    const ref = readFlatMaterialRef(proposal.parameters);
    if (ref) return { operation: proposal.operation, ref };
  }
  return undefined;
}

/**
 * A material reference read out of an untyped tool payload.
 *
 * Narrowing is all this adds; the completeness rule that decides whether the
 * three fields name one revision lives with the identity itself.
 */
function readMaterialRef(value: unknown): MaterialRef | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  return readFlatMaterialRef({
    documentId:
      typeof record.documentId === "string" ? record.documentId : undefined,
    documentVersion:
      typeof record.documentVersion === "number"
        ? record.documentVersion
        : undefined,
    contentHash:
      typeof record.contentHash === "string" ? record.contentHash : undefined,
  });
}

export function normalizeExecutionOutput(
  value: AgentToolExecutionOutput<any>,
): {
  content: unknown;
  artifacts?: AgentToolArtifact[];
  effect?: AgentToolEffect;
  actionEvidence?: AgentActionEvidence[];
  materialRef?: MaterialRef;
  materialKind?: string;
  materialTitle?: string;
  materialCitedSources?: TaskPaperDocumentCitation[];
  paperDecisions?: TaskPaperDecisionInput[];
  batchItems?: AgentBatchItemOutcome[];
} {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as {
      content?: unknown;
      artifacts?: unknown;
      effect?: unknown;
      actionEvidence?: unknown;
      materialRef?: unknown;
      materialKind?: unknown;
      materialTitle?: unknown;
      materialCitedSources?: unknown;
      paperDecisions?: unknown;
      batchItems?: unknown;
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
        materialRef: readMaterialRef(record.materialRef),
        materialKind:
          typeof record.materialKind === "string"
            ? record.materialKind
            : undefined,
        materialTitle:
          typeof record.materialTitle === "string"
            ? record.materialTitle
            : undefined,
        materialCitedSources: Array.isArray(record.materialCitedSources)
          ? (record.materialCitedSources as TaskPaperDocumentCitation[])
          : undefined,
        paperDecisions:
          Array.isArray(record.paperDecisions) && record.paperDecisions.length
            ? (record.paperDecisions as TaskPaperDecisionInput[])
            : undefined,
        batchItems: Array.isArray(record.batchItems)
          ? (record.batchItems as AgentBatchItemOutcome[])
          : undefined,
      };
    }
  }
  return {
    content: value,
  };
}
