import type { PaperContextRef, SelectedTextSource } from "../../shared/types";
import type { AgentRuntimeRequest } from "../types";
import type { AgentSkill, SkillContextKind } from "./skillLoader";

const ANY_CONTEXT: SkillContextKind[] = ["any"];

export type SkillRoutingRequest = Pick<
  AgentRuntimeRequest,
  | "userText"
  | "activeNoteContext"
  | "selectedTextSources"
  | "selectedTextPaperContexts"
  | "selectedPaperContexts"
  | "fullTextPaperContexts"
  | "pinnedPaperContexts"
  | "selectedCollectionContexts"
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
  /\b(?:this|the|current|selected)\s+collection\b|\bmy\s+library\b|\b(?:whole|entire)\s+library\b|\ball\s+(?:papers?|items?|articles?|studies)\b|\b(?:literature|lit)\s+review\b|\breview\s+of\s+(?:the\s+)?literature\b|\b(?:synthesi[sz]e|survey)\b.*\b(?:papers?|articles?|studies|findings?|research|literature|collection|library)\b|\b(?:these|selected)\s+(?:papers?|articles?|studies)\b/i;

const LIBRARY_CORPUS_INTENT_PATTERN =
  /\b(?:library|collection|all papers?|all items?|my papers?|whole|entire)\b|\b(?:literature|lit)\s+review\b|\breview\s+of\s+(?:the\s+)?literature\b|\b(?:synthesi[sz]e|survey)\b.*\b(?:research|papers?|articles?|studies|findings?|literature)\b/i;

const SINGLE_PAPER_TARGET_PATTERN =
  /\b(?:this|the|current|selected)\s+(?:paper|article|study|document)\b/i;

function addPaperKey(
  keys: Set<string>,
  entry: PaperContextRef | undefined,
): void {
  if (!entry) return;
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
  for (const entry of request.selectedPaperContexts || [])
    addPaperKey(paperKeys, entry);
  for (const entry of request.fullTextPaperContexts || [])
    addPaperKey(paperKeys, entry);
  for (const entry of request.pinnedPaperContexts || [])
    addPaperKey(paperKeys, entry);
  for (const entry of request.selectedTextPaperContexts || []) {
    addPaperKey(paperKeys, entry);
  }

  const userText = request.userText || "";
  const uniquePaperCount = paperKeys.size;
  const corpusTargetedByText = CORPUS_TARGET_PATTERN.test(userText);
  const singlePaperTargetedByText = SINGLE_PAPER_TARGET_PATTERN.test(userText);
  const hasLibraryCorpus = Boolean(
    request.selectedCollectionContexts?.length ||
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

function contextMatches(
  context: SkillContextKind,
  resolved: SkillRequestContext,
): boolean {
  switch (context) {
    case "any":
      return true;
    case "single-paper":
      if (!resolved.hasSinglePaper) return false;
      return !(
        resolved.corpusTargetedByText && !resolved.singlePaperTargetedByText
      );
    case "paper-set":
      return resolved.hasPaperSet;
    case "library-corpus":
      return resolved.hasLibraryCorpus;
    case "note":
      return resolved.hasNoteContext;
  }
}

function reasonForContexts(
  contexts: ReadonlyArray<SkillContextKind>,
  resolved: SkillRequestContext,
): string {
  if (
    contexts.includes("single-paper") &&
    resolved.hasSinglePaper &&
    resolved.corpusTargetedByText &&
    !resolved.singlePaperTargetedByText
  ) {
    return "Targets collection/library context";
  }
  if (contexts.length === 1) {
    switch (contexts[0]) {
      case "single-paper":
        return "Requires one paper";
      case "paper-set":
        return "Requires multiple papers";
      case "library-corpus":
        return "Requires collection/library context";
      case "note":
        return "Requires note context";
      case "any":
        return "";
    }
  }
  return "Requires matching context";
}

export function getSkillContextEligibility(
  skill: AgentSkill,
  request: SkillRoutingRequest,
): SkillContextEligibility {
  const contexts: SkillContextKind[] = skill.contexts?.length
    ? skill.contexts
    : ANY_CONTEXT;
  const resolved = resolveSkillRequestContext(request);
  if (contexts.some((context) => contextMatches(context, resolved))) {
    return { eligible: true };
  }
  return { eligible: false, reason: reasonForContexts(contexts, resolved) };
}

export function isSkillContextEligible(
  skill: AgentSkill,
  request: SkillRoutingRequest,
): boolean {
  return getSkillContextEligibility(skill, request).eligible;
}
