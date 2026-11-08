import { assert } from "chai";
import { createAgentExecutionContext } from "../src/agent/execution/context";

describe("Agent execution context", function () {
  it("separates the run identity from the durable workspace snapshot", function () {
    const context = createAgentExecutionContext(
      {
        conversationKey: 7,
        conversationGeneration: 3,
        libraryID: 1,
        userText: "tag these papers",
        history: [],
        attachments: [],
        localDocuments: [
          {
            resource: {
              absolutePath: "/task/requested.md",
            },
          },
        ],
        turnPaperScope: {
          libraryID: 1,
          papers: [
            {
              roles: ["active", "selected"],
              paper: {
                libraryID: 1,
                itemId: 10,
                contextItemId: 11,
                title: "Paper",
                mineruCacheDir: "/cache/paper",
              },
            },
          ],
          collections: [],
          tags: [],
        },
      } as never,
      "run-attempt-2",
      { notesDirectory: null, agentFilesRoot: null },
    );

    assert.equal(context.executionId, "run-attempt-2");
    assert.equal(context.conversationKey, 7);
    assert.equal(context.conversationGeneration, 3);
    assert.equal(context.permissionOwner, "original_agent");
    assert.equal(context.workspaceSnapshot.activePaper?.itemId, 10);
    assert.deepEqual(context.workspaceSnapshot.selectedPapers, [
      {
        libraryID: 1,
        itemId: 10,
        contextItemId: 11,
        title: "Paper",
      },
    ]);
    assert.deepEqual(context.configuredAccess.fileAccess?.readFiles, [
      "/task/requested.md",
    ]);
    assert.deepEqual(context.configuredAccess.fileAccess?.readDirectories, [
      "/cache/paper",
    ]);
    assert.deepEqual(context.configuredAccess.fileAccess?.writeDirectories, []);
  });

  it("lets the agent read and write its own saved-files folder", function () {
    const context = createAgentExecutionContext(
      {
        conversationKey: 7,
        libraryID: 1,
        userText: "make me a page",
        history: [],
        attachments: [],
        turnPaperScope: {
          libraryID: 1,
          papers: [],
          collections: [],
          tags: [],
        },
      } as never,
      "run-1",
      { notesDirectory: null, agentFilesRoot: "/zotero/llm-for-zotero-files" },
    );

    assert.deepEqual(context.configuredAccess.fileAccess?.writeDirectories, [
      "/zotero/llm-for-zotero-files",
    ]);
    assert.include(
      context.configuredAccess.fileAccess?.readDirectories || [],
      "/zotero/llm-for-zotero-files",
    );
  });
});
