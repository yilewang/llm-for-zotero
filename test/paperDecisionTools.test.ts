import { assert } from "chai";
import {
  addZoteroMcpToolActivityObserver,
  getOrCreateZoteroMcpBearerToken,
  registerMcpServer,
  registerScopedZoteroMcpScope,
  unregisterMcpServer,
  ZOTERO_MCP_ENDPOINT_PATH,
  ZOTERO_MCP_EXCLUDED_TOOL_NAMES,
  ZOTERO_MCP_SAFE_READ_TOOL_NAMES,
  ZOTERO_MCP_SCOPE_HEADER,
} from "../src/agent/mcp/server";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import {
  createRecordPaperDecisionsTool,
  exclusionPaperDecisions,
  type PaperDecisionLookup,
} from "../src/agent/tools/control/recordPaperDecisions";
import {
  createReviewCoverageTool,
  type ReviewCoverageSource,
} from "../src/agent/tools/read/reviewCoverage";
import { createTaskUpdateTool } from "../src/agent/tools/control/taskUpdate";
import { createEmptyExecutionCheckpoint } from "../src/agent/execution/checkpoint";
import { recordTaskPaperDecisions } from "../src/agent/context/taskPaperLedgerRecorder";
import { taskPaperCoverageRunsFromMessages } from "../src/agent/context/taskPaperCoverage";
import type { TaskPaperLedgerDelta } from "../src/agent/context/taskPaperLedger";
import type { ZoteroMcpToolActivityEvent } from "../src/agent/mcp/activityTypes";
import type {
  AgentEvent,
  AgentExecutionContext,
  AgentToolContext,
  ExecutionCheckpoint,
} from "../src/agent/types";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

/**
 * record_paper_decisions and review_coverage (the agent's paper decisions
 * and the conversation's reads and decisions so far), and the decisions the
 * existing `excluded` lists of submit_document and task_update record. The
 * decisions reach the ledger as `paper_ledger_update` deltas from the one
 * recorder (taskPaperLedgerRecorder.ts), in the built-in runtime (see
 * agentToolExecution.test.ts) and over MCP (here).
 */

type FakeItem = {
  id: number;
  key: string;
  libraryID: number;
  parentID?: number;
  regular: boolean;
  deleted?: boolean;
  firstCreator?: string;
  fields: Record<string, string>;
  getField(field: string): string;
};

function fakeLibrary(): {
  lookup: PaperDecisionLookup;
  items: Map<number, FakeItem>;
} {
  const items = new Map<number, FakeItem>();
  const add = (item: Omit<FakeItem, "getField">) =>
    items.set(item.id, {
      ...item,
      getField: (field: string) => item.fields[field] || "",
    });
  add({
    id: 11,
    key: "PAPER011",
    libraryID: 1,
    regular: true,
    firstCreator: "Rule",
    fields: { title: "Drift in CA1", date: "2019-05-01" },
  });
  add({
    id: 12,
    key: "PAPER012",
    libraryID: 1,
    regular: true,
    fields: { title: "Birdsong learning" },
  });
  // The PDF of paper 11.
  add({
    id: 21,
    key: "PDF00021",
    libraryID: 1,
    parentID: 11,
    regular: false,
    fields: {},
  });
  // A standalone note.
  add({ id: 31, key: "NOTE0031", libraryID: 1, regular: false, fields: {} });
  // A paper in a group library.
  add({ id: 41, key: "GROUP041", libraryID: 2, regular: true, fields: {} });
  // A paper in the trash.
  add({
    id: 51,
    key: "TRASH051",
    libraryID: 1,
    regular: true,
    deleted: true,
    fields: {},
  });
  const lookup: PaperDecisionLookup = {
    getItem: (id) => (items.get(Number(id)) as unknown as Zotero.Item) || null,
    getItemByLibraryAndKey: (libraryID, key) =>
      ([...items.values()].find(
        (item) => item.libraryID === libraryID && item.key === key,
      ) as unknown as Zotero.Item) || null,
    resolveBibliographicItem: (item) => {
      const fake = item as unknown as FakeItem | null;
      if (!fake) return null;
      if (fake.regular) return item as Zotero.Item;
      const parent = fake.parentID ? items.get(fake.parentID) : undefined;
      return parent?.regular ? (parent as unknown as Zotero.Item) : null;
    },
  };
  return { lookup, items };
}

