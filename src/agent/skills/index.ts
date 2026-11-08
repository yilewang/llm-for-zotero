/**
 * Agent Skills — file-driven guidance instructions.
 *
 * Each skill is a native Agent Skill `SKILL.md` file with a concise
 * description, deterministic context requirements, and a body instruction.
 *
 * Built-in skills are bundled at compile time and copied to the user's
 * data directory on first run. The user folder is the sole source of
 * truth — the agent reads only from there.
 *
 * Users can create, edit, or delete skills by managing:
 *   {Zotero profile runtime root}/.agents/skills/<skill-id>/SKILL.md
 */
import { parseSkill } from "./skillLoader";
import type { AgentSkill } from "./skillLoader";
import { getAllSkills } from "./catalog";
export { getAllSkills, setUserSkills } from "./catalog";
import type { SkillRoutingRequest } from "./contextEligibility";
import libraryAnalysisRaw from "./library-analysis.md";
import comparePapersRaw from "./compare-papers.md";
import analyzeFiguresRaw from "./analyze-figures.md";
import evidenceBasedQaRaw from "./evidence-based-qa.md";
import writeNoteRaw from "./write-note.md";
import literatureReviewRaw from "./literature-review.md";
import importCitedReferenceRaw from "./import-cited-reference.md";
import reorganizeLibraryRaw from "./reorganize-library.md";
import zoteroScriptRaw from "./zotero-script.md";
import { resolveSkillRouting } from "./routing";

export { getSkillRoutingDiagnostics, parseSkill } from "./skillLoader";
export {
  getSkillContextEligibility,
  isSkillContextEligible,
  resolveSkillRequestContext,
} from "./contextEligibility";
export type {
  AgentSkill,
  SkillActivationMode,
  SkillContextKind,
} from "./skillLoader";
export type {
  SkillContextEligibility,
  SkillRequestContext,
  SkillRoutingRequest,
} from "./contextEligibility";
export {
  resolveSkillRouting,
  resolveSkillDirectiveText,
  prependNativeSkillMention,
} from "./routing";
export type {
  SkillRequestedScope,
  SkillRoutingReceipt,
  ValidatedSkillActivation,
} from "./routingTypes";
export type {
  SkillRoutingResolution,
  SkillDirectiveTextResolution,
} from "./routing";
export {
  buildSkillInventory,
  fingerprintSkillInstruction,
  loadSkill,
} from "./progressiveLoading";
export type {
  LoadedSkill,
  LoadedSkillRecord,
  SkillInventoryEntry,
} from "./progressiveLoading";

/**
 * Built-in skill files bundled at compile time.
 * Used by initUserSkills() to copy defaults to the user folder.
 */
export const BUILTIN_SKILL_FILES: Record<string, string> = {
  "library-analysis.md": libraryAnalysisRaw,
  "compare-papers.md": comparePapersRaw,
  "analyze-figures.md": analyzeFiguresRaw,
  "evidence-based-qa.md": evidenceBasedQaRaw,
  "write-note.md": writeNoteRaw,
  "literature-review.md": literatureReviewRaw,
  "import-cited-reference.md": importCitedReferenceRaw,
  "reorganize-library.md": reorganizeLibraryRaw,
  "zotero-script.md": zoteroScriptRaw,
};

/** Set of filenames that are built-in (shipped with the plugin). */
export const BUILTIN_SKILL_FILENAMES = new Set(
  Object.keys(BUILTIN_SKILL_FILES),
);

/**
 * Returns the parsed instruction body of a shipped built-in skill.
 * Used to compare against on-disk versions for the source badge.
 */
export function getBuiltinSkillInstruction(
  filename: string,
): string | undefined {
  const raw = BUILTIN_SKILL_FILES[filename];
  if (!raw) return undefined;
  return parseSkill(raw).instruction;
}

/** Return the shipped instruction for a built-in skill ID. */
export function getBuiltinSkillInstructionById(
  skillId: string,
): string | undefined {
  for (const raw of Object.values(BUILTIN_SKILL_FILES)) {
    const skill = parseSkill(raw);
    if (skill.id === skillId) return skill.instruction;
  }
  return undefined;
}

/**
 * Resolves explicit choices with stored Plan bindings. No model call selects
 * skills; the main model loads other guidance through `load_skill`.
 *
 * Sources of activation, unioned:
 *   1. `forcedSkillIds` — explicit user selection from the slash menu.
 *   2. Stored Plan skill IDs passed in via `classifiedIds`.
 */
export function getMatchedSkillIds(
  request: SkillRoutingRequest &
    Pick<import("../types").AgentRuntimeRequest, "forcedSkillIds">,
  classifiedIds?: ReadonlyArray<string>,
): string[] {
  return resolveSkillRouting(request, getAllSkills(), classifiedIds)
    .matchedSkillIds;
}
