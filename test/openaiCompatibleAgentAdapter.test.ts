import { assert } from "chai";
import { OpenAICompatibleAgentAdapter } from "../src/agent/model/openaiCompatible";
import type { AgentRuntimeRequest, ToolSpec } from "../src/agent/types";
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
