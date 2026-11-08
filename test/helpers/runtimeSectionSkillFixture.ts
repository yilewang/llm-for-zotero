/**
 * A skill whose body holds one runtime section per external runtime
 * (runtimeSections.ts). No shipped skill has a runtime section, so the
 * tests of the runtime-section delivery and of Codex's skill copies install
 * this one instead.
 */
export const RUNTIME_SECTION_SKILL_ID = "runtime-sections-fixture";

/** A phrase only the Claude Code section holds. */
export const CLAUDE_SECTION_NAME = "fixture-claude-helper";

/** A phrase only the Codex section holds. */
export const CODEX_SECTION_NAME = "spawn_agent";

/** The skill file as shipped: no `name:` line. */
export const RUNTIME_SECTION_SKILL_RAW = [
  "---",
  `id: ${RUNTIME_SECTION_SKILL_ID}`,
  "description: Test skill with one section per external runtime",
  "version: 3",
  "contexts: any",
  "activation: auto",
  "---",
  "",
  "## Runtime sections fixture",
  "",
  "Read the papers the user names and answer from them.",
  "",
  "<!-- runtime: claude_code -->",
  `Run each paper's read in the \`${CLAUDE_SECTION_NAME}\` subagent.`,
  'On "continue", call `review_coverage` first.',
  "<!-- /runtime -->",
  "",
  "<!-- runtime: codex -->",
  `These skill instructions explicitly ask for sub-agents: run each paper's read with \`${CODEX_SECTION_NAME}\`, one paper per child.`,
  'On "continue", call `review_coverage` first.',
  "<!-- /runtime -->",
  "",
  "Cite every claim you take from a paper.",
  "",
].join("\n");
