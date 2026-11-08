import { assert } from "chai";
import { createPastChatSearchTool } from "../src/agent/tools/read/pastChatSearch";
import { EPHEMERAL_GLOBAL_CONVERSATION_KEY_BASE } from "../src/shared/conversationKeySpace";
import type {
  AgentRuntimeRequest,
  AgentToolContext,
  AgentToolDefinition,
} from "../src/agent/types";
import type {
  AttachedConversationRef,
  ConversationSystem,
} from "../src/shared/types";
import {
  createFakePastConversationSource,
  type FakePastChat,
} from "./helpers/fakePastConversationSource";

/**
 * past_chat_search: the code labels the result clear / several / none, and
 * the chats it may list are this library's, never the current conversation
 * (by system and key), temporary, web chat or queued for deletion.
 */

const NOW = Date.UTC(2026, 9, 19, 12);
const DAY = 24 * 60 * 60 * 1000;

function chat(
  conversationKey: number,
  title: string,
  texts: string[],
  overrides: Partial<NonNullable<FakePastChat["entry"]>> & {
    system?: ConversationSystem;
  } = {},
): FakePastChat {
  const { system, ...entry } = overrides;
  return {
    ...(system ? { system } : {}),
    conversationKey,
    entry: { title, lastActivityAt: NOW - DAY, ...entry },
    messages: texts.map((text, index) => ({
      role: index % 2 ? "assistant" : "user",
      text,
      timestamp: 1_000 + index,
    })),
  };
}

type Result = Record<string, any>;

function createHarness(
  chats: FakePastChat[],
  options: { pendingDeletion?: number[] } = {},
) {
  const source = createFakePastConversationSource(chats, {
    pendingDeletion: options.pendingDeletion,
    paperTitles: { 501: "Hafting 2005" },
  });
  const tool = createPastChatSearchTool(source, {
    now: () => NOW,
  }) as AgentToolDefinition<unknown, unknown>;
  const context = (
    overrides: Partial<AgentRuntimeRequest> = {},
    conversationSystem?: ConversationSystem,
  ): AgentToolContext => ({
    request: {
      conversationKey: 900,
      mode: "agent",
      userText: "find that chat",
      libraryID: 1,
      ...overrides,
    } as AgentRuntimeRequest,
    ...(conversationSystem ? { conversationSystem } : {}),
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
  });
  const run = async (
    args: unknown,
    toolContext: AgentToolContext = context(),
  ): Promise<Result> => {
    const input = tool.validate(args);
    if (!input.ok) throw new Error(input.error);
    return (await tool.execute(input.value, toolContext)) as Result;
  };
  return { tool, context, run, source };
}

