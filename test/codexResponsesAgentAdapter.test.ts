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
import { ModelStreamInterruptedError } from "../src/agent/model/completion";
import { classifyModelFailure } from "../src/agent/loop/turnBoundary";

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
        executionClass: "read",
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

  it("treats Responses incomplete output as recovery before tool execution", async function () {
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
            id: "resp_incomplete",
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "Partial answer" }],
              },
              {
                type: "function_call",
                call_id: "truncated-call",
                name: "library_search",
                arguments: '{"query":"unfinished"}',
              },
            ],
          }),
          text: async () => "",
        });
      },
    };

    const step = await new OpenAIResponsesAgentAdapter().runStep({
      request: makeRequest({
        apiBase: "https://api.openai.com/v1/responses",
        apiKey: "test",
        authMode: "api_key",
        providerProtocol: "responses_api",
      }),
      messages: [{ role: "user", content: "Search" }],
      tools: [
        {
          name: "library_search",
          description: "search",
          inputSchema: { type: "object" },
          executionClass: "read",
          requiresConfirmation: false,
        },
      ],
    });

    assert.equal(step.kind, "incomplete");
    if (step.kind !== "incomplete") return;
    assert.equal(step.reason, "output_limit");
    assert.equal(step.text, "Partial answer");
    assert.notProperty(step, "calls");
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
          outputTokenLimit: { mode: "custom", tokens: 123 },
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
    for (const effort of ["low", "medium", "high", "xhigh", "max", "ultra"]) {
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

  it("omits stale direct efforts", async function () {
    await loadDirectCatalog();
    for (const effort of ["stale-effort"]) {
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

/** A Responses event stream that sends `events` as SSE lines, then closes. */
function sseStream(events: readonly unknown[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const event of events)
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n`));
      controller.close();
    },
  });
}

async function parseError(
  events: readonly unknown[],
): Promise<unknown | undefined> {
  try {
    await parseResponsesStepStream(sseStream(events));
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("Responses stream endings", function () {
  it("throws a retryable stream error for response.failed before any output", async function () {
    const error = await parseError([
      { type: "response.created", response: { id: "resp_failed" } },
      {
        type: "response.failed",
        response: {
          id: "resp_failed",
          status: "failed",
          error: { code: "server_error", message: "The server had an error." },
        },
      },
    ]);
    assert.instanceOf(error, ModelStreamInterruptedError);
    assert.include((error as Error).message, "server_error");
    assert.deepInclude(classifyModelFailure(error), {
      kind: "transient",
      cause: "stream",
    });
  });

  it("throws for response.failed even after partial text", async function () {
    const error = await parseError([
      { type: "response.output_text.delta", delta: "Partial " },
      {
        type: "response.failed",
        response: {
          status: "failed",
          error: { code: "rate_limit_exceeded", message: "Slow down." },
        },
      },
    ]);
    assert.instanceOf(error, ModelStreamInterruptedError);
  });

  it("reports a non-retryable response.failed with its code and message", async function () {
    const error = await parseError([
      {
        type: "response.failed",
        response: {
          status: "failed",
          error: {
            code: "insufficient_quota",
            message: "You exceeded your current quota.",
          },
        },
      },
    ]);
    assert.instanceOf(error, Error);
    assert.notInstanceOf(error, ModelStreamInterruptedError);
    assert.equal(
      (error as Error).message,
      "insufficient_quota: You exceeded your current quota.",
    );
    assert.equal(classifyModelFailure(error).kind, "fatal");
  });

  it("keeps a context-length error event a prompt that is too long", async function () {
    const error = await parseError([
      {
        type: "error",
        code: "context_length_exceeded",
        message: "Your input exceeds the context window of this model.",
      },
    ]);
    assert.notInstanceOf(error, ModelStreamInterruptedError);
    assert.equal(
      (error as Error).message,
      "context_length_exceeded: Your input exceeds the context window of this model.",
    );
    assert.equal(classifyModelFailure(error).kind, "prompt_too_long");
  });

  it("retries an error event that names no code", async function () {
    const error = await parseError([
      { type: "response.output_text.delta", delta: "Partial" },
      { type: "error", message: "An error occurred while processing." },
    ]);
    assert.instanceOf(error, ModelStreamInterruptedError);
    assert.equal(classifyModelFailure(error).kind, "transient");
  });

  it("reports a nested non-retryable error event when the top-level code is null", async function () {
    const error = await parseError([
      {
        type: "error",
        code: null,
        error: {
          code: "insufficient_quota",
          message: "You exceeded your current quota.",
        },
      },
    ]);
    assert.notInstanceOf(error, ModelStreamInterruptedError);
    assert.equal(
      (error as Error).message,
      "insufficient_quota: You exceeded your current quota.",
    );
    assert.equal(classifyModelFailure(error).kind, "fatal");
  });

  it("treats an invalid_request_error that has no code as fatal", async function () {
    const error = await parseError([
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Unknown parameter: made_up_field.",
        },
      },
    ]);
    assert.notInstanceOf(error, ModelStreamInterruptedError);
    assert.equal(
      (error as Error).message,
      "invalid_request_error: Unknown parameter: made_up_field.",
    );
    assert.equal(classifyModelFailure(error).kind, "fatal");
  });

  it("retries a relay's code-less rate_limit_error event as a 429", async function () {
    const error = await parseError([
      {
        type: "error",
        error: { type: "rate_limit_error", message: "Slow down." },
      },
    ]);
    assert.instanceOf(error, ModelStreamInterruptedError);
    assert.equal((error as ModelStreamInterruptedError).status, 429);
    assert.equal(classifyModelFailure(error).kind, "transient");
  });

  it("retries a nested error that has neither a code nor a type", async function () {
    const error = await parseError([
      { type: "error", code: null, error: { message: "Something broke." } },
    ]);
    assert.instanceOf(error, ModelStreamInterruptedError);
    assert.equal(classifyModelFailure(error).kind, "transient");
  });

  it("cancels the stream after response.failed", async function () {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({
              type: "response.failed",
              response: {
                status: "failed",
                error: { code: "server_error", message: "Broke." },
              },
            })}\n`,
          ),
        );
        // The stream stays open: only a cancel ends it.
      },
      cancel() {
        cancelled = true;
      },
    });
    let error: unknown;
    try {
      await parseResponsesStepStream(stream);
    } catch (caught) {
      error = caught;
    }
    assert.instanceOf(error, ModelStreamInterruptedError);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.isTrue(cancelled, "the unfinished stream is cancelled");
  });

  it("reads a last event that has no trailing newline", async function () {
    const event = JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_last",
        status: "completed",
        output_text: "The last line.",
      },
    });
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "response.created" })}\n`,
          ),
        );
        controller.enqueue(encoder.encode(`data: ${event.slice(0, 40)}`));
        controller.enqueue(encoder.encode(event.slice(40)));
        controller.close();
      },
    });
    const step = await parseResponsesStepStream(stream);
    assert.equal(step.text, "The last line.");
  });

  it("throws when the stream ends with no response, no text and no tool call", async function () {
    const error = await parseError([
      { type: "response.created", response: { id: "resp_cut" } },
      { type: "response.in_progress", response: { id: "resp_cut" } },
    ]);
    assert.instanceOf(error, ModelStreamInterruptedError);
    assert.equal(
      (error as Error).message,
      "The model stream ended before the response finished.",
    );
  });

  it("throws when a reasoning-only stream ends with no response", async function () {
    const error = await parseError([
      {
        type: "response.output_item.added",
        item: { id: "rs_1", type: "reasoning", encrypted_content: "enc" },
      },
      { type: "response.reasoning_summary_text.delta", delta: "Thinking" },
    ]);
    assert.instanceOf(error, ModelStreamInterruptedError);
  });

  it("still returns text or a tool call from a stream that sends no completed response", async function () {
    const textStep = await parseResponsesStepStream(
      sseStream([{ type: "response.output_text.delta", delta: "Answer." }]),
    );
    assert.equal(textStep.text, "Answer.");
    const callStep = await parseResponsesStepStream(
      sseStream([
        {
          type: "response.output_item.done",
          item: {
            id: "fc_1",
            type: "function_call",
            call_id: "call_1",
            name: "library_search",
            arguments: "{}",
          },
        },
      ]),
    );
    assert.deepEqual(
      callStep.toolCalls.map((call) => call.id),
      ["call_1"],
    );
  });
});

describe("Codex adapter: incomplete and empty replies", function () {
  const originalToolkit = (
    globalThis as typeof globalThis & { ztoolkit?: unknown }
  ).ztoolkit;

  afterEach(function () {
    (
      globalThis as typeof globalThis & { ztoolkit?: typeof originalToolkit }
    ).ztoolkit = originalToolkit;
  });

  const request: AgentRuntimeRequest = {
    conversationKey: 1,
    mode: "agent",
    userText: "Search",
    model: "gpt-5.4",
    apiBase: "https://example.com/v1",
    apiKey: "test-token",
    authMode: "api_key",
    providerProtocol: "codex_responses",
  };
  const tools: ToolSpec[] = [
    {
      name: "library_search",
      description: "search",
      inputSchema: { type: "object" },
      executionClass: "read",
      requiresConfirmation: false,
    },
  ];

  /** Serves one SSE stream per request; records each request body. */
  function serveStreams(
    streams: readonly (readonly unknown[])[],
  ): Record<string, unknown>[] {
    const bodies: Record<string, unknown>[] = [];
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name !== "fetch") return undefined;
        return async (_url: string, init?: RequestInit) => {
          bodies.push(
            JSON.parse(String(init?.body || "{}")) as Record<string, unknown>,
          );
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            body: sseStream(streams[bodies.length - 1] || []),
            json: async () => ({}),
            text: async () => "",
          };
        };
      },
    };
    return bodies;
  }

  const incomplete = (reason: string, output: unknown[] = []) => ({
    type: "response.incomplete",
    response: {
      id: "resp_incomplete",
      status: "incomplete",
      incomplete_details: { reason },
      output,
    },
  });

  it("returns an incomplete step for max_output_tokens", async function () {
    serveStreams([
      [
        incomplete("max_output_tokens", [
          {
            type: "message",
            content: [{ type: "output_text", text: "Partial answer" }],
          },
          {
            type: "function_call",
            call_id: "cut-call",
            name: "library_search",
            arguments: '{"query":"unfin',
          },
        ]),
      ],
    ]);
    const step = await new CodexResponsesAgentAdapter().runStep({
      request,
      messages: [{ role: "user", content: "Search" }],
      tools,
    });
    assert.equal(step.kind, "incomplete");
    if (step.kind !== "incomplete") return;
    assert.equal(step.reason, "output_limit");
    assert.equal(step.text, "Partial answer");
    assert.include(step.recoveryInstruction, "output limit");
  });

  it("throws when the provider filtered the reply", async function () {
    serveStreams([[incomplete("content_filter")]]);
    let error: unknown;
    try {
      await new CodexResponsesAgentAdapter().runStep({
        request,
        messages: [{ role: "user", content: "Search" }],
        tools,
      });
    } catch (caught) {
      error = caught;
    }
    assert.instanceOf(error, Error);
    assert.include((error as Error).message, "safety");
  });

  it("asks again for a reply the provider marked interrupted", async function () {
    serveStreams([
      [
        incomplete("interrupted", [
          {
            type: "message",
            content: [{ type: "output_text", text: "Half a sent" }],
          },
        ]),
      ],
    ]);
    const step = await new CodexResponsesAgentAdapter().runStep({
      request,
      messages: [{ role: "user", content: "Search" }],
      tools,
    });
    assert.equal(step.kind, "incomplete");
    if (step.kind !== "incomplete") return;
    assert.equal(step.reason, "stream_interrupted");
  });

  for (const [label, makeAdapter] of [
    ["Codex", () => new CodexResponsesAgentAdapter()],
    ["OpenAI", () => new OpenAIResponsesAgentAdapter()],
  ] as const) {
    it(`${label}: the request after an empty reasoning-only reply ends with no reasoning item`, async function () {
      const bodies = serveStreams([
        [
          {
            type: "response.completed",
            response: {
              id: "resp_empty",
              status: "completed",
              output: [
                { id: "rs_empty", type: "reasoning", encrypted_content: "enc" },
              ],
            },
          },
        ],
        [{ type: "response.output_text.delta", delta: "The answer." }],
      ]);
      const adapter = makeAdapter();
      const openaiRequest: AgentRuntimeRequest =
        label === "OpenAI"
          ? {
              ...request,
              apiBase: "https://api.openai.com/v1",
              providerProtocol: "responses_api",
            }
          : request;
      const messages: AgentModelMessage[] = [{ role: "user", content: "Ask" }];
      const first = await adapter.runStep({
        request: openaiRequest,
        messages,
        tools,
      });
      assert.equal(first.kind, "final");
      assert.equal(first.kind === "final" ? first.text : "x", "");
      const reAsk: AgentModelMessage = {
        role: "user",
        content: "Your last reply had no answer text.",
      };
      messages.push(reAsk);
      const second = await adapter.runStep({
        request: openaiRequest,
        messages,
        continuationMessages: [reAsk],
        tools,
      });
      assert.equal(second.kind, "final");
      const input = bodies[1]?.input as Array<Record<string, unknown>>;
      assert.notInclude(
        input.map((item) => item.type),
        "reasoning",
      );
      assert.deepEqual(input[input.length - 1], {
        type: "message",
        role: "user",
        content: "Your last reply had no answer text.",
      });
    });

    for (const [shape, output] of [
      [
        "reasoning and a cut function call",
        [
          { id: "rs_cut", type: "reasoning", encrypted_content: "enc" },
          {
            type: "function_call",
            call_id: "cut-call",
            name: "library_search",
            arguments: '{"query":"unfin',
          },
        ],
      ],
      [
        "reasoning only",
        [{ id: "rs_only", type: "reasoning", encrypted_content: "enc" }],
      ],
    ] as const) {
      it(`${label}: the request after an incomplete reply of ${shape} has neither the reasoning item nor the function call`, async function () {
        const bodies = serveStreams([
          [incomplete("max_output_tokens", [...output])],
          [{ type: "response.output_text.delta", delta: "Done." }],
        ]);
        const adapter = makeAdapter();
        const stepRequest: AgentRuntimeRequest =
          label === "OpenAI"
            ? {
                ...request,
                apiBase: "https://api.openai.com/v1",
                providerProtocol: "responses_api",
              }
            : request;
        const messages: AgentModelMessage[] = [
          { role: "user", content: "Search" },
        ];
        const first = await adapter.runStep({
          request: stepRequest,
          messages,
          tools,
        });
        assert.equal(first.kind, "incomplete");
        const recovery: AgentModelMessage = {
          role: "user",
          content: "Continue with a complete tool call.",
        };
        messages.push(recovery);
        await adapter.runStep({
          request: stepRequest,
          messages,
          continuationMessages: [recovery],
          tools,
        });
        const input = bodies[1]?.input as Array<Record<string, unknown>>;
        const types = input.map((item) => item.type);
        assert.notInclude(types, "reasoning");
        assert.notInclude(types, "function_call");
        assert.deepEqual(input[input.length - 1], {
          type: "message",
          role: "user",
          content: "Continue with a complete tool call.",
        });
      });
    }
  }
});
