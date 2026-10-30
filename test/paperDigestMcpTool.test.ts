import { assert } from "chai";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";
import {
  PAPER_DIGEST_LIBRARY_UNKNOWN,
  PAPER_DIGEST_MAX_PAPERS_PER_CALL,
  PAPER_DIGEST_OTHER_LIBRARY,
  PAPER_DIGEST_READER_CALL_LIMIT,
  clearPaperDigestRunBounds,
  createPaperDigestTool,
  trackedPaperDigestRuns,
  type PaperDigestResult,
  type PaperDigestToolDeps,
} from "../src/agent/tools/read/paperDigest";
import {
  DIGEST_FAILURE_REASONS,
  type HostPaperDigest,
  type PaperDigestCache,
} from "../src/agent/digests/paperDigestWorker";
import { DIGEST_BODY_DEPTH_CHARS } from "../src/agent/digests/digestJobHost";
import { PAPER_DIGEST_BODY_DEPTH_CHARS } from "../src/agent/context/readObservation";
import {
  ZOTERO_MCP_ENDPOINT_PATH,
  ZOTERO_MCP_SCOPE_HEADER,
  ZOTERO_MCP_TOOL_TIMEOUT_SEC,
  addZoteroMcpToolActivityObserver,
  buildZoteroMcpConfigValue,
  getOrCreateZoteroMcpBearerToken,
  getZoteroMcpAllowedToolNames,
  getZoteroMcpDirectPdfToolNames,
  registerMcpServer,
  registerScopedZoteroMcpScope,
  unregisterMcpServer,
} from "../src/agent/mcp/server";
import {
  buildClaudeZoteroMcpAllowedToolNames,
  buildClaudeZoteroMcpServerConfig,
  buildCodexZoteroMcpThreadConfig,
  preflightCodexZoteroMcpServer,
  clearCodexZoteroMcpPreflightCache,
} from "../src/codexAppServer/mcpSetup";
import type { ReaderCompletion } from "../src/shared/readerCompletion";
import type { AgentToolContext } from "../src/agent/types";

const TEXT = [
  "# Drift paper",
  "Representational drift did not impair decoding across ten sessions of recording.",
  "We recorded 40 cells over 10 days in the hippocampus of behaving mice.",
  "Body text that describes the methods in neutral and complete detail. ".repeat(
    90,
  ),
].join("\n\n");

const ANSWER = JSON.stringify({
  answer: "Drift did not impair decoding.",
  evidence: [
    {
      section: "Results",
      quote:
        "Representational drift did not impair decoding across ten sessions of recording.",
    },
  ],
});

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

type FakeReader = {
  calls: string[];
  peak: number;
  factory: () => ReaderCompletion;
};

function fakeReader(
  reply: (prompt: string) => string | Promise<string> = () => ANSWER,
  delayMs = 0,
): FakeReader {
  const state = { calls: [] as string[], peak: 0, running: 0 };
  const complete: ReaderCompletion = async (prompt, options) => {
    state.calls.push(options.model);
    state.running += 1;
    state.peak = Math.max(state.peak, state.running);
    try {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { text: await reply(prompt) };
    } finally {
      state.running -= 1;
    }
  };
  return {
    get calls() {
      return state.calls;
    },
    get peak() {
      return state.peak;
    },
    factory: () => complete,
  };
}

function deps(
  reader: FakeReader,
  cache: PaperDigestCache,
  overrides: Partial<PaperDigestToolDeps> = {},
): PaperDigestToolDeps {
  return {
    resolvePaper: async (_request, itemId) => ({
      itemId,
      contextItemId: itemId + 1000,
      libraryID: itemId === 99 ? 2 : 1,
      title: `Paper ${itemId}`,
    }),
    readText: async () => ({
      backend: "mineru",
      text: TEXT,
      totalCharacters: TEXT.length,
    }),
    createCache: () => cache,
    readerFactories: {
      codexResponses: reader.factory,
      claudeBridge: reader.factory,
    },
    wait: async () => undefined,
    ...overrides,
  };
}

