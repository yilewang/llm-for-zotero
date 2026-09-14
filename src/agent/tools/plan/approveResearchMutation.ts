import { readOnlyInvocationPlan } from "../../authorization/invocationPlan";
import type {
  AgentActionCapability,
  AgentActionContract,
  AgentActionOperation,
  AgentActionParameters,
  AgentActionProgressLedger,
} from "../../contracts/types";
import { decodeActionContract } from "../../plans/contracts";
import { planExecutionCoordinator } from "../../plans/coordinator";
import { loadPlanArtifact } from "../../plans/store";
import {
  computeResearchResultDigest,
  computeResearchTargetSetDigest,
  researchMutationDigest,
} from "../../research/mutationApproval";
import { researchMutationAuthorization } from "../../research/mutationAuthorization";
import { commitResearchRecords } from "../../research/stages";
import {
  listPaperFindings,
  loadResearchJobForExecution,
  saveResearchMutationApprovalGrant,
} from "../../research/store";
import type { ResearchMutationApprovalGrant } from "../../research/types";
import type {
  AgentPendingAction,
  AgentToolDefinition,
  AgentToolInputValidation,
} from "../../types";
import { fail, ok, validateObject } from "../shared";

type StableItemTarget = { libraryID: number; itemKey: string };

type ResearchMutationOperationInput = {
  capability: AgentActionCapability;
  operation: AgentActionOperation;
  parameters?: AgentActionParameters;
  targets: StableItemTarget[];
};

type ApproveResearchMutationInput = {
  summary: string;
  operations: ResearchMutationOperationInput[];
};

