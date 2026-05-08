import { assert } from "chai";
import { OpenAICompatibleAgentAdapter } from "../src/agent/model/openaiCompatible";
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
    (
      globalThis as typeof globalThis & { ztoolkit?: typeof originalToolkit }
    ).ztoolkit = originalToolkit;
  });

  it("supports tool calling for responses-style API bases", function () {
    assert.isTrue(adapter.supportsTools(makeRequest()));
    assert.isTrue(
      adapter.supportsTools(
        makeRequest({
          apiBase: "https://generativelanguage.googleapis.com/v1beta/openai/responses",
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
      messages: [{ role: "user", content: "Summarize the paper" }],
      tools,
    });

    assert.equal(firstStep.kind, "tool_calls");
    if (firstStep.kind !== "tool_calls") return;
    assert.equal(firstStep.assistantMessage.reasoning_content, "Need the full text.");

    await adapter.runStep({
      request,
      messages: [
        firstStep.assistantMessage,
        {
          role: "tool",
          tool_call_id: "call_read",
          name: "read_paper",
          content: '{"text":"full paper"}',
        },
      ],
      tools,
    });

    const secondMessages = requestBodies[1]?.messages as Array<
      Record<string, unknown>
    >;
    assert.equal(secondMessages[0]?.reasoning_content, "Need the full text.");
  });

  it("does not add reasoning_content to non-DeepSeek tool continuations", async function () {
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
                'data: {"choices":[{"delta":{"reasoning_content":"Hidden reasoning."}}]}\n\n',
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
    assert.isUndefined(firstStep.assistantMessage.reasoning_content);

    await adapter.runStep({
      request,
      messages: [
        firstStep.assistantMessage,
        {
          role: "tool",
          tool_call_id: "call_read",
          name: "read_paper",
          content: "{}",
        },
      ],
      tools,
    });

    assert.notInclude(JSON.stringify(capturedSecondBody), "reasoning_content");
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
