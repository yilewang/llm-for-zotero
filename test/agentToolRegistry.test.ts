import { assert } from "chai";
import {
  prohibitedInvocationPlan,
  readOnlyInvocationPlan,
  stateChangeInvocationPlan,
} from "../src/agent/authorization/invocationPlan";
import { buildActionCallDigest } from "../src/agent/authorization/proposal";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { evaluateActionContract } from "../src/agent/contracts/actionEvaluation";
import { PlanAmendmentService } from "../src/agent/plans/amendments";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import { createMalformedToolArgumentsDiagnostic } from "../src/agent/toolArgumentDiagnostics";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import type { AgentToolContext, AgentToolDefinition } from "../src/agent/types";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";
import {
  actionFixture,
  semanticContractFixture,
} from "./helpers/semanticIntent";

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
      classifiedIntent: actionFixture("settings_update"),
      actionContract: semanticContractFixture({
        version: 3,
        id: "contract:test-settings",
        writeDisposition: "required",
        interpretationSource: "classifier",
        obligations: [
          {
            ...actionFixture("settings_update").actionIntents[0],
            id: "obligation:settings",
          },
        ],
      }),
    },
    item: null,
    currentAnswerText: "",
    modelName: "gpt-4o-mini",
  };

  for (const mode of ["safe", "auto", "yolo"] as const) {
    for (const entryPoint of ["action_ui", "conversation"] as const) {
      for (const preference of ["default", "review", "direct"] as const) {
        it(`${mode}/${entryPoint}/${preference}: counts required confirmations before a native effect`, async function () {
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
          request.actionContract.obligations[0].reviewPreference = preference;
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
          const expected =
            entryPoint === "action_ui" ||
            preference === "review" ||
            mode === "safe"
              ? 1
              : 0;
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
  }

  it("persists MCP proposal authority before allowing a native effect", async function () {
    globalThis.Zotero = {
      DB: new ChangeJournalTestDb(),
      Prefs: { get: () => "auto" },
      debug: () => undefined,
    } as never;
    await initAgentChangeJournal();
    const registry = new AgentToolRegistry(
      new ActionContractService({} as never),
    );
    let executions = 0;
    let checkpoints = 0;
    registry.register({
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
    const request = JSON.parse(JSON.stringify(baseContext.request));
    request.actionProgress = registry.createActionProgress(
      request.actionContract,
    );
    const prepared = await registry.prepareExecution(
      { id: "mcp-authority", name: "settings_test", arguments: {} },
      {
        ...baseContext,
        request,
        runId: "provider-turn",
        checkpointActionProgress: async () => {
          checkpoints++;
          assert.equal(
            request.actionProgress.authorizationGrants[0].status,
            "staged",
          );
          throw new Error("Durable store unavailable");
        },
      },
      { callerKind: "mcp" },
    );
    assert.equal(executions, 0);
    assert.equal(checkpoints, 1);
    assert.equal(prepared.kind, "result");
    if (prepared.kind === "result")
      assert.isFalse(prepared.execution.result.ok);
  });

  it("does not execute a changed Auto payload using the earlier persisted grant", async function () {
    globalThis.Zotero = {
      DB: new ChangeJournalTestDb(),
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
    const request = JSON.parse(JSON.stringify(baseContext.request));
    request.actionProgress = registry.createActionProgress(
      request.actionContract,
    );
    const result = await registry.prepareExecution(
      { id: "changing", name: "changing_settings", arguments: {} },
      {
        ...baseContext,
        request,
        runId: "exact-auto",
        checkpointActionProgress: async () => {
          targets = ["setting:different"];
        },
      },
    );
    assert.equal(writes, 0);
    assert.equal(
      result.kind,
      "result",
      "state drift returns a corrective result, not a permission prompt",
    );
    if (result.kind === "result") assert.isFalse(result.execution.result.ok);
    assert.equal(
      request.actionProgress.authorizationGrants[0].status,
      "failed",
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
  });

  it("does not invent a write receipt when an explicit adapter describes a confined read", async function () {
    for (const contracts of [
      undefined,
      new ActionContractService({} as never),
    ]) {
      const registry = new AgentToolRegistry(contracts);
      registry.register({
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

  it("keeps protected integrity checks active after plan approval", async function () {
    globalThis.Zotero = { DB: new ChangeJournalTestDb() } as never;
    await initAgentChangeJournal();
    let writes = 0;
    const contracts = new ActionContractService({} as never);
    const registry = new AgentToolRegistry(contracts);
    registry.register({
      spec: {
        name: "library_settings",
        description: "Protected fixture",
        inputSchema: { type: "object" },
        executionClass: "external_effect",
        requiresConfirmation: true,
      },
      validate: () => ({ ok: true, value: {} }),
      describeAction: describeTestMutation,
      planInvocation: () =>
        prohibitedInvocationPlan({
          reason: "Protected target",
          riskSignals: ["protected_target"],
        }),
      execute: async () => {
        writes++;
        return { content: {}, effect: "applied" };
      },
    });
    const contract = semanticContractFixture(
      semanticContractFixture({
        version: 3,
        id: "approved-protected-test",
        hardConstraints: [],
        writeDisposition: "required",
        interpretationSource: "classifier",
        obligations: [
          {
            id: "settings",
            operation: "settings_update",
            proofDomain: "zotero_state",
            capability: "zotero.settings",
            coverage: "one",
            targetKind: "items",
          },
        ],
      }),
    ) as const;
    const result = await registry.prepareExecution(
      { id: "protected", name: "library_settings", arguments: {} },
      {
        ...baseContext,
        request: {
          ...baseContext.request,
          actionContract: contract as never,
          actionProgress: contracts.createProgress(contract as never),
          planContext: {
            phase: "executing",
            planId: "p",
            revision: 1,
          } as never,
        },
      },
    );
    assert.equal(writes, 0, "approval cannot execute a prohibited target");
    assert.equal(result.kind, "result");
    if (result.kind !== "result") return;
    assert.isFalse(result.execution.result.ok);
    assert.include(
      JSON.stringify(result.execution.result.content),
      "protected integrity boundary",
    );
  });

  it("executes an approved item checkpoint without requiring no-op assignments for other frozen targets", async function () {
    globalThis.Zotero = { DB: new ChangeJournalTestDb() } as never;
    await initAgentChangeJournal();
    const contracts = new ActionContractService({
      getItem: (id: number) => ({ id, libraryID: 1 }),
    } as never);
    const registry = new AgentToolRegistry(contracts);
    const written: number[] = [];
    registry.register({
      spec: {
        name: "checkpoint_tag",
        description: "Add an approved tag",
        inputSchema: { type: "object" },
        executionClass: "external_effect",
        requiresConfirmation: true,
      },
      validate: (args: any) => ({ ok: true, value: args }),
      planInvocation: (input: any) =>
        stateChangeInvocationPlan({
          reason: "Add a tag",
          targets: [`item:${input.itemId}`],
          reversibility: "full",
        }),
      describeAction: (input: any) => [
        {
          id: "tag",
          operation: "apply_tags",
          capability: "zotero.tags",
          proofDomain: "zotero_state",
          source: "zotero_native",
          requestedTargets: [`item:${input.itemId}`],
          destinationCollectionIds: [],
          parameters: { tags: ["review"] },
        },
      ],
      execute: async (input: any) => {
        written.push(input.itemId);
        return { effect: "applied", content: {} };
      },
    });
    const contract = semanticContractFixture({
      version: 4,
      id: "approved-batch",
      writeDisposition: "required",
      interpretationSource: "classifier",
      obligations: [
        {
          id: "tags",
          reviewPreference: "default",
          operation: "apply_tags",
          capability: "zotero.tags",
          proofDomain: "zotero_state",
          coverage: "some",
          targetKind: "papers",
          parameters: { tags: ["review"] },
          targetBoundary: {
            kind: "selection",
            libraryID: 1,
            frozenTargetIds: [1, 2, 3],
            scopeDigest: "fixed-three",
          },
        },
      ],
    });
    for (const [approved, itemId] of [
      [false, 1],
      [true, 4],
      [true, 1],
    ] as const) {
      const result = await registry.prepareExecution(
        {
          id: `checkpoint-${approved}-${itemId}`,
          name: "checkpoint_tag",
          arguments: { itemId },
        },
        {
          ...baseContext,
          request: {
            ...baseContext.request,
            actionContract: contract as never,
            actionProgress: contracts.createProgress(contract as never),
            ...(approved
              ? {
                  planContext: {
                    phase: "executing",
                    planId: "approved",
                    revision: 1,
                  } as never,
                }
              : {}),
          },
        },
        { callerKind: "mcp" },
      );
      if (!approved || itemId === 4) {
        assert.isEmpty(written);
        assert.equal(result.kind, "result");
        if (result.kind === "result")
          assert.isFalse(result.execution.result.ok);
      }
    }
    assert.deepEqual(
      written,
      [1],
      "Approved checkpoints must retain the exact target boundary while allowing one item at a time",
    );
  });

  for (const mode of ["safe", "auto", "yolo"]) {
    it(`requires the discovery selection path before importing in ${mode}`, async function () {
      globalThis.Zotero = {
        DB: new ChangeJournalTestDb(),
        Prefs: { get: () => mode },
      } as never;
      await initAgentChangeJournal();
      const registry = new AgentToolRegistry(
        new ActionContractService({} as never),
      );
      let imports = 0;
      registry.register({
        spec: {
          name: "library_import",
          description: "Import fixture",
          inputSchema: { type: "object" },
          executionClass: "external_effect",
          requiresConfirmation: true,
        },
        validate: () => ({ ok: true, value: {} }),
        describeAction: () => [
          {
            id: "import:test",
            proofDomain: "zotero_state",
            capability: "zotero.import",
            operation: "import_identifiers",
            source: "zotero_native",
            requestedTargets: [],
            destinationCollectionIds: [],
          },
        ],
        planInvocation: () =>
          stateChangeInvocationPlan({
            domains: ["zotero_library"],
            effects: ["create"],
            reversibility: "full",
            reason: "Import selected paper",
          }),
        execute: async () => {
          imports++;
          return { content: {}, effect: "applied" };
        },
      });
      const result = await registry.prepareExecution(
        { id: "import", name: "library_import", arguments: {} },
        {
          ...baseContext,
          request: {
            ...baseContext.request,
            userText:
              "Find five relevant papers and import only the ones I select.",
            classifiedIntent: actionFixture("import_identifiers", undefined, {
              literature: "select_then_import",
            }),
            actionContract: semanticContractFixture({
              version: 3,
              id: "contract:discovery",
              writeDisposition: "required",
              interpretationSource: "classifier",
              obligations: [
                {
                  ...actionFixture("import_identifiers").actionIntents[0],
                  id: "import",
                },
              ],
            }),
          },
        },
      );
      assert.equal(imports, 0);
      assert.equal(
        result.kind,
        "result",
        "do not substitute a generic effect confirmation",
      );
      if (result.kind !== "result") return;
      assert.isFalse(result.execution.result.ok);
      assert.include(
        JSON.stringify(result.execution.result.content),
        "literature_review",
      );
    });
  }

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
    assert.equal(result.deny().result.ok, false);
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

  for (const permissionMode of ["safe", "auto", "yolo"]) {
    it(`creates a contract-matched new note in ${permissionMode} without confirmation`, async function () {
      globalThis.Zotero = {
        DB: new ChangeJournalTestDb(),
        Prefs: { get: () => permissionMode },
        debug: () => undefined,
      } as never;
      await initAgentChangeJournal();
      const contracts = new ActionContractService({
        getCollectionSummary: () => null,
        listCollectionSummaries: () => [],
        listCollectionPaperTargets: async () => ({ papers: [] }),
        listCollectionItemTargets: async () => ({ items: [] }),
        getItem: () => null,
        getEditableArticleMetadata: () => null,
      });
      const registry = new AgentToolRegistry(contracts);
      let executions = 0;
      registry.register({
        spec: {
          name: "write_note",
          description: "write a Zotero note",
          inputSchema: { type: "object" },
          executionClass: "external_effect",
          requiresConfirmation: true,
        },
        validate: () => ({ ok: true, value: {} }),
        planInvocation: () =>
          stateChangeInvocationPlan({
            domains: ["zotero_library"],
            effects: ["create"],
            targets: ["note:new"],
            reversibility: "full",
            reason: "Create the requested Zotero note.",
          }),
        describeAction: () => [
          {
            id: "note:create",
            proofDomain: "zotero_state",
            capability: "zotero.notes",
            operation: "note_create",
            parameters: { noteMode: "create" },
            source: "zotero_native",
            requestedTargets: [],
            destinationCollectionIds: [],
          },
        ],
        execute: async () => {
          executions += 1;
          return {
            content: { noteId: 91 },
            effect: "applied" as const,
          };
        },
      });
      const actionContract = semanticContractFixture({
        version: 3 as const,
        id: "contract:chinese-note",
        hardConstraints: [],
        writeDisposition: "required" as const,
        interpretationSource: "classifier" as const,
        obligations: [
          {
            id: "obligation:chinese-note",
            operation: "note_create" as const,
            proofDomain: "zotero_state" as const,
            capability: "zotero.notes" as const,
            coverage: "one" as const,
            targetKind: "items" as const,
            parameters: { noteMode: "create" as const },
          },
        ],
      });

      const prepared = await registry.prepareExecution(
        { id: "call:chinese-note", name: "write_note", arguments: {} },
        {
          ...baseContext,
          request: {
            ...baseContext.request,
            // Deliberately avoids the lexical fallback: the exact typed contract
            // is the language-neutral authorization signal here.
            userText: "烦请于 Zotero 里生成一则备忘。",
            actionContract,
            actionProgress: contracts.createProgress(actionContract),
          },
        },
        { callerKind: "model" },
      );

      assert.equal(prepared.kind, "result");
      assert.equal(executions, 1);
    });
  }

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
              riskSignals: ["protected_target"],
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

  it("fails closed when Agent mode has no configured contract verifier", async function () {
    const registry = new AgentToolRegistry();
    let executed = false;
    registry.register({
      spec: {
        name: "unverified_write",
        description: "write",
        inputSchema: { type: "object" },
        executionClass: "external_effect",
        requiresConfirmation: false,
      },
      validate: () => ({ ok: true, value: {} }),
      describeAction: describeTestMutation,
      execute: async () => {
        executed = true;
        return { content: { ok: true }, effect: "applied" as const };
      },
    });
    const prepared = await registry.prepareExecution(
      { id: "unverified", name: "unverified_write", arguments: {} },
      {
        ...baseContext,
        request: {
          ...baseContext.request,
          actionContract: semanticContractFixture(
            semanticContractFixture({
              version: 2,
              id: "contract:no-write",
              writeDisposition: "none",
              interpretationSource: "classifier",
              obligations: [],
            }),
          ),
        },
      },
      { callerKind: "model" },
    );

    assert.equal(prepared.kind, "result");
    if (prepared.kind !== "result") return;
    assert.isFalse(prepared.execution.result.ok);
    assert.isFalse(executed);
    assert.include(
      JSON.stringify(prepared.execution.result.content),
      "no configured Action Contract verifier",
    );
  });

  const describeUnrequestedTagWrite = () => [
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

  function registerUnrequestedTagTool(
    registry: AgentToolRegistry,
    onWrite: () => void,
    options: { withPendingAction?: boolean } = {},
  ) {
    registry.register({
      spec: {
        name: "judgment_tags",
        description: "fixture",
        inputSchema: { type: "object" },
        executionClass: "external_effect",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args }),
      describeAction: describeUnrequestedTagWrite,
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

  it("yolo executes an unrequested typed write under a persisted judgment grant", async function () {
    globalThis.Zotero = {
      DB: new ChangeJournalTestDb(),
      Prefs: { get: () => "yolo" },
      debug: () => undefined,
    } as never;
    await initAgentChangeJournal();
    const registry = new AgentToolRegistry(
      new ActionContractService({} as never),
      new PlanAmendmentService(),
    );
    let writes = 0;
    let checkpoints = 0;
    registerUnrequestedTagTool(registry, () => writes++);
    const request = JSON.parse(JSON.stringify(baseContext.request));
    request.actionProgress = registry.createActionProgress(
      request.actionContract,
    );
    const prepared = await registry.prepareExecution(
      { id: "judgment", name: "judgment_tags", arguments: {} },
      {
        ...baseContext,
        request,
        runId: "yolo-turn",
        checkpointActionProgress: async () => {
          checkpoints++;
        },
      },
    );
    assert.equal(prepared.kind, "result");
    if (prepared.kind !== "result") return;
    assert.isTrue(prepared.execution.result.ok);
    assert.equal(prepared.execution.result.authority, "yolo_judgment");
    assert.equal(writes, 1);
    assert.equal(checkpoints, 1);
    assert.deepEqual(
      request.actionProgress.authorizationGrants.map(
        (grant: { authority: string; status: string }) => [
          grant.authority,
          grant.status,
        ],
      ),
      [["yolo_judgment", "executed"]],
    );
    const receipts = prepared.execution.result.actionReceipts;
    assert.lengthOf(receipts, 1);
    assert.isUndefined(receipts[0].obligationId);
    assert.equal(receipts[0].operation, "apply_tags");
    assert.deepEqual(
      evaluateActionContract(
        request.actionContract,
        receipts,
        request.actionProgress,
      ),
      evaluateActionContract(
        request.actionContract,
        [],
        request.actionProgress,
      ),
      "a judgment write neither satisfies nor fails the requested obligations",
    );
  });

  it("does not execute a changed judgment payload under the staged grant", async function () {
    globalThis.Zotero = {
      DB: new ChangeJournalTestDb(),
      Prefs: { get: () => "yolo" },
      debug: () => undefined,
    } as never;
    await initAgentChangeJournal();
    const registry = new AgentToolRegistry(
      new ActionContractService({} as never),
      new PlanAmendmentService(),
    );
    let targets = ["item:41"],
      writes = 0;
    registry.register({
      spec: {
        name: "judgment_tags",
        description: "fixture",
        inputSchema: { type: "object" },
        executionClass: "external_effect",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args }),
      describeAction: describeUnrequestedTagWrite,
      planInvocation: () =>
        stateChangeInvocationPlan({
          domains: ["zotero_library"],
          effects: ["modify"],
          targets,
          reason: "Tag a related paper on the agent's own initiative",
        }),
      execute: async () => {
        writes++;
        return { content: { tagged: 1 }, effect: "applied" };
      },
    });
    const request = JSON.parse(JSON.stringify(baseContext.request));
    request.actionProgress = registry.createActionProgress(
      request.actionContract,
    );
    const prepared = await registry.prepareExecution(
      { id: "drifting-judgment", name: "judgment_tags", arguments: {} },
      {
        ...baseContext,
        request,
        runId: "yolo-drift-turn",
        // The grant is checkpointed before execution; the action it authorized
        // must be the exact one that runs.
        checkpointActionProgress: async () => {
          targets = ["item:99"];
        },
      },
    );
    assert.equal(
      writes,
      0,
      "judgment authorizes one exact proposal, not a tool",
    );
    assert.equal(prepared.kind, "result");
    if (prepared.kind !== "result") return;
    assert.isFalse(prepared.execution.result.ok);
    assert.equal(
      (prepared.execution.result.content as { code?: string }).code,
      "different_operation",
      "the drifted proposal falls back to the unauthorized scope failure",
    );
    assert.equal(
      request.actionProgress.authorizationGrants[0].authority,
      "yolo_judgment",
    );
    assert.equal(
      request.actionProgress.authorizationGrants[0].status,
      "failed",
    );
  });

  it("auto still refuses the same unrequested write with a scope failure", async function () {
    globalThis.Zotero = {
      DB: new ChangeJournalTestDb(),
      Prefs: { get: () => "auto" },
      debug: () => undefined,
    } as never;
    await initAgentChangeJournal();
    const registry = new AgentToolRegistry(
      new ActionContractService({} as never),
      new PlanAmendmentService(),
    );
    let writes = 0;
    registerUnrequestedTagTool(registry, () => writes++);
    const request = JSON.parse(JSON.stringify(baseContext.request));
    request.actionProgress = registry.createActionProgress(
      request.actionContract,
    );
    const prepared = await registry.prepareExecution(
      { id: "refused", name: "judgment_tags", arguments: {} },
      {
        ...baseContext,
        request,
        runId: "auto-turn",
        checkpointActionProgress: async () => undefined,
      },
    );
    assert.equal(prepared.kind, "result");
    if (prepared.kind !== "result") return;
    assert.isFalse(prepared.execution.result.ok);
    assert.equal(
      (prepared.execution.result.content as { code?: string }).code,
      "different_operation",
    );
    assert.equal(writes, 0);
    assert.isEmpty(request.actionProgress.authorizationGrants || []);
  });

  it("yolo executes a reviewed judgment write after the user approves it", async function () {
    globalThis.Zotero = {
      DB: new ChangeJournalTestDb(),
      Prefs: { get: () => "yolo" },
      debug: () => undefined,
    } as never;
    await initAgentChangeJournal();
    const registry = new AgentToolRegistry(
      new ActionContractService({} as never),
      new PlanAmendmentService(),
    );
    let writes = 0;
    registerUnrequestedTagTool(registry, () => writes++, {
      withPendingAction: true,
    });
    const request = JSON.parse(JSON.stringify(baseContext.request));
    request.actionProgress = registry.createActionProgress(
      request.actionContract,
    );
    const prepared = await registry.prepareExecution(
      { id: "reviewed-judgment", name: "judgment_tags", arguments: {} },
      {
        ...baseContext,
        request,
        runId: "yolo-review-turn",
        checkpointActionProgress: async () => undefined,
      },
      { forceConfirmation: true },
    );
    assert.equal(prepared.kind, "confirmation");
    if (prepared.kind !== "confirmation") return;
    const executed = await prepared.execute({ approved: true });
    assert.equal(executed.kind, "result");
    if (executed.kind !== "result") return;
    assert.isTrue(
      executed.execution.result.ok,
      JSON.stringify(executed.execution.result.content),
    );
    assert.equal(writes, 1);
    assert.deepEqual(
      request.actionProgress.authorizationGrants.map(
        (grant: { authority: string; status: string }) => [
          grant.authority,
          grant.status,
        ],
      ),
      [["safe_confirmation", "executed"]],
      "user approval takes precedence over the agent's judgment",
    );
    assert.isUndefined(
      executed.execution.result.authority,
      "a write the user reviewed is not labelled as the agent's own call",
    );
  });

  it("yolo ledgers an off-plan judgment write as yolo_judgment inside an executing plan", async function () {
    globalThis.Zotero = {
      DB: new ChangeJournalTestDb(),
      Prefs: { get: () => "yolo" },
      debug: () => undefined,
    } as never;
    await initAgentChangeJournal();
    const registry = new AgentToolRegistry(
      new ActionContractService({} as never),
      new PlanAmendmentService(),
    );
    let writes = 0;
    registerUnrequestedTagTool(registry, () => writes++);
    const request = JSON.parse(JSON.stringify(baseContext.request));
    request.actionProgress = registry.createActionProgress(
      request.actionContract,
    );
    request.planContext = {
      phase: "executing",
      provider: "original",
      planId: "plan-1",
      revision: 1,
      executionId: "exec-1",
      approvedDigest: "sha256:test",
    };
    const prepared = await registry.prepareExecution(
      { id: "off-plan-judgment", name: "judgment_tags", arguments: {} },
      {
        ...baseContext,
        request,
        runId: "yolo-plan-turn",
        checkpointActionProgress: async () => undefined,
      },
    );
    assert.equal(prepared.kind, "result");
    if (prepared.kind !== "result") return;
    assert.isTrue(
      prepared.execution.result.ok,
      JSON.stringify(prepared.execution.result.content),
    );
    assert.equal(writes, 1);
    assert.deepEqual(
      request.actionProgress.authorizationGrants.map(
        (grant: { authority: string; status: string }) => [
          grant.authority,
          grant.status,
        ],
      ),
      [["yolo_judgment", "executed"]],
      "the judgment marker, not the plan-approval policy, decides the authority",
    );
    assert.equal(prepared.execution.result.authority, "yolo_judgment");
  });
});
