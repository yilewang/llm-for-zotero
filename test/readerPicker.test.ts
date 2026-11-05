import { assert } from "chai";
import { config } from "../package.json";
import {
  decodeReaderSelection,
  encodeReaderSelection,
  normalizeStoredReaderSelection,
  readerRuntimeKeyForSystem,
} from "../src/shared/readerSelection";
import {
  bindSurfaceChoices,
  clearStandaloneSurfaceChoices,
  clearTornSurfaceChoices,
  resetSideSurfaceChoices,
  startSideSurfaceChoicesFromStandalone,
  startStandaloneSurfaceChoicesFromSidebar,
  startTornSurfaceChoices,
} from "../src/modules/contextPanel/surfaceChoices";
import {
  describeReaderSelection,
  formatReaderTooltipLine,
} from "../src/modules/contextPanel/setupHandlers/controllers/readerMenuController";
import {
  isReaderApiEntry,
  readerChoiceFromSelection,
} from "../src/agent/reader/readerChoiceFromSelection";
import {
  readerFallbackReason,
  resolveReaderWithFallback,
} from "../src/agent/reader/readerFallback";
import {
  resolveReaderCompletion,
  type ReaderChoice,
} from "../src/agent/reader/resolveReader";
import { runDigestParts } from "../src/agent/digests/digestJobHost";
import type {
  HostPaperDigest,
  PaperDigestCache,
} from "../src/agent/digests/paperDigestWorker";
import {
  clearPaperDigestRunBounds,
  createPaperDigestTool,
  type PaperDigestResult,
} from "../src/agent/tools/read/paperDigest";
import { createPaperReadTool } from "../src/agent/tools/read/paperRead";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";
import {
  getOrCreateZoteroMcpBearerToken,
  registerMcpServer,
  registerScopedZoteroMcpScope,
  unregisterMcpServer,
  ZOTERO_MCP_ENDPOINT_PATH,
  ZOTERO_MCP_SCOPE_HEADER,
} from "../src/agent/mcp/server";
import { buildAgentRuntimeRequestForTests } from "../src/modules/contextPanel/chat";
import { toAgentRuntimeRequestParams } from "../src/modules/contextPanel/requestContext";
import { buildClaudeZoteroMcpScopeForTests } from "../src/agent/externalBackendBridge";
import { buildCodexNativeScopedMcpScopeForTests } from "../src/codexAppServer/nativeClient";
import type { AgentToolContext, AgentToolDefinition } from "../src/agent/types";
import type { PdfContext } from "../src/services/paperContent/types";
import type { RuntimeModelEntry } from "../src/utils/modelProviders";
import {
  ReaderCompletionError,
  type ReaderCompletion,
} from "../src/shared/readerCompletion";

const globalScope = globalThis as typeof globalThis & { Zotero?: unknown };
const pref = (key: string) => `${config.prefsPrefix}.${key}`;

/** A configured API model entry, as the model menu lists it. */
function apiEntry(
  entryId: string,
  model: string,
  extra: Partial<RuntimeModelEntry> = {},
): RuntimeModelEntry {
  return {
    entryId,
    groupId: "g",
    model,
    apiBase: `https://${entryId}.invalid/v1`,
    apiKey: `secret-${entryId}`,
    providerProtocol: "openai_chat_compat",
    providerLabel: "Acme",
    providerOrder: 0,
    displayModelLabel: model,
    authMode: "api_key",
    advanced: { temperature: 0.3, outputTokenLimit: { mode: "auto" } },
    ...extra,
  } as RuntimeModelEntry;
}

const lookupOf =
  (...entries: RuntimeModelEntry[]) =>
  (id: string) =>
    entries.find((entry) => entry.entryId === id) || null;

describe("reader selection: stored form", function () {
  it("round-trips an entry, a runtime model and no selection", function () {
    assert.equal(encodeReaderSelection(null), "");
    assert.equal(
      encodeReaderSelection({ kind: "entry", entryId: "e1" }),
      "entry:e1",
    );
    assert.equal(
      encodeReaderSelection({ kind: "model", model: "gpt-6.1-sol" }),
      "model:gpt-6.1-sol",
    );
    assert.deepEqual(decodeReaderSelection("entry:e1"), {
      kind: "entry",
      entryId: "e1",
    });
    assert.deepEqual(decodeReaderSelection(" model:sonnet "), {
      kind: "model",
      model: "sonnet",
    });
  });

  it("reads anything else as Same as main", function () {
    for (const raw of ["", "entry:", "model:  ", "x", undefined, 4, null]) {
      assert.isNull(decodeReaderSelection(raw), String(raw));
    }
    assert.equal(normalizeStoredReaderSelection("nonsense"), "");
  });

  it("keeps one slot per runtime", function () {
    assert.equal(readerRuntimeKeyForSystem("upstream"), "agent");
    assert.equal(readerRuntimeKeyForSystem("codex"), "codex");
    assert.equal(readerRuntimeKeyForSystem("claude_code"), "claude");
    assert.equal(readerRuntimeKeyForSystem(undefined), "agent");
  });
});

