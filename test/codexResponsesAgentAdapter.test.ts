import { assert } from "chai";
import {
  CodexResponsesAgentAdapter,
  normalizeStepFromPayload,
  parseResponsesStepStream,
} from "../src/agent/model/codexResponses";
import { OpenAIResponsesAgentAdapter } from "../src/agent/model/openaiResponses";
import type {
  AgentModelMessage,
  AgentRuntimeRequest,
  ToolSpec,
} from "../src/agent/types";
import {
  loadCodexDirectCatalog,
  resetCodexDirectCatalogForTests,
} from "../src/codexAuth/modelCatalog";
import { CODEX_DIRECT_RESPONSES_URL } from "../src/codexAuth/auth";
import { PAPER_CITATION_CONTRACT } from "../src/shared/instructionContracts";

describe("CodexResponsesAgentAdapter", function () {
  const originalToolkit = (
    globalThis as typeof globalThis & { ztoolkit?: unknown }
  ).ztoolkit;
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
    resetCodexDirectCatalogForTests();
    (
      globalThis as typeof globalThis & { ztoolkit?: typeof originalToolkit }
    ).ztoolkit = originalToolkit;
  });

  async function loadDirectCatalog(): Promise<void> {
    await loadCodexDirectCatalog({
      authPath: "/test/codex/auth.json",
      readText: async () =>
        JSON.stringify({
          tokens: {
            access_token: "catalog-token",
            refresh_token: "catalog-refresh",
          },
        }),
      fetchFn: (async () =>
        new Response(
          JSON.stringify({
            models: [
              {
                slug: "gpt-codex",
                display_name: "GPT Codex",
                visibility: "list",
                priority: 1,
                supported_reasoning_levels: [
                  { effort: "low" },
                  { effort: "medium" },
                  { effort: "high" },
                  { effort: "xhigh" },
                  { effort: "max" },
                  { effort: "ultra" },
                ],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as typeof fetch,
    });
  }

  async function assertCorrectedFinalContinuation(
    targetAdapter: CodexResponsesAgentAdapter | OpenAIResponsesAgentAdapter,
    request: AgentRuntimeRequest,
  ): Promise<void> {
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
              output:
                callCount === 1
                  ? [
                      {
                        id: "fc_issue_387",
                        type: "function_call",
                        call_id: "call_issue_387",
                        name: "library_search",
                        arguments: '{"query":"methods"}',
                      },
                    ]
                  : callCount === 2
                    ? [
                        {
                          id: "rs_final",
                          type: "reasoning",
                          encrypted_content: "enc_final_reasoning",
                        },
                        {
                          type: "message",
                          content: [
                            {
                              type: "output_text",
                              text: "Premature comparison.",
                            },
                          ],
                        },
                      ]
                    : [
                        {
                          type: "message",
                          content: [
                            {
                              type: "output_text",
                              text: "Corrected comparison.",
                            },
                          ],
                        },
                      ],
            }),
            text: async () => "",
          };
        };
      },
    };

    const tools: ToolSpec[] = [
      {
        name: "library_search",
        description: "Search the library",
        inputSchema: { type: "object" },
        mutability: "read",
        requiresConfirmation: false,
      },
    ];
    const messages: AgentModelMessage[] = [
      { role: "user", content: "Compare these papers" },
    ];
    const firstStep = await targetAdapter.runStep({
      request,
      messages,
      tools,
    });
    assert.equal(firstStep.kind, "tool_calls");
    if (firstStep.kind !== "tool_calls") return;
    const toolResultMessage: AgentModelMessage = {
      role: "tool",
      tool_call_id: firstStep.calls[0].id,
      name: firstStep.calls[0].name,
      content: '{"results":[{"itemId":101},{"itemId":102}]}',
    };
    messages.push(firstStep.assistantMessage, toolResultMessage);

    const secondStep = await targetAdapter.runStep({
      request,
      messages,
      continuationMessages: [toolResultMessage],
      tools,
    });
    assert.equal(secondStep.kind, "final");
    if (secondStep.kind !== "final") return;
    assert.notInclude(
      JSON.stringify(secondStep.assistantMessage),
      "enc_final_reasoning",
    );
    const correctionMessage: AgentModelMessage = {
      role: "user",
      content: "Correction for this turn: retrieve body evidence first.",
    };
    messages.push(secondStep.assistantMessage, correctionMessage);

    await targetAdapter.runStep({
      request,
      messages,
      continuationMessages: [correctionMessage],
      tools,
    });

    const thirdInput = requestBodies[2]?.input as Array<
      Record<string, unknown>
    >;
    assert.lengthOf(
      thirdInput.filter((item) => item.type === "function_call_output"),
      1,
    );
    const functionCallIndex = thirdInput.findIndex(
      (item) => item.type === "function_call",
    );
    const functionOutputIndex = thirdInput.findIndex(
      (item) => item.type === "function_call_output",
    );
    const finalAnswerIndex = thirdInput.findIndex((item) =>
      JSON.stringify(item).includes("Premature comparison."),
    );
    const correctionIndex = thirdInput.findIndex((item) =>
      JSON.stringify(item).includes(
        "Correction for this turn: retrieve body evidence first.",
      ),
    );
    assert.isAtLeast(functionCallIndex, 0);
    assert.equal(functionOutputIndex, functionCallIndex + 1);
    assert.isAbove(finalAnswerIndex, functionOutputIndex);
    assert.equal(correctionIndex, thirdInput.length - 1);
    assert.isAbove(correctionIndex, finalAnswerIndex);
    assert.deepInclude(thirdInput, {
      id: "rs_final",
      type: "reasoning",
      encrypted_content: "enc_final_reasoning",
    });
  }

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

  it("preserves a complete native responses step for runtime overflow handling", function () {
    const step = normalizeStepFromPayload({
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
    });

    assert.deepEqual(
      step.toolCalls.map((call) => call.id),
      ["call_1", "call_2", "call_3", "call_4", "call_5"],
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
      ["call_1", "call_2", "call_3", "call_4", "call_5"],
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
      messages: [
        { role: "system", content: PAPER_CITATION_CONTRACT },
        { role: "user", content: "Hello" },
      ],
      tools: [],
    });

    assert.equal(step.kind, "final");
    assert.isFalse(
      Object.prototype.hasOwnProperty.call(
        capturedBody || {},
        "max_output_tokens",
      ),
    );
    assert.deepEqual(capturedBody?.include, ["reasoning.encrypted_content"]);
    assert.equal(
      String(capturedBody?.instructions || "").split(PAPER_CITATION_CONTRACT)
        .length - 1,
      1,
    );
  });

  it("sends exact catalog effort and ignores direct advanced settings", async function () {
    await loadDirectCatalog();
    const freshAdapter = new CodexResponsesAgentAdapter();
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    let capturedHeaders = new Headers();
    (
      globalThis as typeof globalThis & {
        ztoolkit: {
          getGlobal: (name: string) => unknown;
          log: () => void;
        };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name === "process") return { env: { HOME: "/home/tester" } };
        if (name === "IOUtils") {
          return {
            read: async () =>
              new TextEncoder().encode(
                JSON.stringify({
                  tokens: {
                    access_token: "direct-token",
                    refresh_token: "direct-refresh",
                    account_id: "account-456",
                  },
                }),
              ),
          };
        }
        if (name !== "fetch") return undefined;
        return async (url: string, init?: RequestInit) => {
          capturedUrl = url;
          capturedBody = JSON.parse(String(init?.body || "{}")) as Record<
            string,
            unknown
          >;
          capturedHeaders = new Headers(init?.headers);
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            body: undefined,
            json: async () => ({ output_text: "OK", output: [] }),
            text: async () => "",
          };
        };
      },
      log: () => undefined,
    };

    await freshAdapter.runStep({
      request: makeRequest({
        model: "gpt-codex",
        apiBase: "https://malicious.example/v1/responses",
        reasoning: {
          provider: "openai",
          level: "default",
          effort: "max",
        },
        advanced: {
          temperature: 1.7,
          maxTokens: 123,
          profileOverride: {
            forModel: "gpt-codex",
            extraBody: { custom_advanced_value: true },
          },
        },
      }),
      messages: [{ role: "user", content: "Hello" }],
      tools: [],
    });

    assert.equal(capturedUrl, CODEX_DIRECT_RESPONSES_URL);
    assert.deepEqual(capturedBody.reasoning, {
      effort: "max",
      summary: "detailed",
    });
    assert.notProperty(capturedBody, "temperature");
    assert.notProperty(capturedBody, "max_output_tokens");
    assert.notProperty(capturedBody, "custom_advanced_value");
    assert.equal(capturedHeaders.get("Authorization"), "Bearer direct-token");
    assert.equal(capturedHeaders.get("ChatGPT-Account-ID"), "account-456");
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      const effortAdapter = new CodexResponsesAgentAdapter();
      await effortAdapter.runStep({
        request: makeRequest({
          model: "gpt-codex",
          reasoning: { provider: "openai", level: "default", effort },
        }),
        messages: [{ role: "user", content: "Hello" }],
        tools: [],
      });
      assert.equal(
        (capturedBody.reasoning as { effort?: string } | undefined)?.effort,
        effort,
      );
    }
  });

  it("omits Ultra and stale direct efforts", async function () {
    await loadDirectCatalog();
    for (const effort of ["ultra", "stale-effort"]) {
      const freshAdapter = new CodexResponsesAgentAdapter();
      let capturedBody: Record<string, unknown> = {};
      (
        globalThis as typeof globalThis & {
          ztoolkit: { getGlobal: (name: string) => unknown; log: () => void };
        }
      ).ztoolkit = {
        getGlobal: (name: string) => {
          if (name === "process") return { env: { HOME: "/home/tester" } };
          if (name === "IOUtils") {
            return {
              read: async () =>
                new TextEncoder().encode(
                  JSON.stringify({
                    tokens: {
                      access_token: "direct-token",
                      refresh_token: "direct-refresh",
                    },
                  }),
                ),
            };
          }
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
              json: async () => ({ output_text: "OK", output: [] }),
              text: async () => "",
            };
          };
        },
        log: () => undefined,
      };
      await freshAdapter.runStep({
        request: makeRequest({
          model: "gpt-codex",
          reasoning: { provider: "openai", level: "default", effort },
        }),
        messages: [{ role: "user", content: "Hello" }],
        tools: [],
      });
      assert.notProperty(capturedBody, "reasoning", effort);
    }
  });

  it("preserves reusable transcript tool results as safe input evidence", async function () {
    const freshAdapter = new CodexResponsesAgentAdapter();
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

    await freshAdapter.runStep({
      request: makeRequest({
        authMode: "api_key",
        apiKey: "test-token",
      }),
      messages: [
        { role: "user", content: "Earlier collection question" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              name: "library_search",
              arguments: { filters: { collectionId: 55 } },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          name: "library_search",
          content: '{"results":[{"itemId":101,"title":"Paper A"}]}',
        },
        { role: "user", content: "Use those results now" },
      ],
      tools: [],
    });

    const input = (capturedBody?.input as Array<Record<string, unknown>>) || [];
    assert.deepEqual(
      input.map((item) => item.type),
      ["message", "message", "message"],
    );
    assert.notInclude(JSON.stringify(input), "function_call_output");
    assert.include(
      String(input[1]?.content || ""),
      "Previous tool result (library_search, call_id=call_1)",
    );
    assert.include(String(input[1]?.content || ""), "Paper A");
    assert.equal(input[2]?.content, "Use those results now");
  });

  it("does not replay an OpenAI function output after a corrected final answer", async function () {
    await assertCorrectedFinalContinuation(
      new OpenAIResponsesAgentAdapter(),
      makeRequest({
        model: "gpt-5.4",
        apiBase: "https://api.openai.com/v1",
        apiKey: "test-token",
        authMode: "api_key",
        providerProtocol: "responses_api",
      }),
    );
  });

  it("does not replay a Codex function output after a corrected final answer", async function () {
    await assertCorrectedFinalContinuation(
      new CodexResponsesAgentAdapter(),
      makeRequest({
        model: "gpt-5.4",
        apiBase: "https://example.com/v1",
        apiKey: "test-token",
        authMode: "api_key",
        providerProtocol: "codex_responses",
      }),
    );
  });

  it("forwards streamed OpenAI Responses usage including cached tokens", async function () {
    const openaiAdapter = new OpenAIResponsesAgentAdapter();
    const usage: unknown[] = [];
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
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(
                encoder.encode(
                  'data: {"type":"response.completed","response":{"id":"resp_usage","output_text":"Done.","usage":{"input_tokens":20,"output_tokens":5,"total_tokens":25,"input_tokens_details":{"cached_tokens":8}}}}\n',
                ),
              );
              controller.close();
            },
          }),
          json: async () => ({}),
          text: async () => "",
        });
      },
    };

    const step = await openaiAdapter.runStep({
      request: makeRequest({
        apiBase: "https://api.openai.com/v1/responses",
        authMode: "api_key",
        apiKey: "test-token",
      }),
      messages: [{ role: "user", content: "Hello" }],
      tools: [],
      onUsage: async (event) => {
        usage.push(event);
      },
    });

    assert.equal(step.kind, "final");
    assert.deepEqual(usage, [
      {
        promptTokens: 20,
        completionTokens: 5,
        totalTokens: 25,
        cacheReadTokens: 8,
        cacheMissTokens: 12,
        cacheHitRatio: 0.4,
        cacheProvider: "openai",
        contextTokens: 20,
        contextWindowIsAuthoritative: true,
      },
    ]);
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

    const step = await parseResponsesStepStream(
      stream,
      undefined,
      async (event) => {
        if (event.details) {
          reasoning.push(event.details);
        }
      },
    );

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
        contextTokens: 11,
        contextWindowIsAuthoritative: true,
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
