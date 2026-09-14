import type { AgentActionContract } from "../contracts/types";
import type { PlanContract, PlanStep } from "./types";
import { decodeActionContract, decodePlanContract } from "./contracts";
import { decodePlanStep } from "./decoders";

export type PlanAmendmentKind =
  | "research_ceiling"
  | "research_scope"
  | "action_scope"
  | "contract_revision";

export type PlanAmendmentGoalImpact =
  | "deep_read"
  | "within_goal"
  | "contract_revision";

export type PlanAmendmentAuthority = "user" | "auto_policy" | "yolo";

export type PlanAmendmentTarget = Readonly<{
  libraryID: number;
  itemKey: string;
  localItemId?: number;
}>;

export type PlanAmendmentProposal = Readonly<{
  version: 1;
  amendmentId: string;
  proposalDigest: string;
  kind: PlanAmendmentKind;
  goalImpact: PlanAmendmentGoalImpact;
  planId: string;
  planRevision: number;
  planDigest: string;
  executionId: string;
  executionDigest: string;
  conversationKey: number;
  previousScopeDigest: string;
  resultingScopeDigest: string;
  targetSetDigest: string;
  proposalPayloadDigest: string;
  addedTargets?: readonly PlanAmendmentTarget[];
  addedActionTargets?: readonly string[];
  proposedDeepReadCeiling?: number;
  replacementContract?: PlanContract;
  replacementSteps?: readonly PlanStep[];
  replacementActionContract?: AgentActionContract;
  rationale: string;
  createdAt: number;
}>;

export type PlanAmendmentGrant = Readonly<{
  version: 1;
  grantId: string;
  proposal: PlanAmendmentProposal;
  authority: PlanAmendmentAuthority;
  status: "authorized" | "applied" | "failed" | "superseded";
  authorizedAt: number;
  appliedAt?: number;
  failedAt?: number;
  failureReason?: string;
}>;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a number`);
  }
  return value;
}

export function decodePlanAmendmentProposal(
  value: unknown,
): PlanAmendmentProposal {
  const proposal = object(value, "Plan amendment proposal");
  if (proposal.version !== 1) {
    throw new Error("Plan amendment proposal version is invalid");
  }
  if (
    ![
      "research_ceiling",
      "research_scope",
      "action_scope",
      "contract_revision",
    ].includes(String(proposal.kind)) ||
    !["deep_read", "within_goal", "contract_revision"].includes(
      String(proposal.goalImpact),
    )
  ) {
    throw new Error("Plan amendment proposal classification is invalid");
  }
  for (const key of [
    "amendmentId",
    "proposalDigest",
    "planId",
    "planDigest",
    "executionId",
    "executionDigest",
    "previousScopeDigest",
    "resultingScopeDigest",
    "targetSetDigest",
    "proposalPayloadDigest",
    "rationale",
  ]) {
    requiredString(proposal[key], `Plan amendment proposal ${key}`);
  }
  if (
    !Number.isInteger(proposal.planRevision) ||
    Number(proposal.planRevision) < 1 ||
    !Number.isInteger(proposal.conversationKey) ||
    Number(proposal.conversationKey) < 1
  ) {
    throw new Error("Plan amendment proposal identity is invalid");
  }
  requiredNumber(proposal.createdAt, "Plan amendment proposal createdAt");

  if (proposal.kind === "research_ceiling") {
    if (
      proposal.goalImpact !== "deep_read" ||
      !Number.isInteger(proposal.proposedDeepReadCeiling) ||
      Number(proposal.proposedDeepReadCeiling) < 1
    ) {
      throw new Error("research_ceiling proposal payload is invalid");
    }
  } else if (proposal.kind === "research_scope") {
    if (
      proposal.goalImpact !== "within_goal" ||
      !Array.isArray(proposal.addedTargets) ||
      !proposal.addedTargets.length
    ) {
      throw new Error("research_scope proposal addedTargets are required");
    }
    for (let index = 0; index < proposal.addedTargets.length; index += 1) {
      const target = object(
        proposal.addedTargets[index],
        `research_scope proposal addedTargets[${index}]`,
      );
      if (!Number.isInteger(target.libraryID) || Number(target.libraryID) < 1) {
        throw new Error(
          `research_scope proposal addedTargets[${index}].libraryID is invalid`,
        );
      }
      requiredString(
        target.itemKey,
        `research_scope proposal addedTargets[${index}].itemKey`,
      );
      if (
        target.localItemId !== undefined &&
        (!Number.isInteger(target.localItemId) ||
          Number(target.localItemId) < 1)
      ) {
        throw new Error(
          `research_scope proposal addedTargets[${index}].localItemId is invalid`,
        );
      }
    }
  } else if (proposal.kind === "action_scope") {
    if (
      proposal.goalImpact !== "within_goal" ||
      !Array.isArray(proposal.addedActionTargets) ||
      !proposal.addedActionTargets.length
    ) {
      throw new Error("action_scope proposal addedActionTargets are required");
    }
    proposal.addedActionTargets.forEach((target, index) =>
      requiredString(
        target,
        `action_scope proposal addedActionTargets[${index}]`,
      ),
    );
  } else if (
    proposal.kind !== "contract_revision" ||
    proposal.goalImpact !== "contract_revision" ||
    !proposal.replacementContract ||
    typeof proposal.replacementContract !== "object" ||
    Array.isArray(proposal.replacementContract) ||
    !Array.isArray(proposal.replacementSteps) ||
    !proposal.replacementSteps.length
  ) {
    throw new Error("contract_revision proposal payload is invalid");
  } else {
    decodePlanContract(proposal.replacementContract, {
      requireSnapshot: true,
    });
    proposal.replacementSteps.forEach((step, index) =>
      decodePlanStep(step, index, true),
    );
    if (proposal.replacementActionContract !== undefined) {
      decodeActionContract(proposal.replacementActionContract);
    }
  }

  return value as PlanAmendmentProposal;
}

export function decodePlanAmendmentGrant(value: unknown): PlanAmendmentGrant {
  const input = object(value, "Plan amendment grant");
  if (input.version !== 1) {
    throw new Error("Plan amendment grant version is invalid");
  }
  requiredString(input.grantId, "Plan amendment grant grantId");
  decodePlanAmendmentProposal(input.proposal);
  if (!["user", "auto_policy", "yolo"].includes(String(input.authority))) {
    throw new Error("Plan amendment authority is invalid");
  }
  if (
    !["authorized", "applied", "failed", "superseded"].includes(
      String(input.status),
    )
  ) {
    throw new Error("Plan amendment status is invalid");
  }
  requiredNumber(input.authorizedAt, "Plan amendment grant authorizedAt");
  if (input.appliedAt !== undefined) {
    requiredNumber(input.appliedAt, "Plan amendment grant appliedAt");
  }
  if (input.failedAt !== undefined) {
    requiredNumber(input.failedAt, "Plan amendment grant failedAt");
  }
  if (
    input.failureReason !== undefined &&
    typeof input.failureReason !== "string"
  ) {
    throw new Error("Plan amendment grant failureReason is invalid");
  }
  return value as PlanAmendmentGrant;
}
