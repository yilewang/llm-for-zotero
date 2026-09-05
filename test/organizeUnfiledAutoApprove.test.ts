import { assert } from "chai";
import { organizeUnfiledAction } from "../src/agent/actions/organizeUnfiled";
import type { ActionExecutionContext } from "../src/agent/actions";
import { AgentToolRegistry } from "../src/agent/tools/registry";

/**
 * Under `auto_approve` there is no human to fill in a blank row, so an item
 * the model could not confidently place is dropped from the assignment list.
 * That is correct — but it used to happen silently, so an unattended run
 * reported success while quietly leaving items unfiled.
 */
describe("organize_unfiled under auto_approve", function () {
  function makeTarget(itemId: number) {
    return {
      itemId,
      itemType: "journalArticle",
      title: `Paper ${itemId}`,
      firstCreator: "Alice Example",
      year: "2024",
      attachments: [],
      tags: [],
      collectionIds: [],
    };
  }

  function createContext(overrides: Partial<ActionExecutionContext> = {}) {
    const progress: Array<{ type: string; summary?: string }> = [];
    const registry = new AgentToolRegistry();
    const ctx: ActionExecutionContext = {
      registry,
      zoteroGateway: {
        invalidateLibrarySearchCache: () => undefined,
        listUnfiledItemTargets: async () => ({
          items: [makeTarget(1), makeTarget(2)],
          totalCount: 2,
        }),
        listCollectionSummaries: () => [
          { collectionId: 10, name: "Neuro", path: "Neuro" },
        ],
        getItem: (itemId: number) => ({ id: itemId }),
        getEditableArticleMetadata: () => ({
          fields: { abstractNote: "An abstract" },
        }),
      } as never,
      libraryID: 1,
      confirmationMode: "auto_approve",
      onProgress: (event) => progress.push(event as never),
      requestConfirmation: async () => ({ approved: true }),
      // No `llm`, so nothing gets a confident suggestion and every item is
      // unmatched — the exact case that used to vanish without a word.
      ...overrides,
    };
    return { ctx, progress };
  }

  it("reports the items it skipped instead of dropping them silently", async function () {
    const { ctx, progress } = createContext();

    const result = await organizeUnfiledAction.execute({ pageSize: 5 }, ctx);

    assert.isTrue(result.ok);
    const skipped = (result.output as { skippedUnmatched?: number } | undefined)
      ?.skippedUnmatched;
    assert.equal(skipped, 2, "both unmatched items must be accounted for");

    const mentionedSkip = progress.some((event) =>
      /skipped 2 items/i.test(event.summary || ""),
    );
    assert.isTrue(
      mentionedSkip,
      `expected a progress event naming the skipped items, got: ${JSON.stringify(progress)}`,
    );
  });
});
