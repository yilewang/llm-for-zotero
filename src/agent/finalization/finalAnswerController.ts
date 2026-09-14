import type { AgentModelMessage, AgentRuntimeRequest } from "../types";
import type {
  ActionContractRunSession,
  RejectedActionContractFinalDecision,
} from "../contracts/actionContractRunSession";
import {
  findLibraryRetrieveShallowSignal,
  isEvidenceSeekingTurn,
  transcriptShowsEvidenceReads,
} from "../model/libraryAnswerGuard";
import {
  assessWebAttribution,
  type WebAttributionAssessment,
} from "../../webAccess/attribution";
import type { PlanExecutionRunSession } from "../plans/runSession";

export type AgentFinalAnswerToolRecord = {
  name: string;
  ok: boolean;
  content?: unknown;
};

export type AgentFinalActionSession = Pick<
  ActionContractRunSession,
  "evaluateFinal"
>;

export type AgentFinalAnswerDecision =
  | {
      kind: "accept";
      webAttribution: WebAttributionAssessment;
    }
  | {
      kind: "correct";
      correction: string;
      assistantContent?: string;
      actionContractRejection?: Extract<
        RejectedActionContractFinalDecision,
        { kind: "correct" }
      >;
    }
  | {
      kind: "fail";
      userMessage: string;
      actionContractRejection?: Extract<
        RejectedActionContractFinalDecision,
        { kind: "fail" }
      >;
    };

const LIBRARY_EVIDENCE_CORRECTION =
  "Correction for this turn: the question targets the selected collection/tag scope and needs library evidence. Call `library_retrieve` scoped to the selected collections/tags now (intent:'summarize' for synthesis or theme questions, 'enumerate' for which-papers questions; depth:'evidence'), then answer from the returned evidence. Include the coverage line (papers planned / body evidence read / metadata-only) in the final answer; if coverage is partial, name what is missing instead of generalizing.";

/**
 * Applies every runtime-owned final-answer gate through one typed decision.
 * Provider continuation remains outside this class; a correction is an
 * application-owned user message appended after the adapter's cached native
 * final response.
 */
export class AgentFinalAnswerController {
  private shallowLibraryCorrectionUsed = false;
  private webAttributionCorrectionUsed = false;
  private documentCorrectionUsed = false;
  private readonly literatureReviewCorrections = new Set<string>();

  constructor(
    private readonly request: AgentRuntimeRequest,
    private readonly actionContractSession: AgentFinalActionSession,
    private readonly transcriptMessages: readonly AgentModelMessage[],
    private readonly planSession?: Pick<
      PlanExecutionRunSession,
      "evaluateFinal"
    >,
  ) {}

  async evaluate(params: {
    candidateText: string;
    canCorrect: boolean;
    toolExecutionRecords: readonly AgentFinalAnswerToolRecord[];
  }): Promise<AgentFinalAnswerDecision> {
    if (this.request.planContext?.phase !== "planning") {
      const actionDecision = await this.actionContractSession.evaluateFinal({
        canCorrect: params.canCorrect,
      });
      if (actionDecision.kind !== "accept") {
        if (actionDecision.kind === "correct") {
          return {
            kind: "correct",
            correction: actionDecision.correction,
            actionContractRejection: actionDecision,
          };
        }
        return {
          kind: "fail",
          userMessage: actionDecision.failure,
          actionContractRejection: actionDecision,
        };
      }
    }

    const planDecision = await this.planSession?.evaluateFinal({
      canCorrect: params.canCorrect,
      successfulToolResultCount: params.toolExecutionRecords.filter(
        (record) => record.ok,
      ).length,
    });
    if (planDecision && planDecision.kind !== "accept") {
      return planDecision.kind === "correct"
        ? { kind: "correct", correction: planDecision.correction }
        : { kind: "fail", userMessage: planDecision.failure };
    }

    if (
      this.request.documentOutcomePolicy?.required &&
      !params.toolExecutionRecords.some(
        (record) =>
          (record.name === "submit_document" ||
            record.name === "submit_plan_document") &&
          record.ok,
      )
    ) {
      const failure =
        "The requested document was not finalized, so ordinary answer text cannot be accepted as the completed outcome.";
      if (params.canCorrect && !this.documentCorrectionUsed) {
        this.documentCorrectionUsed = true;
        return {
          kind: "correct",
          correction: `${failure} Complete the document and call submit_document now.`,
        };
      }
      return { kind: "fail", userMessage: failure };
    }

    if (this.shouldCorrectShallowLibraryAnswer(params)) {
      this.shallowLibraryCorrectionUsed = true;
      return {
        kind: "correct",
        correction: LIBRARY_EVIDENCE_CORRECTION,
      };
    }

    const lastDiscovery = params.toolExecutionRecords.findLastIndex(
      (record) =>
        record.ok &&
        (record.name === "literature_search" ||
          record.name === "search_literature_online" ||
          (record.name === "literature_review" &&
            (record.content as { discoveryPhase?: string } | undefined)
              ?.discoveryPhase === "expanding")) &&
        Boolean(
          (record.content as { reviewRequired?: boolean } | undefined)
            ?.reviewRequired,
        ),
    );
    if (
      lastDiscovery >= 0 &&
      !params.toolExecutionRecords
        .slice(lastDiscovery + 1)
        .some((record) => record.ok && record.name === "literature_review")
    ) {
      const failure =
        "The relevant-paper shortlist was not presented for review, so discovery is not complete.";
      const pending = params.toolExecutionRecords[lastDiscovery].content as
        | { sessionId?: string; revision?: number }
        | undefined;
      const correctionKey = `${pending?.sessionId || "discovery"}:${pending?.revision || 0}`;
      if (
        params.canCorrect &&
        !this.literatureReviewCorrections.has(correctionKey)
      ) {
        this.literatureReviewCorrections.add(correctionKey);
        return {
          kind: "correct",
          correction: `${failure} Use the active discovery sessionId and revision; select only NEW papers for an expansion. Rank genuinely relevant candidates from the saved literature_search results and call literature_review with the requested number, their candidateSetId/candidateIndex references, relevance reasons and destination. Search further if needed; disclose any genuine shortfall. Do not import silently or finish with recommendations in prose.`,
        };
      }
      return { kind: "fail", userMessage: failure };
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
      return {
        kind: "correct",
        correction: webAttribution.correctionPrompt,
        assistantContent: webAttribution.cleanText,
      };
    }
    return {
      kind: "fail",
      userMessage:
        "I used web access for this task, but could not safely attach valid paragraph-level sources to the answer.",
    };
  }

  private shouldCorrectShallowLibraryAnswer(params: {
    canCorrect: boolean;
    toolExecutionRecords: readonly AgentFinalAnswerToolRecord[];
  }): boolean {
    if (!params.canCorrect || this.shallowLibraryCorrectionUsed) return false;
    const libraryScoped = Boolean(
      this.request.turnPaperScope.collections.length ||
      this.request.turnPaperScope.tags.length,
    );
    if (!libraryScoped || !isEvidenceSeekingTurn(this.request)) return false;
    if (transcriptShowsEvidenceReads(this.transcriptMessages)) return false;

    const shallowSignal = findLibraryRetrieveShallowSignal(
      params.toolExecutionRecords,
    );
    const classifiedRetrieval = this.request.classifiedIntent?.retrievalIntent;
    return (
      !shallowSignal.ranRetrieveFamily ||
      (shallowSignal.lastRetrieveShallow &&
        (classifiedRetrieval === "summarize" ||
          classifiedRetrieval === "verify"))
    );
  }
}
