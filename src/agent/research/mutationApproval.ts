import type { AgentActionContract } from "../contracts/types";
import type { PlanArtifact } from "../plans/types";
import { canonicalJson } from "../services/libraryMutation/canonicalJson";
import { sha256Text } from "../store/journalRecoveryBlobStore";
import {
  listPaperFindings,
  loadResearchJobForExecution,
  saveResearchMutationApprovalGrant,
} from "./store";
import type {
  PaperFinding,
  ResearchJob,
  ResearchMutationApprovalGrant,
} from "./types";

export async function researchMutationDigest(value: unknown): Promise<string> {
  return `sha256:${await sha256Text(canonicalJson(value))}`;
}

export async function computeResearchResultDigest(params: {
  job: ResearchJob;
  findings: readonly PaperFinding[];
  includeScopeLineage?: boolean;
}): Promise<string> {
  return researchMutationDigest({
    researchJobId: params.job.researchJobId,
    coverageStatus: params.job.coverageStatus,
    ...(params.includeScopeLineage !== false
      ? { scopeLineageDigest: params.job.scopeLineageDigest }
      : {}),
    findings: params.findings.map((finding) => ({
      findingId: finding.findingId,
      libraryID: finding.libraryID,
      itemKey: finding.itemKey,
      inclusionDecision: finding.inclusionDecision,
      sourceFingerprint: finding.sourceFingerprint,
    })),
  });
}

export async function computeResearchTargetSetDigest(params: {
  operations: readonly {
    capability: string;
    operation: string;
    parameters?: unknown;
    targets: readonly { libraryID: number; itemKey: string }[];
  }[];
  resolvedTargets: readonly {
    libraryID: number;
    itemKey: string;
    itemId: number;
  }[];
}): Promise<string> {
  return researchMutationDigest(params);
}

async function validateResearchMutationGrantInternal(params: {
  grant: ResearchMutationApprovalGrant;
  artifact: PlanArtifact;
}): Promise<AgentActionContract> {
  const { grant, artifact } = params;
  if (
    grant.status !== "approved" ||
    grant.planId !== artifact.planId ||
    grant.planRevision !== artifact.revision ||
    grant.conversationKey !== artifact.conversationKey ||
    grant.planDigest !== artifact.digest ||
    artifact.contract?.effects?.libraryMutation.approval !== "after_research"
  ) {
    throw new Error(
      "The research-selected mutation approval no longer matches the plan",
    );
  }
  const job = await loadResearchJobForExecution(grant.executionId);
  if (
    !job ||
    job.status !== "completed" ||
    !["complete", "complete_with_limitations"].includes(
      String(job.coverageStatus),
    )
  ) {
    throw new Error(
      "The research result behind the mutation approval is not terminal",
    );
  }
  if (
    grant.version >= 2 &&
    grant.scopeLineageDigest !== job.scopeLineageDigest
  ) {
    throw new Error(
      "The research scope lineage changed after mutation approval",
    );
  }
  const findings = await listPaperFindings(job.researchJobId);
  if (
    (await computeResearchResultDigest({
      job,
      findings,
      includeScopeLineage: grant.version >= 2,
    })) !== grant.researchResultDigest
  ) {
    throw new Error("Research findings changed after mutation approval");
  }
  const operations: Array<{
    capability: string;
    operation: string;
    parameters?: unknown;
    targets: Array<{ libraryID: number; itemKey: string }>;
  }> = [];
  const resolvedTargets: Array<{
    libraryID: number;
    itemKey: string;
    itemId: number;
  }> = [];
  for (const obligation of grant.actionContract.obligations) {
    const boundary = obligation.targetBoundary;
    if (!boundary?.frozenTargetIds.length) {
      throw new Error(
        "The approved mutation no longer has an exact target boundary",
      );
    }
    const targets = boundary.frozenTargetIds.map((itemId) => {
      const item = Zotero.Items.get(itemId);
      if (
        !item ||
        item.deleted ||
        Number(item.libraryID) !== boundary.libraryID ||
        !String(item.key || "").trim()
      ) {
        throw new Error(
          "A research-selected mutation target changed or disappeared",
        );
      }
      const target = {
        libraryID: boundary.libraryID,
        itemKey: String(item.key),
      };
      resolvedTargets.push({ ...target, itemId });
      return target;
    });
    operations.push({
      capability: obligation.capability,
      operation: obligation.operation,
      parameters: obligation.parameters,
      targets,
    });
  }
  if (
    (await computeResearchTargetSetDigest({ operations, resolvedTargets })) !==
    grant.targetSetDigest
  ) {
    throw new Error(
      "Research-selected mutation targets or parameters changed after approval",
    );
  }
  return grant.actionContract;
}

export async function validateResearchMutationGrant(params: {
  grant: ResearchMutationApprovalGrant;
  artifact: PlanArtifact;
}): Promise<AgentActionContract> {
  try {
    return await validateResearchMutationGrantInternal(params);
  } catch (error) {
    if (params.grant.status === "approved") {
      await saveResearchMutationApprovalGrant({
        ...params.grant,
        status: "invalidated",
        invalidatedAt: Date.now(),
      });
    }
    throw error;
  }
}
