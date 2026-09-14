import { createUpdatePlanTool } from "./updatePlan";
import {
  preparePlanExecution,
  validateUpdatePlanInput,
  type UpdatePlanInput,
} from "../../plans/preparation";
import type { AgentToolDefinition } from "../../types";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { fail, validateObject } from "../shared";

/** Native Codex authors the proposal; this tool stages only its execution requirements. */
export function createPreparePlanExecutionTool(
  gateway?: ZoteroGateway,
): AgentToolDefinition<UpdatePlanInput, unknown> {
  const original = createUpdatePlanTool(gateway);
  const {
    ready: _ready,
    explanation: _explanation,
    ...properties
  } = (original.spec.inputSchema as { properties: Record<string, unknown> })
    .properties;
  return {
    ...original,
    spec: {
      ...original.spec,
      name: "prepare_plan_execution",
      description:
        "Prepare the typed execution contract and required steps for your native Codex plan. Call before completing the native plan proposal. This validates and freezes the intended Zotero scope and deliverable, but cannot approve or mark a proposal ready. Do not include progress-checklist steps or claim completed work. Use the existing contract schema and typed acceptance criteria; omit effects unless the user requested library changes.",
      inputSchema: {
        ...original.spec.inputSchema,
        required: ["contract", "steps"],
        properties,
      },
    },
    guidance: undefined,
    isAvailable: (request) =>
      request.planContext?.phase === "planning" &&
      Boolean(request.planContext.nativePlanning),
    validate: (args) => {
      if (!validateObject(args) || !validateObject(args.contract))
        return fail(
          "prepare_plan_execution requires an explicit typed contract",
        );
      return validateUpdatePlanInput({
        ...args,
        ready: false,
      });
    },
    execute: async (input, context) => {
      if (
        context.request.planContext?.phase !== "planning" ||
        !context.request.planContext.nativePlanning
      ) {
        throw new Error(
          "prepare_plan_execution requires an active native planning attempt",
        );
      }
      const artifact = await preparePlanExecution(
        { ...input, ready: false, explanation: undefined },
        context,
        gateway,
      );
      await context.publishPlanEvent?.({ type: "plan_updated", artifact });
      return {
        artifact,
        next: "Complete your native plan proposal. Execution remains blocked until the user reviews and approves it.",
      };
    },
  };
}
