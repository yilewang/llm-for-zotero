import type {
  AgentToolArtifact,
  AgentToolExecutionOutput,
  AgentPromptDefinition,
  AgentResourceDefinition,
  AgentToolCall,
  AgentToolContext,
  AgentToolDefinition,
  PreparedToolExecution,
  PromptSpec,
  ResourceSpec,
  ToolSpec,
} from "../types";

function createSyntheticErrorResult(
  call: AgentToolCall,
  message: string,
): PreparedToolExecution {
  return {
    kind: "result",
    result: {
      callId: call.id,
      name: call.name,
      ok: false,
      content: { error: message },
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
  private readonly resources = new Map<string, AgentResourceDefinition<any>>();
  private readonly prompts = new Map<string, AgentPromptDefinition<any>>();

  register<TInput, TResult>(tool: AgentToolDefinition<TInput, TResult>): void {
    this.tools.set(tool.spec.name, tool);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  registerResource<TValue>(resource: AgentResourceDefinition<TValue>): void {
    this.resources.set(resource.spec.name, resource);
  }

  registerPrompt<TArgs>(prompt: AgentPromptDefinition<TArgs>): void {
    this.prompts.set(prompt.spec.name, prompt);
  }

  listTools(): ToolSpec[] {
    return Array.from(this.tools.values()).map((tool) => tool.spec);
  }

  listToolDefinitions(): AgentToolDefinition<any, any>[] {
    return Array.from(this.tools.values());
  }

  listResources(): ResourceSpec[] {
    return Array.from(this.resources.values()).map((resource) => resource.spec);
  }

  listPrompts(): PromptSpec[] {
    return Array.from(this.prompts.values()).map((prompt) => prompt.spec);
  }

  getTool(name: string): AgentToolDefinition<any, any> | undefined {
    return this.tools.get(name);
  }

  getResource(name: string): AgentResourceDefinition<any> | undefined {
    return this.resources.get(name);
  }

  getPrompt(name: string): AgentPromptDefinition<any> | undefined {
    return this.prompts.get(name);
  }

  async prepareExecution(
    call: AgentToolCall,
    context: AgentToolContext,
  ): Promise<PreparedToolExecution> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return createSyntheticErrorResult(call, `Unknown tool: ${call.name}`);
    }
    const validation = tool.validate(call.arguments);
    if (!validation.ok) {
      return createSyntheticErrorResult(
        call,
        `Invalid tool input for ${call.name}: ${validation.error}`,
      );
    }

    const runExecution = async () => {
      const runWithInput = async (resolvedInput: typeof validation.value) => {
        try {
          const executionOutput = normalizeExecutionOutput(
            await tool.execute(resolvedInput, context),
          );
          return {
            callId: call.id,
            name: call.name,
            ok: true,
            content: executionOutput.content,
            artifacts: executionOutput.artifacts,
          };
        } catch (error) {
          return {
            callId: call.id,
            name: call.name,
            ok: false,
            content: {
              error: error instanceof Error ? error.message : String(error),
            },
          };
        }
      };
      return runWithInput(validation.value);
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
            callId: call.id,
            name: call.name,
            ok: false,
            content: {
              error: `Invalid confirmation input for ${call.name}: ${resolved.error}`,
            },
          };
        }
        try {
          const executionOutput = normalizeExecutionOutput(
            await tool.execute(resolved.value, context),
          );
          return {
            callId: call.id,
            name: call.name,
            ok: true,
            content: executionOutput.content,
            artifacts: executionOutput.artifacts,
          };
        } catch (error) {
          return {
            callId: call.id,
            name: call.name,
            ok: false,
            content: {
              error: error instanceof Error ? error.message : String(error),
            },
          };
        }
      }
      try {
        const executionOutput = normalizeExecutionOutput(
          await tool.execute(validation.value, context),
        );
        return {
          callId: call.id,
          name: call.name,
          ok: true,
          content: executionOutput.content,
          artifacts: executionOutput.artifacts,
        };
      } catch (error) {
        return {
          callId: call.id,
          name: call.name,
          ok: false,
          content: {
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }
    };

    const shouldRequireConfirmation =
      (await tool.shouldRequireConfirmation?.(validation.value, context)) ??
      tool.spec.requiresConfirmation;
    if (shouldRequireConfirmation && tool.createPendingAction) {
      const requestId = createRequestId();
      return {
        kind: "confirmation",
        requestId,
        action: await tool.createPendingAction(validation.value, context),
        execute: runConfirmedExecution,
        deny: () => ({
          callId: call.id,
          name: call.name,
          ok: false,
          content: { error: "User denied action" },
        }),
      };
    }

    return {
      kind: "result",
      result: await runExecution(),
    };
  }
}
