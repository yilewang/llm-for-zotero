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

    const createAlias = tool.validate({
      action: "create",
      file_path: "/tmp/create-alias.py",
      text: "print('saved')",
    });
    assert.isTrue(createAlias.ok);
    if (!createAlias.ok) return;
    assert.equal(createAlias.value.action, "write");
    assert.equal(createAlias.value.filePath, "/tmp/create-alias.py");
    assert.equal(createAlias.value.content, "print('saved')");

    const opAlias = tool.validate({
      op: "save_file",
      filepath: "/tmp/save-alias.py",
      contents: "print('saved from op')",
    });
    assert.isTrue(opAlias.ok);
    if (!opAlias.ok) return;
    assert.equal(opAlias.value.action, "write");
    assert.equal(opAlias.value.filePath, "/tmp/save-alias.py");
    assert.equal(opAlias.value.content, "print('saved from op')");

    const operationAlias = tool.validate({
      operation: "read_file",
      file_path: "/tmp/read-alias.md",
    });
    assert.isTrue(operationAlias.ok);
    if (!operationAlias.ok) return;
    assert.equal(operationAlias.value.action, "read");
    assert.equal(operationAlias.value.filePath, "/tmp/read-alias.md");

    const camelCaseWriteAlias = tool.validate({
      action: "writeFile",
      filePath: "/tmp/camel-write.md",
      content: "saved from camelCase",
    });
    assert.isTrue(camelCaseWriteAlias.ok);
    if (!camelCaseWriteAlias.ok) return;
    assert.equal(camelCaseWriteAlias.value.action, "write");
    assert.equal(camelCaseWriteAlias.value.filePath, "/tmp/camel-write.md");
    assert.equal(camelCaseWriteAlias.value.content, "saved from camelCase");

    const quotedReadAlias = tool.validate({
      action: "'read'",
      filePath: "/tmp/quoted-read.md",
    });
    assert.isTrue(quotedReadAlias.ok);
    if (!quotedReadAlias.ok) return;
    assert.equal(quotedReadAlias.value.action, "read");
    assert.equal(quotedReadAlias.value.filePath, "/tmp/quoted-read.md");

    const localizedSaveAlias = tool.validate({
      action: "保存",
      filePath: "/tmp/localized-save.md",
      content: "saved from localized action",
    });
    assert.isTrue(localizedSaveAlias.ok);
    if (!localizedSaveAlias.ok) return;
    assert.equal(localizedSaveAlias.value.action, "write");
    assert.equal(localizedSaveAlias.value.filePath, "/tmp/localized-save.md");
    assert.equal(
      localizedSaveAlias.value.content,
      "saved from localized action",
    );

    const localizedWriteAlias = tool.validate({
      action: "写入",
      filePath: "/tmp/localized-write.md",
      content: "written from localized action",
    });
    assert.isTrue(localizedWriteAlias.ok);
    if (!localizedWriteAlias.ok) return;
    assert.equal(localizedWriteAlias.value.action, "write");
    assert.equal(localizedWriteAlias.value.filePath, "/tmp/localized-write.md");
    assert.equal(
      localizedWriteAlias.value.content,
      "written from localized action",
    );

    const hyphenatedOperationAlias = tool.validate({
      operation: "save-to-file",
      path: "/tmp/hyphen-save.md",
      text: "saved from hyphenated operation",
    });
    assert.isTrue(hyphenatedOperationAlias.ok);
    if (!hyphenatedOperationAlias.ok) return;
    assert.equal(hyphenatedOperationAlias.value.action, "write");
    assert.equal(hyphenatedOperationAlias.value.filePath, "/tmp/hyphen-save.md");
    assert.equal(
      hyphenatedOperationAlias.value.content,
      "saved from hyphenated operation",
    );

    const actionlessMineruFullMd = tool.validate({
      filePath: "/tmp/llm-for-zotero-mineru/51/full.md",
      offset: 128,
      length: 4096,
    });
    assert.isTrue(actionlessMineruFullMd.ok);
    if (!actionlessMineruFullMd.ok) return;
    assert.equal(actionlessMineruFullMd.value.action, "read");
    assert.equal(
      actionlessMineruFullMd.value.filePath,
      "/tmp/llm-for-zotero-mineru/51/full.md",
    );
    assert.isFalse(
      await tool.shouldRequireConfirmation?.(
        actionlessMineruFullMd.value,
        baseContext,
      ),
    );

    const actionlessMineruManifest = tool.validate({
      path: "/tmp/llm-for-zotero-mineru/51/manifest.json",
    });
    assert.isTrue(actionlessMineruManifest.ok);
    if (!actionlessMineruManifest.ok) return;
    assert.equal(actionlessMineruManifest.value.action, "read");
    assert.equal(
      actionlessMineruManifest.value.filePath,
      "/tmp/llm-for-zotero-mineru/51/manifest.json",
    );

    const accessAlias = tool.validate({
      action: "access",
      filePath: "/tmp/arbitrary-read.md",
    });
    assert.isTrue(accessAlias.ok);
    if (!accessAlias.ok) return;
    assert.equal(accessAlias.value.action, "read");

    const inspectAlias = tool.validate({
      operation: "inspect",
      file_path: "/tmp/inspect-read.md",
    });
    assert.isTrue(inspectAlias.ok);
    if (!inspectAlias.ok) return;
    assert.equal(inspectAlias.value.action, "read");
    assert.equal(inspectAlias.value.filePath, "/tmp/inspect-read.md");

    const missingAction = tool.validate({
      filePath: "/tmp/no-action.md",
    });
    assert.isFalse(missingAction.ok);

    const actionlessWriteLike = tool.validate({
      filePath: "/tmp/llm-for-zotero-mineru/51/full.md",
      content: "unsafe",
    });
    assert.isFalse(actionlessWriteLike.ok);
    if (!actionlessWriteLike.ok) {
      assert.include(actionlessWriteLike.error, "action must be");
    }

    const contentlessReadAliasWithContent = tool.validate({
      action: "access",
      filePath: "/tmp/not-a-read.md",
      content: "unsafe",
    });
    assert.isFalse(contentlessReadAliasWithContent.ok);
    if (!contentlessReadAliasWithContent.ok) {
      assert.include(contentlessReadAliasWithContent.error, "action must be");
    }

    for (const action of ["append", "edit", "update", "delete", "execute"]) {
      const unsupported = tool.validate({
        action,
        filePath: "/tmp/llm-for-zotero-mineru/51/full.md",
        content: "unsafe",
      });
      assert.isFalse(unsupported.ok);
      if (!unsupported.ok) {
        assert.include(unsupported.error, "action must be");
      }
    }

    const unsupportedActionWinsPrecedence = tool.validate({
      action: "append",
      op: "save_file",
      filePath: "/tmp/append.md",
      content: "unsafe",
    });
    assert.isFalse(unsupportedActionWinsPrecedence.ok);
    if (!unsupportedActionWinsPrecedence.ok) {
      assert.include(unsupportedActionWinsPrecedence.error, "action must be");
    }

    const missingWriteContent = tool.validate({
      action: "writeFile",
      filePath: "/tmp/missing-content.md",
    });
    assert.isFalse(missingWriteContent.ok);
    if (!missingWriteContent.ok) {
      assert.include(missingWriteContent.error, "content is required");
    }
  });
});
