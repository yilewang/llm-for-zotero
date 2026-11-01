import { assert } from "chai";
import {
  buildResumeNote,
  buildSearchRecord,
  classifyModelFailure,
  classifyToolRound,
  isNavigationCall,
  rejectsToolChoiceNone,
  MODEL_STEP_RETRIES,
  modelRetryDelayMs,
  NAVIGATION_CALLS_TRIGGER,
  NAVIGATION_ROUNDS_TRIGGER,
  progressFingerprint,
  recordedStopRule,
  renderFinalOnlyInstruction,
  renderSearchCheckpoint,
  searchScopeLabel,
  TURN_SAFETY_LIMITS,
  TurnBoundary,
  type BoundaryToolRecord,
} from "../src/agent/loop/turnBoundary";
import { ModelStreamInterruptedError } from "../src/agent/model/completion";
import { parseResponsesStepStream } from "../src/agent/model/responsesShared";
import { parseRetryAfterMs, providerHttpError } from "../src/utils/retryAfter";

/**
 * The whole-turn stop rules (docs/plans/2026-10-13-agent-stop-rules.md), as
 * pure decisions: the progress classifier, the boundary's counters, the
 * search record and its absence-claim guard, and the retry classifier.
 */

const search = (text: string, results: unknown[] = []): BoundaryToolRecord => ({
  name: "library_search",
  ok: true,
  input: { entity: "items", mode: "search", text },
  content: { results },
});

const retrieve = (
  query: string,
  paperMatches: unknown[] = [],
): BoundaryToolRecord => ({
  name: "library_retrieve",
  ok: true,
  input: { query },
  content: { paperMatches },
});

const read = (
  itemId: number,
  frontier: "advanced" | "unchanged" = "advanced",
  readsThisTurn = 1,
): BoundaryToolRecord => ({
  name: "paper_read",
  ok: true,
  input: { target: { itemId } },
  content: {
    papers: [{ itemId, passages: ["text"] }],
    paperEvidenceProgress: { frontier, readsThisTurn },
  },
  frontier,
});

function boundary(
  overrides: Partial<ConstructorParameters<typeof TurnBoundary>[0]> = {},
): TurnBoundary {
  return new TurnBoundary({
    now: 0,
    maxRounds: 24,
    settledTargets: 0,
    ...overrides,
  });
}

describe("turn boundary: the progress classifier", function () {
  it("names the navigation calls", function () {
    assert.isTrue(isNavigationCall(search("drift")));
    assert.isTrue(isNavigationCall(retrieve("drift")));
    assert.isTrue(isNavigationCall(read(5, "unchanged")));
    assert.isFalse(isNavigationCall(read(5, "advanced")));
    assert.isTrue(
      isNavigationCall({
        name: "zotero_script",
        ok: true,
        input: { access: "library", effect: "read" },
      }),
    );
    assert.isFalse(
      isNavigationCall({
        name: "zotero_script",
        ok: true,
        input: { access: "privileged", effect: "read" },
      }),
      "a privileged script is not a proven read",
    );
    assert.isFalse(isNavigationCall({ name: "web_search", ok: true }));
  });

  it("never counts navigation as progress, whatever its match status", function () {
    const strong = retrieve("drift", [
      { itemId: "7", title: "Drift", matchStatus: "strong" },
    ]);
    assert.isUndefined(progressFingerprint(strong));
    const round = classifyToolRound(
      [strong, search("drift")],
      new Set(),
      false,
    );
    assert.equal(round.kind, "navigation");
    assert.equal(round.navigationCalls, 2);
  });

  it("drops the per-turn read count from a read's fingerprint", function () {
    const first = progressFingerprint(read(5, "advanced", 1));
    const again = progressFingerprint(read(5, "advanced", 2));
    assert.isString(first);
    assert.equal(first, again);
  });

  it("counts a new result, or a newly settled paper, as progress", function () {
    const web = { name: "web_search", ok: true, input: { q: 1 }, content: 1 };
    const seen = new Set<string>();
    const first = classifyToolRound([web], seen, false);
    assert.equal(first.kind, "progress");
    first.newFingerprints.forEach((value) => seen.add(value));
    assert.equal(classifyToolRound([web], seen, false).kind, "no_progress");
    assert.equal(classifyToolRound([web], seen, true).kind, "progress");
  });

  it("lets a prompt be compacted again after a step succeeds or a paper settles", function () {
    const turn = boundary();
    const tooLong = { kind: "prompt_too_long" } as const;
    assert.equal(
      turn.onModelFailure(tooLong, { toolCallSeen: false }).kind,
      "compact",
    );
    turn.modelStepSucceeded();
    assert.equal(
      turn.onModelFailure(tooLong, { toolCallSeen: false }).kind,
      "compact",
    );
    turn.beforeModelCall({ now: 0, settledTargets: 1 });
    assert.equal(
      turn.onModelFailure(tooLong, { toolCallSeen: false }).kind,
      "compact",
    );
    assert.equal(
      turn.onModelFailure(tooLong, { toolCallSeen: false }).kind,
      "stop",
    );
  });

  it("does not count a write that changed nothing", function () {
    assert.isUndefined(
      progressFingerprint({
        name: "note_write",
        ok: true,
        mutability: "write",
        effect: "none" as never,
      }),
    );
  });
});

