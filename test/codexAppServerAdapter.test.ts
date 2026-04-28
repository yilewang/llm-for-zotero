import { assert } from "chai";
import {
  CodexAppServerAdapter,
  shouldResetCodexAppServerThreadOnError,
} from "../src/agent/model/codexAppServer";
import type { AgentRuntimeRequest } from "../src/agent/types";
import { destroyCachedCodexAppServerProcess } from "../src/utils/codexAppServerProcess";

class MockStdout {
  private queue: string[] = [];
  private resolvers: Array<(chunk: string) => void> = [];

  readString(): Promise<string> {
    if (this.queue.length) {
      return Promise.resolve(this.queue.shift() || "");
    }
    return new Promise((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  push(chunk: string): void {
    const resolve = this.resolvers.shift();
    if (resolve) {
      resolve(chunk);
      return;
    }
    this.queue.push(chunk);
  }
}

describe("CodexAppServerAdapter", function () {
  function makeRequest(
    overrides: Partial<AgentRuntimeRequest> = {},
  ): AgentRuntimeRequest {
    return {
      conversationKey: 1,
      mode: "agent",
      userText: "test",
      model: "gpt-5.4",
      apiBase: "https://chatgpt.com/backend-api/codex/responses",
      authMode: "codex_app_server",
      ...overrides,
    };
  }

  it("advertises tool-calling support for agent runtime requests", function () {
    const adapter = new CodexAppServerAdapter("codex_app_server");
    const request = makeRequest();

    assert.isTrue(adapter.supportsTools(request));
    assert.isTrue(adapter.getCapabilities(request).toolCalls);
  });

  it("advertises multimodal support for non-text-only models", function () {
    const adapter = new CodexAppServerAdapter("codex_app_server");
    const request = makeRequest();

    assert.isTrue(adapter.getCapabilities(request).multimodal);
    assert.isTrue(adapter.getCapabilities(request).reasoning);
  });

  it("keeps thread state for recoverable adapter errors", function () {
    assert.isFalse(
      shouldResetCodexAppServerThreadOnError(
        new Error("Turn ended with status: failed"),
      ),
    );
  });

  it("resets thread state when the app-server session becomes unusable", function () {
    const abortError = new Error("Aborted");
    (abortError as Error & { name?: string }).name = "AbortError";
    assert.isTrue(shouldResetCodexAppServerThreadOnError(abortError));
    assert.isTrue(
      shouldResetCodexAppServerThreadOnError(
        new Error(
          "Timed out waiting for codex app-server turn completion after 60000ms",
        ),
      ),
    );
    assert.isTrue(
      shouldResetCodexAppServerThreadOnError(
        new Error("codex app-server process closed unexpectedly"),
      ),
    );
  });

  it("injects seeded history on the first turn and sends only live user input later", async function () {
    const originalChromeUtils = (
      globalThis as typeof globalThis & {
        ChromeUtils?: unknown;
      }
    ).ChromeUtils;
    const originalCodexPath = globalThis.process?.env?.CODEX_PATH;
    const stdout = new MockStdout();
    const processKey = "codex_app_server_seeded_history_test";
    let threadStartCount = 0;
    let injectCount = 0;
    const turnInputs: unknown[] = [];
    let injectedItems: unknown = null;
    let threadStartParams: Record<string, unknown> | null = null;

    try {
      if (globalThis.process?.env) {
        globalThis.process.env.CODEX_PATH = "/mock/codex";
      }

      (
        globalThis as typeof globalThis & {
          ChromeUtils?: {
            importESModule: (path: string) => {
              Subprocess: { call: () => Promise<unknown> };
            };
          };
        }
      ).ChromeUtils = {
        importESModule: (path: string) => {
          assert.include(path, "Subprocess");
          return {
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
                        params?: {
                          input?: unknown;
                          items?: unknown;
                          developerInstructions?: unknown;
                        };
                      };
                      if (message.method === "initialize") {
                        stdout.push(
                          `${JSON.stringify({ id: message.id, result: {} })}\n`,
                        );
                        continue;
                      }
                      if (message.method === "thread/start") {
                        threadStartCount += 1;
                        threadStartParams = message.params as Record<
                          string,
                          unknown
                        >;
                        stdout.push(
                          `${JSON.stringify({ id: message.id, result: { id: "thread-1" } })}\n`,
                        );
                        continue;
                      }
                      if (message.method === "thread/inject_items") {
                        injectCount += 1;
                        injectedItems = message.params?.items ?? null;
                        stdout.push(
                          `${JSON.stringify({ id: message.id, result: {} })}\n`,
                        );
                        continue;
                      }
                      if (message.method === "turn/start") {
                        turnInputs.push(message.params?.input ?? null);
                        const turnId = `turn-${turnInputs.length}`;
                        stdout.push(
                          `${JSON.stringify({ id: message.id, result: { id: turnId } })}\n`,
                        );
                        setTimeout(() => {
                          stdout.push(
                            `${JSON.stringify({ method: "item/agentMessage/delta", params: { turnId, delta: turnInputs.length === 1 ? "First." : "Second." } })}\n`,
                          );
                          stdout.push(
                            `${JSON.stringify({ method: "turn/completed", params: { turnId, status: "completed" } })}\n`,
                          );
                        }, 0);
                      }
                    }
                  },
                },
                kill: () => undefined,
              }),
            },
          };
        },
      };

