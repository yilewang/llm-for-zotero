import type {
  AgentToolArtifact,
  AgentActionEvidence,
  AgentToolExecutionOutput,
  PreparedToolExecutionOptions,
  AgentRuntimeRequest,
  AgentToolCall,
  AgentToolContext,
  AgentToolDefinition,
  AgentToolEffect,
  PreparedToolExecution,
  ToolSpec,
} from "../types";
import { isAgentChangeJournalAvailable } from "../store/changeJournal";
import { isMalformedToolArgumentsDiagnostic } from "../toolArgumentDiagnostics";
import { getAgentLibraryWriteMode } from "../libraryWriteMode";
import {
  ActionContractService,
  type PreparedActionExecution,
} from "../contracts/actionContract";
import {
  createFallbackToolReceipts,
  createUnverifiedReceipt,
} from "../contracts/actionEvaluation";

function createSyntheticErrorResult(
  call: AgentToolCall,
  message: string,
): PreparedToolExecution {
  const syntheticTool: AgentToolDefinition<any, any> = {
    spec: {
      name: call.name,
      description: message,
      inputSchema: { type: "object" },
      mutability: "read",
      requiresConfirmation: false,
    },
    validate: () => ({ ok: true, value: {} }),
    execute: async () => ({ error: message }),
  };
  return {
    kind: "result",
    execution: {
      tool: syntheticTool,
      input: call.arguments,
      result: {
        callId: call.id,
        name: call.name,
        ok: false,
        actionReceipts: [createUnverifiedReceipt({ reason: message })],
        content: { error: message },
      },
    },
  };
}

