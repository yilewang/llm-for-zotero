/**
 * The agent stop rules (docs/plans/2026-10-13-agent-stop-rules.md, Tests)
 * through the panel's real send flow and the real runtime. Only the model is
 * scripted (no API cost); scenario 8 and part of scenario 6 drive the real
 * Anthropic adapter over a stubbed fetch.
 */
import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

/** W and S of turnBoundary.ts. */
const W = 8;

describe("workflow: agent stop rules", function () {
  this.timeout(180000);

  const api = () =>
    (Zotero as any).LLMForZotero.api.workflowTest as WorkflowTestApi;

  /** A fresh paper and its panel for one scenario, removed afterwards. */
  async function withPanel<T>(
    run: (panelId: string, paper: Zotero.Item) => Promise<T>,
  ): Promise<T> {
    assert.match(
      Zotero.DataDirectory.dir,
      /(?:[/\\]zotero-dev|[/\\]\.scaffold[/\\]test[/\\]data)[/\\]?$/,
    );
    const paper = new Zotero.Item("journalArticle");
    paper.libraryID = Zotero.Libraries.userLibraryID;
    paper.setField("title", `Stop rules paper ${Date.now()}`);
    await paper.saveTx();
    const panel = await api().renderPanelForItem(paper.id);
    try {
      return await run(panel.panelId, paper);
    } finally {
      await api()
        .clickPanelDelete(panel.panelId)
        .catch(() => undefined);
      await paper.eraseTx().catch(() => undefined);
    }
  }

  const scenario = (
    panelId: string,
    name: Parameters<WorkflowTestApi["exerciseAgentStopRules"]>[0]["scenario"],
    extra: Partial<
      Parameters<WorkflowTestApi["exerciseAgentStopRules"]>[0]
    > = {},
  ) => api().exerciseAgentStopRules({ panelId, scenario: name, ...extra });

  it("1. a runaway search checkpoints, then answers without tools within 2W + 2 rounds", async function () {
    await withPanel(async (panelId) => {
      const result = (await scenario(panelId, "runaway_search")) as any;
      const report = JSON.stringify({
        ...result,
        turn: { ...result.turn, prompts: undefined },
      });
      assert.isTrue(result.checkpointSeen, report);
      assert.deepEqual(
        result.turn.boundaries.map((entry: any) => [entry.action, entry.round]),
        [
          ["checkpoint", W],
          ["final_only", 2 * W],
        ],
        report,
      );
      assert.isAtMost(result.turn.steps, 2 * W + 2, report);
      assert.equal(result.turn.toolChoices.at(-1), "none", report);
      assert.equal(result.turn.stopRule, "search_exhausted", report);
      assert.equal(result.turn.runStatus, "completed", report);
      assert.equal(result.turn.end, "completed_with_exceptions", report);
      assert.include(result.turn.chatText, "Not confirmed", report);
      assert.isTrue(
        result.turn.rounds
          .slice(0, 2 * W)
          .every((round: any) => round.kind === "navigation"),
        report,
      );
    });
  });

  it("2. a late find after W - 1 navigation rounds gets no checkpoint", async function () {
    await withPanel(async (panelId) => {
      const result = (await scenario(panelId, "late_find")) as any;
      const report = JSON.stringify(result.turn.rounds);
      assert.isFalse(result.checkpointSeen, report);
      assert.deepEqual(result.turn.boundaries, [], report);
      assert.equal(result.turn.rounds[W - 1].kind, "progress", report);
      assert.equal(result.turn.stopRule, "final_answer");
      assert.equal(result.turn.runStatus, "completed");
    });
  });

  it("3. thirty rounds of work outside the library with new results get no checkpoint", async function () {
    await withPanel(async (panelId) => {
      const result = (await scenario(panelId, "non_library_work")) as any;
      const report = JSON.stringify(result.turn.boundaries);
      assert.isFalse(result.checkpointSeen, report);
      assert.deepEqual(result.turn.boundaries, [], report);
      assert.equal(result.turn.steps, 31);
      assert.equal(result.turn.stopRule, "final_answer");
      assert.equal(result.turn.chatText, "All thirty steps ran.");
    });
  });

  it("4. a volunteered 'not in your library' after one search is accepted as written", async function () {
    await withPanel(async (panelId) => {
      const result = (await scenario(panelId, "early_not_found")) as any;
      assert.equal(result.turn.steps, 2, "one search, then the answer");
      assert.equal(result.turn.stopRule, "final_answer");
      assert.equal(
        result.turn.chatText,
        "The cited paper is not in your library.",
      );
    });
  });

  it("5. a 'not found' after a title lookup and a topical search ends the turn, and after lookups that found no item beside a strong lookalike", async function () {
    await withPanel(async (panelId) => {
      const result = (await scenario(panelId, "proper_not_found")) as any;
      assert.equal(result.turn.steps, 3);
      assert.equal(result.turn.stopRule, "final_answer");
      assert.equal(result.decisive.steps, 2);
      assert.equal(result.decisive.stopRule, "final_answer");
    });
  });

  it("6. network failures are retried without duplicated text; after the retries the turn is interrupted and 'continue' resumes", async function () {
    await withPanel(async (panelId) => {
      const result = (await scenario(panelId, "network_retries")) as any;
      const report = JSON.stringify({
        recovered: { ...result.recovered, prompts: undefined },
        anthropic: { ...result.anthropic, prompts: undefined },
        lost: { ...result.lost, prompts: undefined },
      });
      // Two failures, then success: one answer, the partial text gone.
      assert.equal(result.recovered.steps, 3, report);
      assert.lengthOf(result.recovered.retries, 2, report);
      assert.equal(result.recovered.chatText, "The finding holds.", report);
      assert.equal(result.recovered.stopRule, "final_answer", report);
      // The real Anthropic adapter: a broken stream is sent again.
      assert.equal(result.anthropic.calls, 2, report);
      assert.equal(result.anthropic.chatText, "Whole answer.", report);
      assert.equal(result.anthropic.stopRule, "final_answer", report);
      // Three failures: the turn stops interrupted, saying "continue".
      assert.equal(result.lost.steps, 3, report);
      assert.equal(result.lost.stopRule, "connection_lost", report);
      assert.equal(result.lost.runStatus, "failed", report);
      assert.equal(result.lost.end, "interrupted", report);
      assert.include(result.lost.chatText, "continue", report);
      // "continue" picks it up with a resume note.
      assert.isTrue(result.resumeNoteSeen, report);
      assert.equal(result.resumed.stopRule, "final_answer", report);
      assert.equal(result.resumed.chatText, "The method, continued.");
    });
  });

  it("7. a long job that keeps settling papers runs past every per-turn limit, its clock included", async function () {
    const libraryID = Zotero.Libraries.userLibraryID;
    const folder = new Zotero.Collection();
    (folder as { libraryID: number }).libraryID = libraryID;
    folder.name = `Stop rules job ${Date.now()}`;
    await folder.saveTx();
    const papers: Zotero.Item[] = [];
    try {
      for (let index = 1; index <= 8; index += 1) {
        const paper = new Zotero.Item("journalArticle");
        paper.libraryID = libraryID;
        paper.setField("title", `Stop rules job paper ${index}`);
        paper.setCollections([folder.id]);
        await paper.saveTx();
        papers.push(paper);
      }
      await withPanel(async (panelId) => {
        const result = (await scenario(panelId, "long_job_clock", {
          collection: { collectionId: folder.id, name: folder.name, libraryID },
          papers: papers.map((paper) => ({
            itemId: paper.id,
            title: String(paper.getField("title")),
          })),
        })) as any;
        const report = JSON.stringify({
          steady: { ...result.steady, prompts: undefined },
          stalled: { ...result.stalled, prompts: undefined },
        });
        // Ten requests and 100 minutes, past both the 4-call limit set for
        // this test and the 30-minute clock: never budget_reached.
        assert.equal(result.steady.steps, papers.length + 2, report);
        assert.isAbove(result.steadyElapsedMinutes, 30, report);
        assert.equal(result.steady.stopRule, "final_answer", report);
        assert.equal(result.steady.runStatus, "completed", report);
        // The same job that stops settling papers pauses at 30 minutes.
        assert.equal(result.stalled.stopRule, "budget_reached", report);
        assert.equal(result.stalled.end, "interrupted", report);
        assert.include(result.stalled.chatText, "continue", report);
        assert.isAtMost(result.stalled.steps, 5, report);
      });
    } finally {
      for (const paper of papers) await paper.eraseTx().catch(() => undefined);
      await folder.eraseTx().catch(() => undefined);
    }
  });

  it("8. final_only over an Anthropic tool history keeps the tools and sets tool_choice none", async function () {
    await withPanel(async (panelId) => {
      const result = (await scenario(panelId, "anthropic_final_only")) as any;
      const report = JSON.stringify({
        ...result,
        turn: { ...result.turn, prompts: undefined },
      });
      assert.deepEqual(result.lastToolChoice, { type: "none" }, report);
      assert.include(result.lastToolNames, "library_search", report);
      assert.isTrue(result.lastHasToolUse, report);
      assert.isTrue(result.lastHasToolResult, report);
      // The final-only instruction is the last message, right after the
      // user message that carries the tool results.
      assert.equal(result.finalMessageRole, "user", report);
      assert.include(
        result.finalMessageText,
        "Answer now, without calling any tool",
        report,
      );
      assert.equal(result.beforeFinalRole, "user", report);
      assert.include(result.beforeFinalTypes, "tool_result", report);
      assert.isTrue(
        result.earlierToolChoices.every((choice: string) => choice === "auto"),
        report,
      );
      assert.equal(result.requests, 2 * W + 1, report);
      assert.equal(result.turn.stopRule, "search_exhausted", report);
      assert.include(result.turn.chatText, "Not confirmed", report);
    });
  });

  /** A turn record without its long prompt texts, for an assertion report. */
  const brief = (turn: any) => ({ ...turn, prompts: undefined });

  it("9. a runaway of one call, or 1.4 calls, a round still ends with an answer written without tools", async function () {
    await withPanel(async (panelId) => {
      const result = (await scenario(panelId, "runaway_few_calls")) as any;
      for (const turn of [result.one, result.mixed]) {
        const report = JSON.stringify(brief(turn));
        assert.deepEqual(
          turn.boundaries.map((entry: any) => entry.action),
          ["checkpoint", "final_only"],
          report,
        );
        assert.equal(turn.stopRule, "search_exhausted", report);
        assert.equal(turn.end, "completed_with_exceptions", report);
        assert.include(turn.chatText, "Not confirmed", report);
      }
      assert.equal(result.one.boundaries[0].round, 18);
      assert.equal(result.one.boundaries[1].round, 36);
    });
  });

  it("10. one checkpoint per turn: reading a lookalike after it, then searching again, leads to the answer without tools", async function () {
    await withPanel(async (panelId) => {
      const result = (await scenario(
        panelId,
        "checkpoint_then_lookalike",
      )) as any;
      const report = JSON.stringify(brief(result.turn));
      assert.deepEqual(
        result.turn.boundaries.map((entry: any) => [entry.action, entry.round]),
        [
          ["checkpoint", W],
          ["final_only", 2 * W + 1],
        ],
        report,
      );
      assert.equal(result.turn.rounds[W].kind, "progress", report);
      assert.equal(result.turn.stopRule, "search_exhausted", report);
    });
  });

  it("11. a final-only step that still calls tools is refused once, then the host answers from its record", async function () {
    await withPanel(async (panelId) => {
      const result = (await scenario(panelId, "final_only_refusal")) as any;
      const stubborn = JSON.stringify(brief(result.stubborn));
      assert.isTrue(result.stubbornRefusalSeen, stubborn);
      assert.equal(result.stubborn.steps, 2 * W + 2, stubborn);
      assert.equal(result.stubborn.stopRule, "search_exhausted", stubborn);
      assert.include(
        result.stubborn.chatText,
        "I could not confirm the paper",
        stubborn,
      );
      const relenting = JSON.stringify(brief(result.relenting));
      assert.equal(result.relenting.stopRule, "search_exhausted", relenting);
      assert.include(result.relenting.chatText, "Not confirmed", relenting);
    });
  });

  it("12. a provider that rejects tool_choice none with HTTP 400 gets the step again with its default choice", async function () {
    await withPanel(async (panelId) => {
      const result = (await scenario(panelId, "tool_choice_rejected")) as any;
      const report = JSON.stringify(brief(result.turn));
      assert.deepEqual(
        result.turn.toolChoices.slice(-2),
        ["none", undefined],
        report,
      );
      assert.include(
        result.turn.retries.map((entry: any) => entry.action),
        "tool_choice_default",
        report,
      );
      assert.equal(result.turn.stopRule, "search_exhausted", report);
      assert.include(result.turn.chatText, "Not confirmed", report);
    });
  });

  it("13. a final-only 'not in your library' answer is accepted as written, without a send-back", async function () {
    await withPanel(async (panelId) => {
      const result = (await scenario(panelId, "final_only_absence")) as any;
      const report = JSON.stringify(brief(result.turn));
      assert.equal(result.finalOnlyRequests, 1, report);
      assert.equal(result.turn.toolChoices.at(-1), "none", report);
      assert.equal(result.turn.stopRule, "search_exhausted", report);
      assert.include(result.turn.chatText, "not in your library", report);
    });
  });

  it("14. a prompt the provider calls too long is compacted once; too long again, the turn stops resumable", async function () {
    await withPanel(async (panelId) => {
      const result = (await scenario(panelId, "prompt_too_long")) as any;
      const report = JSON.stringify({
        compacted: brief(result.compacted),
        exceeded: brief(result.exceeded),
      });
      assert.equal(result.compacted.steps, 2, report);
      assert.deepEqual(
        result.compacted.retries.map((entry: any) => entry.action),
        ["compact"],
        report,
      );
      assert.equal(result.compacted.stopRule, "final_answer", report);
      assert.equal(result.compacted.chatText, "The summary.", report);
      assert.equal(result.exceeded.steps, 2, report);
      assert.equal(result.exceeded.stopRule, "prompt_budget_exceeded", report);
      assert.equal(result.exceeded.end, "interrupted", report);
      assert.include(result.exceeded.chatText, "start a new chat", report);
    });
  });

  it("15. Stop during a retry wait ends the turn at once", async function () {
    await withPanel(async (panelId) => {
      const result = (await scenario(panelId, "abort_during_backoff")) as any;
      const report = JSON.stringify({ ...result, turn: brief(result.turn) });
      assert.equal(result.turn.steps, 1, report);
      assert.equal(result.turn.stopRule, "cancelled_in_flight", report);
      assert.equal(result.turn.runStatus, "cancelled", report);
      assert.isBelow(result.elapsedMs, 20_000, report);
    });
  });

  it("16. a long job stopped mid-page by its safety limit resumes on 'continue' with no paper noted twice", async function () {
    const libraryID = Zotero.Libraries.userLibraryID;
    const folder = new Zotero.Collection();
    (folder as { libraryID: number }).libraryID = libraryID;
    folder.name = `Stop rules note job ${Date.now()}`;
    await folder.saveTx();
    const papers: Zotero.Item[] = [];
    try {
      for (let index = 1; index <= 20; index += 1) {
        const paper = new Zotero.Item("journalArticle");
        paper.libraryID = libraryID;
        paper.setField("title", `Stop rules note paper ${index}`);
        paper.setCollections([folder.id]);
        await paper.saveTx();
        papers.push(paper);
      }
      await withPanel(async (panelId) => {
        const result = (await scenario(panelId, "long_job_budget_resume", {
          collection: { collectionId: folder.id, name: folder.name, libraryID },
          papers: papers.map((paper) => ({
            itemId: paper.id,
            title: String(paper.getField("title")),
          })),
        })) as any;
        const report = JSON.stringify(result);
        assert.equal(result.first.stopRule, "budget_reached", report);
        assert.equal(result.first.end, "interrupted", report);
        assert.isAbove(result.first.read, result.first.noted.length, report);
        assert.include(
          result.second.resumeNote,
          "papers left, in order",
          report,
        );
        assert.equal(result.second.runStatus, "completed", report);
        for (const paper of papers)
          assert.equal(
            result.notesPerPaper[paper.id],
            1,
            `paper ${paper.id}: ${report}`,
          );
      });
    } finally {
      for (const paper of papers) {
        for (const noteId of paper.getNotes())
          await Zotero.Items.get(noteId)
            ?.eraseTx()
            .catch(() => undefined);
        await paper.eraseTx().catch(() => undefined);
      }
      await folder.eraseTx().catch(() => undefined);
    }
  });

  it("17. a final-only reply with thinking and no text is asked once more, then the host answers; never an empty answer", async function () {
    await withPanel(async (panelId) => {
      const result = (await scenario(panelId, "final_only_empty")) as any;
      const silent = JSON.stringify(brief(result.silent));
      assert.equal(result.silent.steps, 2 * W + 2, silent);
      assert.equal(result.silent.stopRule, "search_exhausted", silent);
      assert.include(
        result.silent.chatText,
        "I could not confirm the paper",
        silent,
      );
      const recovering = JSON.stringify(brief(result.recovering));
      assert.equal(result.recovering.steps, 2 * W + 2, recovering);
      assert.equal(result.recovering.stopRule, "search_exhausted", recovering);
      assert.include(result.recovering.chatText, "Not confirmed", recovering);
    });
  });

  it("18. twenty read-only scripts with new results get no checkpoint; twenty with the same result still reach it", async function () {
    await withPanel(async (panelId) => {
      const result = (await scenario(panelId, "scripted_analysis")) as any;
      const distinct = JSON.stringify(brief(result.distinct));
      assert.equal(result.distinct.steps, 21, distinct);
      assert.deepEqual(result.distinct.boundaries, [], distinct);
      assert.isTrue(
        result.distinct.rounds
          .filter((round: any) => round.kind !== "no_tools")
          .every((round: any) => round.kind === "progress"),
        distinct,
      );
      assert.equal(result.distinct.stopRule, "final_answer", distinct);
      assert.equal(result.distinct.runStatus, "completed", distinct);
      const repeated = JSON.stringify(brief(result.repeated));
      // The first result is new; the 18 navigation rounds after it fill the
      // window (W rounds, S = 18 calls) at round 19.
      assert.deepEqual(
        result.repeated.boundaries.map((entry: any) => [
          entry.action,
          entry.round,
        ]),
        [["checkpoint", 19]],
        repeated,
      );
    });
  });

  it("19. a step past its tool-call limit runs the first eight, a write among them, and not the ninth; the next step makes it", async function () {
    await withPanel(async (panelId, paper) => {
      const result = (await scenario(panelId, "step_past_tool_limit")) as any;
      const report = JSON.stringify({ ...result, turn: brief(result.turn) });
      assert.include(result.tagsAfterFirstStep, result.withinTag, report);
      assert.notInclude(result.tagsAfterFirstStep, result.pastTag, report);
      assert.equal(
        result.pastResult,
        JSON.stringify({
          error:
            "Not run: this step allows 8 tool calls; call it again in the next step.",
        }),
        report,
      );
      assert.equal(result.turn.steps, 3, report);
      assert.equal(result.turn.stopRule, "final_answer", report);
      assert.equal(result.turn.runStatus, "completed", report);
      // Native readback, independent of the turn's record.
      const reread = (await Zotero.Items.getAsync(paper.id)) as Zotero.Item;
      await reread.reload(undefined as never, true);
      const tags = reread.getTags().map((entry) => entry.tag);
      assert.includeMembers(tags, [result.withinTag, result.pastTag], report);
    });
  });
});