describe("turn boundary: navigation without evidence (Rules 1 and 2)", function () {
  const navigationRound = (turn: TurnBoundary, round: number, calls: number) =>
    turn.afterToolRound({
      round,
      calls: Array.from({ length: calls }, (_, index) =>
        search(`query ${round}.${index}`),
      ),
      settledTargets: 0,
      now: 0,
    }).decision.kind;

  it("pins W = 8 rounds and S = 18 calls", function () {
    assert.equal(NAVIGATION_ROUNDS_TRIGGER, 8);
    assert.equal(NAVIGATION_CALLS_TRIGGER, 18);
  });

  it("checkpoints at W rounds and S calls, then asks for the answer after one more window", function () {
    const turn = boundary();
    const decisions: string[] = [];
    for (let round = 1; round <= 16; round += 1)
      decisions.push(navigationRound(turn, round, 3));
    assert.equal(decisions.indexOf("checkpoint"), 7, "round 8");
    assert.equal(decisions.indexOf("final_only"), 15, "round 16");
    assert.isTrue(turn.finalOnly);
  });

  it("needs both counts: eight one-call rounds do not reach the checkpoint", function () {
    const turn = boundary();
    const decisions = Array.from({ length: 12 }, (_, index) =>
      navigationRound(turn, index + 1, 1),
    );
    assert.notInclude(decisions, "checkpoint");
    // 18 calls are reached at round 18.
    for (let round = 13; round <= 18; round += 1)
      decisions.push(navigationRound(turn, round, 1));
    assert.equal(decisions.indexOf("checkpoint"), 17);
  });

  it("matches the calibration: excerpt 198 (4 rounds, 9 calls) and 243 (7, 14) do not trigger; 200 (10, 18) does", function () {
    const stretch = (rounds: number, calls: number) => {
      const turn = boundary();
      const perRound = Array.from(
        { length: rounds },
        (_, index) =>
          Math.floor(((index + 1) * calls) / rounds) -
          Math.floor((index * calls) / rounds),
      );
      return perRound.map((count, index) =>
        navigationRound(turn, index + 1, count),
      );
    };
    assert.notInclude(stretch(4, 9), "checkpoint");
    assert.notInclude(stretch(7, 14), "checkpoint");
    assert.notInclude(stretch(6, 9), "checkpoint");
    assert.equal(stretch(10, 18).indexOf("checkpoint"), 9);
  });

  it("a late find resets the counters", function () {
    const turn = boundary();
    for (let round = 1; round <= NAVIGATION_ROUNDS_TRIGGER - 1; round += 1)
      assert.equal(navigationRound(turn, round, 3), "continue");
    const found = turn.afterToolRound({
      round: 8,
      calls: [read(7)],
      settledTargets: 0,
      now: 0,
    });
    assert.equal(found.report.kind, "progress");
    assert.equal(found.decision.kind, "continue");
    assert.equal(found.report.navigationRounds, 0);
    assert.equal(navigationRound(turn, 9, 3), "continue");
  });

  it("gives one checkpoint per turn: read a lookalike, search again, then the answer without tools", function () {
    const turn = boundary();
    for (let round = 1; round <= 8; round += 1) navigationRound(turn, round, 3);
    assert.equal(turn.phase, "checkpointed");
    const lookalike = turn.afterToolRound({
      round: 9,
      calls: [read(3)],
      settledTargets: 0,
      now: 0,
    });
    assert.equal(lookalike.report.kind, "progress");
    assert.equal(turn.phase, "checkpointed", "the phase stays after progress");
    assert.equal(lookalike.report.navigationRounds, 0, "the window restarts");
    const decisions = Array.from({ length: 8 }, (_, index) =>
      navigationRound(turn, 10 + index, 3),
    );
    assert.notInclude(decisions, "checkpoint");
    assert.equal(decisions[7], "final_only");
  });

  it("settling papers returns a checkpointed turn to the search phase", function () {
    const turn = boundary();
    for (let round = 1; round <= 8; round += 1) navigationRound(turn, round, 3);
    assert.equal(turn.phase, "checkpointed");
    for (let index = 1; index <= 40; index += 1) {
      const settled = turn.afterToolRound({
        round: 8 + index,
        calls: [read(index)],
        settledTargets: index,
        now: 0,
      });
      assert.equal(settled.decision.kind, "continue");
    }
    assert.equal(turn.phase, "searching");
    const decisions: string[] = [];
    for (let index = 1; index <= 8; index += 1)
      decisions.push(
        turn.afterToolRound({
          round: 48 + index,
          calls: Array.from({ length: 3 }, (_, call) =>
            search(`later ${index}.${call}`),
          ),
          settledTargets: 40,
          now: 0,
        }).decision.kind,
      );
    assert.equal(decisions[7], "checkpoint");
    assert.isFalse(turn.finalOnly);
  });

  for (const [label, perRound] of [
    ["one call", () => 1],
    ["1.4 calls", (round: number) => (round % 5 < 2 ? 2 : 1)],
  ] as const) {
    it(`a runaway of ${label} per round reaches the answer without tools, never a segment stop`, function () {
      const turn = boundary();
      const decisions: string[] = [];
      for (let round = 1; round <= 60 && !turn.finalOnly; round += 1)
        decisions.push(navigationRound(turn, round, perRound(round)));
      assert.include(decisions, "checkpoint");
      assert.equal(decisions.at(-1), "final_only");
      assert.notInclude(decisions, "stop");
      assert.isAtMost(decisions.length, 2 * NAVIGATION_CALLS_TRIGGER);
    });
  }

  it("does not checkpoint non-library work that keeps finding new results", function () {
    const turn = boundary();
    for (let round = 1; round <= 30; round += 1) {
      const { decision } = turn.afterToolRound({
        round,
        calls: [
          { name: "run_command", ok: true, input: { round }, content: round },
        ],
        settledTargets: 0,
        now: 0,
      });
      assert.equal(decision.kind, "continue");
    }
  });

  describe("a read-only zotero_script", function () {
    // The constrained read facade; the result shape is zoteroScript.ts's
    // scriptResultContent. Script text and description differ every call.
    const script = (
      index: number,
      result: { returnValue?: unknown; output?: string; error?: string },
      ok = true,
    ): BoundaryToolRecord => ({
      name: "zotero_script",
      ok,
      // zotero_script is an external_effect tool; its read reports "none".
      mutability: "write",
      effect: "none" as never,
      input: {
        access: "library",
        effect: "read",
        description: `Analysis ${index}`,
        script: `return query${index}();`,
      },
      content: {
        access: "library",
        effect: "read",
        description: `Analysis ${index}`,
        output: result.output ?? "",
        returnValue: result.returnValue,
        itemsAffected: 0,
        error: result.error,
      },
    });
    const scriptRounds = (calls: (round: number) => BoundaryToolRecord) => {
      const turn = boundary();
      return Array.from({ length: 20 }, (_, index) =>
        turn.afterToolRound({
          round: index + 1,
          calls: [calls(index + 1)],
          settledTargets: 0,
          now: 0,
        }),
      );
    };

    it("counts as progress when its result is new: twenty distinct analyses never trip the gate", function () {
      const rounds = scriptRounds((round) =>
        script(round, {
          returnValue: { year: 2000 + round, papers: round },
          output: `took ${round * 7} ms`,
        }),
      );
      assert.deepEqual(
        rounds.map((r) => r.decision.kind),
        Array(20).fill("continue"),
      );
      assert.isTrue(rounds.every((r) => r.report.kind === "progress"));
    });

    it("stays navigation when its result repeats, whatever the script text or its log lines", function () {
      const rounds = scriptRounds((round) =>
        script(round, {
          returnValue: { year: 2020, papers: 3 },
          output: `took ${round * 7} ms`,
        }),
      );
      assert.equal(rounds[0].report.kind, "progress", "the first is new");
      assert.isTrue(
        rounds.slice(1).every((r) => r.report.kind === "navigation"),
      );
      // Rounds 2 to 19 are 18 navigation rounds and 18 calls.
      assert.equal(
        rounds.findIndex((r) => r.decision.kind === "checkpoint"),
        18,
      );
    });

    it("reads its log lines only when it returns nothing", function () {
      const logged = (round: number) =>
        progressFingerprint(script(round, { output: `rows: ${round}` }));
      assert.notEqual(logged(1), logged(2));
      assert.equal(
        progressFingerprint(script(1, { returnValue: 5, output: "a" })),
        progressFingerprint(script(2, { returnValue: 5, output: "b" })),
      );
    });

    it("is never progress when it failed", function () {
      assert.isUndefined(
        progressFingerprint(script(1, { error: "TypeError: x is undefined" })),
      );
      assert.isUndefined(
        progressFingerprint(script(1, { returnValue: 1 }, false)),
      );
      assert.equal(
        classifyToolRound([script(1, { error: "TypeError" })], new Set(), false)
          .kind,
        "navigation",
      );
    });

    it("counts a privileged read script's new result as progress, never as navigation", function () {
      const privileged = (returnValue: unknown): BoundaryToolRecord => ({
        ...script(1, { returnValue }),
        input: { access: "privileged", effect: "read" },
      });
      assert.isFalse(isNavigationCall(privileged(1)));
      assert.isString(progressFingerprint(privileged(1)));
      assert.equal(
        progressFingerprint(privileged(1)),
        progressFingerprint(privileged(1)),
      );
      assert.notEqual(
        progressFingerprint(privileged(1)),
        progressFingerprint(privileged(2)),
      );
    });
  });

  it("stops a segment of tool rounds without a new result", function () {
    const turn = boundary();
    const same = { name: "web_search", ok: true, input: {}, content: 1 };
    const decisions = Array.from(
      { length: 25 },
      (_, index) =>
        turn.afterToolRound({
          round: index + 1,
          calls: [same],
          settledTargets: 0,
          now: 0,
        }).decision,
    );
    assert.deepEqual(decisions[24], {
      kind: "stop",
      rule: "segment_without_progress",
    });
    assert.isTrue(decisions.slice(0, 24).every((d) => d.kind === "continue"));
  });

  it("reports a round without tools without moving a counter", function () {
    const turn = boundary();
    navigationRound(turn, 1, 3);
    const report = turn.noToolRound(2);
    assert.equal(report.kind, "no_tools");
    assert.equal(report.navigationRounds, 1);
  });
});

