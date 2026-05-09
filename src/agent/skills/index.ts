/**
 * Agent Skills — file-driven guidance instructions.
 *
 * Each skill is a `.md` file with frontmatter match patterns and a body
 * instruction. When a user's message matches a skill's patterns, the
 * instruction is injected into the agent system prompt alongside tool
 * guidances.
 *
 * Built-in skills are bundled at compile time and copied to the user's
 * data directory on first run. The user folder is the sole source of
 * truth — the agent reads only from there.
 *
 * Users can create, edit, or delete skills by managing `.md` files in:
 *   {Zotero data directory}/llm-for-zotero/skills/
 */
import { matchesSkill, parseSkill } from "./skillLoader";
import type { AgentSkill } from "./skillLoader";
import {
  isNotesDirectoryConfigured,
  getNotesDirectoryNickname,
} from "../../utils/notesDirectoryConfig";
import libraryAnalysisRaw from "./library-analysis.md";
import comparePapersRaw from "./compare-papers.md";
import analyzeFiguresRaw from "./analyze-figures.md";
import simplePaperQaRaw from "./simple-paper-qa.md";
import evidenceBasedQaRaw from "./evidence-based-qa.md";
import writeNoteRaw from "./write-note.md";
import literatureReviewRaw from "./literature-review.md";
import importCitedReferenceRaw from "./import-cited-reference.md";

export { matchesSkill, parseSkill } from "./skillLoader";
export type { AgentSkill } from "./skillLoader";

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
 * Skills loaded from the user's data directory.
 * This is the sole source of truth — the agent reads only from here.
 */
let skills: AgentSkill[] = [];

/**
 * Replace the current set of skills.
 * Called once at plugin startup after scanning the user skills directory.
 */
export function setUserSkills(loaded: AgentSkill[]): void {
  skills = loaded;
}

/**
 * Returns all skills loaded from the user folder.
 * This is the primary accessor used by messageBuilder and trace events.
 */
export function getAllSkills(): AgentSkill[] {
  return skills;
}

/**
 * Runtime-context signals that force specific skill IDs to activate even if
 * the user's text wouldn't otherwise match. Returned as a Set so callers can
 * union it with regex/forcedIds without duplicates.
 *
 * Current rules:
 * - Notes-directory nickname mentioned in userText → force `write-note`.
 */
function computeContextForcedSkillIds(
  request: Pick<import("../types").AgentRuntimeRequest, "userText">,
): Set<string> {
  const forced = new Set<string>();
  const nickname = getNotesDirectoryNickname().trim();
  if (nickname && isNotesDirectoryConfigured() && request.userText) {
    const escaped = nickname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const isAscii = /^[\x20-\x7E]+$/.test(nickname);
    const pattern = isAscii
      ? new RegExp(`\\b${escaped}\\b`, "i")
      : new RegExp(escaped, "i");
    if (pattern.test(request.userText)) {
      forced.add("write-note");
    }
  }
  return forced;
}

/**
 * Returns the IDs of all skills that should activate for the given request.
 * Called once per user turn (NOT per model inference inside the agent loop).
 * The result is (a) fed into messageBuilder to filter which skill
 * instructions get injected into the system prompt, and (b) emitted as
 * trace events.
 *
 * Sources of activation, unioned:
 *   1. `forcedSkillIds` — explicit user selection from the slash menu.
 *   2. Runtime-context rules — e.g. notes-directory nickname mentioned.
 *   3. Either (a) the LLM classifier output passed in via `classifiedIds`,
 *      or (b) regex `match:` patterns as the fallback when no classifier
 *      result is available.
 */
export function getMatchedSkillIds(
  request: Pick<
    import("../types").AgentRuntimeRequest,
    "userText" | "forcedSkillIds"
  >,
  classifiedIds?: ReadonlyArray<string>,
): string[] {
  const forcedIds = new Set(request.forcedSkillIds || []);
  const contextForced = computeContextForcedSkillIds(request);
  const baseMatched =
    classifiedIds !== undefined
      ? new Set(classifiedIds)
      : new Set(
          getAllSkills()
            .filter((skill) => matchesSkill(skill, request))
            .map((skill) => skill.id),
        );
  return getAllSkills()
    .filter(
      (skill) =>
        forcedIds.has(skill.id) ||
        contextForced.has(skill.id) ||
        baseMatched.has(skill.id),
    )
    .map((skill) => skill.id);
}
