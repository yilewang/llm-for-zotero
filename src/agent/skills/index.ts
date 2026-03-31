/**
 * Agent Skills — file-driven guidance instructions.
 *
 * Each skill is a `.md` file with frontmatter match patterns and a body
 * instruction. When a user's message matches a skill's patterns, the
 * instruction is injected into the agent system prompt alongside tool
 * guidances.
 *
 * To add a new skill:
 * 1. Create a `.md` file in this directory (use existing skills as templates).
 * 2. Import it below and add it to the AGENT_SKILLS array.
 */
import { parseSkill, matchesSkill } from "./skillLoader";
import libraryAnalysisRaw from "./library-analysis.md";
import comparePapersRaw from "./compare-papers.md";
import analyzeFiguresRaw from "./analyze-figures.md";

export { matchesSkill } from "./skillLoader";
export type { AgentSkill } from "./skillLoader";

export const AGENT_SKILLS = [
  parseSkill(libraryAnalysisRaw),
  parseSkill(comparePapersRaw),
  parseSkill(analyzeFiguresRaw),
];

/**
 * Returns the IDs of all skills whose patterns match the request.
 * Used by the runtime to emit trace events for matched skills.
 */
export function getMatchedSkillIds(
  request: Pick<import("../types").AgentRuntimeRequest, "userText">,
): string[] {
  return AGENT_SKILLS.filter((skill) => matchesSkill(skill, request)).map(
    (skill) => skill.id,
  );
}
