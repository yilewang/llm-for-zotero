import { assert } from "chai";
import { runCodexAppServerNativeTurn } from "../src/codexAppServer/nativeClient";
import { destroyCachedCodexAppServerProcess } from "../src/utils/codexAppServerProcess";

describe("Codex app-server native client", function () {
  const originalChromeUtils = (globalThis as typeof globalThis & {
    ChromeUtils?: unknown;
  }).ChromeUtils;
  const originalCodexPath = globalThis.process?.env?.CODEX_PATH;
  const originalZotero = globalThis.Zotero;

  class MockStdout {
    private pending: Array<(value: string) => void> = [];
    private queue: string[] = [];

    readString(): Promise<string> {
      if (this.queue.length) {
        return Promise.resolve(this.queue.shift() || "");
      }
      return new Promise((resolve) => {
        this.pending.push(resolve);
      });
    }

    push(value: string) {
      const next = this.pending.shift();
      if (next) {
        next(value);
        return;
      }
      this.queue.push(value);
    }
  }

  afterEach(function () {
    if (globalThis.process?.env) {
      if (typeof originalCodexPath === "string") {
        globalThis.process.env.CODEX_PATH = originalCodexPath;
      } else {
        delete globalThis.process.env.CODEX_PATH;
      }
    }
    (
      globalThis as typeof globalThis & { ChromeUtils?: unknown }
    ).ChromeUtils = originalChromeUtils;
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
    destroyCachedCodexAppServerProcess("native-client-test");
    destroyCachedCodexAppServerProcess("native-client-resume-test");
  });

  it("starts persistent native threads and injects legacy UI history once", async function () {
    const stdout = new MockStdout();
    const methods: string[] = [];
    let threadStartParams: Record<string, unknown> | null = null;
    let injectedItems: unknown = null;
    let turnInput: unknown = null;
    let persistedThreadId = "";

    if (globalThis.process?.env) {
      globalThis.process.env.CODEX_PATH = "/mock/codex";
    }
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      ...(originalZotero || {}),
      isWin: true,
    } as typeof Zotero;
    (
      globalThis as typeof globalThis & {
        ChromeUtils?: {
          importESModule: (
            path: string,
          ) => { Subprocess: { call: () => Promise<unknown> } };
        };
      }
    ).ChromeUtils = {
      importESModule: () => ({
        Subprocess: {
          call: async () => ({
            stdout,
            stdin: {
              write: (chunk: string) => {
                for (const line of chunk.split("\n")) {
                  if (!line.trim()) continue;
                  const message = JSON.parse(line) as {
                    id?: number;
                    method?: string;
                    params?: Record<string, unknown> & { input?: unknown };
                  };
                  if (!message.method || message.method === "initialized") {
                    continue;
                  }
                  methods.push(message.method);
                  if (message.method === "initialize") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: {} })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "thread/start") {
                    threadStartParams = message.params || null;
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { thread: { id: "thread-native-1" } } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "thread/inject_items") {
                    injectedItems = message.params?.items ?? null;
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: {} })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "turn/start") {
                    turnInput = message.params?.input ?? null;
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { turn: { id: "turn-1" } } })}\n`,
                    );
                    queueMicrotask(() => {
                      stdout.push(
                        `${JSON.stringify({ method: "item/agentMessage/delta", params: { turnId: "turn-1", delta: "Hello native" } })}\n`,
                      );
                      stdout.push(
                        `${JSON.stringify({ method: "turn/completed", params: { turnId: "turn-1", status: "completed" } })}\n`,
                      );
                    });
                  }
                }
              },
            },
            kill: () => undefined,
          }),
        },
      }),
    };

    const result = await runCodexAppServerNativeTurn({
      processKey: "native-client-test",
      codexPath: "/mock/codex",
      scope: {
        conversationKey: 6_000_000_001,
        libraryID: 1,
        kind: "global",
        title: "Latest question",
      },
      model: "gpt-5.4",
      messages: [
        { role: "system", content: "Document Context:\nImportant paper context." },
        { role: "user", content: "Earlier question." },
        { role: "assistant", content: "Earlier answer." },
        { role: "user", content: "Latest question." },
      ],
      hooks: {
        loadProviderSessionId: async () => undefined,
        persistProviderSessionId: async (threadId) => {
          persistedThreadId = threadId;
        },
      },
    });

    assert.equal(result.text, "Hello native");
    assert.equal(result.threadId, "thread-native-1");
    assert.equal(persistedThreadId, "thread-native-1");
    assert.includeMembers(methods, [
      "initialize",
      "thread/start",
      "thread/inject_items",
      "turn/start",
    ]);
    assert.equal(threadStartParams?.ephemeral, false);
    assert.equal(threadStartParams?.serviceName, "llm_for_zotero");
    assert.notProperty(threadStartParams || {}, "dynamicTools");
    assert.isUndefined(threadStartParams?.developerInstructions);
    assert.deepEqual(injectedItems, [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Earlier question." }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Earlier answer." }],
      },
    ]);
    assert.isArray(turnInput);
    const textInput = (turnInput as Array<Record<string, unknown>>).find(
      (part) => part.type === "text",
    );
    assert.include(String(textInput?.text || ""), "Zotero context for this turn");
    assert.include(String(textInput?.text || ""), "Important paper context.");
    assert.include(String(textInput?.text || ""), "Latest question.");
  });

  it("resumes stored native threads without reinjecting mirrored history", async function () {
    const stdout = new MockStdout();
    const methods: string[] = [];
    let resumeParams: Record<string, unknown> | null = null;
    let turnInput: unknown = null;
    let injectCalled = false;

    if (globalThis.process?.env) {
      globalThis.process.env.CODEX_PATH = "/mock/codex";
    }
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      ...(originalZotero || {}),
      isWin: true,
    } as typeof Zotero;
    (
      globalThis as typeof globalThis & {
        ChromeUtils?: {
          importESModule: (
            path: string,
          ) => { Subprocess: { call: () => Promise<unknown> } };
        };
      }
    ).ChromeUtils = {
      importESModule: () => ({
        Subprocess: {
          call: async () => ({
            stdout,
            stdin: {
              write: (chunk: string) => {
                for (const line of chunk.split("\n")) {
                  if (!line.trim()) continue;
                  const message = JSON.parse(line) as {
                    id?: number;
                    method?: string;
                    params?: Record<string, unknown> & { input?: unknown };
                  };
                  if (!message.method || message.method === "initialized") {
                    continue;
                  }
                  methods.push(message.method);
                  if (message.method === "initialize") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: {} })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "thread/resume") {
                    resumeParams = message.params || null;
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { thread: { id: "thread-native-1" } } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "thread/inject_items") {
                    injectCalled = true;
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: {} })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "turn/start") {
                    turnInput = message.params?.input ?? null;
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { turn: { id: "turn-2" } } })}\n`,
                    );
                    queueMicrotask(() => {
                      stdout.push(
                        `${JSON.stringify({ method: "item/agentMessage/delta", params: { turnId: "turn-2", delta: "Resumed" } })}\n`,
                      );
                      stdout.push(
                        `${JSON.stringify({ method: "turn/completed", params: { turnId: "turn-2", status: "completed" } })}\n`,
                      );
                    });
                  }
                }
              },
            },
            kill: () => undefined,
          }),
        },
      }),
    };

    const result = await runCodexAppServerNativeTurn({
      processKey: "native-client-resume-test",
      codexPath: "/mock/codex",
      scope: {
        conversationKey: 6_000_000_001,
        libraryID: 1,
        kind: "global",
      },
      model: "gpt-5.4",
      messages: [
        { role: "system", content: "Document Context:\nFresh context." },
        { role: "user", content: "Earlier question." },
        { role: "assistant", content: "Earlier answer." },
        { role: "user", content: "Follow-up question." },
      ],
      hooks: {
        loadProviderSessionId: async () => "thread-native-1",
        persistProviderSessionId: async () => {
          assert.fail("resume should not persist a new thread id");
        },
      },
    });

    assert.equal(result.text, "Resumed");
    assert.equal(result.resumed, true);
    assert.deepEqual(resumeParams, {
      threadId: "thread-native-1",
      model: "gpt-5.4",
      serviceName: "llm_for_zotero",
    });
    assert.includeMembers(methods, ["initialize", "thread/resume", "turn/start"]);
    assert.notInclude(methods, "thread/start");
    assert.isFalse(injectCalled);
    const textInput = (turnInput as Array<Record<string, unknown>>).find(
      (part) => part.type === "text",
    );
    const text = String(textInput?.text || "");
    assert.include(text, "Fresh context.");
    assert.include(text, "Follow-up question.");
    assert.notInclude(text, "Earlier question.");
  });
});
