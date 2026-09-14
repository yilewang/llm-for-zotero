import { semanticFixture } from "./helpers/semanticIntent";
import { assert } from "chai";
import {
  findLibraryRetrieveShallowSignal,
  isEvidenceSeekingTurn,
  transcriptShowsEvidenceReads,
} from "../src/agent/model/libraryAnswerGuard";

describe("libraryAnswerGuard", function () {
  describe("isEvidenceSeekingTurn", function () {
    it("does not derive evidence intent from request wording", function () {
      for (const userText of [
        "Which papers use calcium imaging?",
        "这些论文用了什么方法",
        "총 요약해줘",
      ])
        assert.isFalse(isEvidenceSeekingTurn({ userText }));
    });

    it("treats pure operations as non-evidence turns", function () {
      assert.isFalse(
        isEvidenceSeekingTurn({ userText: "tag every item with drift-2024" }),
      );
      assert.isFalse(isEvidenceSeekingTurn({ userText: "" }));
    });

    it("uses the shared semantic retrieval intent", function () {
      assert.isFalse(
        isEvidenceSeekingTurn({
          userText: "Which papers use calcium imaging?",
          classifiedIntent: {
            semantic: semanticFixture(),
            retrievalIntent: "none",
            wantedSections: [],
          },
        }),
      );
      assert.isTrue(
        isEvidenceSeekingTurn({
          userText: "move these",
          classifiedIntent: {
            semantic: semanticFixture(),
            retrievalIntent: "enumerate",
            wantedSections: [],
          },
        }),
      );
    });
  });

  describe("findLibraryRetrieveShallowSignal", function () {
    it("reports no signal for an empty record list", function () {
      assert.deepEqual(findLibraryRetrieveShallowSignal([]), {
        ranRetrieveFamily: false,
        lastRetrieveShallow: false,
      });
    });

    it("counts successful retrieve-family tools and ignores failures", function () {
      const signal = findLibraryRetrieveShallowSignal([
        { name: "library_search", ok: true },
        { name: "library_retrieve", ok: false },
      ]);

      assert.isTrue(signal.ranRetrieveFamily);
      assert.isFalse(signal.lastRetrieveShallow);
    });

    it("flags the last retrieve as shallow when body coverage is zero with readable papers", function () {
      const signal = findLibraryRetrieveShallowSignal([
        {
          name: "library_retrieve",
          ok: true,
          content: {
            answerContract: { papersBodyRead: 0, papersPlanned: 5 },
            resourcePool: { states: { textAvailable: 5 } },
          },
        },
      ]);

      assert.isTrue(signal.lastRetrieveShallow);
    });

    it("does not flag body-covered retrieves", function () {
      const signal = findLibraryRetrieveShallowSignal([
        {
          name: "library_retrieve",
          ok: true,
          content: {
            answerContract: { papersBodyRead: 3, papersPlanned: 5 },
            resourcePool: { states: { textAvailable: 5 } },
          },
        },
      ]);

      assert.isFalse(signal.lastRetrieveShallow);
    });
  });
});

describe("guard false-positive fixes", function () {
  it("counts library_read and literature_search as evidence-read tools", function () {
    const signal = findLibraryRetrieveShallowSignal([
      { name: "library_read", ok: true },
    ]);
    assert.isTrue(signal.ranRetrieveFamily);

    const literature = findLibraryRetrieveShallowSignal([
      { name: "literature_search", ok: true },
    ]);
    assert.isTrue(literature.ranRetrieveFamily);
  });

  it("detects prior evidence reads in the raw transcript", function () {
    assert.isTrue(
      transcriptShowsEvidenceReads([
        {
          role: "tool",
          name: "library_retrieve",
          tool_call_id: "c1",
          content: "{}",
        },
      ] as any),
    );
    assert.isFalse(
      transcriptShowsEvidenceReads([
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ] as any),
    );
  });

  it("detects evidence reads in a compacted checkpoint summary", function () {
    assert.isTrue(
      transcriptShowsEvidenceReads([
        {
          role: "user",
          content:
            "Agent transcript compact checkpoint:\nEarlier tools used: library_retrieve x3, paper_read",
        },
      ] as any),
    );
  });

  it("detects a prior shallow correction to avoid repeating it", function () {
    assert.isTrue(
      transcriptShowsEvidenceReads([
        {
          role: "user",
          content:
            "Correction for this turn: the question targets the selected collection/tag scope and needs library evidence.",
        },
      ] as any),
    );
  });
});
