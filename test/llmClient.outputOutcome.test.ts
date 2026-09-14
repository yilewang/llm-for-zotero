import { assert } from "chai";
import {
  getOutputCapRecovery,
  normalizeProviderCompletion,
  parseResponsesStream,
  parseStreamResponse,
} from "../src/utils/llmClient";

function makeSseStream(events: unknown[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const event of events) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

describe("LLM terminal outcome normalization", function () {
  it("maps provider terminal reasons without conflating their causes", function () {
    assert.deepEqual(normalizeProviderCompletion("length"), {
      status: "incomplete",
      reason: "output_limit",
      providerReason: "length",
    });
    assert.deepEqual(normalizeProviderCompletion("MAX_TOKENS"), {
      status: "incomplete",
      reason: "output_limit",
      providerReason: "MAX_TOKENS",
    });
    assert.deepEqual(
      normalizeProviderCompletion("model_context_window_exceeded"),
      {
        status: "incomplete",
        reason: "context_limit",
        providerReason: "model_context_window_exceeded",
      },
    );
    assert.deepEqual(normalizeProviderCompletion("pause_turn"), {
      status: "incomplete",
      reason: "provider_pause",
      providerReason: "pause_turn",
    });
    assert.deepEqual(normalizeProviderCompletion("content_filter"), {
      status: "blocked",
      reason: "safety",
      providerReason: "content_filter",
    });
    assert.deepEqual(normalizeProviderCompletion("refusal"), {
      status: "blocked",
      reason: "refusal",
      providerReason: "refusal",
    });
    assert.deepEqual(normalizeProviderCompletion("MALFORMED_FUNCTION_CALL"), {
      status: "blocked",
      reason: "malformed_tool_call",
      providerReason: "MALFORMED_FUNCTION_CALL",
    });
    assert.deepEqual(
      normalizeProviderCompletion(undefined, { responseStatus: "failed" }),
      {
        status: "blocked",
        reason: "other",
        providerReason: "failed",
      },
    );
  });

  it("preserves partial Chat Completions text and marks finish_reason length incomplete", async function () {
    const deltas: string[] = [];
    const outcome = await parseStreamResponse(
      makeSseStream([
        { choices: [{ delta: { content: "Partial answer" } }] },
        { choices: [{ delta: {}, finish_reason: "length" }] },
      ]),
      (delta) => deltas.push(delta),
    );

    assert.equal(outcome.text, "Partial answer");
    assert.equal(deltas.join(""), "Partial answer");
    assert.deepEqual(outcome.completion, {
      status: "incomplete",
      reason: "output_limit",
      providerReason: "length",
    });
  });

  it("preserves Responses continuation state for a reasoning-only cutoff", async function () {
    const outcome = await parseResponsesStream(
      makeSseStream([
        {
          type: "response.reasoning_summary.delta",
          delta: "Private progress summary",
          response: { id: "resp_456" },
        },
        {
          type: "response.incomplete",
          response: {
            id: "resp_456",
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
          },
        },
      ]),
      () => undefined,
    );

    assert.equal(outcome.text, "");
    assert.deepEqual(outcome.completion, {
      status: "incomplete",
      reason: "output_limit",
      providerReason: "max_output_tokens",
    });
    assert.deepEqual(outcome.continuationState, { responseId: "resp_456" });
  });
});

describe("output cap rejection recovery", function () {
  const openaiUrl = "https://api.deepseek.com/v1/chat/completions";
  const anthropicUrl = "https://api.anthropic.com/v1/messages";

  it("takes the provider's stated maximum from several phrasings", function () {
    for (const message of [
      "Invalid max_tokens value, the valid range of max_tokens is [1, 8192]",
      "`max_tokens` must be less than or equal to `8192`",
      "max_tokens is too large: 384000. This model supports at most 8192 completion tokens, whereas you provided 384000.",
      "max_tokens: 384000 > 8192, which is the maximum allowed number of output tokens for this model",
    ]) {
      assert.deepEqual(
        getOutputCapRecovery({
          status: 400,
          message: `400 Bad Request (${openaiUrl}) - {"error":{"message":"${message}","code":400}}`,
          url: openaiUrl,
          requested: 384_000,
        }),
        { mode: "fixed", value: 8_192, scope: "endpoint" },
        message,
      );
    }
  });

  it("omits the cap for OpenAI-compatible providers that reject it without a number", function () {
    assert.deepEqual(
      getOutputCapRecovery({
        status: 400,
        message:
          '{"error":{"message":"Unsupported parameter: max_tokens","code":400}}',
        url: openaiUrl,
        requested: 384_000,
      }),
      { mode: "omit", scope: "endpoint" },
    );
  });

  it("falls back to the compatibility seed for Anthropic, which requires max_tokens", function () {
    assert.deepEqual(
      getOutputCapRecovery({
        status: 400,
        message:
          '{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: unsupported value"}}',
        url: anthropicUrl,
        requested: 128_000,
      }),
      { mode: "fixed", value: 8_192, scope: "endpoint" },
    );
  });

  it("derives the room left from an Anthropic context-limit rejection", function () {
    assert.deepEqual(
      getOutputCapRecovery({
        status: 400,
        message:
          '{"error":{"message":"input length and max_tokens exceed context limit: 150000 + 64000 > 200000, decrease input length or max_tokens and try again"}}',
        url: anthropicUrl,
        requested: 64_000,
      }),
      // Derived from this prompt's size, so it must not be cached.
      { mode: "fixed", value: 200_000 - 150_000 - 1_024, scope: "request" },
    );
  });

  it("ignores unrelated errors and unrelated numbers", function () {
    assert.isNull(
      getOutputCapRecovery({
        status: 500,
        message: "max_tokens exploded 8192",
        url: openaiUrl,
        requested: 384_000,
      }),
    );
    assert.isNull(
      getOutputCapRecovery({
        status: 400,
        message: '{"error":{"message":"temperature must be 1","code":400}}',
        url: openaiUrl,
        requested: 384_000,
      }),
    );
  });
});