function context(
  runId: string,
  request: Record<string, unknown> = {},
  signal?: AbortSignal,
): AgentToolContext {
  return {
    request: {
      conversationKey: 0,
      mode: "agent",
      userText: "Review drift",
      libraryID: 1,
      model: "gpt-5.4",
      authMode: "codex_app_server",
      providerProtocol: "codex_responses",
      exhaustiveReadBackend: "codex_responses",
      executionContext: { permissionOwner: "external_runtime" },
      ...request,
    },
    runId,
    signal,
  } as unknown as AgentToolContext;
}

const targets = (count: number, from = 1) =>
  Array.from({ length: count }, (_, index) => `item:${from + index}`);

async function call(
  tool: ReturnType<typeof createPaperDigestTool>,
  input: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<PaperDigestResult> {
  const validated = tool.validate!(input);
  assert.isTrue(validated.ok, JSON.stringify(validated));
  if (!validated.ok) throw new Error("invalid");
  return (await tool.execute(validated.value, ctx)) as PaperDigestResult;
}

describe("paper_digest MCP tool", function () {
  afterEach(function () {
    clearPaperDigestRunBounds();
  });

  it("is a read that only an external runtime with a native reader sees", function () {
    const tool = createPaperDigestTool(deps(fakeReader(), memoryCache()));
    assert.equal(tool.spec.executionClass, "read");
    const visible = (request: Record<string, unknown>) =>
      tool.isAvailable!(context("r", request).request);
    assert.isTrue(visible({}));
    assert.isTrue(visible({ exhaustiveReadBackend: "claude_bridge" }));
    assert.isFalse(visible({ exhaustiveReadBackend: "unavailable" }));
    assert.isFalse(
      visible({ executionContext: { permissionOwner: "original_agent" } }),
    );
    assert.isAtMost(tool.spec.description.length, 1200);
    assert.include(tool.spec.description, "pending");
  });

  it("refuses the plugin Agent, which declares a task_update digest part instead", async function () {
    const tool = createPaperDigestTool(deps(fakeReader(), memoryCache()));
    try {
      await call(
        tool,
        { targets: ["item:1"], instruction: "Summarize" },
        context("r", {
          executionContext: { permissionOwner: "original_agent" },
        }),
      );
      assert.fail("expected a refusal");
    } catch (error) {
      assert.include((error as Error).message, "task_update digest part");
    }
  });

  it("validates targets and the instruction", function () {
    const tool = createPaperDigestTool(deps(fakeReader(), memoryCache()));
    const parsed = tool.validate!({
      targets: [3, "item:3", "4"],
      instruction: " Summarize ",
    });
    assert.deepEqual(parsed, {
      ok: true,
      value: { targets: ["item:3", "item:4"], instruction: "Summarize" },
    });
    assert.isFalse(tool.validate!({ targets: [], instruction: "x" }).ok);
    assert.isFalse(tool.validate!({ targets: ["paper"], instruction: "x" }).ok);
    assert.isFalse(
      tool.validate!({ targets: ["item:1"], instruction: " " }).ok,
    );
  });

  it(`reads at most ${PAPER_DIGEST_MAX_PAPERS_PER_CALL} papers a call and returns the rest pending; a repeat continues without reading twice`, async function () {
    const reader = fakeReader();
    const tool = createPaperDigestTool(deps(reader, memoryCache()));
    const input = { targets: targets(10), instruction: "Summarize each paper" };
    const first = await call(tool, input, context("run-k"));
    assert.equal(first.status, "partial");
    assert.deepEqual(first.pending, ["item:9", "item:10"]);
    assert.lengthOf(first.papers, 8);
    assert.isTrue(first.papers.every((row) => row.status === "digested"));
    assert.include(first.note || "", "pending");
    assert.lengthOf(reader.calls, 8);
    assert.deepEqual([...new Set(reader.calls)], ["gpt-5.4"]);
    const row = first.papers[0] as Extract<
      PaperDigestResult["papers"][number],
      { answer: string }
    >;
    assert.equal(row.model, "gpt-5.4");
    assert.equal(row.readerRoute, "codex_responses");
    assert.equal(row.libraryID, 1);
    assert.isTrue(row.source.complete);

    const second = await call(tool, input, context("run-k"));
    assert.equal(second.status, "complete");
    assert.notProperty(second, "pending");
    assert.lengthOf(reader.calls, 10, "only the two pending papers are read");
    const repeated = second.papers.filter(
      (entry) => "alreadyReturned" in entry,
    );
    assert.lengthOf(repeated, 8);
    // The digest body comes back again, flagged, for a client whose context
    // lost it; it is not read again and does not count toward the call's 8.
    assert.property(repeated[0], "answer");
    assert.equal((repeated[0] as { answer: string }).answer, row.answer);
    assert.isTrue(
      (repeated[0] as { alreadyReturned: boolean }).alreadyReturned,
    );
    assert.include(second.note || "", "alreadyReturned");
  });

  it("does not count repeated digests against the papers one call reads", async function () {
    const reader = fakeReader();
    const tool = createPaperDigestTool(deps(reader, memoryCache()));
    await call(
      tool,
      { targets: targets(8), instruction: "Summarize" },
      context("run-rep"),
    );
    const next = await call(
      tool,
      { targets: [...targets(8), ...targets(8, 20)], instruction: "Summarize" },
      context("run-rep"),
    );
    assert.lengthOf(next.papers, 16);
    assert.notProperty(next, "pending");
    assert.lengthOf(reader.calls, 16);
  });

  it("reports a failed paper once: a repeat call flags it as already reported", async function () {
    const reader = fakeReader(() => {
      throw new Error("socket hang up");
    });
    const tool = createPaperDigestTool(deps(reader, memoryCache()));
    const input = { targets: ["item:1"], instruction: "Summarize" };
    const first = await call(tool, input, context("run-rep-f"));
    const second = await call(tool, input, context("run-rep-f"));
    const third = await call(tool, input, context("run-rep-f"));
    const final = await call(tool, input, context("run-rep-f"));
    assert.notProperty(first.papers[0], "alreadyReported");
    for (const result of [second, third, final]) {
      assert.isTrue(
        (result.papers[0] as { alreadyReported?: boolean }).alreadyReported,
      );
    }
  });

  it("flags a repeated failure only when its reason is the one already reported", async function () {
    let failure = "socket hang up";
    const reader = fakeReader(() => {
      throw new Error(failure);
    });
    const tool = createPaperDigestTool(deps(reader, memoryCache()));
    const input = { targets: ["item:1"], instruction: "Summarize" };
    const flagged = (result: PaperDigestResult) =>
      (result.papers[0] as { alreadyReported?: boolean }).alreadyReported ===
      true;
    const reasonOf = (result: PaperDigestResult) =>
      (result.papers[0] as { reason: string }).reason;
    // Transport, then timeout: the second row carries a new reason.
    const first = await call(tool, input, context("run-rep-change"));
    failure = "request timed out";
    const second = await call(tool, input, context("run-rep-change"));
    assert.equal(reasonOf(first), DIGEST_FAILURE_REASONS.transport);
    assert.equal(reasonOf(second), DIGEST_FAILURE_REASONS.timeout);
    assert.isFalse(flagged(first));
    assert.isFalse(flagged(second));
    // Timeout again: now it repeats.
    const third = await call(tool, input, context("run-rep-change"));
    assert.equal(reasonOf(third), DIGEST_FAILURE_REASONS.timeout);
    assert.isTrue(flagged(third));
  });

  it("keeps the retry state of two chats apart, even under one run id", async function () {
    const reader = fakeReader();
    const tool = createPaperDigestTool(deps(reader, memoryCache()));
    const input = { targets: ["item:1"], instruction: "Summarize" };
    await call(tool, input, context("run-shared", { conversationKey: 11 }));
    const again = await call(
      tool,
      input,
      context("run-shared", { conversationKey: 11 }),
    );
    assert.isTrue(
      (again.papers[0] as { alreadyReturned?: true }).alreadyReturned,
    );
    const other = await call(
      tool,
      input,
      context("run-shared", { conversationKey: 12 }),
    );
    assert.notProperty(other.papers[0], "alreadyReturned");
  });

  it("counts only the papers it read in the pending note", async function () {
    const reader = fakeReader();
    const tool = createPaperDigestTool(deps(reader, memoryCache()));
    const result = await call(
      tool,
      { targets: ["item:99", ...targets(9)], instruction: "Summarize" },
      context("run-count"),
    );
    // The refused paper takes no place among the 8 read.
    assert.lengthOf(reader.calls, 8);
    assert.include(result.note || "", "This call read 8 papers");
    assert.deepEqual(result.pending, ["item:9"]);
    assert.equal(
      (result.papers[0] as { reason: string }).reason,
      PAPER_DIGEST_OTHER_LIBRARY,
    );
  });

  it("resumes a later run from the conversation's cache without reading again", async function () {
    const reader = fakeReader();
    const cache = memoryCache();
    const tool = createPaperDigestTool(deps(reader, cache));
    const input = { targets: targets(3), instruction: "Summarize each paper" };
    await call(tool, input, context("run-1"));
    assert.lengthOf(reader.calls, 3);
    const resumed = await call(tool, input, context("run-2"));
    assert.lengthOf(reader.calls, 3);
    assert.lengthOf(
      resumed.papers.filter(
        (entry) => entry.status === "digested" && "answer" in entry,
      ),
      3,
      "a new run gets the digests in full, from the cache",
    );
  });

  it(`shares one limit of ${PAPER_DIGEST_READER_CALL_LIMIT} reader calls across concurrent calls`, async function () {
    const reader = fakeReader(() => ANSWER, 5);
    const tool = createPaperDigestTool(deps(reader, memoryCache()));
    await Promise.all([
      call(
        tool,
        { targets: targets(8), instruction: "Summarize" },
        context("run-a"),
      ),
      call(
        tool,
        { targets: targets(8, 20), instruction: "Summarize" },
        context("run-b"),
      ),
    ]);
    assert.lengthOf(reader.calls, 16);
    assert.equal(reader.peak, PAPER_DIGEST_READER_CALL_LIMIT);
  });

  it("runs a failed paper again on at most two later calls of a run, then names it final", async function () {
    const reader = fakeReader(() => {
      throw new Error("socket hang up");
    });
    const tool = createPaperDigestTool(deps(reader, memoryCache()));
    const input = { targets: ["item:1"], instruction: "Summarize" };
    const reasons: string[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = await call(tool, input, context("run-f"));
      const row = result.papers[0];
      assert.equal(row.status, "failed");
      reasons.push(
        `${(row as { reason: string }).reason}${"final" in row && row.final ? " (final)" : ""}`,
      );
    }
    assert.deepEqual(reasons, [
      DIGEST_FAILURE_REASONS.transport,
      DIGEST_FAILURE_REASONS.transport,
      DIGEST_FAILURE_REASONS.transport,
      `${DIGEST_FAILURE_REASONS.transport} (final)`,
    ]);
    // Each run is a first call and one retry; the final call reads nothing.
    assert.lengthOf(reader.calls, 6);
    // Another run starts with a fresh budget.
    await call(tool, input, context("run-g"));
    assert.lengthOf(reader.calls, 8);
  });

  it("ends a run's bounds when its scope's signal ends", async function () {
    const tool = createPaperDigestTool(deps(fakeReader(), memoryCache()));
    const controller = new AbortController();
    await call(
      tool,
      { targets: ["item:1"], instruction: "Summarize" },
      context("run-end", {}, controller.signal),
    );
    assert.include(trackedPaperDigestRuns(), "run-end");
    controller.abort();
    assert.notInclude(trackedPaperDigestRuns(), "run-end");
  });

  it("does not read a paper of another library", async function () {
    const reader = fakeReader();
    const tool = createPaperDigestTool(deps(reader, memoryCache()));
    const result = await call(
      tool,
      { targets: ["item:99"], instruction: "Summarize" },
      context("run-lib"),
    );
    assert.deepEqual(result.papers, [
      {
        status: "failed",
        itemId: 99,
        title: "Paper 99",
        reason: PAPER_DIGEST_OTHER_LIBRARY,
      },
    ]);
    assert.lengthOf(reader.calls, 0);
  });

  it("refuses a paper whose library cannot be determined, and one with no chat library", async function () {
    const reader = fakeReader();
    const unknown = createPaperDigestTool(
      deps(reader, memoryCache(), {
        resolvePaper: async (_request, itemId) =>
          itemId === 5
            ? null
            : ({
                itemId,
                contextItemId: itemId + 1000,
                title: "No library",
              } as never),
      }),
    );
    const result = await call(
      unknown,
      { targets: ["item:4", "item:5"], instruction: "Summarize" },
      context("run-unknown"),
    );
    assert.deepEqual(
      result.papers.map((row) => [
        (row as { itemId: number }).itemId,
        row.status,
        (row as { reason?: string }).reason,
      ]),
      [
        [4, "failed", PAPER_DIGEST_LIBRARY_UNKNOWN],
        [5, "failed", PAPER_DIGEST_LIBRARY_UNKNOWN],
      ],
    );
    const known = createPaperDigestTool(deps(reader, memoryCache()));
    const noChatLibrary = await call(
      known,
      { targets: ["item:1"], instruction: "Summarize" },
      context("run-no-lib", { libraryID: undefined }),
    );
    assert.equal(
      (noChatLibrary.papers[0] as { reason: string }).reason,
      PAPER_DIGEST_LIBRARY_UNKNOWN,
    );
    assert.lengthOf(reader.calls, 0);
  });

  it("refuses when the scope has no reader", async function () {
    const tool = createPaperDigestTool(deps(fakeReader(), memoryCache()));
    try {
      await call(
        tool,
        { targets: ["item:1"], instruction: "Summarize" },
        context("run-none", {
          exhaustiveReadBackend: "unavailable",
          authMode: undefined,
          providerProtocol: undefined,
        }),
      );
      assert.fail("expected a refusal");
    } catch (error) {
      assert.include((error as Error).message, "No reader model");
    }
  });

  it("keeps the digest body-depth threshold equal on both attestation paths", function () {
    assert.equal(PAPER_DIGEST_BODY_DEPTH_CHARS, DIGEST_BODY_DEPTH_CHARS);
  });
});

describe("paper_digest over the MCP server", function () {
  const originalZotero = globalThis.Zotero;
  const prefStore = new Map<string, unknown>();

  beforeEach(async function () {
    prefStore.clear();
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      DB: new ChangeJournalTestDb(),
      Prefs: {
        get: (key: string) =>
          key === "httpServer.port" ? 24680 : prefStore.get(key),
        set: (key: string, value: unknown) => void prefStore.set(key, value),
      },
      Libraries: { userLibraryID: 1 },
      Items: {
        get: (id: number) =>
          id > 0
            ? {
                id,
                key: `KEY${id}`,
                libraryID: 7,
                isAttachment: () => id > 1000,
              }
            : null,
      },
      Server: { Endpoints: {} },
    } as unknown as typeof Zotero;
    await initAgentChangeJournal();
  });

  afterEach(function () {
    unregisterMcpServer();
    clearPaperDigestRunBounds();
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
  });

  async function invoke(
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ): Promise<Record<string, any>> {
    const EndpointClass = (
      globalThis.Zotero.Server.Endpoints as Record<string, any>
    )[ZOTERO_MCP_ENDPOINT_PATH];
    const [, , text] = await new EndpointClass().init({
      method: "POST",
      data: body,
      headers: {
        Authorization: `Bearer ${getOrCreateZoteroMcpBearerToken()}`,
        ...headers,
      },
    });
    return JSON.parse(text);
  }

  function register(reader: FakeReader) {
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
    registry.register(
      createPaperDigestTool(
        deps(reader, memoryCache(), {
          resolvePaper: async (_request, itemId) => ({
            itemId,
            contextItemId: itemId + 1000,
            libraryID: 7,
            title: `Paper ${itemId}`,
          }),
          readText: async (paper) =>
            paper.itemId === 2
              ? null
              : { backend: "mineru", text: TEXT, totalCharacters: TEXT.length },
        }),
      ),
    );
    registerMcpServer({ toolRegistry: registry, zoteroGateway: {} as never });
  }

  const listNames = async (headers?: Record<string, string>) =>
    (
      await invoke({ jsonrpc: "2.0", id: 1, method: "tools/list" }, headers)
    ).result.tools.map((tool: { name: string }) => tool.name);

  it("lists paper_digest only to a scope with a native reader", async function () {
    register(fakeReader());
    const codex = registerScopedZoteroMcpScope(
      {
        conversationKey: 791,
        libraryID: 7,
        kind: "global",
        model: "gpt-5.4",
        exhaustiveReadBackend: "codex_responses",
      },
      { token: "digest-scope-codex" },
    );
    const standalone = registerScopedZoteroMcpScope(
      { conversationKey: 792, libraryID: 7, kind: "global" },
      { token: "digest-scope-none" },
    );
    try {
      assert.include(
        await listNames({ [ZOTERO_MCP_SCOPE_HEADER]: codex.token }),
        "paper_digest",
      );
      assert.notInclude(
        await listNames({ [ZOTERO_MCP_SCOPE_HEADER]: standalone.token }),
        "paper_digest",
      );
      assert.notInclude(await listNames(), "paper_digest");
    } finally {
      codex.clear();
      standalone.clear();
    }
  });

  function digestCall(args: Record<string, unknown>) {
    return {
      jsonrpc: "2.0",
      id: "digest-x",
      method: "tools/call",
      params: { name: "paper_digest", arguments: args },
    };
  }

  it("refuses a model-supplied libraryID other than the scope's library", async function () {
    const reader = fakeReader();
    register(reader);
    const scoped = registerScopedZoteroMcpScope(
      {
        conversationKey: 793,
        libraryID: 7,
        kind: "global",
        runId: "codex-digest-pin",
        model: "gpt-5.4",
        exhaustiveReadBackend: "codex_responses",
      },
      { token: "digest-scope-pin" },
    );
    try {
      const reply = await invoke(
        digestCall({
          targets: ["item:1"],
          instruction: "Summarize",
          libraryID: 9,
        }),
        { [ZOTERO_MCP_SCOPE_HEADER]: scoped.token },
      );
      assert.isTrue(reply.result.isError);
      const payload = JSON.parse(reply.result.content[0].text);
      assert.isFalse(payload.ok);
      assert.match(payload.error, /^paper_digest reads only papers of this/);
      assert.lengthOf(reader.calls, 0);
      // The scope's own library is accepted.
      const accepted = await invoke(
        digestCall({
          targets: ["item:1"],
          instruction: "Summarize",
          libraryID: 7,
        }),
        { [ZOTERO_MCP_SCOPE_HEADER]: scoped.token },
      );
      assert.notProperty(accepted.result, "isError");
    } finally {
      scoped.clear();
    }
  });

  it("records a failed paper once, and repeats a digest without recording it again", async function () {
    const reader = fakeReader();
    register(reader);
    const scoped = registerScopedZoteroMcpScope(
      {
        conversationKey: 794,
        libraryID: 7,
        kind: "global",
        runId: "codex-digest-repeat",
        runtimeAuthority: "codex",
        model: "gpt-5.4",
        exhaustiveReadBackend: "codex_responses",
      },
      { token: "digest-scope-repeat" },
    );
    const completed: Array<Record<string, any>> = [];
    const unregister = addZoteroMcpToolActivityObserver((event) => {
      if (event.phase === "completed") completed.push(event);
    });
    const replies: Array<Record<string, any>> = [];
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const reply = await invoke(
          digestCall({
            targets: ["item:1", "item:2"],
            instruction: "Summarize each paper",
          }),
          { [ZOTERO_MCP_SCOPE_HEADER]: scoped.token },
        );
        replies.push(JSON.parse(reply.result.content[0].text));
      }
    } finally {
      unregister();
      scoped.clear();
    }
    assert.lengthOf(completed, 2);
    assert.deepEqual(
      completed[0].paperLedgerDelta.papers.map((paper: any) => paper.key),
      ["7:1", "7:2"],
    );
    // The repeat adds no ledger row and no read observation.
    const repeatDelta = completed[1].paperLedgerDelta;
    assert.deepEqual(repeatDelta?.papers ?? [], []);
    assert.deepEqual(repeatDelta?.reads ?? [], []);
    assert.lengthOf(completed[1].readObservations ?? [], 0);
    // It carries the refs the first call recorded, and no new ones.
    assert.lengthOf(replies[0].documentEvidenceRefs, 1);
    assert.deepEqual(
      replies[1].documentEvidenceRefs,
      replies[0].documentEvidenceRefs,
    );
    // The digest body is back for a client that lost it.
    const [first, failed] = replies[1].result.papers;
    assert.isTrue(first.alreadyReturned);
    assert.include(first.answer, "Drift did not impair decoding");
    assert.isTrue(failed.alreadyReported);
  });

  it("attests each digested paper and records one ledger row per paper", async function () {
    const reader = fakeReader();
    register(reader);
    const scoped = registerScopedZoteroMcpScope(
      {
        conversationKey: 791,
        libraryID: 7,
        kind: "global",
        runId: "codex-digest-run",
        model: "gpt-5.4",
        exhaustiveReadBackend: "codex_responses",
      },
      { token: "digest-scope-ledger" },
    );
    const completed: Array<Record<string, any>> = [];
    const unregister = addZoteroMcpToolActivityObserver((event) => {
      if (event.phase === "completed") completed.push(event);
    });
    let reply: Record<string, any>;
    try {
      reply = await invoke(
        {
          jsonrpc: "2.0",
          id: "digest-1",
          method: "tools/call",
          params: {
            name: "paper_digest",
            arguments: {
              targets: ["item:1", "item:2"],
              instruction: "Summarize each paper",
            },
          },
        },
        { [ZOTERO_MCP_SCOPE_HEADER]: scoped.token },
      );
    } finally {
      unregister();
      scoped.clear();
    }
    assert.notProperty(reply.result, "isError");
    const payload = JSON.parse(reply.result.content[0].text);
    assert.deepEqual(
      payload.result.papers.map((row: any) => [row.itemId, row.status]),
      [
        [1, "digested"],
        [2, "failed"],
      ],
    );
    assert.lengthOf(payload.documentEvidenceRefs, 1);
    assert.equal(payload.documentEvidenceRefs[0].itemKey, "KEY1");
    assert.deepEqual(payload.documentEvidenceRefs[0].capabilities, ["body"]);

    assert.lengthOf(completed, 1);
    const [event] = completed;
    assert.lengthOf(event.readObservations, 1);
    assert.equal(event.readObservations[0].toolName, "paper_digest");
    assert.equal(event.readObservations[0].readMode, "digest");
    const delta = event.paperLedgerDelta;
    assert.equal(delta.toolName, "paper_digest");
    assert.equal(delta.runId, "codex-digest-run");
    assert.deepEqual(
      delta.papers.map((paper: any) => [paper.key, paper.state]),
      [
        ["7:1", "read"],
        ["7:2", "matched"],
      ],
    );
    const reads = delta.reads.filter((read: any) => read.key === "7:1");
    assert.deepEqual(
      reads.map((read: any) => read.granularity),
      ["digest", "passage"],
    );
    assert.equal(reads[0].snippet, "Drift did not impair decoding.");
    assert.equal(reads[0].label, "Summarize each paper");
    // The digest read records whether the digest read the whole text.
    assert.isBoolean(reads[0].complete);
    assert.equal(reads[0].complete, payload.result.papers[0].source.complete);
    assert.deepEqual(reads[0].observationIds, [
      event.readObservations[0].observationId,
    ]);
    const failedRead = delta.reads.find((read: any) => read.key === "7:2");
    assert.equal(failedRead.whyMatched, DIGEST_FAILURE_REASONS.noText);
    assert.lengthOf(reader.calls, 1);
  });
});

