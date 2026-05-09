import { assert } from "chai";
import {
  CodexAppServerProcess,
  destroyCachedCodexAppServerProcess,
  extractCodexAppServerThreadId,
  extractCodexAppServerTurnId,
  getOrCreateCodexAppServerProcess,
  isCodexAppServerInjectItemsUnsupportedError,
  listNvmCodexCandidates,
  resolveCodexAppServerBinaryPath,
  resolveCodexBinary,
  resolveCodexAppServerTurnInputWithFallback,
  resolveCodexAppServerReasoningParams,
  selectCodexLookupResult,
  waitForCodexAppServerTurnCompletion,
} from "../src/utils/codexAppServerProcess";

function createProcess(): CodexAppServerProcess {
  return CodexAppServerProcess.forTest({
    stdin: { write: () => {} },
    kill: () => {},
  });
}

type SubprocessCallOptions = {
  command: string;
  arguments: string[];
  stderr?: string;
  environment?: Record<string, string>;
  environmentAppend?: boolean;
};

type TestGlobal = typeof globalThis & {
  IOUtils?: unknown;
  Services?: unknown;
  Zotero?: unknown;
  process?: typeof process;
};

type RuntimeStubOptions = {
  env?: Record<string, string | undefined>;
  inheritEnv?: boolean;
  ioExists?: (path: string) => boolean | Promise<boolean>;
  ioGetChildren?: (path: string) => string[] | Promise<string[]>;
  platform?: "macos" | "windows";
  servicesEnvGet?: (key: string) => string | undefined;
  subprocessCall?: (
    options: SubprocessCallOptions,
  ) => unknown | Promise<unknown>;
  subprocessUnavailable?: boolean;
  stubProcessLifecycle?: boolean;
};

function platformZotero(platform?: RuntimeStubOptions["platform"]): unknown {
  if (platform === "windows") return { isWin: true };
  if (platform === "macos") return { isMac: true };
  return undefined;
}

async function withRuntimeStubs<T>(
  options: RuntimeStubOptions,
  callback: () => T | Promise<T>,
): Promise<T> {
  const globals = globalThis as TestGlobal;
  const originalIOUtils = globals.IOUtils;
  const originalProcess = globals.process;
  const originalServices = globals.Services;
  const originalZotero = globals.Zotero;
  const originalLoadSubprocessModule =
    CodexAppServerProcess.loadSubprocessModule;
  const prototype = CodexAppServerProcess.prototype as unknown as {
    initialize: () => Promise<void>;
    startReadLoop: () => void;
  };
  const originalInitialize = prototype.initialize;
  const originalStartReadLoop = prototype.startReadLoop;

  try {
    const zotero = platformZotero(options.platform);
    if (zotero) globals.Zotero = zotero;
    if (options.env) {
      globals.process = {
        ...originalProcess,
        env:
          options.inheritEnv === false
            ? options.env
            : { ...originalProcess?.env, ...options.env },
      } as typeof process;
    }
    if (options.ioExists || options.ioGetChildren) {
      globals.IOUtils = {
        ...(options.ioExists ? { exists: options.ioExists } : {}),
        ...(options.ioGetChildren
          ? { getChildren: options.ioGetChildren }
          : {}),
      };
    }
    if (options.servicesEnvGet) {
      globals.Services = {
        env: { get: options.servicesEnvGet },
      };
    }
    if (options.subprocessUnavailable) {
      CodexAppServerProcess.loadSubprocessModule = async () => {
        throw new Error("Subprocess unavailable");
      };
    } else if (options.subprocessCall) {
      CodexAppServerProcess.loadSubprocessModule = async () => ({
        call: options.subprocessCall,
      });
    }
    if (options.stubProcessLifecycle) {
      prototype.startReadLoop = () => {};
      prototype.initialize = async () => {};
    }

    return await callback();
  } finally {
    globals.IOUtils = originalIOUtils;
    globals.process = originalProcess;
    globals.Services = originalServices;
    globals.Zotero = originalZotero;
    CodexAppServerProcess.loadSubprocessModule = originalLoadSubprocessModule;
    prototype.startReadLoop = originalStartReadLoop;
    prototype.initialize = originalInitialize;
  }
}

function createSpawnStub(calls: SubprocessCallOptions[]) {
  return async (options: SubprocessCallOptions) => {
    calls.push(options);
    return {
      stdout: { readString: async () => "" },
      stdin: { write: () => {} },
      kill: () => {},
    };
  };
}

