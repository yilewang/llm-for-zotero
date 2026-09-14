import { TOKEN_ESTIMATE_CHARS_PER_TOKEN } from "../../utils/modelInputCap";
import type {
  PaperFinding,
  ResearchCorpusItem,
  ResearchEdge,
  ResearchFrame,
  ResearchNodeCapacity,
  ResearchPaperTier,
} from "./types";

/**
 * Capacity-derived tiering. Reading is free on large models; what runs out
 * is the "every node in view" link pass and the output spent on rich nodes.
 * The host measures how many compact nodes fit in the link view and proposes
 * tiers from relevance; the model confirms or overrides with a reason.
 */

/** Calibrated estimates, replaced by measurements of recorded nodes. */
export const COMPACT_CORE_NODE_TOKENS = 360;
export const COMPACT_PERIPHERAL_NODE_TOKENS = 90;
/** Share of the remaining input window the link pass may occupy. */
export const LINK_VIEW_SHARE = 0.5;
/** Assumed full-text size when the host could not measure a paper. */
export const DEFAULT_PAPER_TEXT_TOKENS = 20_000;

export function resolveLinkViewTokens(params: {
  contextWindowTokens: number;
  usedContextTokens: number;
  outputReserveTokens: number;
}): number {
  const remaining = Math.max(
    0,
    Math.floor(params.contextWindowTokens) -
      Math.floor(params.usedContextTokens) -
      Math.floor(params.outputReserveTokens),
  );
  return Math.floor(remaining * LINK_VIEW_SHARE);
}

export function resolveNodeCapacity(params: {
  paperCount: number;
  /** Undefined when the runtime could not report a context budget. */
  linkViewTokens?: number;
  compactCoreTokens?: number;
  compactPeripheralTokens?: number;
  now: number;
}): ResearchNodeCapacity {
  const paperCount = Math.max(0, Math.floor(params.paperCount));
  const core = Math.max(
    1,
    params.compactCoreTokens ?? COMPACT_CORE_NODE_TOKENS,
  );
  const peripheral = Math.max(
    1,
    Math.min(
      core,
      params.compactPeripheralTokens ?? COMPACT_PERIPHERAL_NODE_TOKENS,
    ),
  );
  if (params.linkViewTokens === undefined) {
    return {
      fullNodeCapacity: paperCount,
      linkViewTokens: 0,
      compactCoreTokens: core,
      compactPeripheralTokens: peripheral,
      mandatoryTiering: false,
      measuredAt: params.now,
    };
  }
  const budget = Math.max(0, Math.floor(params.linkViewTokens));
  // Largest k with k*core + (N-k)*peripheral <= budget.
  const fullNodeCapacity = Math.max(
    0,
    Math.min(
      paperCount,
      Math.floor((budget - paperCount * peripheral) / (core - peripheral || 1)),
    ),
  );
  return {
    fullNodeCapacity,
    linkViewTokens: budget,
    compactCoreTokens: core,
    compactPeripheralTokens: peripheral,
    mandatoryTiering: paperCount > fullNodeCapacity,
    measuredAt: params.now,
  };
}

export type TierCandidate = Readonly<{
  identity: string;
  relevanceScore: number;
  ordinal: number;
}>;

export function proposeTiers(params: {
  papers: readonly TierCandidate[];
  capacity: ResearchNodeCapacity;
}): Map<string, ResearchPaperTier> {
  const tiers = new Map<string, ResearchPaperTier>();
  if (!params.capacity.mandatoryTiering) {
    for (const paper of params.papers) tiers.set(paper.identity, "core");
    return tiers;
  }
  const ranked = [...params.papers].sort(
    (left, right) =>
      right.relevanceScore - left.relevanceScore ||
      left.ordinal - right.ordinal,
  );
  const core = ranked.slice(0, params.capacity.fullNodeCapacity);
  const rest = ranked.slice(params.capacity.fullNodeCapacity);
  for (const paper of core) tiers.set(paper.identity, "core");
  if (!rest.length) return tiers;
  const scores = rest
    .map((paper) => paper.relevanceScore)
    .sort((a, b) => a - b);
  const median = scores[Math.floor(scores.length / 2)];
  for (const paper of rest) {
    tiers.set(
      paper.identity,
      paper.relevanceScore >= median && paper.relevanceScore > 0
        ? "supporting"
        : "peripheral",
    );
  }
  return tiers;
}

