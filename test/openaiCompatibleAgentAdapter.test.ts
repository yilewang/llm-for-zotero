import { assert } from "chai";
import { OpenAICompatibleAgentAdapter } from "../src/agent/model/openaiCompatible";
import type { AgentRuntimeRequest, ToolSpec } from "../src/agent/types";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import { isMalformedToolArgumentsDiagnostic } from "../src/agent/toolArgumentDiagnostics";
import { PAPER_CITATION_CONTRACT } from "../src/shared/instructionContracts";

const MOONSHOT_ANY_OF_SIBLING_CONSTRAINTS = [
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "maximum",
  "minimum",
  "maxLength",
  "minLength",
  "maxItems",
  "minItems",
  "default",
];

// MoonshotAI/walle model.go: InvalidPropertyNames (server/ultra validation).
const MOONSHOT_RESERVED_PROPERTY_NAMES = new Set([
  "$defs",
  "$ref",
  "anyOf",
  "required",
  "additionalProperties",
]);

function assertMoonshotSchema(
  schema: unknown,
  path: string,
  allowEmpty = false,
): void {
  assert.isObject(schema, `${path} must be an object schema`);
  assert.isNotArray(schema, `${path} must not be an array`);
  const row = schema as Record<string, unknown>;
  if (!Object.keys(row).length && allowEmpty) return;
  for (const key of ["allOf", "not"]) {
    assert.notProperty(row, key, `${path} uses unsupported keyword ${key}`);
  }

  if (row.anyOf !== undefined) {
    assert.isArray(row.anyOf, `${path}.anyOf must be an array`);
    assert.isNotEmpty(row.anyOf, `${path}.anyOf must not be empty`);
    for (const key of MOONSHOT_ANY_OF_SIBLING_CONSTRAINTS) {
      assert.notProperty(
        row,
        key,
        `${path}.${key} must be distributed into the anyOf branches`,
      );
    }
    for (const [index, variant] of row.anyOf.entries()) {
      assertMoonshotSchema(variant, `${path}.anyOf[${index}]`);
    }
  } else if (row.$ref === undefined) {
    assert.property(row, "type", `${path} must declare a type`);
  }

  if (row.properties !== undefined) {
    assert.equal(row.type, "object", `${path}.properties requires object type`);
    assert.isObject(row.properties, `${path}.properties must be an object`);
    const properties = row.properties as Record<string, unknown>;
    for (const [key, value] of Object.entries(properties)) {
      assert.isFalse(
        MOONSHOT_RESERVED_PROPERTY_NAMES.has(key),
        `${path}.properties.${key} is a reserved Moonshot property name`,
      );
      assertMoonshotSchema(value, `${path}.properties.${key}`);
    }
    if (row.required !== undefined) {
      assert.isArray(row.required, `${path}.required must be an array`);
      for (const requiredKey of row.required) {
        assert.isTrue(
          typeof requiredKey === "string" && requiredKey in properties,
          `${path}.required contains undeclared property ${String(requiredKey)}`,
        );
      }
    }
  }

  if (row.items !== undefined) {
    assert.equal(row.type, "array", `${path}.items requires array type`);
    assertMoonshotSchema(row.items, `${path}.items`);
  }
  if (
    row.additionalProperties &&
    typeof row.additionalProperties === "object"
  ) {
    assertMoonshotSchema(
      row.additionalProperties,
      `${path}.additionalProperties`,
      true,
    );
  }
}

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

