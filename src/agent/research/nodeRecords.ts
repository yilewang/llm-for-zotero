import { ToolInputRejection } from "../tools/execution/failure";
import { minimumClaimsForTier, requiredFrameSlots } from "./frame";
import {
  decodeResearchCandidateLink,
  decodeResearchClaim,
  decodeResearchNodeHooks,
  RESEARCH_PAPER_TIERS,
} from "./graphSchema";
import { string, strings } from "./recordValidation";
import type {
  PaperFinding,
  ResearchCandidateLink,
  ResearchClaim,
  ResearchFrame,
  ResearchPaperTier,
} from "./types";

/**
 * A node is the tailored, claim-based understanding of one paper: frame
 * slots that make it comparable, claims bound to evidence the host verified
 * a read for, hooks that seed links, and an explicit link field that can
 * never be silently empty.
 */

export type NodeRecordInput = {
  identity: string;
  itemKey: string;
  finding: Record<string, unknown>;
  frame: ResearchFrame;
  tier: ResearchPaperTier;
  /** Deepest host-verified read of this paper, if any. */
  readDepth?: "metadata" | "abstract" | "body";
  /** Page indexes a trusted read observation issued for this paper. */
  observedPageIndexes: ReadonlySet<number>;
  corpusIdentities: ReadonlySet<string>;
  allowedSubquestions: ReadonlySet<string>;
};

export type NodeRecordFields = Readonly<{
  tier: ResearchPaperTier;
  frameSlots: Readonly<Record<string, string>>;
  claims: readonly ResearchClaim[];
  hooks: PaperFinding["hooks"];
  candidateLinks?: readonly ResearchCandidateLink[];
  noLinkSeen?: string;
  questionsRaised?: PaperFinding["questionsRaised"];
  subquestionIds: readonly string[];
  findings: readonly string[];
  mechanisms: readonly string[];
  limitations: readonly string[];
  researchQuestion?: string;
  method?: string;
}>;

const DEPTH_RANK = { metadata: 0, abstract: 1, body: 2 } as const;
const MAX_CLAIM_QUOTE_CHARS = 400;

/** True when a finding was written in the claim-based node shape. */
export function isNodeShapedFinding(finding: Record<string, unknown>): boolean {
  return finding.claims !== undefined || finding.frameSlots !== undefined;
}

