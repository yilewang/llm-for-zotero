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
} from "../types";
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
    delegateName: choice.tool.spec.name,
    delegateTool: choice.tool,
    delegateInput: validated.value,
  });
}

export function createRenamedTool<TInput, TResult>(params: {
  tool: AgentToolDefinition<TInput, TResult>;
  name: string;
  description: string;
  label?: string;
  exposure?: "model" | "internal";
  tier?: "normal" | "advanced";
}): AgentToolDefinition<TInput, TResult> {
  const { tool } = params;
  return {
    ...tool,
    spec: {
      ...tool.spec,
      name: params.name,
      description: params.description,
      exposure: params.exposure || "model",
      tier: params.tier || tool.spec.tier || "normal",
    },
    presentation: tool.presentation
      ? {
          ...tool.presentation,
          label: params.label || tool.presentation.label,
        }
      : params.label
        ? { label: params.label }
        : undefined,
    createPendingAction: tool.createPendingAction
      ? async (input, context) =>
          clonePendingAction(
            await tool.createPendingAction!(input, context),
            params.name,
          )
      : undefined,
    resolveResultReview: tool.resolveResultReview
      ? async (input, result, resolution, context) =>
          rewriteReviewResolution(
            await tool.resolveResultReview!(input, result, resolution, context),
            params.name,
          )
      : undefined,
  };
}

export function createDelegatingTool<TResult = unknown>(params: {
  name: string;
  description: string;
  inputSchema: object;
  mutability: "read" | "write";
  requiresConfirmation: boolean;
  label: string;
  summaries?: NonNullable<AgentToolDefinition["presentation"]>["summaries"];
  tier?: "normal" | "advanced";
  chooseDelegate: (args: unknown) => AgentToolInputValidation<DelegateChoice>;
}): AgentToolDefinition<DelegatedInput<any>, TResult> {
  return {
    spec: {
      name: params.name,
      description: params.description,
      inputSchema: params.inputSchema,
      mutability: params.mutability,
      requiresConfirmation: params.requiresConfirmation,
      exposure: "model",
      tier: params.tier || "normal",
    },
    presentation: {
      label: params.label,
      summaries: params.summaries,
    },
    validate(args) {
      const choice = params.chooseDelegate(args);
      if (!choice.ok) return fail(choice.error);
      return validateDelegate(choice.value);
    },
    async shouldRequireConfirmation(input, context) {
      const tool = input.delegateTool;
      if (tool.shouldRequireConfirmation) {
        return tool.shouldRequireConfirmation(input.delegateInput, context);
      }
      return tool.spec.requiresConfirmation;
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
      return tool.execute(input.delegateInput, context) as Promise<
        AgentToolExecutionOutput<TResult>
      >;
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
      return resolved ? rewriteReviewResolution(resolved, params.name) : {
        kind: "deliver",
        toolMessageContent: result.content,
      };
    },
  };
}
