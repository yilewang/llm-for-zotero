import { assert } from "chai";
import { GeminiNativeAgentAdapter } from "../src/agent/model/geminiNative";
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

describe("GeminiNativeAgentAdapter", function () {
  const originalToolkit = (globalThis as typeof globalThis & { ztoolkit?: unknown })
    .ztoolkit;
  const tools: ToolSpec[] = [
    {
      name: "query_library",
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
      userText: "Inspect this",
      model: "gemini-2.5-pro",
      apiBase: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "gemini-test",
      providerProtocol: "gemini_native",
      ...overrides,
    };
  }

  afterEach(function () {
    (
      globalThis as typeof globalThis & { ztoolkit?: typeof originalToolkit }
    ).ztoolkit = originalToolkit;
  });

  it("serializes inline images and parses functionCall parts", async function () {
    const adapter = new GeminiNativeAgentAdapter();
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
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        functionCall: {
                          name: "query_library",
                          args: { query: "graph attention" },
                        },
                      },
                    ],
                  },
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
        {
          role: "user",
          content: [
            { type: "text", text: "What does this figure show?" },
            {
              type: "image_url",
              image_url: {
                url: "data:image/png;base64,AAAA",
              },
            },
          ],
        },
      ],
      tools,
    });

    const contents = capturedBody?.contents as Array<Record<string, unknown>>;
    const firstParts = contents?.[0]?.parts as Array<Record<string, unknown>>;
    const parameters = (
      (
        (
          capturedBody?.tools as Array<Record<string, unknown>>
        )?.[0]?.functionDeclarations as Array<Record<string, unknown>>
      )?.[0]?.parameters as Record<string, unknown>
    ) || { type: "" };
    assert.equal(
      ((firstParts?.[1]?.inlineData as Record<string, unknown>)?.mimeType as string) || "",
      "image/png",
    );
    assert.notInclude(JSON.stringify(capturedBody), "additionalProperties");
    assert.equal(parameters.type, "object");
    assert.equal(step.kind, "tool_calls");
    if (step.kind !== "tool_calls") return;
    assert.equal(step.calls[0].name, "query_library");
    assert.deepEqual(step.calls[0].arguments, { query: "graph attention" });
  });

  it("sanitizes unsupported JSON Schema constructs in tool declarations", async function () {
    const adapter = new GeminiNativeAgentAdapter();
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
              candidates: [{ content: { parts: [{ text: "OK" }] } }],
            }),
            text: async () => "",
          };
        };
      },
    };

    await adapter.runStep({
      request: makeRequest(),
      messages: [{ role: "user", content: "Test schema" }],
      tools: [
        {
          name: "complex_tool",
          description: "complex",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              paperContext: {
                type: "object",
                additionalProperties: true,
              },
              pages: {
                anyOf: [
                  { type: "string" },
                  { type: "integer" },
                  { type: "array", items: { type: "integer" } },
                ],
              },
              fieldValue: {
                type: ["string", "number", "boolean"],
              },
            },
          },
          mutability: "read",
          requiresConfirmation: false,
        },
      ],
    });

    const parameters = (
      (
        (
          capturedBody?.tools as Array<Record<string, unknown>>
        )?.[0]?.functionDeclarations as Array<Record<string, unknown>>
      )?.[0]?.parameters as Record<string, unknown>
    ) || { type: "" };
    const properties = (parameters.properties as Record<string, unknown>) || {};
    assert.equal(parameters.type, "object");
    assert.equal(
      (properties.pages as Record<string, unknown>).type,
      "array",
    );
    assert.equal(
      (
        ((properties.pages as Record<string, unknown>).items as Record<string, unknown>)
          ?.type as string
      ) || "",
      "integer",
    );
    assert.equal(
      (properties.fieldValue as Record<string, unknown>).type,
      "string",
    );
    assert.equal(
      (properties.paperContext as Record<string, unknown>).type,
      "string",
    );
    assert.notInclude(JSON.stringify(capturedBody), "additionalProperties");
    assert.notInclude(JSON.stringify(capturedBody), '["string","number","boolean"]');
  });

  it("streams final text from native SSE", async function () {
    const adapter = new GeminiNativeAgentAdapter();
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
            'data: {"candidates":[{"content":{"parts":[{"text":"Hello "} ]}}]}\n\n',
            'data: {"candidates":[{"content":{"parts":[{"text":"world"}]}}]}\n\n',
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

  it("streams thought parts separately from answer text", async function () {
    const adapter = new GeminiNativeAgentAdapter();
    const reasoning: string[] = [];
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
            'data: {"candidates":[{"content":{"parts":[{"text":"Think first.","thought":true,"thoughtSignature":"sig-1"},{"text":"Final answer."}]}}]}\n\n',
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
      onTextDelta: async (delta) => {
        deltas.push(delta);
      },
      onReasoning: async (event) => {
        if (event.details) {
          reasoning.push(event.details);
        }
      },
    });

    assert.equal(step.kind, "final");
    if (step.kind !== "final") return;
    assert.equal(step.text, "Final answer.");
    assert.deepEqual(deltas, ["Final answer."]);
    assert.deepEqual(reasoning, ["Think first."]);
  });

  it("falls back to non-stream generateContent when streaming returns no text", async function () {
    const adapter = new GeminiNativeAgentAdapter();
    let callCount = 0;
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name !== "fetch") return undefined;
        return async () => {
          callCount += 1;
          if (callCount === 1) {
            return {
              ok: true,
              status: 200,
              statusText: "OK",
              body: makeSseStream([
                'data: {"candidates":[{"content":{"parts":[]}}]}\n\n',
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
              candidates: [
                {
                  content: {
                    parts: [{ text: "Recovered final answer." }],
                  },
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
      messages: [{ role: "user", content: "Summarize it" }],
      tools,
    });

    assert.equal(callCount, 2);
    assert.equal(step.kind, "final");
    if (step.kind !== "final") return;
    assert.equal(step.text, "Recovered final answer.");
  });

  it("replays Gemini function calls with thoughtSignature on continuation", async function () {
    const adapter = new GeminiNativeAgentAdapter();
    let callCount = 0;
    let secondRequestBody: Record<string, unknown> | null = null;
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name !== "fetch") return undefined;
        return async (_url: string, init?: RequestInit) => {
          callCount += 1;
          if (callCount === 1) {
            return {
              ok: true,
              status: 200,
              statusText: "OK",
              body: undefined,
              json: async () => ({
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          functionCall: {
                            name: "read_paper",
                            args: { itemId: 1 },
                            thoughtSignature: "sig-123",
                          },
                        },
                      ],
                    },
                  },
                ],
              }),
              text: async () => "",
            };
          }
          secondRequestBody = JSON.parse(String(init?.body || "{}")) as Record<
            string,
            unknown
          >;
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            body: undefined,
            json: async () => ({
              candidates: [
                {
                  content: {
                    parts: [{ text: "Done." }],
                  },
                },
              ],
            }),
            text: async () => "",
          };
        };
      },
    };

    const firstStep = await adapter.runStep({
      request: makeRequest(),
      messages: [{ role: "user", content: "Inspect this paper" }],
      tools: [
        {
          name: "read_paper",
          description: "read",
          inputSchema: { type: "object" },
          mutability: "read",
          requiresConfirmation: false,
        },
      ],
    });

    assert.equal(firstStep.kind, "tool_calls");
    if (firstStep.kind !== "tool_calls") return;

    const secondStep = await adapter.runStep({
      request: makeRequest(),
      messages: [
        { role: "user", content: "Inspect this paper" },
        firstStep.assistantMessage,
        {
          role: "tool",
          tool_call_id: firstStep.calls[0].id,
          name: firstStep.calls[0].name,
          content: JSON.stringify({ ok: true }),
        },
      ],
      tools: [
        {
          name: "read_paper",
          description: "read",
          inputSchema: { type: "object" },
          mutability: "read",
          requiresConfirmation: false,
        },
      ],
    });

    assert.equal(secondStep.kind, "final");
    const contents = (secondRequestBody?.contents as Array<Record<string, unknown>>) || [];
    const modelParts = (contents[1]?.parts as Array<Record<string, unknown>>) || [];
    const functionCall = modelParts[0]?.functionCall as Record<string, unknown>;
    assert.equal(functionCall?.thoughtSignature, "sig-123");
  });

  it("serializes reusable transcript function responses after function calls", async function () {
    const adapter = new GeminiNativeAgentAdapter();
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
              candidates: [{ content: { parts: [{ text: "Done." }] } }],
            }),
            text: async () => "",
          };
        };
      },
    };

    await adapter.runStep({
      request: makeRequest(),
      messages: [
        { role: "user", content: "Earlier collection question" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              name: "query_library",
              arguments: { filters: { collectionId: 55 } },
            },
            {
              id: "call_2",
              name: "query_library",
              arguments: { filters: { collectionId: 56 } },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          name: "query_library",
          content: '{"results":[{"itemId":101}]}',
        },
        {
          role: "tool",
          tool_call_id: "call_2",
          name: "query_library",
          content: '{"results":[{"itemId":102}]}',
        },
        { role: "user", content: "Use those collection results now" },
      ],
      tools,
    });

    const contents = (capturedBody?.contents as Array<{
      role?: string;
      parts?: Array<Record<string, unknown>>;
    }>) || [];
    assert.deepEqual(
      contents.map((content) => content.role),
      ["user", "model", "user", "user"],
    );
    assert.deepEqual(
      contents[1]?.parts
        ?.map((part) => part.functionCall as Record<string, unknown>)
        .filter(Boolean)
        .map((call) => ({
          name: call.name,
          args: call.args,
        })),
      [
        { name: "query_library", args: { filters: { collectionId: 55 } } },
        { name: "query_library", args: { filters: { collectionId: 56 } } },
      ],
    );
    assert.deepEqual(
      contents[2]?.parts
        ?.map((part) => part.functionResponse as Record<string, unknown>)
        .filter(Boolean)
        .map((response) => ({
          name: response.name,
          response: response.response,
        })),
      [
        { name: "query_library", response: { results: [{ itemId: 101 }] } },
        { name: "query_library", response: { results: [{ itemId: 102 }] } },
      ],
    );
    assert.equal(contents[3]?.parts?.[0]?.text, "Use those collection results now");
  });

  it("filters cached Gemini function calls to executed continuation responses", async function () {
    const adapter = new GeminiNativeAgentAdapter();
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
              body: undefined,
              json: async () => ({
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          text: "Plan first.",
                          thought: true,
                          thoughtSignature: "sig-plan",
                        },
                        {
                          functionCall: {
                            name: "query_library",
                            args: { filters: { collectionId: 55 } },
                          },
                        },
                        {
                          functionCall: {
                            name: "query_library",
                            args: { filters: { collectionId: 56 } },
                          },
                        },
                      ],
                    },
                  },
                ],
              }),
              text: async () => "",
            };
          }
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            body: undefined,
            json: async () => ({
              candidates: [{ content: { parts: [{ text: "Done." }] } }],
            }),
            text: async () => "",
          };
        };
      },
    };

    const firstStep = await adapter.runStep({
      request: makeRequest(),
      messages: [{ role: "user", content: "List papers" }],
      tools,
    });

    assert.equal(firstStep.kind, "tool_calls");
    if (firstStep.kind !== "tool_calls") return;

    await adapter.runStep({
      request: makeRequest(),
      messages: [
        {
          ...firstStep.assistantMessage,
          tool_calls: firstStep.calls.slice(0, 1),
        },
        {
          role: "tool",
          tool_call_id: firstStep.calls[0].id,
          name: firstStep.calls[0].name,
          content: '{"results":[{"itemId":101}]}',
        },
      ],
      tools,
    });

    const secondContents = (requestBodies[1]?.contents as Array<{
      role?: string;
      parts?: Array<Record<string, unknown>>;
    }>) || [];
    const modelParts = secondContents[1]?.parts || [];
    assert.deepEqual(modelParts[0], {
      text: "Plan first.",
      thought: true,
      thoughtSignature: "sig-plan",
    });
    assert.deepEqual(
      modelParts
        .map((part) => part.functionCall as Record<string, unknown>)
        .filter(Boolean)
        .map((call) => call.args),
      [{ filters: { collectionId: 55 } }],
    );
    assert.deepEqual(
      secondContents[2]?.parts
        ?.map((part) => part.functionResponse as Record<string, unknown>)
        .filter(Boolean)
        .map((response) => response.response),
      [{ results: [{ itemId: 101 }] }],
    );
  });
});
