import type {
  AgentActionReceipt,
  AgentRuntimeRequest,
  AgentToolEffect,
} from "../types";
import {
  assessWebAttribution,
  stripWebSourceMarkersForDisplay,
  type WebAttributionAssessment,
} from "../../webAccess/attribution";
import {
  openDeclaredOutcomes,
  outcomeProgressSignature,
} from "../loop/outcomes";
import { settledTargetCount } from "../loop/longJob";
import { OPEN_PARTS_REASK_LIMIT } from "../loop/turnBoundary";

export type AgentFinalAnswerToolRecord = {
  name: string;
  ok: boolean;
  mutability?: "read" | "write";
  effect?: AgentToolEffect;
  actionReceipts?: readonly AgentActionReceipt[];
  input?: unknown;
  content?: unknown;
  /** For paper_read: whether the read added evidence the turn lacked. */
  frontier?: "advanced" | "unchanged" | "unavailable";
};

export type AgentFinalAnswerDecision =
  | {
      kind: "accept";
      webAttribution: WebAttributionAssessment;
    }
  | {
      kind: "correct";
      correction: string;
      assistantContent?: string;
    }
  | {
      kind: "fail";
      userMessage: string;
    };

const DISCOVERY_INCOMPLETE =
  "The relevant-paper shortlist was not presented for review, so discovery is not complete.";
/** How the model presents a discovery's papers on the selection card. */
const DISCOVERY_CARD_STEPS =
  "Use the active discovery sessionId and revision; select only NEW papers for an expansion. Rank genuinely relevant candidates from the saved literature_search results and call literature_review with the requested number, their candidateSetId/candidateIndex references, relevance reasons and destination. Search further if needed; disclose any genuine shortfall. Do not import silently or finish with recommendations in prose.";
/**
 * The correction for prose after a first batch's paper-finding search: the
 * model, which read the user's request, chooses the card or its answer.
 */
const DISCOVERY_CHOICE = `Your answer was not shown: this turn ran a paper-finding search (workflow:'review'), which leads to the selection card. If the user asked for papers themselves (find, recommend, suggest or list papers; with nothing attached, only if the library holds no relevant papers or the user asks for papers outside it), show them on the card: ${DISCOVERY_CARD_STEPS} Otherwise, do not call literature_review: give your answer again as the final answer; the paper-finding search then closes without a card.`;

/**
 * Applies every runtime-owned final-answer gate through one typed decision.
 * Provider continuation remains outside this class; a correction is an
 * application-owned user message appended after the adapter's cached native
 * final response.
 */
export class AgentFinalAnswerController {
  private webAttributionCorrectionUsed = false;
  private webAttributionFallbackText?: string;
  private readonly literatureReviewCorrections = new Set<string>();
  /** The ledger's progress when the last outcome correction was given. */
  private outcomeCorrectionSignature?: string;
  /**
   * Outcome corrections given since a paper last settled, capped at
   * OPEN_PARTS_REASK_LIMIT; a long job that settles papers between them
   * starts a new count, as it restarts the safety limits.
   */
  private outcomeCorrections = 0;
  /** The settled papers when the last outcome correction was given. */
  private outcomeCorrectionSettled = 0;

  constructor(private readonly request: AgentRuntimeRequest) {}

