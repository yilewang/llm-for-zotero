import { assert } from "chai";
import { AnthropicMessagesAgentAdapter } from "../src/agent/model/anthropicMessages";
import { GeminiNativeAgentAdapter } from "../src/agent/model/geminiNative";
import { OpenAIChatCompatAgentAdapter } from "../src/agent/model/openaiCompatible";
import type { AgentRuntimeRequest, ToolSpec } from "../src/agent/types";
import type { UsageStats } from "../src/shared/llm";

/**
 * WHY THIS EXISTS: usage rows were written with all-zero tokens for real agent
 * turns against DeepSeek. DeepSeek's preset defaults to its
 * Anthropic-compatible endpoint, so agent mode runs through
 * `AnthropicMessagesAgentAdapter` — which streamed text perfectly but never
 * forwarded a single `onUsage` callback, because `params.onUsage` was simply
 * not wired into the stream parser and the parser ignored `message_start` /
 * `message_delta` usage frames. The Gemini native agent adapter had the same
 * hole. These tests pin the provider-reported numbers reaching `onUsage` for
 * every agent adapter, streaming and non-streaming.
 */

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

function eventStreamHeaders(): { get: (name: string) => string | null } {
  return {
    get: (name: string) =>
      name.toLowerCase() === "content-type" ? "text/event-stream" : null,
  };
}

function installFetch(respond: () => unknown): void {
  (
    globalThis as typeof globalThis & {
      ztoolkit: { getGlobal: (name: string) => unknown };
    }
  ).ztoolkit = {
    getGlobal: (name: string) => {
      if (name !== "fetch") return undefined;
      return async () => respond();
    },
  };
}

const tools: ToolSpec[] = [
  {
    name: "read_paper",
    description: "search",
    inputSchema: { type: "object" },
    executionClass: "read",
    requiresConfirmation: false,
  },
];