describe("reader selection: kept per runtime across chats and windows", function () {
  const originalZotero = globalScope.Zotero;
  const prefStore = new Map<string, unknown>();
  const sidebar = bindSurfaceChoices(() => "embedded");
  const standalone = bindSurfaceChoices(() => "standalone");
  const side = bindSurfaceChoices(() => "side");

  beforeEach(function () {
    prefStore.clear();
    clearStandaloneSurfaceChoices();
    resetSideSurfaceChoices();
    globalScope.Zotero = {
      Prefs: {
        get: (key: string) => prefStore.get(key) ?? "",
        set: (key: string, value: unknown) => void prefStore.set(key, value),
        clear: (key: string) => void prefStore.delete(key),
      },
    };
  });

  afterEach(function () {
    clearStandaloneSurfaceChoices();
    resetSideSurfaceChoices();
    clearTornSurfaceChoices("torn:reader-test" as never);
    globalScope.Zotero = originalZotero;
  });

  it("the sidebar saves each runtime's reader in its own pref", function () {
    sidebar.setReaderSelection("agent", { kind: "entry", entryId: "e1" });
    sidebar.setReaderSelection("codex", { kind: "model", model: "gpt-6-sol" });
    sidebar.setReaderSelection("claude", { kind: "model", model: "opus" });

    assert.equal(prefStore.get(pref("readerChoiceAgent")), "entry:e1");
    assert.equal(prefStore.get(pref("readerChoiceCodex")), "model:gpt-6-sol");
    assert.equal(prefStore.get(pref("readerChoiceClaude")), "model:opus");
    assert.deepEqual(sidebar.getReaderSelection("codex"), {
      kind: "model",
      model: "gpt-6-sol",
    });
  });

  it("picking Same as main clears the saved reader", function () {
    sidebar.setReaderSelection("agent", { kind: "entry", entryId: "e1" });
    sidebar.setReaderSelection("agent", null);
    assert.equal(prefStore.get(pref("readerChoiceAgent")), "");
    assert.isNull(sidebar.getReaderSelection("agent"));
  });

  it("the window starts from the sidebar's readers and then keeps its own", function () {
    sidebar.setReaderSelection("agent", { kind: "entry", entryId: "e1" });
    startStandaloneSurfaceChoicesFromSidebar();

    assert.deepEqual(standalone.getReaderSelection("agent"), {
      kind: "entry",
      entryId: "e1",
    });
    standalone.setReaderSelection("agent", { kind: "entry", entryId: "e2" });
    standalone.setReaderSelection("codex", { kind: "model", model: "m" });

    assert.deepEqual(standalone.getReaderSelection("agent"), {
      kind: "entry",
      entryId: "e2",
    });
    assert.deepEqual(sidebar.getReaderSelection("agent"), {
      kind: "entry",
      entryId: "e1",
    });
    assert.equal(prefStore.get(pref("readerChoiceCodex")) ?? "", "");
    assert.isNull(sidebar.getReaderSelection("codex"));
  });

  it("a side chat copies the window's reader when it starts", function () {
    sidebar.setReaderSelection("agent", { kind: "entry", entryId: "e1" });
    startStandaloneSurfaceChoicesFromSidebar();
    standalone.setReaderSelection("agent", { kind: "entry", entryId: "e2" });
    startSideSurfaceChoicesFromStandalone();

    assert.deepEqual(side.getReaderSelection("agent"), {
      kind: "entry",
      entryId: "e2",
    });
    side.setReaderSelection("agent", null);
    assert.isNull(side.getReaderSelection("agent"));
    assert.deepEqual(standalone.getReaderSelection("agent"), {
      kind: "entry",
      entryId: "e2",
    });
  });

  it("a torn-off window copies the window's reader when it opens", function () {
    startStandaloneSurfaceChoicesFromSidebar();
    standalone.setReaderSelection("claude", { kind: "model", model: "haiku" });
    startTornSurfaceChoices("torn:reader-test" as never);
    const torn = bindSurfaceChoices(() => "torn:reader-test" as never);
    assert.deepEqual(torn.getReaderSelection("claude"), {
      kind: "model",
      model: "haiku",
    });
  });
});