function toolContext(
  request: Partial<AgentToolContext["request"]> = {},
  extra: Partial<AgentToolContext> = {},
): AgentToolContext {
  return {
    request: { conversationKey: 77, libraryID: 1, ...request },
    runId: "run-current",
    item: null,
    currentAnswerText: "",
    modelName: "test",
    ...extra,
  } as unknown as AgentToolContext;
}

async function record(args: unknown, context = toolContext()) {
  const { lookup } = fakeLibrary();
  const tool = createRecordPaperDecisionsTool(lookup);
  const parsed = tool.validate(args);
  if (!parsed.ok) throw new Error(parsed.error);
  return (await tool.execute(parsed.value, context)) as {
    content: Record<string, any>;
    paperDecisions?: Array<Record<string, any>>;
  };
}

describe("record_paper_decisions", function () {
  it("refuses an input that is not a list of 1 to 200 rows", function () {
    const tool = createRecordPaperDecisionsTool(fakeLibrary().lookup);
    for (const args of [null, [], {}, { decisions: [] }, { decisions: "x" }]) {
      assert.isFalse(tool.validate(args).ok, JSON.stringify(args));
    }
    const row = { target: "11", decision: "include", reason: "On topic." };
    assert.isTrue(
      tool.validate({ decisions: Array.from({ length: 200 }, () => row) }).ok,
    );
    const tooMany = tool.validate({
      decisions: Array.from({ length: 201 }, () => row),
    });
    assert.isFalse(tooMany.ok);
    if (!tooMany.ok) assert.match(tooMany.error, /at most 200/);
  });

  it("records each paper of the library with its decision, and names every refused row", async function () {
    const result = await record({
      decisions: [
        {
          target: "item:11",
          decision: "include",
          relevance: "high",
          subquestions: ["mechanisms", 3],
          reason: "Measures drift directly.",
        },
        { target: 12, decision: "exclude", reason: "Birdsong, not drift." },
        { target: "21", decision: "defer", reason: "PDF of paper 11." },
        { target: "item:31", decision: "include", reason: "A note." },
        { target: "41", decision: "include", reason: "Group paper." },
        { target: "51", decision: "include", reason: "Trashed." },
        { target: "999", decision: "include", reason: "Unknown." },
        { target: "first paper", decision: "include", reason: "Bad id." },
        { target: "11", decision: "maybe", reason: "Bad value." },
        { target: "11", decision: "include", reason: "  " },
        { target: "11", decision: "include", relevance: "huge", reason: "x" },
        "not a row",
      ],
    });
    assert.isTrue(result.content.ok);
    // Paper 11 is named by its own id and then by its PDF: the last row wins.
    assert.equal(result.content.recorded, 2);
    assert.deepEqual(result.content.decisions, {
      include: 0,
      exclude: 1,
      defer: 1,
    });
    assert.deepEqual(
      result.content.rejected.map((row: Record<string, unknown>) => [
        row.row,
        row.reason,
      ]),
      [
        [4, "This item is not a paper."],
        [5, "This item is in another library."],
        [6, "This paper is in the trash."],
        [7, "No item with this id."],
        [
          8,
          "target must be a Zotero item id (12 or item:12) or item key (ABCD2345).",
        ],
        [9, "decision must be include, exclude or defer."],
        [10, "reason is required."],
        [11, "relevance must be high, medium, low or none."],
        [12, "Each row must be an object."],
      ],
    );
    assert.deepEqual(result.paperDecisions, [
      {
        value: "exclude",
        reason: "Birdsong, not drift.",
        paper: {
          libraryID: 1,
          itemId: 12,
          title: "Birdsong learning",
          itemKey: "PAPER012",
        },
      },
      {
        value: "defer",
        reason: "PDF of paper 11.",
        paper: {
          libraryID: 1,
          itemId: 11,
          contextItemId: 21,
          title: "Drift in CA1",
          year: "2019",
          creator: "Rule",
          itemKey: "PAPER011",
        },
      },
    ]);
  });

  it("takes a paper's item key as well as its id, resolved in the turn's library", async function () {
    const result = await record({
      decisions: [
        { target: "PAPER012", decision: "exclude", reason: "Birdsong." },
        // A lower-case key, and the key of paper 11's PDF.
        { target: "pdf00021", decision: "include", reason: "On drift." },
        // A key of the group library: not one of this turn's library.
        { target: "GROUP041", decision: "include", reason: "Group paper." },
        { target: "NOTE0031", decision: "include", reason: "A note." },
        { target: "UNKNOWN9", decision: "include", reason: "Unknown." },
      ],
    });
    assert.isTrue(result.content.ok);
    assert.equal(result.content.recorded, 2);
    assert.deepEqual(
      result.paperDecisions?.map((decision) => [
        decision.paper.itemId,
        decision.paper.itemKey,
        decision.value,
      ]),
      [
        [12, "PAPER012", "exclude"],
        [11, "PAPER011", "include"],
      ],
    );
    assert.deepEqual(
      result.content.rejected.map((row: Record<string, unknown>) => [
        row.row,
        row.target,
        row.reason,
      ]),
      [
        [3, "GROUP041", "No item with this key in this library."],
        [4, "NOTE0031", "This item is not a paper."],
        [5, "UNKNOWN9", "No item with this key in this library."],
      ],
    );
  });

  it("keeps its result small: at most 20 refused rows are listed", async function () {
    const result = await record({
      decisions: Array.from({ length: 30 }, (_, index) => ({
        target: String(1000 + index),
        decision: "exclude",
        reason: "Unknown.",
      })),
    });
    assert.isFalse(result.content.ok);
    assert.equal(result.content.recorded, 0);
    assert.lengthOf(result.content.rejected, 20);
    assert.equal(result.content.moreRejected, 10);
    assert.notProperty(result, "paperDecisions");
  });

  it("records nothing without a conversation or a library", async function () {
    const row = { target: "11", decision: "include", reason: "On topic." };
    const scopeless = await record(
      { decisions: [row] },
      toolContext({ conversationKey: 0 }),
    );
    assert.deepEqual(scopeless.content, {
      ok: false,
      recorded: 0,
      error: "Decisions can be recorded only in a conversation in Zotero.",
    });
    assert.notProperty(scopeless, "paperDecisions");
    const libraryless = await record(
      { decisions: [row] },
      toolContext({ libraryID: 0 }),
    );
    assert.isFalse(libraryless.content.ok);
    assert.notProperty(libraryless, "paperDecisions");
  });

  it("is a control tool with a read-only plan and a short description", function () {
    const tool = createRecordPaperDecisionsTool(fakeLibrary().lookup);
    assert.equal(tool.spec.executionClass, "control");
    assert.equal(
      tool.planInvocation?.({} as never, toolContext()).impact,
      "read_only",
    );
    assert.isAtMost(tool.spec.description.length, 260);
  });
});