describe("turn boundary: safety limits (Rule 3)", function () {
  it("pins the limits", function () {
    assert.deepEqual(
      { ...TURN_SAFETY_LIMITS },
      {
        modelCalls: 100,
        inputTokens: 6_700_000,
        wallClockMs: 30 * 60_000,
      },
    );
  });

  it("stops at the model-call, token and wall-clock limits", function () {
    const calls = boundary({ limits: { modelCalls: 3 } });
    for (let index = 0; index < 3; index += 1) {
      assert.equal(
        calls.beforeModelCall({ now: 0, settledTargets: 0 }).kind,
        "continue",
      );
      calls.recordModelCall(10);
    }
    assert.deepEqual(calls.beforeModelCall({ now: 0, settledTargets: 0 }), {
      kind: "stop",
      rule: "budget_reached",
    });
    const tokens = boundary({ limits: { inputTokens: 100 } });
    tokens.recordModelCall(60);
    tokens.recordModelCall(60);
    assert.equal(
      tokens.beforeModelCall({ now: 0, settledTargets: 0 }).kind,
      "stop",
    );
    const clock = boundary({ limits: { wallClockMs: 1000 } });
    assert.equal(
      clock.beforeModelCall({ now: 999, settledTargets: 0 }).kind,
      "continue",
    );
    assert.equal(
      clock.beforeModelCall({ now: 1000, settledTargets: 0 }).kind,
      "stop",
    );
  });

  it("does not count time spent waiting on the user", function () {
    const clock = boundary({ limits: { wallClockMs: 1000 } });
    clock.excludeWait(5000);
    assert.equal(
      clock.beforeModelCall({ now: 5500, settledTargets: 0 }).kind,
      "continue",
    );
  });

  it("restarts every counter whenever a long job settles a paper", function () {
    const job = boundary({ limits: { modelCalls: 3, wallClockMs: 1000 } });
    for (let settled = 1; settled <= 20; settled += 1) {
      job.recordModelCall(1);
      job.recordModelCall(1);
      assert.equal(
        job.beforeModelCall({ now: settled * 900, settledTargets: settled })
          .kind,
        "continue",
      );
    }
  });
});

