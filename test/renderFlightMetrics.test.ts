import { assert } from "chai";
import { describe, it } from "mocha";

import { summarizeRenderFlight } from "../src/agent/flightMetrics";
import {
  RENDER_TRANSCRIPT_CHARS,
  buildRenderTranscript,
  driveRenderFlight,
  measureRenderFlight,
} from "./helpers/renderFlight";

/**
 * What a streamed answer costs the panel in repaints.
 *
 * The provider delivers an answer as a long run of small deltas. The question
 * this file answers is how many times the bubble is repainted for those
 * deltas: once per delta would be hundreds of repaints for one answer, and the
 * block coalescer exists so that it is instead once per readable block.
 *
 * The same fixed 2,000-character transcript is pushed at three delta sizes, so
 * the numbers say what the cost is per thousand characters of answer rather
 * than per provider chunk -- a provider that switches from 1-character to
 * 128-character deltas must not change how often the panel paints.
 */

describe("render flight metrics", function () {
  describe("the transcript", function () {
    it("is the same 2,000 characters every run, with paragraph breaks to release on", function () {
      const transcript = buildRenderTranscript();

      assert.equal(transcript.length, RENDER_TRANSCRIPT_CHARS);
      assert.equal(transcript, buildRenderTranscript());
      assert.isAbove(
        transcript.split("\n\n").length - 1,
        1,
        "the transcript must contain block boundaries, or it would only ever be released by the hard cap",
      );
    });
  });

  describe("repaints per streamed character", function () {
    it("paints once per released block, never twice", function () {
      for (const run of measureRenderFlight())
        assert.equal(
          run.refreshesScheduled,
          run.blocksReleased,
          `${run.id} scheduled a repaint for something other than a released block`,
        );
    });

    it("collapses a per-character stream into a handful of repaints", function () {
      const runs = measureRenderFlight();
      const perCharacter = runs.find(
        (run) => run.deltaChars === 1 && !run.stallTimerFires,
      );

      assert.isDefined(perCharacter, "the per-character run is measured");
      assert.equal(perCharacter!.deltas, 2000, "one delta per character");
      assert.isBelow(
        perCharacter!.refreshesScheduled,
        10,
        "two thousand deltas must not cost anything like two thousand repaints",
      );
      for (const run of runs) {
        if (run.stallTimerFires) continue;
        assert.isAtMost(
          run.refreshesScheduled,
          run.deltas,
          `${run.id} painted more often than the provider pushed`,
        );
      }
    });

    it("keeps the repaint rate in one narrow band whatever size the deltas are", function () {
      const samples = Object.values(
        summarizeRenderFlight(measureRenderFlight()),
      ).filter((sample) => !sample.stallTimerFires);
      const rates = samples.map((sample) => sample.refreshesPerKChar);

      assert.equal(samples.length, 3, "three delta sizes are measured");
      for (const rate of rates)
        assert.isBelow(
          rate,
          5,
          "a thousand characters of answer must cost a handful of repaints, not dozens",
        );
      assert.isBelow(
        Math.max(...rates) - Math.min(...rates),
        2,
        "the answer's own paragraph structure sets the repaint cost; the provider's chunk size must barely move it",
      );
    });

    it("delivers the whole transcript at every delta size", function () {
      const transcript = buildRenderTranscript();
      for (const deltaChars of [1, 16, 128]) {
        const driven = driveRenderFlight({
          id: `delta${deltaChars}`,
          deltaChars,
        });
        assert.equal(
          driven.text,
          transcript,
          `delta size ${deltaChars} lost or reordered text`,
        );
      }
    });
  });

  describe("the stalled worst case", function () {
    it("costs more repaints than the same stream without stalls", function () {
      const steady = driveRenderFlight({ id: "delta16", deltaChars: 16 });
      const stalled = driveRenderFlight({
        id: "delta16Stalled",
        deltaChars: 16,
        fireStallTimer: true,
      });

      assert.isAbove(
        stalled.run.refreshesScheduled,
        steady.run.refreshesScheduled,
        "a stream that stalls between every delta must be the more expensive case",
      );
      assert.equal(
        stalled.text,
        steady.text,
        "stalling changes when the text is painted, never what it says",
      );
    });

    it("degenerates to one repaint per delta when every delta stalls", function () {
      const stalled = driveRenderFlight({
        id: "delta16Stalled",
        deltaChars: 16,
        fireStallTimer: true,
      });

      assert.equal(
        stalled.run.blocksReleased,
        stalled.run.deltas,
        "a stall after every delta releases every delta as its own block: this is the ceiling the coalescer is measured against",
      );
      assert.deepEqual(
        new Set(stalled.releasedBy),
        new Set(["timer"]),
        "every block in the stalled run is released by the injected stall timer, which a real 450 ms timer could never do inside a synchronous push loop",
      );
    });
  });

  describe("summarizeRenderFlight", function () {
    it("derives repaints per thousand characters from the counts alone", function () {
      const summary = summarizeRenderFlight([
        {
          id: "delta1",
          deltaChars: 1,
          deltas: 2000,
          charsPushed: 2000,
          blocksReleased: 7,
          refreshesScheduled: 7,
          stallTimerFires: false,
        },
      ]);

      assert.deepEqual(summary, {
        delta1: {
          deltaChars: 1,
          deltas: 2000,
          charsPushed: 2000,
          blocksReleased: 7,
          refreshesScheduled: 7,
          refreshesPerKChar: 3.5,
          stallTimerFires: false,
        },
      });
    });

    it("rounds to two decimals rather than reporting a float nobody can pin", function () {
      const summary = summarizeRenderFlight([
        {
          id: "delta16",
          deltaChars: 16,
          deltas: 125,
          charsPushed: 2000,
          blocksReleased: 13,
          refreshesScheduled: 13,
          stallTimerFires: false,
        },
      ]);

      assert.equal(summary.delta16.refreshesPerKChar, 6.5);
    });

    it("reports no repaint rate for a stream that pushed nothing", function () {
      const summary = summarizeRenderFlight([
        {
          id: "empty",
          deltaChars: 16,
          deltas: 0,
          charsPushed: 0,
          blocksReleased: 0,
          refreshesScheduled: 0,
          stallTimerFires: false,
        },
      ]);

      assert.equal(summary.empty.refreshesPerKChar, 0);
    });
  });
});
