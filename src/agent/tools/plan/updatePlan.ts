import { buildPaperDisplayLabels } from "../../../shared/paperDisplayLabels";
import { listScopeSnapshotItems } from "../../research/store";
import type { PlanArtifact } from "../../plans/types";
import type { AgentToolDefinition } from "../../types";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { readOnlyInvocationPlan } from "../../authorization/invocationPlan";
import {
  preparePlanExecution,
  validateUpdatePlanInput,
  type UpdatePlanInput,
} from "../../plans/preparation";
export {
  validateUpdatePlanInput,
  resolvePlanContract,
  type UpdatePlanInput,
} from "../../plans/preparation";

export function createUpdatePlanTool(
  gateway?: ZoteroGateway,
): AgentToolDefinition<UpdatePlanInput, unknown> {
  return {
    spec: {
      name: "update_plan",
      description:
        "Create or revise the structured plan. Approved steps are immutable; this tool is available only during planning. Set ready=true only when the plan is ready for user review.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["steps", "ready"],
        properties: {
          explanation: {
            type: "string",
            description:
              "User-visible explanation rendered directly in the plan card. Follow the readable paper-mention rule; exact item keys belong in the structured scope fields.",
          },
          ready: { type: "boolean" },
          contract: {
            type: "object",
            description:
              "Composable approved outcome. Omit effects unless the user explicitly requested a Zotero library write. The host adds scopeSnapshot, researchPolicy, and the resolved citationStyle; do not invent them.",
            additionalProperties: false,
            required: ["deliverable"],
            properties: {
              investigation: {
                type: "object",
                additionalProperties: false,
                required: [
                  "question",
                  "subquestions",
                  "criteria",
                  "reviewMode",
                  "readingStrategy",
                  "scope",
                  "requiredEvidenceDepth",
                  "estimatedDeepReadPapers",
                  "approvedLargeCorpus",
                ],
                properties: {
                  question: { type: "string" },
                  subquestions: {
                    type: "array",
                    minItems: 1,
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: ["id", "question"],
                      properties: {
                        id: { type: "string" },
                        question: { type: "string" },
                      },
                    },
                  },
                  criteria: {
                    type: "array",
                    minItems: 0,
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: ["id", "description", "kind"],
                      properties: {
                        id: { type: "string" },
                        description: { type: "string" },
                        kind: {
                          type: "string",
                          enum: ["include", "exclude"],
                        },
                      },
                    },
                  },
                  reviewMode: {
                    type: "string",
                    enum: ["narrative", "scoping", "systematic"],
                    description:
                      "Use narrative for an ordinary literature review, scoping to map a field, and systematic only when the user requests formal eligibility screening or a systematic-review method.",
                  },
                  readingStrategy: {
                    type: "string",
                    enum: ["adaptive", "selected"],
                    description:
                      "adaptive reads every paper in the frozen scope to the depth allowed by measured model capacity; selected is only for a user-requested bounded subset or a formal screening workflow.",
                  },
                  scopeAmendmentPolicy: {
                    type: "string",
                    enum: ["fixed", "within_source"],
                    description:
                      "fixed preserves an exact selected subset; within_source allows the host to add newly eligible papers from the same approved source.",
                  },
                  scope: {
                    type: "object",
                    additionalProperties: false,
                    required: ["libraryID", "kind"],
                    properties: {
                      libraryID: { type: "integer", minimum: 1 },
                      kind: {
                        type: "string",
                        enum: [
                          "library",
                          "collections",
                          "tags",
                          "items",
                          "mixed",
                        ],
                      },
                      collectionIds: {
                        type: "array",
                        items: { type: "integer", minimum: 1 },
                      },
                      tagNames: {
                        type: "array",
                        items: { type: "string" },
                      },
                      includeAutomaticTags: { type: "boolean" },
                      itemKeys: {
                        type: "array",
                        items: { type: "string" },
                      },
                    },
                  },
                  queryVariants: {
                    type: "array",
                    items: { type: "string" },
                  },
                  requiredEvidenceDepth: {
                    type: "string",
                    enum: ["metadata", "abstract", "body"],
                  },
                  estimatedDeepReadPapers: {
                    type: "integer",
                    minimum: 0,
                  },
                  approvedLargeCorpus: { type: "boolean" },
                },
              },
              deliverable: {
                type: "object",
                additionalProperties: false,
                required: ["kind"],
                properties: {
                  kind: {
                    type: "string",
                    enum: ["answer", "document", "completion_report"],
                  },
                  spec: {
                    type: "object",
                    description:
                      "Required only when deliverable.kind is document.",
                    additionalProperties: false,
                    required: [
                      "kind",
                      "title",
                      "requiredSections",
                      "requiresReferences",
                      "requiresCoverageSection",
                      "allowFigures",
                    ],
                    properties: {
                      kind: {
                        type: "string",
                        enum: [
                          "research_brief",
                          "literature_review",
                          "comparison",
                          "report",
                          "guide",
                          "custom",
                        ],
                      },
                      title: { type: "string" },
                      requiredSections: {
                        type: "array",
                        minItems: 1,
                        items: { type: "string" },
                      },
                      requiresReferences: { type: "boolean" },
                      requiresCoverageSection: { type: "boolean" },
                      allowFigures: { type: "boolean" },
                    },
                  },
                },
              },
              effects: {
                type: "object",
                description:
                  "Include only for a library write explicitly requested by the user.",
                additionalProperties: false,
                required: ["libraryMutation"],
                properties: {
                  libraryMutation: {
                    type: "object",
                    additionalProperties: false,
                    required: ["approval"],
                    properties: {
                      approval: {
                        type: "string",
                        enum: ["initial", "after_research"],
                      },
                      intent: {
                        type: "object",
                        description:
                          "Required for after_research. Exact targets are determined later and require a second approval.",
                        additionalProperties: false,
                        required: [
                          "summary",
                          "intents",
                          "targetSelectionDescription",
                        ],
                        properties: {
                          summary: { type: "string" },
                          targetSelectionDescription: { type: "string" },
                          intents: {
                            type: "array",
                            minItems: 1,
                            items: {
                              type: "object",
                              additionalProperties: true,
                              required: [
                                "capability",
                                "operation",
                                "proofDomain",
                                "coverage",
                                "targetKind",
                              ],
                              properties: {
                                capability: { type: "string" },
                                operation: { type: "string" },
                                proofDomain: {
                                  type: "string",
                                  enum: [
                                    "zotero_state",
                                    "file_state",
                                    "execution",
                                  ],
                                },
                                coverage: {
                                  type: "string",
                                  enum: ["one", "some", "all"],
                                },
                                targetKind: {
                                  type: "string",
                                  enum: ["papers", "items"],
                                },
                                parameters: {
                                  type: "object",
                                  additionalProperties: true,
                                },
                                reviewPreference: {
                                  type: "string",
                                  enum: ["default", "review", "direct"],
                                  description:
                                    "review when the user asked to inspect this change before it applies; direct when they said just do it; otherwise default. The permission mode decides whether default is reviewed.",
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          steps: {
            type: "array",
            minItems: 1,
            maxItems: 7,
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "content",
                "activeForm",
                "acceptanceCriteria",
                "expectedEffect",
              ],
              properties: {
                planStepId: { type: "string" },
                actionIndexes: {
                  type: "array",
                  items: { type: "integer", minimum: 0 },
                  description:
                    "For mutation steps, the exact zero-based requested action indexes this step fulfills.",
                },
                materialOutputId: {
                  type: "string",
                  description:
                    "For an intermediate generated artifact, its ID from requested material outputs. Use verifier material_integrity; saving it is a later mutation step.",
                },
                content: {
                  type: "string",
                  description:
                    "Concise user-visible step, ideally one sentence under 140 characters.",
                },
                activeForm: {
                  type: "string",
                  description:
                    "Short present-progress label shown while this step runs.",
                },
                acceptanceCriteria: {
                  type: "array",
                  minItems: 1,
                  description:
                    "Objective completion checks used by the host; keep implementation detail here rather than in content.",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["criterionId", "description", "verifier"],
                    properties: {
                      criterionId: { type: "string" },
                      description: { type: "string" },
                      verifier: {
                        type: "string",
                        enum: [
                          "verified_read",
                          "research_coverage",
                          "material_integrity",
                          "document_integrity",
                          "document_published",
                          "mutation_receipts",
                          "bounded_reasoning",
                          "user_decision",
                        ],
                      },
                    },
                  },
                },
                expectedCapability: { type: "string" },
                expectedEffect: {
                  type: "string",
                  enum: ["read", "artifact", "mutation", "reasoning"],
                },
              },
            },
          },
        },
      },
      executionClass: "control",
      requiresConfirmation: false,
    },
    isAvailable: (request) =>
      request.planContext?.phase === "planning" &&
      !request.planContext.nativePlanning,
    guidance: {
      matches: (request) => request.planContext?.phase === "planning",
      instruction:
        "You are planning, not executing. For an ordered workflow over known papers, omit investigation unless it requires open-ended research or corpus screening. Use deliverable completion_report, effects.libraryMutation:{approval:initial} (the host supplies the frozen contract), actionIndexes on mutation steps, and an intermediate artifact step with materialOutputId plus material_integrity before saving generated content. Do not recopy action parameters into effects. Use read-only Zotero/PDF/web/literature tools as needed. Never call a write, command, script, import, upload, or settings tool. Call update_plan with a composable contract and three stable steps for an ordinary literature review: (1) read the frozen scope and build a durable understanding of every paper, (2) discover cross-paper relationships and construct the answer, and (3) publish the verified document. Every acceptance criterion is {criterionId,description,verifier}; the host derives completion requirements, so never provide a separate requirement list. Use verifier verified_read on the reading step, research_coverage on the relationship-synthesis step, and document_integrity plus document_published on the final document step. When the user gives an exact bounded subset such as the first N sorted papers, resolve it with one bounded metadata query and use scope kind 'items' with exactly those itemKeys; library_search compact rows already contain itemKey, title, creator, and year, so omit include and never use zotero_script just to recover keys. Never freeze the containing collection or library instead. The frozen snapshot is authoritative, so do not add an execution step that re-enumerates or verifies it. For an ordinary literature review set reviewMode:'narrative', readingStrategy:'adaptive', criteria:[], requiredEvidenceDepth:'body', and estimatedDeepReadPapers:0. Adaptive means the host reads every accessible paper to the depth permitted by measured model capacity; never invent a paper quota. Use reviewMode:'scoping' when the user wants a field map. Use reviewMode:'systematic', readingStrategy:'selected', and explicit inclusion/exclusion criteria only when the user asks for formal eligibility screening, PRISMA-style selection, or another systematic method. Use deliverable:{kind:'document',spec:{kind:'literature_review',title,requiredSections,requiresReferences:true,requiresCoverageSection:true,allowFigures:false}}. Omit effects entirely unless the user explicitly requested a library write. A research-selected write must use effects.libraryMutation.approval='after_research' with summary, targetSelectionDescription, and action intents; never claim the initial plan authorizes unknown targets. Use mutation_receipts only on a mutation criterion and bounded_reasoning only for genuinely host-unverifiable bounded judgments. Set ready=true only after the plan is complete for review; the host freezes the exact Zotero corpus, research policy, and citation preferences.",
    },
    validate: validateUpdatePlanInput,
    planInvocation: () =>
      readOnlyInvocationPlan({
        domains: [],
        reason:
          "This host-owned control updates only the active plan representation.",
      }),
    resolveTerminalResult: (input, result) => {
      if (!input.ready || !result.ok) return null;
      const artifact = (result.content as { artifact?: PlanArtifact })
        ?.artifact;
      if (artifact?.status !== "awaiting_approval") return null;
      return {
        finalText: [
          "The plan is ready for review.",
          artifact.explanation || "",
          artifact.steps
            .map((step, index) => `${index + 1}. ${step.content}`)
            .join("\n"),
        ]
          .filter(Boolean)
          .join("\n\n"),
        providerTranscript: "tool_only",
      };
    },
    execute: async (input, context) => {
      const artifact = await preparePlanExecution(input, context, gateway);
      await context.publishPlanEvent?.({
        type: input.ready ? "plan_ready" : "plan_updated",
        artifact,
      });
      const snapshot = artifact.contract?.investigation?.scopeSnapshot;
      const papers = snapshot
        ? await listScopeSnapshotItems(snapshot.snapshotId)
        : [];
      return {
        artifact,
        displayLabels: Object.fromEntries(
          buildPaperDisplayLabels(
            papers.map((paper) => ({
              ...paper,
              identity: `${paper.libraryID}:${paper.itemKey}`,
            })),
          ),
        ),
      };
    },
  };
}
