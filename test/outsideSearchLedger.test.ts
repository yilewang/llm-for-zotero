import { assert } from "chai";
import {
  buildOutsideSearchNote,
  clearOutsideSearchTurn,
  latchOutsideSearch,
  OPENALEX_RATE_LIMIT_MESSAGE,
  OUTSIDE_SEARCH_FINAL_AT,
  OUTSIDE_SEARCH_FINISH_AT,
  outsideSearchCount,
  outsideSearchLatch,
  recordOutsideSearch,
  resetOutsideSearchLedger,
  SCOPELESS_MCP_RUN_PREFIX,
  tracksOutsideSearchTurn,
  webSearchUnavailableMessage,
} from "../src/agent/tools/read/outsideSearchLedger";
import {
  OUTSIDE_SEARCH_NEED_MESSAGE,
  OUTSIDE_SEARCH_STOP_NOTE,
  REVIEW_WITHOUT_CARD_NEED_MESSAGE,
} from "../src/agent/tools/read/outsideSearchNeed";
import { EPHEMERAL_PAPER_CONVERSATION_KEY_BASE } from "../src/shared/conversationKeySpace";
import { createLiteratureSearchTool } from "../src/agent/tools/read/literatureSearch";
import { createWebSearchTool } from "../src/agent/tools/read/webSearch";
import {
  LiteratureProviderHttpError,
  LiteratureSearchService,
} from "../src/agent/services/literatureSearchService";
import { WebAccessError } from "../src/webAccess/errors";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { ToolInputRejection } from "../src/agent/tools/execution/failure";
import {
  TAVILY_API_KEY_PREF,
  setWebAccessProvider,
} from "../src/webAccess/prefs";
import { TurnBoundary } from "../src/agent/loop/turnBoundary";
import { clearAgentToolResultHandleStore } from "../src/agent/store/toolResultHandles";
import type { AgentToolContext } from "../src/agent/types";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

/**
 * Outside-search discipline for one turn: the per-family ledger every
 * outside result closes with, the finish-now note it turns into, and the
 * latch that fails fast once a provider is rate-limited or out of quota.
 */

const RUN = "outside-search-ledger-run";

function makeContext(runId = RUN): AgentToolContext {
  return {
    runId,
    request: resolvedAgentRequest({
      conversationKey: 4401,
      mode: "agent",
      userText: "Did other studies find the same stability?",
      libraryID: 1,
    }),
    item: null,
    currentAnswerText: "",
    modelName: "test",
  };
}

const NEED = {
  need: "not_in_scope_or_library",
  gap: "The paper and library hold no replications.",
} as const;

type FetchCall = string;

function openAlexFetch(calls: FetchCall[], status = 200): typeof fetch {
  return (async (url: string | URL | Request) => {
    calls.push(String(url));
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({
        results: [
          {
            id: "https://openalex.org/W1",
            display_name: "A replication",
            doi: "https://doi.org/10.1000/rep",
            publication_year: 2023,
            authorships: [{ author: { display_name: "Ana Example" } }],
          },
        ],
      }),
    } as unknown as Response;
  }) as typeof fetch;
}

