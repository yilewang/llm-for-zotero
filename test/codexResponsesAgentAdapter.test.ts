import { assert } from "chai";
import {
  CodexResponsesAgentAdapter,
  limitNormalizedResponsesStep,
  normalizeStepFromPayload,
  parseResponsesStepStream,
} from "../src/agent/model/codexResponses";
import type { AgentRuntimeRequest } from "../src/agent/types";

describe("CodexResponsesAgentAdapter", function () {
  const originalToolkit = (globalThis as typeof globalThis & { ztoolkit?: unknown })
    .ztoolkit;
  const adapter = new CodexResponsesAgentAdapter();

  function makeRequest(
    overrides: Partial<AgentRuntimeRequest> = {},
  ): AgentRuntimeRequest {
    return {
      conversationKey: 1,
      mode: "agent",
      userText: "Test tool use",
      model: "gpt-5.4",
      apiBase: "https://chatgpt.com/backend-api/codex/responses",
      authMode: "codex_auth",
      apiKey: "",
      ...overrides,
    };
  }

  afterEach(function () {
    (
      globalThis as typeof globalThis & { ztoolkit?: typeof originalToolkit }
    ).ztoolkit = originalToolkit;
  });

  it("supports tool calling for codex auth requests", function () {
    assert.isTrue(adapter.supportsTools(makeRequest()));
  });

  it("extracts tool calls from responses payload output items", function () {
    const step = normalizeStepFromPayload({
      id: "resp_123",
      output: [
        {
          id: "fc_123",
          type: "function_call",
          call_id: "call_123",
          name: "read_paper",
          arguments: JSON.stringify({
            operation: "retrieve_evidence",
            question: "What does the paper conclude?",
            topK: 3,
          }),
        },
      ],
    });

    assert.equal(step.responseId, "resp_123");
    assert.equal(step.toolCalls.length, 1);
    assert.equal(step.toolCalls[0].id, "call_123");
    assert.equal(step.toolCalls[0].name, "read_paper");
    assert.deepEqual(step.toolCalls[0].arguments, {
      operation: "retrieve_evidence",
      question: "What does the paper conclude?",
      topK: 3,
    });
  });

  it("extracts final text from message outputs", function () {
    const step = normalizeStepFromPayload({
      id: "resp_456",
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: "Final answer.",
            },
          ],
        },
      ],
    });

    assert.equal(step.responseId, "resp_456");
    assert.equal(step.toolCalls.length, 0);
    assert.equal(step.text, "Final answer.");
  });

  it("keeps responses tool calls and output items aligned when capped", function () {
    const step = limitNormalizedResponsesStep(
      normalizeStepFromPayload({
        id: "resp_789",
        output: [
          {
            id: "fc_1",
            type: "function_call",
            call_id: "call_1",
            name: "tool_a",
            arguments: "{}",
          },
          {
            id: "fc_2",
            type: "function_call",
            call_id: "call_2",
            name: "tool_b",
            arguments: "{}",
          },
          {
            id: "fc_3",
            type: "function_call",
            call_id: "call_3",
            name: "tool_c",
            arguments: "{}",
          },
          {
            id: "fc_4",
            type: "function_call",
            call_id: "call_4",
            name: "tool_d",
            arguments: "{}",
          },
          {
            id: "fc_5",
            type: "function_call",
            call_id: "call_5",
            name: "tool_e",
            arguments: "{}",
          },
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "Working on it.",
              },
            ],
          },
        ],
      }),
      4,
    );

    assert.deepEqual(
      step.toolCalls.map((call) => call.id),
      ["call_1", "call_2", "call_3", "call_4"],
    );
    assert.deepEqual(
      step.outputItems
        .filter(
          (item) =>
            item &&
            typeof item === "object" &&
            (item as { type?: unknown }).type === "function_call",
        )
        .map((item) => (item as { call_id?: unknown }).call_id),
      ["call_1", "call_2", "call_3", "call_4"],
    );
    assert.equal(step.text, "Working on it.");
  });

  it("does not send max_output_tokens to codex responses", async function () {
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
              output: [
                {
                  type: "message",
                  content: [{ type: "output_text", text: "OK" }],
                },
              ],
            }),
            text: async () => "",
          };
        };
      },
    };

    const step = await adapter.runStep({
      request: makeRequest({
        authMode: "api_key",
        apiKey: "test-token",
      }),
      messages: [{ role: "user", content: "Hello" }],
      tools: [],
    });

    assert.equal(step.kind, "final");
    assert.isFalse(
      Object.prototype.hasOwnProperty.call(capturedBody || {}, "max_output_tokens"),
    );
    assert.deepEqual(capturedBody?.include, ["reasoning.encrypted_content"]);
  });

  it("preserves streamed encrypted reasoning items for follow-up turns", async function () {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(
            'data: {"type":"response.output_item.added","item":{"id":"rs_123","type":"reasoning","encrypted_content":"enc_123"}}\n',
          ),
        );
        controller.enqueue(
          encoder.encode(
            'data: {"type":"response.completed","response":{"id":"resp_123","output":[{"id":"rs_123","type":"reasoning"}]}}\n',
          ),
        );
        controller.close();
      },
    });

    const step = await parseResponsesStepStream(stream);
    assert.equal(step.responseId, "resp_123");
    assert.deepEqual(step.outputItems, [
      {
        id: "rs_123",
        type: "reasoning",
        encrypted_content: "enc_123",
      },
    ]);
  });

  it("streams reasoning deltas separately from output text", async function () {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(
            'data: {"type":"response.reasoning.delta","delta":"Plan first."}\n',
          ),
        );
        controller.enqueue(
          encoder.encode(
            'data: {"type":"response.output_text.delta","delta":"Final answer."}\n',
          ),
        );
        controller.close();
      },
    });
    const reasoning: string[] = [];

    const step = await parseResponsesStepStream(stream, undefined, async (event) => {
      if (event.details) {
        reasoning.push(event.details);
      }
    });

    assert.equal(step.text, "Final answer.");
    assert.deepEqual(reasoning, ["Plan first."]);
  });

  it("forwards completed response usage into the shared usage callback", async function () {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(
            'data: {"type":"response.completed","response":{"id":"resp_usage","output_text":"Done.","usage":{"input_tokens":11,"output_tokens":7,"total_tokens":18}}}\n',
          ),
        );
        controller.close();
      },
    });
    const usage: Array<{
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    }> = [];

    const step = await parseResponsesStepStream(
      stream,
      undefined,
      undefined,
      async (event) => {
        usage.push(event);
      },
    );

    assert.equal(step.responseId, "resp_usage");
    assert.equal(step.text, "Done.");
    assert.deepEqual(usage, [
      {
        promptTokens: 11,
        completionTokens: 7,
        totalTokens: 18,
      },
    ]);
  });

  it("extracts final text from response.message.done events", async function () {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(
            'data: {"type":"response.message.done","message":{"content":[{"type":"output_text","text":"Figure 1 compares memory conditions."}]}}\n',
          ),
        );
        controller.close();
      },
    });

    const step = await parseResponsesStepStream(stream);

    assert.equal(step.text, "Figure 1 compares memory conditions.");
  });

  it("extracts final text from response.content_part.done events", async function () {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(
            'data: {"type":"response.content_part.done","part":{"type":"output_text","text":"The right panel shows the emotional ratings."}}\n',
          ),
        );
        controller.close();
      },
    });

    const step = await parseResponsesStepStream(stream);

    assert.equal(step.text, "The right panel shows the emotional ratings.");
  });

  it("extracts nested final text payloads from response.message.done events", async function () {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(
            'data: {"type":"response.message.done","message":{"content":[{"type":"output_text","text":{"value":"Figure 1 compares retrieval accuracy across conditions."}}]}}\n',
          ),
        );
        controller.close();
      },
    });

    const step = await parseResponsesStepStream(stream);

    assert.equal(
      step.text,
      "Figure 1 compares retrieval accuracy across conditions.",
    );
  });
});