describe("the decision recorder", function () {
  it("stamps the call's own id and run on the delta, and lists each paper with its decision", function () {
    const delta = recordTaskPaperDecisions({
      toolName: "record_paper_decisions",
      callId: "call-7",
      runId: "run-3",
      conversationKey: 77,
      decisions: [
        {
          paper: { libraryID: 1, itemId: 11, title: "Drift in CA1" },
          value: "include",
          relevance: "high",
          reason: "Measures drift.",
        },
      ],
    });
    assert.deepEqual(delta, {
      version: 1,
      callId: "call-7",
      runId: "run-3",
      toolName: "record_paper_decisions",
      reads: [],
      papers: [
        {
          key: "1:11",
          libraryID: 1,
          itemId: 11,
          title: "Drift in CA1",
          state: "listed",
          decision: {
            value: "include",
            relevance: "high",
            reason: "Measures drift.",
            origin: "agent",
          },
        },
      ],
    });
    assert.isNull(
      recordTaskPaperDecisions({
        toolName: "record_paper_decisions",
        callId: "call-7",
        conversationKey: 0,
        decisions: [
          {
            paper: { libraryID: 1, itemId: 11 },
            value: "include",
            reason: "x",
          },
        ],
      }),
      "no conversation, no delta",
    );
  });
});