describe("past_chat_search", function () {
  const chats = [
    chat(10, "Grid cells chat", [
      "What did Hafting find about grid cells?",
      "Grid cells fire on a hexagonal lattice.",
    ]),
    chat(11, "Place cells", [
      "Tell me about place cells in the hippocampus.",
      "Place cells fire in one place.",
    ]),
    chat(
      12,
      "Codex paper chat",
      [
        "Summarize the grid paper",
        "It reports grid cells in entorhinal cortex.",
      ],
      { system: "codex", kind: "paper", paperItemID: 501 },
    ),
    chat(13, "Old theta chat", ["theta rhythm", "theta is 8 Hz"], {
      lastActivityAt: NOW - 400 * DAY,
    }),
  ];

  describe("labels", function () {
    const { run } = createHarness(chats);

    it("is clear when exactly one chat holds every one of two or more words", async function () {
      const result = await run({ query: "hexagonal lattice" });
      assert.equal(result.match, "clear");
      assert.equal(result.chats[0].chat, "upstream:10");
      assert.match(
        result.hint,
        /call past_chat_attach with chat "upstream:10"/,
      );
      assert.match(result.hint, /without asking/);
    });

    it("is several when two chats hold every word", async function () {
      const result = await run({ query: "grid cells" });
      assert.equal(result.match, "several");
      // Full matches first; "Place cells" holds one of the words.
      assert.sameMembers(
        result.chats.slice(0, 2).map((entry: Result) => entry.chat),
        ["upstream:10", "codex:12"],
      );
      assert.equal(result.chats[2].chat, "upstream:11");
      assert.equal(result.chats[2].termsMatched, 1);
      assert.match(result.hint, /Ask the user which one/);
      assert.match(result.hint, /Do not call past_chat_attach until/);
    });

    it("is several when chats hold only some of the words", async function () {
      const result = await run({ query: "hexagonal hippocampus" });
      assert.equal(result.match, "several");
      assert.equal(result.candidateCount, 2);
      assert.match(result.hint, /^No chat contains every word/);
      assert.deepEqual(
        result.chats.map((entry: Result) => entry.termsMatched),
        [1, 1],
      );
    });

    it("is several, with a confirm hint, for one word in one chat and no filter", async function () {
      const result = await run({ query: "hippocampus" });
      assert.equal(result.match, "several");
      assert.equal(result.candidateCount, 1);
      assert.match(
        result.hint,
        /Only one chat contains "hippocampus".*Confirm with the user/,
      );
    });

    it("is clear for one word in one chat when a filter narrows it", async function () {
      const result = await run({ query: "hippocampus", withinDays: 30 });
      assert.equal(result.match, "clear");
      assert.equal(result.chats[0].chat, "upstream:11");
    });

    it("is none when no chat holds any word, and points to the picker", async function () {
      const result = await run({ query: "dopamine reward" });
      assert.equal(result.match, "none");
      assert.deepEqual(result.chats, []);
      assert.equal(result.candidateCount, 0);
      assert.match(result.hint, /\/ → Add past conversation/);
    });

    it("with filters only, is clear for one chat, several for more, none for zero", async function () {
      const one = await run({ paperItemId: 501 });
      assert.equal(one.match, "clear");
      assert.equal(one.chats[0].chat, "codex:12");
      assert.notProperty(one.chats[0], "termsMatched");
      assert.notProperty(one.chats[0], "snippet");
      const several = await run({ withinDays: 30 });
      assert.equal(several.match, "several");
      assert.equal(several.candidateCount, 3);
      const none = await run({ paperItemId: 999 });
      assert.equal(none.match, "none");
    });

    it("says a clear match is already attached instead of attaching it again", async function () {
      const { run: runScoped, context } = createHarness(chats);
      const attached: AttachedConversationRef = {
        system: "upstream",
        conversationKey: 10,
        title: "Grid cells chat",
        libraryID: 1,
      };
      const result = await runScoped(
        { query: "hexagonal lattice" },
        context({ attachedConversationScope: [attached] }),
      );
      assert.equal(result.match, "clear");
      assert.isTrue(result.chats[0].alreadyAttached);
      assert.match(
        result.hint,
        /already attached: open it with past_chat_read/,
      );
    });
  });

  describe("which chats it lists", function () {
    it("leaves out the current conversation by system and key, not by key alone", async function () {
      const { run, context } = createHarness([
        chat(20, "Current grid chat", ["grid cells now"]),
        chat(20, "Codex grid chat", ["grid cells in codex"], {
          system: "codex",
        }),
      ]);
      const fromUpstream = await run(
        { query: "grid" },
        context({ conversationKey: 20 }),
      );
      assert.deepEqual(
        fromUpstream.chats.map((entry: Result) => entry.chat),
        ["codex:20"],
      );
      const fromCodex = await run(
        { query: "grid" },
        context({ conversationKey: 20 }, "codex"),
      );
      assert.deepEqual(
        fromCodex.chats.map((entry: Result) => entry.chat),
        ["upstream:20"],
      );
    });

    it("is clear, not several, once the current conversation's own row is left out", async function () {
      // The current user row is written before the run, so the index holds
      // the question itself.
      const { run, context } = createHarness([
        chat(30, "Current", ["find the chat about vector navigation"]),
        chat(31, "Vector navigation", ["vector navigation in bats"]),
      ]);
      const result = await run(
        { query: "vector navigation" },
        context({ conversationKey: 30 }),
      );
      assert.equal(result.match, "clear");
      assert.equal(result.chats[0].chat, "upstream:31");
    });

    it("leaves out other libraries, chats queued for deletion, temporary chats, web chats and empty chats", async function () {
      const { run } = createHarness(
        [
          chat(40, "Kept grid chat", ["grid kept"]),
          chat(41, "Other library grid", ["grid elsewhere"], { libraryID: 2 }),
          chat(42, "Deleted grid chat", ["grid deleted"]),
          chat(EPHEMERAL_GLOBAL_CONVERSATION_KEY_BASE + 5, "Side grid chat", [
            "grid side",
          ]),
          chat(43, "Web grid chat", ["grid web"], { webchatSession: true }),
          { conversationKey: 44, entry: { title: "Empty grid" }, messages: [] },
        ],
        { pendingDeletion: [42] },
      );
      const result = await run({ query: "grid" });
      assert.deepEqual(
        result.chats.map((entry: Result) => entry.chat),
        ["upstream:40"],
      );
    });

    it("applies the mode, paper and withinDays filters", async function () {
      const { run } = createHarness(chats);
      const codexOnly = await run({ query: "grid", mode: "codex" });
      assert.deepEqual(
        codexOnly.chats.map((entry: Result) => entry.chat),
        ["codex:12"],
      );
      const chatOnly = await run({ query: "grid", mode: "chat" });
      assert.deepEqual(
        chatOnly.chats.map((entry: Result) => entry.chat),
        ["upstream:10"],
      );
      const paper = await run({ query: "grid", paperItemId: 501 });
      assert.deepEqual(
        paper.chats.map((entry: Result) => entry.chat),
        ["codex:12"],
      );
      const recent = await run({ query: "theta" });
      assert.equal(recent.candidateCount, 1);
      const tooOld = await run({ query: "theta", withinDays: 30 });
      assert.equal(tooOld.match, "none");
    });
  });

  describe("the read limit", function () {
    /** `count` newer chats that hold only the word "grid". */
    function busyLibrary(count: number, firstKey = 1_000): FakePastChat[] {
      return Array.from({ length: count }, (_, index) =>
        chat(firstKey + index, `Grid note ${index}`, [`grid note ${index}`], {
          lastActivityAt: NOW - (index + 1) * 60_000,
        }),
      );
    }

    it("finds a full match older than the newest any-word matches, so two full matches across the cut are several", async function () {
      const { run, source } = createHarness([
        ...busyLibrary(120),
        chat(10, "New Hafting chat", ["grid cells in Hafting 2005"], {
          lastActivityAt: NOW - 1_000,
        }),
        chat(11, "Old Hafting chat", ["grid cells, as Hafting showed"], {
          lastActivityAt: NOW - 300 * DAY,
        }),
      ]);
      const result = await run({ query: "grid cells Hafting" });
      assert.equal(result.match, "several");
      assert.sameMembers(
        result.chats.slice(0, 2).map((entry: Result) => entry.chat),
        ["upstream:10", "upstream:11"],
      );
      assert.isTrue(result.more, "the any-word read hit its limit");
      // The full matches have their own read, which requires every word.
      assert.isTrue(source.searches[0].matchAllWords);
      assert.notProperty(source.searches[1], "matchAllWords");
      // An any-word read alone stops before the old chat.
      const anyWord = await source.searchChats!({
        libraryID: 1,
        query: "grid cells Hafting",
        limit: 100,
      });
      assert.notInclude(
        anyWord.map((candidate) => candidate.conversationKey),
        11,
      );
    });

    it("is never clear when the full-match read hit its limit", async function () {
      const fullMatches = Array.from({ length: 100 }, (_, index) =>
        chat(2_000 + index, `Place cell map ${index}`, ["place cell map"], {
          lastActivityAt: NOW - (index + 1) * 60_000,
        }),
      );
      // All but one are queued for deletion, so one is left to list.
      const { run } = createHarness(fullMatches, {
        pendingDeletion: fullMatches
          .slice(1)
          .map((entry) => entry.conversationKey),
      });
      const result = await run({ query: "place map" });
      assert.equal(result.candidateCount, 1);
      assert.equal(result.match, "several");
      assert.isTrue(result.more);
    });

    it("applies paperItemId, withinDays and mode in the read, so older chats inside the filter are found", async function () {
      const { run, source } = createHarness([
        ...busyLibrary(120),
        chat(20, "Old paper chat", ["grid spacing"], {
          kind: "paper",
          paperItemID: 777,
          lastActivityAt: NOW - 200 * DAY,
        }),
        chat(21, "Codex grid", ["grid in codex"], {
          system: "codex",
          lastActivityAt: NOW - 250 * DAY,
        }),
      ]);
      const paper = await run({ query: "grid", paperItemId: 777 });
      assert.equal(paper.match, "clear");
      assert.equal(paper.chats[0].chat, "upstream:20");
      assert.equal(source.searches[0].paperItemID, 777);
      const codex = await run({ query: "grid", mode: "codex" });
      assert.equal(codex.match, "clear");
      assert.deepEqual(source.searches[1].systems, ["codex"]);
      const recent = await run({ query: "grid", withinDays: 1 });
      assert.equal(source.searches[2].minLastActivityAt, NOW - DAY);
      assert.notInclude(
        recent.chats.map((entry: Result) => entry.chat),
        "upstream:20",
      );
    });

    it("reads the catalog with a high limit for filters only", async function () {
      const { run, source } = createHarness([
        ...busyLibrary(150),
        chat(30, "Old paper chat", ["about the paper"], {
          kind: "paper",
          paperItemID: 778,
          lastActivityAt: NOW - 300 * DAY,
        }),
      ]);
      const result = await run({ paperItemId: 778 });
      assert.equal(result.match, "clear");
      assert.equal(result.chats[0].chat, "upstream:30");
      assert.equal(source.lists[0].limit, 5_000);
      assert.equal(source.lists[0].paperItemID, 778);
      assert.notProperty(result, "more");
    });
  });

  describe("output", function () {
    it("lists full matches first, then by words matched, then newest, at most five", async function () {
      const many = Array.from({ length: 7 }, (_, index) =>
        chat(60 + index, `Alpha ${index}`, [`alpha note ${index}`], {
          lastActivityAt: NOW - (index + 1) * DAY,
        }),
      );
      const { run } = createHarness([
        ...many,
        chat(70, "Alpha beta", ["alpha and beta together"], {
          lastActivityAt: NOW - 100 * DAY,
        }),
      ]);
      const result = await run({ query: "alpha beta" });
      assert.equal(result.match, "clear");
      assert.equal(result.candidateCount, 8);
      assert.lengthOf(result.chats, 5);
      assert.deepEqual(
        result.chats.map((entry: Result) => entry.chat),
        [
          "upstream:70",
          "upstream:60",
          "upstream:61",
          "upstream:62",
          "upstream:63",
        ],
      );
    });

    it("returns the chat facts and a short snippet around the first matched word", async function () {
      const long = `${"intro ".repeat(80)}the lattice spacing grows ventrally ${"outro ".repeat(80)}`;
      const { run } = createHarness([
        chat(80, "Spacing chat", ["question", long]),
        chat(81, "Paper spacing", ["spacing along the axis"], {
          system: "codex",
          kind: "paper",
          paperItemID: 501,
        }),
      ]);
      const result = await run({ query: "lattice spacing" });
      const first = result.chats[0];
      assert.equal(first.chat, "upstream:80");
      assert.equal(first.title, "Spacing chat");
      assert.equal(first.mode, "Chat");
      assert.equal(first.lastActive, "2026-10-18");
      assert.equal(first.questions, 1);
      assert.equal(first.termsMatched, 2);
      assert.isFalse(first.alreadyAttached);
      assert.include(first.snippet, "lattice spacing grows ventrally");
      assert.isAtMost(first.snippet.length, 202);
      assert.match(first.snippet, /^….*…$/);
      const paper = result.chats[1];
      assert.equal(paper.mode, "Codex");
      assert.equal(paper.paper, "Hafting 2005");
      assert.equal(paper.termsMatched, 1);
    });

    it("uses the title as the snippet when only the title matches", async function () {
      const { run } = createHarness([
        chat(90, "Boundary vector cells", ["nothing relevant here"]),
      ]);
      const result = await run({ query: "boundary" });
      assert.equal(result.chats[0].snippet, "Boundary vector cells");
    });

    it("centres the snippet on the word when lowercasing changes the text's length", async function () {
      // "İ" lowercases to two characters, which shifts later positions.
      const text = `${"İ".repeat(150)} target ${"x".repeat(300)}`;
      const { run } = createHarness([chat(93, "Dotted", [text])]);
      const result = await run({ query: "target" });
      assert.include(result.chats[0].snippet, "target");
    });

    it("never cuts a surrogate pair in a snippet", async function () {
      const text = `${"😀".repeat(150)}needle${"😀".repeat(150)}`;
      const { run } = createHarness([chat(91, "Emoji", [text])]);
      const result = await run({ query: "needle" });
      const snippet = result.chats[0].snippet as string;
      assert.include(snippet, "needle");
      assert.notMatch(snippet, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      assert.notMatch(snippet, /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    });

    it("matches words case-insensitively as the history search does", async function () {
      const { run } = createHarness([
        chat(92, "Mixed", ["The ENTORHINAL Cortex holds grid cells"]),
      ]);
      const result = await run({ query: "Entorhinal  CORTEX" });
      assert.equal(result.match, "clear");
      assert.equal(result.chats[0].termsMatched, 2);
    });

    it("refuses without a library", async function () {
      const { run, context } = createHarness(chats);
      const result = await run(
        { query: "grid" },
        context({ libraryID: undefined }),
      );
      assert.isFalse(result.ok);
    });
  });

  describe("input", function () {
    const { tool } = createHarness(chats);

    it("needs words or a filter, and checks every field", function () {
      assert.isFalse(tool.validate({}).ok);
      assert.isFalse(tool.validate({ query: "   " }).ok);
      assert.isFalse(tool.validate({ query: "x".repeat(201) }).ok);
      assert.isFalse(tool.validate({ query: "a", paperItemId: 0 }).ok);
      assert.isFalse(tool.validate({ query: "a", withinDays: 0 }).ok);
      assert.isFalse(tool.validate({ query: "a", withinDays: 3651 }).ok);
      assert.isFalse(tool.validate({ query: "a", mode: "toString" }).ok);
      assert.isTrue(tool.validate({ query: "grid" }).ok);
      assert.isTrue(tool.validate({ withinDays: 7 }).ok);
      assert.isTrue(tool.validate({ mode: "claude_code" }).ok);
    });

    it("is a read tool with a read-only plan and no domains", function () {
      assert.equal(tool.spec.executionClass, "read");
      const plan = tool.planInvocation?.({} as never, {} as never) as {
        impact: string;
        domains: string[];
      };
      assert.equal(plan.impact, "read_only");
      assert.deepEqual(plan.domains, []);
    });
  });
});
