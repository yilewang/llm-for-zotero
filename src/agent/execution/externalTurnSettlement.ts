/**
 * How a turn run by a connected client ends: one rule for the Claude bridge
 * and native Codex.
 *
 * Both owners finish a turn the same way. The turn's own receipts decide
 * whether the action it owed is proved. A finalized document, when the turn
 * has one, is the answer the reader sees. An unproved action replaces the
 * answer with the failure, or follows the document with it, and the run is
 * stored as failed. This module decides only that. Each owner keeps its own
 * I/O: which document applies and how it is keyed, the event that reports an
 * unverified completion (each owner names its payload field), any provider
 * thread cleanup, and the call that seals the run.
 */
import type { AgentActionReceipt } from "../contracts/types";
import { evaluatePreparedActionContract } from "../contracts/actionEvaluation";

/** The document a turn finalized, as much of it as its answer needs. */
export type ExternalTurnDocument = {
  visibleMarkdown: string;
  documentId: string;
};

export type ExternalTurnSettlement = {
  /** The status the run is stored with. */
  status: "completed" | "failed";
  /** The turn's final text. */
  text: string;
  /** Present only when the turn has a finalized document. */
  documentId?: string;
  /**
   * The failure text, present only when the turn's receipts do not prove the
   * action it owed.
   */
  unverified?: string;
};

const UNVERIFIED_WITHOUT_DETAIL =
  "The requested action has no verified completion evidence.";

/**
 * Settles the end of an external turn.
 *
 * `answered` says whether the client returned an answer at all; a turn that
 * did not is stored as failed whatever its receipts say. `document` is the
 * finalized document the owner found for this turn, or null when none
 * applies.
 */
export function settleExternalTurn(input: {
  answerText: string;
  answered: boolean;
  document: ExternalTurnDocument | null;
  hostReceipts: AgentActionReceipt[];
}): ExternalTurnSettlement {
  const { document } = input;
  const evaluation = evaluatePreparedActionContract(input.hostReceipts);
  const unverified =
    evaluation.state !== "satisfied" && evaluation.state !== "cancelled"
      ? evaluation.failure || UNVERIFIED_WITHOUT_DETAIL
      : undefined;
  const text =
    unverified !== undefined
      ? document
        ? `${document.visibleMarkdown}\n\n${unverified}`
        : unverified
      : document
        ? document.visibleMarkdown
        : input.answerText;
  return {
    status: input.answered && unverified === undefined ? "completed" : "failed",
    text,
    ...(document ? { documentId: document.documentId } : {}),
    ...(unverified !== undefined ? { unverified } : {}),
  };
}
