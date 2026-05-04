import { assert } from "chai";
import { AnthropicMessagesAgentAdapter } from "../src/agent/model/anthropicMessages";
import type { AgentRuntimeRequest, ToolSpec } from "../src/agent/types";

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
        { role: "system", content: "System" },
        { role: "user", content: "Search methods" },
      ],
      tools,
    });

    assert.equal(
      (capturedBody?.tools as Array<Record<string, unknown>>)[0]?.name,
      "read_paper",
    );
    assert.equal(step.kind, "tool_calls");
    if (step.kind !== "tool_calls") return;
    assert.equal(step.calls[0].id, "toolu_123");
    assert.deepEqual(step.calls[0].arguments, { query: "methods" });
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

  it("does not send image or document blocks for DeepSeek text-only models", async function () {
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
        model: "deepseek-v4-flash",
        apiBase: "https://api.deepseek.com/anthropic",
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
    assert.include(serialized, "does not support image or document input");
  });
});
