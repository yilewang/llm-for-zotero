/**
 * Skill intent classifier — runs ONCE per user turn.
 *
 * Architecture note: when the user sends a message, this module is called
 * exactly once (before the agent loop starts) to decide which skills apply.
 * The returned skill IDs flow into the system prompt, and that system prompt
 * is reused across every model inference the agent performs to fulfil the
 * request. There is no per-model-call classifier cost.
 *
 * The classifier uses the user's configured primary model (via
 * `request.model` / `request.apiBase` / `request.apiKey`) and a small
 * structured prompt listing each skill's `id` + `description`. On any error
 * — network failure, malformed JSON, unconfigured model — it falls back to
 * the per-skill regex `match:` patterns so the agent still works.
 */
import { callLLM } from "../../utils/llmClient";
import { matchesSkill } from "../skills/skillLoader";
import type { AgentSkill } from "../skills/skillLoader";
import type { AgentRuntimeRequest } from "../types";

/**
 * Pseudo-skill ID the classifier can return when none of the real skills
 * apply. Giving the LLM an explicit "no-match" label to commit to works
 * better than asking it to return an empty array — empty arrays read as
 * uncertainty and bias the LLM toward populating them with weak matches.
 * Translated back to `[]` by `parseClassifierResponse`.
 */
const UNMATCHED_ID = "unmatched";

/**
 * Classify which skills apply to the given request.
 *
 * Returns a list of skill IDs drawn from `skills`. Never throws — any
 * failure falls back to regex matching.
 */
export async function detectSkillIntent(
  request: AgentRuntimeRequest,
  skills: AgentSkill[],
  signal?: AbortSignal,
): Promise<string[]> {
  if (skills.length === 0) return [];
  const userText = (request.userText || "").trim();
  if (!userText) return regexFallback(skills, request);
  if (!request.model || !request.apiBase) {
    return regexFallback(skills, request);
  }

  const prompt = buildClassifierPrompt(skills, request);

  let raw: string;
  try {
    raw = await callLLM({
      prompt,
      model: request.model,
      apiBase: request.apiBase,
      apiKey: request.apiKey,
      authMode: request.authMode,
      providerProtocol: request.providerProtocol,
      temperature: 0,
      maxTokens: 200,
      signal,
    });
  } catch (err) {
    Zotero.debug?.(
      `[llm-for-zotero] Skill classifier LLM call failed, falling back to regex: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return regexFallback(skills, request);
  }

  const parsed = parseClassifierResponse(raw, skills);
  if (parsed === null) {
    Zotero.debug?.(
      `[llm-for-zotero] Skill classifier returned malformed JSON, falling back to regex. Raw: ${raw.slice(0, 200)}`,
    );
    return regexFallback(skills, request);
  }
  return parsed;
}

function regexFallback(
  skills: AgentSkill[],
  request: Pick<AgentRuntimeRequest, "userText">,
): string[] {
  return skills
    .filter((skill) => matchesSkill(skill, request))
    .map((skill) => skill.id);
}

function buildClassifierPrompt(
  skills: AgentSkill[],
  request: AgentRuntimeRequest,
): string {
  const skillList = [
    `- ${UNMATCHED_ID}: Select this when the user's task is a direct Zotero operation (running a script, editing metadata, tagging, moving items) or otherwise does not clearly require any skill's specific playbook. Prefer this over a speculative match.`,
    ...skills.map(
      (skill) => `- ${skill.id}: ${skill.description || "(no description)"}`,
    ),
  ].join("\n");

  const context: string[] = [];
  context.push(
    request.activeItemId
      ? "- Active paper: yes (paper-chat mode)"
      : "- Active paper: no (library-chat mode)",
  );
  if (request.activeNoteContext) context.push("- Active note present: yes");
  if (request.selectedTexts?.length)
    context.push(`- Selected text snippets: ${request.selectedTexts.length}`);
  if (request.screenshots?.length)
    context.push(`- Screenshots attached: ${request.screenshots.length}`);
  if (request.fullTextPaperContexts?.length)
    context.push(
      `- Full-text papers marked: ${request.fullTextPaperContexts.length}`,
    );

  return [
    "You are a skill router for a Zotero research-assistant agent. Return a JSON array of skill IDs drawn from the list below.",
    "",
    `• Use ["${UNMATCHED_ID}"] when the user's task is a direct Zotero operation or does not clearly require any skill's playbook. This is the correct answer for most turns.`,
    "• Only include a specific skill ID when the user's message unambiguously aligns with that skill's primary purpose. Do not include a skill just because its description shares a word with the user's message.",
    '• When the user\'s message genuinely combines multiple distinct subtasks (e.g. "read this paper, analyze figure 1, and write a note"), return every skill ID that maps to a distinct subtask. Do NOT pad the list with tangentially related skills.',
    "",
    "Available skills:",
    skillList,
    "",
    "Runtime context:",
    ...context,
    "",
    "User message:",
    `"""`,
    request.userText,
    `"""`,
    "",
    'Reply with ONLY a JSON object in this exact shape, no prose, no code fences: {"skillIds": ["id1", "id2"]}',
  ].join("\n");
}

/**
 * Parse the classifier's response into a list of valid skill IDs.
 * Returns null if the response cannot be interpreted (caller falls back to
 * regex). An empty array return is a positive "no skill applies" answer —
 * the caller should NOT fall back in that case.
 */
export function parseClassifierResponse(
  raw: string,
  skills: AgentSkill[],
): string[] | null {
  if (!raw) return null;
  // Tolerate code fences or surrounding prose — extract the first {…} blob.
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const ids = (parsed as { skillIds?: unknown }).skillIds;
  if (!Array.isArray(ids)) return null;

  const validIds = new Set(skills.map((s) => s.id));
  const rawStrings = ids
    .filter((value): value is string => typeof value === "string")
    .map((s) => s.trim());
  const hasUnmatched = rawStrings.includes(UNMATCHED_ID);
  const realIds = rawStrings.filter(
    (id) => id !== UNMATCHED_ID && validIds.has(id),
  );

  // Hedge case: model returned both "unmatched" and real skill IDs. Trust
  // the real picks — the model found something worth loading. Drop
  // "unmatched".
  if (realIds.length > 0) return realIds;
  // Explicit no-match: model chose only "unmatched", or returned an empty
  // array. Both are valid "no skills apply" responses.
  if (hasUnmatched || rawStrings.length === 0) return [];
  // Fallthrough: only invalid skill IDs (hallucinated names). Treat as
  // unmatched so we don't load anything bogus.
  return [];
}
