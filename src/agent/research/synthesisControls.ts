import { ToolInputRejection } from "../tools/execution/failure";
import { resolveOutputReserve } from "../../utils/outputTokenPolicy";
import type { AgentToolContext } from "../types";
import { refineResearchFrame } from "./frame";
import { decodeResearchFrameSlot, RESEARCH_PAPER_TIERS } from "./graphSchema";
import type { ReadingManifestEntry } from "./reading";
import { resolveAdaptiveReadingBudget } from "./readingBudget";
import { rankCorpusRelevance } from "./relevance";
import { assertResearchCorpusUnchanged, commitResearchRecords } from "./stages";
import {
  listPaperFindings,
  saveResearchCorpusItem,
  saveResearchJob,
} from "./store";
import {
  DEFAULT_PAPER_TEXT_TOKENS,
  proposeReadingGroups,
  proposeTiers,
  resolveLinkViewTokens,
  resolveNodeCapacity,
  resolveTierReadPlan,
} from "./tiering";
import type {
  ResearchContract,
  ResearchCorpusItem,
  ResearchJob,
  ResearchNodeCapacity,
  ResearchPaperTier,
} from "./types";

/**
 * Host-side controls of the adaptive loop: capacity-derived tiering at
 * inventory, the model's tier and frame revisions, and the decorated reading
 * manifest (tier, read plan, proposed groups) the model reads from.
 */

export function resolveHostOutputReserve(context: AgentToolContext): number {
  return resolveOutputReserve(
    context.request.advanced?.outputTokenLimit,
    context.request.model || context.modelName || "",
    {
      apiBase: context.request.apiBase,
      protocol: context.request.providerProtocol,
      authMode: context.request.authMode,
      profileOverride: context.request.advanced?.profileOverride,
    },
  );
}

function paperMetadata(item: ResearchCorpusItem) {
  const live = Zotero.Items.getByLibraryAndKey(item.libraryID, item.itemKey);
  const field = (name: string) =>
    String(live && live.getField?.(name) ? live.getField(name) : "").trim();
  const tags = (
    (
      live as unknown as { getTags?: () => Array<{ tag?: string }> }
    )?.getTags?.() || []
  )
    .map((entry) => String(entry?.tag || "").trim())
    .filter(Boolean);
  return {
    identity: `${item.libraryID}:${item.itemKey}`,
    title: field("title"),
    abstract: field("abstractNote"),
    tags,
  };
}

/**
 * Rank, measure capacity, propose tiers, and persist them on the corpus items
 * and the job. Runs once per job; later calls reuse the stored decision.
 */
export async function applyHostTiering(params: {
  job: ResearchJob;
  corpus: readonly ResearchCorpusItem[];
  investigation: ResearchContract;
  context: AgentToolContext;
  conversationKey: number;
  now?: number;
}): Promise<{ job: ResearchJob; corpus: ResearchCorpusItem[] }> {
  const now = params.now ?? Date.now();
  const live = params.corpus.filter(
    (item) => item.screeningStatus !== "missing",
  );
  const relevance = rankCorpusRelevance({
    papers: live.map(paperMetadata),
    question: params.investigation.question,
    subquestions: params.investigation.subquestions.map(
      (entry) => entry.question,
    ),
  });
  const budget = params.context.request.runtimeContextBudget;
  const capacity = resolveNodeCapacity({
    paperCount: live.length,
    linkViewTokens: budget
      ? resolveLinkViewTokens({
          contextWindowTokens: budget.contextWindowTokens,
          usedContextTokens: budget.usedContextTokens,
          outputReserveTokens: resolveHostOutputReserve(params.context),
        })
      : undefined,
    compactCoreTokens: params.job.nodeCapacity?.compactCoreTokens,
    compactPeripheralTokens: params.job.nodeCapacity?.compactPeripheralTokens,
    now,
  });
  const tiers = proposeTiers({
    papers: live.map((item) => ({
      identity: `${item.libraryID}:${item.itemKey}`,
      relevanceScore: relevance.get(`${item.libraryID}:${item.itemKey}`) || 0,
      ordinal: item.ordinal,
    })),
    capacity,
  });
  const updatedCorpus: ResearchCorpusItem[] = params.corpus.map((item) => {
    const identity = `${item.libraryID}:${item.itemKey}`;
    if (!tiers.has(identity)) return item;
    return {
      ...item,
      version: 2,
      tier: tiers.get(identity)!,
      relevanceScore: relevance.get(identity) || 0,
      tierSource: "host",
      updatedAt: now,
    };
  });
  const updatedJob: ResearchJob = {
    ...params.job,
    nodeCapacity: capacity,
    synthesisPhase: params.job.synthesisPhase || "nodes",
    updatedAt: Math.max(now, params.job.updatedAt + 1),
  };
  await commitResearchRecords(params.job, async () => {
    await assertResearchCorpusUnchanged(params.job, params.corpus);
    for (const item of updatedCorpus) await saveResearchCorpusItem(item);
    await saveResearchJob(updatedJob, params.conversationKey);
  });
  return { job: updatedJob, corpus: updatedCorpus };
}

