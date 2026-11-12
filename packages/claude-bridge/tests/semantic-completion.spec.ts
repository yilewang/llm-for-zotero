import { describe, expect, it } from "vitest";
import { StructuredCompletionError } from "../src/runtime.js";
import { ClaudeAgentSdkRuntimeClient } from "../src/providers/claude-agent-sdk-runtime-client.js";

describe("isolated semantic completion", () => {
  it("uses existing authentication with no tools, hooks, project/local settings, or persisted conversation", async () => {
    let options: any;
    let closed = false;
    const client = new ClaudeAgentSdkRuntimeClient({
      queryImpl: ((input: any) => {
        options = input.options;
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "result",
              subtype: "success",
              result: '{"actionIntents":[]}',
            };
          },
          close() {
            closed = true;
          },
        };
      }) as any,
    });
    const result = await client.completeStructured({
      prompt: "Interpret this request",
      model: "sonnet",
      timeoutMs: 1000,
    });
    expect(result).toEqual({ text: '{"actionIntents":[]}' });
    expect(options.tools).toEqual([]);
    expect(options.mcpServers).toEqual({});
    expect(options.strictMcpConfig).toBe(true);
    expect(options.plugins).toEqual([]);
    expect(options.settings.disableAllHooks).toBe(true);
    expect(options.settingSources).toEqual(["user"]);
    expect(options.hooks).toEqual({});
    expect(options.persistSession).toBe(false);
    expect(options.resume).toBeUndefined();
    expect(closed).toBe(true);
  });
  it("cancels promptly even when the SDK iterator stops responding", async () => {
    const controller = new AbortController();
    let closed = false;
    const client = new ClaudeAgentSdkRuntimeClient({
      queryImpl: (() => ({
        async *[Symbol.asyncIterator]() {
          await new Promise(() => {});
        },
        close() {
          closed = true;
        },
      })) as any,
    });
    const pending = client.completeStructured({
      prompt: "Interpret",
      timeoutMs: 10000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(closed).toBe(true);
  }, 500);

  function clientYielding(messages: unknown[]) {
    return new ClaudeAgentSdkRuntimeClient({
      queryImpl: (() => ({
        async *[Symbol.asyncIterator]() {
          for (const message of messages) yield message;
        },
        close() {},
      })) as any,
    });
  }

  it("returns the token usage the SDK reported next to the text", async () => {
    const client = clientYielding([
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "ok",
        usage: {
          input_tokens: 120,
          output_tokens: 30,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 700,
        },
        modelUsage: { "claude-sonnet-4-5": { inputTokens: 120 } },
      },
    ]);
    expect(
      await client.completeStructured({ prompt: "Read", timeoutMs: 1000 }),
    ).toEqual({
      text: "ok",
      usage: {
        inputTokens: 120,
        outputTokens: 30,
        cacheCreationInputTokens: 5,
        cacheReadInputTokens: 700,
        model: "claude-sonnet-4-5",
      },
    });
  });

  it("omits usage when the SDK reported no token counts", async () => {
    const client = clientYielding([
      { type: "result", subtype: "success", result: "ok", usage: {} },
    ]);
    expect(
      await client.completeStructured({ prompt: "Read", timeoutMs: 1000 }),
    ).toEqual({ text: "ok" });
  });

  it.each([
    [
      "an API status of 429",
      [
        {
          type: "result",
          subtype: "success",
          is_error: true,
          api_error_status: 429,
          result: "Rate limit exceeded, retry in 30s",
        },
      ],
      "Rate limit exceeded, retry in 30s",
    ],
    [
      "a rate_limit assistant error",
      [
        { type: "assistant", error: "rate_limit", message: {} },
        {
          type: "result",
          subtype: "success",
          is_error: true,
          result: "You have hit your limit",
        },
      ],
      "You have hit your limit",
    ],
    [
      "a rejected rate limit event",
      [
        {
          type: "rate_limit_event",
          rate_limit_info: { status: "rejected" },
        },
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["Usage limit reached"],
        },
      ],
      "Usage limit reached",
    ],
  ])(
    "fails with status 429 and the provider message for %s",
    async (_name, messages, text) => {
      const client = clientYielding(messages);
      const error = await client
        .completeStructured({ prompt: "Read", timeoutMs: 1000 })
        .catch((caught) => caught);
      expect(error).toBeInstanceOf(StructuredCompletionError);
      expect(error.status).toBe(429);
      expect(error.message).toBe(text);
    },
  );

  it("keeps other failures as plain errors with the provider detail", async () => {
    const client = clientYielding([
      {
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 500,
        result: "Upstream exploded",
      },
    ]);
    const error = await client
      .completeStructured({ prompt: "Read", timeoutMs: 1000 })
      .catch((caught) => caught);
    expect(error).not.toBeInstanceOf(StructuredCompletionError);
    expect(error.message).toBe("Semantic completion failed: Upstream exploded");
  });
});
