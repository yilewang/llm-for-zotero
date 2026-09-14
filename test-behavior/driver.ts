import { getAgentRuntime } from "../src/agent";
import { getConversationWriteGeneration } from "../src/shared/conversationWriteFence";
import {
  getOriginalAgentPermissionMode,
  setOriginalAgentPermissionMode,
} from "../src/agent/originalAgentPermissionMode";
import type { AgentEvent, AgentRuntimeRequestInput } from "../src/agent/types";
import type { LiveAgentCredentials } from "../test-live-agent/liveAgentCredentials";
import {
  assertExact,
  check,
  confirmationDecision,
  appendTurnHistory,
  assertApprovalProposal,
  failedTurnError,
  type ConfirmationExpectation,
  type Mode,
} from "./core";
import { snapshot } from "./native";

declare const Zotero: any;
export type Turn = { result: any; events: AgentEvent[]; prompt: string };
export type Writer = (
  file: string,
  data: unknown,
  plain?: boolean,
) => Promise<void>;

export class LiveDriver {
  private history = new Map<
    number,
    NonNullable<AgentRuntimeRequestInput["history"]>
  >();
  private serial = 0;
  constructor(
    readonly creds: LiveAgentCredentials,
    readonly write: Writer,
    readonly timeoutMs = 720000,
    readonly inspectEffectState: () => Promise<unknown> = snapshot,
  ) {}

