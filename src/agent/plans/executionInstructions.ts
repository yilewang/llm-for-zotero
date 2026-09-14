import { COVERAGE_DISCLOSURE_REQUIREMENT } from "../documents/draftValidation";
import type { PlanContract, PlanExecutionLedger } from "./types";
import { planRequiresModelTaskUpdates } from "./taskOwnership";

/**
 * The approved investigation is the only owner of reading guidance during
 * execution. The chat-turn reading rule and per-turn read budgets are not
 * rendered while a plan executes, so this text must be complete on its own.
 */
function buildInvestigationReadingGuidance(
  investigation: NonNullable<PlanContract["investigation"]>,
): string {
  const reviewMode = investigation.reviewMode || "narrative";
  const readingStrategy = investigation.readingStrategy || "adaptive";
  return [
    `Reading guidance (owned by the approved investigation): ${reviewMode} review, ${readingStrategy} reading, ${investigation.requiredEvidenceDepth} evidence depth.`,
    "The host reading manifest from research_update is the only reading instruction during execution. Each manifest entry carries the host tier and its readMode: core papers are read with paper_read mode 'overview' (host-sized text at the manifest's evidenceDepthTarget, which satisfies the required depth), supporting papers with mode 'targeted' and the suggested queries, peripheral papers with mode 'overview' bounded to suggestedMaxChars. Read one proposed group at a time and persist it as claim-based nodes with research_update record_papers before reading more. Use mode 'targeted' otherwise only to verify an edge or resolve an important uncertainty.",
    "No per-turn read budget applies and paperEvidenceProgress never asks you to stop reading; the host completes the reading task only when every manifest paper is durable. After that the loop runs links, verification, structure and writing phases: research_update next_work names the phase, the host-ranked candidates and the stop rule, and advance_phase moves on once the rule is met.",
  ].join(" ");
}

/** Shared provider handoff from the authoritative execution ledger. */
export function buildApprovedPlanExecutionInstructions(
  ledger: PlanExecutionLedger,
  approvedContract?: PlanContract | null,
): string {
  const taskProgressInstruction = planRequiresModelTaskUpdates(ledger)
    ? "The host has already started the first pending task and owns the full ledger. It automatically advances tasks verified by research_update or submit_document; never call task_update for tasks whose requirements are only verified_read, material_integrity, mutation_receipts, research_coverage, document_integrity, or document_published. For other active tasks, call task_update with only the task whose status changes, using its exact taskId, after its required evidence exists. The host automatically starts the next pending task. Do not rename, delete, reorder, or silently skip approved tasks."
    : "The host automatically advances these tasks from verified reads, mutation receipts, and finalized material. Bound operations run automatically when their prerequisites are complete. Do not call task_update for these tasks; continue with the active scholarly or document tool instead.";
  const deliverableLines = approvedContract
    ? approvedContract.deliverable.kind === "document"
      ? [
          "Approved document contract:",
          `- Exact title: ${approvedContract.deliverable.spec.title}`,
          `- Kind: ${approvedContract.deliverable.spec.kind}`,
          `- Required sections: ${approvedContract.deliverable.spec.requiredSections.join("; ")}`,
          `- References required: ${approvedContract.deliverable.spec.requiresReferences ? "yes" : "no"}`,
          `- ${
            approvedContract.deliverable.spec.requiresCoverageSection
              ? COVERAGE_DISCLOSURE_REQUIREMENT
              : "Coverage disclosure: not required."
          }`,
          `- Citation style: ${approvedContract.deliverable.spec.citationStyle.styleTitle} (${approvedContract.deliverable.spec.citationStyle.locale})`,
          "submit_document.title must match the exact approved title above.",
        ]
      : [`Approved deliverable: ${approvedContract.deliverable.kind}.`]
    : [];
  const readingGuidanceLines = approvedContract?.investigation
    ? [buildInvestigationReadingGuidance(approvedContract.investigation)]
    : [];
  return [
    "APPROVED PLAN EXECUTION:",
    `Plan identity: ${ledger.planId} revision ${ledger.revision}; execution ${ledger.executionId}.`,
    `Approved digest: ${ledger.planDigest}.`,
    "The host has already frozen and fingerprinted the approved base scope. The active research job owns its effective immutable snapshot. Do not re-enumerate it with library_search; research_update inventory_scope is authoritative. If a paper newly qualifies inside an expandable approved source, use amend_plan research_scope with its exact Zotero identity. Use amend_plan contract_revision for a changed question, source boundary, deliverable, operation, or parameters.",
    "Execute required tasks in order. Provider task status is only a request; the host accepts completion only from verified evidence.",
    ...ledger.tasks.map(
      (task, index) =>
        `${index + 1}. [${task.status}] taskId=${task.taskId}\n` +
        `   ${task.content}\n` +
        `   While active: ${task.activeForm}\n` +
        (task.materialOutputId
          ? `   Generate materialOutputId=${task.materialOutputId} with submit_document.\n`
          : "") +
        (task.actionIndexes
          ? `   Fulfill semantic actionIndexes=${JSON.stringify(task.actionIndexes)}.\n`
          : "") +
        `   Acceptance: ${task.acceptanceCriteria
          .map((criterion) =>
            typeof criterion === "string" ? criterion : criterion.description,
          )
          .join("; ")}`,
    ),
    ...deliverableLines,
    ...readingGuidanceLines,
    taskProgressInstruction,
    "Your final answer should answer the original request naturally. Do not expose plan IDs, execution IDs, task IDs, digests, or append a plan-status/checklist recap; the host renders progress separately.",
  ].join("\n");
}