describe("turn boundary: failure counters (unchanged constants)", function () {
  it("stops after 3 failing rounds or 6 rejected-input rounds, reset by a success", function () {
    const turn = boundary();
    const fail = {
      hadSuccessfulResult: false,
      hadToolFailure: true,
      hadInputRejection: false,
    };
    assert.isUndefined(turn.recordToolRoundOutcome(fail));
    assert.isUndefined(turn.recordToolRoundOutcome(fail));
    assert.equal(turn.recordToolRoundOutcome(fail), "repeated_tool_errors");
    const rejects = boundary();
    const reject = {
      hadSuccessfulResult: false,
      hadToolFailure: false,
      hadInputRejection: true,
    };
    for (let index = 0; index < 5; index += 1)
      assert.isUndefined(rejects.recordToolRoundOutcome(reject));
    rejects.recordToolRoundOutcome({ ...reject, hadSuccessfulResult: true });
    for (let index = 0; index < 5; index += 1)
      assert.isUndefined(rejects.recordToolRoundOutcome(reject));
    assert.equal(
      rejects.recordToolRoundOutcome(reject),
      "repeated_input_rejections",
    );
  });

  it("gives a paper up after the same failure twice, and stops a page's worth in a row", function () {
    const turn = boundary();
    assert.isFalse(turn.recordPaperFailure("item:1", "no pdf"));
    assert.isFalse(turn.recordPaperFailure("item:1", "timeout"));
    assert.isTrue(turn.recordPaperFailure("item:1", "no pdf"));
    assert.isUndefined(
      turn.recordPapersGivenUp({
        doneThisRound: 0,
        givenUp: 1,
        pageSize: () => 3,
      }),
    );
    assert.equal(
      turn.recordPapersGivenUp({
        doneThisRound: 0,
        givenUp: 2,
        pageSize: () => 3,
      }),
      3,
    );
  });
});

