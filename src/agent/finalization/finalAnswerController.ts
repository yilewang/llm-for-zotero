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

  constructor(
    private readonly request: AgentRuntimeRequest,
    private readonly actionContractSession: AgentFinalActionSession,
    private readonly transcriptMessages: readonly AgentModelMessage[],
  ) {}

  async evaluate(params: {
    candidateText: string;
    canCorrect: boolean;
    toolExecutionRecords: readonly AgentFinalAnswerToolRecord[];
  }): Promise<AgentFinalAnswerDecision> {
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

    if (this.shouldCorrectShallowLibraryAnswer(params)) {
      this.shallowLibraryCorrectionUsed = true;
      return {
        kind: "correct",
        correction: LIBRARY_EVIDENCE_CORRECTION,
      };
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
