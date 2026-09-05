import { assert } from "chai";
import { createMalformedToolArgumentsDiagnostic } from "../src/agent/toolArgumentDiagnostics";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import type { AgentToolContext } from "../src/agent/types";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";

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
    },
    item: null,
    currentAnswerText: "",
    modelName: "gpt-4o-mini",
  };

  it("returns an error result for unknown tools", async function () {
    const registry = new AgentToolRegistry();
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

  it("rejects malformed diagnostic arguments centrally before validation", async function () {
    const registry = new AgentToolRegistry();
    let validateCalls = 0;
    registry.register({
      spec: {
        name: "zotero_script",
        description: "run a Zotero script",
        inputSchema: { type: "object" },
        mutability: "write",
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
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "mutate_library",
        description: "apply changes",
        inputSchema: { type: "object" },
        mutability: "write",
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
      ["selectedOperations", "operationsJson", "journalRecoveryWarning"],
    );
    assert.equal(result.deny().result.ok, false);
    const approved = await result.execute({
      selectedOperations: [{ id: "op-1", checked: true }],
      operationsJson: JSON.stringify([{ id: "op-1", type: "apply_tags" }]),
    });
    assert.equal(approved.result.ok, true);
    assert.deepEqual(approved.result.content, {
      applied: 1,
    });
  });

  it("lets tools opt into explicit inherited approval", async function () {
    globalThis.Zotero = {
      DB: new ChangeJournalTestDb(),
      debug: () => undefined,
    } as never;
    await initAgentChangeJournal();
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "mutate_library",
        description: "apply changes",
        inputSchema: { type: "object" },
        mutability: "write",
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
        },
      },
    );

    assert.equal(result.kind, "result");
    if (result.kind !== "result") return;
    assert.equal(result.execution.result.ok, true);
    assert.deepEqual(result.execution.result.content, { applied: 1 });
  });

  it("does not inherit consent for an unjournalled fallback", async function () {
    globalThis.Zotero = { debug: () => undefined } as never;
    const registry = new AgentToolRegistry();
    let executions = 0;
    registry.register({
      spec: {
        name: "mutate_library",
        description: "apply changes",
        inputSchema: { type: "object" },
        mutability: "write",
        requiresConfirmation: true,
      },
      validate: () => ({ ok: true, value: {} }),
      planMutation: () => ({ effect: "write", reversibility: "full" }),
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
        },
      },
    );

    assert.equal(result.kind, "confirmation");
    assert.equal(executions, 0);
    if (result.kind !== "confirmation") return;
    assert.include(result.action.description, "Recovery warning");
    assert.include(
      result.action.fields.map((field) => field.id),
      "journalRecoveryWarning",
    );
    const confirmed = await result.execute();
    assert.isTrue(confirmed.result.ok);
    assert.equal(executions, 1);
  });

  it("filters request-scoped tools when they are unavailable", async function () {
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "edit_current_note",
        description: "edit the active note",
        inputSchema: { type: "object" },
        mutability: "write",
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
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "read_tool",
        description: "read",
        inputSchema: { type: "object" },
        mutability: "read",
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
        mutability: "write",
        requiresConfirmation: false,
      },
      validate: () => ({ ok: true, value: {} }),
      planMutation: () => ({ effect: "none", reversibility: "full" }),
      execute: async () => ({
        content: { value: "listed" },
        effect: "none",
      }),
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
  });

  it("acquires the conversation write lock for a planned write", async function () {
    globalThis.Zotero = {
      DB: new ChangeJournalTestDb(),
      debug: () => undefined,
    } as never;
    await initAgentChangeJournal();
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "write_tool",
        description: "write",
        inputSchema: { type: "object" },
        mutability: "write",
        requiresConfirmation: false,
      },
      validate: () => ({ ok: true, value: {} }),
      planMutation: () => ({ effect: "write", reversibility: "full" }),
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
    const registry = new AgentToolRegistry();
    let allowed = true;
    registry.register({
      spec: {
        name: "slow_read",
        description: "read",
        inputSchema: { type: "object" },
        mutability: "read",
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
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "unknown_write",
        description: "write",
        inputSchema: { type: "object" },
        mutability: "write",
        requiresConfirmation: false,
      },
      validate: () => ({ ok: true, value: {} }),
      planMutation: () => ({ effect: "none", reversibility: "full" }),
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

  it("fails closed when Agent mode has no configured contract verifier", async function () {
    const registry = new AgentToolRegistry();
    let executed = false;
    registry.register({
      spec: {
        name: "unverified_write",
        description: "write",
        inputSchema: { type: "object" },
        mutability: "write",
        requiresConfirmation: false,
      },
      validate: () => ({ ok: true, value: {} }),
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
          actionContract: {
            version: 2,
            id: "contract:no-write",
            writeDisposition: "none",
            interpretationSource: "classifier",
            obligations: [],
          },
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
});