describe("turn boundary: the search record (Rule 2)", function () {
  it("records queries, lookups, listed and read items", function () {
    const record = buildSearchRecord([
      search("Smith 2020 place cells", [{ itemId: 4, title: "Place cells" }]),
      search("smith 2020  place cells"),
      retrieve("place cell drift", [
        { itemId: "9", title: "Drift", matchStatus: "strong" },
        { itemId: "4", title: "Place cells", matchStatus: "possible" },
        { itemId: "2", title: "Other", matchStatus: "weak" },
        { itemId: "8", title: "Fourth", matchStatus: "strong" },
      ]),
      read(4),
    ]);
    assert.deepEqual(record.queries, [
      "Smith 2020 place cells",
      "place cell drift",
    ]);
    assert.equal(record.metadataLookups, 2);
    assert.deepEqual(
      record.listed.map((item) => item.itemId),
      ["4", "9", "2", "8"],
    );
    assert.deepEqual(record.read, [{ itemId: "4", title: "Place cells" }]);
  });

  describe("empty lookups: a title or author search that found no item", function () {
    const unreadable: BoundaryToolRecord = {
      name: "library_search",
      ok: true,
      input: { entity: "items", mode: "search", text: "Smith 2020" },
      content: { summary: "no table" },
    };

    it("counts a lookup whose result lists no item", function () {
      const empty = search("Smith 2020 Representational drift in CA1");
      const author: BoundaryToolRecord = {
        name: "library_search",
        ok: true,
        input: {
          entity: "items",
          mode: "search",
          filters: { author: "Smith" },
        },
        content: { results: [], totalCount: 0 },
      };
      const record = buildSearchRecord([empty, author]);
      assert.equal(record.metadataLookups, 2);
      assert.equal(record.emptyLookups, 2);
    });

    it("counts only the empty lookups when another lists an item", function () {
      const guessed = search("Ziv 2012 long-term dynamics of CA1 place codes");
      const listed = search("Smith 2020 drift", [
        { itemId: 5, title: "An unrelated paper" },
      ]);
      const record = buildSearchRecord([guessed, listed]);
      assert.equal(record.metadataLookups, 2);
      assert.equal(record.emptyLookups, 1);
    });

    it("does not count an ambiguous, failed or non-item result as empty", function () {
      const truncated: BoundaryToolRecord = {
        ...unreadable,
        content: { results: [], totalCount: 3 },
      };
      const failed: BoundaryToolRecord = {
        ...unreadable,
        ok: false,
        content: { results: [] },
      };
      const collections: BoundaryToolRecord = {
        ...unreadable,
        input: { entity: "collections", mode: "search", text: "Smith" },
        content: { results: [] },
      };
      for (const lookup of [unreadable, truncated, failed, collections])
        assert.equal(
          buildSearchRecord([lookup]).emptyLookups,
          0,
          JSON.stringify(lookup),
        );
    });

    it("the record tells the model the lookup found no item", function () {
      assert.include(
        renderSearchCheckpoint(
          buildSearchRecord([search("Smith 2020"), retrieve("drift")]),
          "your library",
        ),
        "made; it found no item",
      );
    });
  });

  it("the checkpoint offers to answer first and never mentions limits", function () {
    const text = renderSearchCheckpoint(
      buildSearchRecord([search("Smith"), retrieve("drift")]),
      "your library",
    );
    assert.isBelow(
      text.indexOf("answer with the paper"),
      text.indexOf("not found in your library"),
    );
    assert.notMatch(text, /budget|window|round|limit|give up|giving up/i);
    assert.include(text, "“Smith”");
  });

  it("offers 'not found' only to a turn that searched and read nothing", function () {
    const reading = buildSearchRecord([
      read(5, "unchanged"),
      read(5, "unchanged"),
    ]);
    const checkpoint = renderSearchCheckpoint(reading, "your library");
    assert.notInclude(checkpoint, "not found");
    assert.include(checkpoint, "do and do not show");
    const finalOnly = renderFinalOnlyInstruction(reading, "your library");
    assert.notInclude(finalOnly, "absent");
    assert.include(finalOnly, "do and do not show");
    const synthesis = buildSearchRecord([retrieve("drift"), read(5)]);
    assert.notInclude(
      renderSearchCheckpoint(synthesis, "your library"),
      "not found",
    );
  });

  it("without a title lookup the final-only step may not claim absence", function () {
    const text = renderFinalOnlyInstruction(
      buildSearchRecord([retrieve("drift")]),
      "your library",
    );
    assert.include(text, "do not say the paper is absent");
    assert.include(text, "not confirmed");
  });

  it("names the scope a 'not found' answer covers", function () {
    assert.equal(
      searchScopeLabel({ collections: [], tags: [] }),
      "your library",
    );
    assert.equal(
      searchScopeLabel({ collections: [{ name: "Drift" }], tags: [] }),
      "the selected collection “Drift”",
    );
  });
});

