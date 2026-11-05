/**
 * What a restart of the provider session carries besides its checkpoint
 * (`restartFromSemanticCheckpoint` in runtime.ts: a long job's page, or a
 * prompt the budget compacts). The restart puts every tool result behind a
 * handle, and the prompt it restarts from was rendered before the turn's
 * first tool call. So two things the model was given mid-turn would be lost
 * with it (eval b4v6, run 2):
 *
 * - each skill it loaded with load_skill: the instructions, and the tool
 *   guidance that came with them. The host records that guidance as
 *   delivered, so loading the skill again returns no guidance;
 * - the item keys of the scope's papers, which it cites papers and records
 *   their decisions by, and which it read from search and digest results.
 *
 * Pure: reads only what it is given.
 */
import type { AgentUserMessage, ExecutionCheckpoint } from "../types";
import type { TaskPaperScopeSet } from "./taskPaperScopeListing";

/** The turn's tool records the carry reads (`ToolExecutionRecord`). */
export type CarriedToolRecord = Readonly<{
  name: string;
  ok: boolean;
  content?: unknown;
}>;

/** The most item keys one restart carries. */
export const CARRIED_ITEM_KEYS_MAX = 200;

const LOAD_SKILL_TOOL_NAME = "load_skill";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The skills the turn loaded with load_skill, as each load returned them,
 * for a restart: none that the rendered prompt already holds (`rendered`).
 * A skill loaded twice keeps its latest instructions and every guidance
 * either load returned. Null when the turn loaded none.
 */
export function buildCarriedSkillsMessage(
  records: readonly CarriedToolRecord[],
  rendered: readonly string[] = [],
): AgentUserMessage | null {
  const skills = new Map<
    string,
    { instructions: string; guidance: string[]; scopeGuard: string }
  >();
  for (const entry of records) {
    if (entry.name !== LOAD_SKILL_TOOL_NAME || !entry.ok) continue;
    const content = record(entry.content);
    if (content.found !== true) continue;
    const id = text(record(content.skill).id);
    const instructions = text(content.instructions);
    if (!id || !instructions || rendered.includes(id)) continue;
    const earlier = skills.get(id);
    const guidance = text(content.toolGuidance);
    skills.delete(id);
    skills.set(id, {
      instructions,
      guidance: [
        ...(earlier?.guidance || []),
        ...(guidance && !earlier?.guidance.includes(guidance)
          ? [guidance]
          : []),
      ],
      scopeGuard: text(content.scopeGuard) || earlier?.scopeGuard || "",
    });
  }
  if (!skills.size) return null;
  const scopeGuard = [...skills.values()].find(
    (skill) => skill.scopeGuard,
  )?.scopeGuard;
  return {
    role: "user",
    transient: true,
    content: [
      "Skills you loaded with load_skill earlier in this turn, carried by the host across a restart of the context. They are still active: follow them, and do not load them again.",
      ...[...skills].map(([id, skill]) =>
        [`### Skill: ${id}`, skill.instructions, ...skill.guidance].join(
          "\n\n",
        ),
      ),
      scopeGuard || "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

/**
 * The item keys of the scope's papers, for a restart: first the papers the
 * model's parts name, then the rest of the scope in its order, at most
 * `CARRIED_ITEM_KEYS_MAX`. Null when the scope holds no key.
 */
export function buildScopeItemKeysMessage(
  scope: TaskPaperScopeSet | undefined,
  libraryID: number | undefined,
  checkpoint: ExecutionCheckpoint | undefined,
): AgentUserMessage | null {
  const papers = scope?.papers;
  if (!papers) return null;
  const named = (checkpoint?.tasks || []).flatMap((task) =>
    task.origin === "model" && !task.supersededBy
      ? (task.targets || []).flatMap((target) => {
          const match = /^item:([1-9]\d*)$/.exec(target);
          return match ? [Number(match[1])] : [];
        })
      : [],
  );
  const keyed = [...new Set([...named, ...(scope.itemIds || [])])].flatMap(
    (itemId) => {
      const key = text(papers[itemId]?.itemKey);
      return key ? [`${itemId}=${key}`] : [];
    },
  );
  if (!keyed.length) return null;
  const listed = keyed.slice(0, CARRIED_ITEM_KEYS_MAX);
  const library =
    typeof libraryID === "number" && libraryID > 0
      ? `, libraryID ${libraryID}`
      : "";
  const more =
    keyed.length > listed.length
      ? ` (${listed.length} of ${keyed.length}; library_search lists the rest)`
      : "";
  return {
    role: "user",
    transient: true,
    content: `Item keys of the papers in this turn's scope (itemId=itemKey${library})${more}, for citation sources and record_paper_decisions: ${listed.join(", ")}`,
  };
}