  async evaluate(params: {
    candidateText: string;
    canCorrect: boolean;
    toolExecutionRecords: readonly AgentFinalAnswerToolRecord[];
    /**
     * The answer was asked for without tools after the search ran out: no
     * correction can send it back to work.
     */
    finalOnly?: boolean;
  }): Promise<AgentFinalAnswerDecision> {
    const unverifiableWrite = params.toolExecutionRecords.find(
      (record) =>
        record.ok &&
        record.mutability === "write" &&
        (record.effect === "applied" || record.effect === "partial") &&
        (!(record.actionReceipts || []).length ||
          (record.actionReceipts || []).some(
            (receipt) =>
              receipt.verification === "unverified" ||
              receipt.status === "unverified",
          )),
    );
    if (unverifiableWrite) {
      return {
        kind: "fail",
        userMessage: `${unverifiableWrite.name} ran, but its concrete effect could not be verified. Inspect current state before retrying it.`,
      };
    }

    const canCorrect = params.canCorrect && !params.finalOnly;
    const outcomeCorrection = this.openOutcomeCorrection(canCorrect);
    if (outcomeCorrection) {
      return { kind: "correct", correction: outcomeCorrection };
    }

    const lastDiscovery = params.toolExecutionRecords.findLastIndex(
      (record) =>
        record.ok &&
        (record.name === "literature_search" ||
          // Retired name, still present in stored tool history.
          record.name === "search_literature_online" ||
          (record.name === "literature_review" &&
            (record.content as { discoveryPhase?: string } | undefined)
              ?.discoveryPhase === "expanding")) &&
        Boolean(
          (record.content as { reviewRequired?: boolean } | undefined)
            ?.reviewRequired,
        ),
    );
    // A discovery ends with the selection card: the host refuses a direct
    // import of its candidates before it runs (discoveryImportRefusal), and
    // a Find more expansion ends only with the card. A first batch may also
    // end with the answer the model chooses after one correction: a
    // paper-finding search on an evidence question must not cost the user
    // the answer. An explicit import searches with workflow:'answer', opens
    // no discovery and needs no card.
    if (
      lastDiscovery >= 0 &&
      !params.toolExecutionRecords
        .slice(lastDiscovery + 1)
        .some((record) => record.ok && record.name === "literature_review")
    ) {
      const discovery = params.toolExecutionRecords[lastDiscovery];
      const pending = discovery.content as
        | { sessionId?: string; revision?: number }
        | undefined;
      const correctionKey = `${pending?.sessionId || "discovery"}:${pending?.revision || 0}`;
      // The user clicked Find more on a card: the last record is that card's
      // expanding result, or a further search at the revision it started.
      const expanding =
        discovery.name === "literature_review" || (pending?.revision || 0) > 0;
      const corrected = this.literatureReviewCorrections.has(correctionKey);
      // Find more is card-only. On a first batch, prose after the correction
      // (or when no correction can be given, so the card cannot follow either)
      // is the model's choice of the answer: it closes without a card.
      if (expanding) {
        if (canCorrect && !corrected) {
          this.literatureReviewCorrections.add(correctionKey);
          return {
            kind: "correct",
            correction: `${DISCOVERY_INCOMPLETE} ${DISCOVERY_CARD_STEPS}`,
          };
        }
        return { kind: "fail", userMessage: DISCOVERY_INCOMPLETE };
      }
      if (canCorrect && !corrected) {
        this.literatureReviewCorrections.add(correctionKey);
        return { kind: "correct", correction: DISCOVERY_CHOICE };
      }
    }

    const webAttribution = assessWebAttribution(
      params.candidateText,
      params.toolExecutionRecords,
    );
    if (webAttribution.status !== "invalid") {
      return { kind: "accept", webAttribution };
    }
    if (!this.webAttributionCorrectionUsed && params.canCorrect) {
      this.webAttributionCorrectionUsed = true;
      const fallbackText = stripWebSourceMarkersForDisplay(
        webAttribution.cleanText,
      ).trim();
      if (fallbackText) this.webAttributionFallbackText = fallbackText;
      return {
        kind: "correct",
        correction: webAttribution.correctionPrompt,
        assistantContent: webAttribution.cleanText,
      };
    }
    const answerText =
      stripWebSourceMarkersForDisplay(webAttribution.cleanText).trim() ||
      this.webAttributionFallbackText;
    return {
      kind: "fail",
      userMessage: answerText
        ? `I used web access, but could not verify valid paragraph-level sources for this answer. The answer is preserved below; its web claims are not source-verified.\n\n${answerText}`
        : "I used web access for this task, but could not safely attach valid paragraph-level sources to the answer.",
    };
  }

  /**
   * The correction that sends an ordinary turn back to the parts the model
   * declared and has not finished: reads, writes and digests, which only
   * tools deliver. A pending artifact part is not one of them: the answer
   * itself delivers it (`applyAnswer`), as it does an answer part. It is
   * given again only after new evidence moved the ledger since the last one.
   */
  private openOutcomeCorrection(canCorrect: boolean): string | undefined {
    const checkpoint = this.request.executionCheckpoint;
    const settled = settledTargetCount(checkpoint);
    if (settled > this.outcomeCorrectionSettled) {
      this.outcomeCorrectionSettled = settled;
      this.outcomeCorrections = 0;
    }
    if (!canCorrect || this.outcomeCorrections >= OPEN_PARTS_REASK_LIMIT)
      return undefined;
    const open = openDeclaredOutcomes(checkpoint).filter(
      (task) => task.effect !== "artifact",
    );
    if (!open.length) return undefined;
    const signature = outcomeProgressSignature(checkpoint);
    if (signature === this.outcomeCorrectionSignature) return undefined;
    this.outcomeCorrectionSignature = signature;
    this.outcomeCorrections += 1;
    const parts = open.map((task) => `“${task.description}”`).join("; ");
    return `Before answering, finish the parts of this request you declared that are still open: ${parts}. Do them now with the tools. If one cannot be done, list it under task_update's skipped or blocked with the reason, then answer.`;
  }
}
