import { assert } from "chai";
import {
  getModelEntryById,
  setModelProviderGroups,
} from "../src/utils/modelProviders";
import type {
  WorkflowTestApi,
  WorkflowTestChatTurnLifecycleState,
  WorkflowTestFixture,
  WorkflowTestPanel,
} from "../src/modules/contextPanel/workflowTestTypes";

/**
 * Characterization of the plain-chat assistant turn, end to end in the real
 * Zotero host: the panel's own Send runs the real `sendQuestion`, and the
 * real `retryLatestAssistantResponse` retries the latest turn, both against a
 * fake streaming provider that the test holds open, closes, or breaks. Each
 * case asserts the in-memory messages, the stored message rows column by
 * column, the usage ledger rows, and the status line.
 *
 * These cases pin what the two flows do TODAY, including where they differ
 * from each other, so that merging them into one assistant-turn owner cannot
 * change any of it silently. A pin marked "suspected bug Bn" records current
 * behaviour that the design review flagged; it is not an endorsement.
 *
 * The Codex trace ordering is not covered here: the trace persists before the
 * row write, and a cancel runs trace then refresh in retry but refresh then
 * trace in send. Plain chat has no Codex trace.
 */

declare const Zotero: any;

const PREF_PREFIX = "extensions.zotero.llmforzotero.";
const API_BASE = "https://workflow-chat-turn.invalid/v1";
const GROUP_ID = "workflow-chat-turn-group";
const ENTRY_ID = "workflow-chat-turn-model";
const MODEL = "workflow-turn-model";
// Retries use a second model so that every field a retry rewrites is visible.
const RETRY_ENTRY_ID = "workflow-chat-turn-retry-model";
const RETRY_MODEL = "workflow-retry-model";
const FORCED_SKILL_ID = "workflow-forced-skill";
const TAG_NAME = "workflow-turn-tag";
// Streamed after the partial text has reached memory, then cut off within
// 50 ms: well inside the 450 ms coalescer window, so it is still buffered.
const UNFLUSHED_TAIL = " unflushed tail";

const SAVED_PREF_KEYS = [
  "modelProviderGroups",
  "modelProviderGroupsMigrationVersion",
  "lastUsedModelEntryId",
  "lastUsedRuntimeMode",
  "conversationSystem",
  "enableCodexAppServerMode",
  "enableClaudeCodeMode",
  "outputTokenAutoMigrationNoticePending",
];

type Row = Record<string, unknown>;

/** One streamed chat completion that the test controls chunk by chunk. */
type HeldStream = {
  url: string;
  push: (text: string) => void;
  reason: (text: string) => void;
  usage: (promptTokens: number, completionTokens: number) => void;
  finish: () => void;
  fail: (message: string) => void;
  readonly aborted: boolean;
};

function getWorkflowTestApi(): WorkflowTestApi {
  const api = (Zotero as any).LLMForZotero?.api?.workflowTest;
  assert.isOk(api, "workflow test API should be installed");
  return api as WorkflowTestApi;
}

// Errors serialized across the Zotero/runner boundary lose their message;
// surface them through the assertion's `actual` field, which is printed.
async function surfacing(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const message = String((err as Error)?.message || err);
    const stack = String((err as Error)?.stack || "");
    assert.equal(message + (stack ? `\n${stack}` : ""), "OK", "step failed");
  }
}

