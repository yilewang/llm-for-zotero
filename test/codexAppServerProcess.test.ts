import { assert } from "chai";
import {
  CodexAppServerProcess,
  destroyCachedCodexAppServerProcess,
  extractCodexAppServerThreadId,
  extractCodexAppServerTurnId,
  waitForCodexAppServerTurnCompletion,
} from "../src/utils/codexAppServerProcess";

function createProcess(): CodexAppServerProcess {
  return CodexAppServerProcess.forTest({
    stdin: { write: () => {} },
    kill: () => {},
  });
}

describe("codexAppServerProcess", function () {
  it("extracts thread and turn IDs from both flat and nested response shapes", function () {
    assert.equal(
      extractCodexAppServerThreadId({ id: "thread-flat" }),
      "thread-flat",
    );
    assert.equal(
      extractCodexAppServerThreadId({ thread: { id: "thread-nested" } }),
      "thread-nested",
    );
    assert.equal(extractCodexAppServerTurnId({ id: "turn-flat" }), "turn-flat");
    assert.equal(
      extractCodexAppServerTurnId({ turn: { id: "turn-nested" } }),
      "turn-nested",
    );
  });

  it("serializes turn work on a shared process", async function () {
    const proc = createProcess();
    const order: string[] = [];
    let releaseFirst!: () => void;

    const first = proc.runTurnExclusive(async () => {
      order.push("first-start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first-end");
      return "first";
    });

    const second = proc.runTurnExclusive(async () => {
      order.push("second-start");
      return "second";
    });

    await Promise.resolve();
    assert.deepEqual(order, ["first-start"]);

    releaseFirst();
    const results = await Promise.all([first, second]);

    assert.deepEqual(results, ["first", "second"]);
    assert.deepEqual(order, ["first-start", "first-end", "second-start"]);
  });

  it("destroys an explicit process when evicting a missing cache entry", function () {
    let killed = false;
    const proc = CodexAppServerProcess.forTest({
      stdin: { write: () => {} },
      kill: () => {
        killed = true;
      },
    });

    destroyCachedCodexAppServerProcess("missing-cache-key", proc);

    assert.isTrue(killed);
  });

  it("responds to server-initiated JSON-RPC requests via registered handlers", async function () {
    const writes: string[] = [];
    const proc = CodexAppServerProcess.forTest({
      stdin: {
        write: (chunk: string) => {
          writes.push(chunk);
        },
      },
      kill: () => {},
    });

    proc.onRequest("item/tool/call", async (params) => {
      assert.deepEqual(params, {
        callId: "call-1",
        tool: "query_library",
        arguments: { query: "transformers" },
      });
      return {
        contentItems: [{ type: "inputText", text: "done" }],
        success: true,
      };
    });

    await (proc as unknown as {
      handleMessage: (msg: Record<string, unknown>) => void;
    }).handleMessage({
      id: 7,
      method: "item/tool/call",
      params: {
        callId: "call-1",
        tool: "query_library",
        arguments: { query: "transformers" },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(
      JSON.parse(writes[0] || "{}"),
      {
        id: 7,
        result: {
          contentItems: [{ type: "inputText", text: "done" }],
          success: true,
        },
      },
    );
  });

  it("times out when a turn never completes", async function () {
    const proc = createProcess();
    let caught: unknown;
    try {
      await waitForCodexAppServerTurnCompletion({
        proc,
        turnId: "turn-timeout",
        timeoutMs: 10,
      });
    } catch (error) {
      caught = error;
    }
    assert.instanceOf(caught, Error);
    assert.match(
      (caught as Error).message,
      /Timed out waiting for codex app-server turn completion after 10ms/,
    );
  });

  it("uses CODEX_PATH when spawning on Windows", async function () {
    const originalZotero = globalThis.Zotero;
    const originalProcess = globalThis.process;
    const originalLoadSubprocessModule = CodexAppServerProcess.loadSubprocessModule;
    const originalStartReadLoop = (
      CodexAppServerProcess.prototype as unknown as {
        startReadLoop: () => void;
      }
    ).startReadLoop;
    const originalInitialize = (
      CodexAppServerProcess.prototype as unknown as {
        initialize: () => Promise<void>;
      }
    ).initialize;
    const calls: Array<{ command: string; arguments: string[] }> = [];

    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      isWin: true,
    } as unknown;
    (globalThis as typeof globalThis & { process?: typeof process }).process = {
      ...originalProcess,
      env: {
        ...originalProcess?.env,
        CODEX_PATH: "C:\\Tools\\Codex\\codex.exe",
      },
    } as typeof process;
    CodexAppServerProcess.loadSubprocessModule = async () => ({
      call: async (options: { command: string; arguments: string[] }) => {
        calls.push(options);
        return {
          stdin: { write: () => {} },
          kill: () => {},
        };
      },
    });
    (
      CodexAppServerProcess.prototype as unknown as {
        startReadLoop: () => void;
      }
    ).startReadLoop = () => {};
    (
      CodexAppServerProcess.prototype as unknown as {
        initialize: () => Promise<void>;
      }
    ).initialize = async () => {};

    try {
      const proc = await CodexAppServerProcess.spawn();
      proc.destroy();
    } finally {
      (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
        originalZotero;
      (globalThis as typeof globalThis & { process?: typeof process }).process =
        originalProcess;
      CodexAppServerProcess.loadSubprocessModule = originalLoadSubprocessModule;
      (
        CodexAppServerProcess.prototype as unknown as {
          startReadLoop: () => void;
        }
      ).startReadLoop = originalStartReadLoop;
      (
        CodexAppServerProcess.prototype as unknown as {
          initialize: () => Promise<void>;
        }
      ).initialize = originalInitialize;
    }

    assert.lengthOf(calls, 1);
    assert.match(calls[0]?.command || "", /c:\\windows\\system32\\cmd\.exe/i);
    assert.deepEqual(calls[0]?.arguments, [
      "/c",
      "\"C:\\Tools\\Codex\\codex.exe\" app-server",
    ]);
  });
});
