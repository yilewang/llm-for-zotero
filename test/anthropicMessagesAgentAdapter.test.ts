import { assert } from "chai";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnthropicMessagesAgentAdapter } from "../src/agent/model/anthropicMessages";
import { planContextCacheReuse } from "../src/contextCache/manager";
import { ModelStreamInterruptedError } from "../src/agent/model/completion";
import { createPaperReadTool } from "../src/agent/tools/read/paperRead";
import type {
  AgentModelMessage,
  AgentRuntimeRequest,
  ToolSpec,
} from "../src/agent/types";
import { isMalformedToolArgumentsDiagnostic } from "../src/agent/toolArgumentDiagnostics";
import { PAPER_CITATION_CONTRACT } from "../src/shared/instructionContracts";

function makeSseStream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

describe("AnthropicMessagesAgentAdapter", function () {
  const originalToolkit = (
    globalThis as typeof globalThis & { ztoolkit?: unknown }
  ).ztoolkit;
  const tools: ToolSpec[] = [
    {
      name: "read_paper",
      description: "search",
      inputSchema: { type: "object" },
      executionClass: "read",
      requiresConfirmation: false,
    },
  ];

  function makeRequest(
    overrides: Partial<AgentRuntimeRequest> = {},
  ): AgentRuntimeRequest {
    return {
      conversationKey: 1,
      mode: "agent",
      userText: "Search the paper",
      model: "claude-sonnet-4-5",
      apiBase: "https://api.anthropic.com/v1",
      apiKey: "anthropic-test",
      providerProtocol: "anthropic_messages",
      ...overrides,
    };
  }

  afterEach(function () {
    (
      globalThis as typeof globalThis & { ztoolkit?: typeof originalToolkit }
    ).ztoolkit = originalToolkit;
  });

  it("serializes native tool schemas and parses tool_use blocks", async function () {
    const adapter = new AnthropicMessagesAgentAdapter();
    let capturedBody: Record<string, unknown> | null = null;
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name !== "fetch") return undefined;
        return async (_url: string, init?: RequestInit) => {
          capturedBody = JSON.parse(String(init?.body || "{}")) as Record<
            string,
            unknown
          >;
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            body: undefined,
            json: async () => ({
              content: [
                {
                  type: "tool_use",
                  id: "toolu_123",
                  name: "read_paper",
                  input: { query: "methods" },
                },
              ],
            }),
            text: async () => "",
          };
        };
      },
    };

    const step = await adapter.runStep({
      request: makeRequest(),
      messages: [
        { role: "system", content: PAPER_CITATION_CONTRACT },
        { role: "user", content: "Search methods" },
      ],
      tools,
    });

    assert.equal(
      (capturedBody?.tools as Array<Record<string, unknown>>)[0]?.name,
      "read_paper",
    );
    assert.equal(capturedBody?.max_tokens, 8192);
    const serializedSystem = Array.isArray(capturedBody?.system)
      ? (capturedBody.system as Array<{ text?: string }>)
          .map((entry) => entry.text || "")
          .join("\n")
      : String(capturedBody?.system || "");
    assert.equal(serializedSystem.split(PAPER_CITATION_CONTRACT).length - 1, 1);
    assert.equal(step.kind, "tool_calls");
    if (step.kind !== "tool_calls") return;
    assert.equal(step.calls[0].id, "toolu_123");
    assert.deepEqual(step.calls[0].arguments, { query: "methods" });
  });

  it("recovers from max_tokens without exposing a truncated tool call", async function () {
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name !== "fetch") return undefined;
        return async () => ({
          ok: true,
          status: 200,
          statusText: "OK",
          body: undefined,
          json: async () => ({
            content: [
              { type: "text", text: "Partial analysis" },
              {
                type: "tool_use",
                id: "truncated-call",
                name: "read_paper",
                input: { query: "unfinished" },
              },
            ],
            stop_reason: "max_tokens",
          }),
          text: async () => "",
        });
      },
    };

    const step = await new AnthropicMessagesAgentAdapter().runStep({
      request: makeRequest(),
      messages: [{ role: "user", content: "Search methods" }],
      tools,
    });

    assert.equal(step.kind, "incomplete");
    if (step.kind !== "incomplete") return;
    assert.equal(step.reason, "output_limit");
    assert.equal(step.text, "Partial analysis");
    assert.notProperty(step, "calls");
  });

  it("keeps Anthropic provider pauses distinct from output limits", async function () {
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name !== "fetch") return undefined;
        return async () => ({
          ok: true,
          status: 200,
          statusText: "OK",
          body: undefined,
          json: async () => ({ content: [], stop_reason: "pause_turn" }),
          text: async () => "",
        });
      },
    };

    const step = await new AnthropicMessagesAgentAdapter().runStep({
      request: makeRequest(),
      messages: [{ role: "user", content: "Continue" }],
      tools,
    });

    assert.equal(step.kind, "incomplete");
    if (step.kind === "incomplete") {
      assert.equal(step.reason, "provider_pause");
    }
  });

  it("reports Anthropic context exhaustion instead of retrying it as an output cutoff", async function () {
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name !== "fetch") return undefined;
        return async () => ({
          ok: true,
          status: 200,
          statusText: "OK",
          body: undefined,
          json: async () => ({
            content: [],
            stop_reason: "model_context_window_exceeded",
          }),
          text: async () => "",
        });
      },
    };

    try {
      await new AnthropicMessagesAgentAdapter().runStep({
        request: makeRequest(),
        messages: [{ role: "user", content: "Continue" }],
        tools,
      });
      assert.fail("expected context exhaustion to stop the step");
    } catch (error) {
      assert.include(String(error), "context window was exhausted");
    }
  });

  it("serializes the real paper_read schema with a portable object root", async function () {
    const paperRead = createPaperReadTool(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    let capturedBody: Record<string, unknown> | null = null;
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name !== "fetch") return undefined;
        return async (_url: string, init?: RequestInit) => {
          capturedBody = JSON.parse(String(init?.body || "{}")) as Record<
            string,
            unknown
          >;
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            body: undefined,
            json: async () => ({
              content: [{ type: "text", text: "OK" }],
            }),
            text: async () => "",
          };
        };
      },
    };

    await new AnthropicMessagesAgentAdapter().runStep({
      request: makeRequest(),
      messages: [{ role: "user", content: "Explain the paper" }],
      tools: [paperRead.spec],
    });

    const bodyTools = capturedBody?.tools as
      | Array<Record<string, unknown>>
      | undefined;
    const inputSchema = bodyTools?.[0]?.input_schema as Record<string, unknown>;
    assert.equal(inputSchema.type, "object");
    for (const keyword of ["oneOf", "allOf", "anyOf"]) {
      assert.notProperty(inputSchema, keyword);
    }
    const properties = inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    assert.isArray(properties.target.anyOf);
    assert.deepEqual(
      (properties.targets.items as Record<string, unknown>).required,
      ["itemId"],
    );
  });

  for (const provider of [
    {
      name: "DeepSeek",
      model: "deepseek-chat",
      apiBase: "https://api.deepseek.com/v1",
      endpoint: "https://api.deepseek.com/anthropic/v1/messages",
    },
    {
      name: "MiniMax",
      model: "MiniMax-M2.1",
      apiBase: "https://api.minimax.io/v1",
      endpoint: "https://api.minimax.io/anthropic/v1/messages",
    },
  ]) {
    it(`serializes the canonical citation contract through ${provider.name}'s Anthropic-compatible protocol`, async function () {
      let capturedUrl = "";
      let capturedBody: Record<string, unknown> = {};
      (
        globalThis as typeof globalThis & {
          ztoolkit: { getGlobal: (name: string) => unknown };
        }
      ).ztoolkit = {
        getGlobal: (name: string) => {
          if (name !== "fetch") return undefined;
          return async (url: string, init?: RequestInit) => {
            capturedUrl = url;
            capturedBody = JSON.parse(String(init?.body || "{}")) as Record<
              string,
              unknown
            >;
            return {
              ok: true,
              status: 200,
              statusText: "OK",
              json: async () => ({ content: [{ type: "text", text: "OK" }] }),
              text: async () => "",
            };
          };
        },
      };

      await new AnthropicMessagesAgentAdapter().runStep({
        request: makeRequest({
          model: provider.model,
          apiBase: provider.apiBase,
          apiKey: "provider-test",
          providerProtocol: "anthropic_messages",
        }),
        messages: [
          { role: "system", content: PAPER_CITATION_CONTRACT },
          { role: "user", content: "Explain the result." },
        ],
        tools: [],
      });

      const serializedSystem = Array.isArray(capturedBody.system)
        ? (capturedBody.system as Array<{ text?: string }>)
            .map((entry) => entry.text || "")
            .join("\n")
        : String(capturedBody.system || "");
      assert.equal(capturedUrl, provider.endpoint);
      assert.equal(
        serializedSystem.split(PAPER_CITATION_CONTRACT).length - 1,
        1,
      );
    });
  }

  it("applies cache_control to the marked stable system block", async function () {
    const adapter = new AnthropicMessagesAgentAdapter();
    let capturedBody: Record<string, unknown> | null = null;
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name !== "fetch") return undefined;
        return async (_url: string, init?: RequestInit) => {
          capturedBody = JSON.parse(String(init?.body || "{}")) as Record<
            string,
            unknown
          >;
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            body: undefined,
            json: async () => ({
              content: [{ type: "text", text: "OK" }],
            }),
            text: async () => "",
          };
        };
      },
    };

    await adapter.runStep({
      request: makeRequest({
        contextCache: {
          enabled: true,
          mode: "anthropic_block",
          provider: "anthropic",
          providerLabel: "Anthropic prompt cache",
          telemetry: "anthropic_read_write",
          requestHints: {
            anthropicBlockCacheControl: { type: "ephemeral" },
          },
        },
      }),
      messages: [
        { role: "system", content: "Base system instructions" },
        {
          role: "system",
          content: "Stable Zotero resource context",
          cachePolicy: "stable-prefix",
        },
        { role: "user", content: "Search methods" },
      ],
      tools,
    });

    assert.isArray(capturedBody?.system);
    const system = capturedBody?.system as Array<Record<string, unknown>>;
    // A lone stable block also leaves a breakpoint on the fixed prompt.
    assert.deepEqual(system[0]?.cache_control, { type: "ephemeral" });
    assert.deepEqual(system[1]?.cache_control, { type: "ephemeral" });
    assert.equal(system[1]?.text, "Stable Zotero resource context");
  });

  it("applies agent request and tool cache_control hints", async function () {
    const adapter = new AnthropicMessagesAgentAdapter();
    let capturedBody: Record<string, unknown> | null = null;
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name !== "fetch") return undefined;
        return async (_url: string, init?: RequestInit) => {
          capturedBody = JSON.parse(String(init?.body || "{}")) as Record<
            string,
            unknown
          >;
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            body: undefined,
            json: async () => ({
              content: [{ type: "text", text: "OK" }],
            }),
            text: async () => "",
          };
        };
      },
    };

    await adapter.runStep({
      request: makeRequest({
        contextCache: {
          enabled: true,
          mode: "anthropic_block",
          provider: "anthropic",
          providerLabel: "Anthropic prompt cache",
          telemetry: "anthropic_read_write",
          requestHints: {
            anthropicBlockCacheControl: { type: "ephemeral", ttl: "1h" },
            anthropicToolCacheControl: { type: "ephemeral", ttl: "1h" },
            anthropicRequestCacheControl: { type: "ephemeral", ttl: "1h" },
          },
        },
      }),
      messages: [
        { role: "system", content: "Base system instructions" },
        {
          role: "system",
          content: "Stable Zotero resource context",
          cachePolicy: "stable-prefix",
        },
        { role: "user", content: "Search methods" },
      ],
      tools: [
        ...tools,
        {
          name: "search_paper",
          description: "search",
          inputSchema: { type: "object" },
          executionClass: "read",
          requiresConfirmation: false,
        },
      ],
    });

    assert.deepEqual(capturedBody?.cache_control, {
      type: "ephemeral",
      ttl: "1h",
    });
    const bodyTools = capturedBody?.tools as Array<Record<string, unknown>>;
    assert.notProperty(bodyTools[0] || {}, "cache_control");
    assert.deepEqual(bodyTools[1]?.cache_control, {
      type: "ephemeral",
      ttl: "1h",
    });
  });

  it("preserves the first paper and final stable prefix as cache breakpoints", async function () {
    const adapter = new AnthropicMessagesAgentAdapter();
    let capturedBody: Record<string, unknown> | null = null;
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name !== "fetch") return undefined;
        return async (_url: string, init?: RequestInit) => {
          capturedBody = JSON.parse(String(init?.body || "{}")) as Record<
            string,
            unknown
          >;
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            body: undefined,
            json: async () => ({
              content: [{ type: "text", text: "OK" }],
            }),
            text: async () => "",
          };
        };
      },
    };

    await adapter.runStep({
      request: makeRequest({
        contextCache: {
          enabled: true,
          mode: "anthropic_block",
          provider: "anthropic",
          providerLabel: "Anthropic prompt cache",
          telemetry: "anthropic_read_write",
          requestHints: {
            anthropicBlockCacheControl: { type: "ephemeral" },
          },
        },
      }),
      messages: [
        { role: "system", content: "Base system instructions" },
        {
          role: "system",
          content: "Stable Zotero resource context 1",
          cachePolicy: "stable-prefix",
        },
        {
          role: "system",
          content: "Stable Zotero resource context 2",
          cachePolicy: "stable-prefix",
        },
        { role: "user", content: "Search methods" },
      ],
      tools,
    });

    const system = capturedBody?.system as Array<Record<string, unknown>>;
    assert.deepEqual(system[1]?.cache_control, { type: "ephemeral" });
    assert.deepEqual(system[2]?.cache_control, { type: "ephemeral" });
  });

  it("caches an agent turn with no resource context within four breakpoints", async function () {
    // Anthropic accepts at most four cache breakpoints per request; the
    // request-level breakpoint counts toward them.
    const contextCache = planContextCacheReuse({
      model: "claude-haiku-5-5",
      apiBase: "https://api.anthropic.com/v1",
      protocol: "anthropic_messages",
      mode: "full",
      strategy: "agent-stable-resources",
      contextText: "",
    });
    assert.isTrue(contextCache.enabled);
    const countBreakpoints = (body: Record<string, unknown>) =>
      JSON.stringify(body).split('"cache_control"').length - 1;
    const twoTools = [
      ...tools,
      {
        name: "search_paper",
        description: "search",
        inputSchema: { type: "object" },
        executionClass: "read" as const,
        requiresConfirmation: false,
      },
    ];

    for (const stableBlocks of [0, 1, 3]) {
      const adapter = new AnthropicMessagesAgentAdapter();
      const requestBodies: Record<string, unknown>[] = [];
      (
        globalThis as typeof globalThis & {
          ztoolkit: { getGlobal: (name: string) => unknown };
        }
      ).ztoolkit = {
        getGlobal: (name: string) => {
          if (name !== "fetch") return undefined;
          return async (_url: string, init?: RequestInit) => {
            requestBodies.push(
              JSON.parse(String(init?.body || "{}")) as Record<string, unknown>,
            );
            return requestBodies.length === 1
              ? {
                  ok: true,
                  status: 200,
                  statusText: "OK",
                  body: makeSseStream([
                    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_paper","input":{}}}\n\n',
                    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
                    'data: {"type":"message_stop"}\n\n',
                  ]),
                  json: async () => ({}),
                  text: async () => "",
                }
              : {
                  ok: true,
                  status: 200,
                  statusText: "OK",
                  body: undefined,
                  json: async () => ({
                    content: [{ type: "text", text: "Done" }],
                  }),
                  text: async () => "",
                };
          };
        },
      };
      const request = makeRequest({ model: "claude-haiku-5-5", contextCache });
      const firstStep = await adapter.runStep({
        request,
        messages: [
          { role: "system", content: "Fixed agent prompt" },
          ...Array.from({ length: stableBlocks }, (_, index) => ({
            role: "system" as const,
            content: `Stable resource block ${index}`,
            cachePolicy: "stable-prefix" as const,
          })),
          { role: "user", content: "Search methods" },
        ],
        tools: twoTools,
      });
      if (firstStep.kind !== "tool_calls") {
        assert.fail("expected a tool call");
        return;
      }
      await adapter.runStep({
        request,
        messages: [
          firstStep.assistantMessage,
          {
            role: "tool",
            tool_call_id: "toolu_1",
            name: "read_paper",
            content: '{"matches":[]}',
          },
        ],
        tools: twoTools,
      });

      assert.lengthOf(requestBodies, 2);
      for (const body of requestBodies) {
        assert.isAtMost(countBreakpoints(body), 4, `${stableBlocks} blocks`);
        assert.deepEqual(body.cache_control, { type: "ephemeral" });
        const bodyTools = body.tools as Array<Record<string, unknown>>;
        assert.deepEqual(bodyTools[bodyTools.length - 1]?.cache_control, {
          type: "ephemeral",
        });
        const system = body.system as Array<Record<string, unknown>>;
        assert.deepEqual(system[system.length - 1]?.cache_control, {
          type: "ephemeral",
        });
        if (stableBlocks === 1) {
          assert.deepEqual(system[0]?.cache_control, { type: "ephemeral" });
        }
      }
    }
  });

  it("streams text deltas from native messages SSE", async function () {
    const adapter = new AnthropicMessagesAgentAdapter();
    const deltas: string[] = [];
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name !== "fetch") return undefined;
        return async () => ({
          ok: true,
          status: 200,
          statusText: "OK",
          body: makeSseStream([
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}\n\n',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}\n\n',
          ]),
          json: async () => ({}),
          text: async () => "",
        });
      },
    };

    const step = await adapter.runStep({
      request: makeRequest(),
      messages: [{ role: "user", content: "Say hello" }],
      tools,
      onTextDelta: async (delta) => {
        deltas.push(delta);
      },
    });

    assert.equal(step.kind, "final");
    if (step.kind !== "final") return;
    assert.equal(step.text, "Hello world");
    assert.deepEqual(deltas, ["Hello ", "world"]);
  });

  it("classifies a stream cut inside a content block as interrupted, and an overloaded error event too", async function () {
    const stream = (frames: string[]) => {
      (
        globalThis as typeof globalThis & {
          ztoolkit: { getGlobal: (name: string) => unknown };
        }
      ).ztoolkit = {
        getGlobal: (name: string) =>
          name === "fetch"
            ? async () => ({
                ok: true,
                status: 200,
                statusText: "OK",
                body: makeSseStream(frames),
                json: async () => ({}),
                text: async () => "",
              })
            : undefined,
      };
      return new AnthropicMessagesAgentAdapter()
        .runStep({
          request: makeRequest(),
          messages: [{ role: "user", content: "Answer" }],
          tools,
        })
        .then(
          (step) => step,
          (error: unknown) => error,
        );
    };
    const cut = await stream([
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Half an"}}\n\n',
    ]);
    assert.instanceOf(cut, ModelStreamInterruptedError);
    const overloaded = await stream([
      'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
    ]);
    assert.instanceOf(overloaded, ModelStreamInterruptedError);
    assert.equal((overloaded as ModelStreamInterruptedError).status, 529);
    // A provider that ends its stream between blocks without a terminal
    // event is taken as finished.
    const closed = (await stream([
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Whole."}}\n\n',
      'data: {"type":"content_block_stop","index":0}\n\n',
    ])) as { kind?: string; text?: string };
    assert.equal(closed.kind, "final");
    assert.equal(closed.text, "Whole.");
  });

  it("keeps no empty or thinking-only assistant turn for the next request", async function () {
    for (const content of [
      [],
      [
        {
          type: "thinking",
          thinking: "Weighing the lookalikes.",
          signature: "sig",
        },
      ],
    ]) {
      const bodies: Array<{
        messages: Array<{ role: string; content: unknown }>;
      }> = [];
      (
        globalThis as typeof globalThis & {
          ztoolkit: { getGlobal: (name: string) => unknown };
        }
      ).ztoolkit = {
        getGlobal: (name: string) =>
          name === "fetch"
            ? async (_url: string, init?: RequestInit) => {
                bodies.push(JSON.parse(String(init?.body || "{}")));
                const reply =
                  bodies.length === 1
                    ? { content, stop_reason: "end_turn" }
                    : {
                        content: [{ type: "text", text: "Not confirmed." }],
                        stop_reason: "end_turn",
                      };
                return {
                  ok: true,
                  status: 200,
                  statusText: "OK",
                  body: undefined,
                  json: async () => reply,
                  text: async () => JSON.stringify(reply),
                };
              }
            : undefined,
      };
      const adapter = new AnthropicMessagesAgentAdapter();
      const first = await adapter.runStep({
        request: makeRequest(),
        messages: [{ role: "user", content: "Answer now, without tools." }],
        tools,
        toolChoice: "none",
      });
      assert.equal(first.kind, "final");
      const second = await adapter.runStep({
        request: makeRequest(),
        messages: [{ role: "user", content: "Answer now, without tools." }],
        continuationMessages: [
          { role: "user", content: "Your last reply had no answer text." },
        ],
        tools,
        toolChoice: "none",
      });
      assert.equal(second.kind, "final");
      const sent = bodies[1].messages;
      assert.isFalse(
        sent.some((message) => message.role === "assistant"),
        JSON.stringify(sent),
      );
      assert.equal(sent[sent.length - 1].role, "user");
    }
  });

  it("streams thinking deltas separately from answer text", async function () {
    const adapter = new AnthropicMessagesAgentAdapter();
    const reasoning: string[] = [];
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name !== "fetch") return undefined;
        return async () => ({
          ok: true,
          status: 200,
          statusText: "OK",
          body: makeSseStream([
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Plan first."}}\n\n',
            'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
            'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Final answer."}}\n\n',
            'data: {"type":"message_stop"}\n\n',
          ]),
          json: async () => ({}),
          text: async () => "",
        });
      },
    };

    const step = await adapter.runStep({
      request: makeRequest(),
      messages: [{ role: "user", content: "Think, then answer" }],
      tools,
      onReasoning: async (event) => {
        if (event.details) {
          reasoning.push(event.details);
        }
      },
    });

    assert.equal(step.kind, "final");
    if (step.kind !== "final") return;
    assert.equal(step.text, "Final answer.");
    assert.deepEqual(reasoning, ["Plan first."]);
  });

  it("preserves native content blocks across tool continuations", async function () {
    const adapter = new AnthropicMessagesAgentAdapter();
    const requestBodies: Record<string, unknown>[] = [];
    let callCount = 0;
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name !== "fetch") return undefined;
        return async (_url: string, init?: RequestInit) => {
          callCount += 1;
          requestBodies.push(
            JSON.parse(String(init?.body || "{}")) as Record<string, unknown>,
          );
          if (callCount === 1) {
            return {
              ok: true,
              status: 200,
              statusText: "OK",
              body: makeSseStream([
                'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
                'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Plan first"}}\n\n',
                'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-123"}}\n\n',
                'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_456","name":"read_paper","input":{}}}\n\n',
                'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"methods\\"}"}}\n\n',
                'data: {"type":"message_stop"}\n\n',
              ]),
              json: async () => ({}),
              text: async () => "",
            };
          }
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            body: undefined,
            json: async () => ({
              content: [{ type: "text", text: "Done" }],
            }),
            text: async () => "",
          };
        };
      },
    };

    const firstStep = await adapter.runStep({
      request: makeRequest(),
      messages: [{ role: "user", content: "Search methods" }],
      tools,
    });

    assert.equal(firstStep.kind, "tool_calls");
    if (firstStep.kind !== "tool_calls") return;

    await adapter.runStep({
      request: makeRequest(),
      messages: [
        firstStep.assistantMessage,
        {
          role: "tool",
          tool_call_id: "toolu_456",
          name: "read_paper",
          content: '{"matches":["methods"]}',
        },
      ],
      tools,
    });

    const secondRequestMessages = requestBodies[1]?.messages as Array<{
      role?: string;
      content?: Array<Record<string, unknown>>;
    }>;
    assert.equal(secondRequestMessages[1]?.role, "assistant");
    assert.deepEqual(secondRequestMessages[1]?.content?.[0], {
      type: "thinking",
      thinking: "Plan first",
      signature: "sig-123",
    });
    assert.deepEqual(secondRequestMessages[1]?.content?.[1], {
      type: "tool_use",
      id: "toolu_456",
      name: "read_paper",
      input: { query: "methods" },
    });
  });

  it("preserves malformed streamed tool input as a redacted diagnostic", async function () {
    const adapter = new AnthropicMessagesAgentAdapter();
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name !== "fetch") return undefined;
        return async () => ({
          ok: true,
          status: 200,
          statusText: "OK",
          body: makeSseStream([
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_bad","name":"read_paper","input":{}}}\n\n',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"action\\":\\"write\\",\\"content\\":\\"secret draft"}}\n\n',
            'data: {"type":"message_stop"}\n\n',
          ]),
          json: async () => ({}),
          text: async () => "",
        });
      },
    };

    const step = await adapter.runStep({
      request: makeRequest(),
      messages: [{ role: "user", content: "Write a script" }],
      tools,
    });

    assert.equal(step.kind, "tool_calls");
    if (step.kind !== "tool_calls") return;
    const args = step.calls[0].arguments;
    assert.isTrue(isMalformedToolArgumentsDiagnostic(args));
    if (!isMalformedToolArgumentsDiagnostic(args)) return;
    assert.include(args.rawPreview, "[redacted]");
    assert.notInclude(args.rawPreview, "secret draft");
    assert.isAbove(args.rawLength, args.rawPreview.length);
  });

  it("serializes reusable transcript tool results directly after tool uses", async function () {
    const adapter = new AnthropicMessagesAgentAdapter();
    let capturedBody: Record<string, unknown> | null = null;
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name !== "fetch") return undefined;
        return async (_url: string, init?: RequestInit) => {
          capturedBody = JSON.parse(String(init?.body || "{}")) as Record<
            string,
            unknown
          >;
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            body: undefined,
            json: async () => ({
              content: [{ type: "text", text: "Done" }],
            }),
            text: async () => "",
          };
        };
      },
    };

    await adapter.runStep({
      request: makeRequest(),
      messages: [
        { role: "user", content: "Earlier paper question" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "toolu_1", name: "read_paper", arguments: { query: "a" } },
            { id: "toolu_2", name: "read_paper", arguments: { query: "b" } },
          ],
        },
        {
          role: "tool",
          tool_call_id: "toolu_1",
          name: "read_paper",
          content: '{"matches":["a"]}',
        },
        {
          role: "tool",
          tool_call_id: "toolu_2",
          name: "read_paper",
          content: '{"matches":["b"]}',
        },
        { role: "user", content: "Use those results now" },
      ],
      tools,
    });

    const bodyMessages = capturedBody?.messages as Array<{
      role?: string;
      content?: Array<Record<string, unknown>>;
    }>;
    assert.deepEqual(
      bodyMessages.map((message) => message.role),
      ["user", "assistant", "user", "user"],
    );
    assert.deepEqual(
      bodyMessages[1]?.content
        ?.filter((block) => block.type === "tool_use")
        .map((block) => block.id),
      ["toolu_1", "toolu_2"],
    );
    assert.deepEqual(
      bodyMessages[2]?.content?.map((block) => ({
        type: block.type,
        tool_use_id: block.tool_use_id,
      })),
      [
        { type: "tool_result", tool_use_id: "toolu_1" },
        { type: "tool_result", tool_use_id: "toolu_2" },
      ],
    );
    assert.equal(bodyMessages[3]?.content?.[0]?.text, "Use those results now");
  });

  it("preserves the complete cached native tool step on continuation", async function () {
    const adapter = new AnthropicMessagesAgentAdapter();
    const requestBodies: Record<string, unknown>[] = [];
    let callCount = 0;
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name !== "fetch") return undefined;
        return async (_url: string, init?: RequestInit) => {
          callCount += 1;
          requestBodies.push(
            JSON.parse(String(init?.body || "{}")) as Record<string, unknown>,
          );
          if (callCount === 1) {
            return {
              ok: true,
              status: 200,
              statusText: "OK",
              body: makeSseStream([
                'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
                'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Plan first"}}\n\n',
                'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_paper","input":{"query":"a"}}}\n\n',
                'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_2","name":"read_paper","input":{"query":"b"}}}\n\n',
                'data: {"type":"message_stop"}\n\n',
              ]),
              json: async () => ({}),
              text: async () => "",
            };
          }
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            body: undefined,
            json: async () => ({
              content: [{ type: "text", text: "Done" }],
            }),
            text: async () => "",
          };
        };
      },
    };

    const firstStep = await adapter.runStep({
      request: makeRequest(),
      messages: [{ role: "user", content: "Search methods" }],
      tools,
    });

    assert.equal(firstStep.kind, "tool_calls");
    if (firstStep.kind !== "tool_calls") return;

    const firstToolResult: AgentModelMessage = {
      role: "tool",
      tool_call_id: "toolu_1",
      name: "read_paper",
      content: '{"matches":["a"]}',
    };
    const secondToolResult: AgentModelMessage = {
      role: "tool",
      tool_call_id: "toolu_2",
      name: "read_paper",
      content: '{"matches":["b"]}',
    };
    await adapter.runStep({
      request: makeRequest(),
      messages: [firstStep.assistantMessage, firstToolResult, secondToolResult],
      continuationMessages: [firstToolResult, secondToolResult],
      tools,
    });

    const secondRequestMessages = requestBodies[1]?.messages as Array<{
      role?: string;
      content?: Array<Record<string, unknown>>;
    }>;
    const assistantContent = secondRequestMessages[1]?.content || [];
    assert.deepEqual(assistantContent[0], {
      type: "thinking",
      thinking: "Plan first",
    });
    assert.deepEqual(
      assistantContent
        .filter((block) => block.type === "tool_use")
        .map((block) => block.id),
      ["toolu_1", "toolu_2"],
    );
    assert.deepEqual(
      secondRequestMessages[2]?.content?.map((block) => ({
        type: block.type,
        tool_use_id: block.tool_use_id,
      })),
      [
        { type: "tool_result", tool_use_id: "toolu_1" },
        { type: "tool_result", tool_use_id: "toolu_2" },
      ],
    );
  });

  it("does not replay a tool result after a corrected final answer", async function () {
    const adapter = new AnthropicMessagesAgentAdapter();
    const requestBodies: Record<string, unknown>[] = [];
    let callCount = 0;
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name !== "fetch") return undefined;
        return async (_url: string, init?: RequestInit) => {
          callCount += 1;
          requestBodies.push(
            JSON.parse(String(init?.body || "{}")) as Record<string, unknown>,
          );
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            body: undefined,
            json: async () => ({
              content:
                callCount === 1
                  ? [
                      {
                        type: "tool_use",
                        id: "call_issue_387",
                        name: "read_paper",
                        input: { query: "methods" },
                      },
                    ]
                  : callCount === 2
                    ? [
                        {
                          type: "thinking",
                          thinking: "Need more evidence.",
                          signature: "sig-final-reasoning",
                        },
                        {
                          type: "text",
                          text: "Premature comparison.",
                        },
                      ]
                    : [
                        {
                          type: "text",
                          text: "Corrected comparison.",
                        },
                      ],
            }),
            text: async () => "",
          };
        };
      },
    };

    const request = makeRequest({
      model: "deepseek-v4-pro",
      apiBase: "https://api.deepseek.com/anthropic",
    });
    const messages: AgentModelMessage[] = [
      { role: "user", content: "Compare these papers" },
    ];
    const firstStep = await adapter.runStep({ request, messages, tools });
    assert.equal(firstStep.kind, "tool_calls");
    if (firstStep.kind !== "tool_calls") return;
    const toolResultMessage: AgentModelMessage = {
      role: "tool",
      tool_call_id: firstStep.calls[0].id,
      name: firstStep.calls[0].name,
      content: '{"matches":["paper-a","paper-b"]}',
    };
    messages.push(firstStep.assistantMessage, toolResultMessage);

    const secondStep = await adapter.runStep({
      request,
      messages,
      continuationMessages: [toolResultMessage],
      tools,
    });
    assert.equal(secondStep.kind, "final");
    if (secondStep.kind !== "final") return;
    assert.notInclude(
      JSON.stringify(secondStep.assistantMessage),
      "sig-final-reasoning",
    );
    const correctionMessage: AgentModelMessage = {
      role: "user",
      content: "Correction for this turn: retrieve body evidence first.",
    };
    messages.push(secondStep.assistantMessage, correctionMessage);

    await adapter.runStep({
      request,
      messages,
      continuationMessages: [correctionMessage],
      tools,
    });

    const thirdRequestMessages = requestBodies[2]?.messages as Array<{
      role?: string;
      content?: Array<Record<string, unknown>>;
    }>;
    assert.deepEqual(
      thirdRequestMessages.map((message) => message.role),
      ["user", "assistant", "user", "assistant", "user"],
    );
    const toolResults = thirdRequestMessages.flatMap(
      (message) =>
        message.content?.filter((block) => block.type === "tool_result") || [],
    );
    assert.deepEqual(
      toolResults.map((block) => block.tool_use_id),
      ["call_issue_387"],
    );
    assert.equal(thirdRequestMessages[1]?.content?.[0]?.type, "tool_use");
    assert.equal(thirdRequestMessages[2]?.content?.[0]?.type, "tool_result");
    assert.deepEqual(thirdRequestMessages[3]?.content?.[0], {
      type: "thinking",
      thinking: "Need more evidence.",
      signature: "sig-final-reasoning",
    });
    assert.equal(
      thirdRequestMessages[3]?.content?.[1]?.text,
      "Premature comparison.",
    );
    assert.equal(
      thirdRequestMessages[4]?.content?.[0]?.text,
      "Correction for this turn: retrieve body evidence first.",
    );
  });

  it("uses DeepSeek Anthropic-style thinking effort payloads", async function () {
    const adapter = new AnthropicMessagesAgentAdapter();
    let capturedBody: Record<string, unknown> | null = null;
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name !== "fetch") return undefined;
        return async (_url: string, init?: RequestInit) => {
          capturedBody = JSON.parse(String(init?.body || "{}")) as Record<
            string,
            unknown
          >;
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            body: undefined,
            json: async () => ({
              content: [{ type: "text", text: "Done" }],
            }),
            text: async () => "",
          };
        };
      },
    };

    await adapter.runStep({
      request: makeRequest({
        model: "deepseek-v4-pro",
        apiBase: "https://api.deepseek.com/anthropic",
        reasoning: { provider: "deepseek", level: "max" },
        advanced: {
          outputTokenLimit: { mode: "custom", tokens: 384000 },
        },
      }),
      messages: [{ role: "user", content: "Think" }],
      tools,
    });

    assert.deepEqual(capturedBody?.thinking, { type: "enabled" });
    assert.deepEqual(capturedBody?.output_config, { effort: "max" });
    assert.notProperty(capturedBody || {}, "reasoning_effort");
    assert.notProperty(capturedBody || {}, "temperature");
    assert.equal(capturedBody?.max_tokens, 384000);
  });

  it("downgrades Anthropic reasoning after provider rejections", async function () {
    const adapter = new AnthropicMessagesAgentAdapter();
    const requestBodies: Record<string, unknown>[] = [];
    (
      globalThis as typeof globalThis & {
        ztoolkit: {
          getGlobal: (name: string) => unknown;
          log: (...args: unknown[]) => void;
        };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name !== "fetch") return undefined;
        return async (_url: string, init?: RequestInit) => {
          requestBodies.push(
            JSON.parse(String(init?.body || "{}")) as Record<string, unknown>,
          );
          if (requestBodies.length === 1) {
            return {
              ok: false,
              status: 400,
              statusText: "Bad Request",
              text: async () => "thinking.type adaptive is not supported",
            };
          }
          if (requestBodies.length === 2) {
            return {
              ok: false,
              status: 400,
              statusText: "Bad Request",
              text: async () => "budget_tokens is not supported",
            };
          }
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            body: undefined,
            json: async () => ({
              content: [{ type: "text", text: "Done" }],
            }),
            text: async () => "",
          };
        };
      },
      log: () => undefined,
    };

    await adapter.runStep({
      request: makeRequest({
        model: "claude-sonnet-4-6",
        apiBase: "https://third-party.example/v1",
        reasoning: { provider: "anthropic", level: "high" },
        advanced: {
          temperature: 0.4,
          outputTokenLimit: { mode: "custom", tokens: 4096 },
        },
      }),
      messages: [{ role: "user", content: "Think" }],
      tools,
    });

    assert.deepEqual(requestBodies[0]?.thinking, { type: "adaptive" });
    assert.notProperty(requestBodies[0] || {}, "temperature");
    assert.deepEqual(requestBodies[1]?.thinking, {
      type: "enabled",
      budget_tokens: 3072,
    });
    assert.notProperty(requestBodies[1] || {}, "temperature");
    assert.notProperty(requestBodies[2] || {}, "thinking");
    assert.equal(requestBodies[2]?.temperature, 0.4);
  });

  it("keeps images but omits PDF documents for DeepSeek Anthropic-compatible models", async function () {
    const adapter = new AnthropicMessagesAgentAdapter();
    let capturedBody: Record<string, unknown> | null = null;
    const restoreIOUtils = (
      globalThis as typeof globalThis & {
        IOUtils?: { read?: (path: string) => Promise<Uint8Array> };
      }
    ).IOUtils;
    const restoreBtoa = (
      globalThis as typeof globalThis & { btoa?: (value: string) => string }
    ).btoa;
    const tempDir = mkdtempSync(join(tmpdir(), "llm-zotero-anthropic-"));
    const pdfPath = join(tempDir, "paper.pdf");
    writeFileSync(pdfPath, Uint8Array.from([37, 80, 68, 70, 45, 49, 46, 55]));
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name !== "fetch") return undefined;
        return async (_url: string, init?: RequestInit) => {
          capturedBody = JSON.parse(String(init?.body || "{}")) as Record<
            string,
            unknown
          >;
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            body: undefined,
            json: async () => ({
              content: [{ type: "text", text: "Done" }],
            }),
            text: async () => "",
          };
        };
      },
    };
    (
      globalThis as typeof globalThis & {
        IOUtils?: { read?: (path: string) => Promise<Uint8Array> };
      }
    ).IOUtils = {
      read: async (path: string) => new Uint8Array(readFileSync(path)),
    };
    (
      globalThis as typeof globalThis & { btoa?: (value: string) => string }
    ).btoa = (value: string) => Buffer.from(value, "binary").toString("base64");

    try {
      await adapter.runStep({
        request: makeRequest({
          model: "deepseek-v4-flash-vision-exp",
          apiBase: "https://api.deepseek.com/anthropic",
        }),
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Inspect the image and PDF." },
              {
                type: "image_url",
                image_url: { url: "data:image/png;base64,AAAA" },
              },
              {
                type: "file_ref",
                file_ref: {
                  name: "paper.pdf",
                  mimeType: "application/pdf",
                  storedPath: pdfPath,
                },
              },
            ],
          },
        ],
        tools,
      });

      const capabilities = adapter.getCapabilities(
        makeRequest({
          model: "deepseek-v4-flash-vision-exp",
          apiBase: "https://api.deepseek.com/anthropic",
        }),
      );
      const serialized = JSON.stringify(capturedBody);
      assert.isFalse(capabilities.fileInputs);
      assert.deepEqual(capabilities.contentInputs, {
        images: true,
        pdfDocuments: false,
        nativeFiles: false,
      });
      assert.include(serialized, '"type":"image"');
      assert.include(serialized, '"media_type":"image/png"');
      assert.notInclude(serialized, '"type":"document"');
      assert.notInclude(serialized, '"media_type":"application/pdf"');
      assert.include(serialized, "Inspect the image and PDF.");
      assert.include(serialized, "does not support PDF/document input");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      (
        globalThis as typeof globalThis & {
          IOUtils?: { read?: (path: string) => Promise<Uint8Array> };
        }
      ).IOUtils = restoreIOUtils;
      (
        globalThis as typeof globalThis & { btoa?: (value: string) => string }
      ).btoa = restoreBtoa;
    }
  });

  it("passes PDF document blocks for native Anthropic Messages while fileInputs is false", async function () {
    const adapter = new AnthropicMessagesAgentAdapter();
    let capturedBody: Record<string, unknown> | null = null;
    const restoreIOUtils = (
      globalThis as typeof globalThis & {
        IOUtils?: { read?: (path: string) => Promise<Uint8Array> };
      }
    ).IOUtils;
    const restoreBtoa = (
      globalThis as typeof globalThis & { btoa?: (value: string) => string }
    ).btoa;
    const tempDir = mkdtempSync(join(tmpdir(), "llm-zotero-anthropic-"));
    const pdfPath = join(tempDir, "paper.pdf");
    writeFileSync(pdfPath, Uint8Array.from([37, 80, 68, 70, 45, 49, 46, 55]));
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name !== "fetch") return undefined;
        return async (_url: string, init?: RequestInit) => {
          capturedBody = JSON.parse(String(init?.body || "{}")) as Record<
            string,
            unknown
          >;
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            body: undefined,
            json: async () => ({
              content: [{ type: "text", text: "Done" }],
            }),
            text: async () => "",
          };
        };
      },
    };
    (
      globalThis as typeof globalThis & {
        IOUtils?: { read?: (path: string) => Promise<Uint8Array> };
      }
    ).IOUtils = {
      read: async (path: string) => new Uint8Array(readFileSync(path)),
    };
    (
      globalThis as typeof globalThis & { btoa?: (value: string) => string }
    ).btoa = (value: string) => Buffer.from(value, "binary").toString("base64");

    try {
      const request = makeRequest({
        model: "claude-sonnet-4-5",
        apiBase: "https://api.anthropic.com/v1",
      });
      await adapter.runStep({
        request,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Read this PDF." },
              {
                type: "file_ref",
                file_ref: {
                  name: "paper.pdf",
                  mimeType: "application/pdf",
                  storedPath: pdfPath,
                },
              },
            ],
          },
        ],
        tools,
      });

      const capabilities = adapter.getCapabilities(request);
      const serialized = JSON.stringify(capturedBody);
      assert.isFalse(capabilities.fileInputs);
      assert.deepEqual(capabilities.contentInputs, {
        images: true,
        pdfDocuments: true,
        nativeFiles: false,
      });
      assert.include(serialized, '"type":"document"');
      assert.include(serialized, '"media_type":"application/pdf"');
      assert.notInclude(serialized, "does not support PDF/document input");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      (
        globalThis as typeof globalThis & {
          IOUtils?: { read?: (path: string) => Promise<Uint8Array> };
        }
      ).IOUtils = restoreIOUtils;
      (
        globalThis as typeof globalThis & { btoa?: (value: string) => string }
      ).btoa = restoreBtoa;
    }
  });

  it("does not send image or document blocks for explicit text-only models", async function () {
    const adapter = new AnthropicMessagesAgentAdapter();
    let capturedBody: Record<string, unknown> | null = null;
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name !== "fetch") return undefined;
        return async (_url: string, init?: RequestInit) => {
          capturedBody = JSON.parse(String(init?.body || "{}")) as Record<
            string,
            unknown
          >;
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            body: undefined,
            json: async () => ({
              content: [{ type: "text", text: "Done" }],
            }),
            text: async () => "",
          };
        };
      },
    };

    await adapter.runStep({
      request: makeRequest({
        model: "local-text-only",
        apiBase: "https://api.example.test/anthropic",
      }),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Use extracted text." },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,AAAA" },
            },
            {
              type: "file_ref",
              file_ref: {
                name: "paper.pdf",
                mimeType: "application/pdf",
                storedPath: "/tmp/nonexistent-paper.pdf",
              },
            },
          ],
        },
      ],
      tools,
    });

    const serialized = JSON.stringify(capturedBody);
    assert.notInclude(serialized, '"type":"image"');
    assert.notInclude(serialized, '"type":"document"');
    assert.include(serialized, "Use extracted text.");
    assert.include(
      serialized,
      "does not support image input or PDF/document input",
    );
  });

  it("counts cached tokens in the prompt it reports", async function () {
    const usage = {
      input_tokens: 100,
      cache_read_input_tokens: 9000,
      cache_creation_input_tokens: 500,
      output_tokens: 50,
    };
    for (const streaming of [false, true]) {
      const adapter = new AnthropicMessagesAgentAdapter();
      const samples: Array<Record<string, unknown>> = [];
      (
        globalThis as typeof globalThis & {
          ztoolkit: { getGlobal: (name: string) => unknown };
        }
      ).ztoolkit = {
        getGlobal: (name: string) => {
          if (name !== "fetch") return undefined;
          return async () => ({
            ok: true,
            status: 200,
            statusText: "OK",
            body: streaming
              ? makeSseStream([
                  `data: ${JSON.stringify({ type: "message_start", message: { usage: { ...usage, output_tokens: 1 } } })}\n\n`,
                  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n\n',
                  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":50}}\n\n',
                  'data: {"type":"message_stop"}\n\n',
                ])
              : undefined,
            json: async () => ({
              content: [{ type: "text", text: "OK" }],
              stop_reason: "end_turn",
              usage,
            }),
            text: async () => "",
          });
        },
      };
      await adapter.runStep({
        request: makeRequest(),
        messages: [{ role: "user", content: "Search methods" }],
        tools,
        onUsage: (sample) => {
          samples.push(sample as unknown as Record<string, unknown>);
        },
      });
      const label = streaming ? "streaming" : "non-streaming";
      assert.deepInclude(
        samples[0],
        {
          promptTokens: 9600,
          contextTokens: 9600,
          cacheReadTokens: 9000,
          cacheWriteTokens: 500,
          cacheHitRatio: 0.9375,
          contextWindowIsAuthoritative: true,
        },
        label,
      );
      if (!streaming) assert.equal(samples[0].totalTokens, 9650, label);
    }
  });
});