describe("excluded lists record exclude decisions", function () {
  it("turns each left-out paper of the library into an exclude decision with its reason", function () {
    const { lookup } = fakeLibrary();
    assert.deepEqual(
      exclusionPaperDecisions(
        [
          {
            targetIds: ["item:12", "item:41", "item:999"],
            reason: "Off topic",
          },
          { targetIds: ["21"], reason: "Duplicate record" },
        ],
        1,
        lookup,
      ).map((decision) => [
        decision.paper.itemId,
        decision.value,
        decision.reason,
      ]),
      [
        [12, "exclude", "Off topic"],
        [11, "exclude", "Duplicate record"],
      ],
    );
    assert.deepEqual(
      exclusionPaperDecisions(
        [{ targetIds: ["12"], reason: "x" }],
        1,
        undefined,
      ),
      [],
    );
  });

  it("task_update's excluded carries the decisions on its result, and its answer is unchanged", async function () {
    const executionContext: AgentExecutionContext = {
      version: 1,
      executionId: "execution-decide-1",
      conversationKey: 52,
      conversationGeneration: 1,
      chatLibraryID: 1,
      permissionOwner: "original_agent",
      workspaceSnapshot: { selectedPapers: [], selectedCollections: [] },
      configuredAccess: { libraryIDs: [1], outputDirectories: [] },
    };
    const run = async (papers?: PaperDecisionLookup) => {
      const request = resolvedAgentRequest({
        conversationKey: 52,
        mode: "agent",
        userText: "Review these papers",
        libraryID: 1,
        executionContext,
      });
      request.turnScopePapers = {
        wholeLibrary: false,
        itemIds: [11, 12],
        withText: 2,
      };
      const context = {
        request,
        runId: "run-decide",
        item: null,
        currentAnswerText: "",
        modelName: "test",
        updateExecutionCheckpoint: async (
          apply: (checkpoint: ExecutionCheckpoint) => ExecutionCheckpoint,
        ) => {
          const next = apply(
            request.executionCheckpoint ||
              createEmptyExecutionCheckpoint(executionContext, 10),
          );
          request.executionCheckpoint = next;
          return next;
        },
      } as unknown as AgentToolContext;
      const tool = createTaskUpdateTool(papers ? { papers } : {});
      const parsed = tool.validate({
        tasks: [
          {
            taskId: "review",
            description: "Write the review",
            expectedEffect: "artifact",
            scope: true,
          },
        ],
        excluded: [
          { taskId: "review", targetIds: ["12"], reason: "Birdsong only" },
        ],
      });
      if (!parsed.ok) throw new Error(parsed.error);
      return tool.execute(parsed.value, context) as Promise<
        Record<string, any>
      >;
    };
    const plain = await run();
    assert.property(plain, "parts", "without lookups the answer is as before");
    const decided = await run(fakeLibrary().lookup);
    assert.deepEqual(decided.content, plain);
    assert.deepEqual(decided.paperDecisions, [
      {
        paper: {
          libraryID: 1,
          itemId: 12,
          title: "Birdsong learning",
          itemKey: "PAPER012",
        },
        value: "exclude",
        reason: "Birdsong only",
      },
    ]);
  });
});

