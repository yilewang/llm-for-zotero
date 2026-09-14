import { isSelfContainedSelectionEdit } from "../model/noteEditingPolicy";
import { defaultInvocationPlan } from "../authorization/invocationPlan";
import type { ActionContractService } from "../contracts/actionContract";
import type { PlanAmendmentService } from "../plans/amendments";
import { isMalformedToolArgumentsDiagnostic } from "../toolArgumentDiagnostics";
import type {
  AgentRuntimeRequest,
  AgentToolCall,
  AgentToolContext,
  AgentToolDefinition,
  PreparedToolExecution,
  PreparedToolExecutionOptions,
  ToolSpec,
} from "../types";
import { InvocationController } from "./execution/controller";
import { createSyntheticErrorResult } from "./execution/results";
import {
  selectWorkflowStep,
  type PreparedActionBinding,
  type PreparedActionBindings,
} from "./workflowSteps";
function assertPortableModelToolSchema(spec: ToolSpec): void {
  if (spec.exposure === "internal") return;

  const schema = spec.inputSchema;
  if (
    !schema ||
    typeof schema !== "object" ||
    Array.isArray(schema) ||
    (schema as Record<string, unknown>).type !== "object"
  ) {
    throw new Error(
      `Tool "${spec.name}" has an incompatible model-visible inputSchema: the schema root must be a non-array object with type: "object".`,
    );
  }

  for (const keyword of ["oneOf", "allOf", "anyOf"] as const) {
    if (Object.prototype.hasOwnProperty.call(schema, keyword)) {
      throw new Error(
        `Tool "${spec.name}" has an incompatible model-visible inputSchema: root-level "${keyword}" is not portable across providers. Move alternatives into properties and enforce cross-field rules in validate().`,
      );
    }
  }
}

export class AgentToolRegistry {
  private readonly tools = new Map<string, AgentToolDefinition<any, any>>();

  constructor(
    private readonly actionContracts?: ActionContractService,
    private readonly planAmendments?: PlanAmendmentService,
  ) {}

  async createActionContract(
    request: AgentRuntimeRequest,
  ): Promise<NonNullable<AgentRuntimeRequest["actionContract"]> | null> {
    if (this.actionContracts) {
      return this.actionContracts.createContract(request);
    }
    if (
      request.classifiedIntent?.actionIntents.some(
        (intent) => intent.operation !== "read_full",
      )
    ) {
      throw new Error(
        "Action execution requires the native action contract resolver.",
      );
    }
    return null;
  }

  private readonly actionBindings: PreparedActionBindings = new Map();

  registerActionBinding(
    operation: import("../types").AgentActionOperation,
    binding: PreparedActionBinding,
  ): void {
    if (this.actionBindings.has(operation))
      throw new Error(`Duplicate prepared action binding: ${operation}`);
    this.actionBindings.set(operation, binding);
  }

  async getNextWorkflowStep(
    request: AgentRuntimeRequest,
    allowedObligationIds?: readonly string[],
  ) {
    const resolved = this.actionContracts?.resolveWorkflowContract(
      request.actionContract,
      request.actionProgress,
    );
    const step = await selectWorkflowStep(
      resolved ? { ...request, actionContract: resolved } : request,
      this.actionBindings,
      allowedObligationIds,
    );
    if (step.kind !== "action") return step;
    const tool = this.tools.get(step.prepared.call.name);
    const validation = tool?.validate(step.prepared.call.arguments);
    if (!validation?.ok)
      return {
        kind: "blocked" as const,
        code: "invalid_binding" as const,
        reason: `The registered ${step.prepared.call.name} action binding is invalid. No action was executed.`,
      };
    return step;
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
      authorizationGrants: [],
      updatedAt: Date.now(),
    };
  }

  private isModelVisibleTool(tool: AgentToolDefinition<any, any>): boolean {
    return tool.spec.exposure !== "internal";
  }

  private filterToolsForRequest(
    request: AgentRuntimeRequest,
  ): AgentToolDefinition<any, any>[] {
    const selectionEdit = isSelfContainedSelectionEdit(request);
    const noteTools = new Set([
      "note_write",
      "library_read",
      "request_user_input",
    ]);
    return Array.from(this.tools.values()).filter(
      (tool) =>
        this.isModelVisibleTool(tool) &&
        tool.isAvailable?.(request) !== false &&
        (!selectionEdit || noteTools.has(tool.spec.name)),
    );
  }

  register<TInput, TResult>(tool: AgentToolDefinition<TInput, TResult>): void {
    assertPortableModelToolSchema(tool.spec);
    const registered = tool.planInvocation
      ? tool
      : {
          ...tool,
          planInvocation: () => defaultInvocationPlan(tool.spec.executionClass),
        };
    this.tools.set(tool.spec.name, registered);
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
    // Authorization happens after input validation and exact effect
    // assessment. A coarse tool label is never the authorization boundary.
    if (isMalformedToolArgumentsDiagnostic(call.arguments)) {
      return createSyntheticErrorResult(
        call,
        `Invalid tool input for ${call.name}: ${call.name} received malformed tool arguments from the model. Retry with valid JSON.`,
        { inputRejected: true },
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
        { inputRejected: true },
      );
    }

    return new InvocationController(
      call,
      tool,
      context,
      options,
      this.actionContracts,
      this.planAmendments,
    ).prepare(validation.value);
  }
}
