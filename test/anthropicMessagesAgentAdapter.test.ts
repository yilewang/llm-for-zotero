import { assert } from "chai";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnthropicMessagesAgentAdapter } from "../src/agent/model/anthropicMessages";
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
      mutability: "read",
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
    assert.notProperty(system[0] || {}, "cache_control");
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
          mutability: "read",
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

  it("places cache_control on the last stable system block", async function () {
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
    assert.notProperty(system[1] || {}, "cache_control");
    assert.deepEqual(system[2]?.cache_control, { type: "ephemeral" });
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
        reasoning: { provider: "deepseek", level: "xhigh" },
        advanced: { maxTokens: 384000 },
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
        advanced: { temperature: 0.4, maxTokens: 4096 },
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
});
