import { assert } from "chai";
import { getGeminiReasoningProfileForModel } from "../src/utils/reasoningProfiles";
import { callLLMStream } from "../src/utils/llmClient";
import { GeminiNativeAgentAdapter } from "../src/agent/model/geminiNative";
import type { AgentRuntimeRequest, ToolSpec } from "../src/agent/types";

describe("gemini 3.x reasoning profiles", function () {
  const originalZotero = globalThis.Zotero;
  const originalToolkit = (
    globalThis as typeof globalThis & { ztoolkit?: unknown }
  ).ztoolkit;

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

  it("gives gemini-3.6-flash a medium default with a minimal option", function () {
    const profile = getGeminiReasoningProfileForModel("gemini-3.6-flash");
    assert.equal(profile.param, "thinking_level");
    assert.equal(profile.defaultLevel, "medium");
    assert.equal(profile.levelToValue.minimal, "minimal");
    assert.include(
      profile.options.map((entry) => entry.level),
      "minimal",
    );
  });

  it("gives gemini-3.x flash-lite models a minimal default", function () {
    for (const model of ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]) {
      const profile = getGeminiReasoningProfileForModel(model);
      assert.equal(profile.param, "thinking_level", model);
      assert.equal(profile.defaultLevel, "minimal", model);
    }
  });

  it("gives gemini-3.x flash models a high default with a minimal option", function () {
    for (const model of ["gemini-3-flash-preview", "gemini-3.5-flash"]) {
      const profile = getGeminiReasoningProfileForModel(model);
      assert.equal(profile.defaultLevel, "high", model);
      assert.equal(profile.levelToValue.minimal, "minimal", model);
    }
  });

  it("gives gemini-3.1-pro medium support without minimal", function () {
    const profile = getGeminiReasoningProfileForModel("gemini-3.1-pro-preview");
    assert.equal(profile.defaultLevel, "high");
    assert.equal(profile.levelToValue.medium, "medium");
    assert.notProperty(profile.levelToValue, "minimal");
  });

  it("keeps gemini-3-pro-preview on its low/high ladder", function () {
    const profile = getGeminiReasoningProfileForModel("gemini-3-pro-preview");
    assert.equal(profile.defaultLevel, "high");
    assert.deepEqual(profile.options.map((entry) => entry.level).sort(), [
      "high",
      "low",
    ]);
  });

  function mockFetchCapturingBody(): { bodies: Record<string, unknown>[] } {
    const captured: { bodies: Record<string, unknown>[] } = { bodies: [] };
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown; log: () => void };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name !== "fetch") return undefined;
        return async (url: string, init?: RequestInit) => {
          if (url.includes("GenerateContent")) {
            captured.bodies.push(
              JSON.parse(String(init?.body || "{}")) as Record<string, unknown>,
            );
          }
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'data: {"candidates":[{"content":{"parts":[{"text":"OK"}]}}]}\n\n',
                  ),
                );
                controller.close();
              },
            }),
            json: async () => ({
              candidates: [{ content: { parts: [{ text: "OK" }] } }],
            }),
            text: async () => "",
          };
        };
      },
      log: () => undefined,
    };
    return captured;
  }

  function thinkingConfigOf(
    body: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    const generationConfig =
      (body?.generationConfig as Record<string, unknown>) || {};
    return (generationConfig.thinkingConfig as Record<string, unknown>) || {};
  }

  it("sends thinkingLevel minimal through the chat payload", async function () {
    const captured = mockFetchCapturingBody();
    await callLLMStream(
      {
        prompt: "Say hi.",
        model: "gemini-3.6-flash",
        apiBase: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "gemini-test",
        providerProtocol: "gemini_native",
        reasoning: { provider: "gemini", level: "minimal" },
      },
      () => undefined,
    );
    const thinkingConfig = thinkingConfigOf(captured.bodies[0]);
    assert.equal(thinkingConfig.thinkingLevel, "minimal");
    assert.equal(thinkingConfig.includeThoughts, true);
  });

  it("sends thinkingLevel minimal through the agent payload", async function () {
    const captured = mockFetchCapturingBody();
    const tools: ToolSpec[] = [
      {
        name: "query_library",
        description: "search",
        inputSchema: { type: "object" },
        mutability: "read",
        requiresConfirmation: false,
      },
    ];
    const request: AgentRuntimeRequest = {
      conversationKey: 1,
      mode: "agent",
      userText: "Inspect this",
      model: "gemini-3.6-flash",
      apiBase: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "gemini-test",
      providerProtocol: "gemini_native",
      reasoning: { provider: "gemini", level: "minimal" },
    };
    const adapter = new GeminiNativeAgentAdapter();
    await adapter.runStep({
      request,
      messages: [{ role: "user", content: "Summarize it" }],
      tools,
    });
    const thinkingConfig = thinkingConfigOf(captured.bodies[0]);
    assert.equal(thinkingConfig.thinkingLevel, "minimal");
  });
});