describe("agent adapters report provider usage", function () {
  const originalToolkit = (
    globalThis as typeof globalThis & { ztoolkit?: unknown }
  ).ztoolkit;

  afterEach(function () {
    (
      globalThis as typeof globalThis & { ztoolkit?: typeof originalToolkit }
    ).ztoolkit = originalToolkit;
  });

  function anthropicRequest(): AgentRuntimeRequest {
    return {
      conversationKey: 1,
      mode: "agent",
      userText: "Summarise the paper",
      // The real report: DeepSeek in agent mode over its Anthropic endpoint.
      model: "deepseek-flash",
      apiBase: "https://api.deepseek.com/anthropic",
      apiKey: "deepseek-test",
      providerProtocol: "anthropic_messages",
    };
  }

  it("forwards Anthropic-protocol streaming usage (the DeepSeek agent path)", async function () {
    const adapter = new AnthropicMessagesAgentAdapter();
    const samples: UsageStats[] = [];
    installFetch(() => ({
      ok: true,
      status: 200,
      statusText: "OK",
      body: makeSseStream([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":32208,"output_tokens":1,"cache_read_input_tokens":128}}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":517}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]),
      json: async () => ({}),
      text: async () => "",
    }));

    const step = await adapter.runStep({
      request: anthropicRequest(),
      messages: [{ role: "user", content: "Summarise" }],
      tools,
      onUsage: (usage) => {
        samples.push(usage);
      },
    });

    assert.equal(step.kind, "final");
    assert.isAtLeast(
      samples.length,
      2,
      "message_start and message_delta both report",
    );
    // input_tokens leaves out the cached tokens; the prompt counts them.
    assert.equal(samples[0].promptTokens, 32208 + 128);
    assert.equal(samples[0].cacheReadTokens, 128);
    const maxCompletion = Math.max(
      ...samples.map((sample) => sample.completionTokens || 0),
    );
    assert.equal(maxCompletion, 517);
  });

  it("forwards Anthropic-protocol usage on the non-streaming path", async function () {
    const adapter = new AnthropicMessagesAgentAdapter();
    const samples: UsageStats[] = [];
    installFetch(() => ({
      ok: true,
      status: 200,
      statusText: "OK",
      body: undefined,
      json: async () => ({
        content: [{ type: "text", text: "Done" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 900, output_tokens: 42 },
      }),
      text: async () => "",
    }));

    await adapter.runStep({
      request: anthropicRequest(),
      messages: [{ role: "user", content: "Summarise" }],
      tools,
      onUsage: (usage) => {
        samples.push(usage);
      },
    });

    assert.lengthOf(samples, 1);
    assert.equal(samples[0].promptTokens, 900);
    assert.equal(samples[0].completionTokens, 42);
    assert.equal(samples[0].totalTokens, 942);
  });

  it("forwards Gemini native streaming usageMetadata", async function () {
    const adapter = new GeminiNativeAgentAdapter();
    const samples: UsageStats[] = [];
    installFetch(() => ({
      ok: true,
      status: 200,
      statusText: "OK",
      body: makeSseStream([
        'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}],"usageMetadata":{"promptTokenCount":1200,"candidatesTokenCount":10,"totalTokenCount":1210}}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":" world"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1200,"candidatesTokenCount":64,"totalTokenCount":1264}}\n\n',
      ]),
      json: async () => ({}),
      text: async () => "",
    }));

    await adapter.runStep({
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "Inspect this",
        model: "gemini-2.5-pro",
        apiBase: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "gemini-test",
        providerProtocol: "gemini_native",
      },
      messages: [{ role: "user", content: "Say hello" }],
      tools,
      onUsage: (usage) => {
        samples.push(usage);
      },
    });

    assert.lengthOf(samples, 2);
    assert.equal(samples[1].promptTokens, 1200);
    assert.equal(samples[1].completionTokens, 64);
    assert.equal(samples[1].totalTokens, 1264);
  });

  it("counts Gemini native thinking tokens as completion tokens", async function () {
    const adapter = new GeminiNativeAgentAdapter();
    const samples: UsageStats[] = [];
    installFetch(() => ({
      ok: true,
      status: 200,
      statusText: "OK",
      body: makeSseStream([
        'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1200,"candidatesTokenCount":64,"thoughtsTokenCount":500,"totalTokenCount":1764}}\n\n',
      ]),
      json: async () => ({}),
      text: async () => "",
    }));

    await adapter.runStep({
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "Inspect this",
        model: "gemini-2.5-pro",
        apiBase: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "gemini-test",
        providerProtocol: "gemini_native",
      },
      messages: [{ role: "user", content: "Say hello" }],
      tools,
      onUsage: (usage) => {
        samples.push(usage);
      },
    });

    assert.lengthOf(samples, 1);
    assert.equal(samples[0].completionTokens, 564);
    assert.equal(samples[0].totalTokens, 1764);
  });

  it("forwards OpenAI-compatible usage that trails the final delta before [DONE]", async function () {
    const adapter = new OpenAIChatCompatAgentAdapter();
    const samples: UsageStats[] = [];
    installFetch(() => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: eventStreamHeaders(),
      body: makeSseStream([
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":800,"completion_tokens":20,"total_tokens":820}}\n\n',
        "data: [DONE]\n\n",
      ]),
      json: async () => ({}),
      text: async () => "",
    }));

    await adapter.runStep({
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "Hi",
        model: "gpt-4o-mini",
        apiBase: "https://api.openai.com/v1",
        apiKey: "openai-test",
        providerProtocol: "openai_chat_compat",
      },
      messages: [{ role: "user", content: "Hi" }],
      tools,
      onUsage: (usage) => {
        samples.push(usage);
      },
    });

    assert.lengthOf(samples, 1);
    assert.equal(samples[0].totalTokens, 820);
  });

  it("forwards OpenAI-compatible usage riding the finish_reason chunk", async function () {
    const adapter = new OpenAIChatCompatAgentAdapter();
    const samples: UsageStats[] = [];
    installFetch(() => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: eventStreamHeaders(),
      body: makeSseStream([
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":800,"completion_tokens":20,"total_tokens":820}}\n\ndata: [DONE]\n\n',
      ]),
      json: async () => ({}),
      text: async () => "",
    }));

    await adapter.runStep({
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "Hi",
        model: "gpt-4o-mini",
        apiBase: "https://api.openai.com/v1",
        apiKey: "openai-test",
        providerProtocol: "openai_chat_compat",
      },
      messages: [{ role: "user", content: "Hi" }],
      tools,
      onUsage: (usage) => {
        samples.push(usage);
      },
    });

    assert.lengthOf(samples, 1);
    assert.equal(samples[0].totalTokens, 820);
  });
});