describe("OpenAICompatibleAgentAdapter", function () {
  const adapter = new OpenAICompatibleAgentAdapter();
  const originalToolkit = (
    globalThis as typeof globalThis & { ztoolkit?: unknown }
  ).ztoolkit;
  const tools: ToolSpec[] = [
    {
      name: "read_paper",
      description: "read paper",
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
      userText: "Test tool use",
      model: "gpt-4o-mini",
      apiBase: "https://api.openai.com/v1/responses",
      apiKey: "test",
      ...overrides,
    };
  }

  afterEach(function () {
    adapter.resetState();
    (
      globalThis as typeof globalThis & { ztoolkit?: typeof originalToolkit }
    ).ztoolkit = originalToolkit;
  });

  it("supports tool calling for responses-style API bases", function () {
    assert.isTrue(adapter.supportsTools(makeRequest()));
    assert.isTrue(
      adapter.supportsTools(
        makeRequest({
          apiBase:
            "https://generativelanguage.googleapis.com/v1beta/openai/responses",
        }),
      ),
    );
    assert.isTrue(
      adapter.supportsTools(
        makeRequest({
          apiBase: "https://api.x.ai/v1/responses",
        }),
      ),
    );
  });

  for (const provider of [
    {
      name: "DeepSeek",
      model: "deepseek-chat",
      apiBase: "https://api.deepseek.com/anthropic",
      endpoint: "https://api.deepseek.com/v1/chat/completions",
    },
    {
      name: "MiniMax",
      model: "MiniMax-M2.1",
      apiBase: "https://api.minimax.io/anthropic",
      endpoint: "https://api.minimax.io/v1/chat/completions",
    },
  ]) {
    it(`serializes the canonical citation contract through ${provider.name}'s OpenAI-compatible protocol`, async function () {
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
              headers: { get: () => "application/json" },
              json: async () => ({ choices: [{ message: { content: "OK" } }] }),
              text: async () => "",
            };
          };
        },
      };

      await adapter.runStep({
        request: makeRequest({
          model: provider.model,
          apiBase: provider.apiBase,
          apiKey: "provider-test",
          providerProtocol: "openai_chat_compat",
        }),
        messages: [
          { role: "system", content: PAPER_CITATION_CONTRACT },
          { role: "user", content: "Explain the result." },
        ],
        tools: [],
      });

      const serializedMessages = (
        capturedBody.messages as Array<{ content?: string }>
      )
        .map((message) => message.content || "")
        .join("\n");
      assert.equal(capturedUrl, provider.endpoint);
      assert.equal(
        serializedMessages.split(PAPER_CITATION_CONTRACT).length - 1,
        1,
      );
    });
  }

  it("keeps codex auth disabled for now", function () {
    assert.isFalse(
      adapter.supportsTools(
        makeRequest({
          apiBase: "https://chatgpt.com/backend-api/codex/responses",
          authMode: "codex_auth",
        }),
      ),
    );
  });

  it("normalizes the built-in Kimi tool registry into complete schemas", async function () {
    let capturedBody: Record<string, unknown> = {};
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
            headers: { get: () => "application/json" },
            json: async () => ({ choices: [{ message: { content: "OK" } }] }),
            text: async () => "",
          };
        };
      },
    };

    const registry = createBuiltInToolRegistry({
      zoteroGateway: {} as never,
      pdfService: {} as never,
      pdfPageService: {} as never,
      retrievalService: {} as never,
    });
    const registeredTools = registry.listTools();
    const originalPaperSchema = registeredTools.find(
      (tool) => tool.name === "paper_read",
    )!.inputSchema as Record<string, unknown>;

    await adapter.runStep({
      request: makeRequest({
        model: "kimi-for-coding",
        apiBase: "https://api.kimi.com/coding/v1",
        providerProtocol: "openai_chat_compat",
      }),
      messages: [{ role: "user", content: "Read the selected paper" }],
      tools: registeredTools,
    });

    const serializedTools = capturedBody.tools as Array<{
      function: {
        name: string;
        parameters: {
          properties: {
            target: Record<string, unknown>;
            pages: { anyOf: Array<Record<string, unknown>> };
          };
        };
      };
    }>;
    for (const tool of serializedTools) {
      assertMoonshotSchema(
        tool.function.parameters,
        `tools.${tool.function.name}.parameters`,
      );
    }

    for (const name of ["library_search", "saved_search_update"]) {
      const schema = serializedTools.find(
        (tool) => tool.function.name === name,
      )!.function.parameters as unknown as {
        properties: {
          conditions: { items: { properties: Record<string, unknown> } };
        };
      };
      assert.deepInclude(
        schema.properties.conditions.items.properties.isRequired,
        {
          type: "boolean",
        },
      );
    }

    const paperParameters = serializedTools.find(
      (tool) => tool.function.name === "paper_read",
    )!.function.parameters;
    const target = paperParameters.properties.target;
    const targetVariants = target.anyOf as Array<Record<string, unknown>>;
    assert.notProperty(target, "type");
    for (const variant of targetVariants) {
      assert.equal(variant.type, "object");
      assert.hasAllKeys(variant.properties as Record<string, unknown>, [
        "contextItemId",
        "itemId",
        "attachmentId",
        "name",
      ]);
      assert.equal(variant.additionalProperties, false);
    }
    assert.deepEqual(
      paperParameters.properties.pages.anyOf.map((variant) => variant.type),
      ["string", "number", "array"],
    );
    assert.equal(
      (
        (originalPaperSchema.properties as Record<string, unknown>)
          .target as Record<string, unknown>
      ).type,
      "object",
    );
  });

  it("does not let the untouched generic output default truncate max-reasoning agent work", async function () {
    let capturedBody: Record<string, unknown> = {};
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
            headers: { get: () => "application/json" },
            json: async () => ({ choices: [{ message: { content: "OK" } }] }),
            text: async () => "",
          };
        };
      },
    };

    await adapter.runStep({
      request: makeRequest({
        model: "deepseek-v4-pro",
        apiBase: "https://api.deepseek.com/v1",
        providerProtocol: "openai_chat_compat",
        reasoning: { provider: "deepseek", level: "xhigh" },
        advanced: { outputTokenLimit: { mode: "auto" } },
      }),
      messages: [{ role: "user", content: "Call the next plan tool." }],
      tools,
    });

    // The registry knows this model's output limit, so Auto sends it.
    assert.equal(capturedBody?.max_tokens, 384_000);
    assert.notProperty(capturedBody, "max_completion_tokens");
  });

  it("redacts malformed streamed tool argument JSON", async function () {
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name !== "fetch") return undefined;
        return async () => {
          const badArguments =
            '{"action":"write","content":"secret generated script"';
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            headers: { get: () => "text/event-stream" },
            body: makeSseStream([
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_bad",
                          function: {
                            name: "read_paper",
                            arguments: badArguments,
                          },
                        },
                      ],
                    },
                  },
                ],
              })}\n\n`,
              "data: [DONE]\n\n",
            ]),
            json: async () => ({}),
            text: async () => "",
          };
        };
      },
    };

    const step = await adapter.runStep({
      request: makeRequest({ providerProtocol: "openai_chat_compat" }),
      messages: [{ role: "user", content: "Write a script" }],
      tools,
    });

    assert.equal(step.kind, "tool_calls");
    if (step.kind !== "tool_calls") return;
    const args = step.calls[0].arguments;
    assert.isTrue(isMalformedToolArgumentsDiagnostic(args));
    if (!isMalformedToolArgumentsDiagnostic(args)) return;
    assert.include(args.rawPreview, "[redacted]");
    assert.notInclude(args.rawPreview, "secret generated script");
  });

  it("discards a broken stream's partial tool call and preserves completed conversation state", async function () {
    const bodies: Record<string, unknown>[] = [];
    let requests = 0;
    (globalThis as any).ztoolkit = {
      getGlobal: (name: string) =>
        name === "fetch"
          ? async (_url: string, init: RequestInit) => {
              bodies.push(JSON.parse(String(init.body)));
              let pulls = 0;
              return {
                ok: true,
                headers: { get: () => "text/event-stream" },
                body:
                  requests++ === 0
                    ? new ReadableStream<Uint8Array>({
                        pull(controller) {
                          if (pulls++)
                            return controller.error(
                              new Error("Error in input stream"),
                            );
                          controller.enqueue(
                            new TextEncoder().encode(
                              'data: {"choices":[{"delta":{"content":"Unfinished text","tool_calls":[{"index":0,"id":"partial","function":{"name":"read_paper","arguments":"{"}}]}}]}\n\n',
                            ),
                          );
                        },
                      })
                    : makeSseStream([
                        'data: {"choices":[{"delta":{"content":"Recovered"},"finish_reason":"stop"}]}\n\n',
                        "data: [DONE]\n\n",
                      ]),
              };
            }
          : undefined,
    };
    const request = makeRequest({ providerProtocol: "openai_chat_compat" });
    const messages = [
      { role: "user" as const, content: "Continue the recorded research" },
    ];
    const step = await adapter.runStep({ request, messages, tools });
    assert.equal(step.kind, "incomplete");
    if (step.kind !== "incomplete") return;
    assert.equal(step.reason, "stream_interrupted");
    assert.notProperty(step.assistantMessage, "tool_calls");
    assert.equal(step.text, "");
    const recovered = await adapter.runStep({
      request,
      messages,
      continuationMessages: [
        { role: "user", content: step.recoveryInstruction },
      ],
      tools,
    });
    assert.equal(recovered.kind, "final");
    assert.notInclude(JSON.stringify(bodies[1]), '"partial"');
    assert.notInclude(JSON.stringify(bodies[1]), "Unfinished text");
    assert.include(JSON.stringify(bodies[1]), "Continue the recorded research");
  });

  for (const aborted of [false, true]) {
    it(`does not retry ${aborted ? "an aborted stream" : "an unrelated parser failure"}`, async function () {
      const error = new Error(
        aborted ? "Error in input stream" : "Unrelated failure",
      );
      const controller = new AbortController();
      if (aborted) controller.abort();
      (globalThis as any).ztoolkit = {
        getGlobal: (name: string) =>
          name === "fetch"
            ? async () => ({
                ok: true,
                headers: { get: () => "text/event-stream" },
                body: new ReadableStream<Uint8Array>({
                  start(stream) {
                    stream.error(error);
                  },
                }),
              })
            : undefined,
      };
      let caught: unknown;
      try {
        await adapter.runStep({
          request: makeRequest(),
          messages: [],
          tools,
          signal: controller.signal,
        });
      } catch (failure) {
        caught = failure;
      }
      assert.strictEqual(caught, error);
    });
  }

  it("preserves a streamed provider output-limit stop instead of reporting a final answer", async function () {
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
          headers: { get: () => "text/event-stream" },
          body: makeSseStream([
            'data: {"choices":[{"delta":{"reasoning_content":"Long unfinished analysis"}}]}\n\n',
            'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
            "data: [DONE]\n\n",
          ]),
          json: async () => ({}),
          text: async () => "",
        });
      },
    };

    const step = await adapter.runStep({
      request: makeRequest({ providerProtocol: "openai_chat_compat" }),
      messages: [{ role: "user", content: "Screen the next batch" }],
      tools,
    });

    assert.equal(step.kind, "incomplete");
    if (step.kind !== "incomplete") return;
    assert.equal(step.reason, "output_limit");
    assert.include(step.recoveryInstruction, "required tool call");
  });

  it("preserves a non-streamed provider output-limit stop", async function () {
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
          headers: { get: () => "application/json" },
          body: undefined,
          json: async () => ({
            choices: [
              {
                finish_reason: "length",
                message: { content: "Partial draft" },
              },
            ],
          }),
          text: async () => "",
        });
      },
    };

    const step = await adapter.runStep({
      request: makeRequest({ providerProtocol: "openai_chat_compat" }),
      messages: [{ role: "user", content: "Write the document" }],
      tools,
    });

    assert.equal(step.kind, "incomplete");
    if (step.kind !== "incomplete") return;
    assert.equal(step.reason, "output_limit");
  });

  it("round-trips DeepSeek reasoning_content across tool continuations", async function () {
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
              headers: { get: () => "text/event-stream" },
              body: makeSseStream([
                'data: {"choices":[{"delta":{"reasoning_content":"Need the full text. "}}]}\n\n',
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_read","function":{"name":"read_paper","arguments":"{\\"path\\":\\"full.md\\"}"}}]}}]}\n\n',
                "data: [DONE]\n\n",
              ]),
              json: async () => ({}),
              text: async () => "",
            };
          }
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            headers: { get: () => "application/json" },
            body: undefined,
            json: async () => ({
              choices: [{ message: { content: "Done" } }],
            }),
            text: async () => "",
          };
        };
      },
    };

    const request = makeRequest({
      model: "deepseek-v4-flash",
      apiBase: "https://api.deepseek.com/v1",
      providerProtocol: "openai_chat_compat",
      reasoning: { provider: "deepseek", level: "high" },
    });
    const firstStep = await adapter.runStep({
      request,
      messages: [
        { role: "system", content: PAPER_CITATION_CONTRACT },
        { role: "user", content: "Summarize the paper" },
      ],
      tools,
    });

    assert.equal(firstStep.kind, "tool_calls");
    if (firstStep.kind !== "tool_calls") return;
    assert.notInclude(
      JSON.stringify(firstStep.assistantMessage),
      "Need the full text.",
    );
    const firstMessages = requestBodies[0]?.messages as Array<{
      role?: string;
      content?: string;
    }>;
    assert.equal(
      firstMessages
        .map((message) => message.content || "")
        .join("\n")
        .split(PAPER_CITATION_CONTRACT).length - 1,
      1,
    );

    const toolResult = {
      role: "tool" as const,
      tool_call_id: "call_read",
      name: "read_paper",
      content: '{"text":"full paper"}',
    };
    await adapter.runStep({
      request,
      messages: [firstStep.assistantMessage, toolResult],
      continuationMessages: [toolResult],
      tools,
    });

    const secondMessages = requestBodies[1]?.messages as Array<
      Record<string, unknown>
    >;
    assert.equal(
      secondMessages.find((message) => message.role === "assistant")
        ?.reasoning_content,
      "Need the full text.",
    );
  });

  it("round-trips provider-emitted reasoning_content for custom thinking models", async function () {
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
              headers: { get: () => "text/event-stream" },
              body: makeSseStream([
                'data: {"choices":[{"delta":{"reasoning_content":"Need the paper first. "}}]}\n\n',
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_read","function":{"name":"read_paper","arguments":"{}"}}]}}]}\n\n',
                "data: [DONE]\n\n",
              ]),
              json: async () => ({}),
              text: async () => "",
            };
          }
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            headers: { get: () => "application/json" },
            body: undefined,
            json: async () => ({
              choices: [{ message: { content: "Done" } }],
            }),
            text: async () => "",
          };
        };
      },
    };

    const request = makeRequest({
      model: "mimo-v2.5-pro",
      apiBase: "https://token-plan-cn.xiaomimimo.com/v1/chat/completions",
      providerProtocol: "openai_chat_compat",
    });
    const firstStep = await adapter.runStep({
      request,
      messages: [{ role: "user", content: "Write an Obsidian note" }],
      tools,
    });

    assert.equal(firstStep.kind, "tool_calls");
    if (firstStep.kind !== "tool_calls") return;
    assert.notInclude(
      JSON.stringify(firstStep.assistantMessage),
      "Need the paper first.",
    );

    const toolResult = {
      role: "tool" as const,
      tool_call_id: "call_read",
      name: "read_paper",
      content: '{"text":"full paper"}',
    };
    await adapter.runStep({
      request,
      messages: [firstStep.assistantMessage, toolResult],
      continuationMessages: [toolResult],
      tools,
    });

    const secondMessages = requestBodies[1]?.messages as Array<
      Record<string, unknown>
    >;
    assert.equal(
      secondMessages.find((message) => message.role === "assistant")
        ?.reasoning_content,
      "Need the paper first.",
    );
  });

  it("does not add reasoning_content to non-DeepSeek generic reasoning aliases", async function () {
    let capturedSecondBody: Record<string, unknown> | null = null;
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
          if (callCount === 2) {
            capturedSecondBody = JSON.parse(
              String(init?.body || "{}"),
            ) as Record<string, unknown>;
          }
          if (callCount === 1) {
            return {
              ok: true,
              status: 200,
              statusText: "OK",
              headers: { get: () => "text/event-stream" },
              body: makeSseStream([
                'data: {"choices":[{"delta":{"thinking":"Hidden reasoning."}}]}\n\n',
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_read","function":{"name":"read_paper","arguments":"{}"}}]}}]}\n\n',
                "data: [DONE]\n\n",
              ]),
              json: async () => ({}),
              text: async () => "",
            };
          }
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            headers: { get: () => "application/json" },
            body: undefined,
            json: async () => ({
              choices: [{ message: { content: "Done" } }],
            }),
            text: async () => "",
          };
        };
      },
    };

    const request = makeRequest({
      model: "gpt-4o-mini",
      apiBase: "https://api.openai.com/v1",
      providerProtocol: "openai_chat_compat",
    });
    const firstStep = await adapter.runStep({
      request,
      messages: [{ role: "user", content: "Search" }],
      tools,
    });

    assert.equal(firstStep.kind, "tool_calls");
    if (firstStep.kind !== "tool_calls") return;
    assert.notInclude(
      JSON.stringify(firstStep.assistantMessage),
      "Hidden reasoning.",
    );

    const toolResult = {
      role: "tool" as const,
      tool_call_id: "call_read",
      name: "read_paper",
      content: "{}",
    };
    await adapter.runStep({
      request,
      messages: [firstStep.assistantMessage, toolResult],
      continuationMessages: [toolResult],
      tools,
    });

    assert.notInclude(JSON.stringify(capturedSecondBody), "reasoning_content");
  });

  it("keeps final reasoning private while replaying it for a live correction", async function () {
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
              headers: { get: () => "text/event-stream" },
              body: makeSseStream([
                'data: {"choices":[{"delta":{"reasoning_content":"Hidden final plan. "}}]}\n\n',
                'data: {"choices":[{"delta":{"content":"Premature answer."}}]}\n\n',
                "data: [DONE]\n\n",
              ]),
              json: async () => ({}),
              text: async () => "",
            };
          }
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            headers: { get: () => "application/json" },
            body: undefined,
            json: async () => ({
              choices: [{ message: { content: "Corrected answer." } }],
            }),
            text: async () => "",
          };
        };
      },
    };

    const request = makeRequest({
      model: "deepseek-v4-pro",
      apiBase: "https://api.deepseek.com/v1",
      providerProtocol: "openai_chat_compat",
    });
    const firstStep = await adapter.runStep({
      request,
      messages: [{ role: "user", content: "Answer from the full paper" }],
      tools,
    });
    assert.equal(firstStep.kind, "final");
    if (firstStep.kind !== "final") return;
    assert.notInclude(
      JSON.stringify(firstStep.assistantMessage),
      "Hidden final plan.",
    );

    const correction = {
      role: "user" as const,
      content: "Correction for this turn: read the full paper first.",
    };
    await adapter.runStep({
      request,
      messages: [firstStep.assistantMessage, correction],
      continuationMessages: [correction],
      tools,
    });

    const secondMessages = requestBodies[1]?.messages as Array<
      Record<string, unknown>
    >;
    const nativeFinal = secondMessages.find(
      (message) => message.role === "assistant",
    );
    assert.equal(nativeFinal?.reasoning_content, "Hidden final plan.");
    assert.equal(nativeFinal?.content, "Premature answer.");
    assert.equal(
      secondMessages.at(-1)?.content,
      "Correction for this turn: read the full paper first.",
    );
  });

  it("preserves high-detail image hints for OpenAI-compatible chat payloads", async function () {
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
            headers: { get: () => "application/json" },
            body: undefined,
            json: async () => ({
              choices: [{ message: { content: "Done" } }],
            }),
            text: async () => "",
          };
        };
      },
    };

    await adapter.runStep({
      request: makeRequest({
        apiBase: "https://api.openai.com/v1",
        providerProtocol: "openai_chat_compat",
      }),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Inspect the figure." },
            {
              type: "image_url",
              image_url: {
                url: "data:image/png;base64,AAAA",
                detail: "high",
              },
            },
          ],
        },
      ],
      tools,
    });

    const messages = capturedBody?.messages as Array<Record<string, unknown>>;
    const content = messages?.[0]?.content as Array<Record<string, unknown>>;
    const imageUrl = content?.[1]?.image_url as Record<string, unknown>;
    assert.equal(imageUrl?.detail, "high");
  });

  it("rejects unresolved PDF file_refs instead of serializing them as image_url", async function () {
    try {
      await adapter.runStep({
        request: makeRequest({
          apiBase: "https://openrouter.ai/api/v1",
          providerProtocol: "openai_chat_compat",
        }),
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Read this PDF" },
              {
                type: "file_ref",
                file_ref: {
                  name: "paper.pdf",
                  mimeType: "application/pdf",
                  storedPath: "/tmp/paper.pdf",
                },
              },
            ],
          },
        ],
        tools,
      });
      assert.fail("Expected PDF file_ref rejection");
    } catch (err) {
      assert.include(
        (err as Error).message,
        "OpenAI-compatible chat cannot send unresolved PDF file_ref",
      );
    }
  });
});

describe("OpenAICompatibleAgentAdapter output cap rejection", function () {
  const originalToolkit = (
    globalThis as typeof globalThis & { ztoolkit?: unknown }
  ).ztoolkit;

  afterEach(function () {
    (
      globalThis as typeof globalThis & { ztoolkit?: typeof originalToolkit }
    ).ztoolkit = originalToolkit;
  });

  function installFetch(rejectionBody: string) {
    const bodies: Array<Record<string, unknown>> = [];
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown; log: () => void };
      }
    ).ztoolkit = {
      log: () => undefined,
      getGlobal: (name: string) => {
        if (name !== "fetch") return undefined;
        return async (_url: string, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body || "{}")) as Record<
            string,
            unknown
          >;
          bodies.push(body);
          if (bodies.length === 1) {
            return {
              ok: false,
              status: 400,
              statusText: "Bad Request",
              headers: { get: () => "application/json" },
              body: undefined,
              json: async () => ({}),
              text: async () => rejectionBody,
            };
          }
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            headers: { get: () => "text/event-stream" },
            body: makeSseStream([
              `data: ${JSON.stringify({
                choices: [{ delta: { content: "done" } }],
              })}\n\n`,
              `data: ${JSON.stringify({
                choices: [{ delta: {}, finish_reason: "stop" }],
              })}\n\n`,
              "data: [DONE]\n\n",
            ]),
            json: async () => ({}),
            text: async () => "",
          };
        };
      },
    };
    return bodies;
  }

  it("retries once with the provider's stated maximum", async function () {
    const bodies = installFetch(
      '{"error":{"message":"Invalid max_tokens value, the valid range of max_tokens is [1, 8192]","type":"invalid_request_error","code":400}}',
    );
    const adapter = new OpenAICompatibleAgentAdapter();
    const step = await adapter.runStep({
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "Summarize",
        model: "deepseek-chat",
        apiBase: "https://api.deepseek.com/v1",
        apiKey: "test",
        providerProtocol: "openai_chat_compat",
        advanced: { outputTokenLimit: { mode: "auto" }, temperature: 0.3 },
      },
      messages: [{ role: "user", content: "Summarize the paper." }],
      tools: [],
    });
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].max_tokens, 384_000);
    assert.equal(bodies[1].max_tokens, 8_192);
    assert.equal(step.kind, "final");
  });

  it("retries once without the cap when the rejection names no maximum", async function () {
    const bodies = installFetch(
      '{"error":{"message":"Unsupported parameter: max_tokens","code":400}}',
    );
    const adapter = new OpenAICompatibleAgentAdapter();
    await adapter.runStep({
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "Summarize",
        model: "deepseek-reasoner",
        apiBase: "https://api.deepseek.com/v1",
        apiKey: "test",
        providerProtocol: "openai_chat_compat",
        advanced: { outputTokenLimit: { mode: "auto" }, temperature: 0.3 },
      },
      messages: [{ role: "user", content: "Summarize the paper." }],
      tools: [],
    });
    assert.equal(bodies.length, 2);
    assert.property(bodies[0], "max_tokens");
    assert.notProperty(bodies[1], "max_tokens");
  });
});