async function waitFor<T>(
  read: () => Promise<T> | T,
  done: (value: T) => boolean,
  label: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value)) {
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for ${label}; last value: ${JSON.stringify(value)}`,
      );
    }
    await Zotero.Promise.delay(25);
    value = await read();
  }
  return value;
}

function createHeldStream(url: string, signal?: AbortSignal): HeldStream {
  const encoder = new TextEncoder();
  const queue: Uint8Array[] = [];
  let ended = false;
  let failure: unknown = null;
  let aborted = false;
  let waiter: {
    resolve: (result: { value?: Uint8Array; done: boolean }) => void;
    reject: (error: unknown) => void;
  } | null = null;
  const settleWaiter = () => {
    if (!waiter) return;
    const current = waiter;
    if (queue.length) {
      waiter = null;
      current.resolve({ value: queue.shift(), done: false });
    } else if (failure) {
      waiter = null;
      current.reject(failure);
    } else if (ended) {
      waiter = null;
      current.resolve({ value: undefined, done: true });
    }
  };
  const send = (payload: unknown) => {
    queue.push(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
    settleWaiter();
  };
  // A real fetch body rejects its pending read with an AbortError once the
  // request's signal aborts; poll so the fake does not depend on whether the
  // signal in this chrome scope supports listeners.
  const abortPoll = setInterval(() => {
    if (!signal?.aborted || failure) return;
    aborted = true;
    failure = Object.assign(new Error("The operation was aborted."), {
      name: "AbortError",
    });
    clearInterval(abortPoll);
    settleWaiter();
  }, 20);
  const stream: HeldStream = {
    url,
    push: (text) => send({ choices: [{ delta: { content: text } }] }),
    reason: (text) =>
      send({ choices: [{ delta: { reasoning_content: text } }] }),
    usage: (promptTokens, completionTokens) =>
      send({
        choices: [],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      }),
    finish: () => {
      send({ choices: [{ delta: {}, finish_reason: "stop" }] });
      queue.push(encoder.encode("data: [DONE]\n\n"));
      ended = true;
      clearInterval(abortPoll);
      settleWaiter();
    },
    fail: (message) => {
      failure = new Error(message);
      clearInterval(abortPoll);
      settleWaiter();
    },
    get aborted() {
      return aborted;
    },
  };
  (stream as HeldStream & { body: unknown }).body = {
    getReader: () => ({
      read: () => {
        return new Promise<{ value?: Uint8Array; done: boolean }>(
          (resolve, reject) => {
            waiter = { resolve, reject };
            settleWaiter();
          },
        );
      },
      releaseLock: () => undefined,
      cancel: async () => undefined,
    }),
  };
  return stream;
}

describe("workflow: plain-chat turn lifecycle (send and retry)", function () {
  this.timeout(180_000);

  const toolkit = () => (Zotero as any).LLMForZotero.data.ztoolkit;
  let originalGetGlobal: ((name: string) => unknown) | undefined;
  const streams: HeldStream[] = [];
  const previousPrefs = new Map<string, unknown>();
  let fixture: WorkflowTestFixture | undefined;
  let panel: WorkflowTestPanel;
  let providerLabel = "";

  const api = () => getWorkflowTestApi();
  const panelElement = (selector: string) => {
    const element = Zotero.getMainWindow().document.querySelector(
      `[data-workflow-panel-id="${panel.panelId}"] ${selector}`,
    ) as HTMLElement | null;
    assert.isOk(element, `panel renders ${selector}`);
    return element!;
  };
  const read = (conversationKey: number) =>
    api().readChatTurnLifecycle(conversationKey);
  const statusText = async () =>
    (await api().getDiagnostics(panel.panelId)).statusText || "";
  const nextStream = (count: number) =>
    waitFor(
      () => streams.length,
      (length) => length > count,
      "the provider request",
    ).then(() => streams[count]);
  const lastAssistant = (state: WorkflowTestChatTurnLifecycleState) =>
    [...state.memory].reverse().find((m) => m.role === "assistant") as Row;
  const lastUser = (state: WorkflowTestChatTurnLifecycleState) =>
    [...state.memory].reverse().find((m) => m.role === "user") as Row;
  const storedOf = (
    state: WorkflowTestChatTurnLifecycleState,
    role: "user" | "assistant",
  ) => [...state.storedRows].reverse().find((row) => row.role === role) as Row;
  const waitForPartial = (conversationKey: number, text: string) =>
    waitFor(
      () => read(conversationKey),
      (state) => String(lastAssistant(state)?.text || "").includes(text),
      `the partial text "${text}" to reach the in-memory answer`,
    );
  /**
   * Streams a tail that the stream coalescer has not flushed yet, then waits
   * a short time so the reader has taken it. The abort poll runs every 20 ms.
   */
  const pushUnflushedTail = async (stream: HeldStream) => {
    stream.push(UNFLUSHED_TAIL);
    await Zotero.Promise.delay(30);
  };
  /**
   * The usage row is written without being awaited after the turn ends.
   * Wait for the expected count, then make sure no extra row follows.
   */
  const settledUsageRows = async (conversationKey: number, count: number) => {
    await waitFor(
      () => read(conversationKey),
      (state) => state.usageRows.length >= count,
      `${count} usage row(s)`,
    );
    await Zotero.Promise.delay(400);
    const state = await read(conversationKey);
    assert.lengthOf(
      state.usageRows,
      count,
      "exactly one usage row per dispatched turn",
    );
    return state.usageRows;
  };
  const startSend = (text: string) =>
    api().startPanelChatSend(panel.panelId, text, {
      forcedSkillIds: [FORCED_SKILL_ID],
      selectedTagContexts: [
        {
          name: TAG_NAME,
          normalizedName: TAG_NAME,
          libraryID: Zotero.Libraries.userLibraryID,
        },
      ],
    });
  const waitForSendSettled = (started: {
    conversationKey: number;
    sendSettledSequenceBefore: number;
  }) =>
    waitFor(
      () => read(started.conversationKey),
      (state) =>
        state.sendSettledSequence > started.sendSettledSequenceBefore &&
        !state.requestPending,
      "the send to settle",
    );
  /** Sends one question that completes, as the start of each retry case. */
  const completedSend = async (question: string, answer: string) => {
    const started = await startSend(question);
    const stream = await nextStream(streams.length);
    stream.push(answer);
    stream.usage(11, 7);
    stream.finish();
    await waitForSendSettled(started);
    return started.conversationKey;
  };

  before(async function () {
    for (const key of SAVED_PREF_KEYS) {
      previousPrefs.set(key, Zotero.Prefs.get(PREF_PREFIX + key, true));
    }
    originalGetGlobal = toolkit().getGlobal;
    const passThrough = originalGetGlobal!;
    toolkit().getGlobal = function (this: unknown, name: string) {
      if (name !== "fetch") return passThrough.call(this, name);
      const realFetch = passThrough.call(this, name) as typeof fetch;
      return async (url: string, init?: RequestInit) => {
        const target = String(url);
        if (!target.startsWith(API_BASE)) return realFetch(target, init);
        const payload = (() => {
          try {
            return JSON.parse(String(init?.body || "{}")) as {
              stream?: boolean;
            };
          } catch {
            return {};
          }
        })();
        if (target === `${API_BASE}/chat/completions` && payload.stream) {
          const stream = createHeldStream(target, init?.signal || undefined);
          streams.push(stream);
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            headers: { get: () => "text/event-stream" },
            body: (stream as HeldStream & { body: unknown }).body,
            json: async () => ({}),
            text: async () => "",
          };
        }
        if (target === `${API_BASE}/chat/completions`) {
          // Non-streamed utility calls (the retrieval query planner uses the
          // chat model): answer with no extra probes so retrieval falls back
          // to the literal question. They report no usage.
          const body = {
            choices: [
              {
                message: { role: "assistant", content: '{"variants":[]}' },
                finish_reason: "stop",
              },
            ],
          };
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            headers: { get: () => "application/json" },
            body: null,
            json: async () => body,
            text: async () => JSON.stringify(body),
          };
        }
        // Capability discovery and anything else on the fake host: absent.
        return {
          ok: false,
          status: 404,
          statusText: "Not Found",
          headers: { get: () => "application/json" },
          body: null,
          json: async () => ({ error: { message: "not found" } }),
          text: async () => '{"error":{"message":"not found"}}',
        };
      };
    };
    Zotero.Prefs.set(PREF_PREFIX + "conversationSystem", "upstream", true);
    Zotero.Prefs.set(PREF_PREFIX + "enableCodexAppServerMode", false, true);
    Zotero.Prefs.set(PREF_PREFIX + "enableClaudeCodeMode", false, true);
    Zotero.Prefs.set(PREF_PREFIX + "lastUsedRuntimeMode", "chat", true);
    setModelProviderGroups([
      {
        id: GROUP_ID,
        authMode: "api_key",
        apiBase: API_BASE,
        apiKey: "workflow-dummy-key",
        providerProtocol: "openai_chat_compat",
        models: [
          {
            id: ENTRY_ID,
            model: MODEL,
            temperature: 0.3,
            outputTokenLimit: { mode: "auto" },
          },
          {
            id: RETRY_ENTRY_ID,
            model: RETRY_MODEL,
            temperature: 0.3,
            outputTokenLimit: { mode: "auto" },
          },
        ],
      },
    ] as any);
    Zotero.Prefs.set(PREF_PREFIX + "lastUsedModelEntryId", ENTRY_ID, true);
    providerLabel = getModelEntryById(ENTRY_ID)?.providerLabel || "";
    assert.isNotEmpty(providerLabel, "the fake provider has a label");
    assert.equal(
      getModelEntryById(RETRY_ENTRY_ID)?.providerLabel,
      providerLabel,
      "both models share the provider label",
    );
  });

  after(async function () {
    if (originalGetGlobal) toolkit().getGlobal = originalGetGlobal;
    await api().reset();
    for (const [key, value] of previousPrefs) {
      if (value === undefined) Zotero.Prefs.clear(PREF_PREFIX + key, true);
      else Zotero.Prefs.set(PREF_PREFIX + key, value, true);
    }
  });

  beforeEach(async function () {
    await api().reset();
    fixture = await api().createPaperWithPdfFixture({
      title: `Chat turn lifecycle ${this.currentTest?.title || ""}`,
      pdfTitle: "chat-turn-lifecycle.pdf",
      pages: ["A short page about how an assistant turn ends."],
    });
    panel = await api().renderPanelForItem(fixture.parentItemId);
  });

  afterEach(async function () {
    // A failed case must not leave a held stream behind for the next one.
    for (const stream of streams) stream.fail("workflow case ended");
    streams.length = 0;
    await Zotero.Promise.delay(200);
    if (fixture) await api().cleanupFixture(fixture);
    fixture = undefined;
  });

  /** Fields every send-path assistant row and message share. */
  const assertSendIdentity = (message: Row, row: Row) => {
    assert.equal(message.runMode, "chat");
    assert.equal(message.modelName, MODEL);
    assert.equal(message.modelEntryId, ENTRY_ID);
    assert.equal(message.modelProviderLabel, providerLabel);
    assert.equal(row.run_mode, "chat");
    assert.equal(row.model_name, MODEL);
    assert.equal(row.model_entry_id, ENTRY_ID);
    assert.equal(row.model_provider_label, providerLabel);
    assert.equal(row.text, message.text, "stored text matches memory");
    assert.equal(row.timestamp, message.timestamp, "stored timestamp");
    assert.isNull(row.document_id, "no document id");
    assert.isNull(row.agent_run_id, "no agent run id");
    assert.isNull(row.webchat_run_state, "no webchat run state");
    assert.isNull(row.webchat_completion_reason);
    assert.notProperty(message, "documentId");
    assert.notProperty(message, "planDocumentId");
    assert.notProperty(message, "agentRunId");
  };

  /** Streamed reasoning, in memory and stored, or none at all. */
  const assertReasoning = (message: Row, row: Row, details: string | null) => {
    assert.notProperty(message, "reasoningSummary");
    assert.isNull(row.reasoning_summary);
    if (details === null) {
      assert.notProperty(message, "reasoningDetails");
      assert.isNull(row.reasoning_details);
    } else {
      assert.equal(message.reasoningDetails, details);
      assert.equal(row.reasoning_details, details);
    }
  };

  /** The send's user row after the context-plan rewrite. */
  const assertSendUserRow = (state: WorkflowTestChatTurnLifecycleState) => {
    const user = lastUser(state);
    const row = storedOf(state, "user");
    assert.equal(row.run_mode, "chat");
    assert.equal(row.model_name, MODEL);
    assert.equal(row.model_entry_id, ENTRY_ID);
    assert.equal(row.model_provider_label, providerLabel);
    assert.equal(row.text, user.text);
    assert.equal(row.timestamp, user.timestamp);
    assert.deepEqual(user.forcedSkillIds, [FORCED_SKILL_ID]);
    // Pins current behaviour; suspected bug B1, see design review: the send
    // inserts the user row WITH forced_skill_ids_json, then its context-plan
    // update omits forcedSkillIds, and the UPDATE writes every column, so the
    // stored row loses the forced skills that memory still holds.
    assert.isNull(
      row.forced_skill_ids_json,
      "B1: the send's user-row update drops forced skill ids",
    );
    assert.equal(
      (user.selectedTagContexts as Row[] | undefined)?.[0]?.name,
      TAG_NAME,
    );
    assert.include(
      String(row.tag_contexts_json || ""),
      TAG_NAME,
      "the send's user-row update keeps tag contexts",
    );
  };

  it("send completes: streamed text, completion status, one counted usage row", async function () {
    await surfacing(async () => {
      const started = await startSend("What does the page say?");
      const stream = await nextStream(0);
      const dispatchedAt = Date.now();
      stream.reason("Reading the page.");
      stream.push("The page says ");
      stream.push("turns end cleanly.");
      stream.usage(11, 7);
      stream.finish();
      const state = await waitForSendSettled(started);

      assert.lengthOf(state.memory, 2, "one user and one assistant message");
      const assistant = lastAssistant(state);
      const row = storedOf(state, "assistant");
      assert.lengthOf(state.storedRows, 2, "one user and one assistant row");
      assert.equal(assistant.text, "The page says turns end cleanly.");
      assert.equal(assistant.streaming, false);
      assert.notProperty(assistant, "interrupted", "interrupted cleared");
      assert.equal(assistant.completionStatus, "complete");
      assert.notProperty(assistant, "completionReason");
      assertSendIdentity(assistant, row);
      assertReasoning(assistant, row, "Reading the page.");
      // The send keeps the timestamp its placeholder got when the turn began.
      assert.isAtMost(Number(assistant.timestamp), dispatchedAt);
      assert.isNull(row.interrupted);
      assert.equal(row.completion_status, "complete");
      assert.isNull(row.completion_reason);
      // Pins current behaviour; suspected bug B2, see design review: send
      // rows never carry the context-usage snapshot (retry rows do).
      assert.isNull(row.context_tokens, "B2: send row has no context tokens");
      assert.isNull(row.context_window, "B2: send row has no context window");
      assert.notProperty(assistant, "contextTokens");
      assertSendUserRow(state);

      const usage = await settledUsageRows(started.conversationKey, 1);
      assert.include(usage[0], {
        runtime: "chat",
        model: MODEL,
        provider: providerLabel,
        promptTokens: 11,
        completionTokens: 7,
        totalTokens: 18,
        countsAsQuestion: true,
        tokenSource: "provider",
      });
      assert.equal(await statusText(), "Ready");
    });
  });

  it("send cancelled while the stream is held: partial text kept, not interrupted", async function () {
    await surfacing(async () => {
      const started = await startSend("Start an answer, then stop.");
      const stream = await nextStream(0);
      stream.push("Partial answer before cancel");
      await waitForPartial(started.conversationKey, "before cancel");
      await pushUnflushedTail(stream);
      const cancelledAt = Date.now();
      panelElement("#llm-cancel").click();
      const state = await waitForSendSettled(started);

      assert.isTrue(stream.aborted, "Cancel aborts the provider request");
      const assistant = lastAssistant(state);
      const row = storedOf(state, "assistant");
      assert.lengthOf(state.storedRows, 2);
      // The cancel flushes the buffered tail before it finalizes the row.
      assert.equal(
        assistant.text,
        `Partial answer before cancel${UNFLUSHED_TAIL}`,
        "memory keeps the unflushed tail",
      );
      assert.equal(assistant.streaming, false);
      assert.notProperty(assistant, "interrupted");
      assert.notProperty(assistant, "completionStatus");
      assertSendIdentity(assistant, row);
      assert.isTrue(
        String(row.text).endsWith(UNFLUSHED_TAIL),
        "the stored row keeps the unflushed tail",
      );
      // A cancel refreshes the placeholder timestamp, unlike a completion.
      assert.isAtLeast(Number(assistant.timestamp), cancelledAt);
      assertReasoning(assistant, row, null);
      assert.isNull(row.interrupted);
      assert.isNull(row.completion_status);
      assert.isNull(row.completion_reason);
      assert.isNull(row.context_tokens, "B2: send row has no context tokens");
      assertSendUserRow(state);

      const usage = await settledUsageRows(started.conversationKey, 1);
      assert.include(usage[0], {
        runtime: "chat",
        countsAsQuestion: true,
        tokenSource: "unreported",
        totalTokens: 0,
      });
      assert.equal(await statusText(), "Cancelled");
    });
  });

  it("send cancelled before the first block is released: [Cancelled] prefixes the buffered text (B6)", async function () {
    await surfacing(async () => {
      const started = await startSend("Cancel before any block is released.");
      const stream = await nextStream(0);
      stream.push("Only buffered text");
      await Zotero.Promise.delay(30);
      panelElement("#llm-cancel").click();
      const state = await waitForSendSettled(started);

      const assistant = lastAssistant(state);
      const row = storedOf(state, "assistant");
      // Pins current behaviour; suspected bug B6: Cancel before the first
      // released block prefixes [Cancelled] to the buffered text, see design
      // review. The Cancel click handler writes it into the empty streaming
      // message before the flow flushes the buffered text.
      assert.equal(assistant.text, "[Cancelled]Only buffered text");
      assert.equal(row.text, "[Cancelled]Only buffered text");
      assert.equal(assistant.streaming, false);
      assert.equal(await statusText(), "Cancelled");
    });
  });

  it("send error after partial text: the partial answer is stored as interrupted", async function () {
    await surfacing(async () => {
      const started = await startSend("Answer until the connection drops.");
      const stream = await nextStream(0);
      stream.reason("Thinking before the drop.");
      stream.push("Partial answer before the drop");
      await waitForPartial(started.conversationKey, "before the drop");
      await pushUnflushedTail(stream);
      stream.fail("workflow socket closed");
      const state = await waitForSendSettled(started);

      const assistant = lastAssistant(state);
      const row = storedOf(state, "assistant");
      assert.lengthOf(state.storedRows, 2);
      // The error path reads the buffered text before it disposes the stream.
      assert.equal(
        assistant.text,
        `Partial answer before the drop${UNFLUSHED_TAIL}`,
        "memory keeps the unflushed tail",
      );
      assert.isTrue(
        String(row.text).endsWith(UNFLUSHED_TAIL),
        "the stored row keeps the unflushed tail",
      );
      assert.equal(assistant.interrupted, true);
      assert.equal(assistant.streaming, false);
      assert.notProperty(assistant, "completionStatus");
      assertSendIdentity(assistant, row);
      assertReasoning(assistant, row, "Thinking before the drop.");
      assert.equal(row.interrupted, 1);
      assert.isNull(row.completion_status);
      assert.isNull(row.context_tokens, "B2: send row has no context tokens");
      assertSendUserRow(state);

      const usage = await settledUsageRows(started.conversationKey, 1);
      assert.include(usage[0], {
        countsAsQuestion: true,
        tokenSource: "unreported",
      });
      // The send's status keeps 40 characters of the error message.
      assert.equal(await statusText(), "Error: workflow socket closed");
    });
  });

  it("send error with no output: an Error row replaces the answer", async function () {
    await surfacing(async () => {
      const started = await startSend("Fail before any text.");
      const stream = await nextStream(0);
      stream.fail(
        "workflow upstream unavailable and this message is longer than forty characters",
      );
      const state = await waitForSendSettled(started);

      const assistant = lastAssistant(state);
      const row = storedOf(state, "assistant");
      assert.lengthOf(state.storedRows, 2);
      assert.equal(
        assistant.text,
        "Error: workflow upstream unavailable and this message is longer than forty characters",
      );
      // The no-output outcome sets interrupted to false, not undefined.
      assert.strictEqual(assistant.interrupted, false);
      assert.equal(assistant.streaming, false);
      assertSendIdentity(assistant, row);
      assertReasoning(assistant, row, null);
      assert.isNull(row.interrupted);
      assert.isNull(row.completion_status);
      assertSendUserRow(state);

      const usage = await settledUsageRows(started.conversationKey, 1);
      assert.include(usage[0], {
        countsAsQuestion: true,
        tokenSource: "unreported",
      });
      assert.equal(
        await statusText(),
        "Error: workflow upstream unavailable and this m",
      );
    });
  });

  /** Fields every retry-path assistant row and message share. */
  const assertRetryIdentity = (message: Row, row: Row) => {
    assert.equal(message.runMode, "chat");
    assert.equal(message.modelName, RETRY_MODEL);
    assert.equal(message.modelEntryId, RETRY_ENTRY_ID);
    assert.equal(message.modelProviderLabel, providerLabel);
    assert.equal(row.run_mode, "chat");
    assert.equal(row.model_name, RETRY_MODEL);
    assert.equal(row.model_entry_id, RETRY_ENTRY_ID);
    assert.equal(row.model_provider_label, providerLabel);
    assert.equal(row.text, message.text, "stored text matches memory");
    assert.equal(row.timestamp, message.timestamp, "stored timestamp");
    assert.isNull(row.document_id, "no document id");
    assert.isNull(row.agent_run_id, "no agent run id");
    // The retry row update writes no webchat fields, so they are NULL.
    assert.isNull(row.webchat_run_state);
    assert.isNull(row.webchat_completion_reason);
    assert.notProperty(message, "documentId");
    assert.notProperty(message, "agentRunId");
  };

  /** The retry's user row: rewritten before dispatch. */
  const assertRetryUserRow = (state: WorkflowTestChatTurnLifecycleState) => {
    const user = lastUser(state);
    const row = storedOf(state, "user");
    assert.equal(row.text, user.text);
    assert.equal(row.timestamp, user.timestamp);
    // The retry rewrites the user row's model identity to the retry model.
    assert.equal(user.modelName, RETRY_MODEL);
    assert.equal(user.modelEntryId, RETRY_ENTRY_ID);
    assert.equal(row.model_name, RETRY_MODEL);
    assert.equal(row.model_entry_id, RETRY_ENTRY_ID);
    assert.isNull(row.forced_skill_ids_json, "B1: forced skill ids stay lost");
    // Pins current behaviour; suspected bug B1, see design review: the retry
    // rewrites the user row without selectedTagContexts, so tag_contexts_json
    // is NULLed although memory still holds the tag.
    assert.equal(
      (user.selectedTagContexts as Row[] | undefined)?.[0]?.name,
      TAG_NAME,
    );
    assert.isNull(
      row.tag_contexts_json,
      "B1: the retry's user-row rewrite drops tag contexts",
    );
  };

  it("retry completes: new text, refreshed timestamp and model, context tokens stored", async function () {
    await surfacing(async () => {
      const conversationKey = await completedSend(
        "Answer once.",
        "Original answer.",
      );
      const before = await read(conversationKey);
      const originalTimestamp = Number(lastAssistant(before).timestamp);

      const retry = api().retryLatestPanelResponse(
        panel.panelId,
        RETRY_ENTRY_ID,
      );
      const stream = await nextStream(1);
      stream.reason("Reading again.");
      stream.push("Retried ");
      stream.push("answer.");
      stream.usage(13, 5);
      const finishedAt = Date.now();
      stream.finish();
      assert.strictEqual(await retry, true, "a completed retry returns true");
      const state = await read(conversationKey);

      assert.lengthOf(state.memory, 2, "the retry replaces the answer");
      assert.lengthOf(state.storedRows, 2, "the retry updates rows in place");
      const assistant = lastAssistant(state);
      const row = storedOf(state, "assistant");
      assert.equal(assistant.text, "Retried answer.");
      assert.equal(assistant.streaming, false);
      assert.notProperty(assistant, "interrupted");
      assert.equal(assistant.completionStatus, "complete");
      assertRetryIdentity(assistant, row);
      assertReasoning(assistant, row, "Reading again.");
      // Retry completion sets a fresh timestamp; send completion does not.
      assert.isAtLeast(Number(assistant.timestamp), finishedAt);
      assert.isAbove(Number(assistant.timestamp), originalTimestamp);
      assert.isNull(row.interrupted);
      assert.equal(row.completion_status, "complete");
      // Retry rows carry the context-usage snapshot (the provider's prompt
      // tokens); send rows do not (B2).
      assert.equal(row.context_tokens, 13, "retry row stores context tokens");
      assert.isNumber(row.context_window, "retry row stores context window");
      assertRetryUserRow(state);

      const usage = await settledUsageRows(conversationKey, 2);
      assert.include(usage[1], {
        runtime: "chat",
        model: RETRY_MODEL,
        provider: providerLabel,
        promptTokens: 13,
        completionTokens: 5,
        totalTokens: 18,
        // A retry's tokens count, but its question was counted at send.
        countsAsQuestion: false,
        tokenSource: "provider",
      });
      assert.equal(await statusText(), "Ready");
    });
  });

  it("retry error with no output: the previous answer is restored in memory and storage", async function () {
    await surfacing(async () => {
      const conversationKey = await completedSend(
        "Answer once.",
        "Original answer.",
      );
      await settledUsageRows(conversationKey, 1);
      const before = await read(conversationKey);

      const retry = api().retryLatestPanelResponse(
        panel.panelId,
        RETRY_ENTRY_ID,
      );
      const stream = await nextStream(1);
      // While the request is out, the stored user row already carries the
      // retry's model; the restore below has to write it back.
      const during = await read(conversationKey);
      assert.equal(storedOf(during, "user").model_name, RETRY_MODEL);
      stream.fail(
        "workflow upstream unavailable and this message is longer than forty-eight characters",
      );
      assert.isUndefined(await retry, "a failed retry returns nothing");
      const state = await read(conversationKey);

      assert.deepEqual(
        state.memory,
        before.memory,
        "both in-memory messages are restored exactly",
      );
      const userBefore = storedOf(before, "user");
      const userAfter = storedOf(state, "user");
      assert.include(String(userBefore.tag_contexts_json || ""), TAG_NAME);
      // Pins current behaviour; suspected bug B1, see design review: the
      // restore rewrites the user row from memory but without
      // selectedTagContexts, so the only stored difference after a fully
      // restored retry is the lost tag context.
      assert.deepEqual(
        state.storedRows,
        before.storedRows.map((row) =>
          row.role === "user" ? { ...row, tag_contexts_json: null } : row,
        ),
        "stored rows are restored except the B1 tag-context loss",
      );
      assert.equal(userAfter.model_name, MODEL);
      assert.isNull(userAfter.tag_contexts_json);

      const usage = await settledUsageRows(conversationKey, 2);
      assert.include(usage[1], {
        countsAsQuestion: false,
        tokenSource: "unreported",
      });
      // The retry's status keeps 48 characters of the error message.
      assert.equal(
        await statusText(),
        "Retry failed: workflow upstream unavailable and this message i",
      );
    });
  });

  it("retry error after partial text: the partial answer is stored as interrupted", async function () {
    await surfacing(async () => {
      const conversationKey = await completedSend(
        "Answer once.",
        "Original answer.",
      );
      const before = await read(conversationKey);
      const originalTimestamp = Number(lastAssistant(before).timestamp);

      const retry = api().retryLatestPanelResponse(
        panel.panelId,
        RETRY_ENTRY_ID,
      );
      const stream = await nextStream(1);
      stream.reason("Retry thinking before the drop.");
      stream.push("Partial retry before the drop");
      await waitForPartial(conversationKey, "retry before the drop");
      await pushUnflushedTail(stream);
      const failedAt = Date.now();
      stream.fail("workflow socket closed");
      assert.isUndefined(await retry);
      const state = await read(conversationKey);

      const assistant = lastAssistant(state);
      const row = storedOf(state, "assistant");
      assert.lengthOf(state.storedRows, 2);
      // The error path reads the buffered text before it disposes the stream.
      assert.equal(
        assistant.text,
        `Partial retry before the drop${UNFLUSHED_TAIL}`,
        "memory keeps the unflushed tail",
      );
      assert.isTrue(
        String(row.text).endsWith(UNFLUSHED_TAIL),
        "the stored row keeps the unflushed tail",
      );
      assert.equal(assistant.interrupted, true);
      assert.equal(assistant.streaming, false);
      // The retry reset the completion fields at start; nothing sets them.
      assert.notProperty(assistant, "completionStatus");
      assertRetryIdentity(assistant, row);
      assertReasoning(assistant, row, "Retry thinking before the drop.");
      assert.isAtLeast(Number(assistant.timestamp), failedAt);
      assert.isAbove(Number(assistant.timestamp), originalTimestamp);
      assert.equal(row.interrupted, 1);
      // The interrupted retry row omits completionStatus, so it is NULLed.
      assert.isNull(row.completion_status);
      assert.isNull(row.completion_reason);
      // No provider usage arrived, so the snapshot is the pre-dispatch
      // estimate; it is still stored on the retry row.
      assert.isNumber(row.context_tokens, "retry row stores context tokens");
      assertRetryUserRow(state);

      const usage = await settledUsageRows(conversationKey, 2);
      assert.include(usage[1], {
        countsAsQuestion: false,
        tokenSource: "unreported",
      });
      assert.equal(await statusText(), "Retry failed: workflow socket closed");
    });
  });

  it("retry cancelled while the stream is held: partial text kept, not interrupted", async function () {
    await surfacing(async () => {
      const conversationKey = await completedSend(
        "Answer once.",
        "Original answer.",
      );
      const originalTimestamp = Number(
        lastAssistant(await read(conversationKey)).timestamp,
      );

      const retry = api().retryLatestPanelResponse(
        panel.panelId,
        RETRY_ENTRY_ID,
      );
      const stream = await nextStream(1);
      stream.push("Partial retry before cancel");
      await waitForPartial(conversationKey, "retry before cancel");
      await pushUnflushedTail(stream);
      const cancelledAt = Date.now();
      panelElement("#llm-cancel").click();
      assert.isUndefined(await retry, "a cancelled retry returns nothing");
      const state = await read(conversationKey);

      assert.isTrue(stream.aborted, "Cancel aborts the provider request");
      const assistant = lastAssistant(state);
      const row = storedOf(state, "assistant");
      assert.lengthOf(state.storedRows, 2);
      // The cancel flushes the buffered tail before it finalizes the row.
      assert.equal(
        assistant.text,
        `Partial retry before cancel${UNFLUSHED_TAIL}`,
        "memory keeps the unflushed tail",
      );
      assert.equal(assistant.streaming, false);
      assert.notProperty(assistant, "interrupted");
      assert.notProperty(assistant, "completionStatus");
      assertRetryIdentity(assistant, row);
      assert.isTrue(
        String(row.text).endsWith(UNFLUSHED_TAIL),
        "the stored row keeps the unflushed tail",
      );
      assert.isAtLeast(Number(assistant.timestamp), cancelledAt);
      assert.isAbove(Number(assistant.timestamp), originalTimestamp);
      assertReasoning(assistant, row, null);
      assert.isNull(row.interrupted);
      assert.isNull(row.completion_status);
      assert.isNumber(row.context_tokens, "retry row stores context tokens");
      assertRetryUserRow(state);

      const usage = await settledUsageRows(conversationKey, 2);
      assert.include(usage[1], {
        countsAsQuestion: false,
        tokenSource: "unreported",
      });
      assert.equal(await statusText(), "Cancelled");
    });
  });

  it("retry cancelled before the first block is released: [Cancelled] prefixes the buffered text (B6)", async function () {
    await surfacing(async () => {
      const conversationKey = await completedSend(
        "Answer once.",
        "Original answer.",
      );

      const retry = api().retryLatestPanelResponse(
        panel.panelId,
        RETRY_ENTRY_ID,
      );
      const stream = await nextStream(1);
      stream.push("Only buffered retry text");
      await Zotero.Promise.delay(30);
      panelElement("#llm-cancel").click();
      assert.isUndefined(await retry, "a cancelled retry returns nothing");
      const state = await read(conversationKey);

      const assistant = lastAssistant(state);
      const row = storedOf(state, "assistant");
      // Pins current behaviour; suspected bug B6: Cancel before the first
      // released block prefixes [Cancelled] to the buffered text, see design
      // review. The Cancel click handler writes it into the empty streaming
      // message before the flow flushes the buffered text.
      assert.equal(assistant.text, "[Cancelled]Only buffered retry text");
      assert.equal(row.text, "[Cancelled]Only buffered retry text");
      assert.equal(assistant.streaming, false);
      assert.equal(await statusText(), "Cancelled");
    });
  });

  it("retry over an answer with a document id keeps the stale id", async function () {
    await surfacing(async () => {
      const seeded = await api().seedPanelStoredTurn(
        panel.panelId,
        "Write it up as a document.",
        "Document answer.",
        { documentId: "workflow-stale-document", runMode: "chat" },
      );
      const conversationKey = seeded.conversationKey;

      const retry = api().retryLatestPanelResponse(
        panel.panelId,
        RETRY_ENTRY_ID,
      );
      const stream = await nextStream(0);
      stream.push("Plain retried answer.");
      stream.finish();
      assert.strictEqual(await retry, true);
      const state = await read(conversationKey);

      const assistant = lastAssistant(state);
      const row = storedOf(state, "assistant");
      assert.equal(assistant.text, "Plain retried answer.");
      assert.equal(assistant.completionStatus, "complete");
      // Pins current behaviour; suspected bug B3, see design review: the
      // retry never resets documentId at start, so a plain retried answer
      // stays tied to the previous answer's document, in memory and stored.
      assert.equal(
        assistant.documentId,
        "workflow-stale-document",
        "B3: the retried answer keeps the stale document id",
      );
      assert.equal(
        row.document_id,
        "workflow-stale-document",
        "B3: the stored retried answer keeps the stale document id",
      );
      assert.equal(row.text, "Plain retried answer.");
      await settledUsageRows(conversationKey, 1);
    });
  });
});