describe("AnthropicMessagesAgentAdapter output cap versus context window", function () {
  const originalToolkit = (
    globalThis as typeof globalThis & { ztoolkit?: unknown }
  ).ztoolkit;

  afterEach(function () {
    (
      globalThis as typeof globalThis & { ztoolkit?: typeof originalToolkit }
    ).ztoolkit = originalToolkit;
  });

  async function captureMaxTokens(
    userText: string,
    model = "claude-opus-4-6",
  ): Promise<number> {
    let capturedBody: Record<string, unknown> | null = null;
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name !== "fetch") return undefined;
        return async (_url: string, init?: RequestInit) => {
          capturedBody = JSON.parse(String(init?.body || "{}")) as Record<
            string,
            unknown
          >;
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            body: undefined,
            json: async () => ({
              content: [{ type: "text", text: "done" }],
              stop_reason: "end_turn",
            }),
            text: async () => "",
          };
        };
      },
    };
    const adapter = new AnthropicMessagesAgentAdapter();
    await adapter.runStep({
      request: {
        conversationKey: 1,
        mode: "agent",
        userText,
        model,
        apiBase: "https://api.anthropic.com",
        apiKey: "test",
        providerProtocol: "anthropic_messages",
        advanced: { outputTokenLimit: { mode: "auto" }, temperature: 0.3 },
      },
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: userText },
      ],
      tools: [],
    });
    return Number(capturedBody?.max_tokens);
  }

  it("sends the full known cap for a short prompt", async function () {
    assert.equal(await captureMaxTokens("Summarize this paper."), 128_000);
  });

  it("keeps the full cap for a long prompt inside the 1M window", async function () {
    // ~100k estimated input tokens of ASCII prose (4 chars per token).
    const longText = "word ".repeat(80_000);
    assert.equal(await captureMaxTokens(longText), 128_000);
  });

  it("shrinks max_tokens so a long prompt plus the cap still fits the 200k window", async function () {
    // ~150k estimated input tokens against Haiku 4.5's 200k window.
    const longText = "word ".repeat(120_000);
    const maxTokens = await captureMaxTokens(longText, "claude-haiku-4-5");
    assert.isAtLeast(maxTokens, 8_192);
    assert.isBelow(maxTokens, 64_000);
    assert.isAtMost(150_000 + maxTokens, 200_000);
  });
});
