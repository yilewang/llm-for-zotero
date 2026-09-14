import type { SelectedTextSource } from "../../shared/types";
import type { AgentRuntimeRequest } from "../types";
import type { AgentSkill, SkillContextKind } from "./skillLoader";

export type SkillRoutingRequest = Pick<
  AgentRuntimeRequest,
  | "userText"
  | "activeNoteContext"
  | "selectedTextSources"
  | "selectedTexts"
  | "turnPaperScope"
  | "classifiedIntent"
  | "conversationKind"
  | "screenshots"
  | "attachments"
>;

export type SkillRequestContext = {
  uniquePaperCount: number;
  hasSinglePaper: boolean;
  hasPaperSet: boolean;
  hasLibraryCorpus: boolean;
  hasNoteContext: boolean;
  hasVisualInput: boolean;
  availableContexts: SkillContextKind[];
};

export type SkillContextEligibility =
  | { eligible: true }
  | { eligible: false; reason: string };

function addPaperKey(
  keys: Set<string>,
  entry: { itemId: number; contextItemId: number },
): void {
  const itemId = Math.floor(Number(entry.itemId));
  if (Number.isFinite(itemId) && itemId > 0) {
    keys.add(`item:${itemId}`);
    return;
  }
  const contextItemId = Math.floor(Number(entry.contextItemId));
  if (Number.isFinite(contextItemId) && contextItemId > 0) {
    keys.add(`context:${contextItemId}`);
  }
}

function hasNoteTextSelection(
  sources: SelectedTextSource[] | undefined,
): boolean {
  return Boolean(
    sources?.some((source) => source === "note" || source === "note-edit"),
  );
}

export function resolveSkillRequestContext(
  request: SkillRoutingRequest,
): SkillRequestContext {
  const paperKeys = new Set<string>();
  for (const entry of request.turnPaperScope?.papers || []) {
    addPaperKey(paperKeys, entry.paper);
  }

  const uniquePaperCount = paperKeys.size;
  const hasLibraryCorpus = Boolean(
    request.conversationKind === "global" ||
    request.turnPaperScope?.collections.length ||
    request.turnPaperScope?.tags.length,
  );
  const hasNoteContext = Boolean(
    request.activeNoteContext ||
    hasNoteTextSelection(request.selectedTextSources),
  );
  const hasVisualInput = Boolean(
    request.screenshots?.length ||
    request.attachments?.some((attachment) => attachment.category === "image"),
  );
  const availableContexts: SkillContextKind[] = [];
  if (uniquePaperCount === 1) availableContexts.push("single-paper");
  if (uniquePaperCount >= 2) availableContexts.push("paper-set");
  if (hasLibraryCorpus) availableContexts.push("library-corpus");
  if (hasNoteContext) availableContexts.push("note");
  if (hasVisualInput) availableContexts.push("visual-input");

  return {
    uniquePaperCount,
    hasSinglePaper: uniquePaperCount === 1,
    hasPaperSet: uniquePaperCount >= 2,
    hasLibraryCorpus,
    hasNoteContext,
    hasVisualInput,
    availableContexts,
  };
}

export function getSkillContextEligibility(
  skill: AgentSkill,
  request: SkillRoutingRequest,
): SkillContextEligibility {
  if (skill.contexts.includes("any")) return { eligible: true };
  const available = new Set(
    resolveSkillRequestContext(request).availableContexts,
  );
  if (skill.contexts.some((context) => available.has(context))) {
    return { eligible: true };
  }
  return {
    eligible: false,
    reason: `Requires ${skill.contexts.join(" or ")}; available context is ${
      available.size ? Array.from(available).join(", ") : "none"
    }`,
  };
}

export function isSkillContextEligible(
  skill: AgentSkill,
  request: SkillRoutingRequest,
): boolean {
  return getSkillContextEligibility(skill, request).eligible;
}
