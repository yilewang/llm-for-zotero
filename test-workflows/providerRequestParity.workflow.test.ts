import { assert } from "chai";
import { setModelProviderGroups } from "../src/utils/modelProviders";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

// Plain chat, Agent mode and the settings Test button each build their own
// provider requests. A provider that works in one must work in the others:
// these tests pin the places where they once disagreed.
describe("workflow: provider requests agree across chat, Agent mode and Test", function () {
  this.timeout(30000);

  type FakeReply = { ok: boolean; status: number; body: unknown };
  type SentRequest = { url: string; body: any };

  function installFakeProvider(
    apiBase: string,
    reply: (request: SentRequest) => FakeReply,
  ): { requests: SentRequest[]; restore: () => void } {
    const toolkit = (Zotero as any).LLMForZotero.data.ztoolkit;
    const originalGetGlobal = toolkit.getGlobal;
    const requests: SentRequest[] = [];
    toolkit.getGlobal = function (name: string) {
      if (name !== "fetch") return originalGetGlobal.call(this, name);
      return async (url: string, init?: RequestInit) => {
        const target = String(url);
        if (!target.startsWith(apiBase))
          throw new Error(
            `Unexpected network destination in isolated provider workflow: ${target}`,
          );
        const request = {
          url: target,
          body: JSON.parse(String(init?.body || "{}")),
        };
        requests.push(request);
        const { ok, status, body } = reply(request);
        return {
          ok,
          status,
          statusText: "",
          body: null,
          headers: { get: () => "application/json" },
          json: async () => body,
          text: async () => JSON.stringify(body),
        };
      };
    };
    return {
      requests,
      restore: () => {
        toolkit.getGlobal = originalGetGlobal;
      },
    };
  }

  const responsesReply = {
    status: "completed",
    output_text: "OK",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "OK" }],
      },
    ],
  };

  // Issue #574: a custom relay whose model is set to the Responses API gets
  // Responses requests in plain chat; Agent mode once switched it to
  // /chat/completions, which such a relay does not serve.
  it("keeps a custom relay's Responses API protocol in Agent mode", async function () {
    const apiBase = "https://relay-574.example/v1";
    const fake = installFakeProvider(apiBase, ({ url }) =>
      url === `${apiBase}/responses`
        ? { ok: true, status: 200, body: responsesReply }
        : {
            ok: false,
            status: 404,
            body: { error: { message: `Invalid URL (POST ${url})` } },
          },
    );
    try {
      const api = (Zotero as any).LLMForZotero.api
        .workflowTest as WorkflowTestApi;
      const result = await api.checkProviderConversationTransport({
        conversationKey: -57400574,
        apiBase,
        apiKey: "workflow-dummy-key",
        model: "gpt-6.1-sol",
        providerProtocol: "responses_api",
      });
      assert.deepEqual(result, {
        chat: "OK",
        stream: "OK",
        agent: "OK",
        continuation: "OK",
      });
      assert.isNotEmpty(fake.requests);
      assert.deepEqual(
        fake.requests
          .map((request) => request.url)
          .filter((url) => url !== `${apiBase}/responses`),
        [],
        "every request goes to the relay's Responses endpoint",
      );
    } finally {
      fake.restore();
    }
  });

  // SiliconFlow (error code 20015) and servers using chat templates such as
  // Qwen's accept one system message, and only as the first message. Plain
  // chat joined its system messages; Agent mode sent each one separately.
  it("sends one leading system message to chat-compatible providers in Agent mode", async function () {
    const apiBase = "https://api.siliconflow.cn/v1";
    const fake = installFakeProvider(apiBase, ({ body }) => {
      const roles: string[] = (body.messages || []).map(
        (message: { role: string }) => message.role,
      );
      const misplaced = roles.some(
        (role, index) => role === "system" && index > 0,
      );
      return misplaced
        ? {
            ok: false,
            status: 400,
            body: {
              code: 20015,
              message:
                '"messages" in request are illegal: System message must be at the beginning...',
              data: null,
            },
          }
        : {
            ok: true,
            status: 200,
            body: {
              choices: [
                {
                  message: { role: "assistant", content: "OK" },
                  finish_reason: "stop",
                },
              ],
            },
          };
    });
    try {
      const api = (Zotero as any).LLMForZotero.api
        .workflowTest as WorkflowTestApi;
      const result = await api.checkProviderConversationTransport({
        conversationKey: -20015,
        apiBase,
        apiKey: "workflow-dummy-key",
        model: "Qwen/Qwen3-8B",
        providerProtocol: "openai_chat_compat",
      });
      assert.deepEqual(result, {
        chat: "OK",
        stream: "OK",
        agent: "OK",
        continuation: "OK",
      });
      for (const request of fake.requests) {
        const systems = request.body.messages.filter(
          (message: { role: string }) => message.role === "system",
        );
        assert.lengthOf(systems, 1, "one system message per request");
        assert.include(
          systems[0].content,
          "Paper context for the transport check.",
          "the joined system message keeps every block",
        );
      }
    } finally {
      fake.restore();
    }
  });

  // Issue #574, second report: a relay that requires a parameter the user put
  // in the model's extra JSON (here `prompt_cache_key`) answers chat, because
  // chat sends that JSON, but the Test button once left it out.
  it("sends the model's extra JSON in the settings Test request", async function () {
    const prefix = "extensions.zotero.llmforzotero.";
    const keys = [
      "modelProviderGroups",
      "modelProviderGroupsMigrationVersion",
      "lastUsedModelEntryId",
      "outputTokenAutoMigrationNoticePending",
    ];
    const previous = new Map(
      keys.map((key) => [key, Zotero.Prefs.get(prefix + key, true)]),
    );
    const apiBase = "https://relay-574-cache.example/v1";
    const fake = installFakeProvider(apiBase, ({ body }) =>
      body.prompt_cache_key
        ? { ok: true, status: 200, body: responsesReply }
        : {
            ok: false,
            status: 400,
            body: { error: { message: "prompt_cache_key is required" } },
          },
    );
    let win: Window | undefined;
    const waitFor = async (condition: () => boolean, message: string) => {
      const deadline = Date.now() + 10000;
      while (!condition() && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 50));
      assert.isTrue(condition(), message);
    };
    try {
      setModelProviderGroups([
        {
          id: "workflow-relay-cache",
          authMode: "api_key",
          apiBase,
          apiKey: "workflow-dummy-key",
          providerProtocol: "responses_api",
          models: [
            {
              id: "workflow-relay-cache-model",
              model: "gpt-6.1-sol",
              providerProtocol: "responses_api",
              temperature: 0.3,
              outputTokenLimit: { mode: "auto" },
              profileOverride: {
                forModel: "gpt-6.1-sol",
                extraBody: { prompt_cache_key: "zotero-workflow" },
              },
            },
          ],
        },
      ]);
      win = (Zotero.Utilities.Internal as any).openPreferences(
        "llmforzotero-preferences",
      );
      await waitFor(
        () =>
          Boolean(
            win?.document.querySelector(
              '[data-llm-provider-row="workflow-relay-cache"]',
            ),
          ),
        "relay provider preferences render",
      );
      const row = win!.document.querySelector(
        '[data-llm-provider-row="workflow-relay-cache"]',
      )!;
      const button = (
        Array.from(
          row.querySelectorAll<HTMLButtonElement>("button"),
        ) as HTMLButtonElement[]
      ).find((b) => b.textContent?.trim() === "Test")!;
      assert.isOk(button, "real settings Test button exists");
      button.click();
      await waitFor(
        () => fake.requests.length > 0 && !button.disabled,
        "settings test completes",
      );
      assert.notInclude(row.textContent!, "prompt_cache_key is required");
      assert.include(row.textContent!, "Success");
      assert.equal(
        fake.requests[0].body.prompt_cache_key,
        "zotero-workflow",
        "the connection request carries the extra JSON",
      );
    } finally {
      fake.restore();
      if (win && !win.closed) win.close();
      for (const [key, value] of previous) {
        if (value === undefined) Zotero.Prefs.clear(prefix + key, true);
        else Zotero.Prefs.set(prefix + key, value, true);
      }
    }
  });
});
