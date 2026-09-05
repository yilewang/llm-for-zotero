import { assert } from "chai";
import { GeminiNativeAgentAdapter } from "../src/agent/model/geminiNative";
import { getModelCapabilities } from "../src/modelCapabilities";
import { computeProfileOverrideDraft } from "../src/modules/modelProfileEditor";
import type {
  AgentModelMessage,
  AgentRuntimeRequest,
  ToolSpec,
} from "../src/agent/types";
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

describe("GeminiNativeAgentAdapter", function () {
  const originalToolkit = (
    globalThis as typeof globalThis & { ztoolkit?: unknown }
  ).ztoolkit;
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
        { role: "system", content: PAPER_CITATION_CONTRACT },
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
    const parameters = ((
      (capturedBody?.tools as Array<Record<string, unknown>>)?.[0]
        ?.functionDeclarations as Array<Record<string, unknown>>
    )?.[0]?.parameters as Record<string, unknown>) || { type: "" };
    const systemParts = (
      (capturedBody?.systemInstruction as { parts?: Array<{ text?: string }> })
        ?.parts || []
    )
      .map((part) => part.text || "")
      .join("\n");
    assert.equal(systemParts.split(PAPER_CITATION_CONTRACT).length - 1, 1);
    assert.equal(
      ((firstParts?.[1]?.inlineData as Record<string, unknown>)
        ?.mimeType as string) || "",
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

    const parameters = ((
      (capturedBody?.tools as Array<Record<string, unknown>>)?.[0]
        ?.functionDeclarations as Array<Record<string, unknown>>
    )?.[0]?.parameters as Record<string, unknown>) || { type: "" };
    const properties = (parameters.properties as Record<string, unknown>) || {};
    assert.equal(parameters.type, "object");
    assert.equal((properties.pages as Record<string, unknown>).type, "array");
    assert.equal(
      ((
        (properties.pages as Record<string, unknown>).items as Record<
          string,
          unknown
        >
      )?.type as string) || "",
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
    assert.notInclude(
      JSON.stringify(capturedBody),
      '["string","number","boolean"]',
    );
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
    const contents =
      (secondRequestBody?.contents as Array<Record<string, unknown>>) || [];
    const modelParts =
      (contents[1]?.parts as Array<Record<string, unknown>>) || [];
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

    const contents =
      (capturedBody?.contents as Array<{
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
    assert.equal(
      contents[3]?.parts?.[0]?.text,
      "Use those collection results now",
    );
  });

  it("preserves the complete cached Gemini function step on continuation", async function () {
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

    const firstToolResult: AgentModelMessage = {
      role: "tool",
      tool_call_id: firstStep.calls[0].id,
      name: firstStep.calls[0].name,
      content: '{"results":[{"itemId":101}]}',
    };
    const secondToolResult: AgentModelMessage = {
      role: "tool",
      tool_call_id: firstStep.calls[1].id,
      name: firstStep.calls[1].name,
      content: '{"results":[{"itemId":102}]}',
    };
    await adapter.runStep({
      request: makeRequest(),
      messages: [firstStep.assistantMessage, firstToolResult, secondToolResult],
      continuationMessages: [firstToolResult, secondToolResult],
      tools,
    });

    const secondContents =
      (requestBodies[1]?.contents as Array<{
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
      [{ filters: { collectionId: 55 } }, { filters: { collectionId: 56 } }],
    );
    assert.deepEqual(
      secondContents[2]?.parts
        ?.map((part) => part.functionResponse as Record<string, unknown>)
        .filter(Boolean)
        .map((response) => response.response),
      [{ results: [{ itemId: 101 }] }, { results: [{ itemId: 102 }] }],
    );
  });

  it("does not replay a function response after a corrected final answer", async function () {
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
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            body: undefined,
            json: async () => ({
              candidates: [
                {
                  content: {
                    parts:
                      callCount === 1
                        ? [
                            {
                              functionCall: {
                                name: "query_library",
                                args: { query: "methods" },
                              },
                            },
                          ]
                        : callCount === 2
                          ? [
                              {
                                text: "Need more evidence.",
                                thought: true,
                                thoughtSignature: "sig-final-reasoning",
                              },
                              { text: "Premature comparison." },
                            ]
                          : [
                              {
                                text: "Corrected comparison.",
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

    const request = makeRequest();
    const messages: AgentModelMessage[] = [
      { role: "user", content: "Compare these papers" },
    ];
    const firstStep = await adapter.runStep({ request, messages, tools });
    assert.equal(firstStep.kind, "tool_calls");
    if (firstStep.kind !== "tool_calls") return;
    const toolResultMessage: AgentModelMessage = {
      role: "tool",
      tool_call_id: firstStep.calls[0].id,
      name: firstStep.calls[0].name,
      content: '{"results":[{"itemId":101},{"itemId":102}]}',
    };
    messages.push(firstStep.assistantMessage, toolResultMessage);

    const secondStep = await adapter.runStep({
      request,
      messages,
      continuationMessages: [toolResultMessage],
      tools,
    });
    assert.equal(secondStep.kind, "final");
    if (secondStep.kind !== "final") return;
    assert.notInclude(
      JSON.stringify(secondStep.assistantMessage),
      "sig-final-reasoning",
    );
    const correctionMessage: AgentModelMessage = {
      role: "user",
      content: "Correction for this turn: retrieve body evidence first.",
    };
    messages.push(secondStep.assistantMessage, correctionMessage);

    await adapter.runStep({
      request,
      messages,
      continuationMessages: [correctionMessage],
      tools,
    });

    const thirdContents = requestBodies[2]?.contents as Array<{
      role?: string;
      parts?: Array<Record<string, unknown>>;
    }>;
    assert.deepEqual(
      thirdContents.map((message) => message.role),
      ["user", "model", "user", "model", "user"],
    );
    const functionResponses = thirdContents.flatMap(
      (message) =>
        message.parts?.map((part) => part.functionResponse).filter(Boolean) ||
        [],
    );
    assert.lengthOf(functionResponses, 1);
    assert.property(thirdContents[1]?.parts?.[0] || {}, "functionCall");
    assert.property(thirdContents[2]?.parts?.[0] || {}, "functionResponse");
    assert.deepEqual(thirdContents[3]?.parts?.[0], {
      text: "Need more evidence.",
      thought: true,
      thoughtSignature: "sig-final-reasoning",
    });
    assert.equal(thirdContents[3]?.parts?.[1]?.text, "Premature comparison.");
    assert.equal(
      thirdContents[4]?.parts?.[0]?.text,
      "Correction for this turn: retrieve body evidence first.",
    );
  });

  it("keeps a signed final answer part in the answer channel", async function () {
    const adapter = new GeminiNativeAgentAdapter();
    let callCount = 0;
    const reasoning: string[] = [];
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name !== "fetch") return undefined;
        return async () => {
          callCount += 1;
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            body: makeSseStream([
              'data: {"candidates":[{"content":{"parts":[{"text":"Signed final.","thoughtSignature":"sig-final"}]}}]}\n\n',
            ]),
            json: async () => ({
              candidates: [
                {
                  content: {
                    parts: [
                      { text: "Signed final.", thoughtSignature: "sig-final" },
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
      request: makeRequest({ model: "gemini-3.6-flash" }),
      messages: [{ role: "user", content: "Summarize it" }],
      tools,
      onReasoning: async (event) => {
        if (event.details) reasoning.push(event.details);
      },
    });

    assert.equal(callCount, 1);
    assert.equal(step.kind, "final");
    if (step.kind !== "final") return;
    assert.equal(step.text, "Signed final.");
    assert.deepEqual(reasoning, []);
  });

  it("preserves parallel function calls split across stream chunks", async function () {
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
              body: makeSseStream([
                'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read_paper","args":{"itemId":1}},"thoughtSignature":"sig-1"}]}}]}\n\n',
                'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"query_library","args":{"query":"attention"}}}]}}]}\n\n',
              ]),
              json: async () => ({}),
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
              candidates: [{ content: { parts: [{ text: "Done." }] } }],
            }),
            text: async () => "",
          };
        };
      },
    };

    const stepTools: ToolSpec[] = [
      {
        name: "read_paper",
        description: "read",
        inputSchema: { type: "object" },
        mutability: "read",
        requiresConfirmation: false,
      },
      {
        name: "query_library",
        description: "search",
        inputSchema: { type: "object" },
        mutability: "read",
        requiresConfirmation: false,
      },
    ];
    const firstStep = await adapter.runStep({
      request: makeRequest({ model: "gemini-3.6-flash" }),
      messages: [{ role: "user", content: "Check the paper and the library" }],
      tools: stepTools,
    });

    assert.equal(firstStep.kind, "tool_calls");
    if (firstStep.kind !== "tool_calls") return;
    assert.deepEqual(
      firstStep.calls.map((call) => call.name),
      ["read_paper", "query_library"],
    );
    assert.notEqual(firstStep.calls[0].id, firstStep.calls[1].id);

    const secondStep = await adapter.runStep({
      request: makeRequest({ model: "gemini-3.6-flash" }),
      messages: [
        { role: "user", content: "Check the paper and the library" },
        firstStep.assistantMessage,
        {
          role: "tool",
          tool_call_id: firstStep.calls[0].id,
          name: firstStep.calls[0].name,
          content: JSON.stringify({ ok: true }),
        },
        {
          role: "tool",
          tool_call_id: firstStep.calls[1].id,
          name: firstStep.calls[1].name,
          content: JSON.stringify({ results: [] }),
        },
      ],
      tools: stepTools,
    });

    assert.equal(secondStep.kind, "final");
    const contents =
      (secondRequestBody?.contents as Array<{
        role?: string;
        parts?: Array<Record<string, unknown>>;
      }>) || [];
    const modelParts = contents[1]?.parts || [];
    assert.deepEqual(
      modelParts
        .map((part) => part.functionCall as Record<string, unknown>)
        .filter(Boolean)
        .map((call) => call.name),
      ["read_paper", "query_library"],
    );
    assert.equal(modelParts[0]?.thoughtSignature, "sig-1");
  });

  it("reattaches thought signatures when rebuilding history after resetState", async function () {
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
                          },
                          thoughtSignature: "sig-123",
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
              candidates: [{ content: { parts: [{ text: "Done." }] } }],
            }),
            text: async () => "",
          };
        };
      },
    };

    const stepTools: ToolSpec[] = [
      {
        name: "read_paper",
        description: "read",
        inputSchema: { type: "object" },
        mutability: "read",
        requiresConfirmation: false,
      },
    ];
    const firstStep = await adapter.runStep({
      request: makeRequest({ model: "gemini-3.6-flash" }),
      messages: [{ role: "user", content: "Inspect this paper" }],
      tools: stepTools,
    });

    assert.equal(firstStep.kind, "tool_calls");
    if (firstStep.kind !== "tool_calls") return;

    // Mid-turn prompt compaction wipes the adapter's cached conversation.
    adapter.resetState();

    const secondStep = await adapter.runStep({
      request: makeRequest({ model: "gemini-3.6-flash" }),
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
      tools: stepTools,
    });

    assert.equal(secondStep.kind, "final");
    const contents =
      (secondRequestBody?.contents as Array<{
        role?: string;
        parts?: Array<Record<string, unknown>>;
      }>) || [];
    const modelParts = contents[1]?.parts || [];
    const functionCallPart = modelParts.find((part) => part.functionCall);
    assert.isDefined(functionCallPart);
    assert.equal(functionCallPart?.thoughtSignature, "sig-123");
  });

  it("sends a user-authored reasoning level on the wire", async function () {
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
              candidates: [{ content: { parts: [{ text: "done" }] } }],
            }),
            text: async () => "",
          };
        };
      },
    };

    const model = "gemini-3-pro";
    await adapter.runStep({
      request: makeRequest({
        model,
        reasoning: { provider: "gemini", level: "ultra" as never },
        advanced: {
          profileOverride: computeProfileOverrideDraft({
            rows: [{ id: "ultra" }],
            extraJson: "",
            detected: getModelCapabilities({
              provider: "gemini",
              model,
              protocol: "gemini_native",
            }),
            modelName: model,
          }).override,
        },
      }),
      messages: [{ role: "user", content: "Inspect this paper" }],
      tools: [],
    });

    // The editor promises the plugin owns the encoding, so a level the user
    // typed has to arrive in the shape Gemini reads.  A flat reasoning_effort
    // is not one: this builder would drop it and quietly think at the default
    // level while the menu claimed "ultra".
    const generationConfig = capturedBody?.generationConfig as Record<
      string,
      unknown
    >;
    const thinkingConfig = generationConfig?.thinkingConfig as Record<
      string,
      unknown
    >;
    assert.equal(thinkingConfig?.thinkingLevel, "ultra");
    assert.notInclude(JSON.stringify(capturedBody), "reasoning_effort");
    assert.equal(
      thinkingConfig?.includeThoughts,
      true,
      "customizing the level must not silently cost the user the thought stream",
    );
  });

  it("preserves explicit output above detected limits", async function () {
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
              candidates: [{ content: { parts: [{ text: "done" }] } }],
            }),
            text: async () => "",
          };
        };
      },
    };

    await adapter.runStep({
      request: makeRequest({
        advanced: {
          maxTokens: 200_000,
          maxTokensExplicit: true,
          profileOverride: {
            forModel: "gemini-2.5-pro",
            limits: { outputTokens: 64_000 },
          },
        },
      }),
      messages: [{ role: "user", content: "Inspect this paper" }],
      tools: [],
    });

    const generationConfig = capturedBody?.generationConfig as Record<
      string,
      unknown
    >;
    assert.equal(generationConfig.maxOutputTokens, 200_000);
  });
});
