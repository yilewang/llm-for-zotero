import { assert } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import {
  bindClaudeBridgeConversationSystem,
  createExternalBackendBridgeRuntime,
} from "../src/agent/externalBackendBridge";

const CORE_CAPABILITIES = {
  streaming: true,
  toolCalls: false,
  multimodal: false,
  fileInputs: false,
  reasoning: false,
};

function createRuntime() {
  return createExternalBackendBridgeRuntime({
    coreRuntime: {
      listTools: () => [],
      getToolDefinition: () => null,
      unregisterTool: () => undefined,
      registerTool: () => undefined,
      registerPendingConfirmation: () => undefined,
      resolveConfirmation: () => false,
      getRunTrace: () => [],
      getCapabilities: () => CORE_CAPABILITIES,
      runTurn: async () => ({
        kind: "fallback",
        runId: "unused",
        reason: "unused",
        usedFallback: true,
      }),
    } as any,
    getBridgeUrl: () => "http://127.0.0.1:19787",
  });
}

/**
 * The window on Claude Code while the sidebar last chose the API: the saved
 * conversationSystem pref says "upstream", but the window's own turns and
 * menus name Claude Code explicitly and must still get Claude's.
 */
describe("external bridge gates follow the caller's conversation system", function () {
  const originalFetch = globalThis.fetch;
  const originalZotero = globalThis.Zotero;
  let savedSystem = "upstream";

  beforeEach(function () {
    savedSystem = "upstream";
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Prefs: {
        get(key: string) {
          if (key.endsWith("enableClaudeCodeMode")) return true;
          if (key.endsWith("conversationSystem")) return savedSystem;
          return "";
        },
      },
      Profile: { dir: "/tmp/llm-for-zotero-bridge-gate-test" },
    } as typeof Zotero;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("/commands")
        ? { commands: [{ name: "review", description: "Review" }] }
        : url.includes("/efforts")
          ? { efforts: ["low", "high"] }
          : url.includes("/tools")
            ? {
                tools: [
                  {
                    name: "Read",
                    description: "Read a file",
                    inputSchema: { type: "object" },
                  },
                ],
              }
            : {
                models: ["sonnet"],
                modelInfos: [{ value: "sonnet", displayName: "Sonnet" }],
              };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  });

  afterEach(function () {
    globalThis.fetch = originalFetch;
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
  });

  it("an explicit Claude Code system keeps capabilities, models, efforts and commands", async function () {
    const runtime = createRuntime();
    const claude = { conversationSystem: "claude_code" as const };
    await runtime.refreshExternalActions(true);
    assert.lengthOf(runtime.listExternalActionsSync(claude), 1);

    assert.isTrue(runtime.getCapabilities({} as any, claude).toolCalls);
    assert.deepEqual(
      (await runtime.listModels(false, undefined, claude)).models.map(
        (model) => model.value,
      ),
      ["sonnet"],
    );
    assert.deepEqual(await runtime.listEfforts("sonnet", undefined, claude), [
      "low",
      "high",
    ]);
    await runtime.refreshSlashCommands(true);
    assert.deepEqual(
      runtime.listSlashCommandsSync(claude).map((command) => command.name),
      ["review"],
    );
  });

  it("an explicit API system gets the core runtime's answers even when the saved system is Claude Code", async function () {
    savedSystem = "claude_code";
    const runtime = createRuntime();
    const upstream = { conversationSystem: "upstream" as const };
    await runtime.refreshSlashCommands(true);

    assert.deepEqual(
      runtime.getCapabilities({} as any, upstream),
      CORE_CAPABILITIES,
    );
    assert.deepEqual(
      (await runtime.listModels(false, undefined, upstream)).models,
      [],
    );
    assert.deepEqual(
      await runtime.listEfforts("sonnet", undefined, upstream),
      [],
    );
    assert.deepEqual(runtime.listSlashCommandsSync(upstream), []);
    assert.deepEqual(runtime.listExternalActionsSync(upstream), []);
  });

  it("without a system the saved pref still decides, as before", async function () {
    const runtime = createRuntime();
    await runtime.refreshSlashCommands(true);
    assert.deepEqual(runtime.getCapabilities({} as any), CORE_CAPABILITIES);
    assert.deepEqual(runtime.listSlashCommandsSync(), []);

    savedSystem = "claude_code";
    assert.isTrue(runtime.getCapabilities({} as any).toolCalls);
    assert.lengthOf(runtime.listSlashCommandsSync(), 1);
  });

  it("a runtime bound to a turn's system answers for that system", async function () {
    const runtime = createRuntime();
    await runtime.refreshSlashCommands(true);
    const bound = bindClaudeBridgeConversationSystem(runtime, "claude_code");

    assert.isTrue(bound.getCapabilities({} as any).toolCalls);
    assert.lengthOf(bound.listSlashCommandsSync(), 1);
    assert.deepEqual(await bound.listEfforts("sonnet"), ["low", "high"]);
    // Everything else is the same runtime.
    assert.strictEqual(bound.runTurn, runtime.runTurn);
  });
});
