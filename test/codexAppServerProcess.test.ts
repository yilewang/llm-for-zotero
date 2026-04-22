import { assert } from "chai";
import {
  CodexAppServerProcess,
  destroyCachedCodexAppServerProcess,
  extractCodexAppServerThreadId,
  extractCodexAppServerTurnId,
  getOrCreateCodexAppServerProcess,
  resolveCodexAppServerReasoningParams,
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

  it("maps UI reasoning levels to app-server effort and verbose summaries", function () {
    assert.deepEqual(
      resolveCodexAppServerReasoningParams(
        {
          provider: "openai",
          level: "low",
        },
        "gpt-5.4",
      ),
      {
        effort: "low",
        summary: "detailed",
      },
    );
    assert.deepEqual(
      resolveCodexAppServerReasoningParams(
        {
          provider: "openai",
          level: "xhigh",
        },
        "gpt-5.4",
      ),
      {
        effort: "xhigh",
        summary: "detailed",
      },
    );
    assert.deepEqual(
      resolveCodexAppServerReasoningParams(
        {
          provider: "openai",
          level: "default",
        },
        "gpt-5.4",
      ),
      {
        summary: "detailed",
      },
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

  it("times out stalled JSON-RPC requests and marks the process unusable", async function () {
    let killed = false;
    const writes: string[] = [];
    const proc = CodexAppServerProcess.forTest({
      stdin: {
        write: (chunk: string) => {
          writes.push(chunk);
        },
      },
      kill: () => {
        killed = true;
      },
    });

    let caught: unknown;
    try {
      await proc.sendRequest("thread/start", { model: "gpt-5.4" }, 10);
    } catch (error) {
      caught = error;
    }

    assert.instanceOf(caught, Error);
    assert.match(
      (caught as Error).message,
      /Timed out waiting for codex app-server response to thread\/start after 10ms/,
    );
    assert.isTrue(killed);
    assert.lengthOf(writes, 1);

    let destroyedError: unknown;
    try {
      await proc.sendRequest("thread/start", { model: "gpt-5.4" });
    } catch (error) {
      destroyedError = error;
    }
    assert.instanceOf(destroyedError, Error);
    assert.match(
      (destroyedError as Error).message,
      /CodexAppServerProcess destroyed/,
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

  it("refreshes the turn timeout when the app-server stays active", async function () {
    const proc = createProcess();

    setTimeout(() => {
      void (proc as unknown as {
        handleMessage: (msg: Record<string, unknown>) => void;
      }).handleMessage({
        id: 9,
        method: "item/tool/call",
        params: {
          callId: "call-1",
          tool: "edit_current_note",
          arguments: { mode: "create" },
        },
      });
    }, 20);
    setTimeout(() => {
      void (proc as unknown as {
        handleMessage: (msg: Record<string, unknown>) => void;
      }).handleMessage({
        method: "turn/completed",
        params: {
          turnId: "turn-active",
          status: "completed",
        },
      });
    }, 45);

    proc.onRequest("item/tool/call", async () => ({
      contentItems: [{ type: "inputText", text: "approved" }],
      success: true,
    }));

    const result = await waitForCodexAppServerTurnCompletion({
      proc,
      turnId: "turn-active",
      timeoutMs: 30,
    });

    assert.equal(result, "");
  });

  it("streams reasoning summaries and details without duplicating final reasoning items", async function () {
    const proc = createProcess();
    const reasoning: Array<{ summary?: string; details?: string }> = [];

    setTimeout(() => {
      void (proc as unknown as {
        handleMessage: (msg: Record<string, unknown>) => void;
      }).handleMessage({
        method: "item/reasoning/summaryTextDelta",
        params: {
          itemId: "reasoning-1",
          delta: "Plan first.",
        },
      });
    }, 5);
    setTimeout(() => {
      void (proc as unknown as {
        handleMessage: (msg: Record<string, unknown>) => void;
      }).handleMessage({
        method: "item/reasoning/textDelta",
        params: {
          itemId: "reasoning-1",
          delta: "Inspecting the library.",
        },
      });
    }, 10);
    setTimeout(() => {
      void (proc as unknown as {
        handleMessage: (msg: Record<string, unknown>) => void;
      }).handleMessage({
        method: "item/completed",
        params: {
          item: {
            id: "reasoning-1",
            type: "reasoning",
            summary: "Plan first.",
            content: "Inspecting the library.",
          },
        },
      });
    }, 15);
    setTimeout(() => {
      void (proc as unknown as {
        handleMessage: (msg: Record<string, unknown>) => void;
      }).handleMessage({
        method: "turn/completed",
        params: {
          turnId: "turn-reasoning",
          status: "completed",
        },
      });
    }, 20);

    const result = await waitForCodexAppServerTurnCompletion({
      proc,
      turnId: "turn-reasoning",
      onReasoning: async (event) => {
        reasoning.push({
          ...(event.summary ? { summary: event.summary } : {}),
          ...(event.details ? { details: event.details } : {}),
        });
      },
      timeoutMs: 50,
    });

    assert.equal(result, "");
    assert.deepEqual(reasoning, [
      { summary: "Plan first." },
      { details: "Inspecting the library." },
    ]);
  });

  it("falls back to final reasoning items when the app-server sends no reasoning deltas", async function () {
    const proc = createProcess();
    const reasoning: Array<{ summary?: string; details?: string }> = [];

    setTimeout(() => {
      void (proc as unknown as {
        handleMessage: (msg: Record<string, unknown>) => void;
      }).handleMessage({
        method: "item/completed",
        params: {
          item: {
            id: "reasoning-2",
            type: "reasoning",
            summary: "Reviewing context.",
            content: "Looking through the selected note.",
          },
        },
      });
    }, 5);
    setTimeout(() => {
      void (proc as unknown as {
        handleMessage: (msg: Record<string, unknown>) => void;
      }).handleMessage({
        method: "turn/completed",
        params: {
          turnId: "turn-reasoning-final",
          status: "completed",
        },
      });
    }, 10);

    const result = await waitForCodexAppServerTurnCompletion({
      proc,
      turnId: "turn-reasoning-final",
      onReasoning: async (event) => {
        reasoning.push({
          ...(event.summary ? { summary: event.summary } : {}),
          ...(event.details ? { details: event.details } : {}),
        });
      },
      timeoutMs: 50,
    });

    assert.equal(result, "");
    assert.deepEqual(reasoning, [
      { summary: "Reviewing context." },
      { details: "Looking through the selected note." },
    ]);
  });

  it("emits token usage updates for the active turn", async function () {
    const proc = createProcess();
    const usage: Array<{
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    }> = [];

    setTimeout(() => {
      void (proc as unknown as {
        handleMessage: (msg: Record<string, unknown>) => void;
      }).handleMessage({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-usage",
          turnId: "turn-usage",
          tokenUsage: {
            last: {
              totalTokens: 42,
              inputTokens: 39,
              outputTokens: 3,
            },
          },
        },
      });
    }, 5);
    setTimeout(() => {
      void (proc as unknown as {
        handleMessage: (msg: Record<string, unknown>) => void;
      }).handleMessage({
        method: "turn/completed",
        params: {
          turnId: "turn-usage",
          status: "completed",
        },
      });
    }, 10);

    const result = await waitForCodexAppServerTurnCompletion({
      proc,
      turnId: "turn-usage",
      onUsage: async (event) => {
        usage.push(event);
      },
      timeoutMs: 50,
    });

    assert.equal(result, "");
    assert.deepEqual(usage, [
      {
        promptTokens: 39,
        completionTokens: 3,
        totalTokens: 42,
      },
    ]);
  });

  it("deduplicates repeated cumulative token usage updates", async function () {
    const proc = createProcess();
    const usage: Array<{
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    }> = [];

    setTimeout(() => {
      void (proc as unknown as {
        handleMessage: (msg: Record<string, unknown>) => void;
      }).handleMessage({
        method: "thread/tokenUsage/updated",
        params: {
          turnId: "turn-usage-repeat",
          tokenUsage: {
            last: {
              totalTokens: 10,
              inputTokens: 8,
              outputTokens: 2,
            },
          },
        },
      });
    }, 5);
    setTimeout(() => {
      void (proc as unknown as {
        handleMessage: (msg: Record<string, unknown>) => void;
      }).handleMessage({
        method: "thread/tokenUsage/updated",
        params: {
          turnId: "turn-usage-repeat",
          tokenUsage: {
            last: {
              totalTokens: 10,
              inputTokens: 8,
              outputTokens: 2,
            },
          },
        },
      });
    }, 10);
    setTimeout(() => {
      void (proc as unknown as {
        handleMessage: (msg: Record<string, unknown>) => void;
      }).handleMessage({
        method: "thread/tokenUsage/updated",
        params: {
          turnId: "turn-usage-repeat",
          tokenUsage: {
            last: {
              totalTokens: 15,
              inputTokens: 11,
              outputTokens: 4,
            },
          },
        },
      });
    }, 15);
    setTimeout(() => {
      void (proc as unknown as {
        handleMessage: (msg: Record<string, unknown>) => void;
      }).handleMessage({
        method: "turn/completed",
        params: {
          turnId: "turn-usage-repeat",
          status: "completed",
        },
      });
    }, 20);

    const result = await waitForCodexAppServerTurnCompletion({
      proc,
      turnId: "turn-usage-repeat",
      onUsage: async (event) => {
        usage.push(event);
      },
      timeoutMs: 50,
    });

    assert.equal(result, "");
    assert.deepEqual(usage, [
      {
        promptTokens: 8,
        completionTokens: 2,
        totalTokens: 10,
      },
      {
        promptTokens: 3,
        completionTokens: 2,
        totalTokens: 5,
      },
    ]);
  });

  it("prefers cumulative token totals when both total and last usage are present", async function () {
    const proc = createProcess();
    const usage: Array<{
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    }> = [];

    setTimeout(() => {
      void (proc as unknown as {
        handleMessage: (msg: Record<string, unknown>) => void;
      }).handleMessage({
        method: "thread/tokenUsage/updated",
        params: {
          turnId: "turn-usage-total",
          tokenUsage: {
            last: {
              totalTokens: 10,
              inputTokens: 8,
              outputTokens: 2,
            },
            total: {
              totalTokens: 10,
              inputTokens: 8,
              outputTokens: 2,
            },
          },
        },
      });
    }, 5);
    setTimeout(() => {
      void (proc as unknown as {
        handleMessage: (msg: Record<string, unknown>) => void;
      }).handleMessage({
        method: "thread/tokenUsage/updated",
        params: {
          turnId: "turn-usage-total",
          tokenUsage: {
            last: {
              totalTokens: 5,
              inputTokens: 4,
              outputTokens: 1,
            },
            total: {
              totalTokens: 15,
              inputTokens: 12,
              outputTokens: 3,
            },
          },
        },
      });
    }, 10);
    setTimeout(() => {
      void (proc as unknown as {
        handleMessage: (msg: Record<string, unknown>) => void;
      }).handleMessage({
        method: "turn/completed",
        params: {
          turnId: "turn-usage-total",
          status: "completed",
        },
      });
    }, 15);

    const result = await waitForCodexAppServerTurnCompletion({
      proc,
      turnId: "turn-usage-total",
      onUsage: async (event) => {
        usage.push(event);
      },
      timeoutMs: 50,
    });

    assert.equal(result, "");
    assert.deepEqual(usage, [
      {
        promptTokens: 8,
        completionTokens: 2,
        totalTokens: 10,
      },
      {
        promptTokens: 4,
        completionTokens: 1,
        totalTokens: 5,
      },
    ]);
  });

  it("evicts a closed cached process so the next lookup spawns a fresh instance", async function () {
    const originalSpawn = CodexAppServerProcess.spawn;
    const spawned: CodexAppServerProcess[] = [];
    CodexAppServerProcess.spawn = async () => {
      const proc = CodexAppServerProcess.forTest({
        stdin: { write: () => {} },
        kill: () => {},
      });
      spawned.push(proc);
      return proc;
    };

    try {
      const first = await getOrCreateCodexAppServerProcess("evict-on-close");
      const second = await getOrCreateCodexAppServerProcess("evict-on-close");
      assert.strictEqual(second, first);

      first.destroy();

      const third = await getOrCreateCodexAppServerProcess("evict-on-close");
      assert.notStrictEqual(third, first);
      assert.lengthOf(spawned, 2);
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      destroyCachedCodexAppServerProcess("evict-on-close");
    }
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

  it("falls back to /opt/homebrew/bin/codex on macOS when PATH lookup misses it", async function () {
    const originalZotero = globalThis.Zotero;
    const originalProcess = globalThis.process;
    const originalIOUtils = (
      globalThis as typeof globalThis & { IOUtils?: unknown }
    ).IOUtils;
    const originalLoadSubprocessModule =
      CodexAppServerProcess.loadSubprocessModule;
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
      isMac: true,
    } as unknown;
    (globalThis as typeof globalThis & { process?: typeof process }).process = {
      ...originalProcess,
      env: {
        ...originalProcess?.env,
        HOME: "/Users/alice",
      },
    } as typeof process;
    (globalThis as typeof globalThis & { IOUtils?: unknown }).IOUtils = {
      exists: async (path: string) => path === "/opt/homebrew/bin/codex",
    };
    CodexAppServerProcess.loadSubprocessModule = async () => ({
      call: async (options: { command: string; arguments: string[] }) => {
        calls.push(options);
        if (
          options.command === "/bin/zsh" &&
          options.arguments[1] === "which codex"
        ) {
          return {
            stdout: {
              readString: async () => "",
            },
            wait: async () => ({ exitCode: 1 }),
          };
        }
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
      (globalThis as typeof globalThis & { IOUtils?: unknown }).IOUtils =
        originalIOUtils;
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

    assert.deepEqual(calls[0], {
      command: "/bin/zsh",
      arguments: ["-c", "which codex"],
    });
    assert.equal(calls[1]?.command, "/opt/homebrew/bin/codex");
    assert.deepEqual(calls[1]?.arguments, ["app-server"]);
  });
});