export function corpusHasHostTiers(corpus: readonly ResearchCorpusItem[]) {
  return corpus
    .filter((item) => item.screeningStatus !== "missing")
    .every((item) => Boolean(item.tier));
}

export type DecoratedManifestEntry = ReadingManifestEntry & {
  tier: ResearchPaperTier;
  relevanceScore?: number;
  textTokens?: number;
  readMode: "overview" | "targeted";
  suggestedQueries?: readonly string[];
  suggestedMaxChars?: number;
};

export function decorateReadingManifest(params: {
  manifest: readonly ReadingManifestEntry[];
  corpus: readonly ResearchCorpusItem[];
  job: ResearchJob;
  context: AgentToolContext;
}): {
  entries: DecoratedManifestEntry[];
  proposedGroups: string[][];
  allocatedReadingTokens: number;
} {
  const byIdentity = new Map(
    params.corpus.map((item) => [`${item.libraryID}:${item.itemKey}`, item]),
  );
  const entries = params.manifest.map((entry) => {
    const item = byIdentity.get(entry.identity);
    const tier = item?.tier || "core";
    const plan = resolveTierReadPlan({
      tier,
      frame: params.job.frame,
      readable: entry.readable,
    });
    return {
      ...entry,
      tier,
      ...(item?.relevanceScore === undefined
        ? {}
        : { relevanceScore: item.relevanceScore }),
      ...(item?.textTokens === undefined
        ? {}
        : { textTokens: item.textTokens }),
      ...plan,
    };
  });
  const budget = params.context.request.runtimeContextBudget;
  const allocatedReadingTokens = budget
    ? resolveAdaptiveReadingBudget({
        contextWindowTokens: budget.contextWindowTokens,
        usedContextTokens: budget.usedContextTokens,
        outputReserveTokens: resolveHostOutputReserve(params.context),
        paperCount: Math.max(1, entries.length),
      }).allocatedReadingTokens
    : DEFAULT_PAPER_TEXT_TOKENS * 4;
  const proposedGroups = proposeReadingGroups({
    papers: entries.map((entry) => ({
      identity: entry.identity,
      tier: entry.tier,
      ordinal: entry.ordinal,
      textTokens:
        entry.tier === "peripheral" && entry.suggestedMaxChars
          ? Math.ceil(entry.suggestedMaxChars / 4)
          : entry.textTokens,
    })),
    allocatedReadingTokens,
  });
  return { entries, proposedGroups, allocatedReadingTokens };
}

export async function applyFrameRevision(params: {
  job: ResearchJob;
  slots: unknown[];
  conversationKey: number;
  now?: number;
}): Promise<ResearchJob> {
  const now = params.now ?? Date.now();
  if (!params.job.frame) {
    throw new ToolInputRejection(
      "This research job has no comparison frame to refine",
    );
  }
  if ((params.job.synthesisPhase || "nodes") !== "nodes") {
    throw new ToolInputRejection(
      "The comparison frame is frozen once the link pass begins; nodes already fill it",
    );
  }
  const slots = params.slots.map((entry, index) =>
    decodeResearchFrameSlot(entry, `slots[${index}]`),
  );
  const findings = await listPaperFindings(params.job.researchJobId);
  const filledSlotIds = new Set(
    findings.flatMap((finding) => Object.keys(finding.frameSlots || {})),
  );
  const frame = refineResearchFrame({
    frame: params.job.frame,
    slots,
    filledSlotIds,
    now,
  });
  const updated: ResearchJob = {
    ...params.job,
    frame,
    updatedAt: Math.max(now, params.job.updatedAt + 1),
  };
  await commitResearchRecords(params.job, async () => {
    await saveResearchJob(updated, params.conversationKey);
  });
  return updated;
}