function createOneShotReader(value: string) {
  let didRead = false;
  return {
    readString: async () => {
      if (didRead) return "";
      didRead = true;
      return value;
    },
  };
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

  it("recognizes older-server thread/inject_items compatibility errors", function () {
    assert.isTrue(
      isCodexAppServerInjectItemsUnsupportedError(
        new Error(
          "Invalid request: unknown variant `thread/inject_items`, expected one of initialize, thread/start, thread/resume",
        ),
      ),
    );
    assert.isTrue(
      isCodexAppServerInjectItemsUnsupportedError(
        new Error("Method not found: thread/inject_items (-32601)"),
      ),
    );
    assert.isFalse(
      isCodexAppServerInjectItemsUnsupportedError(
        new Error("permission denied while updating thread metadata"),
      ),
    );
  });

  it("caches unsupported inject_items capability after the first compatibility failure", async function () {
    const originalToolkit = (
      globalThis as typeof globalThis & { ztoolkit?: unknown }
    ).ztoolkit;
    const proc = createProcess();
    const requests: string[] = [];
    try {
      (
        globalThis as typeof globalThis & {
          ztoolkit?: { log: () => void };
        }
      ).ztoolkit = {
        log: () => undefined,
      };
      proc.sendRequest = async (method: string) => {
        requests.push(method);
        if (method === "thread/inject_items") {
          throw new Error(
            "Invalid request: unknown variant `thread/inject_items`, expected one of initialize, thread/start",
          );
        }
        return {};
      };

      const legacyInput = [{ type: "text" as const, text: "User:\nHello" }];
      const historyItemsToInject = [
        {
          type: "message" as const,
          role: "user" as const,
          content: [{ type: "input_text" as const, text: "Earlier question." }],
        },
      ];
      const turnInput = [{ type: "text" as const, text: "Hello" }];

      const first = await resolveCodexAppServerTurnInputWithFallback({
        proc,
        threadId: "thread-1",
        historyItemsToInject,
        turnInput,
        legacyInputFactory: async () => legacyInput,
        logContext: "test",
      });
      const second = await resolveCodexAppServerTurnInputWithFallback({
        proc,
        threadId: "thread-1",
        historyItemsToInject,
        turnInput,
        legacyInputFactory: async () => legacyInput,
        logContext: "test",
      });

      assert.deepEqual(first, legacyInput);
      assert.deepEqual(second, legacyInput);
      assert.equal(proc.getInjectItemsSupport(), "unsupported");
      assert.deepEqual(requests, ["thread/inject_items"]);
    } finally {
      (globalThis as typeof globalThis & { ztoolkit?: unknown }).ztoolkit =
        originalToolkit;
    }
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

    await (
      proc as unknown as {
        handleMessage: (msg: Record<string, unknown>) => void;
      }
    ).handleMessage({
      id: 7,
      method: "item/tool/call",
      params: {
        callId: "call-1",
        tool: "query_library",
        arguments: { query: "transformers" },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(JSON.parse(writes[0] || "{}"), {
      id: 7,
      result: {
        contentItems: [{ type: "inputText", text: "done" }],
        success: true,
      },
    });
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
      void (
        proc as unknown as {
          handleMessage: (msg: Record<string, unknown>) => void;
        }
      ).handleMessage({
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
      void (
        proc as unknown as {
          handleMessage: (msg: Record<string, unknown>) => void;
        }
      ).handleMessage({
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

  it("interrupts the active turn instead of destroying the process on abort", async function () {
    const writes: string[] = [];
    let killed = false;
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
    const controller = new AbortController();

    const waitPromise = waitForCodexAppServerTurnCompletion({
      proc,
      threadId: "thread-1",
      turnId: "turn-1",
      signal: controller.signal,
      interruptOnAbort: true,
      cacheKey: "interrupt-test-missing-cache-entry",
      timeoutMs: 1000,
    });

    controller.abort();
    const interruptRequest = JSON.parse(writes[0] || "{}") as {
      id: number;
      method: string;
      params: Record<string, unknown>;
    };
    await (
      proc as unknown as {
        handleMessage: (msg: Record<string, unknown>) => void;
      }
    ).handleMessage({
      id: interruptRequest.id,
      result: {},
    });

    let caught: unknown;
    try {
      await waitPromise;
    } catch (error) {
      caught = error;
    }

    assert.equal(interruptRequest.method, "turn/interrupt");
    assert.deepEqual(interruptRequest.params, {
      threadId: "thread-1",
      turnId: "turn-1",
    });
    assert.instanceOf(caught, Error);
    assert.equal((caught as Error).name, "AbortError");
    assert.isFalse(killed);
  });

  it("streams reasoning summaries and details without duplicating final reasoning items", async function () {
    const proc = createProcess();
    const reasoning: Array<{ summary?: string; details?: string }> = [];

    setTimeout(() => {
      void (
        proc as unknown as {
          handleMessage: (msg: Record<string, unknown>) => void;
        }
      ).handleMessage({
        method: "item/reasoning/summaryTextDelta",
        params: {
          itemId: "reasoning-1",
          delta: "Plan first.",
        },
      });
    }, 5);
    setTimeout(() => {
      void (
        proc as unknown as {
          handleMessage: (msg: Record<string, unknown>) => void;
        }
      ).handleMessage({
        method: "item/reasoning/textDelta",
        params: {
          itemId: "reasoning-1",
          delta: "Inspecting the library.",
        },
      });
    }, 10);
    setTimeout(() => {
      void (
        proc as unknown as {
          handleMessage: (msg: Record<string, unknown>) => void;
        }
      ).handleMessage({
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
      void (
        proc as unknown as {
          handleMessage: (msg: Record<string, unknown>) => void;
        }
      ).handleMessage({
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
      void (
        proc as unknown as {
          handleMessage: (msg: Record<string, unknown>) => void;
        }
      ).handleMessage({
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
      void (
        proc as unknown as {
          handleMessage: (msg: Record<string, unknown>) => void;
        }
      ).handleMessage({
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

  it("passes reasoning item IDs through and ignores stale-turn notifications", async function () {
    const proc = createProcess();
    const reasoning: Array<{ summary?: string; stepId?: string }> = [];
    const chunks: string[] = [];

    setTimeout(() => {
      void (
        proc as unknown as {
          handleMessage: (msg: Record<string, unknown>) => void;
        }
      ).handleMessage({
        method: "item/reasoning/summaryTextDelta",
        params: {
          turnId: "turn-stale",
          itemId: "reasoning-stale",
          delta: "Ignore this.",
        },
      });
    }, 5);
    setTimeout(() => {
      void (
        proc as unknown as {
          handleMessage: (msg: Record<string, unknown>) => void;
        }
      ).handleMessage({
        method: "item/agentMessage/delta",
        params: {
          turnId: "turn-stale",
          delta: "stale",
        },
      });
    }, 10);
    setTimeout(() => {
      void (
        proc as unknown as {
          handleMessage: (msg: Record<string, unknown>) => void;
        }
      ).handleMessage({
        method: "item/reasoning/summaryTextDelta",
        params: {
          turnId: "turn-active",
          itemId: "reasoning-active",
          delta: "Use this.",
        },
      });
    }, 15);
    setTimeout(() => {
      void (
        proc as unknown as {
          handleMessage: (msg: Record<string, unknown>) => void;
        }
      ).handleMessage({
        method: "item/agentMessage/delta",
        params: {
          turnId: "turn-active",
          delta: "active",
        },
      });
    }, 20);
    setTimeout(() => {
      void (
        proc as unknown as {
          handleMessage: (msg: Record<string, unknown>) => void;
        }
      ).handleMessage({
        method: "turn/completed",
        params: {
          turnId: "turn-active",
          status: "completed",
        },
      });
    }, 25);

    const result = await waitForCodexAppServerTurnCompletion({
      proc,
      turnId: "turn-active",
      onTextDelta: async (delta) => {
        chunks.push(delta);
      },
      onReasoning: async (event) => {
        reasoning.push({
          ...(event.summary ? { summary: event.summary } : {}),
          ...(event.stepId ? { stepId: event.stepId } : {}),
        });
      },
      timeoutMs: 50,
    });

    assert.equal(result, "active");
    assert.deepEqual(chunks, ["active"]);
    assert.deepEqual(reasoning, [
      { summary: "Use this.", stepId: "reasoning-active" },
    ]);
  });

  it("resolves turn text from the latest agent message item", async function () {
    const proc = createProcess();
    const chunks: string[] = [];

    setTimeout(() => {
      void (
        proc as unknown as {
          handleMessage: (msg: Record<string, unknown>) => void;
        }
      ).handleMessage({
        method: "item/agentMessage/delta",
        params: {
          turnId: "turn-items",
          itemId: "msg-pre",
          delta: "I'm reading.",
        },
      });
    }, 5);
    setTimeout(() => {
      void (
        proc as unknown as {
          handleMessage: (msg: Record<string, unknown>) => void;
        }
      ).handleMessage({
        method: "item/agentMessage/delta",
        params: {
          turnId: "turn-items",
          itemId: "msg-final",
          delta: "Final answer.",
        },
      });
    }, 10);
    setTimeout(() => {
      void (
        proc as unknown as {
          handleMessage: (msg: Record<string, unknown>) => void;
        }
      ).handleMessage({
        method: "item/completed",
        params: {
          turnId: "turn-items",
          item: {
            id: "msg-final",
            type: "agent_message",
            content: "Final answer.",
          },
        },
      });
    }, 15);
    setTimeout(() => {
      void (
        proc as unknown as {
          handleMessage: (msg: Record<string, unknown>) => void;
        }
      ).handleMessage({
        method: "turn/completed",
        params: {
          turnId: "turn-items",
          status: "completed",
        },
      });
    }, 20);

    const result = await waitForCodexAppServerTurnCompletion({
      proc,
      turnId: "turn-items",
      onTextDelta: async (delta) => {
        chunks.push(delta);
      },
      timeoutMs: 50,
    });

    assert.equal(result, "Final answer.");
    assert.deepEqual(chunks, ["I'm reading.", "Final answer."]);
  });

  it("routes item-scoped agent message deltas separately when requested", async function () {
    const proc = createProcess();
    const chunks: string[] = [];
    const itemDeltas: Array<{ itemId?: string; delta: string }> = [];

    setTimeout(() => {
      void (
        proc as unknown as {
          handleMessage: (msg: Record<string, unknown>) => void;
        }
      ).handleMessage({
        method: "item/agentMessage/delta",
        params: {
          turnId: "turn-items",
          itemId: "msg-progress",
          delta: "I'm reading.",
        },
      });
    }, 5);
    setTimeout(() => {
      void (
        proc as unknown as {
          handleMessage: (msg: Record<string, unknown>) => void;
        }
      ).handleMessage({
        method: "item/agentMessage/delta",
        params: {
          turnId: "turn-items",
          itemId: "msg-final",
          delta: "Final answer.",
        },
      });
    }, 10);
    setTimeout(() => {
      void (
        proc as unknown as {
          handleMessage: (msg: Record<string, unknown>) => void;
        }
      ).handleMessage({
        method: "item/completed",
        params: {
          turnId: "turn-items",
          item: {
            id: "msg-final",
            type: "agent_message",
            content: "Final answer.",
          },
        },
      });
    }, 15);
    setTimeout(() => {
      void (
        proc as unknown as {
          handleMessage: (msg: Record<string, unknown>) => void;
        }
      ).handleMessage({
        method: "turn/completed",
        params: {
          turnId: "turn-items",
          status: "completed",
        },
      });
    }, 20);

    const result = await waitForCodexAppServerTurnCompletion({
      proc,
      turnId: "turn-items",
      onTextDelta: async (delta) => {
        chunks.push(delta);
      },
      onAgentMessageDelta: async (event) => {
        itemDeltas.push(event);
      },
      timeoutMs: 50,
    });

    assert.equal(result, "Final answer.");
    assert.deepEqual(chunks, []);
    assert.deepEqual(itemDeltas, [
      { itemId: "msg-progress", delta: "I'm reading." },
      { itemId: "msg-final", delta: "Final answer." },
    ]);
  });

  it("preserves tool metadata from app-server item events", async function () {
    const proc = createProcess();
    const started: unknown[] = [];
    const completed: unknown[] = [];

    setTimeout(() => {
      void (
        proc as unknown as {
          handleMessage: (msg: Record<string, unknown>) => void;
        }
      ).handleMessage({
        method: "item/started",
        params: {
          turnId: "turn-tool-items",
          item: {
            id: "tool-1",
            type: "mcp_tool_call",
            name: "query_library",
            title: "Query library",
            serverName: "llm_for_zotero",
            arguments: { entity: "items", mode: "list" },
          },
        },
      });
    }, 5);
    setTimeout(() => {
      void (
        proc as unknown as {
          handleMessage: (msg: Record<string, unknown>) => void;
        }
      ).handleMessage({
        method: "item/completed",
        params: {
          turnId: "turn-tool-items",
          item: {
            id: "tool-1",
            type: "mcp_tool_call",
            tool: { name: "query_library" },
            title: "Query library",
            server: { name: "llm_for_zotero" },
            args: { entity: "items", mode: "list" },
            summary: "Found 3 items.",
            error: { message: "Tool failed after review denial." },
          },
        },
      });
    }, 10);
    setTimeout(() => {
      void (
        proc as unknown as {
          handleMessage: (msg: Record<string, unknown>) => void;
        }
      ).handleMessage({
        method: "turn/completed",
        params: {
          turnId: "turn-tool-items",
          status: "completed",
        },
      });
    }, 15);

    await waitForCodexAppServerTurnCompletion({
      proc,
      turnId: "turn-tool-items",
      onItemStarted: async (event) => {
        started.push(event);
      },
      onItemCompleted: async (event) => {
        completed.push(event);
      },
      timeoutMs: 50,
    });

    assert.deepInclude(started[0] as Record<string, unknown>, {
      id: "tool-1",
      type: "mcp_tool_call",
      name: "query_library",
      title: "Query library",
      serverName: "llm_for_zotero",
    });
    assert.deepEqual((started[0] as { arguments?: unknown }).arguments, {
      entity: "items",
      mode: "list",
    });
    assert.deepInclude(completed[0] as Record<string, unknown>, {
      id: "tool-1",
      type: "mcp_tool_call",
      toolName: "query_library",
      title: "Query library",
      serverName: "llm_for_zotero",
      summary: "Found 3 items.",
      error: "Tool failed after review denial.",
    });
    assert.deepEqual((completed[0] as { arguments?: unknown }).arguments, {
      entity: "items",
      mode: "list",
    });
    assert.deepInclude(
      (completed[0] as { raw?: Record<string, unknown> }).raw || {},
      {
        title: "Query library",
      },
    );
  });

  it("emits token usage updates for the active turn", async function () {
    const proc = createProcess();
    const usage: Array<{
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    }> = [];

    setTimeout(() => {
      void (
        proc as unknown as {
          handleMessage: (msg: Record<string, unknown>) => void;
        }
      ).handleMessage({
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
      void (
        proc as unknown as {
          handleMessage: (msg: Record<string, unknown>) => void;
        }
      ).handleMessage({
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
      void (
        proc as unknown as {
          handleMessage: (msg: Record<string, unknown>) => void;
        }
      ).handleMessage({
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
      void (
        proc as unknown as {
          handleMessage: (msg: Record<string, unknown>) => void;
        }
      ).handleMessage({
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
      void (
        proc as unknown as {
          handleMessage: (msg: Record<string, unknown>) => void;
        }
      ).handleMessage({
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
      void (
        proc as unknown as {
          handleMessage: (msg: Record<string, unknown>) => void;
        }
      ).handleMessage({
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
      void (
        proc as unknown as {
          handleMessage: (msg: Record<string, unknown>) => void;
        }
      ).handleMessage({
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
      void (
        proc as unknown as {
          handleMessage: (msg: Record<string, unknown>) => void;
        }
      ).handleMessage({
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
      void (
        proc as unknown as {
          handleMessage: (msg: Record<string, unknown>) => void;
        }
      ).handleMessage({
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

  it("keeps cached app-server processes separate for different explicit codex paths", async function () {
    const originalSpawn = CodexAppServerProcess.spawn;
    const spawned: CodexAppServerProcess[] = [];
    const seenPaths: Array<string | undefined> = [];
    CodexAppServerProcess.spawn = async (options = {}) => {
      const proc = CodexAppServerProcess.forTest({
        stdin: { write: () => {} },
        kill: () => {},
      });
      spawned.push(proc);
      seenPaths.push(options.codexPath);
      return proc;
    };

    try {
      const first = await getOrCreateCodexAppServerProcess("path-cache", {
        codexPath: "C:\\Tools\\CodexA\\codex.cmd",
      });
      const second = await getOrCreateCodexAppServerProcess("path-cache", {
        codexPath: "C:\\Tools\\CodexA\\codex.cmd",
      });
      const third = await getOrCreateCodexAppServerProcess("path-cache", {
        codexPath: "C:\\Tools\\CodexB\\codex.cmd",
      });

      assert.strictEqual(second, first);
      assert.notStrictEqual(third, first);
      assert.deepEqual(seenPaths, [
        "C:\\Tools\\CodexA\\codex.cmd",
        "C:\\Tools\\CodexB\\codex.cmd",
      ]);
      assert.lengthOf(spawned, 2);
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      destroyCachedCodexAppServerProcess("path-cache", undefined, {
        codexPath: "C:\\Tools\\CodexA\\codex.cmd",
      });
      destroyCachedCodexAppServerProcess("path-cache", undefined, {
        codexPath: "C:\\Tools\\CodexB\\codex.cmd",
      });
    }
  });

  it("uses CODEX_PATH when spawning on Windows", async function () {
    const calls: SubprocessCallOptions[] = [];

    await withRuntimeStubs(
      {
        env: { CODEX_PATH: "C:\\Tools\\Codex\\codex.exe" },
        platform: "windows",
        stubProcessLifecycle: true,
        subprocessCall: createSpawnStub(calls),
      },
      async () => {
        const proc = await CodexAppServerProcess.spawn();
        proc.destroy();
      },
    );

    assert.lengthOf(calls, 1);
    assert.equal(calls[0]?.command, "C:\\Tools\\Codex\\codex.exe");
    assert.deepEqual(calls[0]?.arguments, ["app-server"]);
  });

  it("uses an explicit codex path before environment or PATH lookup", async function () {
    const binary = await resolveCodexBinary("D:\\Portable\\codex.cmd");
    assert.equal(binary, "D:\\Portable\\codex.cmd");
  });

  it("normalizes quoted explicit codex paths", function () {
    assert.equal(
      resolveCodexAppServerBinaryPath('"C:\\nvm4w\\nodejs\\codex.cmd"'),
      "C:\\nvm4w\\nodejs\\codex.cmd",
    );
    assert.equal(
      resolveCodexAppServerBinaryPath("'C:\\nvm4w\\nodejs\\codex.cmd'"),
      "C:\\nvm4w\\nodejs\\codex.cmd",
    );
  });

  it("maps Windows PowerShell and extensionless shims to the cmd shim when present", async function () {
    await withRuntimeStubs(
      {
        ioExists: async (path) => path === "C:\\nvm4w\\nodejs\\codex.cmd",
        platform: "windows",
      },
      async () => {
        assert.equal(
          await resolveCodexBinary("C:\\nvm4w\\nodejs\\codex.ps1"),
          "C:\\nvm4w\\nodejs\\codex.cmd",
        );
        assert.equal(
          await resolveCodexBinary("C:\\nvm4w\\nodejs\\codex"),
          "C:\\nvm4w\\nodejs\\codex.cmd",
        );
      },
    );
  });

  it("can invoke bare codex through the Windows shell", async function () {
    const calls: SubprocessCallOptions[] = [];

    await withRuntimeStubs(
      {
        platform: "windows",
        stubProcessLifecycle: true,
        subprocessCall: createSpawnStub(calls),
      },
      async () => {
        const proc = await CodexAppServerProcess.spawn({ codexPath: "codex" });
        proc.destroy();
      },
    );

    assert.match(calls[0]?.command || "", /c:\\windows\\system32\\cmd\.exe/i);
    assert.deepEqual(calls[0]?.arguments, [
      "/d",
      "/s",
      "/c",
      "codex app-server",
    ]);
  });

  it("bypasses the Windows npm cmd and node shims when the native binary is present", async function () {
    const calls: SubprocessCallOptions[] = [];
    const nativeRoot =
      "C:\\nvm4w\\nodejs\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc";

    await withRuntimeStubs(
      {
        ioExists: async (path) =>
          path === `${nativeRoot}\\codex\\codex.exe` ||
          path === `${nativeRoot}\\path`,
        platform: "windows",
        stubProcessLifecycle: true,
        subprocessCall: createSpawnStub(calls),
      },
      async () => {
        const proc = await CodexAppServerProcess.spawn({
          codexPath: "C:\\nvm4w\\nodejs\\codex.cmd",
        });
        proc.destroy();
      },
    );

    assert.equal(calls[0]?.command, `${nativeRoot}\\codex\\codex.exe`);
    assert.deepEqual(calls[0]?.arguments, ["app-server"]);
    assert.equal(calls[0]?.stderr, "pipe");
    assert.equal(calls[0]?.environment?.CODEX_MANAGED_BY_NPM, "1");
    assert.include(calls[0]?.environment?.PATH || "", `${nativeRoot}\\path`);
    assert.isTrue(calls[0]?.environmentAppend);
  });

  it("includes app-server stderr when the child closes during initialization", async function () {
    let stderrReadCount = 0;
    await withRuntimeStubs(
      {
        env: { CODEX_PATH: "C:\\Tools\\Codex\\codex.cmd" },
        platform: "windows",
        subprocessCall: async () => ({
          stdout: { readString: async () => "" },
          stderr: {
            readString: async () => {
              stderrReadCount += 1;
              return stderrReadCount === 1
                ? "Error: unable to load Codex config\n"
                : "";
            },
          },
          stdin: { write: () => {} },
          kill: () => {},
        }),
      },
      async () => {
        try {
          await CodexAppServerProcess.spawn();
          assert.fail("Expected spawn to fail during initialization");
        } catch (error) {
          assert.include(
            error instanceof Error ? error.message : String(error),
            "unable to load Codex config",
          );
        }
      },
    );
  });

  it("includes the launched command when the child closes without diagnostics", async function () {
    await withRuntimeStubs(
      {
        env: { CODEX_PATH: "C:\\Tools\\Codex\\codex.cmd" },
        platform: "windows",
        subprocessCall: async () => ({
          stdout: { readString: async () => "" },
          stderr: { readString: async () => "" },
          stdin: { write: () => {} },
          kill: () => {},
        }),
      },
      async () => {
        try {
          await CodexAppServerProcess.spawn();
          assert.fail("Expected spawn to fail during initialization");
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          assert.include(message, "with no stderr/stdout diagnostics");
          assert.include(message, "launched:");
          assert.include(message, "C:\\Tools\\Codex\\codex.cmd app-server");
        }
      },
    );
  });

  it("includes non-json stdout diagnostics when the child closes during initialization", async function () {
    let stdoutReadCount = 0;
    await withRuntimeStubs(
      {
        env: { CODEX_PATH: "C:\\Tools\\Codex\\codex.cmd" },
        platform: "windows",
        subprocessCall: async () => ({
          stdout: {
            readString: async () => {
              stdoutReadCount += 1;
              return stdoutReadCount === 1
                ? "Error: app-server startup failed\n"
                : "";
            },
          },
          stdin: { write: () => {} },
          kill: () => {},
        }),
      },
      async () => {
        try {
          await CodexAppServerProcess.spawn();
          assert.fail("Expected spawn to fail during initialization");
        } catch (error) {
          assert.include(
            error instanceof Error ? error.message : String(error),
            "app-server startup failed",
          );
        }
      },
    );
  });

  it("runs explicit Windows exe paths directly even when they contain spaces", async function () {
    const calls: SubprocessCallOptions[] = [];

    await withRuntimeStubs(
      {
        platform: "windows",
        stubProcessLifecycle: true,
        subprocessCall: createSpawnStub(calls),
      },
      async () => {
        const proc = await CodexAppServerProcess.spawn({
          codexPath: "C:\\Program Files\\Codex\\codex.exe",
        });
        proc.destroy();
      },
    );

    assert.equal(calls[0]?.command, "C:\\Program Files\\Codex\\codex.exe");
    assert.deepEqual(calls[0]?.arguments, ["app-server"]);
  });

  it("treats URLs as non-path app-server values", function () {
    assert.isUndefined(
      resolveCodexAppServerBinaryPath(
        "https://chatgpt.com/backend-api/codex/responses",
      ),
    );
    assert.equal(
      resolveCodexAppServerBinaryPath("C:\\nvm4w\\nodejs\\codex.cmd"),
      "C:\\nvm4w\\nodejs\\codex.cmd",
    );
  });

  it("prefers the Windows cmd shim from PATH lookup results", function () {
    assert.equal(
      selectCodexLookupResult(
        "C:\\nvm4w\\nodejs\\codex\r\nC:\\nvm4w\\nodejs\\codex.cmd\r\n",
        "windows",
      ),
      "C:\\nvm4w\\nodejs\\codex.cmd",
    );
  });

  it("preserves PATH order when the first Windows match is a different install than a later cmd", function () {
    assert.equal(
      selectCodexLookupResult(
        "C:\\Tools\\Codex\\codex.exe\r\nC:\\Users\\foo\\AppData\\Roaming\\npm\\codex.cmd\r\n",
        "windows",
      ),
      "C:\\Tools\\Codex\\codex.exe",
    );
  });

  it("finds codex from the Windows nvm4w symlink without relying on PATH", async function () {
    await withRuntimeStubs(
      {
        env: {
          CODEX_PATH: "",
          NVM_HOME: "C:\\nvm4w",
          NVM_SYMLINK: "C:\\nvm4w\\nodejs",
        },
        ioExists: async (path) => path === "C:\\nvm4w\\nodejs\\codex.cmd",
        platform: "windows",
        subprocessUnavailable: true,
      },
      async () => {
        const binary = await resolveCodexBinary();
        assert.equal(binary, "C:\\nvm4w\\nodejs\\codex.cmd");
      },
    );
  });

  it("reads Windows install hints from Services.env when process.env is unavailable", async function () {
    await withRuntimeStubs(
      {
        env: {},
        inheritEnv: false,
        ioExists: async (path) => path === "C:\\nvm4w\\nodejs\\codex.cmd",
        platform: "windows",
        servicesEnvGet: (key) =>
          key === "NVM_SYMLINK" ? "C:\\nvm4w\\nodejs" : undefined,
        subprocessUnavailable: true,
      },
      async () => {
        const binary = await resolveCodexBinary();
        assert.equal(binary, "C:\\nvm4w\\nodejs\\codex.cmd");
      },
    );
  });

  it("fails Windows auto-detect without fabricating C:\\Users\\User when home env vars are missing", async function () {
    const checkedPaths: string[] = [];

    await withRuntimeStubs(
      {
        env: { CODEX_PATH: "" },
        ioExists: async (path) => {
          checkedPaths.push(path);
          return false;
        },
        platform: "windows",
        subprocessUnavailable: true,
      },
      async () => {
        try {
          await resolveCodexBinary();
          assert.fail("Expected Windows codex auto-detect to fail");
        } catch (error) {
          assert.include(
            error instanceof Error ? error.message : String(error),
            "codex binary not found",
          );
        }
        assert.notInclude(checkedPaths.join("\n"), "C:\\Users\\User");
      },
    );
  });

  it("does not probe WSL when Windows auto-detect cannot find native codex", async function () {
    const calls: SubprocessCallOptions[] = [];

    await withRuntimeStubs(
      {
        env: {
          CODEX_PATH: "",
          USERPROFILE: "C:\\Users\\alice",
          APPDATA: "",
          LOCALAPPDATA: "",
          SystemRoot: "C:\\Windows",
        },
        inheritEnv: false,
        ioExists: async (path) => path === "C:\\Windows\\System32\\wsl.exe",
        platform: "windows",
        subprocessCall: async (options) => {
          calls.push(options);
          if (
            options.command === "C:\\Windows\\System32\\cmd.exe" &&
            options.arguments[1] === "where codex"
          ) {
            return {
              stdout: createOneShotReader(""),
              wait: async () => ({ exitCode: 1 }),
            };
          }
          return {
            stdout: createOneShotReader(""),
            wait: async () => ({ exitCode: 1 }),
          };
        },
      },
      async () => {
        try {
          await resolveCodexBinary();
          assert.fail("Expected Windows codex auto-detect to fail");
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          assert.include(message, "codex binary not found");
          assert.include(message, "only native Windows Codex is supported");
          assert.include(message, "WSL Codex is not supported");
        }
      },
    );

    assert.deepEqual(calls, [
      {
        command: "C:\\Windows\\System32\\cmd.exe",
        arguments: ["/c", "where codex"],
      },
    ]);
  });

  it("derives Windows AppData candidates from USERPROFILE when APPDATA / LOCALAPPDATA are missing", async function () {
    await withRuntimeStubs(
      {
        env: {
          CODEX_PATH: "",
          USERPROFILE: "C:\\Users\\alice",
          APPDATA: "",
          LOCALAPPDATA: "",
        },
        inheritEnv: false,
        ioExists: async (path) =>
          path === "C:\\Users\\alice\\AppData\\Roaming\\npm\\codex.cmd",
        platform: "windows",
        subprocessUnavailable: true,
      },
      async () => {
        const binary = await resolveCodexBinary();
        assert.equal(
          binary,
          "C:\\Users\\alice\\AppData\\Roaming\\npm\\codex.cmd",
        );
      },
    );

    await withRuntimeStubs(
      {
        env: {
          CODEX_PATH: "",
          USERPROFILE: "C:\\Users\\alice",
          APPDATA: "",
          LOCALAPPDATA: "",
        },
        inheritEnv: false,
        ioExists: async (path) =>
          path === "C:\\Users\\alice\\AppData\\Local\\Volta\\bin\\codex.cmd",
        platform: "windows",
        subprocessUnavailable: true,
      },
      async () => {
        const binary = await resolveCodexBinary();
        assert.equal(
          binary,
          "C:\\Users\\alice\\AppData\\Local\\Volta\\bin\\codex.cmd",
        );
      },
    );
  });

  it("rejects explicit wsl.exe launchers on Windows", async function () {
    await withRuntimeStubs(
      {
        env: {
          CODEX_PATH: "",
        },
        inheritEnv: false,
        platform: "windows",
        subprocessUnavailable: true,
      },
      async () => {
        for (const codexPath of [
          "wsl.exe",
          "wsl.exe -d Ubuntu-22.04",
          "C:\\Windows\\System32\\wsl.exe",
        ]) {
          try {
            await resolveCodexBinary(codexPath);
            assert.fail(`Expected explicit ${codexPath} path to fail`);
          } catch (error) {
            assert.include(
              error instanceof Error ? error.message : String(error),
              "WSL Codex is not supported on Windows",
            );
          }
        }
      },
    );
  });

  it("rejects an explicit WSL codex path on Windows", async function () {
    await withRuntimeStubs(
      {
        env: {
          CODEX_PATH: "",
        },
        inheritEnv: false,
        platform: "windows",
        subprocessUnavailable: true,
      },
      async () => {
        try {
          await resolveCodexBinary("/home/alice/.local/bin/codex");
          assert.fail("Expected explicit WSL codex path to fail");
        } catch (error) {
          assert.include(
            error instanceof Error ? error.message : String(error),
            "WSL Codex is not supported on Windows",
          );
        }
      },
    );
  });

  it("rejects a WSL CODEX_PATH on Windows", async function () {
    await withRuntimeStubs(
      {
        env: {
          CODEX_PATH: "wsl.exe",
        },
        inheritEnv: false,
        platform: "windows",
        subprocessUnavailable: true,
      },
      async () => {
        try {
          await resolveCodexBinary();
          assert.fail("Expected WSL CODEX_PATH to fail");
        } catch (error) {
          assert.include(
            error instanceof Error ? error.message : String(error),
            "WSL Codex is not supported on Windows",
          );
        }
      },
    );
  });

  it("does not probe WSL when native Windows Codex is available during auto-detect", async function () {
    const calls: SubprocessCallOptions[] = [];

    await withRuntimeStubs(
      {
        env: {
          CODEX_PATH: "",
          USERPROFILE: "C:\\Users\\alice",
          APPDATA: "C:\\Users\\alice\\AppData\\Roaming",
          LOCALAPPDATA: "",
          SystemRoot: "C:\\Windows",
        },
        inheritEnv: false,
        ioExists: async (path) =>
          path === "C:\\Users\\alice\\AppData\\Roaming\\npm\\codex.cmd" ||
          path === "C:\\Windows\\System32\\wsl.exe",
        platform: "windows",
        stubProcessLifecycle: true,
        subprocessCall: async (options) => {
          calls.push(options);
          if (
            options.command === "C:\\Windows\\System32\\cmd.exe" &&
            options.arguments[1] === "where codex"
          ) {
            return {
              stdout: createOneShotReader(""),
              wait: async () => ({ exitCode: 1 }),
            };
          }
          return {
            stdout: { readString: async () => "" },
            stdin: { write: () => {} },
            kill: () => {},
          };
        },
      },
      async () => {
        const proc = await CodexAppServerProcess.spawn();
        proc.destroy();
      },
    );

    assert.deepEqual(calls[0], {
      command: "C:\\Windows\\System32\\cmd.exe",
      arguments: ["/c", "where codex"],
    });
    assert.notInclude(
      calls.map((call) => call.command).join("\n"),
      "C:\\Windows\\System32\\wsl.exe",
    );
  });

  it("falls back to /opt/homebrew/bin/codex on macOS when PATH lookup misses it", async function () {
    const calls: SubprocessCallOptions[] = [];

    await withRuntimeStubs(
      {
        env: {
          HOME: "/Users/alice",
          NVM_DIR: "/Users/alice/.nvm",
          CODEX_PATH: "",
        },
        ioExists: async (path) => path === "/opt/homebrew/bin/codex",
        platform: "macos",
        stubProcessLifecycle: true,
        subprocessCall: async (options) => {
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
      },
      async () => {
        const proc = await CodexAppServerProcess.spawn();
        proc.destroy();
      },
    );

    assert.deepEqual(calls[0], {
      command: "/bin/zsh",
      arguments: ["-c", "which codex"],
    });
    assert.equal(calls[1]?.command, "/opt/homebrew/bin/codex");
    assert.deepEqual(calls[1]?.arguments, ["app-server"]);
    assert.equal(calls[1]?.environmentAppend, true);
    assert.include(calls[1]?.environment?.PATH || "", "/opt/homebrew/bin");
  });

  it("prepends the nvm codex bin directory to PATH when launching on macOS", async function () {
    const calls: SubprocessCallOptions[] = [];
    const codexPath = "/Users/alice/.nvm/versions/node/v24.13.0/bin/codex";
    const codexDir = "/Users/alice/.nvm/versions/node/v24.13.0/bin";

    await withRuntimeStubs(
      {
        env: {
          HOME: "/Users/alice",
          NVM_DIR: "/Users/alice/.nvm",
          CODEX_PATH: "",
          PATH: "/usr/bin:/bin",
        },
        ioExists: async (path) => path === codexPath,
        ioGetChildren: async (path) =>
          path === "/Users/alice/.nvm/versions/node" ? ["v24.13.0"] : [],
        platform: "macos",
        stubProcessLifecycle: true,
        subprocessCall: async (options) => {
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
      },
      async () => {
        const proc = await CodexAppServerProcess.spawn();
        proc.destroy();
      },
    );

    assert.equal(calls[1]?.command, codexPath);
    assert.deepEqual(calls[1]?.arguments, ["app-server"]);
    assert.equal(calls[1]?.environmentAppend, true);
    assert.match(
      calls[1]?.environment?.PATH || "",
      new RegExp(`^${codexDir}:`),
    );
  });

  it("finds codex in an npm prefix bin without relying on PATH", async function () {
    await withRuntimeStubs(
      {
        env: {
          HOME: "/Users/alice",
          NPM_CONFIG_PREFIX: "/Users/alice/.npm-global",
          CODEX_PATH: "",
        },
        ioExists: async (path) => path === "/Users/alice/.npm-global/bin/codex",
        ioGetChildren: async () => [],
        platform: "macos",
      },
      async () => {
        const binary = await resolveCodexBinary();
        assert.equal(binary, "/Users/alice/.npm-global/bin/codex");
      },
    );
  });

  it("finds codex in common Volta fallback locations", async function () {
    await withRuntimeStubs(
      {
        env: {
          HOME: "/Users/alice",
          CODEX_PATH: "",
        },
        ioExists: async (path) => path === "/Users/alice/.volta/bin/codex",
        ioGetChildren: async () => [],
        platform: "macos",
      },
      async () => {
        const binary = await resolveCodexBinary();
        assert.equal(binary, "/Users/alice/.volta/bin/codex");
      },
    );
  });

  it("prefers the newest nvm-installed codex binary", async function () {
    await withRuntimeStubs(
      {
        ioGetChildren: async (path) =>
          path === "/Users/alice/.nvm/versions/node"
            ? ["v20.18.0", "v22.2.0"]
            : [],
      },
      async () => {
        const candidates = await listNvmCodexCandidates({
          homeDir: "/Users/alice",
          nvmDir: "/Users/alice/.nvm",
          separator: "/",
        });
        assert.deepEqual(candidates, [
          "/Users/alice/.nvm/versions/node/v22.2.0/bin/codex",
          "/Users/alice/.nvm/versions/node/v20.18.0/bin/codex",
        ]);
      },
    );
  });

  it("falls back to the cargo install path when no other candidate exists", async function () {
    await withRuntimeStubs(
      {
        env: {
          HOME: "/Users/alice",
          CODEX_PATH: "",
        },
        ioExists: async (path) => path === "/Users/alice/.cargo/bin/codex",
        ioGetChildren: async () => [],
        platform: "macos",
      },
      async () => {
        const binary = await resolveCodexBinary();
        assert.equal(binary, "/Users/alice/.cargo/bin/codex");
      },
    );
  });
});
