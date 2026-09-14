/**
 * Agent Skills — file-driven guidance instructions.
 *
 * Each skill is a native Agent Skill `SKILL.md` file with a semantic
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
import simplePaperQaRaw from "./simple-paper-qa.md";
import evidenceBasedQaRaw from "./evidence-based-qa.md";
import writeNoteRaw from "./write-note.md";
import literatureReviewRaw from "./literature-review.md";
import importCitedReferenceRaw from "./import-cited-reference.md";
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
  PlanSkillRoutingReceipt,
  SkillRequestedScope,
  SkillRouterResponseV1,
  SkillRoutingReceipt,
  ValidatedSkillActivation,
} from "./routingTypes";
export type {
  SkillRoutingResolution,
  SkillDirectiveTextResolution,
} from "./routing";

/**
 * Built-in skill files bundled at compile time.
 * Used by initUserSkills() to copy defaults to the user folder.
 */
export const BUILTIN_SKILL_FILES: Record<string, string> = {
  "library-analysis.md": libraryAnalysisRaw,
  "compare-papers.md": comparePapersRaw,
  "analyze-figures.md": analyzeFiguresRaw,
  "simple-paper-qa.md": simplePaperQaRaw,
  "evidence-based-qa.md": evidenceBasedQaRaw,
  "write-note.md": writeNoteRaw,
  "literature-review.md": literatureReviewRaw,
  "import-cited-reference.md": importCitedReferenceRaw,
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

/**
 * Returns the IDs of all skills that should activate for the given request.
 * Called once per user turn (NOT per model inference inside the agent loop).
 * The result is (a) fed into messageBuilder to filter which skill
 * instructions get injected into current-turn guidance, and (b) emitted as
 * trace events.
 *
 * Sources of activation, unioned:
 *   1. `forcedSkillIds` — explicit user selection from the slash menu.
 *   2. Validated semantic router output passed in via `classifiedIds`.
 * Missing router output intentionally activates no automatic skills.
 */
export function getMatchedSkillIds(
  request: SkillRoutingRequest &
    Pick<import("../types").AgentRuntimeRequest, "forcedSkillIds">,
  classifiedIds?: ReadonlyArray<string>,
): string[] {
  return resolveSkillRouting(request, getAllSkills(), classifiedIds)
    .matchedSkillIds;
}