  async turn(
    id: string,
    prompt: string,
    mode: Mode,
    request: Partial<AgentRuntimeRequestInput> = {},
    expected: ConfirmationExpectation = "none",
    invokeUI?: () => Promise<unknown>,
    answerQuestion?: (
      action: import("../src/agent/types").AgentPendingAction,
    ) => Record<string, unknown> | Promise<Record<string, unknown>>,
  ): Promise<Turn> {
    setOriginalAgentPermissionMode(mode);
    assertExact(
      getOriginalAgentPermissionMode(),
      mode,
      "Canonical permission mode",
    );
    const runtime = getAgentRuntime();
    const events: AgentEvent[] = [];
    const errors: string[] = [];
    let confirmations = 0;
    let approvals = 0;
    let appliedResults = 0;
    let stable = await this.inspectEffectState();
    const eventPath = `${id}/turn-${++this.serial}`;
    const onEvent = async (event: AgentEvent) => {
      events.push(event);
      // Checkpoint every event before interacting with the agent, not only at
      // successful completion. A cancelled/failed turn still leaves evidence.
      await this.write("events.jsonl", {
        step: id,
        turn: this.serial,
        at: new Date().toISOString(),
        event,
      });
      if (event.type === "confirmation_required") {
        confirmations++;
        const decision =
          event.action.toolName === "request_user_input" &&
          answerQuestion &&
          expected === "review"
            ? { approve: true, failure: undefined as string | undefined }
            : confirmationDecision(
                mode,
                expected,
                event.action.mode || "approval",
                runtime.getToolDefinition(event.action.toolName)?.spec
                  .executionClass === "external_effect",
              );
        try {
          assertExact(
            await this.inspectEffectState(),
            stable,
            "Native and file state before approval",
          );
          check(
            event.action.toolName &&
              event.action.title &&
              event.action.fields.length,
            "Confirmation card must describe the proposed action",
          );
          if (
            decision.approve &&
            event.action.toolName !== "request_user_input"
          ) {
            const proposal = [...events]
              .reverse()
              .find(
                (entry) =>
                  entry.type === "tool_call" &&
                  entry.name === event.action.toolName,
              );
            assertApprovalProposal(
              event.action,
              proposal?.type === "tool_call" ? proposal.args : undefined,
              request.activeItemId,
              request.activeItemId
                ? Zotero.Items.get(request.activeItemId)?.getField("title")
                : undefined,
            );
          }
        } catch (error) {
          errors.push(String(error));
          decision.approve = false;
        }
        if (decision.failure)
          errors.push(`${decision.failure}: ${event.action.toolName}`);
        if (decision.approve) approvals++;
        runtime.resolveConfirmation(
          event.requestId,
          decision.approve,
          event.action.toolName === "request_user_input"
            ? await answerQuestion?.(event.action)
            : undefined,
        );
        if (errors.length) controller.abort();
      }
      if (
        event.type === "tool_result" &&
        event.actionReceipts?.some((receipt) => receipt.status === "applied")
      ) {
        const requestedNoteCreation = event.actionReceipts.every(
          (receipt) => receipt.operation === "note_create",
        );
        if (!requestedNoteCreation) appliedResults++;
        if (
          mode === "safe" &&
          !requestedNoteCreation &&
          approvals < appliedResults
        )
          errors.push("Effect occurred without a preceding Safe approval");
        stable = await this.inspectEffectState();
      }
    };
    const conversationKey = request.conversationKey || Date.now() + this.serial;
    const AbortControllerCtor = Zotero.getMainWindow().AbortController;
    check(AbortControllerCtor, "The live Zotero window has no AbortController");
    const controller: AbortController = new AbortControllerCtor();
    const timer = Zotero.getMainWindow().setTimeout(
      () => controller.abort(),
      this.timeoutMs,
    );
    let result: any;
    const transportDiagnostics: string[] = [];
    const originalDebug = Zotero.debug;
    Zotero.debug = function (message: unknown, ...args: unknown[]) {
      if (
        typeof message === "string" &&
        message.startsWith("[llm-for-zotero] Semantic interpretation failed")
      ) {
        transportDiagnostics.push(
          message.split(thisDriverApiKey).join("[redacted]"),
        );
      }
      return originalDebug?.call(Zotero, message, ...args);
    };
    const thisDriverApiKey = this.creds.apiKey;
    try {
      if (invokeUI) {
        // Observe the real UI-to-runtime call without replacing its request,
        // model output, authority or effects. Always restore the method.
        const original = runtime.runTurn;
        let observed: Promise<any> | undefined;
        runtime.runTurn = (params) => {
          check(
            !observed,
            "Unexpected concurrent Agent turn during UI behavior test",
          );
          observed = Promise.resolve().then(() => {
            check(
              params.request.model === this.creds.model,
              `UI selected ${params.request.model}, expected ${this.creds.model}`,
            );
            check(
              params.request.reasoning?.level === this.creds.reasoningLevel,
              `UI reasoning is ${params.request.reasoning?.level}, expected ${this.creds.reasoningLevel}`,
            );
            if (request.activeItemId)
              check(
                params.request.activeItemId === request.activeItemId,
                `UI paper scope is ${params.request.activeItemId}, expected ${request.activeItemId}`,
              );
            if (request.selectedPaperContexts?.length) {
              assertExact(
                (params.request.selectedPaperContexts || [])
                  .map((paper) => paper.itemId)
                  .sort((a, b) => a - b),
                request.selectedPaperContexts
                  .map((paper) => paper.itemId)
                  .sort((a, b) => a - b),
                "UI dispatched the exact selected research corpus",
              );
            }
            return original.call(runtime, {
              ...params,
              signal: controller.signal,
              onEvent: async (event) => {
                await params.onEvent?.(event);
                await onEvent(event);
              },
            });
          });
          return observed;
        };
        try {
          await invokeUI();
          const deadline = Date.now() + 15000;
          while (!observed && Date.now() < deadline)
            await Zotero.Promise.delay(50);
          check(
            observed,
            "Composer did not dispatch a live Original Agent turn",
          );
          result = await observed;
        } finally {
          runtime.runTurn = original;
        }
      } else {
        result = await runtime.runTurn({
          request: {
            conversationKey,
            conversationGeneration:
              getConversationWriteGeneration(conversationKey),
            mode: "agent",
            conversationKind: "global",
            libraryID: Zotero.Libraries.userLibraryID,
            authMode: "api_key",
            model: this.creds.model,
            apiBase: this.creds.apiBase,
            apiKey: this.creds.apiKey,
            providerProtocol: this.creds
              .providerProtocol as AgentRuntimeRequestInput["providerProtocol"],
            reasoning: {
              provider: "deepseek",
              level: this.creds.reasoningLevel || "high",
            } as AgentRuntimeRequestInput["reasoning"],
            history: this.history.get(conversationKey) || [],
            ...request,
            userText: prompt,
          },
          onEvent,
          signal: controller.signal,
        });
        if (result?.kind === "completed")
          this.history.set(
            conversationKey,
            appendTurnHistory(
              this.history.get(conversationKey) || [],
              prompt,
              result.text,
            ),
          );
      }
    } catch (error) {
      const failure = failedTurnError(error, errors);
      errors.push(
        error instanceof Error ? error.stack || error.message : String(error),
      );
      throw failure;
    } finally {
      Zotero.debug = originalDebug;
      Zotero.getMainWindow().clearTimeout(timer);
      await this.write(`${eventPath}.json`, {
        prompt,
        mode,
        expectedConfirmation: expected,
        transportDiagnostics,
        result,
        errors,
        events,
      });
    }
    check(!errors.length, errors.join("; "));
    check(!controller.signal.aborted, "Live turn deadline exceeded");
    if (expected !== "none")
      check(confirmations > 0, `Expected ${expected} card was never shown`);
    check(
      result?.kind === "completed",
      `Agent did not complete: ${result?.kind || "missing"}`,
    );
    check(String(result.text || "").trim().length > 0, "Empty final answer");
    await this.write(`${eventPath}-answer.md`, result.text, true);
    return { result, events, prompt };
  }
}

export function requireReceipt(turn: Turn, target?: string) {
  const receipts = turn.events.flatMap((event) =>
    event.type === "tool_result" ? event.actionReceipts || [] : [],
  );
  const verified = receipts.filter(
    (receipt) =>
      receipt.verification === "verified" &&
      ["applied", "already_satisfied"].includes(receipt.status),
  );
  check(verified.length, "No verified action receipt");
  if (target)
    check(
      verified.some((receipt) => JSON.stringify(receipt).includes(target)),
      `No verified receipt for ${target}`,
    );
}
