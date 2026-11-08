import { assert } from "chai";
import {
  prohibitedInvocationPlan,
  readOnlyInvocationPlan,
  stateChangeInvocationPlan,
} from "../src/agent/authorization/invocationPlan";
import { buildActionCallDigest } from "../src/agent/authorization/proposal";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import { createMalformedToolArgumentsDiagnostic } from "../src/agent/toolArgumentDiagnostics";
import { describeLibraryMutationInput } from "../src/agent/contracts/actionContract";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import type { AgentToolContext, AgentToolDefinition } from "../src/agent/types";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";

const describeTestMutation = () => [
  {
    id: "settings:test",
    proofDomain: "zotero_state" as const,
    capability: "zotero.settings" as const,
    operation: "settings_update" as const,
    source: "zotero_native" as const,
    requestedTargets: [],
    destinationCollectionIds: [],
  },
];

describe("AgentToolRegistry", function () {
  const originalZotero = globalThis.Zotero;

  afterEach(function () {
    globalThis.Zotero = originalZotero;
  });

  const baseContext: AgentToolContext = {
    request: {
      conversationKey: 1,
      mode: "agent",
      userText: "test",
      libraryID: 1,
      // An ordinary agent turn: the in-plugin agent owns permission.
      executionContext: {
        version: 1,
        executionId: "registry-run",
        conversationKey: 1,
        conversationGeneration: 0,
        chatLibraryID: 1,
        permissionOwner: "original_agent",
        workspaceSnapshot: { selectedPapers: [], selectedCollections: [] },
        configuredAccess: { libraryIDs: [1], outputDirectories: [] },
      },
    } as AgentToolContext["request"],
    item: null,
    currentAnswerText: "",
    modelName: "gpt-4o-mini",
  };

  for (const mode of ["safe", "auto", "yolo"] as const) {
    for (const entryPoint of ["action_ui", "conversation"] as const) {
      it(`${mode}/${entryPoint}: counts required confirmations before a native effect`, async function () {
        globalThis.Zotero = {
          DB: new ChangeJournalTestDb(),
          Prefs: { get: () => mode },
          debug: () => undefined,
        } as never;
        await initAgentChangeJournal();
        const registry = new AgentToolRegistry(
          new ActionContractService({} as never),
        );
        let writes = 0,
          confirmations = 0;
        registry.register({
          effectOperations: ["settings_update"],
          spec: {
            name: "interaction_write",
            description: "fixture",
            inputSchema: { type: "object" },
            executionClass: "external_effect",
            requiresConfirmation: true,
          },
          validate: (args) => ({ ok: true, value: args }),
          describeAction: describeTestMutation,
          planInvocation: () =>
            stateChangeInvocationPlan({
              domains: ["zotero_library"],
              effects: ["modify"],
              reason: "Apply exact requested setting",
            }),
          execute: async () => {
            writes++;
            return { content: { changed: true }, effect: "applied" };
          },
        });
        const request = JSON.parse(JSON.stringify(baseContext.request));
        request.actionEntryPoint = entryPoint;
        let prepared = await registry.prepareExecution(
          {
            id: "matrix",
            name: "interaction_write",
            arguments: {
              actionEntryPoint: "action_ui",
              reviewPreference: "direct",
            },
          },
          { ...baseContext, request },
        );
        // Model-supplied review hints never override the permission mode.
        const expected = mode === "safe" ? 1 : 0;
        if (prepared.kind === "confirmation") {
          confirmations++;
          assert.equal(writes, 0);
          prepared = await prepared.execute({ approved: true });
        }
        assert.equal(confirmations, expected);
        assert.equal(prepared.kind, "result");
        assert.equal(writes, 1);
      });
    }
  }

  it("persists MCP proposal authority before allowing a native effect", async function () {
    const db = new ChangeJournalTestDb();
    globalThis.Zotero = {
      DB: db,
      Prefs: { get: () => "auto" },
      debug: () => undefined,
    } as never;
    await initAgentChangeJournal();
    const registry = new AgentToolRegistry(
      new ActionContractService({} as never),
    );
    let executions = 0;
    let staged = 0;
    registry.register({
      effectOperations: ["settings_update"],
      spec: {
        name: "settings_test",
        description: "fixture",
        inputSchema: { type: "object" },
        executionClass: "external_effect",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args }),
      describeAction: describeTestMutation,
      planInvocation: () =>
        stateChangeInvocationPlan({
          domains: ["settings"],
          reason: "Update requested setting.",
        }),
      execute: async () => {
        executions++;
        return { content: { ok: true }, effect: "applied" };
      },
    });
    db.failWhen = (_sql, params) => {
      if (!params.includes("original_authorization_prepared")) return null;
      staged++;
      return new Error("Durable store unavailable");
    };
    const prepared = await registry.prepareExecution(
      { id: "mcp-authority", name: "settings_test", arguments: {} },
      { ...baseContext, runId: "provider-turn" },
      { callerKind: "mcp" },
    );
    assert.equal(executions, 0);
    assert.equal(staged, 1);
    assert.equal(prepared.kind, "result");
    if (prepared.kind !== "result") return;
    assert.isFalse(prepared.execution.result.ok);
    assert.include(
      JSON.stringify(prepared.execution.result.content),
      "Durable store unavailable",
    );
  });

  it("does not execute a changed Auto payload using the earlier persisted grant", async function () {
    const db = new ChangeJournalTestDb();
    globalThis.Zotero = {
      DB: db,
      Prefs: { get: () => "auto" },
      debug: () => undefined,
    } as never;
    await initAgentChangeJournal();
    const registry = new AgentToolRegistry(
      new ActionContractService({} as never),
    );
    let targets = ["setting:original"],
      writes = 0;
    registry.register({
      effectOperations: ["settings_update"],
      spec: {
        name: "changing_settings",
        description: "fixture",
        inputSchema: { type: "object" },
        executionClass: "external_effect",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args }),
      describeAction: describeTestMutation,
      planInvocation: () =>
        stateChangeInvocationPlan({
          domains: ["settings"],
          targets,
          reason: "Change requested settings",
        }),
      execute: async () => {
        writes++;
        return { content: {}, effect: "applied" };
      },
    });
    // State drifts after the grant is journaled and before the effect runs.
    db.failWhen = (_sql, params) => {
      if (params.includes("original_authorization_prepared"))
        targets = ["setting:different"];
      return null;
    };
    const result = await registry.prepareExecution(
      { id: "changing", name: "changing_settings", arguments: {} },
      { ...baseContext, runId: "exact-auto" },
    );
    assert.equal(writes, 0);
    assert.equal(
      result.kind,
      "result",
      "state drift returns a corrective result, not a permission prompt",
    );
    if (result.kind === "result") assert.isFalse(result.execution.result.ok);
    assert.deepEqual(
      [...db.observations.values()].map((row) => row.event),
      ["original_authorization_prepared", "original_execution_failed"],
    );
  });

  function createSchemaTool(params: {
    name: string;
    inputSchema: object;
    exposure?: "model" | "internal";
    description?: string;
  }): AgentToolDefinition<unknown, unknown> {
    return {
      spec: {
        name: params.name,
        description: params.description || "schema fixture",
        inputSchema: params.inputSchema,
        executionClass: "read",
        requiresConfirmation: false,
        exposure: params.exposure,
      },
      validate: (args) => ({ ok: true, value: args }),
      execute: async (input) => input,
    };
  }

  it("returns an error result for unknown tools", async function () {
    const registry = new AgentToolRegistry(
      new ActionContractService({} as never),
    );
    const result = await registry.prepareExecution(
      {
        id: "call-1",
        name: "missing_tool",
        arguments: {},
      },
      baseContext,
    );

    assert.equal(result.kind, "result");
    if (result.kind !== "result") return;
    assert.equal(result.execution.result.ok, false);
    assert.include(
      String((result.execution.result.content as { error?: string }).error),
      "Unknown tool",
    );
    assert.isUndefined(result.execution.result.inputRejected);
  });

  it("rejects leaked provider markup as a malformed call, not an unknown tool", async function () {
    const registry = new AgentToolRegistry(
      new ActionContractService({} as never),
    );
    const result = await registry.prepareExecution(
      {
        id: "call-2",
        name: "quote:Q_1</\uff5c\uff5cDSML\uff5c\uff5c parameter>",
        arguments: {},
      },
      baseContext,
    );

    assert.equal(result.kind, "result");
    if (result.kind !== "result") return;
    assert.isFalse(result.execution.result.ok);
    assert.isTrue(result.execution.result.inputRejected);
    const error = String(
      (result.execution.result.content as { error?: string }).error,
    );
    assert.include(error, "Malformed tool call");
    assert.notInclude(error, "Unknown tool");
  });

  it("does not invent a write receipt when an explicit adapter describes a confined read", async function () {
    for (const contracts of [
      undefined,
      new ActionContractService({} as never),
    ]) {
      const registry = new AgentToolRegistry(contracts);
      registry.register({
        effectOperations: ["settings_update"],
        spec: {
          name: "zotero_script",
          description: "Confined read",
          inputSchema: { type: "object" },
          executionClass: "external_effect",
          requiresConfirmation: true,
        },
        validate: () => ({ ok: true, value: {} }),
        describeAction: () => [],
        planInvocation: () =>
          readOnlyInvocationPlan({ reason: "Runtime-confined read" }),
        execute: async () => ({
          content: { value: "Read result" },
          effect: "none",
        }),
      });
      const result = await registry.prepareExecution(
        { id: "read", name: "zotero_script", arguments: {} },
        baseContext,
      );
      assert.equal(result.kind, "result");
      if (result.kind !== "result") return;
      assert.isTrue(result.execution.result.ok);
      assert.isEmpty(result.execution.result.actionReceipts || []);
    }
  });

  it("gives every registered tool one complete invocation planner", async function () {
    const registry = new AgentToolRegistry(
      new ActionContractService({} as never),
    );
    registry.register({
      spec: {
        name: "plain_read",
        description: "read",
        inputSchema: { type: "object" },
        executionClass: "read",
        requiresConfirmation: false,
      },
      validate: () => ({ ok: true, value: {} }),
      execute: async () => ({ ok: true }),
    });

    const registered = registry.getTool("plain_read");
    assert.isFunction(registered?.planInvocation);
    const plan = await registered?.planInvocation?.({}, baseContext);
    assert.deepInclude(plan, {
      mechanism: "none",
      impact: "read_only",
      assurance: "runtime_enforced",
      reversibility: "full",
    });
    assert.isArray(plan?.domains);
    assert.isArray(plan?.effects);
    assert.isArray(plan?.targets);
    assert.isArray(plan?.riskSignals);
    assert.isNotEmpty(plan?.reason || "");
  });

  it("rejects root composition in model-visible schemas before replacing a tool", function () {
    for (const keyword of ["oneOf", "allOf", "anyOf"] as const) {
      const registry = new AgentToolRegistry(
        new ActionContractService({} as never),
      );
      const name = `portable_${keyword}`;
      registry.register(
        createSchemaTool({
          name,
          inputSchema: { type: "object" },
          description: "existing tool",
        }),
      );

      let registrationError: unknown;
      try {
        registry.register(
          createSchemaTool({
            name,
            inputSchema: { type: "object", [keyword]: [] },
            description: "invalid replacement",
          }),
        );
      } catch (error) {
        registrationError = error;
      }
      assert.instanceOf(registrationError, Error);
      const message = (registrationError as Error).message;
      assert.include(message, name);
      assert.include(message, keyword);
      assert.include(message, "properties");
      assert.include(message, "validate()");
      assert.equal(registry.getTool(name)?.spec.description, "existing tool");
    }
  });

  it("requires a non-array object schema with type object for model-visible tools", function () {
    const invalidSchemas: Array<{ label: string; schema: object }> = [
      { label: "array root", schema: [] },
      { label: "null root", schema: null as unknown as object },
      { label: "missing type", schema: {} },
      { label: "array type", schema: { type: "array" } },
    ];

    for (const fixture of invalidSchemas) {
      const registry = new AgentToolRegistry(
        new ActionContractService({} as never),
      );
      const name = `invalid_${fixture.label.replace(/ /g, "_")}`;
      let registrationError: unknown;
      try {
        registry.register(
          createSchemaTool({ name, inputSchema: fixture.schema }),
        );
      } catch (error) {
        registrationError = error;
      }
      assert.instanceOf(registrationError, Error);
      const message = (registrationError as Error).message;
      assert.include(message, name);
      assert.include(message, 'type: "object"');
    }
  });

  it("permits root composition for internal-only tool schemas", function () {
    const registry = new AgentToolRegistry(
      new ActionContractService({} as never),
    );
    registry.register(
      createSchemaTool({
        name: "internal_composed_tool",
        inputSchema: { allOf: [{ type: "object" }] },
        exposure: "internal",
      }),
    );

    assert.exists(registry.getTool("internal_composed_tool"));
    assert.notInclude(
      registry.listTools().map((tool) => tool.name),
      "internal_composed_tool",
    );
  });

  it("rejects malformed diagnostic arguments centrally before validation", async function () {
    const registry = new AgentToolRegistry(
      new ActionContractService({} as never),
    );
    let validateCalls = 0;
    registry.register({
      describeAction: describeLibraryMutationInput,
      effectOperations: ["zotero_script_execute"],
      spec: {
        name: "zotero_script",
        description: "run a Zotero script",
        inputSchema: { type: "object" },
        executionClass: "external_effect",
        requiresConfirmation: true,
      },
      validate: () => {
        validateCalls += 1;
        return { ok: false, error: "mode must be 'read' or 'write'" };
      },
      execute: async () => ({
        content: { ok: true },
        effect: "applied",
      }),
    });

    const result = await registry.prepareExecution(
      {
        id: "call-malformed",
        name: "zotero_script",
        arguments: createMalformedToolArgumentsDiagnostic(
          '{"mode":"read","script": secret draft',
        ),
      },
      baseContext,
    );

    assert.equal(validateCalls, 0);
    assert.equal(result.kind, "result");
    if (result.kind !== "result") return;
    assert.equal(result.execution.result.ok, false);
    assert.equal(
      String((result.execution.result.content as { error?: string }).error),
      "Invalid tool input for zotero_script: zotero_script received malformed tool arguments from the model. Retry with valid JSON.",
    );
  });

  it("gates write tools behind confirmation", async function () {
    globalThis.Zotero = {
      DB: new ChangeJournalTestDb(),
      Prefs: { get: () => "safe" },
      debug: () => undefined,
    } as never;
    await initAgentChangeJournal();
    const registry = new AgentToolRegistry(
      new ActionContractService({} as never),
    );
    registry.register({
      effectOperations: ["settings_update"],
      spec: {
        name: "mutate_library",
        description: "apply changes",
        inputSchema: { type: "object" },
        executionClass: "external_effect",
        requiresConfirmation: true,
      },
      validate: (args) =>
        Array.isArray((args as { operations?: unknown })?.operations)
          ? {
              ok: true,
              value: {
                operations: (
                  args as { operations: Array<Record<string, unknown>> }
                ).operations,
              },
            }
          : { ok: false, error: "operations required" },
      describeAction: describeTestMutation,
      createPendingAction: (input) => ({
        toolName: "mutate_library",
        title: "Apply changes?",
        confirmLabel: "Approve",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "checklist",
            id: "selectedOperations",
            label: "Operations",
            items: input.operations.map(
              (operation: { id: string; type: string }) => ({
                id: operation.id,
                label: operation.type,
                checked: true,
              }),
            ),
          },
          {
            type: "textarea",
            id: "operationsJson",
            label: "Operations JSON",
            value: JSON.stringify(input.operations, null, 2),
          },
        ],
      }),
      applyConfirmation: (input, resolutionData) => {
        if (!resolutionData || typeof resolutionData !== "object") {
          return { ok: true, value: input };
        }
        const data = resolutionData as {
          selectedOperations?: Array<{ id?: string; checked?: boolean }>;
          operationsJson?: unknown;
        };
        const selectedIds = new Set(
          Array.isArray(data.selectedOperations)
            ? data.selectedOperations
                .filter(
                  (entry) =>
                    entry.checked !== false && typeof entry.id === "string",
                )
                .map((entry) => entry.id as string)
            : input.operations.map((operation: { id: string }) => operation.id),
        );
        return {
          ok: true,
          value: {
            operations: JSON.parse(
              typeof data.operationsJson === "string"
                ? data.operationsJson
                : JSON.stringify(input.operations),
            ).filter((operation: { id: string }) =>
              selectedIds.has(operation.id),
            ),
          },
        };
      },
      execute: async (input) => ({
        content: { applied: input.operations.length },
        effect: "applied",
      }),
    });

    const result = await registry.prepareExecution(
      {
        id: "call-1",
        name: "mutate_library",
        arguments: {
          operations: [
            { id: "op-1", type: "apply_tags" },
            { id: "op-2", type: "create_collection" },
          ],
        },
      },
      baseContext,
    );

    assert.equal(result.kind, "confirmation");
    if (result.kind !== "confirmation") return;
    assert.equal(result.action.toolName, "mutate_library");
    assert.deepEqual(
      result.action.fields.map((field) => field.id),
      ["selectedOperations", "operationsJson"],
      "internal authorization diagnostics must not become user-editable review fields",
    );
    assert.equal((await result.deny()).result.ok, false);
    const approved = await result.execute({
      approved: true,
      data: {
        selectedOperations: [{ id: "op-1", checked: true }],
        operationsJson: JSON.stringify([{ id: "op-1", type: "apply_tags" }]),
      },
    });
    assert.equal(approved.kind, "result");
    if (approved.kind !== "result") return;
    assert.equal(approved.execution.result.ok, true);
    assert.deepEqual(approved.execution.result.content, {
      applied: 1,
    });
  });

  it("replans edited confirmation input and confirms an expanded target exactly once", async function () {
    globalThis.Zotero = {
      DB: new ChangeJournalTestDb(),
      Prefs: { get: () => "safe" },
      debug: () => undefined,
    } as never;
    await initAgentChangeJournal();
    const registry = new AgentToolRegistry(
      new ActionContractService({} as never),
    );
    let planCalls = 0;
    const executedTargets: string[] = [];
    registry.register({
      effectOperations: ["settings_update"],
      spec: {
        name: "editable_write",
        description: "write a target",
        inputSchema: { type: "object" },
        executionClass: "external_effect",
        requiresConfirmation: true,
      },
      validate: (args) => {
        const target = (args as { target?: unknown })?.target;
        return typeof target === "string" && target
          ? { ok: true as const, value: { target } }
          : { ok: false as const, error: "target is required" };
      },
      planInvocation: (input) => {
        planCalls += 1;
        return stateChangeInvocationPlan({
          domains: ["filesystem"],
          effects: ["modify"],
          targets: [input.target],
          reversibility: "full",
          reason: `Replace ${input.target}.`,
        });
      },
      describeAction: (input) => [
        {
          ...describeTestMutation()[0],
          requestedTargets: [input.target],
        },
      ],
      createPendingAction: (input) => ({
        toolName: "editable_write",
        title: "Review write",
        confirmLabel: "Write",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "text",
            id: "target",
            label: "Target",
            value: input.target,
          },
        ],
      }),
      applyConfirmation: (input, data) => {
        const target = (data as { target?: unknown } | undefined)?.target;
        return {
          ok: true,
          value: {
            target:
              typeof target === "string" && target ? target : input.target,
          },
        };
      },
      execute: async (input) => {
        executedTargets.push(input.target);
        return { content: { target: input.target }, effect: "applied" };
      },
    });

    const initial = await registry.prepareExecution(
      {
        id: "editable",
        name: "editable_write",
        arguments: { target: "/tmp/a.md" },
      },
      baseContext,
    );
    assert.equal(initial.kind, "confirmation");
    assert.equal(planCalls, 1);
    if (initial.kind !== "confirmation") return;

    const expanded = await initial.execute({
      approved: true,
      data: { target: "/tmp/b.md" },
    });
    assert.equal(expanded.kind, "confirmation");
    assert.equal(planCalls, 2);
    assert.deepEqual(executedTargets, []);
    if (expanded.kind !== "confirmation") return;

    const execution = await expanded.execute({ approved: true });
    assert.equal(execution.kind, "result");
    assert.equal(
      planCalls,
      4,
      "reassess current state at review and execution boundaries",
    );
    assert.deepEqual(executedTargets, ["/tmp/b.md"]);
    if (execution.kind !== "result") return;
    assert.deepEqual(execution.execution.result.content, {
      target: "/tmp/b.md",
    });
  });

  it("blocks a confirmed edit that crosses a hard boundary before execution", async function () {
    globalThis.Zotero = {
      DB: new ChangeJournalTestDb(),
      Prefs: { get: () => "safe" },
      debug: () => undefined,
    } as never;
    await initAgentChangeJournal();
    const registry = new AgentToolRegistry(
      new ActionContractService({} as never),
    );
    let executions = 0;
    registry.register({
      effectOperations: ["settings_update"],
      spec: {
        name: "boundary_write",
        description: "write a target",
        inputSchema: { type: "object" },
        executionClass: "external_effect",
        requiresConfirmation: true,
      },
      validate: (args) => ({
        ok: true,
        value: { target: String((args as { target?: unknown })?.target || "") },
      }),
      planInvocation: (input) =>
        input.target === "/"
          ? prohibitedInvocationPlan({
              domains: ["filesystem"],
              targets: [input.target],
              reason: "The target is a protected filesystem root.",
            })
          : stateChangeInvocationPlan({
              domains: ["filesystem"],
              targets: [input.target],
              reason: "Write the requested target.",
            }),
      describeAction: (input) => [
        {
          ...describeTestMutation()[0],
          requestedTargets: [input.target],
        },
      ],
      createPendingAction: (input) => ({
        toolName: "boundary_write",
        title: "Review write",
        confirmLabel: "Write",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "text",
            id: "target",
            label: "Target",
            value: input.target,
          },
        ],
      }),
      applyConfirmation: (input, data) => ({
        ok: true,
        value: {
          target: String(
            (data as { target?: unknown })?.target || input.target,
          ),
        },
      }),
      execute: async () => {
        executions += 1;
        return { content: { ok: true }, effect: "applied" };
      },
    });

    const initial = await registry.prepareExecution(
      {
        id: "boundary",
        name: "boundary_write",
        arguments: { target: "/tmp/a.md" },
      },
      baseContext,
    );
    assert.equal(initial.kind, "confirmation");
    if (initial.kind !== "confirmation") return;
    const blocked = await initial.execute({
      approved: true,
      data: { target: "/" },
    });
    assert.equal(blocked.kind, "result");
    assert.equal(executions, 0);
    if (blocked.kind !== "result") return;
    assert.isFalse(blocked.execution.result.ok);
    assert.include(
      JSON.stringify(blocked.execution.result.content),
      "protected integrity boundary",
    );
  });

  it("binds inherited approval to the exact downstream invocation", async function () {
    globalThis.Zotero = {
      DB: new ChangeJournalTestDb(),
      debug: () => undefined,
    } as never;
    await initAgentChangeJournal();
    const registry = new AgentToolRegistry(
      new ActionContractService({} as never),
    );
    registry.register({
      describeAction: describeLibraryMutationInput,
      effectOperations: ["import_identifiers"],
      spec: {
        name: "mutate_library",
        description: "apply changes",
        inputSchema: { type: "object" },
        executionClass: "external_effect",
        requiresConfirmation: true,
      },
      validate: () => ({
        ok: true,
        value: {
          operations: [
            { type: "import_identifiers", identifiers: ["10.1000/a"] },
          ],
        },
      }),
      acceptInheritedApproval: (_input, approval) =>
        approval.sourceToolName === "search_literature_online" &&
        approval.sourceActionId === "import",
      createPendingAction: () => ({
        toolName: "mutate_library",
        title: "Apply changes?",
        confirmLabel: "Approve",
        cancelLabel: "Cancel",
        fields: [],
      }),
      execute: async () => ({
        content: { applied: 1 },
        effect: "applied",
      }),
    });

    const result = await registry.prepareExecution(
      {
        id: "call-2",
        name: "mutate_library",
        arguments: {},
      },
      baseContext,
      {
        inheritedApproval: {
          sourceToolName: "search_literature_online",
          sourceActionId: "import",
          sourceMode: "review",
          approvedCallDigest: buildActionCallDigest("mutate_library", {}),
        },
      },
    );

    assert.equal(result.kind, "result");
    if (result.kind !== "result") return;
    assert.equal(result.execution.result.ok, true);
    assert.deepEqual(result.execution.result.content, { applied: 1 });

    const mismatched = await registry.prepareExecution(
      {
        id: "call-2-mismatch",
        name: "mutate_library",
        arguments: {},
      },
      baseContext,
      {
        inheritedApproval: {
          sourceToolName: "search_literature_online",
          sourceActionId: "import",
          sourceMode: "review",
          approvedCallDigest: buildActionCallDigest("mutate_library", {
            changed: true,
          }),
        },
      },
    );
    assert.equal(mismatched.kind, "result");
    if (mismatched.kind !== "result") return;
    assert.isFalse(mismatched.execution.result.ok);
    assert.include(
      JSON.stringify(mismatched.execution.result.content),
      "not bound to this exact invocation",
    );
  });

  it("blocks an unjournalled action even when it has inherited consent", async function () {
    globalThis.Zotero = { debug: () => undefined } as never;
    const registry = new AgentToolRegistry(
      new ActionContractService({} as never),
    );
    let executions = 0;
    registry.register({
      effectOperations: ["settings_update"],
      spec: {
        name: "mutate_library",
        description: "apply changes",
        inputSchema: { type: "object" },
        executionClass: "external_effect",
        requiresConfirmation: true,
      },
      validate: () => ({ ok: true, value: {} }),
      planInvocation: () =>
        stateChangeInvocationPlan({
          reversibility: "full",
          reason: "Test mutation.",
        }),
      describeAction: describeTestMutation,
      acceptInheritedApproval: () => true,
      createPendingAction: () => ({
        toolName: "mutate_library",
        title: "Apply changes?",
        confirmLabel: "Approve",
        cancelLabel: "Cancel",
        fields: [],
      }),
      execute: async () => {
        executions += 1;
        return { content: { applied: 1 }, effect: "applied" };
      },
    });

    const result = await registry.prepareExecution(
      { id: "call-unavailable", name: "mutate_library", arguments: {} },
      baseContext,
      {
        inheritedApproval: {
          sourceToolName: "search_literature_online",
          sourceActionId: "import",
          sourceMode: "review",
          approvedCallDigest: buildActionCallDigest("mutate_library", {}),
        },
      },
    );

    assert.equal(result.kind, "result");
    assert.equal(executions, 0);
    if (result.kind !== "result") return;
    assert.isFalse(result.execution.result.ok);
    assert.include(
      String((result.execution.result.content as { error?: string }).error),
      "durable change journal is unavailable",
    );
  });

  it("filters request-scoped tools when they are unavailable", async function () {
    const registry = new AgentToolRegistry(
      new ActionContractService({} as never),
    );
    registry.register({
      describeAction: describeLibraryMutationInput,
      effectOperations: ["note_edit"],
      spec: {
        name: "edit_current_note",
        description: "edit the active note",
        inputSchema: { type: "object" },
        executionClass: "external_effect",
        requiresConfirmation: true,
      },
      isAvailable: (request) => Boolean(request.activeNoteContext),
      validate: () => ({ ok: true, value: {} }),
      createPendingAction: () => ({
        toolName: "edit_current_note",
        title: "Edit note?",
        confirmLabel: "Apply",
        cancelLabel: "Cancel",
        fields: [],
      }),
      execute: async () => ({
        content: { status: "updated" },
        effect: "applied",
      }),
    });

    assert.deepEqual(registry.listToolsForRequest(baseContext.request), []);
    assert.lengthOf(
      registry.listToolsForRequest({
        ...baseContext.request,
        activeNoteContext: {
          noteId: 5,
          title: "Draft",
          noteKind: "standalone",
          noteText: "Current body",
        },
      }),
      1,
    );

    const result = await registry.prepareExecution(
      {
        id: "call-3",
        name: "edit_current_note",
        arguments: {},
      },
      baseContext,
    );

    assert.equal(result.kind, "result");
    if (result.kind !== "result") return;
    assert.equal(result.execution.result.ok, false);
    assert.include(
      String((result.execution.result.content as { error?: string }).error),
      "not available",
    );
  });

  it("does not acquire the conversation write lock for reads or read-only write modes", async function () {
    const registry = new AgentToolRegistry(
      new ActionContractService({} as never),
    );
    let receivedInvocationPlan: AgentToolContext["invocationPlan"];
    registry.register({
      spec: {
        name: "read_tool",
        description: "read",
        inputSchema: { type: "object" },
        executionClass: "read",
        requiresConfirmation: false,
      },
      validate: () => ({ ok: true, value: {} }),
      execute: async () => ({ value: "read" }),
    });
    registry.register({
      describeAction: describeLibraryMutationInput,
      effectOperations: ["settings_update"],
      spec: {
        name: "write_tool_list",
        description: "list write-tool state",
        inputSchema: { type: "object" },
        executionClass: "external_effect",
        requiresConfirmation: false,
      },
      validate: () => ({ ok: true, value: {} }),
      planInvocation: () =>
        readOnlyInvocationPlan({ reason: "Test read-only mode." }),
      execute: async (_input, context) => {
        receivedInvocationPlan = context.invocationPlan;
        return {
          content: { value: "listed" },
          effect: "none",
        };
      },
    });
    let lockCalls = 0;
    const options = {
      executeWithLock: async <T>(task: () => Promise<T>) => {
        lockCalls += 1;
        return task();
      },
    };

    const read = await registry.prepareExecution(
      { id: "read", name: "read_tool", arguments: {} },
      baseContext,
      options,
    );
    const list = await registry.prepareExecution(
      { id: "list", name: "write_tool_list", arguments: {} },
      baseContext,
      options,
    );

    assert.equal(lockCalls, 0);
    assert.equal(read.kind, "result");
    assert.equal(list.kind, "result");
    if (read.kind === "result") {
      assert.isUndefined(read.execution.result.effect);
    }
    if (list.kind === "result") {
      assert.equal(list.execution.result.effect, "none");
    }
    assert.equal(receivedInvocationPlan?.impact, "read_only");
    assert.equal(receivedInvocationPlan?.assurance, "runtime_enforced");
  });

  it("acquires the conversation write lock for a planned write", async function () {
    globalThis.Zotero = {
      DB: new ChangeJournalTestDb(),
      Prefs: { get: () => "yolo" },
      debug: () => undefined,
    } as never;
    await initAgentChangeJournal();
    const registry = new AgentToolRegistry(
      new ActionContractService({} as never),
    );
    registry.register({
      effectOperations: ["settings_update"],
      spec: {
        name: "write_tool",
        description: "write",
        inputSchema: { type: "object" },
        executionClass: "external_effect",
        requiresConfirmation: false,
      },
      validate: () => ({ ok: true, value: {} }),
      planInvocation: () =>
        stateChangeInvocationPlan({
          reversibility: "full",
          reason: "Test write.",
        }),
      describeAction: describeTestMutation,
      execute: async () => ({
        content: { value: "written" },
        effect: "applied",
      }),
    });
    let lockCalls = 0;

    const prepared = await registry.prepareExecution(
      { id: "write", name: "write_tool", arguments: {} },
      baseContext,
      {
        executeWithLock: async (task) => {
          lockCalls += 1;
          return task();
        },
      },
    );

    assert.equal(prepared.kind, "result");
    assert.equal(lockCalls, 1);
    if (prepared.kind === "result") {
      assert.equal(prepared.execution.result.effect, "applied");
    }
  });

  it("discards a result and its artifacts when the lifecycle changes during execution", async function () {
    const registry = new AgentToolRegistry(
      new ActionContractService({} as never),
    );
    let allowed = true;
    registry.register({
      spec: {
        name: "slow_read",
        description: "read",
        inputSchema: { type: "object" },
        executionClass: "read",
        requiresConfirmation: false,
      },
      validate: () => ({ ok: true, value: {} }),
      execute: async () => {
        allowed = false;
        return {
          content: { privateResult: true },
          artifacts: [{ type: "image", dataUrl: "data:image/png;base64,AA==" }],
        };
      },
    });

    const prepared = await registry.prepareExecution(
      { id: "slow", name: "slow_read", arguments: {} },
      baseContext,
      { isExecutionAllowed: () => allowed },
    );

    assert.equal(prepared.kind, "result");
    if (prepared.kind !== "result") return;
    assert.isFalse(prepared.execution.result.ok);
    assert.isUndefined(prepared.execution.result.artifacts);
    assert.notInclude(
      JSON.stringify(prepared.execution.result.content),
      "privateResult",
    );
    assert.include(
      JSON.stringify(prepared.execution.result.content),
      "lifecycle changed",
    );
  });

  it("rejects a dynamically registered write with no explicit effect", async function () {
    const registry = new AgentToolRegistry(
      new ActionContractService({} as never),
    );
    registry.register({
      describeAction: describeLibraryMutationInput,
      effectOperations: ["settings_update"],
      spec: {
        name: "unknown_write",
        description: "write",
        inputSchema: { type: "object" },
        executionClass: "external_effect",
        requiresConfirmation: false,
      },
      validate: () => ({ ok: true, value: {} }),
      planInvocation: () =>
        readOnlyInvocationPlan({ reason: "Test read-only execution." }),
      execute: async () => ({ status: "finished" }),
    });

    const prepared = await registry.prepareExecution(
      { id: "unknown", name: "unknown_write", arguments: {} },
      baseContext,
    );

    assert.equal(prepared.kind, "result");
    if (prepared.kind !== "result") return;
    assert.isFalse(prepared.execution.result.ok);
    assert.include(
      JSON.stringify(prepared.execution.result.content),
      "outcome is unknown",
    );
  });

  it("runs confirmed control operations without an action contract or mutation receipt", async function () {
    const registry = new AgentToolRegistry(
      new ActionContractService({} as never),
    );
    let executions = 0;
    registry.register({
      spec: {
        name: "plan_control",
        description: "change plan metadata",
        inputSchema: { type: "object" },
        executionClass: "control",
        requiresConfirmation: true,
        interaction: "user_input",
      },
      validate: () => ({ ok: true, value: {} }),
      createPendingAction: () => ({
        toolName: "plan_control",
        title: "Continue?",
        confirmLabel: "Continue",
        cancelLabel: "Cancel",
        fields: [],
        actions: [
          { id: "continue", label: "Continue", approved: true },
          { id: "cancel", label: "Cancel", approved: false },
        ],
        defaultActionId: "continue",
        cancelActionId: "cancel",
      }),
      execute: async () => {
        executions += 1;
        return { updated: true };
      },
    });

    const prepared = await registry.prepareExecution(
      { id: "control", name: "plan_control", arguments: {} },
      baseContext,
    );
    assert.equal(prepared.kind, "confirmation");
    if (prepared.kind !== "confirmation") return;
    const executed = await prepared.execute({ approved: true });
    assert.equal(executions, 1);
    assert.equal(executed.kind, "result");
    if (executed.kind !== "result") return;
    assert.isTrue(executed.execution.result.ok);
    assert.deepEqual(executed.execution.result.actionReceipts, []);
  });

  it("blocks an untyped external effect before execution and fabricates no command receipt", async function () {
    const registry = new AgentToolRegistry(
      new ActionContractService({} as never),
    );
    let executions = 0;
    registry.register({
      describeAction: describeLibraryMutationInput,
      effectOperations: ["settings_update"],
      spec: {
        name: "unknown_external_effect",
        description: "unknown write",
        inputSchema: { type: "object" },
        executionClass: "external_effect",
        requiresConfirmation: false,
      },
      validate: () => ({ ok: true, value: {} }),
      planInvocation: () =>
        stateChangeInvocationPlan({ reason: "Untyped test effect." }),
      execute: async () => {
        executions += 1;
        return { content: { ok: true }, effect: "applied" as const };
      },
    });

    const prepared = await registry.prepareExecution(
      {
        id: "unknown-external",
        name: "unknown_external_effect",
        arguments: {},
      },
      baseContext,
    );
    assert.equal(prepared.kind, "result");
    assert.equal(executions, 0);
    if (prepared.kind !== "result") return;
    assert.isFalse(prepared.execution.result.ok);
    assert.notInclude(
      prepared.execution.result.actionReceipts.map((entry) => entry.operation),
      "command_execute",
    );
    assert.include(
      JSON.stringify(prepared.execution.result.content),
      "no typed action adapter",
    );
  });
  const describeTagWrite = () => [
    {
      id: "tags:judgment",
      proofDomain: "zotero_state" as const,
      capability: "zotero.tags" as const,
      operation: "apply_tags" as const,
      source: "zotero_native" as const,
      parameters: { tags: ["follow-up"] },
      requestedTargets: ["item:41"],
      destinationCollectionIds: [],
    },
  ];

  function registerTagTool(
    registry: AgentToolRegistry,
    onWrite: () => void,
    options: { withPendingAction?: boolean } = {},
  ) {
    registry.register({
      effectOperations: ["apply_tags"],
      spec: {
        name: "judgment_tags",
        description: "fixture",
        inputSchema: { type: "object" },
        executionClass: "external_effect",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args }),
      describeAction: describeTagWrite,
      ...(options.withPendingAction
        ? {
            createPendingAction: () => ({
              toolName: "judgment_tags",
              title: "Tag a related paper",
              confirmLabel: "Allow once",
              cancelLabel: "Cancel",
              fields: [],
            }),
          }
        : {}),
      planInvocation: () =>
        stateChangeInvocationPlan({
          domains: ["zotero_library"],
          effects: ["modify"],
          targets: ["item:41"],
          reason: "Tag a related paper on the agent's own initiative",
        }),
      execute: async () => {
        onWrite();
        return { content: { tagged: 1 }, effect: "applied" };
      },
    });
  }

  it("yolo executes a judgment write without honoring a generic forced permission prompt", async function () {
    const db = new ChangeJournalTestDb();
    globalThis.Zotero = {
      DB: db,
      Prefs: { get: () => "yolo" },
      debug: () => undefined,
    } as never;
    await initAgentChangeJournal();
    const registry = new AgentToolRegistry(
      new ActionContractService({} as never),
    );
    let writes = 0;
    registerTagTool(registry, () => writes++, {
      withPendingAction: true,
    });
    const prepared = await registry.prepareExecution(
      { id: "reviewed-judgment", name: "judgment_tags", arguments: {} },
      { ...baseContext, runId: "yolo-review-turn" },
      { forceConfirmation: true },
    );
    const executed = prepared;
    assert.equal(executed.kind, "result");
    if (executed.kind !== "result") return;
    assert.isTrue(
      executed.execution.result.ok,
      JSON.stringify(executed.execution.result.content),
    );
    assert.equal(writes, 1);
    assert.deepEqual(
      [...db.observations.values()].map((row) => [
        row.event,
        JSON.parse(String(row.extra_json)).grant?.authority ??
          JSON.parse(String(row.extra_json)).authority,
      ]),
      [
        ["original_authorization_prepared", "yolo_judgment"],
        ["original_execution_completed", "yolo_judgment"],
      ],
      "the exact action journals delegated judgment",
    );
    assert.equal(executed.execution.result.authority, "yolo_judgment");
  });
  describe("external_effect registration", function () {
    const effectDefinition = () => ({
      spec: {
        name: "registered_effect",
        description: "fixture",
        inputSchema: { type: "object" },
        executionClass: "external_effect" as const,
        workCategory: "zotero_action" as const,
      },
      effectOperations: ["settings_update" as const],
      validate: (args: unknown) => ({ ok: true as const, value: args }),
      describeAction: describeTestMutation,
      execute: async () => ({ content: {}, effect: "applied" as const }),
    });

    it("accepts an external_effect tool that declares its adapter and operations", function () {
      const registry = new AgentToolRegistry();
      registry.register(effectDefinition());
      assert.isDefined(registry.getTool("registered_effect"));
    });

    it("refuses an external_effect tool with no typed action adapter", function () {
      const registry = new AgentToolRegistry();
      const { describeAction, ...withoutAdapter } = effectDefinition();
      assert.isFunction(describeAction);
      assert.throws(
        () => registry.register(withoutAdapter as never),
        /registered_effect.*describeAction/s,
      );
      assert.isUndefined(registry.getTool("registered_effect"));
    });

    it("refuses an external_effect tool that declares no effect operations", function () {
      const registry = new AgentToolRegistry();
      const { effectOperations, ...withoutOperations } = effectDefinition();
      assert.isArray(effectOperations);
      assert.throws(
        () => registry.register(withoutOperations as never),
        /registered_effect.*effectOperations/s,
      );
      assert.throws(
        () =>
          registry.register({ ...effectDefinition(), effectOperations: [] }),
        /registered_effect.*effectOperations/s,
      );
    });

    it("refuses an effect operation that is not in the operation catalog", function () {
      const registry = new AgentToolRegistry();
      assert.throws(
        () =>
          registry.register({
            ...effectDefinition(),
            effectOperations: ["settings_update", "teleport_items"] as never,
          }),
        /teleport_items.*operation catalog/s,
      );
    });

    it("exempts control and read classes by class, not by tool name", function () {
      const registry = new AgentToolRegistry();
      const control = effectDefinition();
      registry.register({
        ...control,
        spec: {
          ...control.spec,
          name: "control_shaped_like_library_batch",
          executionClass: "control",
        },
        describeAction: undefined,
        effectOperations: undefined,
      } as never);
      registry.register({
        ...control,
        spec: {
          ...control.spec,
          name: "plain_read",
          executionClass: "read",
          workCategory: "retrieval",
        },
        describeAction: undefined,
        effectOperations: undefined,
      } as never);
      assert.isDefined(registry.getTool("control_shaped_like_library_batch"));
      assert.isDefined(registry.getTool("plain_read"));
    });

    it("refuses a described operation the tool never declared", async function () {
      const registry = new AgentToolRegistry(
        new ActionContractService({} as never),
      );
      registry.register({
        ...effectDefinition(),
        spec: { ...effectDefinition().spec, name: "drifting_effect" },
        effectOperations: ["settings_update"],
        describeAction: () => [
          {
            id: "annotation_write:1",
            proofDomain: "zotero_state" as const,
            capability: "zotero.annotations" as const,
            operation: "annotation_write" as const,
            source: "zotero_native" as const,
            requestedTargets: [],
            destinationCollectionIds: [],
          },
        ],
        planInvocation: () =>
          stateChangeInvocationPlan({ reason: "Drifted test effect." }),
      });

      const prepared = await registry.prepareExecution(
        { id: "drift", name: "drifting_effect", arguments: {} },
        baseContext,
      );
      assert.equal(prepared.kind, "result");
      if (prepared.kind !== "result") return;
      assert.isFalse(prepared.execution.result.ok);
      assert.include(
        JSON.stringify(prepared.execution.result.content),
        'Typed action adapter for drifting_effect described \\"annotation_write\\", which it never declared: effectOperations is [settings_update].',
      );
    });

    it("refuses the shared library-mutation adapter's read_full branch when the tool never declared it", async function () {
      const registry = new AgentToolRegistry(
        new ActionContractService({} as never),
      );
      registry.register({
        ...effectDefinition(),
        spec: { ...effectDefinition().spec, name: "full_read_effect" },
        effectOperations: ["settings_update"],
        describeAction: describeLibraryMutationInput,
        validate: () => ({ ok: true as const, value: { mode: "full" } }),
        planInvocation: () =>
          stateChangeInvocationPlan({ reason: "Full-read test effect." }),
      });

      const prepared = await registry.prepareExecution(
        { id: "full-read", name: "full_read_effect", arguments: {} },
        baseContext,
      );
      assert.equal(prepared.kind, "result");
      if (prepared.kind !== "result") return;
      assert.isFalse(prepared.execution.result.ok);
      assert.include(
        JSON.stringify(prepared.execution.result.content),
        'Typed action adapter for full_read_effect described \\"read_full\\", which it never declared: effectOperations is [settings_update].',
      );
    });

    it("keeps every production external_effect tool declaring its operations", function () {
      const production = createBuiltInToolRegistry({
        zoteroGateway: {} as never,
        pdfService: {} as never,
        pdfPageService: {} as never,
        retrievalService: {} as never,
      });
      const undeclared = production
        .listToolDefinitions()
        .filter(
          (tool) =>
            tool.spec.executionClass === "external_effect" &&
            !(tool.describeAction && tool.effectOperations?.length),
        )
        .map((tool) => tool.spec.name);
      assert.deepEqual(undeclared, []);
    });
  });
  describe("requiresConfirmation scope", function () {
    const production = () =>
      createBuiltInToolRegistry({
        zoteroGateway: {} as never,
        pdfService: {} as never,
        pdfPageService: {} as never,
        retrievalService: {} as never,
      });

    it("keeps the flag only on the specs the controller reads it for", function () {
      const specs = production()
        .listToolDefinitions()
        .map((tool) => tool.spec);
      const userInput = specs
        .filter((spec) => spec.interaction === "user_input")
        .map((spec) => spec.name)
        .sort();
      assert.deepEqual(userInput, ["request_user_input"]);
      for (const spec of specs) {
        if (spec.interaction === "user_input") {
          assert.isBoolean(
            spec.requiresConfirmation,
            `${spec.name} must still declare its pause`,
          );
          continue;
        }
        assert.notProperty(
          spec,
          "requiresConfirmation",
          `${spec.name} must not carry a tool-private confirmation rule`,
        );
      }
    });

    it("stamps the interaction kind on the card an interaction tool raises", async function () {
      // The trace renders a planning question differently from an approval.
      // It must read that from the action, not recognise the host's own
      // interaction tool by name.
      globalThis.Zotero = {
        DB: new ChangeJournalTestDb(),
        Prefs: { get: () => "auto" },
        debug: () => undefined,
      } as never;
      await initAgentChangeJournal();
      const registry = new AgentToolRegistry(
        new ActionContractService({} as never),
      );
      registry.register({
        spec: {
          name: "ask_the_user",
          description: "fixture",
          inputSchema: { type: "object" },
          executionClass: "control",
          workCategory: "planning",
          requiresConfirmation: true,
          interaction: "user_input",
        },
        validate: (args) => ({ ok: true, value: args }),
        planInvocation: () =>
          readOnlyInvocationPlan({
            domains: [],
            reason: "The fixture only records an answer.",
          }),
        createPendingAction: () => ({
          toolName: "ask_the_user",
          title: "Agent needs your input",
          mode: "review",
          confirmLabel: "Continue",
          cancelLabel: "Cancel",
          fields: [],
        }),
        execute: async () => ({ answered: true }),
      } as never);
      const asked = await registry.prepareExecution(
        { id: "ask-1", name: "ask_the_user", arguments: {} },
        baseContext,
      );
      assert.equal(asked.kind, "confirmation");
      if (asked.kind !== "confirmation") return;
      assert.equal(asked.action.interaction, "user_input");

      registry.register({
        spec: {
          name: "confirm_something",
          description: "fixture",
          inputSchema: { type: "object" },
          executionClass: "external_effect",
          workCategory: "zotero_action",
          requiresConfirmation: true,
        },
        effectOperations: ["settings_update"],
        validate: (args) => ({ ok: true, value: args }),
        describeAction: describeTestMutation,
        planInvocation: () =>
          stateChangeInvocationPlan({
            domains: ["zotero_library"],
            effects: ["modify"],
            reason: "Apply exact requested setting",
          }),
        createPendingAction: () => ({
          toolName: "confirm_something",
          title: "Approve",
          mode: "review",
          confirmLabel: "Run",
          cancelLabel: "Cancel",
          fields: [],
        }),
        execute: async () => ({ content: { ok: true }, effect: "applied" }),
      } as never);
      (globalThis.Zotero.Prefs as any).get = () => "safe";
      const approval = await registry.prepareExecution(
        { id: "confirm-1", name: "confirm_something", arguments: {} },
        JSON.parse(JSON.stringify(baseContext)),
        { forceConfirmation: true },
      );
      assert.equal(approval.kind, "confirmation");
      if (approval.kind !== "confirmation") return;
      assert.isUndefined(
        approval.action.interaction,
        "an approval is not a question the run is waiting on an answer to",
      );
    });
  });
});