describe("review_coverage", function () {
  const included = (callId: string, runId: string, itemId: number) => ({
    type: "paper_ledger_update" as const,
    callId,
    delta: recordTaskPaperDecisions({
      toolName: "record_paper_decisions",
      callId,
      runId,
      conversationKey: 77,
      decisions: [
        {
          paper: { libraryID: 1, itemId, title: `Paper ${itemId}` },
          value: "include",
          reason: `Paper ${itemId} is on topic.`,
        },
      ],
    })!,
  });
  const excluded = (callId: string, runId: string, itemId: number) => {
    const event = included(callId, runId, itemId);
    event.delta.papers[0].decision = {
      value: "exclude",
      reason: `Paper ${itemId} is off topic.`,
      origin: "agent",
    };
    return event;
  };
  const read = (callId: string, runId: string, itemId: number) => ({
    type: "paper_ledger_update" as const,
    callId,
    delta: {
      version: 1 as const,
      callId,
      runId,
      toolName: "paper_read",
      papers: [
        {
          key: `1:${itemId}`,
          libraryID: 1,
          itemId,
          state: "read" as const,
        },
      ],
      reads: [
        {
          key: `1:${itemId}`,
          callId,
          toolName: "paper_read",
          granularity: "full" as const,
          method: "full",
        },
      ],
    } satisfies TaskPaperLedgerDelta,
  });

  function fakeSource(
    messages: Array<Record<string, unknown>>,
    events: Record<string, AgentEvent[]>,
  ): ReviewCoverageSource & { loads: Array<Record<string, unknown>> } {
    const loads: Array<Record<string, unknown>> = [];
    return {
      loads,
      async loadMessages(target) {
        loads.push(target);
        return messages;
      },
      async listLedgerEvents(runIds) {
        return runIds.flatMap((runId) =>
          (events[runId] || []).map((payload) => ({ runId, payload })),
        );
      },
    };
  }

  async function coverage(
    source: ReviewCoverageSource,
    args: unknown = {},
    context = toolContext(),
  ) {
    const tool = createReviewCoverageTool(source);
    const parsed = tool.validate(args);
    if (!parsed.ok) throw new Error(parsed.error);
    return (await tool.execute(parsed.value, context)) as Record<string, any>;
  }

  it("numbers questions as the panel does: compaction markers skipped, answers naming their runs", function () {
    assert.deepEqual(
      taskPaperCoverageRunsFromMessages(
        [
          { role: "assistant", agentRunId: "orphan" },
          { role: "user" },
          { role: "assistant", agentRunId: "run-1" },
          { role: "user", compactMarker: true },
          { role: "assistant", agentRunId: "compacted" },
          { role: "user" },
          { role: "assistant", agentRunId: " run-2a " },
          { role: "assistant", agentRunId: "run-2b" },
          { role: "user" },
          { role: "assistant" },
          { role: "user" },
          { role: "assistant", agentRunId: "run-current" },
        ],
        { excludeRunIds: ["run-current", undefined] },
      ),
      [
        { runId: "run-1", turn: 1 },
        // After a compaction marker the next answer still names the latest
        // question; the panel's numbering does the same.
        { runId: "compacted", turn: 1 },
        { runId: "run-2a", turn: 2 },
        { runId: "run-2b", turn: 2 },
      ],
    );
  });

  it("returns the reads and decisions of earlier answers, a re-run replacing the earlier run's", async function () {
    const source = fakeSource(
      [
        { role: "user", text: "Screen the folder" },
        { role: "assistant", agentRunId: "run-1" },
        { role: "user", compactMarker: true },
        { role: "user", text: "Read the included one" },
        { role: "assistant", agentRunId: "run-2a" },
        // A re-run of question 2: its decisions replace run-2a's.
        { role: "assistant", agentRunId: "run-2b" },
        { role: "user", text: "continue" },
      ],
      {
        "run-1": [
          included("d1", "run-1", 11),
          excluded("d2", "run-1", 12),
          included("d3", "run-1", 13),
        ],
        "run-2a": [excluded("d4", "run-2a", 11), read("r1", "run-2a", 11)],
        "run-2b": [read("r2", "run-2b", 11), excluded("d5", "run-2b", 13)],
        // The current run's own events are never read.
        "run-current": [excluded("d6", "run-current", 11)],
      },
    );
    const result = await coverage(source);
    assert.deepEqual(source.loads, [
      { system: "upstream", conversationKey: 77, limit: 400 },
    ]);
    assert.isTrue(result.ok);
    assert.deepEqual(result.counts, {
      total: 3,
      byState: { listed: 2, matched: 0, skimmed: 0, read: 1, cited: 0 },
      byDecision: { include: 1, exclude: 2, defer: 0 },
      noDecision: 0,
    });
    assert.deepEqual(
      result.papers.map((row: Record<string, any>) => [
        row.itemId,
        row.state,
        row.strongestGranularity,
        row.readCount,
        row.decision?.value,
        row.decision?.turnIndex,
      ]),
      [
        // Question 1 included it; question 2's re-run read it and decided
        // nothing, so question 1's decision is the latest.
        [11, "read", "full", 1, "include", 1],
        [12, "listed", undefined, 0, "exclude", 1],
        [13, "listed", undefined, 0, "exclude", 2],
      ],
    );
    const page = await coverage(source, {
      decision: "exclude",
      offset: 1,
      limit: 1,
    });
    assert.deepEqual(
      page.papers.map((row: Record<string, any>) => row.itemId),
      [13],
    );
    assert.equal(page.matched, 2);
    assert.equal(page.remaining, 0);
    const readOnly = await coverage(source, { states: ["read"] });
    assert.deepEqual(
      readOnly.papers.map((row: Record<string, any>) => row.itemId),
      [11],
    );
  });

  it("reads the calling runtime's conversation store", async function () {
    const source = fakeSource([], {});
    const result = await coverage(
      source,
      {},
      toolContext({}, { conversationSystem: "codex" }),
    );
    assert.equal(source.loads[0].system, "codex");
    assert.isTrue(result.ok);
    assert.equal(result.counts.total, 0);
  });

  it("refuses without a conversation, and reports a store that fails", async function () {
    const none = await coverage(
      fakeSource([], {}),
      {},
      toolContext({ conversationKey: 0 }),
    );
    assert.deepEqual(none, {
      ok: false,
      error: "Coverage is available only in a conversation in Zotero.",
    });
    const broken = await coverage({
      loadMessages: async () => {
        throw new Error("db closed");
      },
      listLedgerEvents: async () => [],
    });
    assert.isFalse(broken.ok);
  });

  it("validates its paging and filter", function () {
    const tool = createReviewCoverageTool(fakeSource([], {}));
    assert.isTrue(tool.validate(undefined).ok);
    for (const args of [
      { offset: -1 },
      { limit: 0 },
      { limit: 201 },
      { limit: 1.5 },
      { states: ["done"] },
      { decision: "maybe" },
      [],
    ]) {
      assert.isFalse(tool.validate(args).ok, JSON.stringify(args));
    }
    assert.match(tool.spec.description, /reads and decisions so far/);
    assert.notMatch(tool.spec.description, /full coverage/i);
  });
});