describe("reader choice: built from the selection when a paper is read", function () {
  const e1 = apiEntry("e1", "acme-reader", {
    advanced: {
      temperature: 0.3,
      outputTokenLimit: { mode: "auto" },
    } as never,
  });
  const codexRequest = {
    model: "gpt-6-sol",
    authMode: "codex_app_server",
    exhaustiveReadBackend: "codex_responses",
  } as const;
  const claudeRequest = {
    model: "sonnet",
    exhaustiveReadBackend: "claude_bridge",
  } as const;
  const agentRequest = {
    model: "deepseek-flash",
    apiBase: "https://m.invalid",
  };

  it("means Same as main when nothing is selected", function () {
    assert.isUndefined(
      readerChoiceFromSelection({
        selection: null,
        request: agentRequest as never,
      }),
    );
  });

  it("calls an API entry's own provider from every runtime", function () {
    for (const request of [agentRequest, codexRequest, claudeRequest]) {
      const choice = readerChoiceFromSelection({
        selection: { kind: "entry", entryId: "e1" },
        request: request as never,
        lookupEntry: lookupOf(e1),
      });
      assert.deepInclude(choice as ReaderChoice, {
        route: "turn_model",
        model: "acme-reader",
        apiBase: "https://e1.invalid/v1",
        authMode: "api_key",
        providerProtocol: "openai_chat_compat",
      });
      assert.equal((choice as { apiKey: string }).apiKey, "secret-e1");
    }
  });

  it("reads a deleted entry as Same as main", function () {
    assert.isUndefined(
      readerChoiceFromSelection({
        selection: { kind: "entry", entryId: "gone" },
        request: agentRequest as never,
        lookupEntry: lookupOf(e1),
      }),
    );
  });

  it("never reads with a WebChat entry", function () {
    const web = apiEntry("w", "chatgpt.com", {
      authMode: "webchat",
      providerProtocol: "web_sync",
    } as never);
    assert.isUndefined(
      readerChoiceFromSelection({
        selection: { kind: "entry", entryId: "w" },
        request: agentRequest as never,
        lookupEntry: lookupOf(web),
      }),
    );
  });

  it("never reads with a Codex app-server entry, and does not offer one", function () {
    const codex = apiEntry("c", "gpt-6.1-sol", {
      authMode: "codex_app_server",
    } as never);
    for (const request of [agentRequest, codexRequest, claudeRequest]) {
      assert.isUndefined(
        readerChoiceFromSelection({
          selection: { kind: "entry", entryId: "c" },
          request: request as never,
          lookupEntry: lookupOf(codex),
        }),
      );
    }
    assert.isFalse(isReaderApiEntry(codex));
    assert.isFalse(isReaderApiEntry({ authMode: "webchat" }));
    assert.isFalse(
      isReaderApiEntry({
        authMode: "api_key",
        catalogAvailability: "saved-unavailable",
      }),
    );
    assert.isTrue(isReaderApiEntry(e1));
  });

  it("sends a runtime's own model through that runtime's route", function () {
    assert.deepEqual(
      readerChoiceFromSelection({
        selection: { kind: "model", model: "gpt-6.1-sol" },
        request: codexRequest as never,
      }),
      { route: "codex_responses", model: "gpt-6.1-sol" },
    );
    assert.deepEqual(
      readerChoiceFromSelection({
        selection: { kind: "model", model: "opus" },
        request: claudeRequest as never,
      }),
      { route: "claude_bridge", model: "opus" },
    );
  });

  it("ignores a runtime model name in the plugin Agent, which has none", function () {
    assert.isUndefined(
      readerChoiceFromSelection({
        selection: { kind: "model", model: "gpt-6.1-sol" },
        request: agentRequest as never,
      }),
    );
  });
});

