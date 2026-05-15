import type {
  AgentToolArtifact,
  AgentToolExecutionOutput,
  PreparedToolExecutionOptions,
  AgentRuntimeRequest,
  AgentToolCall,
  AgentToolContext,
  AgentToolDefinition,
  PreparedToolExecution,
  ToolSpec,
} from "../types";

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
        content: { error: message },
      },
    },
  };
}

function createRequestId(): string {
  return `confirm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeExecutionOutput(
  value: AgentToolExecutionOutput<any>,
): { content: unknown; artifacts?: AgentToolArtifact[] } {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as {
      content?: unknown;
      artifacts?: unknown;
    };
    if (Object.prototype.hasOwnProperty.call(record, "content")) {
      return {
        content: record.content,
        artifacts: Array.isArray(record.artifacts)
          ? (record.artifacts as AgentToolArtifact[])
          : undefined,
      };
    }
  }
  return {
    content: value,
  };
}

export class AgentToolRegistry {
  private readonly tools = new Map<string, AgentToolDefinition<any, any>>();

  private isModelVisibleTool(tool: AgentToolDefinition<any, any>): boolean {
    return tool.spec.exposure !== "internal";
  }

  private filterToolsForRequest(
    request: AgentRuntimeRequest,
  ): AgentToolDefinition<any, any>[] {
    return Array.from(this.tools.values()).filter(
      (tool) =>
        this.isModelVisibleTool(tool) &&
        tool.isAvailable?.(request) !== false,
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
      .filter((tool) => this.isModelVisibleTool(tool))
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
    const validation = tool.validate(call.arguments);
    if (!validation.ok) {
      const validationError =
        call.name === "library_search" &&
        context.request.selectedCollectionContexts?.length &&
        validation.error.includes("entity and mode are required")
          ? `${validation.error} For selected collections, use ` +
            "{ entity:'items', mode:'list', filters:{ collectionId:<collectionId> } }."
          : validation.error;
      return createSyntheticErrorResult(
        call,
        `Invalid tool input for ${call.name}: ${validationError}`,
      );
    }

    const runWithInput = async (resolvedInput: typeof validation.value) => {
      try {
        const executionOutput = normalizeExecutionOutput(
          await tool.execute(resolvedInput, context),
        );
        return {
          tool,
          input: resolvedInput,
          result: {
            callId: call.id,
            name: call.name,
            ok: true,
            content: executionOutput.content,
            artifacts: executionOutput.artifacts,
          },
        };
      } catch (error) {
        return {
          tool,
          input: resolvedInput,
          result: {
            callId: call.id,
            name: call.name,
            ok: false,
            content: {
              error: error instanceof Error ? error.message : String(error),
            },
          },
        };
      }
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
              content: {
                error: `Invalid confirmation input for ${call.name}: ${resolved.error}`,
              },
            },
          };
        }
        return runWithInput(resolved.value);
      }
      return runWithInput(validation.value);
    };

    const shouldRequireConfirmation =
      options.forceConfirmation && tool.createPendingAction
        ? true
        : ((await tool.shouldRequireConfirmation?.(validation.value, context)) ??
          tool.spec.requiresConfirmation);
    const acceptsInheritedApproval =
      shouldRequireConfirmation &&
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
        execution: await runWithInput(validation.value),
      };
    }
    if (shouldRequireConfirmation && tool.createPendingAction) {
      const requestId = createRequestId();
      return {
        kind: "confirmation",
        requestId,
        action: await tool.createPendingAction(validation.value, context),
        execute: runConfirmedExecution,
        deny: () => ({
          tool,
          input: validation.value,
          result: {
            callId: call.id,
            name: call.name,
            ok: false,
            content: { error: "User denied action" },
          },
        }),
      };
    }

    return {
      kind: "result",
      execution: await runWithInput(validation.value),
    };
  }
}