describe("turn boundary: the retry policy (Rule 4)", function () {
  it("classifies network, stream and HTTP failures as transient", function () {
    for (const error of [
      new TypeError("NetworkError when attempting to fetch resource."),
      new Error("Error in input stream"),
      new Error("fetch failed"),
    ])
      assert.equal(
        classifyModelFailure(error).kind,
        "transient",
        error.message,
      );
    assert.deepInclude(
      classifyModelFailure(new ModelStreamInterruptedError("overloaded", 529)),
      { kind: "transient", cause: "stream", status: 529 },
    );
    for (const status of [429, 500, 502, 503, 529])
      assert.deepInclude(
        classifyModelFailure(new Error(`${status} Busy (https://x) - busy`)),
        { kind: "transient", cause: "http", status },
      );
  });

  it("does not retry an abort, a client error or an unknown failure", function () {
    const abort = new Error("Aborted");
    abort.name = "AbortError";
    assert.equal(classifyModelFailure(abort).kind, "fatal");
    assert.equal(
      classifyModelFailure(new Error("401 Unauthorized - bad key")).kind,
      "fatal",
    );
    assert.equal(
      classifyModelFailure(new Error("provider interrupted")).kind,
      "fatal",
    );
    assert.equal(
      classifyModelFailure(new Error("simulated process interruption")).kind,
      "fatal",
    );
  });

  it("recognizes a prompt the provider calls too long", function () {
    assert.equal(
      classifyModelFailure(
        new Error(
          "400 Bad Request - prompt is too long: 210000 tokens > 200000 maximum",
        ),
      ).kind,
      "prompt_too_long",
    );
    assert.equal(
      classifyModelFailure(
        new Error('400 Bad Request - {"code":"context_length_exceeded"}'),
      ).kind,
      "prompt_too_long",
    );
    assert.equal(
      classifyModelFailure(
        new Error(
          "400 Bad Request - The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).",
        ),
      ).kind,
      "prompt_too_long",
    );
    assert.equal(
      classifyModelFailure(
        new Error(
          "400 Bad Request - Invalid request: exceeded model token limit",
        ),
      ).kind,
      "prompt_too_long",
    );
  });

  it("recognizes a provider that refuses tool_choice none", function () {
    assert.isTrue(
      rejectsToolChoiceNone(
        new Error("400 Bad Request - tool_choice 'none' is not supported"),
      ),
    );
    assert.isTrue(
      rejectsToolChoiceNone(
        new Error('400 Bad Request - invalid value "none" for this model'),
      ),
    );
    assert.isFalse(
      rejectsToolChoiceNone(new Error("400 Bad Request - bad key")),
    );
    assert.isFalse(
      rejectsToolChoiceNone(new Error("500 Internal - tool_choice failed")),
    );
  });

  it("retries twice with backoff, honoring retry-after, then stops connection_lost", function () {
    assert.equal(MODEL_STEP_RETRIES, 2);
    const turn = boundary();
    const failure = classifyModelFailure(new Error("Error in input stream"));
    assert.deepEqual(turn.onModelFailure(failure, { toolCallSeen: false }), {
      kind: "retry",
      retry: 1,
      delayMs: 2000,
    });
    assert.deepEqual(turn.onModelFailure(failure, { toolCallSeen: false }), {
      kind: "retry",
      retry: 2,
      delayMs: 8000,
    });
    assert.deepEqual(turn.onModelFailure(failure, { toolCallSeen: false }), {
      kind: "stop",
      rule: "connection_lost",
    });
    const fresh = boundary();
    fresh.onModelFailure(failure, { toolCallSeen: false });
    fresh.modelStepSucceeded();
    assert.equal(
      fresh.onModelFailure(failure, { toolCallSeen: false }).kind,
      "retry",
      "a step that succeeds starts a new count",
    );
    assert.equal(
      modelRetryDelayMs(1, {
        kind: "transient",
        cause: "http",
        retryAfterMs: 5000,
      }),
      5000,
    );
    assert.equal(
      modelRetryDelayMs(1, {
        kind: "transient",
        cause: "http",
        retryAfterMs: 600_000,
      }),
      60_000,
    );
  });

  it("retries a Responses stream that ended before the response finished", async function () {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"type":"response.created","response":{"id":"resp_cut"}}\n',
          ),
        );
        controller.close();
      },
    });
    let error: unknown;
    try {
      await parseResponsesStepStream(stream);
    } catch (caught) {
      error = caught;
    }
    const failure = classifyModelFailure(error);
    assert.deepEqual(failure, { kind: "transient", cause: "stream" });
    assert.deepEqual(
      boundary({ retryBackoffMs: [0, 0] }).onModelFailure(failure, {
        toolCallSeen: false,
      }),
      { kind: "retry", retry: 1, delayMs: 0 },
    );
  });

  it("does not retry a step that already ran a tool", function () {
    const failure = classifyModelFailure(new Error("Error in input stream"));
    assert.deepEqual(
      boundary().onModelFailure(failure, { toolCallSeen: true }),
      {
        kind: "stop",
        rule: "connection_lost",
      },
    );
  });

  it("compacts once for a prompt too long, then stops prompt_budget_exceeded", function () {
    const turn = boundary();
    const failure = { kind: "prompt_too_long" } as const;
    assert.deepEqual(turn.onModelFailure(failure, { toolCallSeen: false }), {
      kind: "compact",
    });
    assert.deepEqual(turn.onModelFailure(failure, { toolCallSeen: false }), {
      kind: "stop",
      rule: "prompt_budget_exceeded",
    });
  });

  it("reads retry-after in seconds or as a date, and carries it on the HTTP error", function () {
    assert.equal(parseRetryAfterMs("3", 0), 3000);
    assert.equal(
      parseRetryAfterMs("Thu, 01 Jan 1970 00:00:10 GMT", 4000),
      6000,
    );
    assert.isUndefined(parseRetryAfterMs("", 0));
    const error = providerHttpError(
      {
        status: 429,
        statusText: "Too Many Requests",
        headers: { get: (name) => (name === "retry-after" ? "4" : null) },
      },
      "https://api.example/v1",
      "slow down",
    );
    assert.match(error.message, /^429 Too Many Requests/);
    assert.deepInclude(classifyModelFailure(error), {
      kind: "transient",
      status: 429,
      retryAfterMs: 4000,
    });
  });
});

describe("turn boundary: resume", function () {
  it("reads the recorded stop rule and notes a resumable one", function () {
    const events = [
      { payload: { type: "status", text: "x" } },
      {
        payload: {
          type: "provider_event",
          providerType: "agent_run_stop",
          payload: { rule: "connection_lost", status: "failed" },
        },
      },
    ];
    assert.equal(recordedStopRule(events), "connection_lost");
    assert.include(buildResumeNote("connection_lost"), "Resume note");
    assert.include(buildResumeNote("budget_reached"), "safety limit");
    assert.include(
      buildResumeNote("prompt_budget_exceeded"),
      "narrow the request or start a new chat",
    );
    assert.include(
      buildResumeNote("empty_answer"),
      "the model returned an empty answer twice",
    );
    assert.isUndefined(buildResumeNote("final_answer"));
  });
});
