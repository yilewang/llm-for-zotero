import { sanitizeText } from "../textUtils";

/**
 * Returns true when there is definitively nothing for the agent to retrieve.
 * The loop exits immediately with zero LLM calls when this returns true.
 *
 * Rules (checked in order):
 * - Empty question → skip.
 * - Images attached → skip.  All agent tools operate on text; a vision
 *   question cannot benefit from read_paper_text / list_papers.
 * - Active paper present → do NOT skip (may want to read additional papers).
 * - Existing paper contexts → do NOT skip.
 * - Library available → do NOT skip.
 * - Nothing at all → skip.
 */
export function shouldSkipAgent(params: {
  question: string;
  libraryID: number;
  hasActivePaper: boolean;
  hasExistingPaperContexts: boolean;
  /** True when the request contains one or more image attachments (figures, screenshots, etc.). */
  hasImages?: boolean;
}): boolean {
  if (!sanitizeText(params.question || "").trim()) return true;
  if (params.hasImages) return true;
  if (params.hasActivePaper) return false;
  if (params.hasExistingPaperContexts) return false;
  if (params.libraryID > 0) return false;
  return true;
}
