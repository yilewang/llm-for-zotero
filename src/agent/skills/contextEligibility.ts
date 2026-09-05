import type { SelectedTextSource } from "../../shared/types";
import type { AgentRuntimeRequest } from "../types";
import type { AgentSkill } from "./skillLoader";

export type SkillRoutingRequest = Pick<
  AgentRuntimeRequest,
  | "userText"
  | "activeNoteContext"
  | "selectedTextSources"
  | "selectedTexts"
  | "turnPaperScope"
  | "classifiedIntent"
>;

export type SkillRequestContext = {
  uniquePaperCount: number;
  hasSinglePaper: boolean;
  hasPaperSet: boolean;
  hasLibraryCorpus: boolean;
  hasNoteContext: boolean;
  corpusTargetedByText: boolean;
  singlePaperTargetedByText: boolean;
};

export type SkillContextEligibility =
  | { eligible: true }
  | { eligible: false; reason: string };

const CORPUS_TARGET_PATTERN =
  /\b(?:this|the|current|selected)\s+(?:collection|tag)\b|\bmy\s+library\b|\b(?:whole|entire)\s+library\b|\ball\s+(?:papers?|items?|articles?|studies)\b|\b(?:literature|lit)\s+review\b|\breview\s+of\s+(?:the\s+)?literature\b|\b(?:synthesi[sz]e|survey)\b.*\b(?:papers?|articles?|studies|findings?|research|literature|collection|tag|library)\b|\b(?:these|selected)\s+(?:papers?|articles?|studies)\b/i;

const LIBRARY_CORPUS_INTENT_PATTERN =
  /\b(?:library|collection|tag|all papers?|all items?|my papers?|whole|entire)\b|\b(?:literature|lit)\s+review\b|\breview\s+of\s+(?:the\s+)?literature\b|\b(?:synthesi[sz]e|survey)\b.*\b(?:research|papers?|articles?|studies|findings?|literature)\b/i;

const SINGLE_PAPER_TARGET_PATTERN =
  /\b(?:this|the|current|selected)\s+(?:paper|article|study|document)\b/i;

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
  for (const entry of request.turnPaperScope.papers) {
    addPaperKey(paperKeys, entry.paper);
  }

  const userText = request.userText || "";
  const uniquePaperCount = paperKeys.size;
  const corpusTargetedByText = CORPUS_TARGET_PATTERN.test(userText);
  const singlePaperTargetedByText = SINGLE_PAPER_TARGET_PATTERN.test(userText);
  const hasLibraryCorpus = Boolean(
    request.turnPaperScope.collections.length ||
    request.turnPaperScope.tags.length ||
    LIBRARY_CORPUS_INTENT_PATTERN.test(userText),
  );
  const hasNoteContext = Boolean(
    request.activeNoteContext ||
    hasNoteTextSelection(request.selectedTextSources),
  );

  return {
    uniquePaperCount,
    hasSinglePaper: uniquePaperCount === 1,
    hasPaperSet: uniquePaperCount >= 2,
    hasLibraryCorpus,
    hasNoteContext,
    corpusTargetedByText,
    singlePaperTargetedByText,
  };
}

export function getSkillContextEligibility(
  _skill: AgentSkill,
  _request: SkillRoutingRequest,
): SkillContextEligibility {
  return { eligible: true };
}

export function isSkillContextEligible(
  _skill: AgentSkill,
  _request: SkillRoutingRequest,
): boolean {
  return true;
}
