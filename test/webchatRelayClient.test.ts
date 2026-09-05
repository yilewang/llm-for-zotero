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

function terminalDeliveryDiagnostic(input: {
  pdfRequested: boolean;
  filename?: string;
  submittedPdfCount?: number;
}) {
  return {
    phase: "done",
    siteId: "chatgpt",
    composerTextMatched: true,
    uploadDetected: input.pdfRequested,
    userTurnMatched: true,
    assistantTurnMatched: true,
    attachmentFilename: input.filename || null,
    attachmentMethod: input.pdfRequested ? "drag_drop" : null,
    attachmentVerificationMs: input.pdfRequested ? 850 : null,
    attachmentPreviewVerified: input.pdfRequested ? true : null,
    attachmentRequested: input.pdfRequested,
    attachmentFilenameConfirmed: input.pdfRequested ? true : null,
    attachmentReadyVerified: input.pdfRequested ? true : null,
    submittedAttachmentVerified: input.pdfRequested ? true : null,
    submittedAttachmentCount: input.pdfRequested ? 1 : 0,
    submittedPdfCount: input.submittedPdfCount ?? (input.pdfRequested ? 1 : 0),
    attachmentContractVerified: true,
  };
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

  beforeEach(async function () {
    relayServer.relayResetForTests();
    await invokeEndpoint("/llm-for-zotero/webchat/extension_status", "POST", {
      chatTabAlive: true,
      contentScriptAlive: true,
      supportedDeliveryContracts: [
        relayServer.ATTACHMENT_DELIVERY_CONTRACT_VERSION,
      ],
    });
  });

  after(function () {
    relayServer.unregisterWebChatRelay();
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
    (
      globalThis as typeof globalThis & { ztoolkit?: typeof originalToolkit }
    ).ztoolkit = originalToolkit;
  });

  it("binds HTTP submissions to the requested webchat provider", async function () {
    relayServer.relaySetActiveTarget("chatgpt");

    const submitted = await invokeEndpoint(
      "/llm-for-zotero/webchat/submit_query",
      "POST",
      {
        prompt: "DeepSeek provider probe",
        target: "deepseek",
      },
    );
    const polled = await invokeEndpoint(
      "/llm-for-zotero/webchat/poll_query",
      "GET",
    );

    assert.equal(submitted.ok, true);
    assert.equal(
      (polled.query as { target?: string } | undefined)?.target,
      "deepseek",
    );
    assert.equal(relayServer.relayGetStateSnapshot().active_target, "deepseek");
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

  it("stores rich extension status diagnostics", async function () {
    await invokeEndpoint("/llm-for-zotero/webchat/extension_status", "POST", {
      chatTabAlive: true,
      chatUrl: "https://chat.deepseek.com/",
      siteId: "deepseek",
      url: "https://chat.deepseek.com/a/chat/s/status-chat",
      contentScriptAlive: true,
      mainWorldInjected: false,
      composerFound: true,
      sendControlState: "disabled",
      uploadControlFound: true,
      networkHookActive: false,
      supportedDeliveryContracts: [1, 1, 1.5, 2, 0, "invalid"],
      lastRequestAt: 123456,
      lastStreamAt: 123999,
      lastDiagnostic: {
        reasonCode: "send_control_disabled",
        phase: "prompt_applied",
        message: "DeepSeek send button is disabled",
      },
    });

    const status = relayServer.relayGetExtensionStatus();
    assert.isNotNull(status);
    assert.equal(status?.chatTabAlive, true);
    assert.equal(status?.siteId, "deepseek");
    assert.equal(status?.url, "https://chat.deepseek.com/a/chat/s/status-chat");
    assert.equal(status?.contentScriptAlive, true);
    assert.equal(status?.mainWorldInjected, false);
    assert.equal(status?.composerFound, true);
    assert.equal(status?.sendControlState, "disabled");
    assert.equal(status?.uploadControlFound, true);
    assert.equal(status?.networkHookActive, false);
    assert.deepEqual(status?.supportedDeliveryContracts, [1, 2]);
    assert.equal(status?.lastRequestAt, 123456);
    assert.equal(status?.lastStreamAt, 123999);
    assert.equal(status?.lastDiagnostic?.reasonCode, "send_control_disabled");
    assert.equal(status?.lastDiagnostic?.siteId, "deepseek");
  });

  it("updates remote chat url and derives provider chat ids", async function () {
    const chatgpt = await invokeEndpoint(
      "/llm-for-zotero/webchat/update_chat_url",
      "POST",
      {
        chat_url: "https://chatgpt.com/c/chatgpt-thread-1",
      },
    );

    assert.equal(
      chatgpt.remote_chat_url,
      "https://chatgpt.com/c/chatgpt-thread-1",
    );
    assert.equal(chatgpt.remote_chat_id, "chatgpt-thread-1");

    const deepseek = await invokeEndpoint(
      "/llm-for-zotero/webchat/update_chat_url",
      "POST",
      {
        chatUrl:
          "https://chat.deepseek.com/a/chat/s/deepseek-thread-2?from=sidebar",
      },
    );

    assert.equal(
      deepseek.remote_chat_url,
      "https://chat.deepseek.com/a/chat/s/deepseek-thread-2?from=sidebar",
    );
    assert.equal(deepseek.remote_chat_id, "deepseek-thread-2");

    const root = await invokeEndpoint(
      "/llm-for-zotero/webchat/update_chat_url",
      "POST",
      {
        chatUrl: "https://chat.deepseek.com/",
      },
    );

    assert.equal(root.remote_chat_url, "https://chat.deepseek.com/");
    assert.isNull(root.remote_chat_id);
  });

  it("prevents query replay once submission is durably starting", async function () {
    const submit = relayServer.relaySubmitQuery({
      prompt: "at-most-once delivery",
    });
    const firstClaim = relayServer.relayClaimQuery(submit.seq);
    const firstAttempt = firstClaim.query?.attempt || 1;
    assert.isTrue(firstClaim.ok);

    const promptApplied = await invokeEndpoint(
      "/llm-for-zotero/webchat/ack_query_phase",
      "POST",
      {
        seq: submit.seq,
        attempt: firstAttempt,
        phase: "prompt_applied",
      },
    );
    assert.equal(promptApplied.ok, true);

    const safeRelease = await invokeEndpoint(
      "/llm-for-zotero/webchat/release_query",
      "POST",
      {
        seq: submit.seq,
        attempt: firstAttempt,
      },
    );
    assert.equal(safeRelease.ok, true);

    const secondClaim = relayServer.relayClaimQuery(submit.seq);
    const secondAttempt = secondClaim.query?.attempt || 2;
    assert.isTrue(secondClaim.ok);
    assert.equal(secondAttempt, firstAttempt + 1);

    const submitStarted = await invokeEndpoint(
      "/llm-for-zotero/webchat/ack_query_phase",
      "POST",
      {
        seq: submit.seq,
        attempt: secondAttempt,
        phase: "submit_started",
      },
    );
    assert.equal(submitStarted.ok, true);

    const unsafeRelease = await invokeEndpoint(
      "/llm-for-zotero/webchat/release_query",
      "POST",
      {
        seq: submit.seq,
        attempt: secondAttempt,
      },
    );
    assert.equal(unsafeRelease.ok, false);
    assert.equal(unsafeRelease.reason, "already_submitted");
    assert.equal(
      relayServer.relayGetStateSnapshot().query.phase,
      "submit_started",
    );
    assert.equal(relayServer.relayPollQuery().status, "running");
  });

  it("requests the strict delivery contract for plugin submissions", async function () {
    await client.submitQuery(
      "",
      "contract probe",
      null,
      null,
      undefined,
      undefined,
      undefined,
      false,
      "chatgpt",
    );

    assert.equal(
      relayServer.relayGetStateSnapshot().query.delivery_contract_version,
      relayServer.ATTACHMENT_DELIVERY_CONTRACT_VERSION,
    );
    assert.doesNotHaveAnyKeys(relayServer.relayGetStateSnapshot().query, [
      "temperature",
      "maxTokens",
      "maxTokensExplicit",
      "inputTokenCap",
      "inputMode",
      "providerProtocol",
      "profileOverride",
    ]);
  });

  it("rejects an incompatible extension before dispatching a real turn", async function () {
    relayServer.relayResetForTests();
    await invokeEndpoint("/llm-for-zotero/webchat/extension_status", "POST", {
      chatTabAlive: true,
      contentScriptAlive: true,
      supportedDeliveryContracts: [],
    });
    const before = relayServer.relayGetStateSnapshot();

    let rejection: unknown = null;
    try {
      await client.submitQuery(
        "",
        "must not dispatch",
        "JVBERi0=",
        "paper.pdf",
        undefined,
        undefined,
        undefined,
        false,
        "chatgpt",
      );
    } catch (error) {
      rejection = error;
    }
    assert.match(
      String(rejection),
      /does not support WebChat delivery contract 1/,
    );

    const after = relayServer.relayGetStateSnapshot();
    assert.equal(after.query.seq, before.query.seq);
    assert.isNull(after.query.prompt);
    assert.equal(after.status, "idle");
  });

  it("rejects a stale capability when no live chat content script is verified", async function () {
    relayServer.relayResetForTests();
    await invokeEndpoint("/llm-for-zotero/webchat/extension_status", "POST", {
      chatTabAlive: false,
      contentScriptAlive: true,
      supportedDeliveryContracts: [
        relayServer.ATTACHMENT_DELIVERY_CONTRACT_VERSION,
      ],
    });

    const result = relayServer.relaySubmitQuery({
      prompt: "must not dispatch",
      delivery_contract_version:
        relayServer.ATTACHMENT_DELIVERY_CONTRACT_VERSION,
    });

    assert.equal(result.ok, false);
    assert.match(result.error || "", /live chat tab and content script/);
    assert.equal(relayServer.relayGetStateSnapshot().status, "idle");
  });

  it("accepts a terminal PDF response only with an exact delivery receipt", async function () {
    const filename = "Requested paper.pdf";
    const submit = relayServer.relaySubmitQuery({
      prompt: "read the PDF",
      pdf_base64: "JVBERi0=",
      pdf_filename: filename,
      delivery_contract_version:
        relayServer.ATTACHMENT_DELIVERY_CONTRACT_VERSION,
    });
    const claimed = relayServer.relayClaimQuery(submit.seq);

    const response = await invokeEndpoint(
      "/llm-for-zotero/webchat/submit_response",
      "POST",
      {
        seq: submit.seq,
        attempt: claimed.query?.attempt || 1,
        response: "Verified answer",
        run_state: "done",
        completion_reason: "settled",
        diagnostic: terminalDeliveryDiagnostic({
          pdfRequested: true,
          filename,
        }),
      },
    );

    assert.equal(response.ok, true);
    assert.equal(relayServer.relayPollResponse().status, "done");
  });

  it("accepts a presence-tier receipt when the site renders the filename unreadably", async function () {
    const filename = "Requested paper.pdf";
    const submit = relayServer.relaySubmitQuery({
      prompt: "read the PDF",
      pdf_base64: "JVBERi0=",
      pdf_filename: filename,
      delivery_contract_version:
        relayServer.ATTACHMENT_DELIVERY_CONTRACT_VERSION,
    });
    const claimed = relayServer.relayClaimQuery(submit.seq);
    const diagnostic = terminalDeliveryDiagnostic({
      pdfRequested: true,
      filename,
    });
    diagnostic.attachmentFilenameConfirmed = false;
    diagnostic.attachmentReadyVerified = false;
    diagnostic.submittedAttachmentVerified = false;
    diagnostic.submittedPdfCount = 0;
    diagnostic.submittedAttachmentCount = 1;

    const response = await invokeEndpoint(
      "/llm-for-zotero/webchat/submit_response",
      "POST",
      {
        seq: submit.seq,
        attempt: claimed.query?.attempt || 1,
        response: "Presence-tier answer",
        run_state: "done",
        completion_reason: "settled",
        diagnostic,
      },
    );

    assert.equal(response.ok, true);
    assert.equal(relayServer.relayPollResponse().status, "done");
  });

  it("accepts a PDF receipt that reports an extra submitted PDF", async function () {
    const filename = "Requested paper.pdf";
    const submit = relayServer.relaySubmitQuery({
      prompt: "read exactly one PDF",
      pdf_base64: "JVBERi0=",
      pdf_filename: filename,
      delivery_contract_version:
        relayServer.ATTACHMENT_DELIVERY_CONTRACT_VERSION,
    });
    const claimed = relayServer.relayClaimQuery(submit.seq);

    const response = await invokeEndpoint(
      "/llm-for-zotero/webchat/submit_response",
      "POST",
      {
        seq: submit.seq,
        attempt: claimed.query?.attempt || 1,
        response: "Two-card answer",
        run_state: "done",
        completion_reason: "settled",
        diagnostic: terminalDeliveryDiagnostic({
          pdfRequested: true,
          filename,
          submittedPdfCount: 2,
        }),
      },
    );

    assert.equal(response.ok, true);
    assert.equal(relayServer.relayPollResponse().status, "done");
  });

  it("rejects a terminal PDF receipt whose attachment contract failed", async function () {
    const filename = "Requested paper.pdf";
    const submit = relayServer.relaySubmitQuery({
      prompt: "read the PDF",
      pdf_base64: "JVBERi0=",
      pdf_filename: filename,
      delivery_contract_version:
        relayServer.ATTACHMENT_DELIVERY_CONTRACT_VERSION,
    });
    const claimed = relayServer.relayClaimQuery(submit.seq);
    const diagnostic = terminalDeliveryDiagnostic({
      pdfRequested: true,
      filename,
    });
    diagnostic.attachmentContractVerified = false;

    const response = await invokeEndpoint(
      "/llm-for-zotero/webchat/submit_response",
      "POST",
      {
        seq: submit.seq,
        attempt: claimed.query?.attempt || 1,
        response: "Unverified answer",
        diagnostic,
      },
    );

    assert.match(
      String(response.error),
      /did not verify the terminal attachment contract/,
    );
    assert.equal(relayServer.relayPollResponse().status, "running");
  });

  it("rejects a terminal PDF receipt with no submitted attachment", async function () {
    const filename = "Requested paper.pdf";
    const submit = relayServer.relaySubmitQuery({
      prompt: "read the PDF",
      pdf_base64: "JVBERi0=",
      pdf_filename: filename,
      delivery_contract_version:
        relayServer.ATTACHMENT_DELIVERY_CONTRACT_VERSION,
    });
    const claimed = relayServer.relayClaimQuery(submit.seq);
    const diagnostic = terminalDeliveryDiagnostic({
      pdfRequested: true,
      filename,
    });
    diagnostic.submittedAttachmentCount = 0;
    diagnostic.submittedPdfCount = 0;

    const response = await invokeEndpoint(
      "/llm-for-zotero/webchat/submit_response",
      "POST",
      {
        seq: submit.seq,
        attempt: claimed.query?.attempt || 1,
        response: "Attachment-free answer",
        diagnostic,
      },
    );

    assert.match(String(response.error), /could not prove delivery/);
    assert.equal(relayServer.relayPollResponse().status, "running");
  });

  it("rejects a terminal PDF receipt without a detected upload", async function () {
    const filename = "Requested paper.pdf";
    const submit = relayServer.relaySubmitQuery({
      prompt: "read the PDF",
      pdf_base64: "JVBERi0=",
      pdf_filename: filename,
      delivery_contract_version:
        relayServer.ATTACHMENT_DELIVERY_CONTRACT_VERSION,
    });
    const claimed = relayServer.relayClaimQuery(submit.seq);
    const diagnostic = terminalDeliveryDiagnostic({
      pdfRequested: true,
      filename,
    });
    diagnostic.uploadDetected = false;

    const response = await invokeEndpoint(
      "/llm-for-zotero/webchat/submit_response",
      "POST",
      {
        seq: submit.seq,
        attempt: claimed.query?.attempt || 1,
        response: "Uploadless answer",
        diagnostic,
      },
    );

    assert.match(String(response.error), /could not prove delivery/);
    assert.equal(relayServer.relayPollResponse().status, "running");
  });

  it("rejects an unexpected PDF on a prompt-only terminal turn", async function () {
    const submit = relayServer.relaySubmitQuery({
      prompt: "prompt only",
      delivery_contract_version:
        relayServer.ATTACHMENT_DELIVERY_CONTRACT_VERSION,
    });
    const claimed = relayServer.relayClaimQuery(submit.seq);

    const response = await invokeEndpoint(
      "/llm-for-zotero/webchat/submit_response",
      "POST",
      {
        seq: submit.seq,
        attempt: claimed.query?.attempt || 1,
        response: "Wrong-mode answer",
        diagnostic: terminalDeliveryDiagnostic({
          pdfRequested: false,
          submittedPdfCount: 1,
        }),
      },
    );

    assert.match(String(response.error), /unexpected PDF/);
    assert.equal(relayServer.relayPollResponse().status, "running");
  });

  it("accepts a verified prompt-only terminal turn", async function () {
    const submit = relayServer.relaySubmitQuery({
      prompt: "prompt only",
      delivery_contract_version:
        relayServer.ATTACHMENT_DELIVERY_CONTRACT_VERSION,
    });
    const claimed = relayServer.relayClaimQuery(submit.seq);

    const response = await invokeEndpoint(
      "/llm-for-zotero/webchat/submit_response",
      "POST",
      {
        seq: submit.seq,
        attempt: claimed.query?.attempt || 1,
        response: "Prompt-only answer",
        run_state: "done",
        completion_reason: "settled",
        diagnostic: terminalDeliveryDiagnostic({ pdfRequested: false }),
      },
    );

    assert.equal(response.ok, true);
    assert.equal(relayServer.relayPollResponse().status, "done");
  });

  it("keeps cancellation incomplete and rejects a late terminal overwrite", async function () {
    const submit = relayServer.relaySubmitQuery({
      prompt: "cancel this turn",
      delivery_contract_version:
        relayServer.ATTACHMENT_DELIVERY_CONTRACT_VERSION,
    });
    const claimed = relayServer.relayClaimQuery(submit.seq);
    const attempt = claimed.query?.attempt || 1;

    relayServer.relayRequestStop();

    const cancelled = relayServer.relayPollResponse();
    assert.equal(cancelled.current_attempt, attempt);
    assert.equal(cancelled.responses.length, 1);
    assert.equal(cancelled.responses[0].run_state, "incomplete");
    assert.equal(cancelled.responses[0].turn_status, "incomplete");
    assert.equal(cancelled.responses[0].completion_reason, "forced_cancel");

    const stop = await invokeEndpoint(
      "/llm-for-zotero/webchat/poll_stop",
      "GET",
    );
    assert.equal(stop.stop, true);
    assert.equal(stop.seq, submit.seq);
    assert.equal(stop.attempt, attempt);

    const late = await invokeEndpoint(
      "/llm-for-zotero/webchat/submit_response",
      "POST",
      {
        seq: submit.seq,
        attempt,
        response: "late answer must not win",
        diagnostic: terminalDeliveryDiagnostic({ pdfRequested: false }),
      },
    );
    assert.equal(late.ok, false);
    assert.equal(late.reason, "attempt_not_running");

    const latePhase = await invokeEndpoint(
      "/llm-for-zotero/webchat/ack_query_phase",
      "POST",
      {
        seq: submit.seq,
        attempt,
        phase: "streaming",
      },
    );
    assert.equal(latePhase.ok, false);
    assert.equal(latePhase.reason, "attempt_not_running");
    assert.equal(relayServer.relayPollResponse().responses.length, 1);
  });

  it("keeps a long response alive only while attempt-bound progress advances", async function () {
    const originalNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      const submit = relayServer.relaySubmitQuery({
        prompt: "stream a long answer",
        delivery_contract_version:
          relayServer.ATTACHMENT_DELIVERY_CONTRACT_VERSION,
      });
      const claimed = relayServer.relayClaimQuery(submit.seq);
      const attempt = claimed.query?.attempt || 1;
      await invokeEndpoint("/llm-for-zotero/webchat/ack_query_phase", "POST", {
        seq: submit.seq,
        attempt,
        phase: "streaming",
      });

      now += 170_000;
      const progress = await invokeEndpoint(
        "/llm-for-zotero/webchat/update_partial",
        "POST",
        {
          seq: submit.seq,
          attempt,
          answer_snapshot: "A growing answer",
          answer_revision: 1,
          run_state: "active",
        },
      );
      assert.equal(progress.ok, true);

      now += 20_000;
      assert.equal(relayServer.relayPollResponse().status, "running");

      now += 159_000;
      const duplicate = await invokeEndpoint(
        "/llm-for-zotero/webchat/update_partial",
        "POST",
        {
          seq: submit.seq,
          attempt,
          answer_snapshot: "A growing answer",
          answer_revision: 1,
          run_state: "active",
        },
      );
      assert.equal(duplicate.ok, true);

      now += 2_000;
      const expired = relayServer.relayPollResponse();
      assert.equal(expired.status, "error");
      assert.equal(expired.responses.at(-1)?.completion_reason, "timeout");
    } finally {
      Date.now = originalNow;
    }
  });

  it("rejects a late attempt-bound turn-state update after new chat reset", async function () {
    const submit = relayServer.relaySubmitQuery({
      prompt: "old turn",
      delivery_contract_version:
        relayServer.ATTACHMENT_DELIVERY_CONTRACT_VERSION,
    });
    const claimed = relayServer.relayClaimQuery(submit.seq);
    const attempt = claimed.query?.attempt || 1;

    relayServer.relayNewChat("chatgpt");
    const lateState = await invokeEndpoint(
      "/llm-for-zotero/webchat/update_turn_state",
      "POST",
      {
        seq: submit.seq,
        attempt,
        remote_chat_url: "https://chatgpt.com/c/old-chat",
        remote_chat_id: "old-chat",
        turn_status: "assistant_turn_matched",
      },
    );

    assert.equal(lateState.ok, false);
    assert.equal(lateState.reason, "seq_mismatch");
    const state = relayServer.relayGetStateSnapshot();
    assert.equal(state.turn_status, "navigating");
    assert.equal(state.remote_chat_id, null);
  });

  it("distinguishes verified PDF and prompt-only delivery from provider timeout", function () {
    assert.deepEqual(
      relayServer.describeWebChatPipelineTimeout({
        attachmentRequested: true,
        attachmentContractVerified: true,
      }),
      {
        reasonCode: "provider_timeout_after_verified_pdf_delivery",
        message:
          "The web provider made no verified progress for 180 seconds. PDF upload and submission were verified; no final answer was accepted.",
      },
    );
    assert.deepEqual(
      relayServer.describeWebChatPipelineTimeout({
        attachmentRequested: false,
        attachmentContractVerified: true,
      }),
      {
        reasonCode: "provider_timeout_after_verified_prompt_delivery",
        message:
          "The web provider made no verified progress for 180 seconds. The prompt-only submission was verified with zero PDFs; no final answer was accepted.",
      },
    );
    assert.equal(
      relayServer.describeWebChatPipelineTimeout(null).reasonCode,
      "pipeline_timeout_unverified_delivery",
    );
  });

  it("propagates per-turn diagnostics through phase, snapshot, and terminal response", async function () {
    const submit = relayServer.relaySubmitQuery({ prompt: "diagnostic-turn" });
    const claimed = relayServer.relayClaimQuery(submit.seq);
    const attempt = claimed.query?.attempt || 1;
    assert.isTrue(claimed.ok);

    await invokeEndpoint("/llm-for-zotero/webchat/ack_query_phase", "POST", {
      seq: submit.seq,
      attempt,
      phase: "prompt_applied",
      diagnostic: {
        reasonCode: "prompt_ready",
        siteId: "deepseek",
        composerTextMatched: true,
        uploadDetected: true,
        sendControlState: "disabled",
      },
    });

    assert.equal(
      relayServer.relayGetStateSnapshot().last_diagnostic?.reasonCode,
      "prompt_ready",
    );
    assert.equal(
      relayServer.relayGetStateSnapshot().last_diagnostic?.phase,
      "prompt_applied",
    );

    await invokeEndpoint("/llm-for-zotero/webchat/update_partial", "POST", {
      seq: submit.seq,
      attempt,
      answer_snapshot: "partial",
      turn_status: "assistant_turn_matched",
      diagnostic: {
        reasonCode: "assistant_visible",
        siteId: "deepseek",
        requestObserved: true,
        streamObserved: true,
        userTurnMatched: true,
        assistantTurnMatched: true,
        attachmentFilename: "paper.pdf",
        attachmentMethod: "drag_drop",
        attachmentVerificationMs: 12_345,
        attachmentPreviewVerified: true,
        submittedAttachmentVerified: true,
        completionDetectionMs: 875,
      },
    });

    const partial = relayServer.relayPollResponse();
    assert.equal(partial.diagnostic?.reasonCode, "assistant_visible");
    assert.equal(partial.diagnostic?.requestObserved, true);
    assert.equal(partial.diagnostic?.streamObserved, true);

    await invokeEndpoint("/llm-for-zotero/webchat/submit_response", "POST", {
      seq: submit.seq,
      attempt,
      response: "Final",
      thinking: "Reasoning",
      run_state: "done",
      completion_reason: "settled",
      turn_status: "done",
      diagnostic: {
        reasonCode: "deepseek_stream_observed",
        siteId: "deepseek",
        clickAttempts: 2,
        requestObserved: true,
        streamObserved: true,
        userTurnMatched: true,
        assistantTurnMatched: true,
        attachmentFilename: "paper.pdf",
        attachmentMethod: "drag_drop",
        attachmentVerificationMs: 12_345,
        attachmentPreviewVerified: true,
        submittedAttachmentVerified: true,
        completionDetectionMs: 875,
      },
    });

    const done = relayServer.relayPollResponse();
    assert.equal(done.status, "done");
    assert.equal(done.diagnostic?.reasonCode, "deepseek_stream_observed");
    assert.equal(
      done.responses[0].diagnostic?.reasonCode,
      "deepseek_stream_observed",
    );
    assert.equal(done.responses[0].diagnostic?.clickAttempts, 2);
    assert.equal(done.responses[0].diagnostic?.attachmentFilename, "paper.pdf");
    assert.equal(done.responses[0].diagnostic?.attachmentMethod, "drag_drop");
    assert.equal(
      done.responses[0].diagnostic?.attachmentVerificationMs,
      12_345,
    );
    assert.equal(done.responses[0].diagnostic?.attachmentPreviewVerified, true);
    assert.equal(
      done.responses[0].diagnostic?.submittedAttachmentVerified,
      true,
    );
    assert.equal(done.responses[0].diagnostic?.completionDetectionMs, 875);
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
