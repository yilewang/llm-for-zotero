import { assert } from "chai";
import { createQueryLibraryTool } from "../src/agent/tools/read/queryLibrary";
import { createFileIOTool } from "../src/agent/tools/write/fileIO";
import type { AgentToolContext } from "../src/agent/types";

const baseContext: AgentToolContext = {
  request: {
    conversationKey: 77_001,
    mode: "agent",
    userText: "test tool validation",
    libraryID: 1,
  },
  item: null,
  currentAnswerText: "",
  modelName: "gpt-5.4",
};

describe("tool validation compatibility", function () {
  it("normalizes canonical and legacy query_library shapes", function () {
    const tool = createQueryLibraryTool({} as never);

    const itemSearch = tool.validate({
      entity: "items",
      mode: "search",
      text: "computational psychiatry",
    });
    assert.isTrue(itemSearch.ok);
    if (!itemSearch.ok) return;
    assert.equal(itemSearch.value.entity, "items");
    assert.equal(itemSearch.value.mode, "search");
    assert.equal(itemSearch.value.text, "computational psychiatry");

    const collectionTree = tool.validate({
      entity: "collections",
      mode: "list",
      view: "tree",
    });
    assert.isTrue(collectionTree.ok);
    if (!collectionTree.ok) return;
    assert.equal(collectionTree.value.entity, "collections");
    assert.equal(collectionTree.value.mode, "list");
    assert.equal(collectionTree.value.view, "tree");

    const tagList = tool.validate({ entity: "tags", mode: "list" });
    assert.isTrue(tagList.ok);
    if (!tagList.ok) return;
    assert.equal(tagList.value.entity, "tags");
    assert.equal(tagList.value.mode, "list");

    const duplicates = tool.validate({
      entity: "items",
      mode: "duplicates",
    });
    assert.isTrue(duplicates.ok);
    if (!duplicates.ok) return;
    assert.equal(duplicates.value.entity, "items");
    assert.equal(duplicates.value.mode, "duplicates");

    const legacyTopic = tool.validate({ query: "hippocampus" });
    assert.isTrue(legacyTopic.ok);
    if (!legacyTopic.ok) return;
    assert.equal(legacyTopic.value.entity, "items");
    assert.equal(legacyTopic.value.mode, "search");
    assert.equal(legacyTopic.value.text, "hippocampus");

    const legacyQueryMode = tool.validate({
      mode: "query",
      query: "hippocampus",
    });
    assert.isTrue(legacyQueryMode.ok);
    if (!legacyQueryMode.ok) return;
    assert.equal(legacyQueryMode.value.entity, "items");
    assert.equal(legacyQueryMode.value.mode, "search");
    assert.equal(legacyQueryMode.value.text, "hippocampus");

    const legacyTextQueryMode = tool.validate({
      mode: "query",
      text: "computational psychiatry",
    });
    assert.isTrue(legacyTextQueryMode.ok);
    if (!legacyTextQueryMode.ok) return;
    assert.equal(legacyTextQueryMode.value.entity, "items");
    assert.equal(legacyTextQueryMode.value.mode, "search");
    assert.equal(legacyTextQueryMode.value.text, "computational psychiatry");

    const topLevelCollectionId = tool.validate({
      entity: "items",
      mode: "list",
      collectionId: 4,
    });
    assert.isTrue(topLevelCollectionId.ok);
    if (!topLevelCollectionId.ok) return;
    assert.equal(topLevelCollectionId.value.entity, "items");
    assert.equal(topLevelCollectionId.value.mode, "list");
    assert.equal(topLevelCollectionId.value.filters?.collectionId, 4);

    const listCollectionIdWithoutEntity = tool.validate({
      mode: "list",
      collectionId: 4,
    });
    assert.isTrue(listCollectionIdWithoutEntity.ok);
    if (!listCollectionIdWithoutEntity.ok) return;
    assert.equal(listCollectionIdWithoutEntity.value.entity, "items");
    assert.equal(listCollectionIdWithoutEntity.value.mode, "list");
    assert.equal(listCollectionIdWithoutEntity.value.filters?.collectionId, 4);

    const legacyDuplicates = tool.validate({ mode: "duplicates" });
    assert.isTrue(legacyDuplicates.ok);
    if (!legacyDuplicates.ok) return;
    assert.equal(legacyDuplicates.value.entity, "items");
    assert.equal(legacyDuplicates.value.mode, "duplicates");

    const legacyCollectionTree = tool.validate({
      entity: "collections",
      view: "tree",
    });
    assert.isTrue(legacyCollectionTree.ok);
    if (!legacyCollectionTree.ok) return;
    assert.equal(legacyCollectionTree.value.entity, "collections");
    assert.equal(legacyCollectionTree.value.mode, "list");
    assert.equal(legacyCollectionTree.value.view, "tree");
  });

  it("keeps query_library validation strict outside known legacy shapes", function () {
    const tool = createQueryLibraryTool({} as never);

    const missingSearchText = tool.validate({
      entity: "items",
      mode: "search",
    });
    assert.isFalse(missingSearchText.ok);
    if (!missingSearchText.ok) {
      assert.include(missingSearchText.error, "text is required");
    }

    const badCollectionMode = tool.validate({
      entity: "collections",
      mode: "duplicates",
    });
    assert.isFalse(badCollectionMode.ok);
    if (!badCollectionMode.ok) {
      assert.include(badCollectionMode.error, "collections only support");
    }

    const missingShape = tool.validate({});
    assert.isFalse(missingShape.ok);
    if (!missingShape.ok) {
      assert.include(missingShape.error, "entity and mode are required");
      assert.include(missingShape.error, "{ entity:'items', mode:'search'");
    }
  });

  it("normalizes file_io canonical and deprecated alias shapes", async function () {
    const tool = createFileIOTool();

    const read = tool.validate({
      action: "read",
      filePath: "/tmp/source.md",
    });
    assert.isTrue(read.ok);
    if (!read.ok) return;
    assert.equal(read.value.action, "read");
    assert.equal(read.value.filePath, "/tmp/source.md");
    assert.isFalse(
      await tool.shouldRequireConfirmation?.(read.value, baseContext),
    );

    const write = tool.validate({
      action: "write",
      filePath: "/tmp/output.md",
      content: "saved",
    });
    assert.isTrue(write.ok);
    if (!write.ok) return;
    assert.equal(write.value.action, "write");
    assert.isTrue(
      await tool.shouldRequireConfirmation?.(write.value, baseContext),
    );

    const pathAlias = tool.validate({
      action: "read",
      path: "/tmp/from-path.md",
    });
    assert.isTrue(pathAlias.ok);
    if (!pathAlias.ok) return;
    assert.equal(pathAlias.value.filePath, "/tmp/from-path.md");

    const modeAlias = tool.validate({
      mode: "write",
      path: "/tmp/from-mode.md",
      content: "saved",
    });
    assert.isTrue(modeAlias.ok);
    if (!modeAlias.ok) return;
    assert.equal(modeAlias.value.action, "write");
    assert.equal(modeAlias.value.filePath, "/tmp/from-mode.md");
    assert.isTrue(
      await tool.shouldRequireConfirmation?.(modeAlias.value, baseContext),
    );

    const missingAction = tool.validate({
      filePath: "/tmp/no-action.md",
    });
    assert.isFalse(missingAction.ok);
  });
});
