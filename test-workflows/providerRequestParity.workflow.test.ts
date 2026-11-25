import { assert } from "chai";
import { DOCUMENT_CONTEXT_POINTER } from "../src/utils/documentContextMessages";
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

  // Issue #497: paper text once travelled only in the system channel. A relay
  // that never passes that channel to the model left it with no paper, and a
  // chat that already held "I have no paper" answers kept getting them.
  const CAPTION_CODE = "CONTEXT-CHECK-62481";
  const QUESTION = "Explain Figure 4.";
  const PAPER_CONTEXT = [
    "Full Paper Contexts:",
    "",
    "Paper 1",
    "Title: Workflow context delivery check",
    "",
    "Paper Text:",
    `Figure 4 caption: The experiment code is ${CAPTION_CODE}. The measured result is 73.6 units.`,
  ].join("\n");
  // Long enough for a provider cache plan, which needs at least 1024 tokens.
  const LONG_PAPER_CONTEXT = `${PAPER_CONTEXT}\n${"An invented sentence about the invented result. ".repeat(150)}`;
  const EARLIER_TURN = [
    { role: "user" as const, content: "What is this paper about?" },
    { role: "assistant" as const, content: "It is an invented paper." },
  ];

  function textOf(content: unknown): string {
    if (typeof content === "string") return content;
    return (content as Array<{ text?: string }>)
      .map((part) => part.text || "")
      .join("\n");
  }

  function documentRequest(
    overrides: Partial<
      Parameters<WorkflowTestApi["sendDocumentContextRequest"]>[0]
    >,
  ): Parameters<WorkflowTestApi["sendDocumentContextRequest"]>[0] {
    return {
      conversationKey: -497,
      apiBase: "https://relay-497.example/v1",
      apiKey: "workflow-dummy-key",
      model: "relay-497-model",
      providerProtocol: "openai_chat_compat",
      prompt: QUESTION,
      context: PAPER_CONTEXT,
      contextMode: "full",
      ...overrides,
    };
  }

  it("delivers paper text to a chat-compatible provider that ignores system messages", async function () {
    const request = documentRequest({});
    const fake = installFakeProvider(request.apiBase, ({ body }) => {
      // Like the reported relay: the model only ever sees the other roles.
      const delivered = (body.messages || [])
        .filter((message: { role: string }) => message.role !== "system")
        .some((message: { content: unknown }) =>
          textOf(message.content).includes(CAPTION_CODE),
        );
      return {
        ok: true,
        status: 200,
        body: {
          choices: [
            {
              message: {
                role: "assistant",
                content: delivered ? "OK" : "NO PAPER",
              },
              finish_reason: "stop",
            },
          ],
        },
      };
    });
    try {
      const api = (Zotero as any).LLMForZotero.api
        .workflowTest as WorkflowTestApi;
      const result = await api.sendDocumentContextRequest(request);
      assert.deepEqual(result, { chat: "OK", stream: "OK" });
      assert.isAtLeast(fake.requests.length, 2);
      for (const sent of fake.requests) {
        const systems = sent.body.messages.filter(
          (message: { role: string }) => message.role === "system",
        );
        assert.lengthOf(systems, 1, "one system message per request");
        assert.notInclude(
          systems[0].content,
          CAPTION_CODE,
          "paper text stays out of the system message",
        );
        const last = sent.body.messages[sent.body.messages.length - 1];
        assert.equal(last.role, "user");
        assert.isString(
          last.content,
          "a text-only turn stays a plain string for relays that reject parts",
        );
        assert.include(last.content, "Document Context:");
        assert.include(last.content, CAPTION_CODE);
        assert.include(last.content, QUESTION);
      }
    } finally {
      fake.restore();
    }
  });

  it("keeps paper text out of the Anthropic system field and the Responses instructions", async function () {
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    const anthropic = documentRequest({
      apiBase: "https://anthropic-relay-497.example",
      model: "relay-497-messages-model",
      providerProtocol: "anthropic_messages",
    });
    const anthropicFake = installFakeProvider(anthropic.apiBase, () => ({
      ok: true,
      status: 200,
      body: {
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
      },
    }));
    try {
      await api.sendDocumentContextRequest(anthropic);
      const sent = anthropicFake.requests.filter(
        (request) => request.body.messages,
      );
      assert.isAtLeast(sent.length, 2);
      for (const { body } of sent) {
        assert.notInclude(JSON.stringify(body.system ?? ""), CAPTION_CODE);
        const last = body.messages[body.messages.length - 1];
        assert.equal(last.role, "user");
        assert.include(textOf(last.content), CAPTION_CODE);
        assert.include(textOf(last.content), QUESTION);
      }
    } finally {
      anthropicFake.restore();
    }

    const responses = documentRequest({
      apiBase: "https://responses-relay-497.example/v1",
      model: "relay-497-responses-model",
      providerProtocol: "responses_api",
    });
    const responsesFake = installFakeProvider(responses.apiBase, () => ({
      ok: true,
      status: 200,
      body: responsesReply,
    }));
    try {
      await api.sendDocumentContextRequest(responses);
      const sent = responsesFake.requests.filter(
        (request) => request.body.input,
      );
      assert.isAtLeast(sent.length, 2);
      for (const { body } of sent) {
        assert.notInclude(String(body.instructions ?? ""), CAPTION_CODE);
        const last = body.input[body.input.length - 1];
        assert.equal(last.role, "user");
        assert.include(textOf(last.content), CAPTION_CODE);
        assert.include(textOf(last.content), QUESTION);
      }
    } finally {
      responsesFake.restore();
    }
  });

  it("sends retrieved snippets with the question they were chosen for", function () {
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    const prepared = api.prepareDocumentContextRequest(
      documentRequest({ contextMode: "retrieval", history: EARLIER_TURN }),
    );
    const users = prepared.messages.filter(
      (message) => message.role === "user",
    );
    assert.lengthOf(users, 2);
    assert.equal(textOf(users[0].content), EARLIER_TURN[0].content);
    const current = textOf(users[1].content);
    assert.include(current, "Document Context:");
    assert.include(current, CAPTION_CODE);
    assert.include(current, QUESTION);
    assert.isBelow(
      current.indexOf(CAPTION_CODE),
      current.indexOf(QUESTION),
      "the snippets come before the question",
    );
  });

  it("anchors a full paper in the first user message and points to it from the question", async function () {
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    // A full paper is resent on every turn. It has to sit in the same place
    // each time for a provider's prefix cache, such as DeepSeek's, to reuse it.
    const request = documentRequest({
      apiBase: "https://api.deepseek.com/anthropic",
      model: "deepseek-flash",
      providerProtocol: "anthropic_messages",
      context: LONG_PAPER_CONTEXT,
      history: EARLIER_TURN,
    });
    const fake = installFakeProvider(request.apiBase, () => ({
      ok: true,
      status: 200,
      body: {
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
      },
    }));
    try {
      await api.sendDocumentContextRequest(request);
      const sent = fake.requests.filter((entry) => entry.body.messages);
      assert.isAtLeast(sent.length, 2);
      for (const { body } of sent) {
        assert.notInclude(JSON.stringify(body.system ?? ""), CAPTION_CODE);
        const first = body.messages[0];
        assert.equal(first.role, "user");
        assert.match(first.content[0].text, /^Document Context:\n/);
        assert.include(first.content[0].text, CAPTION_CODE);
        assert.equal(
          first.content[first.content.length - 1].text,
          EARLIER_TURN[0].content,
          "the first question follows the paper unchanged",
        );
        const last = body.messages[body.messages.length - 1];
        assert.equal(last.role, "user");
        const current = textOf(last.content);
        assert.equal(
          current,
          `${DOCUMENT_CONTEXT_POINTER}\n\n${QUESTION}`,
          "the paper is sent once, and the question says where it is",
        );
      }
      // Same paper, next turn: everything up to the paper is byte-identical,
      // which is what a prefix cache needs.
      const nextTurn = api.prepareDocumentContextRequest({
        ...request,
        prompt: "And Figure 5?",
        history: [
          ...EARLIER_TURN,
          { role: "user", content: QUESTION },
          { role: "assistant", content: "It reports the experiment code." },
        ],
      });
      const thisTurn = api.prepareDocumentContextRequest(request);
      const firstUser = (messages: typeof thisTurn.messages) =>
        messages.find((message) => message.role === "user");
      assert.deepEqual(
        firstUser(nextTurn.messages),
        firstUser(thisTurn.messages),
      );
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
