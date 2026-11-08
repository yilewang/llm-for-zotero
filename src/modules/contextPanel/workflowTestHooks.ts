import type { SendQuestionOptions } from "./types";
import type { InputCapEffects } from "../../utils/modelInputCap";
import type { ModelInputTokenLimitSource } from "../../utils/modelInputCap";
import type { ContextAssemblyStrategy, MultiContextPlan } from "./types";

export type WorkflowTestSendInterceptor = (
  opts: SendQuestionOptions,
) => Promise<boolean | void> | boolean | void;

export type WorkflowTestFinalRequestSnapshot = {
  prompt: string;
  historyTexts: string[];
  /** The protocol the request would go out with. */
  providerProtocol: string;
  /** Roles of the messages sent after the input cap, system included. */
  finalMessageRoles: string[];
  combinedContext: string;
  strategy: ContextAssemblyStrategy;
  systemMessages: string[];
  inputCap: {
    limitTokens: number;
    limitSource: ModelInputTokenLimitSource;
    estimatedAfterTokens: number;
  };
  inputCapEffects: InputCapEffects;
  readStrategy?: MultiContextPlan["readStrategy"];
  coverageReceipt?: MultiContextPlan["coverageReceipt"];
  fullReadReceipt?: MultiContextPlan["fullReadReceipt"];
};

export type WorkflowTestFinalRequestInterceptor = (
  snapshot: WorkflowTestFinalRequestSnapshot,
) => Promise<boolean | void> | boolean | void;

export type WorkflowTestHistoryOpenFailure = (target: {
  system: string;
  conversationKey: number;
}) => boolean;

let historyOpenFailure: WorkflowTestHistoryOpenFailure | null = null;

export function setWorkflowTestHistoryOpenFailure(
  fn: WorkflowTestHistoryOpenFailure | null,
): void {
  historyOpenFailure = fn;
}

export function getWorkflowTestHistoryOpenFailure(): WorkflowTestHistoryOpenFailure | null {
  return historyOpenFailure;
}

let sendInterceptor: WorkflowTestSendInterceptor | null = null;
let finalRequestInterceptor: WorkflowTestFinalRequestInterceptor | null = null;
let sendSettledSequence = 0;

export function setWorkflowTestSendInterceptor(
  interceptor: WorkflowTestSendInterceptor | null,
): void {
  sendInterceptor = interceptor;
}

export function getWorkflowTestSendInterceptor(): WorkflowTestSendInterceptor | null {
  return sendInterceptor;
}

export function notifyWorkflowTestSendSettled(): void {
  sendSettledSequence += 1;
}

export function getWorkflowTestSendSettledSequence(): number {
  return sendSettledSequence;
}

export function setWorkflowTestFinalRequestInterceptor(
  interceptor: WorkflowTestFinalRequestInterceptor | null,
): void {
  finalRequestInterceptor = interceptor;
}

export function getWorkflowTestFinalRequestInterceptor(): WorkflowTestFinalRequestInterceptor | null {
  return finalRequestInterceptor;
}
