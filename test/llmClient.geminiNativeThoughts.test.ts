import { assert } from "chai";
import { callLLM, callLLMStream } from "../src/utils/llmClient";

describe("llmClient gemini native thought parts", function () {
  const originalZotero = globalThis.Zotero;
  const originalToolkit = (
    globalThis as typeof globalThis & { ztoolkit?: unknown }
  ).ztoolkit;

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

  function mockGeminiFetch(
    handlers: {
      stream?: () => ReadableStream<Uint8Array>;
      json?: () => unknown;
    },
    onRequestBody?: (body: Record<string, unknown>) => void,
  ) {
    const requestedUrls: string[] = [];
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown; log: () => void };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name !== "fetch") return undefined;
        return async (url: string, init?: RequestInit) => {
          requestedUrls.push(url);
          if (onRequestBody) {
            onRequestBody(
              JSON.parse(String(init?.body || "{}")) as Record<string, unknown>,
            );
          }
          if (url.includes(":streamGenerateContent") && handlers.stream) {
            return {
              ok: true,
              status: 200,
              statusText: "OK",
              body: handlers.stream(),
              json: async () => ({}),
              text: async () => "",
            };
          }
          if (url.includes(":generateContent") && handlers.json) {
            return {
              ok: true,
              status: 200,
              statusText: "OK",
              json: async () => handlers.json!(),
              text: async () => "",
            };
          }
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({}),
            text: async () => "",
          };
        };
      },
      log: () => undefined,
    };
    return requestedUrls;
  }

  beforeEach(function () {
    const prefStore = new Map<string, unknown>();
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Prefs: {
        get: (key: string) => prefStore.get(key) ?? "",
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      },
    } as typeof Zotero;
  });

  after(function () {
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
    (
      globalThis as typeof globalThis & { ztoolkit?: typeof originalToolkit }
    ).ztoolkit = originalToolkit;
  });

  it("streams thought parts into onReasoning instead of the answer", async function () {
    mockGeminiFetch({
      stream: () =>
        makeSseStream([
          'data: {"candidates":[{"content":{"parts":[{"text":"Considering the request.","thought":true}]}}]}\n\n',
          'data: {"candidates":[{"content":{"parts":[{"text":"Final "},{"text":"answer."}]}}]}\n\n',
          'data: {"candidates":[{"content":{"parts":[{"text":"","thoughtSignature":"sig-tail"}]}}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15}}\n\n',
        ]),
    });

    const deltas: string[] = [];
    const reasoning: string[] = [];
    const result = await callLLMStream(
      {
        prompt: "Summarize the paper.",
        model: "gemini-3.6-flash",
        apiBase: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "gemini-test",
        providerProtocol: "gemini_native",
      },
      (delta) => {
        deltas.push(delta);
      },
      (event) => {
        if (event.details) reasoning.push(event.details);
      },
    );

    assert.equal(result, "Final answer.");
    assert.equal(deltas.join(""), "Final answer.");
    assert.equal(reasoning.join(""), "Considering the request.");
  });

  it("keeps answer text that carries a thoughtSignature in the streamed answer", async function () {
    mockGeminiFetch({
      stream: () =>
        makeSseStream([
          'data: {"candidates":[{"content":{"parts":[{"text":"Signed answer.","thoughtSignature":"sig-1"}]}}]}\n\n',
        ]),
    });

    const deltas: string[] = [];
    const reasoning: string[] = [];
    const result = await callLLMStream(
      {
        prompt: "Summarize the paper.",
        model: "gemini-3.6-flash",
        apiBase: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "gemini-test",
        providerProtocol: "gemini_native",
      },
      (delta) => {
        deltas.push(delta);
      },
      (event) => {
        if (event.details) reasoning.push(event.details);
      },
    );

    assert.equal(result, "Signed answer.");
    assert.equal(deltas.join(""), "Signed answer.");
    assert.equal(reasoning.join(""), "");
  });

  it("drops thought parts from non-streaming answers", async function () {
    mockGeminiFetch({
      json: () => ({
        candidates: [
          {
            content: {
              parts: [
                { text: "Plan quietly.", thought: true },
                { text: "Visible answer.", thoughtSignature: "sig-1" },
              ],
            },
          },
        ],
      }),
    });

    const output = await callLLM({
      prompt: "Summarize the paper.",
      model: "gemini-3.6-flash",
      apiBase: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "gemini-test",
      providerProtocol: "gemini_native",
    });

    assert.equal(output, "Visible answer.");
  });

  it("sends a user-authored reasoning level, thought summaries intact", async function () {
    let body: Record<string, unknown> = {};
    mockGeminiFetch(
      {
        json: () => ({
          candidates: [{ content: { parts: [{ text: "Answer." }] } }],
        }),
      },
      (captured) => {
        body = captured;
      },
    );

    await callLLM({
      prompt: "Summarize the paper.",
      model: "gemini-3.6-flash",
      apiBase: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "gemini-test",
      providerProtocol: "gemini_native",
      reasoning: { provider: "gemini", level: "ultra" as never },
      profileOverride: {
        forModel: "gemini-3.6-flash",
        reasoning: {
          kind: "select",
          options: [
            {
              id: "ultra",
              label: "ultra",
              enabled: true,
              controls: {
                body: { thinkingConfig: { thinkingLevel: "ultra" } },
              },
            },
          ],
        },
      },
    });

    // The chat path builds its own Gemini payload, so it needs the same two
    // guarantees as the agent adapter: the customized level travels, and
    // declaring one does not turn the thought stream off.
    const generationConfig = body.generationConfig as Record<string, unknown>;
    const thinkingConfig = generationConfig?.thinkingConfig as Record<
      string,
      unknown
    >;
    assert.equal(thinkingConfig?.thinkingLevel, "ultra");
    assert.equal(thinkingConfig?.includeThoughts, true);
  });
});
