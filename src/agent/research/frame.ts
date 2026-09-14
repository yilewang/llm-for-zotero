import { ToolInputRejection } from "../tools/execution/failure";
import type {
  ResearchContract,
  ResearchFrame,
  ResearchFrameSlot,
  ResearchPaperTier,
} from "./types";

/**
 * The comparison frame turns the approved question into named slots every
 * node fills, so nodes become comparable and edges computable. The host
 * derives the default frame from the investigation; the model may refine
 * comparison slots before the link pass, never the identity slots.
 */

export const IDENTITY_FRAME_SLOTS: readonly ResearchFrameSlot[] = [
  {
    slotId: "question",
    name: "Question",
    description: "What this paper asks or sets out to show.",
    kind: "identity",
  },
  {
    slotId: "approach",
    name: "Approach",
    description:
      "Method and evidence type: experiment, model, review, dataset, analysis.",
    kind: "identity",
  },
  {
    slotId: "system",
    name: "System",
    description:
      "Population, species, model system, task, or dataset the evidence comes from.",
    kind: "identity",
  },
];

export function buildDefaultResearchFrame(
  investigation: Pick<ResearchContract, "subquestions">,
  now = Date.now(),
): ResearchFrame {
  const comparison: ResearchFrameSlot[] = investigation.subquestions.map(
    (subquestion) => ({
      slotId: subquestion.id,
      name: subquestion.question.replace(/\s+/g, " ").trim().slice(0, 80),
      description: `What this paper contributes to: ${subquestion.question.trim()}`,
      kind: "comparison",
    }),
  );
  return {
    version: 1,
    slots: [...IDENTITY_FRAME_SLOTS, ...comparison],
    revisedAt: now,
  };
}

/** Slots a node of the given tier must fill. */
export function requiredFrameSlots(
  frame: ResearchFrame,
  tier: ResearchPaperTier,
): readonly ResearchFrameSlot[] {
  return tier === "core"
    ? frame.slots
    : frame.slots.filter((slot) => slot.kind === "identity");
}

/** Minimum number of evidence-bound claims a node of the given tier carries. */
export function minimumClaimsForTier(tier: ResearchPaperTier): number {
  return tier === "core" ? 3 : 1;
}

/**
 * Apply a model refinement: comparison slots may be added or re-described,
 * identity slots never change, and no slot that a node already fills may be
 * removed.
 */
export function refineResearchFrame(params: {
  frame: ResearchFrame;
  slots: readonly ResearchFrameSlot[];
  filledSlotIds: ReadonlySet<string>;
  now: number;
}): ResearchFrame {
  const identityIds = new Set(IDENTITY_FRAME_SLOTS.map((slot) => slot.slotId));
  const proposed = new Map(params.slots.map((slot) => [slot.slotId, slot]));
  for (const slot of params.slots) {
    if (identityIds.has(slot.slotId) && slot.kind !== "identity") {
      throw new ToolInputRejection(
        `Frame slot ${slot.slotId} is an identity slot`,
      );
    }
    if (!identityIds.has(slot.slotId) && slot.kind === "identity") {
      throw new ToolInputRejection(
        `Frame slot ${slot.slotId} cannot be an identity slot; use kind comparison`,
      );
    }
  }
  const removed = params.frame.slots.filter(
    (slot) => !proposed.has(slot.slotId),
  );
  const blocked = removed.filter(
    (slot) =>
      identityIds.has(slot.slotId) || params.filledSlotIds.has(slot.slotId),
  );
  if (blocked.length) {
    throw new ToolInputRejection(
      `Frame slots ${blocked.map((slot) => slot.slotId).join(", ")} cannot be removed: identity slots are fixed and a slot that a recorded node fills stays`,
    );
  }
  const identity = IDENTITY_FRAME_SLOTS.map(
    (slot) => proposed.get(slot.slotId) || slot,
  );
  const comparison = params.slots.filter(
    (slot) => !identityIds.has(slot.slotId),
  );
  return {
    version: 1,
    slots: [...identity, ...comparison],
    revisedAt: params.now,
  };
}