describe("outside search ledger", function () {
  afterEach(function () {
    clearOutsideSearchTurn(RUN);
  });

  it("closes a result with the count, the queries and the stop note", function () {
    recordOutsideSearch(RUN, "scholarly", "place cell stability");
    recordOutsideSearch(RUN, "scholarly", "place field drift");
    assert.equal(
      buildOutsideSearchNote(RUN, "scholarly"),
      `Outside searches this turn: 2 scholarly (queries: place cell stability; place field drift). ${OUTSIDE_SEARCH_STOP_NOTE}`,
    );
  });

  it("counts each family on its own", function () {
    recordOutsideSearch(RUN, "scholarly", "a");
    recordOutsideSearch(RUN, "web", "release date");
    assert.equal(outsideSearchCount(RUN, "scholarly"), 1);
    assert.equal(outsideSearchCount(RUN, "web"), 1);
    assert.match(
      buildOutsideSearchNote(RUN, "web"),
      /^Outside searches this turn: 1 web \(queries: release date\)\. /,
    );
  });

  it("asks to finish at the finish threshold and allows one more gap search", function () {
    assert.equal(OUTSIDE_SEARCH_FINISH_AT, 6);
    for (let i = 1; i <= OUTSIDE_SEARCH_FINISH_AT; i += 1)
      recordOutsideSearch(RUN, "scholarly", `q${i}`);
    assert.equal(
      buildOutsideSearchNote(RUN, "scholarly"),
      "Outside searches this turn: 6 scholarly (queries: q1; q2; q3; q4; q5; q6). Finish the request now with what these searches found; if nothing tests the claim, say so and name the searches. At most one more search, for one gap you can name.",
    );
  });

  it("drops the one-more-search allowance at the final threshold and caps the query list", function () {
    assert.equal(OUTSIDE_SEARCH_FINAL_AT, 12);
    for (let i = 1; i <= OUTSIDE_SEARCH_FINAL_AT; i += 1)
      recordOutsideSearch(RUN, "web", `q${i}`);
    const note = buildOutsideSearchNote(RUN, "web");
    assert.match(note, /^Outside searches this turn: 12 web \(queries: q1; /);
    assert.include(note, "; and 4 more).");
    assert.notInclude(note, "q9;");
    assert.isTrue(
      note.endsWith(
        "Finish the request now with what these searches found; if nothing tests the claim, say so and name the searches.",
      ),
      note,
    );
    assert.notInclude(note, "At most one more search");
  });

  it("lists a repeated query once but counts every call", function () {
    recordOutsideSearch(RUN, "scholarly", "same");
    recordOutsideSearch(RUN, "scholarly", "same");
    assert.match(
      buildOutsideSearchNote(RUN, "scholarly"),
      /^Outside searches this turn: 2 scholarly \(queries: same\)\. /,
    );
  });

  it("restarts the counts when a long job settles a paper, but keeps a latch", function () {
    recordOutsideSearch(RUN, "scholarly", "a");
    latchOutsideSearch(RUN, "openalex", OPENALEX_RATE_LIMIT_MESSAGE);
    resetOutsideSearchLedger(RUN);
    assert.equal(outsideSearchCount(RUN, "scholarly"), 0);
    assert.equal(
      outsideSearchLatch(RUN, "openalex"),
      OPENALEX_RATE_LIMIT_MESSAGE,
    );
    clearOutsideSearchTurn(RUN);
    assert.isUndefined(outsideSearchLatch(RUN, "openalex"));
  });

  it("calls the settle hook when a long job settles a paper", function () {
    let settled = 0;
    const boundary = new TurnBoundary({
      now: 0,
      maxRounds: 24,
      settledTargets: 0,
      onSettled: () => {
        settled += 1;
      },
    });
    boundary.afterToolRound({ round: 1, calls: [], settledTargets: 0, now: 1 });
    assert.equal(settled, 0);
    boundary.afterToolRound({ round: 2, calls: [], settledTargets: 1, now: 2 });
    assert.equal(settled, 1);
    boundary.beforeModelCall({ now: 3, settledTargets: 2 });
    assert.equal(settled, 2);
  });

  it("states the stop note's absence exit", function () {
    assert.equal(
      OUTSIDE_SEARCH_STOP_NOTE,
      "If these results cover the need, stop searching and finish the request. Absence is also an answer: when two differently worded searches on the sources that index this field return no study that tests the claim, say so, name the searches, and give the closest studies as what was found. Search again only for one specific gap you can name.",
    );
  });
});

describe("literature_search outside-search discipline", function () {
  const originalFetch = globalThis.fetch;
  const gateway = {
    resolveMetadataItem: () => null,
    getEditableArticleMetadata: () => null,
    fetchMetadataByIdentifier: async () => null,
  };

  beforeEach(function () {
    clearAgentToolResultHandleStore();
  });
  afterEach(function () {
    globalThis.fetch = originalFetch;
    clearOutsideSearchTurn(RUN);
    clearAgentToolResultHandleStore();
  });

  async function run(args: Record<string, unknown>, context = makeContext()) {
    const tool = createLiteratureSearchTool(gateway as never);
    const parsed = tool.validate(args);
    if (!parsed.ok) throw new Error(parsed.error);
    return (await tool.execute(parsed.value, context)) as Record<
      string,
      unknown
    >;
  }

  /** The message the tool refuses with at planning, before anything runs. */
  async function planRejection(
    args: Record<string, unknown>,
    context = makeContext(),
  ): Promise<string> {
    const tool = createLiteratureSearchTool(gateway as never);
    const parsed = tool.validate(args);
    if (!parsed.ok) throw new Error(parsed.error);
    try {
      await tool.planInvocation!(parsed.value, context);
    } catch (error) {
      assert.instanceOf(error, ToolInputRejection);
      return String((error as Error).message);
    }
    return "";
  }

  it("reports a refused need as an input rejection through the registry", async function () {
    const calls: FetchCall[] = [];
    globalThis.fetch = openAlexFetch(calls);
    const registry = new AgentToolRegistry();
    registry.register(createLiteratureSearchTool(gateway as never));
    const sideChat: AgentToolContext = {
      ...makeContext(),
      request: resolvedAgentRequest({
        conversationKey: EPHEMERAL_PAPER_CONVERSATION_KEY_BASE,
        mode: "agent",
        userText: "Find papers on drift.",
        libraryID: 1,
      }),
    };
    const cases: Array<[Record<string, unknown>, AgentToolContext]> = [
      [{ mode: "search", query: "drift", workflow: "review" }, sideChat],
      [{ mode: "search", query: "x", need: "host_action" }, makeContext()],
    ];
    for (const [args, context] of cases) {
      const prepared = await registry.prepareExecution(
        { id: "c", name: "literature_search", arguments: args },
        context,
      );
      assert.equal(prepared.kind, "result");
      if (prepared.kind !== "result") continue;
      assert.isFalse(prepared.execution.result.ok);
      assert.isTrue(prepared.execution.result.inputRejected);
    }
    assert.lengthOf(calls, 0);
  });

  it("throws a typed rate-limit error from search mode instead of an empty result", async function () {
    const calls: FetchCall[] = [];
    globalThis.fetch = openAlexFetch(calls, 429);
    const service = new LiteratureSearchService(gateway as never);
    let caught: unknown;
    try {
      await service.execute(
        { mode: "search", query: "place cells" } as never,
        makeContext(),
      );
    } catch (error) {
      caught = error;
    }
    assert.instanceOf(caught, LiteratureProviderHttpError);
    const error = caught as LiteratureProviderHttpError;
    assert.equal(error.kind, "rate_limit");
    assert.equal(error.status, 429);
  });

  it("surfaces other OpenAlex search failures as errors", async function () {
    globalThis.fetch = openAlexFetch([], 503);
    const service = new LiteratureSearchService(gateway as never);
    let message = "";
    try {
      await service.execute(
        { mode: "search", query: "place cells" } as never,
        makeContext(),
      );
    } catch (error) {
      message = String((error as Error).message);
    }
    assert.equal(message, "OpenAlex search failed: HTTP 503");
  });

  it("latches OpenAlex after a rate limit and makes no further OpenAlex call this turn", async function () {
    const calls: FetchCall[] = [];
    globalThis.fetch = openAlexFetch(calls, 429);
    let first = "";
    try {
      await run({ ...NEED, mode: "search", query: "place cells" });
    } catch (error) {
      first = String((error as Error).message);
    }
    assert.equal(first, OPENALEX_RATE_LIMIT_MESSAGE);
    assert.equal(
      first,
      "OpenAlex is rate-limited for the rest of this turn (HTTP 429). Do not wait, sleep or retry. Search mode: use source:'europepmc' or 'arxiv'. Recommendations, references and citations need OpenAlex and are unavailable this turn; say so in the answer.",
    );
    assert.lengthOf(calls, 1);
    // The rate-limited call reached the provider and counts.
    assert.equal(outsideSearchCount(RUN, "scholarly"), 1);
    for (const args of [
      { ...NEED, mode: "search", query: "place fields" },
      { ...NEED, mode: "recommendations", doi: "10.1000/seed" },
    ]) {
      const latched = (await run(args)) as Record<string, unknown>;
      assert.equal(latched.unavailable, "rate_limited");
      assert.equal(latched.message, OPENALEX_RATE_LIMIT_MESSAGE);
      assert.equal(latched.nextStep, OPENALEX_RATE_LIMIT_MESSAGE);
      assert.deepEqual(latched.results, []);
    }
    assert.lengthOf(calls, 1, "no provider call after the latch");
    // Latched rejections never reached a provider and do not count.
    assert.equal(outsideSearchCount(RUN, "scholarly"), 1);
    let otherSource = "";
    try {
      await run({
        ...NEED,
        mode: "search",
        query: "place fields",
        source: "europepmc",
      });
    } catch (error) {
      otherSource = String((error as Error).message);
    }
    assert.notEqual(
      otherSource,
      OPENALEX_RATE_LIMIT_MESSAGE,
      "Europe PMC is not latched",
    );
    // Another turn is not latched.
    globalThis.fetch = openAlexFetch(calls);
    const other = await run(
      { ...NEED, mode: "search", query: "place fields" },
      makeContext("another-run"),
    );
    clearOutsideSearchTurn("another-run");
    assert.lengthOf(other.results as unknown[], 1);
  });

  it("tracks no ledger or latch for a standalone MCP session run id", async function () {
    const mcpRun = "mcp-run-1-1-abc";
    assert.equal(SCOPELESS_MCP_RUN_PREFIX, "mcp-run");
    assert.isFalse(tracksOutsideSearchTurn(mcpRun));
    assert.isTrue(tracksOutsideSearchTurn(RUN));
    const calls: FetchCall[] = [];
    globalThis.fetch = openAlexFetch(calls, 429);
    let message = "";
    try {
      await run({ ...NEED, mode: "search", query: "q" }, makeContext(mcpRun));
    } catch (error) {
      message = String((error as Error).message);
    }
    assert.notEqual(message, OPENALEX_RATE_LIMIT_MESSAGE);
    assert.isUndefined(outsideSearchLatch(mcpRun, "openalex"));
    globalThis.fetch = openAlexFetch(calls);
    const ok = await run(
      { ...NEED, mode: "search", query: "q" },
      makeContext(mcpRun),
    );
    assert.isTrue(
      String(ok.nextStep).endsWith(OUTSIDE_SEARCH_STOP_NOTE),
      String(ok.nextStep),
    );
    assert.equal(outsideSearchCount(mcpRun, "scholarly"), 0);
  });

  it("does not latch or count a host action, and does not count metadata lookups", async function () {
    const calls: FetchCall[] = [];
    globalThis.fetch = openAlexFetch(calls, 429);
    let message = "";
    try {
      await run(
        { mode: "search", query: "place cells", need: "host_action" },
        { ...makeContext(), hostAction: true },
      );
    } catch (error) {
      message = String((error as Error).message);
    }
    assert.equal(message, "OpenAlex rate limit (HTTP 429)");
    assert.isUndefined(outsideSearchLatch(RUN, "openalex"));
    assert.equal(outsideSearchCount(RUN, "scholarly"), 0);
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ message: { items: [] } }),
    })) as unknown as typeof fetch;
    await run({ mode: "metadata", title: "A paper" });
    assert.equal(outsideSearchCount(RUN, "scholarly"), 0);
  });

  it("rejects the host-only need from a model call before any search", async function () {
    // The schema enum hides host_action, but not every provider enforces
    // enums; only the action executor marks a call as host-built.
    const calls: FetchCall[] = [];
    globalThis.fetch = openAlexFetch(calls);
    const message = await planRejection({
      mode: "search",
      query: "place cells",
      need: "host_action",
    });
    assert.equal(message, OUTSIDE_SEARCH_NEED_MESSAGE);
    assert.lengthOf(calls, 0);
    assert.equal(outsideSearchCount(RUN, "scholarly"), 0);
  });

  it("asks a find-paper search for a reason where no selection card can open", async function () {
    // workflow:'review' skips the reason only because it leads to the card;
    // a side chat or an MCP client without literature_review has no card.
    const sideChat: AgentToolContext = {
      ...makeContext(),
      request: resolvedAgentRequest({
        conversationKey: EPHEMERAL_PAPER_CONVERSATION_KEY_BASE,
        mode: "agent",
        userText: "Find papers on drift.",
        libraryID: 1,
      }),
    };
    const mcpWithoutCard: AgentToolContext = {
      ...makeContext(),
      isToolVisible: (spec) => spec.name !== "literature_review",
    };
    const calls: FetchCall[] = [];
    globalThis.fetch = openAlexFetch(calls);
    const review = { mode: "search", query: "drift", workflow: "review" };
    for (const context of [sideChat, mcpWithoutCard]) {
      const message = await planRejection(review, context);
      assert.equal(message, REVIEW_WITHOUT_CARD_NEED_MESSAGE);
      assert.include(message, OUTSIDE_SEARCH_NEED_MESSAGE);
    }
    assert.lengthOf(calls, 0);
    assert.equal(outsideSearchCount(RUN, "scholarly"), 0);
    await run({ ...review, ...NEED }, sideChat);
    assert.lengthOf(calls, 1);
    // Where the card can open, the find-paper search still states no reason.
    await run(review);
    assert.lengthOf(calls, 2);
  });

  it("closes an answer result with the ledger and no card route", async function () {
    globalThis.fetch = openAlexFetch([]);
    await run({ ...NEED, mode: "search", query: "place cells" });
    const content = await run({ ...NEED, mode: "search", query: "drift" });
    const nextStep = String(content.nextStep);
    assert.include(
      nextStep,
      `Outside searches this turn: 2 scholarly (queries: place cells; drift). ${OUTSIDE_SEARCH_STOP_NOTE}`,
    );
    // The card belongs to workflow:'review'; an evidence result never
    // offers it.
    assert.notInclude(nextStep, "literature_review");
    assert.notInclude(nextStep, "find or recommend papers, call");
    assert.isTrue(nextStep.endsWith(OUTSIDE_SEARCH_STOP_NOTE), nextStep);
  });

  it("names the seed of a recommendations search in the ledger", async function () {
    globalThis.fetch = openAlexFetch([]);
    await run({ ...NEED, mode: "recommendations", doi: "10.1000/seed" });
    assert.match(
      buildOutsideSearchNote(RUN, "scholarly"),
      /\(queries: recommendations for 10\.1000\/seed\)/,
    );
  });

  it("does not count a validation rejection", async function () {
    const registry = new AgentToolRegistry();
    registry.register(createLiteratureSearchTool(gateway as never));
    const prepared = await registry.prepareExecution(
      {
        id: "call-1",
        name: "literature_search",
        arguments: { mode: "search", doi: "10.1000/x", ...NEED },
      },
      makeContext(),
    );
    assert.equal(prepared.kind, "result");
    if (prepared.kind === "result")
      assert.deepEqual(prepared.execution.result.content, {
        error:
          "Invalid tool input for literature_search: search mode requires query, title, or author; to read one paper by DOI, PMID, PMCID or arXiv ID, use literature_read.",
      });
    assert.equal(outsideSearchCount(RUN, "scholarly"), 0);
  });
});