describe("MCP surfaces carry paper_digest and a long tool timeout", function () {
  const originalZotero = globalThis.Zotero;
  const prefStore = new Map<string, unknown>();
  beforeEach(function () {
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Prefs: {
        get: (key: string) =>
          key === "httpServer.port" ? 24680 : prefStore.get(key),
        set: (key: string, value: unknown) => void prefStore.set(key, value),
      },
    } as unknown as typeof Zotero;
  });
  afterEach(function () {
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
  });

  it("allows paper_digest on the curated lists but hides it from raw-PDF turns", function () {
    assert.include(getZoteroMcpAllowedToolNames(), "paper_digest");
    assert.notInclude(getZoteroMcpDirectPdfToolNames(), "paper_digest");
    assert.include(
      buildClaudeZoteroMcpAllowedToolNames("zotero"),
      "mcp__zotero__paper_digest",
    );
    assert.notInclude(
      buildClaudeZoteroMcpAllowedToolNames("zotero", true),
      "mcp__zotero__paper_digest",
    );
  });

  it("asks Codex and Claude Code for a tool timeout that fits a full paper_digest call", function () {
    assert.isAtLeast(ZOTERO_MCP_TOOL_TIMEOUT_SEC, 900);
    const value = buildZoteroMcpConfigValue();
    assert.equal(value.tool_timeout_sec, ZOTERO_MCP_TOOL_TIMEOUT_SEC);
    const thread = buildCodexZoteroMcpThreadConfig({ profileSignature: "p" });
    const servers = thread.config.mcp_servers as Record<
      string,
      Record<string, unknown>
    >;
    assert.equal(
      servers[thread.serverName].tool_timeout_sec,
      ZOTERO_MCP_TOOL_TIMEOUT_SEC,
    );
    const claude = buildClaudeZoteroMcpServerConfig({ profileSignature: "p" });
    assert.equal(
      claude.mcpServers[claude.serverName].timeout,
      ZOTERO_MCP_TOOL_TIMEOUT_SEC * 1000,
    );
  });

  it("passes the Codex preflight when the server lists paper_digest", async function () {
    clearCodexZoteroMcpPreflightCache();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}"));
      const result =
        body.method === "tools/list"
          ? {
              tools: ["library_search", "paper_read", "paper_digest"].map(
                (name) => ({ name }),
              ),
            }
          : {};
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id ?? null, result }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const status = await preflightCodexZoteroMcpServer({
        scopeToken: "preflight-token",
      });
      assert.include(status.toolNames, "paper_digest");
    } finally {
      globalThis.fetch = originalFetch;
      clearCodexZoteroMcpPreflightCache();
    }
  });
});