      const adapter = new CodexAppServerAdapter(processKey);
      const first = await adapter.runStep({
        request: makeRequest(),
        messages: [
          {
            role: "system",
            content: "Follow Zotero-specific tool guidance.",
          },
          {
            role: "assistant",
            content: "I can inspect your library.",
          },
          {
            role: "user",
            content: "Summarize this note.",
          },
        ],
        tools: [],
      });
      const second = await adapter.runStep({
        request: makeRequest(),
        messages: [
          {
            role: "system",
            content: "Follow Zotero-specific tool guidance.",
          },
          {
            role: "assistant",
            content: "I can inspect your library.",
          },
          {
            role: "user",
            content: "Summarize this note.",
          },
          {
            role: "assistant",
            content: "First.",
          },
          {
            role: "user",
            content: "Focus on action items.",
          },
        ],
        tools: [],
      });

      assert.equal(first.kind, "final");
      assert.equal(second.kind, "final");
      assert.equal(threadStartCount, 1);
      assert.equal(
        threadStartParams?.developerInstructions,
        "Follow Zotero-specific tool guidance.",
      );
      assert.equal(injectCount, 1);
      assert.deepEqual(injectedItems, [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "I can inspect your library.",
            },
          ],
        },
      ]);
      assert.deepEqual(turnInputs[0], [
        {
          type: "text",
          text: "Summarize this note.",
        },
      ]);
      assert.deepEqual(turnInputs[1], [
        {
          type: "text",
          text: "Focus on action items.",
        },
      ]);
    } finally {
      destroyCachedCodexAppServerProcess(processKey);
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
    }
  });

  it("falls back to flattened first-turn input when history injection is unsupported", async function () {
    const originalChromeUtils = (
      globalThis as typeof globalThis & {
        ChromeUtils?: unknown;
      }
    ).ChromeUtils;
    const originalCodexPath = globalThis.process?.env?.CODEX_PATH;
    const originalToolkit = (
      globalThis as typeof globalThis & { ztoolkit?: unknown }
    ).ztoolkit;
    const stdout = new MockStdout();
    const processKey = "codex_app_server_legacy_fallback_test";
    let threadStartCount = 0;
    let injectCount = 0;
    const turnInputs: unknown[] = [];
    let threadStartParams: Record<string, unknown> | null = null;

    try {
      if (globalThis.process?.env) {
        globalThis.process.env.CODEX_PATH = "/mock/codex";
      }
      (
        globalThis as typeof globalThis & {
          ztoolkit?: { log: () => void };
        }
      ).ztoolkit = {
        log: () => undefined,
      };

      (
        globalThis as typeof globalThis & {
          ChromeUtils?: {
            importESModule: (path: string) => {
              Subprocess: { call: () => Promise<unknown> };
            };
          };
        }
      ).ChromeUtils = {
        importESModule: (path: string) => {
          assert.include(path, "Subprocess");
          return {
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
                        params?: {
                          input?: unknown;
                          developerInstructions?: unknown;
                        };
                      };
                      if (message.method === "initialize") {
                        stdout.push(
                          `${JSON.stringify({ id: message.id, result: {} })}\n`,
                        );
                        continue;
                      }
                      if (message.method === "thread/start") {
                        threadStartCount += 1;
                        threadStartParams = message.params as Record<
                          string,
                          unknown
                        >;
                        stdout.push(
                          `${JSON.stringify({ id: message.id, result: { id: "thread-1" } })}\n`,
                        );
                        continue;
                      }
                      if (message.method === "thread/inject_items") {
                        injectCount += 1;
                        stdout.push(
                          `${JSON.stringify({
                            id: message.id,
                            error: {
                              code: -32601,
                              message:
                                "Invalid request: unknown variant `thread/inject_items`, expected one of initialize, thread/start",
                            },
                          })}\n`,
                        );
                        continue;
                      }
                      if (message.method === "turn/start") {
                        turnInputs.push(message.params?.input ?? null);
                        const turnId = `turn-${turnInputs.length}`;
                        stdout.push(
                          `${JSON.stringify({ id: message.id, result: { id: turnId } })}\n`,
                        );
                        setTimeout(() => {
                          stdout.push(
                            `${JSON.stringify({ method: "item/agentMessage/delta", params: { turnId, delta: turnInputs.length === 1 ? "First." : "Second." } })}\n`,
                          );
                          stdout.push(
                            `${JSON.stringify({ method: "turn/completed", params: { turnId, status: "completed" } })}\n`,
                          );
                        }, 0);
                      }
                    }
                  },
                },
                kill: () => undefined,
              }),
            },
          };
        },
      };

      const adapter = new CodexAppServerAdapter(processKey);
      const first = await adapter.runStep({
        request: makeRequest(),
        messages: [
          {
            role: "system",
            content: "Follow Zotero-specific tool guidance.",
          },
          {
            role: "assistant",
            content: "I can inspect your library.",
          },
          {
            role: "user",
            content: "Summarize this note.",
          },
        ],
        tools: [],
      });
      const second = await adapter.runStep({
        request: makeRequest(),
        messages: [
          {
            role: "system",
            content: "Follow Zotero-specific tool guidance.",
          },
          {
            role: "assistant",
            content: "I can inspect your library.",
          },
          {
            role: "user",
            content: "Summarize this note.",
          },
          {
            role: "assistant",
            content: "First.",
          },
          {
            role: "user",
            content: "Focus on action items.",
          },
        ],
        tools: [],
      });

      assert.equal(first.kind, "final");
      assert.equal(second.kind, "final");
      assert.equal(threadStartCount, 1);
      assert.equal(
        threadStartParams?.developerInstructions,
        "Follow Zotero-specific tool guidance.",
      );
      assert.equal(injectCount, 1);
      assert.deepEqual(turnInputs[0], [
        {
          type: "text",
          text: "Assistant:\nI can inspect your library.",
        },
        {
          type: "text",
          text: "User:\nSummarize this note.",
        },
      ]);
      assert.deepEqual(turnInputs[1], [
        {
          type: "text",
          text: "Focus on action items.",
        },
      ]);
    } finally {
      destroyCachedCodexAppServerProcess(processKey);
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
      (globalThis as typeof globalThis & { ztoolkit?: unknown }).ztoolkit =
        originalToolkit;
    }
  });

  it("preserves the system prompt in flattened input when developer instructions are unsupported", async function () {
    const originalChromeUtils = (
      globalThis as typeof globalThis & {
        ChromeUtils?: unknown;
      }
    ).ChromeUtils;
    const originalCodexPath = globalThis.process?.env?.CODEX_PATH;
    const originalToolkit = (
      globalThis as typeof globalThis & { ztoolkit?: unknown }
    ).ztoolkit;
    const stdout = new MockStdout();
    const processKey = "codex_app_server_developer_instructions_fallback_test";
    let threadStartCount = 0;
    let injectCount = 0;
    const turnInputs: unknown[] = [];

    try {
      if (globalThis.process?.env) {
        globalThis.process.env.CODEX_PATH = "/mock/codex";
      }
      (
        globalThis as typeof globalThis & {
          ztoolkit?: { log: () => void };
        }
      ).ztoolkit = {
        log: () => undefined,
      };

      (
        globalThis as typeof globalThis & {
          ChromeUtils?: {
            importESModule: (path: string) => {
              Subprocess: { call: () => Promise<unknown> };
            };
          };
        }
      ).ChromeUtils = {
        importESModule: (path: string) => {
          assert.include(path, "Subprocess");
          return {
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
                        params?: {
                          input?: unknown;
                          developerInstructions?: unknown;
                        };
                      };
                      if (message.method === "initialize") {
                        stdout.push(
                          `${JSON.stringify({ id: message.id, result: {} })}\n`,
                        );
                        continue;
                      }
                      if (message.method === "thread/start") {
                        threadStartCount += 1;
                        if (message.params?.developerInstructions) {
                          stdout.push(
                            `${JSON.stringify({
                              id: message.id,
                              error: {
                                code: -32602,
                                message:
                                  "Invalid params: unknown field `developerInstructions`, expected one of model, approvalPolicy",
                              },
                            })}\n`,
                          );
                        } else {
                          stdout.push(
                            `${JSON.stringify({ id: message.id, result: { id: "thread-1" } })}\n`,
                          );
                        }
                        continue;
                      }
                      if (message.method === "thread/inject_items") {
                        injectCount += 1;
                        stdout.push(
                          `${JSON.stringify({ id: message.id, result: {} })}\n`,
                        );
                        continue;
                      }
                      if (message.method === "turn/start") {
                        turnInputs.push(message.params?.input ?? null);
                        stdout.push(
                          `${JSON.stringify({ id: message.id, result: { id: "turn-1" } })}\n`,
                        );
                        setTimeout(() => {
                          stdout.push(
                            `${JSON.stringify({ method: "item/agentMessage/delta", params: { turnId: "turn-1", delta: "Done." } })}\n`,
                          );
                          stdout.push(
                            `${JSON.stringify({ method: "turn/completed", params: { turnId: "turn-1", status: "completed" } })}\n`,
                          );
                        }, 0);
                      }
                    }
                  },
                },
                kill: () => undefined,
              }),
            },
          };
        },
      };

      const adapter = new CodexAppServerAdapter(processKey);
      const step = await adapter.runStep({
        request: makeRequest(),
        messages: [
          {
            role: "system",
            content: "Follow Zotero-specific tool guidance.",
          },
          {
            role: "assistant",
            content: "I can inspect your library.",
          },
          {
            role: "user",
            content: "Summarize this note.",
          },
        ],
        tools: [],
      });

      assert.equal(step.kind, "final");
      assert.equal(threadStartCount, 2);
      assert.equal(injectCount, 0);
      assert.deepEqual(turnInputs[0], [
        {
          type: "text",
          text: "System:\nFollow Zotero-specific tool guidance.",
        },
        {
          type: "text",
          text: "Assistant:\nI can inspect your library.",
        },
        {
          type: "text",
          text: "User:\nSummarize this note.",
        },
      ]);
    } finally {
      destroyCachedCodexAppServerProcess(processKey);
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
      (globalThis as typeof globalThis & { ztoolkit?: unknown }).ztoolkit =
        originalToolkit;
    }
  });

  it("resets thread state when the resolved codex path changes between runs", async function () {
    const originalChromeUtils = (
      globalThis as typeof globalThis & { ChromeUtils?: unknown }
    ).ChromeUtils;
    const originalCodexPath = globalThis.process?.env?.CODEX_PATH;
    const processKey = "codex_app_server_codex_path_change_test";
    const codexPathA = "/mock/codex/a";
    const codexPathB = "/mock/codex/b";

    type SpawnRecord = {
      command: string;
      arguments: string[];
      stdout: MockStdout;
      threadStartCount: number;
    };
    const spawns: SpawnRecord[] = [];

    try {
      if (globalThis.process?.env) {
        delete globalThis.process.env.CODEX_PATH;
      }

      (
        globalThis as typeof globalThis & {
          ChromeUtils?: {
            importESModule: (path: string) => {
              Subprocess: {
                call: (options: {
                  command: string;
                  arguments: string[];
                }) => Promise<unknown>;
              };
            };
          };
        }
      ).ChromeUtils = {
        importESModule: (path: string) => {
          assert.include(path, "Subprocess");
          return {
            Subprocess: {
              call: async (options: {
                command: string;
                arguments: string[];
                }) => {
                  const record: SpawnRecord = {
                    command: options.command,
                    arguments: options.arguments,
                    stdout: new MockStdout(),
                    threadStartCount: 0,
                  };
                spawns.push(record);
                return {
                  stdout: record.stdout,
                  stdin: {
                    write: (chunk: string) => {
                      for (const line of chunk.split("\n")) {
                        if (!line.trim()) continue;
                        const message = JSON.parse(line) as {
                          id?: number;
                          method?: string;
                        };
                        if (message.method === "initialize") {
                          record.stdout.push(
                            `${JSON.stringify({ id: message.id, result: {} })}\n`,
                          );
                          continue;
                        }
                        if (message.method === "thread/start") {
                          record.threadStartCount += 1;
                          record.stdout.push(
                            `${JSON.stringify({
                              id: message.id,
                              result: { id: `thread-${spawns.length}` },
                            })}\n`,
                          );
                          continue;
                        }
                        if (message.method === "turn/start") {
                          const turnId = `turn-${spawns.length}`;
                          record.stdout.push(
                            `${JSON.stringify({
                              id: message.id,
                              result: { id: turnId },
                            })}\n`,
                          );
                          setTimeout(() => {
                            record.stdout.push(
                              `${JSON.stringify({ method: "item/agentMessage/delta", params: { turnId, delta: "OK." } })}\n`,
                            );
                            record.stdout.push(
                              `${JSON.stringify({ method: "turn/completed", params: { turnId, status: "completed" } })}\n`,
                            );
                          }, 0);
                        }
                      }
                    },
                  },
                  kill: () => undefined,
                };
              },
            },
          };
        },
      };

      const adapter = new CodexAppServerAdapter(processKey);

      const first = await adapter.runStep({
        request: {
          conversationKey: 1,
          mode: "agent",
          userText: "test",
          model: "gpt-5.4",
          apiBase: codexPathA,
          authMode: "codex_app_server",
        },
        messages: [{ role: "user", content: "First." }],
        tools: [],
      });
      const second = await adapter.runStep({
        request: {
          conversationKey: 1,
          mode: "agent",
          userText: "test",
          model: "gpt-5.4",
          apiBase: codexPathB,
          authMode: "codex_app_server",
        },
        messages: [{ role: "user", content: "Second." }],
        tools: [],
      });

      assert.equal(first.kind, "final");
      assert.equal(second.kind, "final");
      assert.lengthOf(spawns, 2, "expected a fresh spawn per codex path");
      assert.include(
        spawns[0]?.arguments.at(-1) ?? "",
        codexPathA,
        "first launch should target the first codex path",
      );
      assert.include(
        spawns[1]?.arguments.at(-1) ?? "",
        codexPathB,
        "second launch should target the second codex path",
      );
      assert.equal(spawns[0]?.threadStartCount, 1);
      assert.equal(
        spawns[1]?.threadStartCount,
        1,
        "second runStep with a different codex path should start a new thread",
      );
    } finally {
      destroyCachedCodexAppServerProcess(processKey, undefined, {
        codexPath: codexPathA,
      });
      destroyCachedCodexAppServerProcess(processKey, undefined, {
        codexPath: codexPathB,
      });
      if (globalThis.process?.env) {
        if (typeof originalCodexPath === "string") {
          globalThis.process.env.CODEX_PATH = originalCodexPath;
        }
      }
      (
        globalThis as typeof globalThis & { ChromeUtils?: unknown }
      ).ChromeUtils = originalChromeUtils;
    }
  });

  it("forwards app-server reasoning events into the shared reasoning callback", async function () {
    const originalChromeUtils = (
      globalThis as typeof globalThis & {
        ChromeUtils?: unknown;
      }
    ).ChromeUtils;
    const originalCodexPath = globalThis.process?.env?.CODEX_PATH;
    const stdout = new MockStdout();
    const processKey = "codex_app_server_reasoning_test";

    try {
      if (globalThis.process?.env) {
        globalThis.process.env.CODEX_PATH = "/mock/codex";
      }

      (
        globalThis as typeof globalThis & {
          ChromeUtils?: {
            importESModule: (path: string) => {
              Subprocess: { call: () => Promise<unknown> };
            };
          };
        }
      ).ChromeUtils = {
        importESModule: (path: string) => {
          assert.include(path, "Subprocess");
          return {
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
                      };
                      if (message.method === "initialize") {
                        stdout.push(
                          `${JSON.stringify({ id: message.id, result: {} })}\n`,
                        );
                        continue;
                      }
                      if (message.method === "thread/start") {
                        stdout.push(
                          `${JSON.stringify({ id: message.id, result: { id: "thread-1" } })}\n`,
                        );
                        continue;
                      }
                      if (message.method === "turn/start") {
                        stdout.push(
                          `${JSON.stringify({ id: message.id, result: { id: "turn-1" } })}\n`,
                        );
                        setTimeout(() => {
                          stdout.push(
                            `${JSON.stringify({ method: "item/reasoning/summaryTextDelta", params: { itemId: "reasoning-1", delta: "Reviewing the request." } })}\n`,
                          );
                          stdout.push(
                            `${JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "Done." } })}\n`,
                          );
                          stdout.push(
                            `${JSON.stringify({ method: "turn/completed", params: { turnId: "turn-1", status: "completed" } })}\n`,
                          );
                        }, 0);
                      }
                    }
                  },
                },
                kill: () => undefined,
              }),
            },
          };
        },
      };

      const adapter = new CodexAppServerAdapter(processKey);
      const reasoning: string[] = [];
      const chunks: string[] = [];
      const step = await adapter.runStep({
        request: makeRequest(),
        messages: [{ role: "user", content: "Summarize this note." }],
        tools: [],
        onTextDelta: async (delta) => {
          chunks.push(delta);
        },
        onReasoning: async (event) => {
          if (event.summary) {
            reasoning.push(event.summary);
          }
        },
      });

      assert.equal(step.kind, "final");
      assert.equal(step.text, "Done.");
      assert.deepEqual(chunks, ["Done."]);
      assert.deepEqual(reasoning, ["Reviewing the request."]);
    } finally {
      destroyCachedCodexAppServerProcess(processKey);
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
    }
  });

  it("forwards app-server token deltas into the shared usage callback", async function () {
    const originalChromeUtils = (
      globalThis as typeof globalThis & {
        ChromeUtils?: unknown;
      }
    ).ChromeUtils;
    const originalCodexPath = globalThis.process?.env?.CODEX_PATH;
    const stdout = new MockStdout();
    const processKey = "codex_app_server_usage_test";

    try {
      if (globalThis.process?.env) {
        globalThis.process.env.CODEX_PATH = "/mock/codex";
      }

      (
        globalThis as typeof globalThis & {
          ChromeUtils?: {
            importESModule: (path: string) => {
              Subprocess: { call: () => Promise<unknown> };
            };
          };
        }
      ).ChromeUtils = {
        importESModule: (path: string) => {
          assert.include(path, "Subprocess");
          return {
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
                      };
                      if (message.method === "initialize") {
                        stdout.push(
                          `${JSON.stringify({ id: message.id, result: {} })}\n`,
                        );
                        continue;
                      }
                      if (message.method === "thread/start") {
                        stdout.push(
                          `${JSON.stringify({ id: message.id, result: { id: "thread-1" } })}\n`,
                        );
                        continue;
                      }
                      if (message.method === "turn/start") {
                        stdout.push(
                          `${JSON.stringify({ id: message.id, result: { id: "turn-1" } })}\n`,
                        );
                        setTimeout(() => {
                          stdout.push(
                            `${JSON.stringify({ method: "thread/tokenUsage/updated", params: { tokenUsage: { last: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } } } })}\n`,
                          );
                          stdout.push(
                            `${JSON.stringify({ method: "thread/tokenUsage/updated", params: { tokenUsage: { last: { inputTokens: 10, outputTokens: 6, totalTokens: 16 } } } })}\n`,
                          );
                          stdout.push(
                            `${JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "Done." } })}\n`,
                          );
                          stdout.push(
                            `${JSON.stringify({ method: "turn/completed", params: { turnId: "turn-1", status: "completed" } })}\n`,
                          );
                        }, 0);
                      }
                    }
                  },
                },
                kill: () => undefined,
              }),
            },
          };
        },
      };

      const adapter = new CodexAppServerAdapter(processKey);
      const usage: Array<{
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
      }> = [];
      const step = await adapter.runStep({
        request: makeRequest(),
        messages: [{ role: "user", content: "Summarize this note." }],
        tools: [],
        onUsage: async (event) => {
          usage.push(event);
        },
      });

      assert.equal(step.kind, "final");
      assert.equal(step.text, "Done.");
      assert.deepEqual(usage, [
        {
          promptTokens: 10,
          completionTokens: 4,
          totalTokens: 14,
        },
        {
          promptTokens: 0,
          completionTokens: 2,
          totalTokens: 2,
        },
      ]);
    } finally {
      destroyCachedCodexAppServerProcess(processKey);
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
    }
  });
});