describe("web_search outside-search discipline", function () {
  const originalZotero = globalThis.Zotero;
  let prefs: Map<string, unknown>;

  beforeEach(function () {
    prefs = new Map<string, unknown>([
      [TAVILY_API_KEY_PREF, "synthetic-tavily-key"],
    ]);
    globalThis.Zotero = {
      ...((originalZotero as unknown as Record<string, unknown>) || {}),
      Prefs: {
        get: (name: string) => prefs.get(name),
        set: (name: string, value: unknown) => prefs.set(name, value),
      },
    } as unknown as typeof Zotero;
  });
  afterEach(function () {
    globalThis.Zotero = originalZotero;
    clearOutsideSearchTurn(RUN);
  });

  it("latches web search after a quota error and calls no provider again", async function () {
    setWebAccessProvider("anysearch");
    let searches = 0;
    const tool = createWebSearchTool(
      () =>
        ({
          search: async () => {
            searches += 1;
            throw new WebAccessError(
              "AnySearch quota exhausted. No credentials were adopted and no retry was made.",
              "quota",
              402,
            );
          },
        }) as never,
    );
    const expected = webSearchUnavailableMessage(
      "AnySearch",
      "quota exhausted",
    );
    assert.equal(
      expected,
      "Web search is unavailable for the rest of this turn (AnySearch quota exhausted). Do not retry or fetch pages with shell commands; answer from other sources and say which part could not be checked online.",
    );
    let message = "";
    try {
      await tool.execute({ query: "q0", maxResults: 5 }, makeContext());
    } catch (error) {
      message = String((error as Error).message);
    }
    assert.equal(message, expected);
    const second = (await tool.execute(
      { query: "q1", maxResults: 5 },
      makeContext(),
    )) as Record<string, unknown>;
    assert.equal(second.unavailable, "latched");
    assert.equal(second.message, expected);
    assert.equal(second.nextStep, expected);
    assert.deepEqual(second.results, []);
    assert.equal(searches, 1);
    assert.equal(outsideSearchCount(RUN, "web"), 1);
  });

  it("latches on a Tavily credit limit and on rejected authentication", async function () {
    for (const [code, status, reason] of [
      ["quota", 432, "quota exhausted"],
      ["plan_limit", 433, "quota exhausted"],
      ["authentication", 401, "authentication rejected"],
    ] as const) {
      clearOutsideSearchTurn(RUN);
      const tool = createWebSearchTool(
        () =>
          ({
            search: async () => {
              throw new WebAccessError("Tavily failed.", code, status);
            },
          }) as never,
      );
      let message = "";
      try {
        await tool.execute(
          { query: "q", depth: "basic", topic: "general", maxResults: 5 },
          makeContext(),
        );
      } catch (error) {
        message = String((error as Error).message);
      }
      assert.equal(message, webSearchUnavailableMessage("Tavily", reason));
    }
  });

  it("does not latch on a rate limit or other failure", async function () {
    const tool = createWebSearchTool(
      () =>
        ({
          search: async () => {
            throw new WebAccessError(
              "Tavily rate-limited the request. Try again later.",
              "rate_limit",
              429,
            );
          },
        }) as never,
    );
    let message = "";
    try {
      await tool.execute(
        { query: "q", depth: "basic", topic: "general", maxResults: 5 },
        makeContext(),
      );
    } catch (error) {
      message = String((error as Error).message);
    }
    assert.equal(message, "Tavily rate-limited the request. Try again later.");
    assert.isUndefined(outsideSearchLatch(RUN, "web"));
  });

  it("keeps no ledger or latch for a standalone MCP session run id", async function () {
    const mcpRun = "mcp-run-1-1-abc";
    const failure = new WebAccessError("Tavily failed.", "quota", 432);
    let fail = true;
    const tool = createWebSearchTool(
      () =>
        ({
          search: async () => {
            if (fail) throw failure;
            return { provider: "tavily", query: "q", results: [] };
          },
        }) as never,
    );
    const input = {
      query: "q",
      depth: "basic",
      topic: "general",
      maxResults: 5,
    };
    let caught: unknown;
    try {
      await tool.execute(input as never, makeContext(mcpRun));
    } catch (error) {
      caught = error;
    }
    assert.equal(caught, failure);
    assert.isUndefined(outsideSearchLatch(mcpRun, "web"));
    fail = false;
    const ok = (await tool.execute(
      input as never,
      makeContext(mcpRun),
    )) as Record<string, unknown>;
    assert.equal(ok.nextStep, OUTSIDE_SEARCH_STOP_NOTE);
    assert.equal(outsideSearchCount(mcpRun, "web"), 0);
  });

  it("closes a web result with the web ledger", async function () {
    const tool = createWebSearchTool(
      () =>
        ({
          search: async () => ({
            provider: "tavily",
            query: "q",
            results: [],
          }),
        }) as never,
    );
    const result = await tool.execute(
      {
        query: "release date",
        depth: "basic",
        topic: "general",
        maxResults: 5,
      },
      makeContext(),
    );
    assert.equal(
      result.nextStep,
      `Outside searches this turn: 1 web (queries: release date). ${OUTSIDE_SEARCH_STOP_NOTE}`,
    );
    assert.equal(Object.keys(result).at(-1), "nextStep");
  });
});
