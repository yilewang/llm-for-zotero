/**
 * Per-conversation agent turn memory.
 *
 * After each agent turn finishes, a record of the question asked, tools used,
 * and a short excerpt of the answer is stored here.  On subsequent turns the
 * accumulated records are injected into the system prompt so the agent can
 * build on what it already discovered without re-running the same tools.
 */

type TurnMemory = {
  question: string;
  toolsUsed: string[];
  answerExcerpt: string;
};

const MAX_MEMORY_TURNS = 6;
const QUESTION_EXCERPT_LEN = 200;
const ANSWER_EXCERPT_LEN = 350;

const store = new Map<number, TurnMemory[]>();

export function recordAgentTurn(
  conversationKey: number,
  question: string,
  toolsUsed: string[],
  finalAnswer: string,
): void {
  const key = Math.floor(conversationKey);
  if (!Number.isFinite(key) || key <= 0) return;
  const existing = store.get(key) ?? [];
  existing.push({
    question: question.trim().slice(0, QUESTION_EXCERPT_LEN),
    toolsUsed: [...new Set(toolsUsed)],
    answerExcerpt: finalAnswer.trim().slice(0, ANSWER_EXCERPT_LEN),
  });
  store.set(key, existing.slice(-MAX_MEMORY_TURNS));
}

/**
 * Returns a formatted block summarising what the agent found in prior turns,
 * or an empty string when no memory exists for the conversation.
 */
export function buildAgentMemoryBlock(conversationKey: number): string {
  const key = Math.floor(conversationKey);
  if (!Number.isFinite(key) || key <= 0) return "";
  const turns = store.get(key);
  if (!turns?.length) return "";

  const lines: string[] = [
    "Prior findings from this conversation (do not re-run tools for these unless the user asks you to update them):",
  ];
  for (const turn of turns) {
    lines.push(`- User asked: "${turn.question}${turn.question.length >= QUESTION_EXCERPT_LEN ? "…" : ""}"`);
    if (turn.toolsUsed.length) {
      lines.push(`  Tools used: ${turn.toolsUsed.join(", ")}`);
    }
    lines.push(
      `  Finding: ${turn.answerExcerpt}${turn.answerExcerpt.length >= ANSWER_EXCERPT_LEN ? "…" : ""}`,
    );
  }
  return lines.join("\n");
}

export function clearAgentMemory(conversationKey: number): void {
  store.delete(Math.floor(conversationKey));
}