export type TierReadPlan = Readonly<{
  readMode: "overview" | "targeted";
  suggestedQueries?: readonly string[];
  suggestedMaxChars?: number;
}>;

/** Reading depth that the tier buys: full text, targeted passages, or a bounded excerpt. */
export function resolveTierReadPlan(params: {
  tier: ResearchPaperTier;
  frame: ResearchFrame | undefined;
  readable: boolean;
}): TierReadPlan {
  if (!params.readable) return { readMode: "overview" };
  if (params.tier === "core") return { readMode: "overview" };
  if (params.tier === "supporting") {
    const queries = (params.frame?.slots || [])
      .filter((slot) => slot.kind === "comparison")
      .map((slot) => slot.name);
    return {
      readMode: "targeted",
      suggestedQueries: queries.length ? queries : ["main finding and method"],
    };
  }
  return {
    readMode: "overview",
    suggestedMaxChars: 4 * TOKEN_ESTIMATE_CHARS_PER_TOKEN * 750,
  };
}

const TIER_ORDER: Record<ResearchPaperTier, number> = {
  core: 0,
  supporting: 1,
  peripheral: 2,
};

export type GroupCandidate = Readonly<{
  identity: string;
  tier: ResearchPaperTier;
  ordinal: number;
  textTokens?: number;
}>;

/**
 * Host-proposed read groups: core first, then supporting, then peripheral,
 * ordinal order inside a tier, each group filled up to the reading allocation
 * from the measured (or assumed) text size of its papers.
 */
export function proposeReadingGroups(params: {
  papers: readonly GroupCandidate[];
  allocatedReadingTokens: number;
}): string[][] {
  const budget = Math.max(1, Math.floor(params.allocatedReadingTokens));
  const ordered = [...params.papers].sort(
    (left, right) =>
      TIER_ORDER[left.tier] - TIER_ORDER[right.tier] ||
      left.ordinal - right.ordinal,
  );
  const groups: string[][] = [];
  let current: string[] = [];
  let used = 0;
  for (const paper of ordered) {
    const size = Math.max(1, paper.textTokens ?? DEFAULT_PAPER_TEXT_TOKENS);
    const startsNewTier =
      current.length > 0 &&
      TIER_ORDER[paper.tier] !==
        TIER_ORDER[
          ordered.find((entry) => entry.identity === current[0])!.tier
        ];
    if (current.length && (used + size > budget || startsNewTier)) {
      groups.push(current);
      current = [];
      used = 0;
    }
    current.push(paper.identity);
    used += size;
  }
  if (current.length) groups.push(current);
  return groups;
}

export function buildCorpusMap(params: {
  corpus: readonly ResearchCorpusItem[];
  findings: readonly PaperFinding[];
  edges: readonly ResearchEdge[];
  labels: ReadonlyMap<string, string>;
}): string[] {
  const findingByIdentity = new Map(
    params.findings.map((finding) => [
      `${finding.libraryID}:${finding.itemKey}`,
      finding,
    ]),
  );
  const edgeCount = new Map<string, number>();
  for (const edge of params.edges) {
    if (edge.lifecycle !== "valid" || edge.status === "merged") continue;
    for (const end of [edge.source, edge.target]) {
      edgeCount.set(end, (edgeCount.get(end) || 0) + 1);
    }
  }
  return [...params.corpus]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((item) => {
      const identity = `${item.libraryID}:${item.itemKey}`;
      const finding = findingByIdentity.get(identity);
      const label = params.labels.get(identity) || identity;
      const status = finding
        ? `node ok (${finding.claims?.length ?? finding.findings.length} claims, ${edgeCount.get(identity) || 0} edges)`
        : item.screeningStatus === "missing"
          ? "missing"
          : "node pending";
      const message = finding?.mainMessage
        ? ` — ${finding.mainMessage.replace(/\s+/g, " ").slice(0, 140)}`
        : "";
      return `#${item.ordinal + 1} ${identity} ${label} [${item.tier || "core"}] ${status}${message}`;
    });
}
