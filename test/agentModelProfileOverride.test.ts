import { assert } from "chai";
import { OpenAIChatCompatAgentAdapter } from "../src/agent/model/openaiCompatible";
import { OllamaNativeAgentAdapter } from "../src/agent/model/ollamaNative";
import { AnthropicMessagesAgentAdapter } from "../src/agent/model/anthropicMessages";
import { OpenAIResponsesAgentAdapter } from "../src/agent/model/openaiResponses";
import type { AgentRuntimeRequest, ToolSpec } from "../src/agent/types";
import {
  configureModelCapabilityRuntime,
  refreshModelCatalog,
  resetModelCapabilityStateForTests,
} from "../src/modelCapabilities";

/**
 * Per-model parameter overrides must reach agent runs, not just Paper Chat.
 *
 * Each adapter forwards them through one optional trailing argument to
 * `buildReasoningPayload`. Nothing type-checks its absence, so dropping it in a
 * refactor is silent: chat keeps honouring the user's settings while agent mode
 * quietly ignores them, and the only symptom is "the same model behaves
 * differently in agent mode". These tests make that failure loud.
 */
describe("agent adapters honour model profile overrides", function () {
  const originalToolkit = (
    globalThis as typeof globalThis & { ztoolkit?: unknown }
  ).ztoolkit;
  const originalZotero = globalThis.Zotero;

  const tools: ToolSpec[] = [
    {
      name: "read_paper",
      description: "read paper",
      inputSchema: { type: "object" },
      mutability: "read",
      requiresConfirmation: false,
    },
  ];

  /** Capture the request body an adapter builds, then end the turn cleanly. */
  function captureBody(reply: {
    sse?: string[];
    ndjson?: string[];
    json?: unknown;
  }): { read: () => Record<string, unknown> } {
    let captured: Record<string, unknown> = {};
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown; log: () => void };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name !== "fetch") return undefined;
        return async (_url: string, init?: RequestInit) => {
          captured = JSON.parse(String(init?.body || "{}")) as Record<
            string,
            unknown
          >;
          const lines = reply.sse || reply.ndjson;
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            headers: {
              get: () => (reply.sse ? "text/event-stream" : "application/json"),
            },
            body: lines
              ? new ReadableStream<Uint8Array>({
                  start(controller) {
                    const encoder = new TextEncoder();
                    for (const line of lines)
                      controller.enqueue(encoder.encode(line));
                    controller.close();
                  },
                })
              : undefined,
            json: async () => reply.json ?? {},
            text: async () => "",
          };
        };
      },
      log: () => undefined,
    };
    return { read: () => captured };
  }

  function makeRequest(
    overrides: Partial<AgentRuntimeRequest> = {},
  ): AgentRuntimeRequest {
    return {
      conversationKey: 1,
      mode: "agent",
      userText: "Summarize the paper",
      model: "gpt-4o-mini",
      apiBase: "https://api.openai.com/v1",
      apiKey: "test",
      ...overrides,
    };
  }

  /** Advanced config carrying an extra request parameter the user authored. */
  function advancedWith(
    extraBody: Record<string, unknown>,
    forModel = "gpt-4o-mini",
  ) {
    return {
      temperature: 0.3,
      maxTokens: 4096,
      profileOverride: { forModel, extraBody },
    };
  }

  function advancedWithExplicitOutputLimit() {
    return {
      temperature: 0.3,
      maxTokens: 200_000,
      maxTokensExplicit: true,
      profileOverride: {
        forModel: "claude-haiku-4-5",
        limits: { outputTokens: 100_000 },
      },
    };
  }

  beforeEach(function () {
    const prefStore = new Map<string, unknown>();
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Prefs: {
        get: (key: string) => prefStore.get(key) ?? "",
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      },
    } as typeof Zotero;
  });

  afterEach(function () {
    resetModelCapabilityStateForTests();
    (
      globalThis as typeof globalThis & { ztoolkit?: typeof originalToolkit }
    ).ztoolkit = originalToolkit;
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
  });

  it("openai_chat_compat sends the user's extra parameters", async function () {
    const body = captureBody({
      sse: [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`,
        "data: [DONE]\n\n",
      ],
    });

    await new OpenAIChatCompatAgentAdapter().runStep({
      request: makeRequest({
        apiBase: "https://api.deepseek.com/v1",
        providerProtocol: "openai_chat_compat",
        advanced: advancedWith({ top_k: 40 }),
      }),
      messages: [{ role: "user", content: "Summarize" }],
      tools,
    });

    assert.equal(body.read().top_k, 40);
  });

  it("responses_api sends the user's extra parameters", async function () {
    const body = captureBody({
      json: { output: [{ content: [{ type: "output_text", text: "hi" }] }] },
    });

    await new OpenAIResponsesAgentAdapter().runStep({
      request: makeRequest({
        apiBase: "https://api.openai.com/v1/responses",
        providerProtocol: "responses_api",
        advanced: advancedWith({ top_k: 40 }),
      }),
      messages: [{ role: "user", content: "Summarize" }],
      tools,
    });

    assert.equal(body.read().top_k, 40);
  });

  it("anthropic_messages sends the user's extra parameters", async function () {
    const body = captureBody({
      json: {
        content: [{ type: "text", text: "hi" }],
        stop_reason: "end_turn",
      },
    });

    await new AnthropicMessagesAgentAdapter().runStep({
      request: makeRequest({
        model: "claude-sonnet-4-5",
        apiBase: "https://api.anthropic.com/v1",
        providerProtocol: "anthropic_messages",
        advanced: advancedWith({ top_k: 40 }, "claude-sonnet-4-5"),
      }),
      messages: [{ role: "user", content: "Summarize" }],
      tools,
    });

    assert.equal(body.read().top_k, 40);
  });

  it("openai_chat_compat preserves explicit output above detected limits", async function () {
    const body = captureBody({
      sse: [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`,
        "data: [DONE]\n\n",
      ],
    });

    await new OpenAIChatCompatAgentAdapter().runStep({
      request: makeRequest({
        model: "claude-haiku-4-5",
        advanced: advancedWithExplicitOutputLimit(),
      }),
      messages: [{ role: "user", content: "Summarize" }],
      tools,
    });

    assert.equal(body.read().max_tokens, 200_000);
  });

  it("responses_api preserves explicit output above detected limits", async function () {
    const body = captureBody({
      json: { output: [{ content: [{ type: "output_text", text: "hi" }] }] },
    });

    await new OpenAIResponsesAgentAdapter().runStep({
      request: makeRequest({
        model: "claude-haiku-4-5",
        apiBase: "https://api.openai.com/v1/responses",
        providerProtocol: "responses_api",
        advanced: advancedWithExplicitOutputLimit(),
      }),
      messages: [{ role: "user", content: "Summarize" }],
      tools,
    });

    assert.equal(body.read().max_output_tokens, 200_000);
  });

  it("anthropic_messages preserves explicit output above detected limits", async function () {
    const body = captureBody({
      json: {
        content: [{ type: "text", text: "hi" }],
        stop_reason: "end_turn",
      },
    });

    await new AnthropicMessagesAgentAdapter().runStep({
      request: makeRequest({
        model: "claude-haiku-4-5",
        apiBase: "https://api.anthropic.com/v1",
        providerProtocol: "anthropic_messages",
        advanced: advancedWithExplicitOutputLimit(),
      }),
      messages: [{ role: "user", content: "Summarize" }],
      tools,
    });

    assert.equal(body.read().max_tokens, 200_000);
  });

  it("ollama_native sends the user's extra parameters", async function () {
    const body = captureBody({
      ndjson: ['{"message":{"content":"hi"},"done":true}\n'],
    });

    await new OllamaNativeAgentAdapter().runStep({
      request: makeRequest({
        model: "qwen3:8b",
        apiBase: "http://localhost:11434",
        providerProtocol: "ollama_native",
        advanced: advancedWith({ top_k: 40 }, "qwen3:8b"),
      }),
      messages: [{ role: "user", content: "Summarize" }],
      tools,
    });

    assert.equal(body.read().top_k, 40);
  });

  it("ollama_native merges user options.* without dropping its own", async function () {
    const body = captureBody({
      ndjson: ['{"message":{"content":"hi"},"done":true}\n'],
    });

    await new OllamaNativeAgentAdapter().runStep({
      request: makeRequest({
        model: "qwen3:8b",
        apiBase: "http://localhost:11434",
        providerProtocol: "ollama_native",
        advanced: advancedWith(
          { options: { repeat_penalty: 1.1 } },
          "qwen3:8b",
        ),
      }),
      messages: [{ role: "user", content: "Summarize" }],
      tools,
    });

    const options = body.read().options as Record<string, unknown>;
    assert.equal(options.repeat_penalty, 1.1);
    assert.isNumber(
      options.temperature,
      "a user options.* entry must not replace the adapter's own options",
    );
  });

  it("keeps Ollama final thinking private while replaying it for a live correction", async function () {
    const requestBodies: Record<string, unknown>[] = [];
    let callCount = 0;
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown; log: () => void };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name !== "fetch") return undefined;
        return async (_url: string, init?: RequestInit) => {
          callCount += 1;
          requestBodies.push(
            JSON.parse(String(init?.body || "{}")) as Record<string, unknown>,
          );
          const lines =
            callCount === 1
              ? [
                  '{"message":{"role":"assistant","thinking":"Hidden Ollama plan. "},"done":false}\n',
                  '{"message":{"role":"assistant","content":"Premature answer."},"done":true}\n',
                ]
              : [
                  '{"message":{"role":"assistant","content":"Corrected answer."},"done":true}\n',
                ];
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            headers: { get: () => "application/json" },
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                const encoder = new TextEncoder();
                for (const line of lines)
                  controller.enqueue(encoder.encode(line));
                controller.close();
              },
            }),
            json: async () => ({}),
            text: async () => "",
          };
        };
      },
      log: () => undefined,
    };

    const adapter = new OllamaNativeAgentAdapter();
    const request = makeRequest({
      model: "qwen3:8b",
      apiBase: "http://localhost:11434",
      providerProtocol: "ollama_native",
    });
    const first = await adapter.runStep({
      request,
      messages: [{ role: "user", content: "Answer from the full paper" }],
      tools,
    });
    assert.equal(first.kind, "final");
    if (first.kind !== "final") return;
    assert.notInclude(JSON.stringify(first.assistantMessage), "Hidden Ollama");

    const correction = {
      role: "user" as const,
      content: "Correction for this turn: read the complete paper.",
    };
    await adapter.runStep({
      request,
      messages: [first.assistantMessage, correction],
      continuationMessages: [correction],
      tools,
    });

    const secondMessages = requestBodies[1]?.messages as Array<
      Record<string, unknown>
    >;
    const nativeFinal = secondMessages.find(
      (message) => message.role === "assistant",
    );
    assert.equal(nativeFinal?.thinking, "Hidden Ollama plan.");
    assert.equal(nativeFinal?.content, "Premature answer.");
    assert.equal(
      secondMessages.at(-1)?.content,
      "Correction for this turn: read the complete paper.",
    );
  });

  it("applies a user-defined reasoning level the plugin has no encoding for", async function () {
    // The point of the editor: adopt a provider's new effort value without
    // waiting for a release. Agent mode has to honour it too.
    const body = captureBody({
      sse: [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`,
        "data: [DONE]\n\n",
      ],
    });

    await new OpenAIChatCompatAgentAdapter().runStep({
      request: makeRequest({
        model: "kimi-k3",
        apiBase: "https://api.moonshot.ai/v1",
        providerProtocol: "openai_chat_compat",
        reasoning: { provider: "kimi", level: "ultra" },
        advanced: {
          temperature: 0.3,
          maxTokens: 4096,
          profileOverride: {
            forModel: "kimi-k3",
            reasoning: {
              kind: "select",
              options: [
                {
                  id: "ultra",
                  label: "ultra",
                  enabled: true,
                  controls: { body: { reasoning_effort: "ultra" } },
                },
              ],
            },
          },
        },
      }),
      messages: [{ role: "user", content: "Summarize" }],
      tools,
    });

    assert.equal(body.read().reasoning_effort, "ultra");
  });

  // Not a guard for the override wiring — this level comes from the detected
  // catalog, so it passes with or without it. Kept because disabling thinking
  // in agent mode is the #363 behaviour and deserves its own check.
  it("turns Ollama thinking off using the detected level", async function () {
    configureModelCapabilityRuntime({
      fetch: (async (url: string) =>
        new Response(
          JSON.stringify(
            String(url).endsWith("/api/tags")
              ? { models: [{ name: "gemma4" }] }
              : { capabilities: ["completion", "thinking"], model_info: {} },
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
    });
    await refreshModelCatalog({
      model: "gemma4",
      apiBase: "http://localhost:11434",
      protocol: "ollama_native",
    });

    const body = captureBody({
      ndjson: ['{"message":{"content":"hi"},"done":true}\n'],
    });

    await new OllamaNativeAgentAdapter().runStep({
      request: makeRequest({
        model: "gemma4",
        apiBase: "http://localhost:11434",
        providerProtocol: "ollama_native",
        reasoning: { provider: "local", level: "minimal" },
        advanced: { temperature: 0.3, maxTokens: 4096 },
      }),
      messages: [{ role: "user", content: "Summarize" }],
      tools,
    });

    assert.strictEqual(
      body.read().think,
      false,
      "agent mode must be able to disable thinking, same as chat",
    );
  });

  it("a user-defined off level overrides the detected one", async function () {
    configureModelCapabilityRuntime({
      fetch: (async (url: string) =>
        new Response(
          JSON.stringify(
            String(url).endsWith("/api/tags")
              ? { models: [{ name: "gemma4" }] }
              : { capabilities: ["completion", "thinking"], model_info: {} },
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
    });
    await refreshModelCatalog({
      model: "gemma4",
      apiBase: "http://localhost:11434",
      protocol: "ollama_native",
    });

    const body = captureBody({
      ndjson: ['{"message":{"content":"hi"},"done":true}\n'],
    });

    // Detection would send `think: false` for this level; the override says to
    // send a string instead, so the value proves which one was used.
    await new OllamaNativeAgentAdapter().runStep({
      request: makeRequest({
        model: "gemma4",
        apiBase: "http://localhost:11434",
        providerProtocol: "ollama_native",
        reasoning: { provider: "local", level: "minimal" },
        advanced: {
          temperature: 0.3,
          maxTokens: 4096,
          profileOverride: {
            forModel: "gemma4",
            reasoning: {
              kind: "select",
              options: [
                {
                  id: "minimal",
                  label: "Off",
                  enabled: true,
                  controls: { body: { think: "never" } },
                },
              ],
            },
          },
        },
      }),
      messages: [{ role: "user", content: "Summarize" }],
      tools,
    });

    assert.strictEqual(
      body.read().think,
      "never",
      "the user's level must win over the detected one in agent mode",
    );
  });

  it("still refuses reserved envelope keys in agent mode", async function () {
    const body = captureBody({
      ndjson: ['{"message":{"content":"hi"},"done":true}\n'],
    });

    await new OllamaNativeAgentAdapter().runStep({
      request: makeRequest({
        model: "qwen3:8b",
        apiBase: "http://localhost:11434",
        providerProtocol: "ollama_native",
        advanced: advancedWith(
          {
            tools: [],
            messages: [{ role: "user", content: "hijack" }],
            top_k: 40,
          },
          "qwen3:8b",
        ),
      }),
      messages: [{ role: "user", content: "Summarize" }],
      tools,
    });

    const sent = body.read();
    assert.equal(sent.top_k, 40);
    assert.lengthOf(
      sent.tools as unknown[],
      1,
      "a user parameter must not drop the tool definitions",
    );
    assert.lengthOf(
      sent.messages as unknown[],
      1,
      "a user parameter must not replace the conversation",
    );
  });
});