describe("reader fallback rules", function () {
  const request = { model: "main-model", apiBase: "https://main.invalid" };
  const choice: ReaderChoice = {
    route: "turn_model",
    model: "chosen-model",
    apiBase: "https://chosen.invalid",
    apiKey: "k",
    authMode: "api_key",
    providerProtocol: "openai_chat_compat",
  };
  const answer: ReaderCompletion = async (_prompt, options) => ({
    text: `read by ${options.model}`,
  });

  it("falls back for a missing configuration and for a refused key, not for the rest", function () {
    assert.deepEqual(
      readerFallbackReason(
        new ReaderCompletionError({ reason: "not_configured" }),
      ),
      { reason: "not_configured" },
    );
    assert.deepEqual(
      readerFallbackReason(
        new ReaderCompletionError({ reason: "transport", status: 401 }),
      ),
      { reason: "unauthorized", status: 401 },
    );
    assert.deepEqual(
      readerFallbackReason(new Error("403 Forbidden: bad key")),
      { reason: "unauthorized", status: 403 },
    );
    for (const quality of [
      new ReaderCompletionError({ reason: "timeout" }),
      new ReaderCompletionError({ reason: "output_limit" }),
      new ReaderCompletionError({ reason: "empty" }),
      new ReaderCompletionError({ reason: "transport", status: 500 }),
      new ReaderCompletionError({ reason: "transport", status: 429 }),
      new ReaderCompletionError({ reason: "aborted" }),
    ]) {
      assert.isNull(readerFallbackReason(quality), quality.message);
    }
  });

  it("sizes batches by the smaller window of the chosen and the main reader", function () {
    const windowOf = (mainWindow: number) => {
      const withBudget = {
        ...request,
        runtimeContextBudget: {
          contextWindowTokens: mainWindow,
          usedContextTokens: 0,
        },
      };
      const { resolution } = resolveReaderWithFallback({
        request: withBudget as never,
        choice,
        factories: { turnModel: () => answer },
      });
      if (!resolution.ok) throw new Error("unresolved");
      const alone = resolveReaderCompletion({
        request: withBudget as never,
        choice,
        factories: { turnModel: () => answer },
      });
      if (!alone.ok) throw new Error("unresolved");
      return [resolution.reader.windowTokens, alone.reader.windowTokens];
    };
    const [smallMain, chosen] = windowOf(3_000);
    assert.equal(smallMain, 3_000);
    const [bigMain, chosenAgain] = windowOf(5_000_000);
    assert.equal(bigMain, chosenAgain);
    assert.equal(chosen, chosenAgain);
  });

  it("reads with the chosen reader and records no fallback when it works", async function () {
    const { resolution, fallbackNote } = resolveReaderWithFallback({
      request: request as never,
      choice,
      factories: { turnModel: () => answer },
    });
    assert.isTrue(resolution.ok);
    if (!resolution.ok) return;
    const result = await resolution.reader.complete("p", { model: "x" });
    assert.equal(result.text, "read by chosen-model");
    assert.equal(resolution.reader.model, "chosen-model");
    assert.isUndefined(fallbackNote());
  });

  it("switches to the main model once for configuration or auth failures, and says so", async function () {
    for (const failure of [
      new ReaderCompletionError({ reason: "not_configured" }),
      new ReaderCompletionError({ reason: "transport", status: 401 }),
    ]) {
      const calls: string[] = [];
      const { resolution, fallbackNote } = resolveReaderWithFallback({
        request: request as never,
        choice,
        factories: {
          turnModel: (config) => async (_prompt, options) => {
            calls.push(`${config.apiBase}|${options.model}`);
            if (config.apiBase === "https://chosen.invalid") throw failure;
            return { text: `read by ${options.model}` };
          },
        },
      });
      if (!resolution.ok) throw new Error("unresolved");
      const first = await resolution.reader.complete("p", { model: "x" });
      assert.equal(first.text, "read by main-model");
      assert.equal(resolution.reader.model, "main-model");
      await resolution.reader.complete("p", { model: "x" });
      // The chosen reader is asked once; later calls go straight to main.
      assert.deepEqual(calls, [
        "https://chosen.invalid|chosen-model",
        "https://main.invalid|main-model",
        "https://main.invalid|main-model",
      ]);
      const note = fallbackNote();
      assert.equal(note?.type, "reader_fallback");
      assert.equal(note?.chosen.model, "chosen-model");
      assert.equal(note?.usedInstead.model, "main-model");
      assert.notInclude(JSON.stringify(note), "https://");
      assert.notInclude(JSON.stringify(note), '"k"');
    }
  });

  it("does not fall back when the chosen reader fails on the paper itself", async function () {
    const { resolution, fallbackNote } = resolveReaderWithFallback({
      request: request as never,
      choice,
      factories: {
        turnModel: () => async () => {
          throw new ReaderCompletionError({ reason: "timeout" });
        },
      },
    });
    if (!resolution.ok) throw new Error("unresolved");
    let thrown: unknown;
    try {
      await resolution.reader.complete("p", { model: "x" });
    } catch (error) {
      thrown = error;
    }
    assert.instanceOf(thrown, ReaderCompletionError);
    assert.equal(resolution.reader.model, "chosen-model");
    assert.isUndefined(fallbackNote());
  });

  it("uses the main model from the start, with a note, when the chosen reader cannot be built", function () {
    const { resolution, fallbackNote } = resolveReaderWithFallback({
      request: { model: "gpt-6-sol", authMode: "codex_app_server" } as never,
      choice: { route: "claude_bridge", model: "" },
      factories: { codexResponses: () => answer },
    });
    if (!resolution.ok) throw new Error("unresolved");
    assert.equal(resolution.reader.model, "gpt-6-sol");
    assert.equal(fallbackNote()?.reason, "unavailable");
  });

  it("is exactly the main reader, with no fallback, when nothing is chosen", function () {
    const { resolution, fallbackNote } = resolveReaderWithFallback({
      request: request as never,
      factories: { turnModel: () => answer },
    });
    if (!resolution.ok) throw new Error("unresolved");
    assert.equal(resolution.reader.model, "main-model");
    assert.isUndefined(fallbackNote());
  });
});

