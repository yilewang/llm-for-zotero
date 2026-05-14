import type { AgentRuntimeRequest } from "../types";

/**
 * A skill is a file-driven guidance instruction that gets injected into the
 * agent current-turn guidance when the user's message matches one of its patterns.
 *
 * Skills are defined as `.md` files with frontmatter:
 *
 * ```markdown
 * ---
 * id: my-skill
 * match: /regex pattern/i
 * match: /another pattern/i
 * ---
 *
 * Instruction body (markdown) injected into current-turn guidance.
 * ```
 */
export type AgentSkill = {
  id: string;
  description: string;
  version: number;
  patterns: RegExp[];
  instruction: string;
  /** Set at load time by userSkills.ts based on filename + content comparison. */
  source: "system" | "customized" | "personal";
};

/**
 * Parse a raw `.md` skill file into an AgentSkill.
 * Frontmatter is delimited by `---` lines. Supported keys:
 * - `id: <string>`          — unique skill identifier
 * - `match: /<regex>/<flags>` — pattern to match against userText (repeatable, OR semantics)
 */
export function parseSkill(raw: string): AgentSkill {
  const lines = raw.split("\n");
  let inFrontmatter = false;
  let frontmatterEnd = 0;
  const fmLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "---") {
      if (!inFrontmatter) {
        inFrontmatter = true;
        continue;
      }
      frontmatterEnd = i + 1;
      break;
    }
    if (inFrontmatter) {
      fmLines.push(trimmed);
    }
  }

  let id = "unknown";
  let description = "";
  let version = 0;
  const patterns: RegExp[] = [];

  for (const line of fmLines) {
    const idMatch = line.match(/^id:\s*(.+)$/);
    if (idMatch) {
      id = idMatch[1].trim();
      continue;
    }
    const descMatch = line.match(/^description:\s*(.+)$/);
    if (descMatch) {
      description = descMatch[1].trim();
      continue;
    }
    const versionMatch = line.match(/^version:\s*(\d+)$/);
    if (versionMatch) {
      version = parseInt(versionMatch[1], 10);
      continue;
    }
    // Skip name: lines (legacy, no longer used)
    if (/^name:\s/.test(line)) continue;
    const matchMatch = line.match(/^match:\s*\/(.+)\/([gimsuy]*)$/);
    if (matchMatch) {
      try {
        patterns.push(new RegExp(matchMatch[1], matchMatch[2]));
      } catch {
        // Skip invalid regex
      }
    }
  }

  const instruction = lines.slice(frontmatterEnd).join("\n").trim();

  return {
    id,
    description,
    version,
    patterns,
    instruction,
    source: "personal",
  };
}

/**
 * Test whether a skill's patterns match the user's request text.
 * Returns true if any pattern matches (OR semantics).
 */
export function matchesSkill(
  skill: AgentSkill,
  request: Pick<AgentRuntimeRequest, "userText">,
): boolean {
  const text = (request.userText || "").trim();
  if (!text || !skill.patterns.length) return false;
  return skill.patterns.some((pattern) => pattern.test(text));
}