function createRequestId(): string {
  return `confirm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function withRecoveryWarning(
  action: import("../types").AgentPendingAction,
  reason: string,
): import("../types").AgentPendingAction {
  const warning = `Recovery warning: ${reason}`;
  return {
    ...action,
    description: `${action.description}\n\n${warning}`,
    fields: [
      ...(action.fields || []),
      {
        type: "text" as const,
        id: "journalRecoveryWarning",
        label: "Recovery warning",
        value: warning,
      },
    ],
  };
}

function normalizeExecutionOutput(value: AgentToolExecutionOutput<any>): {
  content: unknown;
  artifacts?: AgentToolArtifact[];
  effect?: AgentToolEffect;
  actionEvidence?: AgentActionEvidence[];
} {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as {
      content?: unknown;
      artifacts?: unknown;
      effect?: unknown;
      actionEvidence?: unknown;
    };
    if (Object.prototype.hasOwnProperty.call(record, "content")) {
      return {
        content: record.content,
        artifacts: Array.isArray(record.artifacts)
          ? (record.artifacts as AgentToolArtifact[])
          : undefined,
        effect:
          record.effect === "applied" ||
          record.effect === "partial" ||
          record.effect === "none"
            ? record.effect
            : undefined,
        actionEvidence: Array.isArray(record.actionEvidence)
          ? (record.actionEvidence as AgentActionEvidence[])
          : undefined,
      };
    }
  }
  return {
    content: value,
  };
}

/**
 * Tools that change the library unattended and therefore need `yolo`.
 *
 * Deliberately a short, explicit list rather than "every write tool": the
 * ordinary write tools already stop at a confirmation card, so gating them
 * here would only duplicate a control the user already has. What needs a mode
 * is the work that runs *without* a card once approved.
 */
const YOLO_ONLY_TOOLS = new Set(["library_batch"]);

function refuseForLibraryWriteMode(
  tool: AgentToolDefinition<any, any>,
  options: PreparedToolExecutionOptions,
): string | null {
  if (!YOLO_ONLY_TOOLS.has(tool.spec.name)) return null;
  // Only the model path is gated. The actions subsystem and the public API
  // are driven by an explicit user gesture, which is its own consent.
  if (options.callerKind && options.callerKind !== "model") return null;
  if (getAgentLibraryWriteMode() === "yolo") return null;
  return `${tool.spec.name} runs unattended and requires the agent library write mode to be "yolo". Change it in the plugin preferences, or use the slash-command surface, which reviews each page before applying it.`;
}

export class AgentToolRegistry {
  private readonly tools = new Map<string, AgentToolDefinition<any, any>>();

  constructor(private readonly actionContracts?: ActionContractService) {}

  async createActionContract(
    request: AgentRuntimeRequest,
  ): Promise<NonNullable<AgentRuntimeRequest["actionContract"]> | null> {
    if (this.actionContracts) {
      return this.actionContracts.createContract(request);
    }
    const intents = request.classifiedIntent?.actionIntents || [];
    if (intents.some((intent) => intent.scope)) {
      throw new Error(
        "A collection-scoped action requires the Zotero scope resolver.",
      );
    }
    const id = `action-contract:${request.conversationKey}:${Date.now()}`;
    return {
      version: 2,
      id,
      writeDisposition:
        request.classifiedIntent?.writeDisposition ||
        (intents.length ? "required" : "none"),
      interpretationSource:
        request.classifiedIntent?.actionInterpretationSource ||
        "deterministic_fallback",
      obligations: intents.map((intent, index) => {
        const { scope: _scope, ...unscoped } = intent;
        return {
          ...unscoped,
          id: `${id}:obligation:${index}`,
        };
      }),
    };
  }

  createActionProgress(
    contract: NonNullable<AgentRuntimeRequest["actionContract"]>,
  ): NonNullable<AgentRuntimeRequest["actionProgress"]> {
    if (this.actionContracts)
      return this.actionContracts.createProgress(contract);
    return {
      version: 1,
      contractId: contract.id,
      state: "pending",
      correctionCount: 0,
      obligations: contract.obligations.map((obligation) => ({
        obligationId: obligation.id,
        status: "open",
        verifiedTargetIds: [],
        unresolvedTargetIds: [],
        journalStepIds: [],
        failureReasons: [],
      })),
      appliedReceiptKeys: [],
      updatedAt: Date.now(),
    };
  }

  private isModelVisibleTool(tool: AgentToolDefinition<any, any>): boolean {
    return tool.spec.exposure !== "internal";
  }

  private filterToolsForRequest(
    request: AgentRuntimeRequest,
  ): AgentToolDefinition<any, any>[] {
    return Array.from(this.tools.values()).filter(
      (tool) =>
        this.isModelVisibleTool(tool) && tool.isAvailable?.(request) !== false,
    );
  }

  register<TInput, TResult>(tool: AgentToolDefinition<TInput, TResult>): void {
    this.tools.set(tool.spec.name, tool);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  listTools(): ToolSpec[] {
    return Array.from(this.tools.values())
      .filter(
        (tool) =>
          this.isModelVisibleTool(tool) && tool.spec.localAgentOnly !== true,
      )
      .map((tool) => tool.spec);
  }

  listToolDefinitions(): AgentToolDefinition<any, any>[] {
    return Array.from(this.tools.values());
  }

  listToolsForRequest(request: AgentRuntimeRequest): ToolSpec[] {
    return this.filterToolsForRequest(request).map((tool) => tool.spec);
  }

  listToolDefinitionsForRequest(
    request: AgentRuntimeRequest,
  ): AgentToolDefinition<any, any>[] {
    return this.filterToolsForRequest(request);
  }

  getTool(name: string): AgentToolDefinition<any, any> | undefined {
    return this.tools.get(name);
  }

  async prepareExecution(
    call: AgentToolCall,
    context: AgentToolContext,
    options: PreparedToolExecutionOptions = {},
  ): Promise<PreparedToolExecution> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return createSyntheticErrorResult(call, `Unknown tool: ${call.name}`);
    }
    if (tool.isAvailable?.(context.request) === false) {
      return createSyntheticErrorResult(
        call,
        `${call.name} is not available for this request`,
      );
    }
    // Enforce the library write mode here, not in the tool listing.
    //
    // `exposure` is checked when listing tools and deliberately NOT here --
    // seventeen internal tools are called by name through this method by the
    // actions subsystem, the slash commands and the public runAction API, and
    // a test asserts they stay reachable. So this is a separate gate keyed on
    // the caller being the model, and it lives at the one point every backend
    // (in-plugin runtime, MCP, the external bridge) passes through.
    const modeRefusal = refuseForLibraryWriteMode(tool, options);
    if (modeRefusal) {
      return createSyntheticErrorResult(call, modeRefusal);
    }
    if (isMalformedToolArgumentsDiagnostic(call.arguments)) {
      return createSyntheticErrorResult(
        call,
        `Invalid tool input for ${call.name}: ${call.name} received malformed tool arguments from the model. Retry with valid JSON.`,
      );
    }
    const validation = tool.validate(call.arguments);
    if (!validation.ok) {
      const validationError =
        call.name === "library_search" &&
        (context.request.turnPaperScope.collections.length ||
          context.request.turnPaperScope.tags.length) &&
        validation.error.includes("entity and mode are required")
          ? `${validation.error} For selected collection/tag scopes, use ` +
            "{ entity:'items', mode:'list', filters:{ collectionId:<collectionId> } } or " +
            "{ entity:'items', mode:'list', filters:{ tag:'<tag>' } }."
          : validation.error;
      return createSyntheticErrorResult(
        call,
        `Invalid tool input for ${call.name}: ${validationError}`,
      );
    }

    const callerKind = options.callerKind || "model";
    const enforceActionContract =
      callerKind === "model" || Boolean(context.journalActionScope);

    const preparedAction =
      enforceActionContract && this.actionContracts
        ? await this.actionContracts.prepare(tool, validation.value, context)
        : undefined;
    if (preparedAction && context.request.actionContract) {
      const scopeFailure = await this.actionContracts!.validateScope(
        context.request.actionContract,
        preparedAction,
        {
          allowPartialCoverage: Boolean(
            options.callerKind === "action" && context.journalActionScope,
          ),
          progress: context.request.actionProgress,
        },
      );
      if (scopeFailure) {
        return {
          kind: "result",
          execution: {
            tool,
            input: validation.value,
            result: {
              callId: call.id,
              name: call.name,
              ok: false,
              actionReceipts: this.actionContracts!.rejectionReceipts(
                context.request.actionContract,
                preparedAction,
                scopeFailure,
              ),
              content: {
                error: scopeFailure.message,
                retryable: true,
                expectedCount: scopeFailure.expectedCount,
                proposedCount: scopeFailure.proposedCount,
                rejectedTargets: scopeFailure.rejectedTargets,
                missingTargets: scopeFailure.missingTargets,
              },
            },
          },
        };
      }
    }

    const finalizeReceipts = (
      params: {
        ok: boolean;
        effect?: AgentToolEffect;
        cancelled?: boolean;
        reason?: string;
        content?: unknown;
        actionEvidence?: AgentActionEvidence[];
      },
      prepared: PreparedActionExecution | undefined = preparedAction,
    ) => {
      const receipts =
        prepared && this.actionContracts
          ? this.actionContracts.finalize(
              context.request.actionContract,
              prepared,
              params,
              context.request.actionProgress,
            )
          : createFallbackToolReceipts({
              toolName: call.name,
              mutability: tool.spec.mutability,
              input: validation.value,
              ...params,
            });
      if (context.request.actionProgress && this.actionContracts) {
        this.actionContracts.applyReceipts(
          context.request.actionProgress,
          receipts,
        );
      }
      return receipts;
    };

    const runWithInput = async (
      resolvedInput: typeof validation.value,
      executionContext: AgentToolContext = context,
    ) => {
      const lifecycleError = () => ({
        tool,
        input: resolvedInput,
        result: {
          callId: call.id,
          name: call.name,
          ok: false,
          actionReceipts: finalizeReceipts({
            ok: false,
            reason: "Conversation lifecycle changed before execution.",
          }),
          content: {
            error:
              "Conversation lifecycle changed before this tool could execute.",
          },
        },
      });
      const execute = async () => {
        if (options.isExecutionAllowed && !options.isExecutionAllowed()) {
          return lifecycleError();
        }
        const executionPrepared = this.actionContracts
          ? await this.actionContracts.prepare(
              tool,
              resolvedInput,
              executionContext,
            )
          : preparedAction;
        if (executionPrepared && context.request.actionContract) {
          const scopeFailure = await this.actionContracts!.validateScope(
            context.request.actionContract,
            executionPrepared,
            {
              allowPartialCoverage: Boolean(
                options.callerKind === "action" &&
                executionContext.journalActionScope,
              ),
              concreteWrite: mutationPlan.effect === "write",
              progress: context.request.actionProgress,
            },
          );
          if (scopeFailure) {
            return {
              tool,
              input: resolvedInput,
              result: {
                callId: call.id,
                name: call.name,
                ok: false,
                actionReceipts: this.actionContracts!.rejectionReceipts(
                  context.request.actionContract,
                  executionPrepared,
                  scopeFailure,
                ),
                content: {
                  error: scopeFailure.message,
                  retryable: true,
                  expectedCount: scopeFailure.expectedCount,
                  proposedCount: scopeFailure.proposedCount,
                  rejectedTargets: scopeFailure.rejectedTargets,
                  missingTargets: scopeFailure.missingTargets,
                },
              },
            };
          }
        }
        try {
          const executionOutput = normalizeExecutionOutput(
            await tool.execute(resolvedInput, executionContext),
          );
          if (options.isExecutionAllowed && !options.isExecutionAllowed()) {
            return lifecycleError();
          }
          if (
            tool.spec.mutability === "write" &&
            executionOutput.effect === undefined
          ) {
            return {
              tool,
              input: resolvedInput,
              result: {
                callId: call.id,
                name: call.name,
                ok: false,
                actionReceipts: finalizeReceipts(
                  {
                    ok: false,
                    reason: "Tool completed without an explicit write effect.",
                  },
                  executionPrepared,
                ),
                content: {
                  error: `${call.name} completed without the required explicit write effect. Its outcome is unknown; inspect current state before retrying.`,
                },
              },
            };
          }
          return {
            tool,
            input: resolvedInput,
            result: {
              callId: call.id,
              name: call.name,
              // `ok` reports that the tool ran, not that it changed anything.
              // See AgentToolResult: flipping this on a zero-effect write
              // would disable the result-review loop and trip the
              // consecutive-error breaker.
              ok: true,
              effect:
                tool.spec.mutability === "write"
                  ? executionOutput.effect
                  : undefined,
              actionReceipts: finalizeReceipts(
                {
                  ok: true,
                  effect:
                    tool.spec.mutability === "write"
                      ? executionOutput.effect
                      : undefined,
                  content: executionOutput.content,
                  actionEvidence: executionOutput.actionEvidence,
                },
                executionPrepared,
              ),
              content: executionOutput.content,
              artifacts: executionOutput.artifacts,
            },
          };
        } catch (error) {
          if (options.isExecutionAllowed && !options.isExecutionAllowed()) {
            return lifecycleError();
          }
          return {
            tool,
            input: resolvedInput,
            result: {
              callId: call.id,
              name: call.name,
              ok: false,
              actionReceipts: finalizeReceipts(
                {
                  ok: false,
                  reason:
                    error instanceof Error ? error.message : String(error),
                },
                executionPrepared,
              ),
              content: {
                error: error instanceof Error ? error.message : String(error),
              },
            },
          };
        }
      };
      return mutationPlan.effect === "write" && options.executeWithLock
        ? options.executeWithLock(execute)
        : execute();
    };

    const runConfirmedExecution = async (resolutionData?: unknown) => {
      if (resolutionData !== undefined && tool.applyConfirmation) {
        const resolved = tool.applyConfirmation(
          validation.value,
          resolutionData,
          context,
        );
        if (!resolved.ok) {
          return {
            tool,
            input: validation.value,
            result: {
              callId: call.id,
              name: call.name,
              ok: false,
              actionReceipts: finalizeReceipts({
                ok: false,
                reason: `Invalid confirmation input for ${call.name}: ${resolved.error}`,
              }),
              content: {
                error: `Invalid confirmation input for ${call.name}: ${resolved.error}`,
              },
            },
          };
        }
        return runWithInput(
          resolved.value,
          journalUnavailable
            ? { ...context, journalFallbackApproved: true }
            : context,
        );
      }
      return runWithInput(
        validation.value,
        journalUnavailable
          ? { ...context, journalFallbackApproved: true }
          : context,
      );
    };

    const toolWantsConfirmation =
      (await tool.shouldRequireConfirmation?.(validation.value, context)) ??
      tool.spec.requiresConfirmation;
    const mutationPlan =
      tool.spec.mutability === "write"
        ? ((await tool.planMutation?.(validation.value, context)) ?? {
            effect: "write" as const,
            reversibility: "none" as const,
            reason:
              "This write tool did not provide a durable operation-specific inverse plan.",
          })
        : {
            effect: "none" as const,
            reversibility: "none" as const,
          };
    if (
      enforceActionContract &&
      context.request.actionContract &&
      mutationPlan.effect === "write" &&
      !this.actionContracts
    ) {
      return createSyntheticErrorResult(
        call,
        `Write blocked: ${call.name} has no configured Action Contract verifier.`,
      );
    }
    const writeMode = getAgentLibraryWriteMode();
    const journalUnavailable =
      mutationPlan.effect === "write" && !isAgentChangeJournalAvailable();
    if (journalUnavailable && writeMode === "yolo") {
      return createSyntheticErrorResult(
        call,
        `${call.name} was refused because the durable change journal is unavailable. Unattended writes cannot run without restart-safe recovery.`,
      );
    }
    const planRequiresConfirmation =
      mutationPlan.requiresConfirmation === true ||
      (mutationPlan.effect === "write" &&
        (writeMode === "safe" ||
          (writeMode === "auto" &&
            (mutationPlan.reversibility !== "full" || journalUnavailable))));
    const shouldRequireConfirmation =
      options.forceConfirmation && tool.createPendingAction
        ? true
        : mutationPlan.effect === "write"
          ? planRequiresConfirmation
          : toolWantsConfirmation;
    const acceptsInheritedApproval =
      shouldRequireConfirmation &&
      !journalUnavailable &&
      options.inheritedApproval &&
      Boolean(
        await tool.acceptInheritedApproval?.(
          validation.value,
          options.inheritedApproval,
          context,
        ),
      );
    if (acceptsInheritedApproval) {
      return {
        kind: "result",
        execution: await runWithInput(
          validation.value,
          journalUnavailable
            ? { ...context, journalFallbackApproved: true }
            : context,
        ),
      };
    }
    if (shouldRequireConfirmation && tool.createPendingAction) {
      const requestId = createRequestId();
      const pendingAction = await tool.createPendingAction(
        validation.value,
        context,
      );
      return {
        kind: "confirmation",
        requestId,
        action: journalUnavailable
          ? withRecoveryWarning(
              pendingAction,
              "Zotero's durable journal is unavailable. If you continue, this change may not be recoverable after a restart.",
            )
          : pendingAction,
        execute: runConfirmedExecution,
        deny: () => ({
          tool,
          input: validation.value,
          result: {
            callId: call.id,
            name: call.name,
            ok: false,
            actionReceipts: finalizeReceipts({
              ok: false,
              cancelled: true,
              reason: "User denied action",
            }),
            content: { error: "User denied action" },
          },
        }),
      };
    }
    if (shouldRequireConfirmation) {
      return createSyntheticErrorResult(
        call,
        `${call.name} requires confirmation for this mutation plan, but the tool did not provide a confirmation action. The write was not executed.`,
      );
    }

    return {
      kind: "result",
      execution: await runWithInput(validation.value),
    };
  }
}