export type TierDecision = {
  identity: string;
  tier: ResearchPaperTier;
  reason?: string;
};

export function parseTierDecisions(value: unknown[]): TierDecision[] {
  return value.map((entry, index) => {
    const raw =
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as Record<string, unknown>)
        : {};
    const identity =
      typeof raw.identity === "string" && raw.identity.trim()
        ? raw.identity.trim()
        : raw.libraryID !== undefined && typeof raw.itemKey === "string"
          ? `${Number(raw.libraryID)}:${raw.itemKey.trim()}`
          : "";
    if (!identity) {
      throw new ToolInputRejection(
        `tiers[${index}] requires identity (libraryID:itemKey)`,
      );
    }
    if (!RESEARCH_PAPER_TIERS.includes(raw.tier as ResearchPaperTier)) {
      throw new ToolInputRejection(
        `tiers[${index}].tier must be core, supporting, or peripheral`,
      );
    }
    return {
      identity,
      tier: raw.tier as ResearchPaperTier,
      ...(typeof raw.reason === "string" && raw.reason.trim()
        ? { reason: raw.reason.trim() }
        : {}),
    };
  });
}

/**
 * The model confirms or overrides host tiers. Overrides need a reason, and
 * when tiering is mandatory the number of core papers stays within capacity.
 */
export async function applyTierDecisions(params: {
  job: ResearchJob;
  corpus: readonly ResearchCorpusItem[];
  decisions: readonly TierDecision[];
  now?: number;
}): Promise<ResearchCorpusItem[]> {
  const now = params.now ?? Date.now();
  if ((params.job.synthesisPhase || "nodes") !== "nodes") {
    throw new ToolInputRejection(
      "Tiers can be revised only while nodes are being recorded",
    );
  }
  const byIdentity = new Map(
    params.corpus.map((item) => [`${item.libraryID}:${item.itemKey}`, item]),
  );
  const updates = new Map<string, ResearchCorpusItem>();
  for (const decision of params.decisions) {
    const item = byIdentity.get(decision.identity);
    if (!item) {
      throw new ToolInputRejection(
        `Paper ${decision.identity} is outside the frozen corpus`,
      );
    }
    if (item.tier === decision.tier) continue;
    if (!decision.reason) {
      throw new ToolInputRejection(
        `Changing ${decision.identity} from ${item.tier || "core"} to ${decision.tier} requires a reason`,
      );
    }
    updates.set(decision.identity, {
      ...item,
      version: 2,
      tier: decision.tier,
      tierSource: "model",
      tierReason: decision.reason,
      updatedAt: now,
    });
  }
  const capacity = params.job.nodeCapacity;
  if (capacity?.mandatoryTiering) {
    const coreCount = params.corpus.filter((item) => {
      const next = updates.get(`${item.libraryID}:${item.itemKey}`) || item;
      return next.screeningStatus !== "missing" && next.tier === "core";
    }).length;
    if (coreCount > capacity.fullNodeCapacity) {
      throw new ToolInputRejection(
        `At most ${capacity.fullNodeCapacity} core papers fit the link view for this model (requested ${coreCount}); keep the rest supporting or peripheral`,
      );
    }
  }
  if (!updates.size) return [...params.corpus];
  await commitResearchRecords(params.job, async () => {
    await assertResearchCorpusUnchanged(params.job, params.corpus);
    for (const item of updates.values()) await saveResearchCorpusItem(item);
  });
  return params.corpus.map(
    (item) => updates.get(`${item.libraryID}:${item.itemKey}`) || item,
  );
}
