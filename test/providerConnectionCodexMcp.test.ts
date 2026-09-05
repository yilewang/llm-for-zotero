import { assert } from "chai";
import { CodexAppServerProcess } from "../src/utils/codexAppServerProcess";
import { runCodexAppServerConnectionTest } from "../src/utils/providerConnectionTest";

type RequestCall = { method: string; params: unknown };

function createTestProcess(
  sendRequest: (method: string, params?: unknown) => Promise<unknown>,
): CodexAppServerProcess {
  const proc = CodexAppServerProcess.forTest({
    stdin: { write: () => {} },
    kill: () => {},
  });
  proc.sendRequest = sendRequest;
  return proc;
}

function emitNotification(
  proc: CodexAppServerProcess,
  method: string,
  params: unknown,
): void {
  (
    proc as unknown as {
      handleMessage: (message: Record<string, unknown>) => void;
    }
  ).handleMessage({ method, params });
}

describe("Codex app-server connection test MCP probe", function () {
  const originalSpawn = CodexAppServerProcess.spawn;
  const originalZotero = (globalThis as { Zotero?: unknown }).Zotero;
  const prefStore = new Map<string, unknown>();

  beforeEach(function () {
    prefStore.clear();
    (globalThis as { Zotero?: unknown }).Zotero = {
      Prefs: {
        get: (key: string) => {
          if (key === "httpServer.port") return 24680;
          return prefStore.get(key);
        },
        set: (key: string, value: unknown) => prefStore.set(key, value),
      },
    };
  });

  afterEach(function () {
    CodexAppServerProcess.spawn = originalSpawn;
    (globalThis as { Zotero?: unknown }).Zotero = originalZotero;
  });

  it("probes MCP before the model and reports both successful connections", async function () {
    const calls: RequestCall[] = [];
    let threadStartCount = 0;
    const proc = createTestProcess(async (method, params) => {
      calls.push({ method, params });
      if (method === "thread/start") {
        threadStartCount += 1;
        return threadStartCount === 1
          ? { thread: { id: "probe-thread" } }
          : { thread: { id: "model-thread" } };
      }
      if (method === "thread/archive") return {};
      if (method === "turn/start") {
        setTimeout(() => {
          emitNotification(proc, "item/completed", {
            turnId: "model-turn",
            item: {
              id: "answer-item",
              type: "agentMessage",
              text: "OK",
            },
          });
          emitNotification(proc, "turn/completed", {
            turn: { id: "model-turn", status: "completed" },
          });
        }, 0);
        return { turn: { id: "model-turn" } };
      }
      throw new Error(`unexpected method ${method}`);
    });
    CodexAppServerProcess.spawn = async () => proc;

    const result = await runCodexAppServerConnectionTest({
      modelName: "gpt-5.4",
      testZoteroMcp: true,
    });

    assert.deepEqual(
      calls.map((call) => call.method),
      ["thread/start", "thread/archive", "thread/start", "turn/start"],
    );
    const probeParams = calls[0]?.params as {
      config?: { mcp_servers?: Record<string, { required?: boolean }> };
    };
    const probeServers = probeParams.config?.mcp_servers || {};
    assert.isTrue(Object.values(probeServers)[0]?.required);
    assert.notProperty(calls[2]?.params as Record<string, unknown>, "config");
    assert.equal(result.reply, "OK");
    assert.isTrue(result.mcpConnected);
  });

  it("does not send a model request after the MCP probe fails", async function () {
    const calls: RequestCall[] = [];
    const proc = createTestProcess(async (method, params) => {
      calls.push({ method, params });
      throw new Error(
        "MCP server llm_for_zotero_connection_probe at http://127.0.0.1:24680/llm-for-zotero/mcp returned HTTP 502 Bad Gateway",
      );
    });
    CodexAppServerProcess.spawn = async () => proc;

    let thrown: unknown;
    try {
      await runCodexAppServerConnectionTest({
        modelName: "gpt-5.4",
        testZoteroMcp: true,
      });
    } catch (error) {
      thrown = error;
    }

    assert.instanceOf(thrown, Error);
    assert.include((thrown as Error).message, "HTTP 502");
    assert.deepEqual(
      calls.map((call) => call.method),
      ["thread/start"],
    );
  });

  it("preserves a successful MCP result when the later model test fails", async function () {
    const calls: RequestCall[] = [];
    let threadStartCount = 0;
    const proc = createTestProcess(async (method, params) => {
      calls.push({ method, params });
      if (method === "thread/start") {
        threadStartCount += 1;
        if (threadStartCount === 1) {
          return { thread: { id: "probe-thread" } };
        }
        throw new Error("model endpoint unavailable");
      }
      if (method === "thread/archive") return {};
      throw new Error(`unexpected method ${method}`);
    });
    CodexAppServerProcess.spawn = async () => proc;

    let thrown: unknown;
    try {
      await runCodexAppServerConnectionTest({
        modelName: "gpt-5.4",
        testZoteroMcp: true,
      });
    } catch (error) {
      thrown = error;
    }

    assert.instanceOf(thrown, Error);
    assert.equal((thrown as { mcpConnected?: unknown }).mcpConnected, true);
    assert.equal((thrown as Error).message, "model endpoint unavailable");
    assert.deepEqual(
      calls.map((call) => call.method),
      ["thread/start", "thread/archive", "thread/start"],
    );
  });

  it("retains the model-only path when Zotero MCP testing is disabled", async function () {
    const calls: RequestCall[] = [];
    const proc = createTestProcess(async (method, params) => {
      calls.push({ method, params });
      if (method === "thread/start") {
        return { thread: { id: "model-only-thread" } };
      }
      if (method === "turn/start") {
        setTimeout(() => {
          emitNotification(proc, "item/completed", {
            turnId: "model-only-turn",
            item: {
              id: "answer-item",
              type: "agentMessage",
              text: "OK",
            },
          });
          emitNotification(proc, "turn/completed", {
            turn: { id: "model-only-turn", status: "completed" },
          });
        }, 0);
        return { turn: { id: "model-only-turn" } };
      }
      throw new Error(`unexpected method ${method}`);
    });
    CodexAppServerProcess.spawn = async () => proc;

    const result = await runCodexAppServerConnectionTest({
      modelName: "gpt-5.4",
      testZoteroMcp: false,
    });

    assert.deepEqual(
      calls.map((call) => call.method),
      ["thread/start", "turn/start"],
    );
    assert.isFalse(result.mcpConnected);
  });
});
