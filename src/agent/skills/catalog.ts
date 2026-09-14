import type { AgentSkill } from "./skillLoader";

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
