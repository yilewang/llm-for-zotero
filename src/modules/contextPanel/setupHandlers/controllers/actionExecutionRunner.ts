import { getAgentApi } from "../../../../agent";
import type {
  ActionProgressEvent,
  ActionRequestContext,
} from "../../../../agent/actions";
import type { ModelProviderAuthMode } from "../../../../utils/modelProviders";
import type { ProviderProtocol } from "../../../../utils/providerProtocol";
import {
  formatActionLabel,
  resolveActionCompletionFeedback,
  resolveActionCompletionStatusText,
  resolveActionFailureFeedback,
} from "../../actionStatusText";
import type { ActionCommandLifecycle } from "./actionCommandLifecycle";

export type ActionExecutionLlmConfig = {
  model: string;
  apiBase: string;
  apiKey?: string;
  authMode?: ModelProviderAuthMode;
  providerProtocol?: ProviderProtocol;
};

export async function runAgentActionWithLifecycle(params: {
  actionName: string;
  input: Record<string, unknown>;
  requestContext: ActionRequestContext & { mode: "paper" | "library" };
  libraryID: number;
  llm?: ActionExecutionLlmConfig;
  isPagedLibraryAction?: boolean;
  lifecycle: ActionCommandLifecycle;
  setStatus: (
    message: string,
    level: "ready" | "warning" | "error",
  ) => void;
  logError: (message: string, error?: unknown) => void;
}): Promise<void> {
  const {
    actionName,
    input,
    isPagedLibraryAction,
    libraryID,
    lifecycle,
    llm,
    logError,
    requestContext,
    setStatus,
  } = params;
  setStatus(`Running: ${formatActionLabel(actionName)}...`, "ready");
  const progressIndicator =
    lifecycle.createActionProgressIndicator(actionName);
  let lastProgressSummary = "";
  try {
    const agentApi = getAgentApi();
    const commonOptions = {
      libraryID,
      requestContext,
      llm,
      onProgress: (event: ActionProgressEvent) => {
        if (event.type === "step_start") {
          progressIndicator.setStep(event.step, event.index, event.total);
          setStatus(`${event.step} (${event.index}/${event.total})`, "ready");
        } else if (event.type === "step_done") {
          if (event.summary) {
            lastProgressSummary = event.summary;
            progressIndicator.setSummary(event.summary);
            setStatus(event.summary, "ready");
          }
        } else if (event.type === "confirmation_required") {
          progressIndicator.hide();
        }
      },
    };
    if (isPagedLibraryAction) {
      agentApi.getZoteroGateway().invalidateLibrarySearchCache?.(libraryID);
    }
    const result = await agentApi.runAction(actionName, input, {
      ...commonOptions,
      confirmationMode: "native_ui",
      requestConfirmation: (requestId, pendingAction) =>
        lifecycle.showActionHitlCard(requestId, pendingAction),
    });
    setStatus(
      result.ok
        ? resolveActionCompletionStatusText({
            actionName,
            lastProgressSummary,
          })
        : `${formatActionLabel(actionName)} failed: ${result.error}`,
      result.ok ? "ready" : "error",
    );
    if (result.ok) {
      progressIndicator.remove();
      lifecycle.showActionCompletionCard(
        resolveActionCompletionFeedback({
          actionName,
          output: result.output,
          lastProgressSummary,
        }),
      );
    } else {
      lifecycle.closeActionHitlPanel();
      lifecycle.showActionCompletionCard(
        resolveActionFailureFeedback({
          actionName,
          error: result.error,
          lastProgressSummary,
        }),
      );
    }
  } catch (error) {
    lifecycle.closeActionHitlPanel();
    logError("LLM: action picker run error", error);
    setStatus(`Error: ${String(error)}`, "error");
    lifecycle.showActionCompletionCard(
      resolveActionFailureFeedback({
        actionName,
        error,
        lastProgressSummary,
      }),
    );
  } finally {
    progressIndicator.remove();
  }
}
