import { assert } from "chai";
import { createEditCurrentNoteTool } from "../src/agent/tools/write/editCurrentNote";
import type { AgentToolContext } from "../src/agent/types";

describe("editCurrentNote path imports", function () {
  const baseContext: AgentToolContext = {
    request: {
      conversationKey: 77,
      mode: "agent",
      userText: "embed this figure",
      activeItemId: 9,
      libraryID: 1,
    },
    item: null,
    currentAnswerText: "",
    modelName: "gpt-5.4",
  };

  it("imports markdown Windows file URLs using native paths", async function () {
    let importedPath = "";
    const tool = createEditCurrentNoteTool({
      getActiveNoteSnapshot: () => ({
        noteId: 55,
        title: "Draft Note",
        html: "<p>Original body</p>",
        text: "Original body",
        libraryID: 1,
        noteKind: "standalone",
      }),
      importNoteImage: async ({
        imagePath,
      }: {
        imagePath: string;
        noteItemId: number;
      }) => {
        importedPath = imagePath;
        return { key: "IMGWIN" };
      },
      replaceCurrentNote: async ({ content }: { content: string }) => {
        assert.equal(
          content,
          'See <img data-attachment-key="IMGWIN" alt="Figure 1" />',
        );
        return {
          noteId: 55,
          title: "Draft Note",
          previousHtml: "<p>Original body</p>",
          previousText: "Original body",
          nextText: content,
        };
      },
      restoreNoteHtml: async () => {},
    } as never);
    const noteRequest = {
      ...baseContext.request,
      activeNoteContext: {
        noteId: 55,
        title: "Draft Note",
        noteKind: "standalone" as const,
        noteText: "Original body",
      },
    };

    const validated = tool.validate({
      content: "See ![Figure 1](file:///C:/Users/alice/My%20Fig.png)",
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    tool.createPendingAction?.(validated.value, {
      ...baseContext,
      request: noteRequest,
    });
    await tool.execute(validated.value, {
      ...baseContext,
      request: noteRequest,
    });
    assert.equal(importedPath, "C:\\Users\\alice\\My Fig.png");
  });

  it("imports HTML UNC file URLs using native paths", async function () {
    let importedPath = "";
    const tool = createEditCurrentNoteTool({
      importNoteImage: async ({
        imagePath,
      }: {
        imagePath: string;
        noteItemId: number;
      }) => {
        importedPath = imagePath;
        return { key: "IMGUNC" };
      },
      replaceCurrentNote: async ({ content }: { content: string }) => {
        assert.equal(
          content,
          '<img data-attachment-key="IMGUNC" alt="Shared figure" />',
        );
        return {
          noteId: 55,
          title: "Draft Note",
          previousHtml: "<p>Original body</p>",
          previousText: "Original body",
          nextText: content,
        };
      },
      restoreNoteHtml: async () => {},
    } as never);

    await tool.execute(
      {
        mode: "edit",
        content:
          '<img src="file://server/share/fig%231.png" alt="Shared figure" />',
        noteId: 55,
        expectedOriginalHtml: "<p>Original body</p>",
      },
      baseContext,
    );
    assert.equal(importedPath, "\\\\server\\share\\fig#1.png");
  });

  it("leaves unsupported file URLs unchanged", async function () {
    let importAttempts = 0;
    const tool = createEditCurrentNoteTool({
      importNoteImage: async () => {
        importAttempts += 1;
        return { key: "UNUSED" };
      },
      replaceCurrentNote: async ({ content }: { content: string }) => {
        assert.equal(
          content,
          '<img src="file://server" alt="Broken figure" />',
        );
        return {
          noteId: 55,
          title: "Draft Note",
          previousHtml: "<p>Original body</p>",
          previousText: "Original body",
          nextText: content,
        };
      },
      restoreNoteHtml: async () => {},
    } as never);

    await tool.execute(
      {
        mode: "edit",
        content: '<img src="file://server" alt="Broken figure" />',
        noteId: 55,
        expectedOriginalHtml: "<p>Original body</p>",
      },
      baseContext,
    );
    assert.equal(importAttempts, 0);
  });
});
