import type {
  AgentRuntimeRequest,
  AgentToolDefinition,
  AgentToolResult,
  ToolSpec,
} from "../../types";
import { readOnlyInvocationPlan } from "../../authorization/invocationPlan";
import { canonicalJson } from "../../services/libraryMutation/canonicalJson";
import {
  compileScript,
  safeHostFunction,
  type ZoteroScriptRuntimeOptions,
} from "../write/zoteroScript";
import { fail, ok, validateObject } from "../shared";

type WorkflowScriptInput = {
  script: string;
  description: string;
  timeoutMs: number;
};

/** Scripts compose the live registry. The wrapper itself grants no effects. */
export function createWorkflowScriptTool(
  operations: (request: AgentRuntimeRequest) => ToolSpec[],
  options: ZoteroScriptRuntimeOptions = {},
): AgentToolDefinition<WorkflowScriptInput, unknown> {
  return {
    spec: {
      name: "workflow_script",
      description:
        "Compose registered tools with JavaScript loops and conditions. env.operations contains their current names and input schemas. await env.invoke(name, arguments) returns the ordinary tool result and native receipts. Each invocation independently validates scope and permissions. No Zotero or platform globals are exposed. Use this for conditional or bulk composition when a single registered operation is insufficient; fixed prepared actions advance automatically.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["script", "description"],
        properties: {
          script: { type: "string" },
          description: { type: "string" },
          timeoutMs: {
            type: "number",
            description:
              "Cooperative time limit in milliseconds; at most 120000",
          },
        },
      },
      executionClass: "control",
      requiresConfirmation: false,
      localAgentOnly: true,
    },
    describeAction: () => [],
    planInvocation: () =>
      readOnlyInvocationPlan({
        domains: [],
        reason:
          "The script composes separately authorized registered operations; it has no direct native access.",
      }),
    validate(args) {
      if (
        !validateObject<Record<string, unknown>>(args) ||
        typeof args.script !== "string" ||
        !args.script.trim() ||
        typeof args.description !== "string" ||
        !args.description.trim()
      )
        return fail("script and description are required");
      return ok({
        script: args.script,
        description: args.description,
        timeoutMs:
          typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)
            ? Math.min(120000, Math.max(1000, args.timeoutMs))
            : 30000,
      });
    },
    async execute(input, context) {
      const invoke = context.invokeRegisteredOperation;
      if (!invoke)
        throw new Error(
          "The registered operation execution bridge is unavailable.",
        );
      const available = operations(context.request).filter(
        (spec) =>
          spec.executionClass !== "control" && spec.name !== "zotero_script",
      );
      const allowed = new Set(available.map((spec) => spec.name));
      const completed: AgentToolResult[] = [];
      const rejected = new Set<string>();
      const deadline = Date.now() + input.timeoutMs;
      let closed = false;
      let cancelled = false;
      let queue: Promise<unknown> = Promise.resolve();
      const shouldStop = () =>
        closed ||
        cancelled ||
        Boolean(context.signal?.aborted) ||
        Date.now() >= deadline;
      // Only primitives cross back into the sandbox. Its own JSON.parse creates
      // data objects, and this null-prototype thenable never exposes a host Promise.
      const invokeJson = safeHostFunction((name, json) => {
        const operation = queue.then(async () => {
          if (shouldStop())
            throw new Error(
              "Workflow execution stopped before the next operation.",
            );
          if (typeof name !== "string" || !allowed.has(name))
            throw new Error("Unknown or unavailable registered operation.");
          if (typeof json !== "string")
            throw new Error("Operation arguments must be JSON.");
          const args: unknown = JSON.parse(json);
          const fingerprint = canonicalJson({ name, args });
          if (rejected.has(fingerprint))
            throw new Error(
              "An unchanged rejected proposal cannot be retried; correct its arguments or resolve the missing state.",
            );
          const result = await invoke(name, args);
          completed.push(result);
          if (!result.ok) rejected.add(fingerprint);
          if (
            result.actionReceipts.some(
              (receipt) => receipt.status === "cancelled",
            )
          )
            cancelled = true;
          return JSON.stringify(result);
        });
        queue = operation.catch(() => undefined);
        return Object.freeze(
          Object.assign(Object.create(null), {
            then: safeHostFunction((resolve, reject) => {
              void operation.then(
                (value) => {
                  if (typeof resolve === "function") resolve(value);
                },
                (error) => {
                  if (typeof reject === "function") reject(String(error));
                },
              );
            }),
          }),
        );
      });
      const bridge = Object.freeze(
        Object.assign(Object.create(null), {
          operationsJson: JSON.stringify(available),
          invokeJson,
          shouldStop: safeHostFunction(shouldStop),
        }),
      );
      let returnValue: unknown;
      let error: string | undefined;
      try {
        const script = compileScript(
          `const bridge = env; env = Object.freeze({ operations: JSON.parse(bridge.operationsJson), invoke: async (name, args) => JSON.parse(await bridge.invokeJson(name, JSON.stringify(args))), shouldStop: () => bridge.shouldStop() });\n${input.script}`,
          "operations",
          "read",
          options,
        );
        returnValue = await script(undefined, bridge);
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure);
      } finally {
        closed = true;
        await queue;
      }
      if (!error && context.signal?.aborted)
        error = "Workflow execution was interrupted.";
      if (!error && Date.now() >= deadline)
        error = "Workflow execution reached its time limit.";
      if (error) throw new Error(error);
      return {
        content: {
          returnValue,
          operations: completed,
        },
        effect: "none",
      };
    },
  };
}
