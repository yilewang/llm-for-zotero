import type {
  AgentAssistantMessage,
  AgentModelMessage,
  AgentToolMessage,
  AgentUserMessage,
} from "../types";

/**
 * Owns the semantic delta appended after the most recent provider response.
 *
 * Provider-native reasoning and signatures stay inside the live adapter.  The
 * session supplies only application-owned tool results and correction prompts
 * to that cached native conversation.  Clearing the previous delta when a
 * provider response commits is the invariant that prevents an old tool result
 * from being replayed after a later final answer.
 */
export class AgentRunContinuationSession {
  private continuationMessages: AgentModelMessage[] = [];
  private toolStepOpen = false;

  constructor(private readonly messages: AgentModelMessage[]) {}

  inputForNextStep(): {
    messages: AgentModelMessage[];
    continuationMessages: AgentModelMessage[];
  } {
    if (this.toolStepOpen) {
      throw new Error(
        "Cannot call the model before the active tool-result batch is complete.",
      );
    }
    return {
      messages: this.messages,
      continuationMessages: [...this.continuationMessages],
    };
  }

  commitProviderResponse(): void {
    if (this.toolStepOpen) {
      throw new Error(
        "Cannot commit a provider response while a tool step is still open.",
      );
    }
    this.continuationMessages = [];
  }

  beginToolStep(message: AgentAssistantMessage): void {
    if (this.toolStepOpen) {
      throw new Error("A provider tool step is already open.");
    }
    this.messages.push(message);
    this.toolStepOpen = true;
  }

  completeToolStep(params: {
    toolMessages: AgentToolMessage[];
    followupMessages: AgentModelMessage[];
  }): AgentModelMessage[] {
    if (!this.toolStepOpen) {
      throw new Error("Cannot complete a tool step that was not opened.");
    }
    const delta: AgentModelMessage[] = [
      ...params.toolMessages,
      ...params.followupMessages,
    ];
    this.messages.push(...delta);
    this.continuationMessages = [...delta];
    this.toolStepOpen = false;
    return delta;
  }

  appendFinalCorrection(params: {
    assistantMessage: AgentAssistantMessage;
    correctionMessage: AgentUserMessage;
  }): AgentModelMessage[] {
    if (this.toolStepOpen) {
      throw new Error(
        "Cannot correct a final while a tool step is still open.",
      );
    }
    const appended: AgentModelMessage[] = [
      params.assistantMessage,
      params.correctionMessage,
    ];
    this.messages.push(...appended);
    this.continuationMessages = [params.correctionMessage];
    return appended;
  }

  restartWithMessages(messages: readonly AgentModelMessage[]): void {
    this.messages.splice(0, this.messages.length, ...messages);
    this.continuationMessages = [];
    this.toolStepOpen = false;
  }
}
