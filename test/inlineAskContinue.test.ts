import { assert } from "chai";
import { describe, it } from "mocha";
import {
  buildInlineAskContinueInput,
  createInlineAskContinueInSidebar,
  inlineAskContinueFailureText,
} from "../src/modules/contextPanel/selectionPrompt/inlineAskContinue";
import type { InlineAskPopupSnapshot } from "../src/modules/contextPanel/selectionPrompt/inlineAskSnapshot";
import type {
  SeedPaperConversationInput,
  SeedPaperConversationResult,
} from "../src/modules/contextPanel/seededConversation";

const snapshot: InlineAskPopupSnapshot = {
  annotation: null,
  readerItemId: 41,
  paperContext: { itemId: 40, contextItemId: 41, title: "Drift paper" },
  selectedText: "A familiar stimulus drifts.",
  pageIndex: 3,
  pageLabel: "4",
};
const turns = [
  { role: "user" as const, text: "Explain this passage fully." },
  { role: "assistant" as const, text: "It drifts." },
];
const model = { name: "model-x", entryId: "entry-x", providerLabel: "X" };

describe("Inline Ask continue in sidebar request", function () {
  it("puts the selection, the turns and the model into the panel request", function () {
    assert.deepEqual(buildInlineAskContinueInput(snapshot, model, turns), {
      paperItemId: 40,
      selectedTextContext: {
        text: "A familiar stimulus drifts.",
        source: "pdf",
        contextItemId: 41,
        pageIndex: 3,
        pageLabel: "4",
        paperContext: { itemId: 40, contextItemId: 41, title: "Drift paper" },
      },
      turns,
      model,
    });
  });

  it("leaves out what the snapshot does not know", function () {
    const input = buildInlineAskContinueInput(
      {
        ...snapshot,
        paperContext: null,
        pageIndex: null,
        pageLabel: undefined,
      },
      null,
      turns,
    );
    assert.deepEqual(input.selectedTextContext, {
      text: "A familiar stimulus drifts.",
      source: "pdf",
      contextItemId: 41,
    });
    assert.isUndefined(input.paperItemId);
    assert.isUndefined(input.model);
  });

  it("says why the sidebar did not take the conversation", function () {
    assert.equal(
      inlineAskContinueFailureText("busy"),
      "The sidebar is answering. Try again when it finishes.",
    );
    assert.equal(
      inlineAskContinueFailureText("unreachable"),
      "The sidebar chat for this PDF is not available. Open it and try again.",
    );
    assert.equal(
      inlineAskContinueFailureText("unavailable"),
      inlineAskContinueFailureText("unreachable"),
    );
    assert.equal(
      inlineAskContinueFailureText("webchat"),
      "Continue in sidebar does not work in WebChat mode.",
    );
    assert.equal(
      inlineAskContinueFailureText("failed"),
      "The conversation could not be saved to the sidebar.",
    );
  });

  it("maps the panel's answer to the card's result", async function () {
    const requests: SeedPaperConversationInput[] = [];
    let answer: SeedPaperConversationResult | null = {
      ok: true,
      conversationKey: 7,
      handover: false,
    };
    const run = createInlineAskContinueInSidebar({
      snapshot,
      getModel: () => model,
      reachPanel: async (input) => {
        requests.push(input);
        return answer;
      },
    });
    assert.deepEqual(await run(turns), { ok: true });
    assert.deepEqual(requests[0].turns, turns);
    answer = { ok: false, reason: "busy" };
    assert.deepEqual(await run(turns), {
      ok: false,
      error: "The sidebar is answering. Try again when it finishes.",
    });
    // No panel could be reached.
    answer = null;
    assert.deepEqual(await run(turns), {
      ok: false,
      error:
        "The sidebar chat for this PDF is not available. Open it and try again.",
    });
  });
});
