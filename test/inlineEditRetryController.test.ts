import { assert } from "chai";
import {
  getInlineEditPrefillText,
  isMessageTextDerivedFromChipQuestions,
} from "../src/modules/contextPanel/chat";
import {
  buildInlineEditRetryContextSnapshot,
  resolveInlineEditSubmitText,
} from "../src/modules/contextPanel/setupHandlers/controllers/inlineEditRetryController";
import type {
  AttachedConversationRef,
  CollectionContextRef,
  PaperContextRef,
  SelectedTextContext,
  TagContextRef,
} from "../src/modules/contextPanel/types";

describe("inlineEditRetryController", function () {
  it("carries selected collection and tag contexts through inline edit retry", function () {
    const paperContext: PaperContextRef = {
      itemId: 12,
      contextItemId: 34,
      title: "Pinned paper",
    };
    const selectedContexts: SelectedTextContext[] = [
      {
        text: "quoted passage",
        source: "pdf",
        paperContext,
      },
    ];
    const selectedCollectionContexts: CollectionContextRef[] = [
      {
        collectionId: 55,
        libraryID: 1,
        name: "Computational_Psychiatry",
      },
    ];
    const selectedTagContexts: TagContextRef[] = [
      {
        name: "Stable",
        normalizedName: "stable",
        libraryID: 1,
      },
    ];

    const attachedConversations: AttachedConversationRef[] = [
      {
        system: "codex",
        conversationKey: 9,
        title: "Earlier chat",
        libraryID: 1,
      },
    ];

    const snapshot = buildInlineEditRetryContextSnapshot({
      selectedContexts,
      selectedCollectionContexts,
      selectedTagContexts,
      attachedConversations,
    });

    assert.deepEqual(snapshot.selectedTexts, ["quoted passage"]);
    assert.deepEqual(snapshot.selectedTextPaperContexts, [paperContext]);
    assert.deepEqual(
      snapshot.selectedCollectionContexts,
      selectedCollectionContexts,
    );
    assert.notStrictEqual(
      snapshot.selectedCollectionContexts,
      selectedCollectionContexts,
    );
    assert.deepEqual(snapshot.selectedTagContexts, selectedTagContexts);
    assert.notStrictEqual(snapshot.selectedTagContexts, selectedTagContexts);
    assert.deepEqual(snapshot.attachedConversations, attachedConversations);
    assert.notStrictEqual(
      snapshot.attachedConversations,
      attachedConversations,
    );
  });

  it("passes an empty attached-conversation list when the composer has none", function () {
    const snapshot = buildInlineEditRetryContextSnapshot({});
    assert.deepEqual(snapshot.attachedConversations, []);
  });

  describe("resolveInlineEditSubmitText", function () {
    const questionChips: SelectedTextContext[] = [
      { text: "First quote.", source: "pdf", userQuery: "Is it new?" },
      { text: "Plain quote.", source: "pdf" },
      { text: "Third quote.", source: "model", userQuery: "Why here?" },
    ];

    it("submits the typed composer text unchanged", function () {
      assert.equal(
        resolveInlineEditSubmitText("  Typed edit  ", questionChips),
        "Typed edit",
      );
    });

    it("submits the chip questions when the composer is empty", function () {
      assert.equal(
        resolveInlineEditSubmitText("   ", questionChips),
        "Is it new?\n\nWhy here?",
      );
    });

    it("has nothing to submit with an empty composer and no chip questions", function () {
      assert.equal(resolveInlineEditSubmitText("", []), "");
      assert.equal(resolveInlineEditSubmitText("", undefined), "");
      assert.equal(resolveInlineEditSubmitText("", [questionChips[1]!]), "");
    });

    it("re-sends a question-only turn as a question-only turn", function () {
      // Editing such a turn starts with an empty composer; sending it as is
      // must store the same text, so the bubble keeps its question cards.
      const sent = {
        text: "Is it new?\n\nWhy here?",
        selectedTextContexts: questionChips,
      };
      assert.equal(getInlineEditPrefillText(sent), "");
      const submitted = resolveInlineEditSubmitText(
        getInlineEditPrefillText(sent),
        questionChips,
      );
      assert.isTrue(
        isMessageTextDerivedFromChipQuestions({
          text: submitted,
          selectedTextContexts: questionChips,
        }),
      );
    });
  });
});
