/**
 * Shallow-answer guard helpers for collection/tag-scoped turns.
 *
 * The runtime uses these to decide whether a final answer was produced
 * without touching library evidence, mirroring the full-read correction
 * pattern: prompt guidance sets the norm, this guard enforces the floor
 * once per run regardless of which model is driving.
 */
import type { AgentRuntimeRequest } from "../types";

const EN_EVIDENCE_CUE_PATTERN =
  /\b(?:which|what|how many|list|summari[sz]e|overview|compare|contrast|themes?|evidence|find|discuss|mention)\b/i;
// No \b for CJK — word boundaries do not exist between CJK codepoints.
const CJK_EVIDENCE_CUE_PATTERN =
  /(?:哪些|什么|多少|总结|概述|比较|综述|列出|讨论|要約|まとめ|比較|どの|なに|요약|비교|어떤|무엇)/u;

/**
 * Is this turn asking a question that needs library evidence? The classifier
 * verdict wins when present; otherwise a permissive multilingual heuristic
 * (question mark or interrogative/synthesis cue words) decides.
 */
export function isEvidenceSeekingTurn(
  request: Pick<AgentRuntimeRequest, "userText" | "classifiedIntent">,
): boolean {
  const classified = request.classifiedIntent;
  if (classified) return classified.retrievalIntent !== "none";
  const text = (request.userText || "").trim();
  if (!text) return false;
  if (/[?？]\s*$/.test(text)) return true;
  return (
    EN_EVIDENCE_CUE_PATTERN.test(text) || CJK_EVIDENCE_CUE_PATTERN.test(text)
  );
}

export type LibraryRetrieveShallowSignal = {
  /** Any successful model-visible evidence-read tool ran this turn. */
  ranRetrieveFamily: boolean;
  /** The LAST successful library_retrieve read zero body evidence while readable papers existed. */
  lastRetrieveShallow: boolean;
};

// Model-visible evidence-read tools; search_paper/read_paper are registered
// internal-only and never appear in model-driven runs.
const RETRIEVE_FAMILY_TOOLS = new Set([
  "library_retrieve",
  "paper_read",
  "library_search",
  "library_read",
  "literature_search",
]);

const CORRECTION_MARKER = "Correction for this turn:";
const CHECKPOINT_TOOLS_MARKER = "Earlier tools used:";

/**
 * Did earlier turns of this conversation already read evidence? Checks raw
 * tool messages, the compaction checkpoint's tool summary line, and prior
 * shallow-correction markers — a follow-up answered from transcript evidence
 * must not be rolled back again.
 */
export function transcriptShowsEvidenceReads(
  messages: ReadonlyArray<{
    role: string;
    name?: string;
    content?: unknown;
  }>,
): boolean {
  for (const message of messages) {
    if (
      message.role === "tool" &&
      message.name &&
      RETRIEVE_FAMILY_TOOLS.has(message.name)
    ) {
      return true;
    }
    const content = typeof message.content === "string" ? message.content : "";
    if (!content) continue;
    if (content.includes(CORRECTION_MARKER)) return true;
    if (content.includes(CHECKPOINT_TOOLS_MARKER)) {
      for (const tool of RETRIEVE_FAMILY_TOOLS) {
        if (content.includes(tool)) return true;
      }
    }
  }
  return false;
}

export function findLibraryRetrieveShallowSignal(
  records: ReadonlyArray<{ name: string; ok: boolean; content?: unknown }>,
): LibraryRetrieveShallowSignal {
  let ranRetrieveFamily = false;
  let lastRetrieveShallow = false;
  for (const record of records) {
    if (!record.ok) continue;
    if (RETRIEVE_FAMILY_TOOLS.has(record.name)) ranRetrieveFamily = true;
    if (record.name !== "library_retrieve") continue;
    const content = record.content as {
      answerContract?: { papersBodyRead?: unknown; papersPlanned?: unknown };
      resourcePool?: { states?: { textAvailable?: unknown } };
    } | null;
    const papersBodyRead = Number(content?.answerContract?.papersBodyRead);
    const papersPlanned = Number(content?.answerContract?.papersPlanned);
    const textAvailable = Number(content?.resourcePool?.states?.textAvailable);
    lastRetrieveShallow =
      Number.isFinite(papersBodyRead) &&
      papersBodyRead === 0 &&
      Number.isFinite(papersPlanned) &&
      papersPlanned > 0 &&
      Number.isFinite(textAvailable) &&
      textAvailable > 0;
  }
  return { ranRetrieveFamily, lastRetrieveShallow };
}
