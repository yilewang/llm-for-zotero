import { BUILTIN_SKILL_FILES } from "../../agent/skills";
import { initUserSkills } from "../../agent/skills/userSkills";

/**
 * Workflow-test hooks for the user skills folder. The test bundler has no
 * loader for the skill markdown, so a test file cannot import the built-in
 * skills or `initUserSkills`; the plugin's own module instance runs them.
 */
export async function runUserSkillsInit(): Promise<void> {
  await initUserSkills();
}

export function readBuiltinSkillFiles(): Record<string, string> {
  return { ...BUILTIN_SKILL_FILES };
}
