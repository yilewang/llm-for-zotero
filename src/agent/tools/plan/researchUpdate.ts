import { readOnlyInvocationPlan } from "../../authorization/invocationPlan";
import {
  validateResearchUpdate,
  type ResearchUpdateInput,
} from "../../research/commands";
import { executeResearchUpdate } from "../../research/execution";
import {
  RESEARCH_CLAIM_KINDS,
  RESEARCH_EDGE_TYPES,
  RESEARCH_PAPER_TIERS,
} from "../../research/graphSchema";
import { RESEARCH_STAGES as STAGES } from "../../research/policy";
import { NARRATIVE_ROLES } from "../../research/recordValidation";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import type { AgentToolDefinition } from "../../types";
export {
  resolveTrustedPdfLocator,
  selectPreferredReadingAttachment,
  selectPreferredVerifiedReads,
} from "../../research/reading";
export {
  getTerminalScreeningDecisionError,
  isCriterionCompleteScreeningDecision,
} from "../../research/recordValidation";
export function createResearchUpdateTool(
  gateway: ZoteroGateway,
): AgentToolDefinition<ResearchUpdateInput, unknown> {
  return {
    spec: {
      name: "research_update",
      description:
        "Persist normalized per-paper research decisions, evidence provenance, findings, theme reductions, progress, and terminal coverage for the approved frozen corpus. This does not mutate the Zotero library.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["operation"],
        properties: {
          operation: {
            type: "string",
            enum: [
              "record_papers",
              "inventory_scope",
              "next_screen_batch",
              "list_verified_reads",
              "list_findings",
              "list_themes",
              "record_probes",
              "record_themes",
              "set_stage",
              "finalize",
              "set_frame",
              "set_tiers",
              "record_edges",
              "update_edges",
              "record_questions",
              "resolve_questions",
              "advance_phase",
              "next_work",
              "list_graph",
            ],
          },
          view: {
            type: "string",
            enum: ["compact", "full"],
            description:
              "list_findings view. compact (default once a frame exists) returns every node with frame slots, claim ids and candidate links for the link pass.",
          },
          phase: {
            type: "string",
            enum: ["links", "verification", "structure", "writing"],
            description:
              "advance_phase: the next loop phase. The host enforces the stop rule of each transition and names the blockers.",
          },
          edges: {
            type: "array",
            minItems: 1,
            description:
              "record_edges: typed relationships between two durable nodes (source, target, type, statement, confidence, sourceClaimIds, targetClaimIds, optional edgeKey). update_edges: decisions on existing edges (edgeId, status verified|refuted|tentative|merged|candidate, note, mergedInto, optional statement/confidence). verified and refuted need a targeted read of the pair after the edge was recorded; tentative needs a note.",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                edgeId: { type: "string" },
                edgeKey: { type: "string" },
                source: { type: "string" },
                target: { type: "string" },
                type: { type: "string", enum: RESEARCH_EDGE_TYPES },
                statement: { type: "string" },
                confidence: { type: "string", enum: ["low", "medium", "high"] },
                sourceClaimIds: { type: "array", items: { type: "string" } },
                targetClaimIds: { type: "array", items: { type: "string" } },
                requiresVerification: { type: "boolean" },
                status: {
                  type: "string",
                  enum: [
                    "candidate",
                    "verified",
                    "refuted",
                    "tentative",
                    "merged",
                  ],
                },
                note: { type: "string" },
                mergedInto: { type: "string" },
              },
            },
          },
          questions: {
            type: "array",
            minItems: 1,
            description:
              "record_questions: open questions the corpus raises (text, scope {kind: subquestion|edge|node|corpus, ref}, priority 1-3). resolve_questions: questionId, status answered|abandoned, resolution, optional evidenceRefs.",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                questionId: { type: "string" },
                text: { type: "string" },
                scope: {
                  type: "object",
                  additionalProperties: false,
                  required: ["kind"],
                  properties: {
                    kind: {
                      type: "string",
                      enum: ["subquestion", "edge", "node", "corpus"],
                    },
                    ref: { type: "string" },
                  },
                },
                priority: { type: "integer", minimum: 1, maximum: 3 },
                status: { type: "string", enum: ["answered", "abandoned"] },
                resolution: { type: "string" },
                evidenceRefs: { type: "array", items: { type: "string" } },
              },
            },
          },
          stage: { type: "string", enum: STAGES },
          slots: {
            type: "array",
            minItems: 1,
            description:
              "set_frame: the complete comparison frame. Identity slots (question, approach, system) are fixed; add or re-describe comparison slots before the link pass. A slot a recorded node fills cannot be removed.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["slotId", "name", "description", "kind"],
              properties: {
                slotId: { type: "string" },
                name: { type: "string" },
                description: { type: "string" },
                kind: { type: "string", enum: ["identity", "comparison"] },
              },
            },
          },
          tiers: {
            type: "array",
            minItems: 1,
            description:
              "set_tiers: confirm or override host-proposed tiers. An override needs a reason; when tiering is mandatory the core count stays within nodeCapacity.fullNodeCapacity.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["identity", "tier"],
              properties: {
                identity: {
                  type: "string",
                  description: "Corpus identity such as 1:ABCD1234",
                },
                tier: { type: "string", enum: RESEARCH_PAPER_TIERS },
                reason: { type: "string" },
              },
            },
          },
          cursor: {
            type: "integer",
            minimum: 0,
            description:
              "Zero-based cursor returned by list_findings. Omit for the first page.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 25,
            description: "Page size for list_findings; defaults to 20.",
          },
          papers: {
            type: "array",
            minItems: 1,
            description:
              "Durable paper understandings for any capacity-sized reading group. For adaptive narrative reviews provide the paper identities and rich findings; the host derives descriptive status, criterion fields, and trusted evidence references. Systematic reviews also provide screeningStatus and criterionResults.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["libraryID", "itemKey"],
              properties: {
                libraryID: { type: "integer", minimum: 1 },
                itemKey: { type: "string" },
                screeningStatus: {
                  type: "string",
                  description:
                    "candidate is provisional for deep reading; included means selected for the evidence synthesis and must meet requiredEvidenceDepth; excluded means screened and not selected for deep reading, but the paper remains in frozen coverage.",
                  enum: [
                    "pending",
                    "candidate",
                    "included",
                    "excluded",
                    "unresolved",
                    "unreadable",
                    "missing",
                  ],
                },
                criterionResults: {
                  type: "object",
                  description:
                    'Map every approved criterion ID to met, not_met, or unknown. Criterion kind controls the direction: an included paper has every include criterion="met" and every exclude criterion="not_met". An excluded paper has an include criterion="not_met" or an exclude criterion="met"; a reasoned relative exclusion may satisfy all absolute criteria when only a bounded subset will be deep-read.',
                  additionalProperties: {
                    type: "string",
                    enum: ["met", "not_met", "unknown"],
                  },
                },
                decisionReason: { type: "string" },
                finding: {
                  type: "object",
                  additionalProperties: false,
                  description:
                    "The paper's tailored understanding. Adaptive reviews record a claim-based node: frameSlots (every slot of the host frame for a core paper, identity slots for others), claims[] bound to evidence no deeper than the verified read, hooks, and either candidateLinks[] to other corpus papers or noLinkSeen with a reason. Legacy fields (researchQuestion, method, findings, limitations, mechanisms) are derived from the frame and claims when omitted.",
                  required: ["mainMessage", "relevance", "confidence"],
                  properties: {
                    tier: {
                      type: "string",
                      enum: RESEARCH_PAPER_TIERS,
                      description:
                        "Revise the host-proposed tier only with a reason in relevance; core needs at least three claims and every frame slot.",
                    },
                    frameSlots: {
                      type: "object",
                      description:
                        "slotId -> text for the host comparison frame; write not_reported when the paper is silent.",
                      additionalProperties: { type: "string" },
                    },
                    claims: {
                      type: "array",
                      minItems: 1,
                      items: {
                        type: "object",
                        additionalProperties: false,
                        required: [
                          "statement",
                          "kind",
                          "subquestionIds",
                          "evidence",
                        ],
                        properties: {
                          claimId: { type: "string" },
                          statement: { type: "string" },
                          kind: { type: "string", enum: RESEARCH_CLAIM_KINDS },
                          subquestionIds: {
                            type: "array",
                            items: { type: "string" },
                          },
                          evidence: {
                            type: "object",
                            additionalProperties: false,
                            required: ["sourceKind"],
                            properties: {
                              sourceKind: {
                                type: "string",
                                enum: ["body", "abstract", "metadata"],
                              },
                              pageIndex: { type: "integer", minimum: 0 },
                              quote: { type: "string" },
                            },
                          },
                        },
                      },
                    },
                    hooks: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        constructs: {
                          type: "array",
                          items: { type: "string" },
                        },
                        methods: { type: "array", items: { type: "string" } },
                        datasets: { type: "array", items: { type: "string" } },
                        populations: {
                          type: "array",
                          items: { type: "string" },
                        },
                        keyQuantities: {
                          type: "array",
                          items: { type: "string" },
                        },
                      },
                    },
                    candidateLinks: {
                      type: "array",
                      items: {
                        type: "object",
                        additionalProperties: false,
                        required: ["target", "type", "note"],
                        properties: {
                          target: {
                            type: "string",
                            description: "Corpus identity such as 1:ABCD1234",
                          },
                          type: { type: "string", enum: RESEARCH_EDGE_TYPES },
                          note: { type: "string" },
                        },
                      },
                    },
                    noLinkSeen: {
                      type: "string",
                      description:
                        "Reason no relationship to another corpus paper was seen; exclusive with candidateLinks.",
                    },
                    questionsRaised: {
                      type: "array",
                      items: {
                        type: "object",
                        additionalProperties: false,
                        required: ["text"],
                        properties: {
                          text: { type: "string" },
                          about: { type: "string" },
                        },
                      },
                    },
                    roles: {
                      type: "array",
                      minItems: 1,
                      items: { type: "string", enum: NARRATIVE_ROLES },
                    },
                    mainMessage: { type: "string" },
                    researchQuestion: { type: "string" },
                    method: { type: "string" },
                    mechanisms: {
                      type: "array",
                      items: { type: "string" },
                    },
                    relevance: { type: "string" },
                    relationships: {
                      type: "array",
                      items: { type: "string" },
                    },
                    subquestionIds: {
                      type: "array",
                      items: { type: "string" },
                    },
                    criterionIds: {
                      type: "array",
                      items: { type: "string" },
                    },
                    findings: {
                      type: "array",
                      items: { type: "string" },
                    },
                    contradictions: {
                      type: "array",
                      items: { type: "string" },
                    },
                    negativeEvidence: {
                      type: "array",
                      items: { type: "string" },
                    },
                    limitations: {
                      type: "array",
                      items: { type: "string" },
                    },
                    inclusionDecision: {
                      type: "string",
                      enum: ["include", "exclude", "unresolved"],
                    },
                    confidence: {
                      type: "string",
                      enum: ["low", "medium", "high"],
                    },
                    unresolvedQuestions: {
                      type: "array",
                      items: { type: "string" },
                    },
                  },
                },
              },
            },
          },
          probes: {
            type: "array",
            description:
              "Durable recall-expansion probes. addedTargets contains only frozen-corpus candidates newly added by this probe; use [] when the probe confirmed existing candidates but added none.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["probeId", "kind", "query", "addedTargets"],
              properties: {
                probeId: { type: "string" },
                kind: {
                  type: "string",
                  enum: [
                    "synonym",
                    "abbreviation",
                    "translation",
                    "semantic",
                    "reformulation",
                  ],
                },
                query: { type: "string" },
                addedTargets: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["libraryID", "itemKey"],
                    properties: {
                      libraryID: { type: "integer", minimum: 1 },
                      itemKey: { type: "string" },
                    },
                  },
                },
              },
            },
          },
          themes: {
            type: "array",
            description:
              "Cross-paper relationship themes. Refer to papers by stable libraryID:itemKey identities; the host resolves durable finding and evidence IDs.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["themeId", "title", "synthesis", "limitations"],
              properties: {
                themeId: { type: "string" },
                title: { type: "string" },
                synthesis: { type: "string" },
                paperFindingIds: {
                  type: "array",
                  minItems: 1,
                  items: { type: "string" },
                },
                paperIdentities: {
                  type: "array",
                  minItems: 1,
                  items: { type: "string" },
                },
                evidenceRefs: {
                  type: "array",
                  items: { type: "string" },
                },
                limitations: {
                  type: "array",
                  items: { type: "string" },
                },
                edgeIds: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Edges (from list_graph) the theme rests on; required for a multi-paper theme once edges exist, and every edge must connect two of the theme's papers.",
                },
                communityId: {
                  type: "string",
                  description:
                    "Host community id from list_graph this theme corresponds to.",
                },
              },
            },
          },
          outcome: {
            type: "string",
            enum: ["complete", "partial", "failed"],
          },
        },
      },
      executionClass: "control",
      requiresConfirmation: false,
    },
    isAvailable: (request) => request.planContext?.phase === "executing",
    guidance: {
      matches: (request) => request.planContext?.phase === "executing",
      instruction:
        "For an approved investigation, persist durable understanding instead of administering workflow state in model context. The host has frozen and fingerprinted the exact scope, so never re-enumerate or re-verify it with library_search. First call {operation:'inventory_scope'}; this authoritative scope check returns the comparison frame, every paper's tier and readMode, proposed read groups, the corpus map, and the unread reading manifest, and it is safe to repeat after an actual interruption when no continuation manifest is available. For a narrative or scoping review, read one proposed group with paper_read in each entry's readMode, then immediately record a claim-based node for every paper in that group with record_papers before reading more: mainMessage, relevance, confidence, every frame slot for a core paper, claims bound to evidence no deeper than the verified read, hooks, and candidateLinks or noLinkSeen. The host checkpoints away that group's raw PDF text; the host binds internal evidence and finding IDs and supplies the exact remaining manifest with the corpus map. A continuation checkpoint already supplies the authoritative remaining manifest: call paper_read directly from it and do not call inventory_scope between durable groups. You must read every accessible paper at its tier's depth; never preselect a fixed deep-reading quota or accumulate multiple unrecorded groups. Confirm or override host tiers with set_tiers (reason required) and refine comparison slots with set_frame only before the link pass. When every node is durable the loop enters the links phase: call list_findings (compact) to see every node, record the typed edge list with record_edges, advance_phase to verification and follow next_work (contradictions first: targeted paper_read of the pair, then update_edges verified, refuted, or tentative with a note), record and resolve open questions, advance_phase to structure, call list_graph, record themes with record_themes using paperIdentities such as '1:ABCD1234' plus the edgeIds each theme rests on (the host derives paperFindingIds and evidenceRefs), advance_phase to writing, then finalize with outcome complete (partial when accessible papers stayed unread). Use targeted reads only to verify an edge or resolve an important uncertainty. Missing or inaccessible evidence remains unresolved and its depth must be reported honestly. For a systematic review only, use next_screen_batch, explicit criterion decisions, recall probes, and ordered screening stages. When all papers are durable, call list_findings directly, or list_themes when themes are already durable; do not recover old tool handles or reread completed papers.",
    },
    validate: validateResearchUpdate,
    planInvocation: () =>
      readOnlyInvocationPlan({
        domains: [],
        reason:
          "This host-owned control updates only the active research workflow ledger.",
      }),
    execute: (input, context) => executeResearchUpdate(gateway, input, context),
  };
}
