import type {
  AgentConfirmationResolution,
  AgentInheritedApproval,
  AgentModelMessage,
  AgentPendingAction,
  AgentToolContext,
  AgentToolDefinition,
  AgentToolExecutionOutput,
  AgentToolInputValidation,
  AgentToolResult,
  AgentToolReviewResolution,
  AgentWorkCategory,
} from "../types";
import { defaultInvocationPlan } from "../authorization/invocationPlan";
import { describeLibraryMutationActions } from "../contracts/actionContract";
import { fail, ok } from "./shared";

type DelegatedInput<TInput> = {
  delegateName: string;
  delegateTool: AgentToolDefinition<TInput, any>;
  delegateInput: TInput;
};

type DelegateChoice = {
  tool: AgentToolDefinition<any, any>;
  args: unknown;
};

function clonePendingAction(
  action: AgentPendingAction,
  toolName: string,
): AgentPendingAction {
  return {
    ...action,
    toolName,
  };
}

function rewriteInheritedApproval(
  approval: AgentInheritedApproval | undefined,
  sourceToolName: string,
): AgentInheritedApproval | undefined {
  if (!approval) return undefined;
  return {
    ...approval,
    sourceToolName,
  };
}

function rewriteReviewResolution(
  resolution: AgentToolReviewResolution,
  sourceToolName: string,
): AgentToolReviewResolution {
  if (resolution.kind !== "invoke_tool") return resolution;
  return {
    ...resolution,
    call: {
      ...resolution.call,
      inheritedApproval: rewriteInheritedApproval(
        resolution.call.inheritedApproval,
        sourceToolName,
      ),
    },
  };
}

function validateDelegate(
  choice: DelegateChoice,
): AgentToolInputValidation<DelegatedInput<any>> {
  const validated = choice.tool.validate(choice.args);
  if (!validated.ok) {
    return fail(validated.error);
  }
  return ok({
    // A delegate's spec.name is an internal identifier used for journaling
    // and presentation. Delegates are never registered, so the model cannot
    // call them by this name; only the facade that owns them is a tool.
    delegateName: choice.tool.spec.name,
    delegateTool: choice.tool,
    delegateInput: validated.value,
  });
}

export function createDelegatingTool<TResult = unknown>(params: {
  name: string;
  description: string;
  inputSchema: object;
  executionClass: "read" | "control" | "external_effect";
  workCategory: AgentWorkCategory;
  label: string;
  traceIcon?: NonNullable<AgentToolDefinition["presentation"]>["traceIcon"];
  summaries?: NonNullable<AgentToolDefinition["presentation"]>["summaries"];
  guidance?: AgentToolDefinition<DelegatedInput<any>, TResult>["guidance"];
  /**
   * Every tool this facade can route to. The facade performs no effect of its
   * own, so its declared effect operations are exactly the union of theirs;
   * adding a delegate therefore widens the facade automatically and cannot
   * leave the declaration behind.
   */
  delegates: AgentToolDefinition<any, any>[];
  chooseDelegate: (args: unknown) => AgentToolInputValidation<DelegateChoice>;
}): AgentToolDefinition<DelegatedInput<any>, TResult> {
  return {
    effectOperations: [
      ...new Set(
        params.delegates.flatMap((tool) => tool.effectOperations || []),
      ),
    ],
    spec: {
      name: params.name,
      description: params.description,
      inputSchema: params.inputSchema,
      executionClass: params.executionClass,
      workCategory: params.workCategory,
      exposure: "model",
    },
    guidance: params.guidance,
    presentation: {
      label: params.label,
      ...(params.traceIcon ? { traceIcon: params.traceIcon } : {}),
      summaries: params.summaries,
    },
    validate(args) {
      const choice = params.chooseDelegate(args);
      if (!choice.ok) return fail(choice.error);
      return validateDelegate(choice.value);
    },
    // The trace must name the work this call performs, and the delegate is
    // already decided by the arguments. Freezing the facade's own category
    // would label every import as the widest mode it can reach.
    resolveWorkCategory(args) {
      const choice = params.chooseDelegate(args);
      return choice.ok ? choice.value.tool.spec.workCategory : undefined;
    },
    describeAction: (input, context) =>
      input.delegateTool.describeAction?.(input.delegateInput, context) ||
      describeLibraryMutationActions(input.delegateInput),
    async planInvocation(input, context) {
      const tool = input.delegateTool;
      if (tool.planInvocation) {
        return tool.planInvocation(input.delegateInput, context);
      }
      return defaultInvocationPlan(tool.spec.executionClass);
    },
    async acceptInheritedApproval(input, approval, context) {
      const tool = input.delegateTool;
      return Boolean(
        await tool.acceptInheritedApproval?.(
          input.delegateInput,
          approval,
          context,
        ),
      );
    },
    async createPendingAction(input, context) {
      const tool = input.delegateTool;
      if (!tool.createPendingAction) {
        throw new Error(
          `Internal delegate does not support confirmation: ${input.delegateName}`,
        );
      }
      return clonePendingAction(
        await tool.createPendingAction(input.delegateInput, context),
        params.name,
      );
    },
    applyConfirmation(input, resolutionData, context) {
      const tool = input.delegateTool;
      if (!tool.applyConfirmation) return ok(input);
      const resolved = tool.applyConfirmation(
        input.delegateInput,
        resolutionData,
        context,
      );
      if (!resolved.ok) return fail(resolved.error);
      return ok({
        ...input,
        delegateInput: resolved.value,
      });
    },
    async execute(input, context): Promise<AgentToolExecutionOutput<TResult>> {
      const tool = input.delegateTool;
      return tool.execute(input.delegateInput, {
        ...context,
        journalToolName: context.journalToolName || params.name,
      }) as Promise<AgentToolExecutionOutput<TResult>>;
    },
    // A delegate whose result is the turn's answer, a published document,
    // keeps that through the facade.
    async resolveTerminalResult(input, result, context) {
      return (
        (await input.delegateTool.resolveTerminalResult?.(
          input.delegateInput,
          result,
          context,
        )) ?? null
      );
    },
    async buildFollowupMessage(
      result: AgentToolResult,
      context: AgentToolContext,
    ): Promise<AgentModelMessage | null> {
      void context;
      void result;
      return null;
    },
    async createResultReviewAction(input, result, context) {
      const tool = input.delegateTool;
      const action = await tool.createResultReviewAction?.(
        input.delegateInput,
        result,
        context,
      );
      return action ? clonePendingAction(action, params.name) : null;
    },
    async resolveResultReview(input, result, resolution, context) {
      const tool = input.delegateTool;
      const resolved = await tool.resolveResultReview?.(
        input.delegateInput,
        result,
        resolution,
        context,
      );
      return resolved
        ? rewriteReviewResolution(resolved, params.name)
        : {
            kind: "deliver",
            toolMessageContent: result.content,
          };
    },
  };
}
