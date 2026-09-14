import type { AgentRuntimeRequest } from "../types";

/**
 * A skill is a file-driven guidance instruction that gets injected into the
 * agent current-turn guidance after contextual eligibility and semantic routing.
 *
 * Skills are defined as `.md` files with frontmatter:
 *
 * ```markdown
 * ---
 * id: my-skill
 * contexts: single-paper
 * activation: auto
 * ---
 *
 * Instruction body (markdown) injected into current-turn guidance.
 * ```
 */
export type AgentSkill = {
  id: string;
  description: string;
  version: number;
  contexts: SkillContextKind[];
  activation: SkillActivationMode;
  supersedes: string[];
  instruction: string;
  /** Set at load time by userSkills.ts based on filename + content comparison. */
  source: "system" | "customized" | "personal";
};

export type SkillContextKind =
  | "any"
  | "single-paper"
  | "paper-set"
  | "library-corpus"
  | "note"
  | "visual-input";

export type SkillActivationMode = "auto" | "manual" | "both";

const VALID_CONTEXTS = new Set<SkillContextKind>([
  "any",
  "single-paper",
  "paper-set",
  "library-corpus",
  "note",
  "visual-input",
]);

const VALID_ACTIVATIONS = new Set<SkillActivationMode>([
  "auto",
  "manual",
  "both",
]);

function parseSkillContexts(raw: string): SkillContextKind[] {
  const contexts = raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part): part is SkillContextKind =>
      VALID_CONTEXTS.has(part as SkillContextKind),
    );
  return contexts.length ? Array.from(new Set(contexts)) : ["any"];
}

function parseSkillActivation(raw: string): SkillActivationMode {
  const normalized = raw.trim().toLowerCase();
  return VALID_ACTIVATIONS.has(normalized as SkillActivationMode)
    ? (normalized as SkillActivationMode)
    : "auto";
}

/**
 * Parse a raw `.md` skill file into an AgentSkill.
 * Frontmatter is delimited by `---` lines. Supported keys:
 * - `id: <string>`          — unique skill identifier
 * - `contexts: <context>[,<context>]` — request contexts where the skill is valid
 * - `activation: auto|manual|both` — whether the skill can activate automatically
 * - `supersedes: <id>[,<id>]` — automatic skills this workflow replaces
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
  let name = "";
  let description = "";
  let version = 0;
  let contexts: SkillContextKind[] = ["any"];
  let activation: SkillActivationMode = "auto";
  let supersedes: string[] = [];

  for (const line of fmLines) {
    const idMatch = line.match(/^id:\s*(.+)$/);
    if (idMatch) {
      id = idMatch[1].trim();
      continue;
    }
    const nameMatch = line.match(/^name:\s*(.+)$/);
    if (nameMatch) {
      name = nameMatch[1].trim();
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
    const contextsMatch = line.match(/^contexts:\s*(.+)$/);
    if (contextsMatch) {
      contexts = parseSkillContexts(contextsMatch[1]);
      continue;
    }
    const activationMatch = line.match(/^activation:\s*(.+)$/);
    if (activationMatch) {
      activation = parseSkillActivation(activationMatch[1]);
      continue;
    }
    const supersedesMatch = line.match(/^supersedes:\s*(.+)$/);
    if (supersedesMatch) {
      supersedes = Array.from(
        new Set(
          supersedesMatch[1]
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
        ),
      );
      continue;
    }
  }
  if (id === "unknown" && name) {
    id = name;
  }

  const instruction = lines.slice(frontmatterEnd).join("\n").trim();

  return {
    id,
    description,
    version,
    contexts,
    activation,
    supersedes,
    instruction,
    source: "personal",
  };
}

export function getSkillRoutingDiagnostics(skill: AgentSkill): string[] {
  const diagnostics: string[] = [];
  const description = skill.description.trim();
  const normalizedDescription = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  const normalizedId = skill.id.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (
    skill.activation !== "manual" &&
    (!description ||
      description.replace(/\s+/g, "").length < 20 ||
      normalizedDescription === normalizedId ||
      /describe what this skill does/i.test(description))
  ) {
    diagnostics.push(
      "Automatic activation needs a precise description of the workflow and its intended requests.",
    );
  }
  return diagnostics;
}