describe("paper decision tools over the Zotero MCP bridge", function () {
  type EndpointReply = [number, string, string];
  const originalZotero = globalThis.Zotero;
  const prefStore = new Map<string, unknown>();

  async function callTool(
    name: string,
    args: Record<string, unknown>,
    scopeToken?: string,
  ): Promise<Record<string, any>> {
    const EndpointClass = (
      globalThis.Zotero.Server.Endpoints as Record<string, any>
    )[ZOTERO_MCP_ENDPOINT_PATH];
    const reply: EndpointReply = await new EndpointClass().init({
      method: "POST",
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      },
      headers: {
        Authorization: `Bearer ${getOrCreateZoteroMcpBearerToken()}`,
        ...(scopeToken ? { [ZOTERO_MCP_SCOPE_HEADER]: scopeToken } : {}),
      },
    });
    const payload = JSON.parse(reply[2]);
    const text = payload.result?.content?.[0]?.text;
    assert.isString(text, reply[2]);
    const parsed = JSON.parse(text);
    return parsed.result ?? parsed;
  }

  beforeEach(function () {
    prefStore.clear();
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      DB: new ChangeJournalTestDb(),
      Prefs: {
        get: (key: string) =>
          key === "httpServer.port" ? 24681 : prefStore.get(key),
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      },
      Libraries: { userLibraryID: 1 },
      getActiveZoteroPane: () => ({
        getSelectedLibraryIDs: () => [1],
        getSelectedItems: () => [],
      }),
      Items: { get: () => null },
      Server: { Endpoints: {} },
    } as unknown as typeof Zotero;
  });

  afterEach(function () {
    unregisterMcpServer();
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
  });

  it("lists both tools as safe reads for Codex and Claude Code", function () {
    for (const name of ["record_paper_decisions", "review_coverage"]) {
      assert.include(
        ZOTERO_MCP_SAFE_READ_TOOL_NAMES as readonly string[],
        name,
      );
      assert.notProperty(ZOTERO_MCP_EXCLUDED_TOOL_NAMES, name);
    }
  });

  it("carries the decisions on the activity as the call's delta, inside a conversation only", async function () {
    const registry = new AgentToolRegistry();
    registry.register(createRecordPaperDecisionsTool(fakeLibrary().lookup));
    registry.register(createReviewCoverageTool(fakeSourceFor([])));
    registerMcpServer({ toolRegistry: registry, zoteroGateway: {} as never });
    const scope = registerScopedZoteroMcpScope(
      {
        runtimeAuthority: "codex",
        conversationKey: 8_812,
        libraryID: 1,
        kind: "global",
        runId: "codex-turn-decide",
      },
      { token: "decisions-scope-token" },
    );
    const events: ZoteroMcpToolActivityEvent[] = [];
    const unregister = addZoteroMcpToolActivityObserver((event) => {
      events.push(event);
    });
    try {
      const args = {
        decisions: [
          { target: "11", decision: "include", reason: "On topic." },
          { target: "41", decision: "include", reason: "Group paper." },
        ],
      };
      const scoped = await callTool(
        "record_paper_decisions",
        args,
        scope.token,
      );
      assert.deepEqual(scoped, {
        ok: true,
        recorded: 1,
        decisions: { include: 1, exclude: 0, defer: 0 },
        rejected: [
          { row: 2, target: "41", reason: "This item is in another library." },
        ],
      });
      // A client without a conversation records nothing.
      const scopeless = await callTool("record_paper_decisions", args);
      assert.isFalse(scopeless.ok);
    } finally {
      unregister();
      scope.clear();
    }
    const completed = events.filter((event) => event.phase === "completed");
    assert.lengthOf(completed, 2);
    const delta = completed[0].paperLedgerDelta;
    assert.isOk(delta, "the scoped call carries its delta");
    assert.equal(delta!.runId, "codex-turn-decide");
    assert.equal(delta!.toolName, "record_paper_decisions");
    assert.match(delta!.callId, /^mcp-/);
    assert.deepEqual(delta!.reads, []);
    assert.deepEqual(
      delta!.papers.map((paper) => [paper.key, paper.state, paper.decision]),
      [
        [
          "1:11",
          "listed",
          { value: "include", reason: "On topic.", origin: "agent" },
        ],
      ],
    );
    assert.notProperty(completed[1], "paperLedgerDelta");
  });

  it("reviews the scope's conversation in the calling runtime's store", async function () {
    const loads: Array<Record<string, unknown>> = [];
    const registry = new AgentToolRegistry();
    registry.register(createReviewCoverageTool(fakeSourceFor(loads)));
    registerMcpServer({ toolRegistry: registry, zoteroGateway: {} as never });
    const scope = registerScopedZoteroMcpScope(
      {
        runtimeAuthority: "claude",
        conversationKey: 8_813,
        libraryID: 1,
        kind: "global",
        runId: "claude-turn-review",
      },
      { token: "coverage-scope-token" },
    );
    try {
      const result = await callTool("review_coverage", {}, scope.token);
      assert.isTrue(result.ok, JSON.stringify(result));
      assert.equal(result.counts.total, 1);
      assert.equal(result.papers[0].decision.value, "exclude");
    } finally {
      scope.clear();
    }
    assert.deepEqual(loads, [
      { system: "claude_code", conversationKey: 8_813, limit: 400 },
    ]);
  });

  it("lists review_coverage to Codex and Claude Code scopes, and the plugin Agent does not list it", async function () {
    const registry = new AgentToolRegistry();
    registry.register(createRecordPaperDecisionsTool(fakeLibrary().lookup));
    registry.register(createReviewCoverageTool(fakeSourceFor([])));
    registerMcpServer({ toolRegistry: registry, zoteroGateway: {} as never });
    const EndpointClass = (
      globalThis.Zotero.Server.Endpoints as Record<string, any>
    )[ZOTERO_MCP_ENDPOINT_PATH];
    for (const runtimeAuthority of ["codex", "claude"] as const) {
      const scope = registerScopedZoteroMcpScope(
        {
          runtimeAuthority,
          conversationKey: 8_814,
          libraryID: 1,
          kind: "global",
          runId: `${runtimeAuthority}-turn-list`,
        },
        { token: `${runtimeAuthority}-list-scope-token` },
      );
      try {
        const reply: EndpointReply = await new EndpointClass().init({
          method: "POST",
          data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
          headers: {
            Authorization: `Bearer ${getOrCreateZoteroMcpBearerToken()}`,
            [ZOTERO_MCP_SCOPE_HEADER]: scope.token,
          },
        });
        const names = (
          JSON.parse(reply[2]).result.tools as Array<{ name: string }>
        ).map((tool) => tool.name);
        assert.include(names, "review_coverage", runtimeAuthority);
      } finally {
        scope.clear();
      }
    }
    const tool = registry.getTool("review_coverage")!;
    const as = (permissionOwner: string) =>
      ({ executionContext: { permissionOwner } }) as never;
    assert.isFalse(tool.isAvailable!(as("original_agent")));
    assert.isFalse(tool.isAvailable!({} as never));
    assert.isTrue(tool.isAvailable!(as("external_runtime")));
  });

  function fakeSourceFor(
    loads: Array<Record<string, unknown>>,
  ): ReviewCoverageSource {
    return {
      async loadMessages(target) {
        loads.push(target);
        return [
          { role: "user", text: "Screen" },
          { role: "assistant", agentRunId: "stored-run" },
        ];
      },
      async listLedgerEvents(runIds) {
        assert.deepEqual(runIds, ["stored-run"]);
        const delta = recordTaskPaperDecisions({
          toolName: "record_paper_decisions",
          callId: "mcp-1",
          runId: "claude-turn-earlier",
          conversationKey: 8_813,
          decisions: [
            {
              paper: { libraryID: 1, itemId: 12 },
              value: "exclude",
              reason: "Off topic.",
            },
          ],
        })!;
        return [
          {
            runId: "stored-run",
            payload: { type: "paper_ledger_update", callId: "mcp-1", delta },
          },
        ];
      },
    };
  }
});
