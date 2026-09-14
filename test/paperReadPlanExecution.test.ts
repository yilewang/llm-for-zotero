import { assert } from "chai";
import { createPaperReadTool } from "../src/agent/tools/read/paperRead";
import type { AgentToolContext } from "../src/agent/types";
import { classifiedFixture } from "./helpers/semanticIntent";

describe("paper_read inside an approved research plan", function () {
  const paper = {
    libraryID: 1,
    itemId: 51,
    contextItemId: 52,
    title: "Manifest paper",
  };
  function tool() {
    return createPaperReadTool(
      {
        getOverviewExcerpt: async ({
          paperContext,
        }: {
          paperContext: unknown;
        }) => ({
          backend: "raw_pdf_text",
          text: "Full body text of the manifest paper.",
          chunkIndexes: [0],
          totalChunks: 1,
          paperContext,
        }),
      } as never,
      {} as never,
      {} as never,
      {
        listPaperContexts: () => [],
        resolvePaperContextTarget: (target: { itemId?: number }) =>
          target.itemId === paper.itemId ? paper : null,
      } as never,
    );
  }
  const context = (planExecuting: boolean): AgentToolContext => ({
    request: {
      classifiedIntent: classifiedFixture(),
      conversationKey: 77,
      mode: "agent",
      conversationKind: "global",
      userText: "Execute the approved plan",
      libraryID: 1,
      ...(planExecuting
        ? {
            planContext: {
              phase: "executing",
              planId: "plan",
              revision: 1,
              executionId: "execution",
              approvedDigest: "sha256:plan",
              provider: "original",
            },
          }
        : {}),
    } as never,
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
  });

  it("serves an explicit full read of manifest targets as overview with a note", async function () {
    const validated = tool().validate({
      mode: "full",
      targets: [{ itemId: 51, contextItemId: 52 }],
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    const output = (await tool().execute(validated.value, context(true))) as {
      mode: string;
      readingNote?: string;
      results: Array<{ text: string }>;
    };
    assert.equal(output.mode, "overview");
    assert.match(output.readingNote || "", /served as 'overview'/);
    assert.equal(
      output.results[0].text,
      "Full body text of the manifest paper.",
    );
  });

  it("keeps full-read authority checks outside plan execution", async function () {
    const validated = tool().validate({
      mode: "full",
      targets: [{ itemId: 51, contextItemId: 52 }],
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    let error = "";
    try {
      await tool().execute(validated.value, context(false));
    } catch (caught) {
      error = String(caught);
    }
    assert.match(error, /Exhaustive reading requires/);
  });
});
