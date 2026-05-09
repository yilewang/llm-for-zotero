import { assert } from "chai";

type RelayServerModule = typeof import("../src/webchat/relayServer");
type WebChatClientModule = typeof import("../src/webchat/client");

type EndpointReply = [number, string | Record<string, string>, string?];

function parseJsonReply(
  reply: EndpointReply | number,
): Record<string, unknown> {
  if (!Array.isArray(reply)) {
    throw new Error(`Unexpected endpoint reply: ${String(reply)}`);
  }
  return JSON.parse(reply[2] || "{}") as Record<string, unknown>;
}

describe("webchat relay/client", function () {
  const originalZotero = globalThis.Zotero;
  const originalToolkit = (globalThis as typeof globalThis & { ztoolkit?: any })
    .ztoolkit;

  let relayServer: RelayServerModule;
  let client: WebChatClientModule;

  const invokeEndpoint = async (
    path: string,
    method: "GET" | "POST",
    data?: unknown,
  ): Promise<Record<string, unknown>> => {
    const EndpointClass = (
      globalThis.Zotero.Server.Endpoints as Record<string, any>
    )[path];
    assert.isFunction(EndpointClass, `Missing endpoint class for ${path}`);
    const endpoint = new EndpointClass();
    return parseJsonReply(
      await endpoint.init({
        method,
        pathname: path,
        query: {},
        headers: {},
        data: data ?? null,
      }),
    );
  };

  before(async function () {
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Prefs: {
        get: () => 23119,
      },
      Server: {
        Endpoints: {},
      },
    } as typeof Zotero;
    (
      globalThis as typeof globalThis & { ztoolkit: { log: () => void } }
    ).ztoolkit = {
      log: () => {},
    };

    relayServer = await import("../src/webchat/relayServer");
    client = await import("../src/webchat/client");
    relayServer.registerWebChatRelay();
  });

  beforeEach(function () {
    relayServer.relayResetForTests();
  });

  after(function () {
    relayServer.unregisterWebChatRelay();
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
    (
      globalThis as typeof globalThis & { ztoolkit?: typeof originalToolkit }
    ).ztoolkit = originalToolkit;
  });

  it("tracks per-site history freshness without wiping other sites on empty updates", async function () {
    await invokeEndpoint(
      "/llm-for-zotero/webchat/update_chat_history",
      "POST",
      {
        sessions: [
          {
            id: "chatgpt-1",
            title: "ChatGPT thread",
            chatUrl: "https://chatgpt.com/c/chatgpt-1",
          },
        ],
        siteHostname: "chatgpt.com",
        scrapedAt: 111,
      },
    );
    await invokeEndpoint(
      "/llm-for-zotero/webchat/update_chat_history",
      "POST",
      {
        sessions: [],
        siteHostname: "chat.deepseek.com",
        scrapedAt: 222,
      },
    );

    const snapshot = relayServer.relayGetHistorySnapshot();
    assert.deepEqual(snapshot.sessions, [
      {
        id: "chatgpt-1",
        title: "ChatGPT thread",
        chatUrl: "https://chatgpt.com/c/chatgpt-1",
      },
    ]);
    assert.deepEqual(snapshot.siteSync["chatgpt.com"], {
      lastUpdatedAt: 111,
      status: "ok",
      source: null,
    });
    assert.deepEqual(snapshot.siteSync["chat.deepseek.com"], {
      lastUpdatedAt: 222,
      status: "empty",
      source: null,
    });
  });

  it("preserves existing site history when a fresh invalid source update arrives", async function () {
    await invokeEndpoint(
      "/llm-for-zotero/webchat/update_chat_history",
      "POST",
      {
        sessions: [
          {
            id: "deepseek-1",
            title: "DeepSeek thread",
            chatUrl: "https://chat.deepseek.com/a/chat/s/deepseek-1",
          },
        ],
        siteHostname: "chat.deepseek.com",
        scrapedAt: 300,
        source: "network",
      },
    );

    await invokeEndpoint(
      "/llm-for-zotero/webchat/update_chat_history",
      "POST",
      {
        sessions: [],
        siteHostname: "chat.deepseek.com",
        scrapedAt: 301,
        status: "invalid_source",
        source: "network",
      },
    );

    const snapshot = relayServer.relayGetHistorySnapshot();
    assert.deepEqual(snapshot.sessions, [
      {
        id: "deepseek-1",
        title: "DeepSeek thread",
        chatUrl: "https://chat.deepseek.com/a/chat/s/deepseek-1",
      },
    ]);
    assert.deepEqual(snapshot.siteSync["chat.deepseek.com"], {
      lastUpdatedAt: 301,
      status: "invalid_source",
      source: "network",
    });
  });

  it("clears existing site history on a fresh empty update and exposes the failure helpers", async function () {
    await invokeEndpoint(
      "/llm-for-zotero/webchat/update_chat_history",
      "POST",
      {
        sessions: [
          {
            id: "deepseek-1",
            title: "DeepSeek thread",
            chatUrl: "https://chat.deepseek.com/a/chat/s/deepseek-1",
          },
        ],
        siteHostname: "chat.deepseek.com",
        scrapedAt: 400,
        source: "network",
      },
    );

    await invokeEndpoint(
      "/llm-for-zotero/webchat/update_chat_history",
      "POST",
      {
        sessions: [],
        siteHostname: "chat.deepseek.com",
        scrapedAt: 401,
        status: "empty",
        source: "network",
      },
    );

    const snapshot = await client.fetchChatHistorySnapshot("");
    assert.deepEqual(snapshot.sessions, []);
    assert.deepEqual(
      client.getWebChatHistorySiteSyncEntry(snapshot, "chat.deepseek.com"),
      {
        lastUpdatedAt: 401,
        status: "empty",
        source: "network",
      },
    );
    assert.isFalse(
      client.isWebChatHistorySiteFailure(
        client.getWebChatHistorySiteSyncEntry(snapshot, "chat.deepseek.com"),
      ),
    );
  });

  it("flags invalid history statuses as failures in the client helper", async function () {
    await invokeEndpoint(
      "/llm-for-zotero/webchat/update_chat_history",
      "POST",
      {
        sessions: [],
        siteHostname: "chat.deepseek.com",
        scrapedAt: 500,
        status: "timeout",
        source: "dom",
      },
    );

    const snapshot = await client.fetchChatHistorySnapshot("");
    assert.equal(
      client.getWebChatHistorySiteStatus(snapshot, "chat.deepseek.com"),
      "timeout",
    );
    assert.isTrue(
      client.isWebChatHistorySiteFailure(
        client.getWebChatHistorySiteSyncEntry(snapshot, "chat.deepseek.com"),
      ),
    );
  });

  it("stores scraped transcript metadata and exposes it directly", async function () {
    await invokeEndpoint("/llm-for-zotero/webchat/chat_history", "POST", {
      action: "submit_scraped",
      messages: [
        {
          role: "user",
          text: "Hello",
        },
      ],
      chatUrl: "https://chat.deepseek.com/a/chat/s/chat-a",
      chatId: "chat-a",
      siteHostname: "chat.deepseek.com",
      capturedAt: 333,
      source: "network",
    });

    const snapshot = relayServer.relayGetScrapedTranscriptSnapshot();
    assert.deepEqual(snapshot, {
      messages: [
        {
          role: "user",
          text: "Hello",
          thinking: undefined,
          attachments: undefined,
          messageKey: undefined,
        },
      ],
      chatUrl: "https://chat.deepseek.com/a/chat/s/chat-a",
      chatId: "chat-a",
      siteHostname: "chat.deepseek.com",
      capturedAt: 333,
      source: "network",
    });
  });

  it("does not reuse a fresh scraped transcript for the wrong chat", async function () {
    await invokeEndpoint("/llm-for-zotero/webchat/chat_history", "POST", {
      action: "submit_scraped",
      messages: [
        {
          role: "assistant",
          text: "Chat A",
        },
      ],
      chatUrl: "https://chat.deepseek.com/a/chat/s/chat-a",
      chatId: "chat-a",
      siteHostname: "chat.deepseek.com",
      capturedAt: 444,
      source: "network",
    });

    const snapshot = await client.waitForFreshScrapedTranscriptSnapshot("", {
      expectedChatUrl: "https://chat.deepseek.com/a/chat/s/chat-b",
      expectedChatId: "chat-b",
      siteHostname: "chat.deepseek.com",
      minCapturedAt: 400,
      timeoutMs: 50,
    });

    assert.isNull(snapshot);
  });

  it("accepts a fresh scraped transcript when the chat id matches even if the url differs", async function () {
    await invokeEndpoint("/llm-for-zotero/webchat/chat_history", "POST", {
      action: "submit_scraped",
      messages: [
        {
          role: "assistant",
          text: "Chat B",
        },
      ],
      chatUrl: "https://chat.deepseek.com/a/chat/s/chat-b?from=sidebar",
      chatId: "chat-b",
      siteHostname: "chat.deepseek.com",
      capturedAt: 445,
      source: "dom",
    });

    const snapshot = await client.waitForFreshScrapedTranscriptSnapshot("", {
      expectedChatUrl: "https://chat.deepseek.com/a/chat/s/chat-b",
      expectedChatId: "chat-b",
      siteHostname: "chat.deepseek.com",
      minCapturedAt: 400,
      timeoutMs: 50,
    });

    assert.isNotNull(snapshot);
    assert.equal(snapshot?.chatId, "chat-b");
  });

  it("falls back to the latest matching transcript when freshness timing is missed", async function () {
    await invokeEndpoint("/llm-for-zotero/webchat/chat_history", "POST", {
      action: "submit_scraped",
      messages: [
        {
          role: "assistant",
          text: "Late but matching",
        },
      ],
      chatUrl: "https://chat.deepseek.com/a/chat/s/chat-b",
      chatId: "chat-b",
      siteHostname: "chat.deepseek.com",
      capturedAt: 1,
      source: "dom",
    });

    const snapshot = await client.waitForFreshScrapedTranscriptSnapshot("", {
      expectedChatUrl: "https://chat.deepseek.com/a/chat/s/chat-b",
      expectedChatId: "chat-b",
      siteHostname: "chat.deepseek.com",
      minCapturedAt: Date.now(),
      timeoutMs: 50,
    });

    assert.isNotNull(snapshot);
    assert.equal(snapshot?.chatId, "chat-b");
    assert.deepEqual(snapshot?.messages, [
      {
        role: "assistant",
        text: "Late but matching",
        thinking: undefined,
        attachments: undefined,
        messageKey: undefined,
      },
    ]);
  });

  it("fails chat loading instead of falling back to stale scraped messages", async function () {
    await invokeEndpoint(
      "/llm-for-zotero/webchat/update_chat_history",
      "POST",
      {
        sessions: [
          {
            id: "chat-b",
            title: "DeepSeek thread",
            chatUrl: "https://chat.deepseek.com/a/chat/s/chat-b",
          },
        ],
        siteHostname: "chat.deepseek.com",
        scrapedAt: 555,
      },
    );

    await invokeEndpoint("/llm-for-zotero/webchat/chat_history", "POST", {
      action: "submit_scraped",
      messages: [
        {
          role: "assistant",
          text: "Stale chat A",
        },
      ],
      chatUrl: "https://chat.deepseek.com/a/chat/s/chat-a",
      chatId: "chat-a",
      siteHostname: "chat.deepseek.com",
      capturedAt: 556,
      source: "network",
    });

    const loadPromise = client.loadChatSession("", "chat-b");
    setTimeout(() => {
      relayServer.relayUpdateTurnState({
        remote_chat_url: "https://chat.deepseek.com/a/chat/s/chat-b",
        remote_chat_id: "chat-b",
        turn_status: "ready",
      });
      void invokeEndpoint("/llm-for-zotero/webchat/chat_history", "POST", {
        action: "submit_scraped",
        messages: [],
        chatUrl: "https://chat.deepseek.com/a/chat/s/chat-b",
        chatId: "chat-b",
        siteHostname: "chat.deepseek.com",
        capturedAt: Date.now(),
        source: "network",
      });
    }, 20);

    let thrown: Error | null = null;
    try {
      await loadPromise;
    } catch (err) {
      thrown = err as Error;
    }

    assert.instanceOf(thrown, Error);
    assert.equal(
      thrown?.message,
      "Selected chat loaded, but no transcript messages were captured.",
    );
  });

  it("loads a fresh scraped transcript without requiring remote ready state", async function () {
    await invokeEndpoint(
      "/llm-for-zotero/webchat/update_chat_history",
      "POST",
      {
        sessions: [
          {
            id: "chat-c",
            title: "DeepSeek thread",
            chatUrl: "https://chat.deepseek.com/a/chat/s/chat-c",
          },
        ],
        siteHostname: "chat.deepseek.com",
        scrapedAt: 600,
      },
    );

    const loadPromise = client.loadChatSession("", "chat-c");
    setTimeout(() => {
      void invokeEndpoint("/llm-for-zotero/webchat/chat_history", "POST", {
        action: "submit_scraped",
        messages: [
          {
            role: "user",
            text: "Hello from chat C",
          },
          {
            role: "assistant",
            text: "DeepSeek reply",
          },
        ],
        chatUrl: "https://chat.deepseek.com/a/chat/s/chat-c",
        chatId: "chat-c",
        siteHostname: "chat.deepseek.com",
        capturedAt: Date.now(),
        source: "dom",
      });
    }, 20);

    const result = await loadPromise;
    assert.deepEqual(result?.messages, [
      {
        speaker: "user",
        text: "Hello from chat C",
        kind: "user",
        thinking: undefined,
      },
      {
        speaker: "assistant",
        text: "DeepSeek reply",
        kind: "bot",
        thinking: undefined,
      },
    ]);
  });

  it("downgrades reasoning-only terminal turns to incomplete", async function () {
    const submit = relayServer.relaySubmitQuery({ prompt: "reasoning-only" });
    const claimed = relayServer.relayClaimQuery(submit.seq);
    assert.isTrue(claimed.ok);

    await invokeEndpoint("/llm-for-zotero/webchat/submit_response", "POST", {
      seq: submit.seq,
      attempt: claimed.query?.attempt || 1,
      response: "",
      thinking: "Reasoning only",
      run_state: "done",
      completion_reason: "settled",
    });

    const result = await client.pollForResponse(
      "",
      submit.seq,
      () => undefined,
      () => undefined,
      undefined,
    );

    assert.equal(result.runState, "incomplete");
    assert.equal(result.text, "");
    assert.equal(result.thinking, "Reasoning only");
    assert.equal(result.completionReason, "settled");
  });

  it("returns done when the terminal turn carries a final answer", async function () {
    const submit = relayServer.relaySubmitQuery({ prompt: "full-answer" });
    const claimed = relayServer.relayClaimQuery(submit.seq);
    assert.isTrue(claimed.ok);

    await invokeEndpoint("/llm-for-zotero/webchat/submit_response", "POST", {
      seq: submit.seq,
      attempt: claimed.query?.attempt || 1,
      response: "Final answer",
      thinking: "Trace",
      run_state: "done",
      completion_reason: "settled",
    });

    const result = await client.pollForResponse(
      "",
      submit.seq,
      () => undefined,
      () => undefined,
      undefined,
    );

    assert.equal(result.runState, "done");
    assert.equal(result.text, "Final answer");
    assert.equal(result.thinking, "Trace");
    assert.isNull(result.userTurnKey);
    assert.isNull(result.assistantTurnKey);
  });

  it("rejects empty terminal turns that have no answer or reasoning context", async function () {
    const submit = relayServer.relaySubmitQuery({ prompt: "empty-terminal" });
    const claimed = relayServer.relayClaimQuery(submit.seq);
    assert.isTrue(claimed.ok);

    await invokeEndpoint("/llm-for-zotero/webchat/submit_response", "POST", {
      seq: submit.seq,
      attempt: claimed.query?.attempt || 1,
      response: "",
      thinking: "",
      run_state: "done",
      completion_reason: "settled",
    });

    let thrown: Error | null = null;
    try {
      await client.pollForResponse(
        "",
        submit.seq,
        () => undefined,
        () => undefined,
        undefined,
      );
    } catch (err) {
      thrown = err as Error;
    }

    assert.instanceOf(thrown, Error);
    assert.equal(
      thrown?.message,
      "Chat finished without a visible final answer.",
    );
  });
});
