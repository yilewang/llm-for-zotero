import { assert } from "chai";
import {
  runProviderConnectionTest,
  runProviderSettingsChecks,
} from "../src/utils/providerConnectionTest";
import { callLLM, callLLMStream } from "../src/utils/llmClient";
import { createAgentModelAdapter } from "../src/agent/model/factory";
import type { AgentRuntimeRequest } from "../src/agent/types";
import { createProviderRequestScope } from "../src/utils/providerTransport";
import {
  providerSupportsFileUploads,
  getProviderPreset,
} from "../src/utils/providerPresets";

const base = "https://opencode.ai/zen/go/v1";
const protocols = getProviderPreset("opencode_go").supportedProtocols;

describe("provider request contract across product entry points", function () {
  const originalZotero = globalThis.Zotero;
  const globals = globalThis as typeof globalThis & { ztoolkit?: unknown };
  const originalToolkit = globals.ztoolkit;
  let requests: Array<{
    url: string;
    headers: Headers;
    body: Record<string, unknown>;
  }>;
  let fetchFn: typeof fetch;
  let toolReply: boolean;
  let streamReplies: boolean;

  beforeEach(function () {
    requests = [];
    toolReply = false;
    streamReplies = false;
    const prefs = new Map<string, unknown>();
    globalThis.Zotero = {
      Prefs: {
        get: (key: string) => prefs.get(key) ?? "",
        set: (key: string, value: unknown) => prefs.set(key, value),
      },
    } as unknown as typeof Zotero;
    fetchFn = (async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      const body = JSON.parse(String(init.body));
      requests.push({ url: String(url), headers, body });
      if (!headers.get("x-opencode-session")) {
        return new Response(
          JSON.stringify({ error: { type: "MissingSessionID" } }),
          { status: 400 },
        );
      }
      let response: unknown = String(url).endsWith("/messages")
        ? { content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" }
        : String(url).endsWith("/responses")
          ? {
              status: "completed",
              output_text: "OK",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "OK" }],
                },
              ],
            }
          : {
              choices: [
                {
                  message: { role: "assistant", content: "OK" },
                  finish_reason: "stop",
                },
              ],
            };
      if (toolReply) {
        toolReply = false;
        response = String(url).endsWith("/messages")
          ? {
              content: [
                {
                  type: "tool_use",
                  id: "call_read",
                  name: "read_paper",
                  input: {},
                },
              ],
              stop_reason: "tool_use",
            }
          : String(url).endsWith("/responses")
            ? {
                status: "completed",
                output: [
                  {
                    type: "function_call",
                    call_id: "call_read",
                    name: "read_paper",
                    arguments: "{}",
                  },
                ],
              }
            : {
                choices: [
                  {
                    message: {
                      role: "assistant",
                      content: null,
                      tool_calls: [
                        {
                          id: "call_read",
                          type: "function",
                          function: { name: "read_paper", arguments: "{}" },
                        },
                      ],
                    },
                    finish_reason: "tool_calls",
                  },
                ],
              };
      } else if (streamReplies && body.stream) {
        const events = String(url).endsWith("/messages")
          ? [
              {
                type: "message_start",
                message: { role: "assistant", content: [] },
              },
              {
                type: "content_block_start",
                index: 0,
                content_block: { type: "text", text: "" },
              },
              {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: "OK" },
              },
              { type: "content_block_stop", index: 0 },
              { type: "message_delta", delta: { stop_reason: "end_turn" } },
              { type: "message_stop" },
            ]
          : String(url).endsWith("/responses")
            ? [
                { type: "response.output_text.delta", delta: "OK" },
                { type: "response.completed", response },
              ]
            : [
                {
                  choices: [
                    { delta: { content: "OK" }, finish_reason: "stop" },
                  ],
                },
              ];
        return new Response(
          events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      // A JSON response also exercises the adapters' non-stream fallback.
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        body: null,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => response,
        text: async () => JSON.stringify(response),
      } as Response;
    }) as typeof fetch;
    globals.ztoolkit = {
      getGlobal: (name: string) => (name === "fetch" ? fetchFn : undefined),
      log: () => undefined,
    };
  });

  afterEach(function () {
    globalThis.Zotero = originalZotero;
    globals.ztoolkit = originalToolkit;
  });

  function assertContract() {
    assert.isNotEmpty(requests);
    for (const request of requests) {
      assert.match(
        request.headers.get("x-opencode-session") || "",
        /^[a-zA-Z0-9-]{16,}$/,
      );
      assert.match(
        request.headers.get("user-agent") || "",
        /^llm-for-zotero\//,
      );
      assert.equal(
        request.headers.get(
          request.url.endsWith("/messages") ? "x-api-key" : "authorization",
        ),
        request.url.endsWith("/messages") ? "test-key" : "Bearer test-key",
      );
    }
  }

  for (const protocol of protocols) {
    it(`settings Test sends required headers over ${protocol}`, async function () {
      await runProviderConnectionTest({
        fetchFn,
        protocol,
        authMode: "api_key",
        apiBase: base,
        apiKey: "test-key",
        modelName: "deepseek-v4-flash",
      });
      assertContract();
    });

    it(`agent turns preserve session and selected ${protocol}`, async function () {
      const request: AgentRuntimeRequest = {
        conversationKey: 439,
        mode: "agent",
        userText: "Say OK",
        model: "deepseek-v4-flash",
        apiBase: base,
        apiKey: "test-key",
        providerProtocol: protocol,
      };
      const adapter = createAgentModelAdapter(request);
      const messages = [{ role: "user" as const, content: "Say OK" }];
      toolReply = true;
      const tools = [
        {
          name: "read_paper",
          description: "Read paper",
          inputSchema: { type: "object" },
          executionClass: "read" as const,
          requiresConfirmation: false,
        },
      ];
      const first = await adapter.runStep({ request, messages, tools });
      assert.equal(first.kind, "tool_calls");
      if (first.kind !== "tool_calls") return;
      const result = {
        role: "tool" as const,
        tool_call_id: "call_read",
        name: "read_paper",
        content: "Paper read.",
      };
      const last = await adapter.runStep({
        request,
        messages: [first.assistantMessage, result],
        continuationMessages: [result],
        tools,
      });
      assert.equal(last.kind, "final");
      assertContract();
      assert.equal(
        new Set(requests.map((r) => r.headers.get("x-opencode-session"))).size,
        1,
      );
      assert.isTrue(
        requests.every((r) =>
          r.url.endsWith(
            protocol === "anthropic_messages"
              ? "/messages"
              : protocol === "responses_api"
                ? "/responses"
                : "/chat/completions",
          ),
        ),
      );
    });

    for (const stream of [false, true]) {
      it(`standalone utility ${stream ? "stream" : "call"} sends required headers over ${protocol}`, async function () {
        const params = {
          prompt: "Say OK",
          apiBase: base,
          apiKey: "test-key",
          model: "deepseek-v4-flash",
          providerProtocol: protocol,
        };
        streamReplies = stream;
        const outcome = stream
          ? await callLLMStream(params, () => undefined)
          : await callLLM(params);
        assert.equal(outcome.text, "OK");
        assertContract();
        assert.equal(
          new Set(requests.map((r) => r.headers.get("x-opencode-session")))
            .size,
          1,
        );
      });
    }
  }

  it("custom settings probes share one operation session", async function () {
    const checks = await runProviderSettingsChecks({
      fetchFn,
      protocol: "openai_chat_compat",
      authMode: "api_key",
      apiBase: base,
      apiKey: "test-key",
      modelName: "deepseek-v4-flash",
      profileOverride: {
        forModel: "deepseek-v4-flash",
        extraBody: { top_p: 0.9 },
        reasoning: {
          kind: "select",
          options: [
            {
              id: "off",
              label: "off",
              enabled: true,
              controls: { body: { thinking: { type: "disabled" } } },
            },
          ],
        },
      },
    });
    assert.isTrue(
      checks.every((c) => c.ok),
      JSON.stringify(checks),
    );
    assert.lengthOf(requests, 2);
    assertContract();
    assert.equal(
      new Set(requests.map((r) => r.headers.get("x-opencode-session"))).size,
      1,
    );
  });
  it("chat and agent share a conversation session and isolate other conversations", async function () {
    const params = {
      prompt: "Say OK",
      apiBase: base,
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      requestScope: createProviderRequestScope(4439),
    };
    await callLLM(params);
    await callLLMStream(params, () => undefined);
    const request: AgentRuntimeRequest = {
      conversationKey: 4439,
      mode: "agent",
      userText: "Say OK",
      model: params.model,
      apiBase: base,
      apiKey: "test-key",
      providerProtocol: "openai_chat_compat",
    };
    await createAgentModelAdapter(request).runStep({
      request,
      messages: [{ role: "user", content: "Say OK" }],
      tools: [],
    });
    assert.equal(
      new Set(requests.map((r) => r.headers.get("x-opencode-session"))).size,
      1,
    );
    const first = requests[0].headers.get("x-opencode-session");
    await callLLM({
      ...params,
      requestScope: createProviderRequestScope(4440),
    });
    assert.notEqual(requests.at(-1)!.headers.get("x-opencode-session"), first);
  });

  it("temperature recovery keeps the operation session on every attempt", async function () {
    const normalFetch = fetchFn;
    const attempts: string[] = [];
    fetchFn = (async (url, init) => {
      attempts.push(new Headers(init?.headers).get("x-opencode-session") || "");
      if (attempts.length === 1)
        return new Response("temperature is not supported", { status: 400 });
      return normalFetch(url, init);
    }) as typeof fetch;
    await callLLM({
      prompt: "OK",
      apiBase: base,
      apiKey: "test-key",
      model: "retry-contract-model",
      temperature: 0.2,
    });
    assert.lengthOf(attempts, 2);
    assert.isNotEmpty(attempts[0]);
    assert.equal(attempts[0], attempts[1]);
  });

  it("OpenCode Responses support does not enable unsupported file uploads", function () {
    assert.isFalse(providerSupportsFileUploads(base));
    assert.isTrue(providerSupportsFileUploads("https://api.openai.com/v1"));
  });
});