const CAPABILITIES = new Set<AgentActionCapability>([
  "zotero.tags",
  "zotero.metadata",
  "zotero.collections",
  "zotero.notes",
  "zotero.import",
  "zotero.trash",
  "zotero.attachments",
  "zotero.annotations",
  "zotero.settings",
  "zotero.undo",
]);

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function validateInput(
  args: unknown,
): AgentToolInputValidation<ApproveResearchMutationInput> {
  try {
    if (!validateObject<Record<string, unknown>>(args)) {
      return fail("approve_research_mutation expects an object");
    }
    if (!Array.isArray(args.operations) || !args.operations.length) {
      return fail("approve_research_mutation requires operations[]");
    }
    const operations = args.operations.map((raw, operationIndex) => {
      if (!validateObject<Record<string, unknown>>(raw)) {
        throw new Error(`operations[${operationIndex}] must be an object`);
      }
      const capability = raw.capability as AgentActionCapability;
      if (!CAPABILITIES.has(capability)) {
        throw new Error(`operations[${operationIndex}].capability is invalid`);
      }
      const operation = string(
        raw.operation,
        `operations[${operationIndex}].operation`,
      ) as AgentActionOperation;
      if (!Array.isArray(raw.targets) || !raw.targets.length) {
        throw new Error(
          `operations[${operationIndex}].targets must not be empty`,
        );
      }
      const targets = raw.targets.map((target, targetIndex) => {
        if (!validateObject<Record<string, unknown>>(target)) {
          throw new Error(
            `operations[${operationIndex}].targets[${targetIndex}] must be an object`,
          );
        }
        if (
          !Number.isInteger(target.libraryID) ||
          Number(target.libraryID) < 1
        ) {
          throw new Error(
            `operations[${operationIndex}].targets[${targetIndex}].libraryID is invalid`,
          );
        }
        return {
          libraryID: Number(target.libraryID),
          itemKey: string(
            target.itemKey,
            `operations[${operationIndex}].targets[${targetIndex}].itemKey`,
          ),
        };
      });
      const identities = targets.map(
        (target) => `${target.libraryID}:${target.itemKey}`,
      );
      if (new Set(identities).size !== identities.length) {
        throw new Error(`operations[${operationIndex}] has duplicate targets`);
      }
      if (new Set(targets.map((target) => target.libraryID)).size !== 1) {
        throw new Error(
          `operations[${operationIndex}] targets must belong to one Zotero library`,
        );
      }
      const parameters = validateObject<Record<string, unknown>>(raw.parameters)
        ? decodeActionContract({
            version: 3,
            id: `research-mutation-preview-${operationIndex}`,
            writeDisposition: "required",
            interpretationSource: "deterministic_fallback",
            obligations: [
              {
                id: `preview-${operationIndex}`,
                capability,
                operation,
                proofDomain: "zotero_state",
                coverage: "all",
                targetKind: "papers",
                parameters: raw.parameters,
                targetBoundary: {
                  kind: "selection",
                  libraryID: targets[0].libraryID,
                  frozenTargetIds: [1],
                  scopeDigest: "preview",
                },
              },
            ],
          }).obligations[0].parameters
        : undefined;
      return {
        capability,
        operation,
        parameters,
        targets,
      };
    });
    return ok({
      summary: string(args.summary, "summary"),
      operations,
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

function pendingAction(
  input: ApproveResearchMutationInput,
): AgentPendingAction {
  const operations = input.operations.map((operation) => {
    const parameters = operation.parameters
      ? `\nParameters: ${JSON.stringify(operation.parameters)}`
      : "";
    const targets = operation.targets
      .map((target) => {
        const resolved = Zotero.Items.getByLibraryAndKey(
          target.libraryID,
          target.itemKey,
        );
        const item = resolved || null;
        const title = String(
          item?.getDisplayTitle?.() ||
            item?.getField?.("title") ||
            target.itemKey,
        ).trim();
        return `- ${title} [${target.libraryID}/${target.itemKey}]`;
      })
      .join("\n");
    return `${operation.operation} (${operation.capability})${parameters}\n${targets}`;
  });
  return {
    toolName: "approve_research_mutation",
    title: "Review research-selected library changes",
    description:
      `${input.summary}\n\nResearch identified the exact targets below. ` +
      "This approval authorizes only these operations and item keys.",
    confirmLabel: "Approve changes",
    cancelLabel: "Skip changes",
    fields: [
      {
        type: "text",
        id: "operations",
        label: "Exact operations and targets",
        value: operations.join("\n\n"),
      },
    ],
  };
}

function createProgress(
  contract: AgentActionContract,
): AgentActionProgressLedger {
  return {
    version: 1,
    contractId: contract.id,
    state: "pending",
    correctionCount: 0,
    obligations: contract.obligations.map((obligation) => ({
      obligationId: obligation.id,
      status: "open",
      verifiedTargetIds: [],
      unresolvedTargetIds:
        obligation.targetBoundary?.frozenTargetIds.map(String) || [],
      journalStepIds: [],
      failureReasons: [],
    })),
    appliedReceiptKeys: [],
    authorizationGrants: [],
    updatedAt: Date.now(),
  };
}

export function createApproveResearchMutationTool(): AgentToolDefinition<
  ApproveResearchMutationInput,
  unknown
> {
  return {
    spec: {
      name: "approve_research_mutation",
      description:
        "Present the mandatory second approval for research-selected Zotero writes. It freezes exact stable item keys, resolved runtime IDs, operations, and parameters into a new action contract. It does not itself change the library.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["summary", "operations"],
        properties: {
          summary: { type: "string" },
          operations: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["capability", "operation", "targets"],
              properties: {
                capability: { type: "string" },
                operation: { type: "string" },
                parameters: { type: "object", additionalProperties: true },
                targets: {
                  type: "array",
                  minItems: 1,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["libraryID", "itemKey"],
                    properties: {
                      libraryID: { type: "number" },
                      itemKey: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      executionClass: "control",
      requiresConfirmation: true,
      interaction: "user_input",
    },
    isAvailable: (request) => request.planContext?.phase === "executing",
    guidance: {
      matches: (request) => request.planContext?.phase === "executing",
      instruction:
        "If the approved contract declares effects.libraryMutation.approval='after_research', do not call any Zotero write tool until research is terminal and approve_research_mutation has frozen and authorized the exact operations and targets under central mode policy. Targets use stable libraryID/itemKey pairs from paper findings. After authorization, use only write calls covered by the returned frozen action contract. If the user skips the changes, mark only the mutation task skipped and preserve the research document.",
    },
    validate: validateInput,
    planInvocation: () =>
      readOnlyInvocationPlan({
        reason:
          "This confirmation records a plan decision without mutating Zotero.",
      }),
    shouldRequireConfirmation: async (input, context) => {
      const plan = context.request.planContext;
      if (plan?.phase !== "executing")
        throw new Error("Research mutation approval requires plan execution");
      const artifact = await loadPlanArtifact(plan.planId, plan.revision);
      const mutation = artifact?.contract?.effects?.libraryMutation;
      if (
        !artifact ||
        artifact.digest !== plan.approvedDigest ||
        mutation?.approval !== "after_research"
      )
        throw new Error(
          "The approved research mutation intent is unavailable.",
        );
      const decision = researchMutationAuthorization({
        context,
        intents: mutation.intent.intents,
        operations: input.operations,
      });
      if (decision.kind === "block") throw new Error(decision.reason);
      return decision.kind === "confirm";
    },
    createPendingAction: (input) => pendingAction(input),
    execute: async (input, context) => {
      const plan = context.request.planContext;
      if (!plan || plan.phase !== "executing") {
        throw new Error("Research mutation approval requires plan execution");
      }
      const artifact = await loadPlanArtifact(plan.planId, plan.revision);
      const mutation = artifact?.contract?.effects?.libraryMutation;
      if (
        !artifact ||
        artifact.digest !== plan.approvedDigest ||
        mutation?.approval !== "after_research"
      ) {
        throw new Error(
          "The approved plan does not contain a research-selected mutation intent",
        );
      }
      const job = await loadResearchJobForExecution(plan.executionId);
      if (
        !job ||
        job.status !== "completed" ||
        !["complete", "complete_with_limitations"].includes(
          String(job.coverageStatus),
        )
      ) {
        throw new Error(
          "Research-selected changes require terminal complete coverage",
        );
      }
      const allowedIntents = mutation.intent.intents;
      const decision = researchMutationAuthorization({
        context,
        intents: allowedIntents,
        operations: input.operations,
      });
      if (decision.kind === "block") throw new Error(decision.reason);
      if (decision.kind === "confirm" && context.executionAuthority !== "user")
        throw new Error(
          "These exact research-selected changes require review before granting authority.",
        );
      const findings = await listPaperFindings(job.researchJobId);
      const findingKeys = new Set(
        findings.map((entry) => `${entry.libraryID}:${entry.itemKey}`),
      );
      const obligations: AgentActionContract["obligations"] = [];
      const resultTargets: Array<{
        libraryID: number;
        itemKey: string;
        itemId: number;
      }> = [];
      for (let index = 0; index < input.operations.length; index += 1) {
        const operation = input.operations[index];
        const allowed = allowedIntents.some(
          (intent) =>
            intent.capability === operation.capability &&
            intent.operation === operation.operation,
        );
        if (!allowed) {
          throw new Error(
            `${operation.capability}/${operation.operation} was not declared in the approved mutation intent`,
          );
        }
        const libraries = new Set(
          operation.targets.map((target) => target.libraryID),
        );
        if (libraries.size !== 1) {
          throw new Error(
            "Each frozen mutation obligation must target one Zotero library",
          );
        }
        const frozenTargetIds: number[] = [];
        for (const target of operation.targets) {
          if (!findingKeys.has(`${target.libraryID}:${target.itemKey}`)) {
            throw new Error(
              `Mutation target ${target.libraryID}/${target.itemKey} lacks a persisted paper finding`,
            );
          }
          const item = Zotero.Items.getByLibraryAndKey(
            target.libraryID,
            target.itemKey,
          );
          if (!item || item.deleted) {
            throw new Error(
              `Mutation target ${target.libraryID}/${target.itemKey} is missing`,
            );
          }
          frozenTargetIds.push(item.id);
          resultTargets.push({ ...target, itemId: item.id });
        }
        const scopeDigest = await researchMutationDigest({
          capability: operation.capability,
          operation: operation.operation,
          parameters: operation.parameters,
          targets: operation.targets,
        });
        obligations.push({
          id: `research-mutation-${index + 1}`,
          capability: operation.capability,
          operation: operation.operation,
          proofDomain: "zotero_state",
          coverage: "all",
          targetKind: "papers",
          reviewPreference: allowedIntents.find(
            (intent) => intent.operation === operation.operation,
          )?.reviewPreference,
          parameters: operation.parameters,
          targetBoundary: {
            kind: "selection",
            libraryID: operation.targets[0].libraryID,
            frozenTargetIds,
            scopeDigest,
          },
        });
      }
      const researchResultDigest = await computeResearchResultDigest({
        job,
        findings,
      });
      const targetSetDigest = await computeResearchTargetSetDigest({
        operations: input.operations,
        resolvedTargets: resultTargets,
      });
      const contractId = `research-action:${plan.executionId}:${targetSetDigest.slice(-16)}`;
      const actionContract: AgentActionContract = {
        version: context.request.classifiedIntent?.semantic ? 4 : 3,
        intent: context.request.classifiedIntent?.semantic
          ? { ...context.request.classifiedIntent, actionIntents: obligations }
          : undefined,
        id: contractId,
        writeDisposition: "required",
        interpretationSource: "deterministic_fallback",
        obligations,
      };
      const approvedAt = Date.now();
      const grant: ResearchMutationApprovalGrant = {
        version: 3,
        authority:
          context.executionAuthority === "user"
            ? "user"
            : decision.kind === "execute" && decision.authority === "yolo"
              ? "yolo"
              : "auto_policy",
        grantId: `${contractId}:grant`,
        planId: artifact.planId,
        planRevision: artifact.revision,
        executionId: plan.executionId,
        conversationKey: artifact.conversationKey,
        planDigest: artifact.digest,
        researchResultDigest,
        scopeLineageDigest: job.scopeLineageDigest,
        targetSetDigest,
        actionContract,
        status: "approved",
        approvedAt,
      };
      await commitResearchRecords(job, async () => {
        await saveResearchMutationApprovalGrant(grant);
        await planExecutionCoordinator.bindResearchDerivedActionContract({
          executionId: plan.executionId,
          contract: actionContract,
          now: approvedAt,
          alreadyInTransaction: true,
        });
      });
      context.request.actionContract = actionContract;
      context.request.actionProgress = createProgress(actionContract);
      await context.checkpointActionProgress?.();
      return {
        approved: true,
        grantId: grant.grantId,
        researchResultDigest,
        targetSetDigest,
        actionContract,
        targets: resultTargets,
      };
    },
  };
}