export function buildNodeRecordFields(
  input: NodeRecordInput,
): NodeRecordFields {
  const { finding, identity } = input;
  const tier =
    finding.tier === undefined
      ? input.tier
      : ((): ResearchPaperTier => {
          if (
            !RESEARCH_PAPER_TIERS.includes(finding.tier as ResearchPaperTier)
          ) {
            throw new ToolInputRejection(
              `Node for ${identity} has an invalid tier; use core, supporting, or peripheral`,
            );
          }
          return finding.tier as ResearchPaperTier;
        })();

  const rawSlots =
    finding.frameSlots && typeof finding.frameSlots === "object"
      ? (finding.frameSlots as Record<string, unknown>)
      : {};
  const frameSlots: Record<string, string> = {};
  const knownSlotIds = new Set(input.frame.slots.map((slot) => slot.slotId));
  for (const [slotId, value] of Object.entries(rawSlots)) {
    if (!knownSlotIds.has(slotId)) continue;
    const text = typeof value === "string" ? value.trim() : "";
    if (text) frameSlots[slotId] = text;
  }
  const required = requiredFrameSlots(input.frame, tier);
  const missingSlots = required
    .map((slot) => slot.slotId)
    .filter((slotId) => !frameSlots[slotId]);
  if (missingSlots.length) {
    throw new ToolInputRejection(
      `Node for ${identity} is missing frame slots ${missingSlots.join(", ")}; a ${tier} node fills ${
        tier === "core" ? "every frame slot" : "the identity slots"
      } (write "not_reported" when the paper is silent on one)`,
    );
  }

  if (!Array.isArray(finding.claims) || !finding.claims.length) {
    throw new ToolInputRejection(
      `Node for ${identity} requires claims[]: each claim states one thing the paper shows, its kind, the subquestions it answers, and the evidence it rests on`,
    );
  }
  const minimum = minimumClaimsForTier(tier);
  if (finding.claims.length < minimum) {
    throw new ToolInputRejection(
      `Node for ${identity} needs at least ${minimum} claims for its ${tier} tier (received ${finding.claims.length})`,
    );
  }
  const seenClaimIds = new Set<string>();
  const claims: ResearchClaim[] = finding.claims.map((entry, index) => {
    const raw =
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as Record<string, unknown>)
        : {};
    const claimId =
      typeof raw.claimId === "string" && raw.claimId.trim()
        ? raw.claimId.trim()
        : `${input.itemKey}:c${index + 1}`;
    if (seenClaimIds.has(claimId)) {
      throw new ToolInputRejection(
        `Node for ${identity} repeats claim id ${claimId}`,
      );
    }
    seenClaimIds.add(claimId);
    const decoded = decodeResearchClaim(
      {
        ...raw,
        claimId,
        subquestionIds: raw.subquestionIds ?? [],
      },
      `claims[${index}]`,
    );
    for (const subquestionId of decoded.subquestionIds) {
      if (!input.allowedSubquestions.has(subquestionId)) {
        throw new ToolInputRejection(
          `Claim ${claimId} of ${identity} references unknown subquestion ${subquestionId}`,
        );
      }
    }
    const allowedDepth = input.readDepth ? DEPTH_RANK[input.readDepth] : -1;
    if (DEPTH_RANK[decoded.evidence.sourceKind] > allowedDepth) {
      throw new ToolInputRejection(
        `Claim ${claimId} of ${identity} cites ${decoded.evidence.sourceKind} evidence but the host-verified read depth of this paper is ${
          input.readDepth || "none"
        }; read the paper at that depth first or lower the claim's evidence kind`,
      );
    }
    if (
      decoded.evidence.pageIndex !== undefined &&
      decoded.evidence.sourceKind !== "body"
    ) {
      throw new ToolInputRejection(
        `Claim ${claimId} of ${identity} carries a page locator without body evidence`,
      );
    }
    if (
      decoded.evidence.quote !== undefined &&
      decoded.evidence.quote.length > MAX_CLAIM_QUOTE_CHARS
    ) {
      throw new ToolInputRejection(
        `Claim ${claimId} of ${identity} quote exceeds ${MAX_CLAIM_QUOTE_CHARS} characters`,
      );
    }
    const pageVerified =
      decoded.evidence.pageIndex !== undefined &&
      input.observedPageIndexes.has(decoded.evidence.pageIndex);
    return {
      ...decoded,
      evidence: { ...decoded.evidence, verified: pageVerified },
    };
  });

  const subquestionIds = [
    ...new Set(claims.flatMap((claim) => claim.subquestionIds)),
  ];
  if (tier === "core" && !subquestionIds.length) {
    throw new ToolInputRejection(
      `Node for ${identity} answers no approved subquestion; tag each claim with the subquestion it answers`,
    );
  }

  const hasLinks =
    Array.isArray(finding.candidateLinks) && finding.candidateLinks.length > 0;
  const noLinkSeen =
    typeof finding.noLinkSeen === "string" && finding.noLinkSeen.trim()
      ? finding.noLinkSeen.trim()
      : undefined;
  if (hasLinks && noLinkSeen) {
    throw new ToolInputRejection(
      `Node for ${identity} must provide either candidateLinks or noLinkSeen, not both`,
    );
  }
  if (!hasLinks && !noLinkSeen) {
    throw new ToolInputRejection(
      `Node for ${identity} must name its relationships: provide candidateLinks with at least one link to another corpus paper, or noLinkSeen with the reason no link was found`,
    );
  }
  const candidateLinks = hasLinks
    ? (finding.candidateLinks as unknown[]).map((entry, index) => {
        const link = decodeResearchCandidateLink(
          entry,
          `candidateLinks[${index}]`,
        );
        if (link.target === identity) {
          throw new ToolInputRejection(
            `Node for ${identity} cannot link to itself`,
          );
        }
        if (!input.corpusIdentities.has(link.target)) {
          throw new ToolInputRejection(
            `Node for ${identity} links to ${link.target}, which is outside the frozen corpus`,
          );
        }
        return link;
      })
    : undefined;

  const hooks = decodeResearchNodeHooks(finding.hooks ?? {}, "hooks");
  const questionsRaised =
    finding.questionsRaised === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(finding.questionsRaised)) {
            throw new ToolInputRejection(
              `Node for ${identity} questionsRaised must be an array`,
            );
          }
          return finding.questionsRaised.map((entry, index) => {
            const raw =
              entry && typeof entry === "object" && !Array.isArray(entry)
                ? (entry as Record<string, unknown>)
                : {};
            const about =
              typeof raw.about === "string" && raw.about.trim()
                ? raw.about.trim()
                : undefined;
            if (about && !input.corpusIdentities.has(about)) {
              throw new ToolInputRejection(
                `Node for ${identity} raises a question about ${about}, which is outside the frozen corpus`,
              );
            }
            return {
              text: string(raw.text, `questionsRaised[${index}].text`),
              ...(about ? { about } : {}),
            };
          });
        })();

  const statementsOf = (kinds: readonly ResearchClaim["kind"][]) =>
    claims
      .filter((claim) => kinds.includes(claim.kind))
      .map((claim) => claim.statement);
  const explicitLimitations =
    finding.limitations === undefined
      ? []
      : strings(finding.limitations, "finding.limitations");
  return {
    tier,
    frameSlots,
    claims,
    hooks,
    ...(candidateLinks ? { candidateLinks } : {}),
    ...(noLinkSeen ? { noLinkSeen } : {}),
    ...(questionsRaised ? { questionsRaised } : {}),
    subquestionIds,
    findings: statementsOf(["finding", "theory"]),
    mechanisms: statementsOf(["mechanism"]),
    limitations: [
      ...new Set([...statementsOf(["limitation"]), ...explicitLimitations]),
    ],
    researchQuestion:
      typeof finding.researchQuestion === "string" &&
      finding.researchQuestion.trim()
        ? finding.researchQuestion.trim()
        : frameSlots.question,
    method:
      typeof finding.method === "string" && finding.method.trim()
        ? finding.method.trim()
        : frameSlots.approach,
  };
}