describe("reader tooltip line", function () {
  const e1 = apiEntry("e1", "acme-reader", {
    displayModelLabel: "Acme Reader",
  });
  const own = [
    apiEntry("codex_app_server::gpt-6.1-sol", "gpt-6.1-sol", {
      providerLabel: "Codex",
      displayModelLabel: "GPT-6.1-Sol",
    }),
  ];

  it("names the API reader as provider and model", function () {
    assert.equal(
      formatReaderTooltipLine(
        describeReaderSelection({
          runtime: "agent",
          selection: { kind: "entry", entryId: "e1" },
          lookupEntry: lookupOf(e1),
          runtimeEntries: [],
        }),
      ),
      "Subagent: Acme · Acme Reader",
    );
  });

  it("names a runtime's own reader, even when its catalog has not loaded", function () {
    const line = (model: string, entries: RuntimeModelEntry[]) =>
      formatReaderTooltipLine(
        describeReaderSelection({
          runtime: "codex",
          selection: { kind: "model", model },
          lookupEntry: lookupOf(),
          runtimeEntries: entries,
        }),
      );
    assert.equal(line("gpt-6.1-sol", own), "Subagent: Codex · GPT-6.1-Sol");
    assert.equal(line("gpt-7", []), "Subagent: Codex · gpt-7");
  });

  it("adds no line for Same as main or a deleted entry", function () {
    for (const selection of [
      null,
      { kind: "entry", entryId: "gone" } as const,
    ]) {
      assert.equal(
        formatReaderTooltipLine(
          describeReaderSelection({
            runtime: "agent",
            selection,
            lookupEntry: lookupOf(e1),
            runtimeEntries: [],
          }),
        ),
        "",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Routing: digests and full reads use the reader the request names.
// ---------------------------------------------------------------------------

const TEXT = [
  "# Drift paper",
  "Representational drift did not impair decoding across ten sessions of recording.",
  "Body text that describes the methods in neutral and complete detail. ".repeat(
    90,
  ),
].join("\n\n");
const ANSWER = JSON.stringify({ answer: "Drift did not impair decoding." });

function memoryCache(): PaperDigestCache & {
  entries: Map<string, HostPaperDigest>;
} {
  const entries = new Map<string, HostPaperDigest>();
  return {
    entries,
    get: async (key) => entries.get(key) || null,
    set: async (digest) => void entries.set(digest.cacheKey, digest),
  };
}

describe("digests read with the picked reader", function () {
  afterEach(function () {
    clearPaperDigestRunBounds();
  });
  const e1 = apiEntry("e1", "acme-reader");
  const deps = (cache: PaperDigestCache, factories: object) => ({
    resolvePaper: async (_request: unknown, itemId: number) => ({
      itemId,
      contextItemId: itemId + 100,
      libraryID: 1,
      title: `Paper ${itemId}`,
    }),
    readText: async () => ({
      backend: "mineru" as const,
      text: TEXT,
      totalCharacters: TEXT.length,
    }),
    createCache: () => ({ ...cache, handleOf: async () => undefined }),
    readerFactories: factories,
    lookupReaderEntry: lookupOf(e1),
  });
  const partRun = async (
    request: Record<string, unknown>,
    factories: object,
  ) => {
    const cache = memoryCache();
    const result = await runDigestParts({
      parts: [{ taskId: "run:task:papers", targets: ["item:1"] }],
      context: {
        request: {
          conversationKey: 1,
          mode: "agent",
          userText: "",
          libraryID: 1,
          model: "deepseek-flash",
          apiBase: "https://main.invalid",
          apiKey: "main-key",
          ...request,
        },
        runId: "run",
        toolCallId: "call-1",
      } as never,
      deps: deps(cache, factories) as never,
      localTaskId: () => "papers",
    });
    return { result, cache };
  };

  it("the plugin Agent digests with the picked API reader and records its model", async function () {
    const seen: string[] = [];
    const { result, cache } = await partRun(
      { readerSelection: { kind: "entry", entryId: "e1" } },
      {
        turnModel:
          (config: { apiBase?: string }) =>
          async (_prompt: string, options: { model: string }) => {
            seen.push(`${config.apiBase}|${options.model}`);
            return { text: ANSWER };
          },
      },
    );
    assert.deepEqual(seen, ["https://e1.invalid/v1|acme-reader"]);
    const [digest] = [...cache.entries.values()];
    assert.equal(digest.model, "acme-reader");
    assert.equal(digest.readerRoute, "turn_model");
    assert.deepEqual(result.digestReaders, [
      {
        itemId: 1,
        taskId: "papers",
        model: "acme-reader",
        route: "turn_model",
      },
    ]);
    assert.notProperty(result, "readerFallback");
  });

  it("without a pick it reads with the main model and lists no readers", async function () {
    const seen: string[] = [];
    const { result, cache } = await partRun(
      {},
      {
        turnModel:
          () => async (_prompt: string, options: { model: string }) => {
            seen.push(options.model);
            return { text: ANSWER };
          },
      },
    );
    assert.deepEqual(seen, ["deepseek-flash"]);
    assert.equal([...cache.entries.values()][0].model, "deepseek-flash");
    assert.notProperty(result, "digestReaders");
  });

  it("a deleted entry reads as Same as main", async function () {
    const seen: string[] = [];
    await partRun(
      { readerSelection: { kind: "entry", entryId: "gone" } },
      {
        turnModel:
          () => async (_prompt: string, options: { model: string }) => {
            seen.push(options.model);
            return { text: ANSWER };
          },
      },
    );
    assert.deepEqual(seen, ["deepseek-flash"]);
  });

  it("an unauthorized reader falls back to main; the digest names the main model and the trace carries the note", async function () {
    const { result, cache } = await partRun(
      { readerSelection: { kind: "entry", entryId: "e1" } },
      {
        turnModel:
          (config: { apiBase?: string }) =>
          async (_prompt: string, options: { model: string }) => {
            if (config.apiBase === "https://e1.invalid/v1") {
              throw new ReaderCompletionError({
                reason: "transport",
                status: 401,
              });
            }
            return { text: ANSWER };
          },
      },
    );
    assert.notProperty(result, "digestFailures");
    const [digest] = [...cache.entries.values()];
    assert.equal(digest.model, "deepseek-flash");
    assert.equal(result.readerFallback?.reason, "unauthorized");
    assert.equal(result.readerFallback?.status, 401);
    assert.equal(result.readerFallback?.chosen.model, "acme-reader");
    assert.equal(result.readerFallback?.usedInstead.model, "deepseek-flash");
    assert.notInclude(JSON.stringify(result), "secret-e1");
  });

  it("a quality failure of the picked reader is the paper's failure, not a fallback", async function () {
    const { result, cache } = await partRun(
      { readerSelection: { kind: "entry", entryId: "e1" } },
      {
        turnModel: () => async () => {
          throw new ReaderCompletionError({ reason: "output_limit" });
        },
      },
    );
    assert.lengthOf(result.digestFailures || [], 1);
    assert.equal(cache.entries.size, 0);
    assert.notProperty(result, "readerFallback");
  });

  it("Codex and Claude Code digest with the picked runtime model, or an API reader", async function () {
    const seen: string[] = [];
    const answering = () => async (_p: string, options: { model: string }) => {
      seen.push(options.model);
      return { text: ANSWER };
    };
    await partRun(
      {
        model: "gpt-6-sol",
        authMode: "codex_app_server",
        providerProtocol: "codex_responses",
        exhaustiveReadBackend: "codex_responses",
        readerSelection: { kind: "model", model: "gpt-6.1-sol" },
      },
      { codexResponses: answering },
    );
    await partRun(
      {
        model: "sonnet",
        exhaustiveReadBackend: "claude_bridge",
        readerSelection: { kind: "model", model: "haiku" },
      },
      { claudeBridge: answering },
    );
    await partRun(
      {
        model: "sonnet",
        exhaustiveReadBackend: "claude_bridge",
        readerSelection: { kind: "entry", entryId: "e1" },
      },
      { turnModel: answering, claudeBridge: () => async () => ({ text: "x" }) },
    );
    assert.deepEqual(seen, ["gpt-6.1-sol", "haiku", "acme-reader"]);
  });
});

describe("paper_digest over MCP reads with the picked reader", function () {
  afterEach(function () {
    clearPaperDigestRunBounds();
  });
  const e1 = apiEntry("e1", "acme-reader");

  it("records the picked model on each row and the fallback on the result", async function () {
    const cache = memoryCache();
    const tool = createPaperDigestTool({
      resolvePaper: async (_request, itemId) => ({
        itemId,
        contextItemId: itemId + 100,
        libraryID: 1,
        title: `Paper ${itemId}`,
      }),
      readText: async () => ({
        backend: "mineru",
        text: TEXT,
        totalCharacters: TEXT.length,
      }),
      createCache: () => cache,
      lookupReaderEntry: lookupOf(e1),
      readerFactories: {
        turnModel: (config) => async (_prompt, options) => {
          if (config.apiBase === "https://e1.invalid/v1") {
            throw new ReaderCompletionError({ reason: "not_configured" });
          }
          return {
            text: ANSWER,
            usage: undefined,
            ...{ model: options.model },
          };
        },
        codexResponses: () => async () => ({ text: ANSWER }),
      },
      wait: async () => undefined,
    });
    const validated = tool.validate!({
      targets: ["item:1"],
      instruction: "Summarize",
    });
    if (!validated.ok) throw new Error("invalid");
    const result = (await tool.execute(validated.value, {
      request: {
        conversationKey: 0,
        mode: "agent",
        userText: "Review drift",
        libraryID: 1,
        model: "gpt-6-sol",
        authMode: "codex_app_server",
        providerProtocol: "codex_responses",
        exhaustiveReadBackend: "codex_responses",
        executionContext: { permissionOwner: "external_runtime" },
        readerSelection: { kind: "entry", entryId: "e1" },
      },
      runId: "run-r",
    } as unknown as AgentToolContext)) as PaperDigestResult;

    const row = result.papers[0] as { model?: string; readerRoute?: string };
    assert.equal(row.model, "gpt-6-sol");
    assert.equal(row.readerRoute, "codex_responses");
    assert.equal(result.readerFallback?.reason, "not_configured");
    assert.equal(result.readerFallback?.chosen.route, "turn_model");
  });
});

// ---------------------------------------------------------------------------
// paper_read mode full reads through the resolver.
// ---------------------------------------------------------------------------

const paper = {
  libraryID: 1,
  itemId: 9700,
  contextItemId: 9701,
  title: "Grid cells",
  firstCreator: "Lee",
  year: "2025",
};
const paperContent = {
  title: paper.title,
  chunks: ["Section 1\nGrid cells fire in hexagons."],
  chunkMeta: [],
  chunkStats: [],
  docFreq: {},
  avgChunkLength: 10,
  fullLength: 40,
} as unknown as PdfContext;

describe("paper_read full uses the reader resolver", function () {
  const e1 = apiEntry("e1", "acme-reader");
  const batchReply = JSON.stringify({
    digest: "Grid cells fire in hexagons.",
    relevantChunkIds: [0],
  });

  function fullTool(readerFactories: object, lookupReaderEntry = lookupOf(e1)) {
    return createPaperReadTool(
      { ensurePaperContext: async () => paperContent } as never,
      {} as never,
      {} as never,
      {
        listPaperContexts: () => [paper],
        resolvePaperContextTarget: () => paper,
      } as never,
      undefined,
      undefined,
      { readerFactories, lookupReaderEntry },
    ) as unknown as AgentToolDefinition<never, unknown>;
  }

  async function runFull(
    tool: AgentToolDefinition<never, unknown>,
    request: Record<string, unknown>,
  ) {
    const validated = tool.validate({
      mode: "full",
      query: "What do grid cells do?",
      targets: [{ itemId: paper.itemId, contextItemId: paper.contextItemId }],
    });
    if (!validated.ok) throw new Error(validated.error);
    return (await tool.execute(validated.value, {
      request: {
        conversationKey: 79,
        mode: "agent",
        conversationKind: "paper",
        userText: "Read the paper.",
        libraryID: 1,
        activeItemId: paper.itemId,
        ...request,
      } as never,
      item: null,
      currentAnswerText: "",
      modelName: "m",
    })) as {
      status: string;
      synthesisContext: string;
      reader?: { route: string; model: string };
      readerFallback?: { reason: string };
    };
  }

  it("the plugin Agent reads every batch with its turn model through the resolver", async function () {
    const seen: string[] = [];
    const output = await runFull(
      fullTool({
        turnModel:
          (config: { apiBase?: string }) =>
          async (
            _prompt: string,
            options: { model: string; maxTokens?: number },
          ) => {
            seen.push(`${config.apiBase}|${options.model}`);
            return { text: batchReply };
          },
      }),
      { model: "deepseek-flash", apiBase: "https://main.invalid" },
    );
    assert.equal(output.status, "complete");
    assert.include(output.synthesisContext, "Grid cells fire in hexagons.");
    assert.deepEqual(
      [...new Set(seen)],
      ["https://main.invalid|deepseek-flash"],
    );
    assert.notProperty(output, "reader");
  });

  it("a picked API reader reads the batches in any runtime and the result names it", async function () {
    const seen: string[] = [];
    const answering =
      (config: { apiBase?: string }) =>
      async (_prompt: string, options: { model: string }) => {
        seen.push(`${config.apiBase}|${options.model}`);
        return { text: batchReply };
      };
    const forPlugin = await runFull(fullTool({ turnModel: answering }), {
      model: "deepseek-flash",
      apiBase: "https://main.invalid",
      readerSelection: { kind: "entry", entryId: "e1" },
    });
    const forClaude = await runFull(fullTool({ turnModel: answering }), {
      model: "sonnet",
      exhaustiveReadBackend: "claude_bridge",
      readerSelection: { kind: "entry", entryId: "e1" },
    });
    assert.deepEqual([...new Set(seen)], ["https://e1.invalid/v1|acme-reader"]);
    for (const output of [forPlugin, forClaude]) {
      assert.equal(output.status, "complete");
      assert.deepEqual(output.reader, {
        route: "turn_model",
        model: "acme-reader",
      });
    }
  });

  it("a picked Codex model reads through Codex Responses, not the chat's model", async function () {
    const seen: string[] = [];
    const output = await runFull(
      fullTool({
        codexResponses:
          () => async (_prompt: string, options: { model: string }) => {
            seen.push(options.model);
            return { text: batchReply };
          },
      }),
      {
        model: "gpt-6-sol",
        authMode: "codex_app_server",
        providerProtocol: "codex_responses",
        exhaustiveReadBackend: "codex_responses",
        readerSelection: { kind: "model", model: "gpt-6.1-sol" },
      },
    );
    assert.equal(output.status, "complete");
    assert.deepEqual([...new Set(seen)], ["gpt-6.1-sol"]);
    assert.equal(output.reader?.model, "gpt-6.1-sol");
  });

  it("falls back to the main model when the picked reader's key is refused", async function () {
    const seen: string[] = [];
    const output = await runFull(
      fullTool({
        turnModel:
          (config: { apiBase?: string }) =>
          async (_prompt: string, options: { model: string }) => {
            if (config.apiBase === "https://e1.invalid/v1") {
              throw new ReaderCompletionError({
                reason: "transport",
                status: 403,
              });
            }
            seen.push(options.model);
            return { text: batchReply };
          },
      }),
      {
        model: "deepseek-flash",
        apiBase: "https://main.invalid",
        readerSelection: { kind: "entry", entryId: "e1" },
      },
    );
    assert.equal(output.status, "complete");
    assert.deepEqual([...new Set(seen)], ["deepseek-flash"]);
    assert.equal(output.readerFallback?.reason, "unauthorized");
    assert.equal(output.reader?.model, "deepseek-flash");
  });
});

// ---------------------------------------------------------------------------
// The Codex and Claude Code scopes carry the selection to the MCP tools.
// ---------------------------------------------------------------------------

describe("the picked reader reaches the MCP tool context", function () {
  const originalZotero = globalScope.Zotero;
  const prefStore = new Map<string, unknown>();
  beforeEach(async function () {
    prefStore.clear();
    globalScope.Zotero = {
      DB: new ChangeJournalTestDb(),
      Prefs: {
        get: (key: string) =>
          key === "httpServer.port" ? 24680 : prefStore.get(key),
        set: (key: string, value: unknown) => void prefStore.set(key, value),
      },
      Libraries: { userLibraryID: 1, get: () => null },
      Items: { get: () => null },
      Server: { Endpoints: {} },
    };
    await initAgentChangeJournal();
  });
  afterEach(function () {
    unregisterMcpServer();
    globalScope.Zotero = originalZotero;
  });

  it("the Claude Code scope carries the selection, never a key", function () {
    const scope = buildClaudeZoteroMcpScopeForTests(
      {
        conversationKey: 8_810,
        mode: "agent",
        userText: "read",
        libraryID: 1,
        model: "sonnet",
        readerSelection: { kind: "entry", entryId: "e1" },
      },
      "profile-reader-picker",
    );
    assert.deepEqual(scope.readerSelection, { kind: "entry", entryId: "e1" });
    assert.notInclude(JSON.stringify(scope), "secret-");
  });

  it("the Codex scope carries the selection from the prepared request", function () {
    const scope = buildCodexNativeScopedMcpScopeForTests({
      preparedRequest: {
        conversationKey: 8_811,
        mode: "agent",
        userText: "read",
        libraryID: 1,
        model: "gpt-6-sol",
        readerSelection: { kind: "model", model: "gpt-6.1-sol" },
      } as never,
      scope: { conversationKey: 8_811, libraryID: 1, kind: "global" },
      profileSignature: "profile-reader-picker",
      userText: "read",
      model: "gpt-6-sol",
    });
    assert.deepEqual(scope.readerSelection, {
      kind: "model",
      model: "gpt-6.1-sol",
    });
  });

  it("a scoped MCP call hands the tool the selection on its request", async function () {
    let observed: AgentToolContext["request"]["readerSelection"];
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "library_read",
        description: "probe",
        inputSchema: { type: "object", additionalProperties: true },
        executionClass: "read",
        workCategory: "retrieval",
        requiresConfirmation: false,
      },
      validate: (args: unknown) => ({ ok: true, value: args ?? {} }),
      execute: async (_input: unknown, context: AgentToolContext) => {
        observed = context.request.readerSelection;
        return { ok: true };
      },
    } as never);
    registerMcpServer({ toolRegistry: registry, zoteroGateway: {} as never });
    const scope = registerScopedZoteroMcpScope({
      conversationKey: 8_812,
      conversationGeneration: 0,
      libraryID: 1,
      kind: "global",
      runtimeAuthority: "codex",
      readerSelection: { kind: "model", model: "gpt-6.1-sol" },
    });
    try {
      const Endpoint = (
        (globalScope.Zotero as any).Server.Endpoints as Record<string, any>
      )[ZOTERO_MCP_ENDPOINT_PATH];
      const reply = await new Endpoint().init({
        method: "POST",
        data: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "library_read", arguments: {} },
        },
        headers: {
          Authorization: `Bearer ${getOrCreateZoteroMcpBearerToken()}`,
          [ZOTERO_MCP_SCOPE_HEADER]: scope.token,
        },
      });
      const payload = JSON.parse(reply[2]);
      assert.isUndefined(payload.result?.isError, JSON.stringify(payload));
      assert.deepEqual(observed, { kind: "model", model: "gpt-6.1-sol" });
    } finally {
      scope.clear();
      unregisterMcpServer();
    }
  });
});

describe("the agent request carries the runtime's picked reader", function () {
  const originalZotero = globalScope.Zotero;
  const prefStore = new Map<string, unknown>();
  beforeEach(function () {
    prefStore.clear();
    prefStore.set(pref("readerChoiceAgent"), "entry:e1");
    prefStore.set(pref("readerChoiceCodex"), "model:gpt-6.1-sol");
    prefStore.set(pref("readerChoiceClaude"), "model:haiku");
    clearStandaloneSurfaceChoices();
    globalScope.Zotero = {
      Items: { get: () => null },
      Prefs: { get: (key: string) => prefStore.get(key) },
    };
  });
  afterEach(function () {
    clearStandaloneSurfaceChoices();
    globalScope.Zotero = originalZotero;
  });

  const build = (
    config: Record<string, unknown>,
    surface?: "embedded" | "standalone",
  ) =>
    buildAgentRuntimeRequestForTests(
      toAgentRuntimeRequestParams(
        {
          selectedTexts: [],
          selectedPaperContexts: [],
          fullTextPaperContexts: [],
          attachedConversations: undefined,
          attachments: undefined,
          screenshots: undefined,
        },
        {
          conversationKey: 7_410,
          item: {
            id: 9_001,
            libraryID: 1,
            isAttachment: () => false,
            isRegularItem: () => false,
            isNote: () => false,
          } as unknown as Zotero.Item,
          userText: "Review",
          effectiveRequestConfig: {
            model: "m",
            apiBase: "https://example.invalid",
            apiKey: "k",
            authMode: "api_key",
            reasoning: undefined,
            advanced: undefined,
            ...config,
          } as never,
          history: [],
          ...(surface ? { surface } : {}),
        },
      ),
    );

  it("names the selection of the runtime the model belongs to, without a key", async function () {
    const agent = await build({});
    assert.deepEqual(agent.readerSelection, { kind: "entry", entryId: "e1" });
    const codex = await build({
      authMode: "codex_app_server",
      providerProtocol: "codex_responses",
    });
    assert.deepEqual(codex.readerSelection, {
      kind: "model",
      model: "gpt-6.1-sol",
    });
    const claude = await build({ modelProviderLabel: "Claude Code" });
    assert.deepEqual(claude.readerSelection, { kind: "model", model: "haiku" });
    assert.notProperty(agent.readerSelection, "apiKey");
  });

  it("leaves it out for Same as main", async function () {
    prefStore.set(pref("readerChoiceAgent"), "");
    const request = await build({});
    assert.isUndefined(request.readerSelection);
  });

  it("reads the window's own pick on the standalone surface", async function () {
    startStandaloneSurfaceChoicesFromSidebar();
    bindSurfaceChoices(() => "standalone").setReaderSelection("agent", {
      kind: "entry",
      entryId: "e2",
    });
    const request = await build({}, "standalone");
    assert.deepEqual(request.readerSelection, { kind: "entry", entryId: "e2" });
    const sidebar = await build({}, "embedded");
    assert.deepEqual(sidebar.readerSelection, { kind: "entry", entryId: "e1" });
  });
});
