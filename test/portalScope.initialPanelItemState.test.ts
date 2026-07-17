/// <reference types="zotero-types" />

import { assert } from "chai";
import { after, before, beforeEach, describe, it } from "mocha";
import {
  isGlobalPortalItem,
  isPaperPortalItem,
  resolveActiveNoteSession,
  resolveInitialPanelItemState,
  resolveNoteFocusSystemSwitch,
  resolvePaperChatSourceItem,
  resolvePreferredConversationSystem,
} from "../src/modules/contextPanel/portalScope";
import { createClaudePaperPortalItem } from "../src/claudeCode/portal";
import {
  createCodexPaperPortalItem,
  isCodexPaperPortalItem,
} from "../src/codexAppServer/portal";
import {
  activeConversationModeByLibrary,
  activeGlobalConversationByLibrary,
  activePaperConversationByPaper,
} from "../src/modules/contextPanel/state";
import {
  activeCodexGlobalConversationByLibrary,
  activeCodexPaperConversationByPaper,
  buildCodexPaperStateKey,
} from "../src/codexAppServer/state";

describe("portalScope resolveInitialPanelItemState", function () {
  const originalZotero = globalThis.Zotero;
  const itemsById = new Map<number, Zotero.Item>();

  const installBaseZotero = () => {
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Items: {
        get: (itemId: number) => itemsById.get(itemId) || null,
      },
      Profile: {
        dir: "/tmp/llm-for-zotero-test-profile",
      },
      Prefs: {
        get: (key: string) => {
          if (String(key).endsWith("enableClaudeCodeMode")) return false;
          if (String(key).endsWith("enableCodexAppServerMode")) return false;
          if (String(key).endsWith("conversationSystem")) return "upstream";
          return "";
        },
      },
    } as typeof Zotero;
  };

  before(function () {
    installBaseZotero();
  });

  after(function () {
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
  });

  beforeEach(function () {
    installBaseZotero();
    activeConversationModeByLibrary.clear();
    activeGlobalConversationByLibrary.clear();
    activePaperConversationByPaper.clear();
    activeCodexGlobalConversationByLibrary.clear();
    activeCodexPaperConversationByPaper.clear();
    itemsById.clear();
  });

  it("restores the remembered global chat when library mode is global", function () {
    const paperItem = {
      id: 42,
      libraryID: 7,
      parentID: undefined,
      isAttachment: () => false,
      isRegularItem: () => true,
    } as unknown as Zotero.Item;

    activeConversationModeByLibrary.set(7, "global");
    activeGlobalConversationByLibrary.set(7, 2_000_009_001);

    const resolved = resolveInitialPanelItemState(paperItem);

    assert.equal(resolved.basePaperItem, paperItem);
    assert.equal(resolved.item?.id, 2_000_009_001);
    assert.equal(resolved.item?.libraryID, 7);
  });

  it("restores the locked upstream library chat when no explicit paper mode is active", function () {
    const paperItem = {
      id: 42,
      libraryID: 7,
      parentID: undefined,
      isAttachment: () => false,
      isRegularItem: () => true,
    } as unknown as Zotero.Item;

    globalThis.Zotero = {
      ...globalThis.Zotero,
      Prefs: {
        get: (key: string) => {
          if (String(key).endsWith("lockedGlobalConversation.7")) {
            return 2_000_009_001;
          }
          if (String(key).endsWith("enableClaudeCodeMode")) return false;
          if (String(key).endsWith("enableCodexAppServerMode")) return false;
          if (String(key).endsWith("conversationSystem")) return "upstream";
          return "";
        },
      },
    } as typeof Zotero;

    const resolved = resolveInitialPanelItemState(paperItem);

    assert.equal(resolved.basePaperItem, paperItem);
    assert.isTrue(isGlobalPortalItem(resolved.item));
    assert.equal(resolved.item?.id, 2_000_009_001);
    assert.equal(resolved.item?.libraryID, 7);
  });

  it("restores the remembered paper chat session for the selected paper", function () {
    const paperItem = {
      id: 42,
      libraryID: 7,
      parentID: undefined,
      isAttachment: () => false,
      isRegularItem: () => true,
    } as unknown as Zotero.Item;

    activePaperConversationByPaper.set("7:42", 4207);

    const resolved = resolveInitialPanelItemState(paperItem);

    assert.equal(resolved.basePaperItem, paperItem);
    assert.isTrue(isPaperPortalItem(resolved.item));
    assert.equal(resolved.item?.id, 4207);
    assert.equal(resolved.item?.libraryID, 7);
  });

  it("restores explicit paper mode while the remembered library mode is global", function () {
    const paperItem = {
      id: 42,
      libraryID: 7,
      parentID: undefined,
      isAttachment: () => false,
      isRegularItem: () => true,
    } as unknown as Zotero.Item;

    activeConversationModeByLibrary.set(7, "global");
    activeGlobalConversationByLibrary.set(7, 2_000_009_001);
    activePaperConversationByPaper.set("7:42", 4207);

    const resolved = resolveInitialPanelItemState(paperItem, {
      conversationMode: "paper",
    });

    assert.equal(resolved.basePaperItem, paperItem);
    assert.isTrue(isPaperPortalItem(resolved.item));
    assert.equal(resolved.item?.id, 4207);
    assert.equal(resolved.item?.libraryID, 7);
  });

  it("uses the parent paper as the conversation item for a selected child attachment", function () {
    const paperItem = {
      id: 42,
      libraryID: 7,
      parentID: undefined,
      isAttachment: () => false,
      isRegularItem: () => true,
    } as unknown as Zotero.Item;
    const attachmentItem = {
      id: 43,
      libraryID: 7,
      parentID: 42,
      attachmentContentType: "application/pdf",
      attachmentFilename: "paper.pdf",
      isAttachment: () => true,
      isRegularItem: () => false,
    } as unknown as Zotero.Item;
    itemsById.set(42, paperItem);

    const resolved = resolveInitialPanelItemState(attachmentItem);

    assert.equal(resolved.basePaperItem, paperItem);
    assert.equal(resolved.item, paperItem);
  });

  it("restores the remembered paper chat session for a selected child attachment", function () {
    const paperItem = {
      id: 42,
      libraryID: 7,
      parentID: undefined,
      isAttachment: () => false,
      isRegularItem: () => true,
    } as unknown as Zotero.Item;
    const attachmentItem = {
      id: 43,
      libraryID: 7,
      parentID: 42,
      attachmentContentType: "application/pdf",
      attachmentFilename: "paper.pdf",
      isAttachment: () => true,
      isRegularItem: () => false,
    } as unknown as Zotero.Item;
    itemsById.set(42, paperItem);
    activePaperConversationByPaper.set("7:42", 4207);

    const resolved = resolveInitialPanelItemState(attachmentItem);

    assert.equal(resolved.basePaperItem, paperItem);
    assert.isTrue(isPaperPortalItem(resolved.item));
    assert.equal(resolved.item?.id, 4207);
    assert.equal(resolved.item?.libraryID, 7);
  });

  it("uses top-level supported attachments as paper chat source items", function () {
    const cases = [
      {
        id: 501,
        contentType: "application/pdf",
        filename: "standalone.pdf",
      },
      {
        id: 502,
        contentType: "text/markdown",
        filename: "notes.md",
      },
      {
        id: 503,
        contentType: "text/html",
        filename: "page.html",
      },
      {
        id: 504,
        contentType: "text/plain",
        filename: "plain.txt",
      },
      {
        id: 505,
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename: "draft.docx",
      },
    ];

    for (const entry of cases) {
      const attachmentItem = {
        id: entry.id,
        libraryID: 7,
        parentID: undefined,
        attachmentContentType: entry.contentType,
        attachmentFilename: entry.filename,
        isAttachment: () => true,
        isRegularItem: () => false,
      } as unknown as Zotero.Item;

      assert.equal(resolvePaperChatSourceItem(attachmentItem), attachmentItem);
      const resolved = resolveInitialPanelItemState(attachmentItem);

      assert.equal(resolved.basePaperItem, attachmentItem);
      assert.equal(resolved.item, attachmentItem);
    }
  });

  it("restores remembered paper chat for a top-level supported attachment", function () {
    const attachmentItem = {
      id: 501,
      libraryID: 7,
      parentID: undefined,
      attachmentContentType: "application/pdf",
      attachmentFilename: "standalone.pdf",
      isAttachment: () => true,
      isRegularItem: () => false,
    } as unknown as Zotero.Item;

    itemsById.set(501, attachmentItem);
    activePaperConversationByPaper.set("7:501", 4501);

    const resolved = resolveInitialPanelItemState(attachmentItem);

    assert.equal(resolved.basePaperItem, attachmentItem);
    assert.isTrue(isPaperPortalItem(resolved.item));
    assert.equal(resolvePaperChatSourceItem(resolved.item), attachmentItem);
    assert.equal(resolved.item?.id, 4501);
    assert.equal(resolved.item?.libraryID, 7);
  });

  it("does not use unsupported top-level attachments as paper chat sources", function () {
    const attachmentItem = {
      id: 601,
      libraryID: 7,
      parentID: undefined,
      attachmentContentType: "application/zip",
      attachmentFilename: "archive.zip",
      isAttachment: () => true,
      isRegularItem: () => false,
    } as unknown as Zotero.Item;

    const resolved = resolveInitialPanelItemState(attachmentItem);

    assert.isNull(resolvePaperChatSourceItem(attachmentItem));
    assert.isNull(resolved.basePaperItem);
    assert.equal(resolved.item, attachmentItem);
  });

  it("keeps explicit upstream paper mode ahead of a stale global lock", function () {
    const paperItem = {
      id: 42,
      libraryID: 7,
      parentID: undefined,
      isAttachment: () => false,
      isRegularItem: () => true,
    } as unknown as Zotero.Item;

    globalThis.Zotero = {
      ...globalThis.Zotero,
      Prefs: {
        get: (key: string) => {
          if (String(key).endsWith("lockedGlobalConversation.7")) {
            return 2_000_009_001;
          }
          if (String(key).endsWith("enableClaudeCodeMode")) return false;
          if (String(key).endsWith("enableCodexAppServerMode")) return false;
          if (String(key).endsWith("conversationSystem")) return "upstream";
          return "";
        },
      },
    } as typeof Zotero;
    activeConversationModeByLibrary.set(7, "paper");
    activePaperConversationByPaper.set("7:42", 4207);

    const resolved = resolveInitialPanelItemState(paperItem);

    assert.equal(resolved.basePaperItem, paperItem);
    assert.isTrue(isPaperPortalItem(resolved.item));
    assert.equal(resolved.item?.id, 4207);
    assert.equal(resolved.item?.libraryID, 7);
  });

  it("maps item notes onto parent paper chat while keeping note focus metadata", function () {
    const parentItem = {
      id: 42,
      libraryID: 7,
      parentID: undefined,
      isAttachment: () => false,
      isRegularItem: () => true,
    } as unknown as Zotero.Item;
    const noteItem = {
      id: 99,
      libraryID: 7,
      parentID: 42,
      isAttachment: () => false,
      isRegularItem: () => false,
      isNote: () => true,
      getNoteTitle: () => "Item Note",
    } as unknown as Zotero.Item;
    itemsById.set(42, parentItem);

    const resolved = resolveInitialPanelItemState(noteItem);
    const session = resolveActiveNoteSession(noteItem);

    assert.equal(resolved.item, noteItem);
    assert.equal(resolved.basePaperItem, parentItem);
    assert.deepEqual(session, {
      noteKind: "item",
      noteId: 99,
      libraryID: 7,
      title: "Item Note",
      parentItemId: 42,
      conversationKind: "paper",
    });
  });

  it("maps standalone notes onto library chat while keeping note focus metadata", function () {
    const noteItem = {
      id: 108,
      libraryID: 7,
      parentID: undefined,
      isAttachment: () => false,
      isRegularItem: () => false,
      isNote: () => true,
      getNoteTitle: () => "Standalone Note",
    } as unknown as Zotero.Item;

    const resolved = resolveInitialPanelItemState(noteItem);
    const session = resolveActiveNoteSession(noteItem);

    assert.equal(resolved.item, noteItem);
    assert.isNull(resolved.basePaperItem);
    assert.isFalse(isPaperPortalItem(resolved.item));
    assert.deepEqual(session, {
      noteKind: "standalone",
      noteId: 108,
      libraryID: 7,
      title: "Standalone Note",
      parentItemId: undefined,
      conversationKind: "global",
    });
  });

  it("allows active notes to prefer Codex when Codex app-server is enabled", function () {
    const noteItem = {
      id: 108,
      libraryID: 7,
      parentID: undefined,
      isAttachment: () => false,
      isRegularItem: () => false,
      isNote: () => true,
      getNoteTitle: () => "Standalone Note",
    } as unknown as Zotero.Item;
    globalThis.Zotero = {
      ...globalThis.Zotero,
      Prefs: {
        get: (key: string) => {
          if (String(key).endsWith("enableCodexAppServerMode")) return true;
          if (String(key).endsWith("conversationSystem")) return "codex";
          return "";
        },
      },
    } as typeof Zotero;

    assert.equal(
      resolvePreferredConversationSystem({ item: noteItem }),
      "codex",
    );
  });

  it("honors a supplied upstream initial state while Codex is available", function () {
    const paperItem = {
      id: 42,
      libraryID: 7,
      parentID: undefined,
      isAttachment: () => false,
      isRegularItem: () => true,
    } as unknown as Zotero.Item;
    itemsById.set(42, paperItem);
    activePaperConversationByPaper.set("7:42", 4207);
    globalThis.Zotero = {
      ...globalThis.Zotero,
      Items: {
        get: (itemId: number) => itemsById.get(itemId) || null,
      },
      Profile: {
        dir: "/tmp/llm-for-zotero-test-profile",
      },
      Prefs: {
        get: (key: string) => {
          if (String(key).endsWith("enableCodexAppServerMode")) return true;
          if (String(key).endsWith("conversationSystem")) return "codex";
          return "";
        },
      },
    } as typeof Zotero;

    const resolved = resolveInitialPanelItemState(paperItem, {
      conversationSystem: "upstream",
    });

    assert.equal(resolved.basePaperItem, paperItem);
    assert.isTrue(isPaperPortalItem(resolved.item));
    assert.isFalse(isCodexPaperPortalItem(resolved.item));
    assert.equal(resolved.item?.id, 4207);
    assert.equal(resolved.item?.libraryID, 7);
  });

  it("allows active notes to enter Claude Code mode when enabled", function () {
    const noteItem = {
      id: 108,
      libraryID: 7,
      parentID: undefined,
      isAttachment: () => false,
      isRegularItem: () => false,
      isNote: () => true,
      getNoteTitle: () => "Standalone Note",
    } as unknown as Zotero.Item;
    globalThis.Zotero = {
      ...globalThis.Zotero,
      Prefs: {
        get: (key: string) => {
          if (String(key).endsWith("enableClaudeCodeMode")) return true;
          if (String(key).endsWith("conversationSystem")) return "claude_code";
          return "";
        },
      },
    } as typeof Zotero;

    assert.equal(
      resolvePreferredConversationSystem({ item: noteItem }),
      "claude_code",
    );
  });

  it("falls active notes back to upstream when Codex app-server is disabled", function () {
    const noteItem = {
      id: 108,
      libraryID: 7,
      parentID: undefined,
      isAttachment: () => false,
      isRegularItem: () => false,
      isNote: () => true,
      getNoteTitle: () => "Standalone Note",
    } as unknown as Zotero.Item;
    globalThis.Zotero = {
      ...globalThis.Zotero,
      Prefs: {
        get: (key: string) => {
          if (String(key).endsWith("enableCodexAppServerMode")) return false;
          if (String(key).endsWith("conversationSystem")) return "codex";
          return "";
        },
      },
    } as typeof Zotero;

    assert.equal(
      resolvePreferredConversationSystem({ item: noteItem }),
      "upstream",
    );
  });

  it("normalizes note-session runtime switches across all enabled runtimes", function () {
    assert.equal(
      resolveNoteFocusSystemSwitch({
        nextSystem: "codex",
        codexAvailable: true,
        claudeAvailable: true,
      }),
      "codex",
    );
    assert.isNull(
      resolveNoteFocusSystemSwitch({
        nextSystem: "codex",
        codexAvailable: false,
        claudeAvailable: true,
      }),
    );
    assert.equal(
      resolveNoteFocusSystemSwitch({
        nextSystem: "upstream",
        codexAvailable: false,
        claudeAvailable: true,
      }),
      "upstream",
    );
    assert.equal(
      resolveNoteFocusSystemSwitch({
        nextSystem: "claude_code",
        codexAvailable: true,
        claudeAvailable: true,
      }),
      "claude_code",
    );
    assert.isNull(
      resolveNoteFocusSystemSwitch({
        nextSystem: "claude_code",
        codexAvailable: true,
        claudeAvailable: false,
      }),
    );
  });

  it("falls back to upstream paper state when Claude mode is disabled", function () {
    const claudeEnabled = false;
    const originalPrefs = globalThis.Zotero?.Prefs;
    const paperItem = {
      id: 42,
      libraryID: 7,
      parentID: undefined,
      isAttachment: () => false,
      isRegularItem: () => true,
    } as unknown as Zotero.Item;
    itemsById.set(42, paperItem);
    activePaperConversationByPaper.set("7:42", 4207);
    globalThis.Zotero = {
      ...globalThis.Zotero,
      Items: {
        get: (itemId: number) => itemsById.get(itemId) || null,
      },
      Prefs: {
        get: (key: string) => {
          if (String(key).endsWith("enableClaudeCodeMode"))
            return claudeEnabled;
          if (String(key).endsWith("conversationSystem")) return "claude_code";
          return originalPrefs?.get?.(key, true) ?? "";
        },
      },
    } as typeof Zotero;

    const claudePortal = createClaudePaperPortalItem(
      paperItem,
      3500005254,
    ) as Zotero.Item;
    const resolved = resolveInitialPanelItemState(claudePortal, {
      conversationSystem: "claude_code",
    });

    assert.equal(resolved.basePaperItem, paperItem);
    assert.isTrue(isPaperPortalItem(resolved.item));
    assert.equal(resolved.item?.id, 4207);
    assert.equal(resolved.item?.libraryID, 7);
  });

  it("restores the remembered Codex paper chat when Codex is enabled", function () {
    const paperItem = {
      id: 42,
      libraryID: 7,
      parentID: undefined,
      isAttachment: () => false,
      isRegularItem: () => true,
    } as unknown as Zotero.Item;
    itemsById.set(42, paperItem);
    globalThis.Zotero = {
      ...globalThis.Zotero,
      Items: {
        get: (itemId: number) => itemsById.get(itemId) || null,
      },
      Profile: {
        dir: "/tmp/llm-for-zotero-test-profile",
      },
      Prefs: {
        get: (key: string) => {
          if (String(key).endsWith("enableCodexAppServerMode")) return true;
          if (String(key).endsWith("conversationSystem")) return "codex";
          return "";
        },
      },
    } as typeof Zotero;

    activeCodexPaperConversationByPaper.set(
      buildCodexPaperStateKey(7, 42),
      6_000_000_000_000_042,
    );

    const resolved = resolveInitialPanelItemState(paperItem, {
      conversationSystem: "codex",
    });

    assert.equal(resolved.basePaperItem, paperItem);
    assert.isTrue(isCodexPaperPortalItem(resolved.item));
    assert.equal(resolved.item?.id, 6_000_000_000_000_042);
    assert.equal(resolved.item?.libraryID, 7);
  });

  it("falls back to upstream paper state when Codex is disabled", function () {
    const paperItem = {
      id: 42,
      libraryID: 7,
      parentID: undefined,
      isAttachment: () => false,
      isRegularItem: () => true,
    } as unknown as Zotero.Item;
    itemsById.set(42, paperItem);
    activePaperConversationByPaper.set("7:42", 4207);
    globalThis.Zotero = {
      ...globalThis.Zotero,
      Items: {
        get: (itemId: number) => itemsById.get(itemId) || null,
      },
      Profile: {
        dir: "/tmp/llm-for-zotero-test-profile",
      },
      Prefs: {
        get: (key: string) => {
          if (String(key).endsWith("enableCodexAppServerMode")) return false;
          if (String(key).endsWith("conversationSystem")) return "codex";
          return "";
        },
      },
    } as typeof Zotero;

    const codexPortal = createCodexPaperPortalItem(
      paperItem,
      6_000_000_000_000_042,
    ) as Zotero.Item;
    const resolved = resolveInitialPanelItemState(codexPortal, {
      conversationSystem: "codex",
    });

    assert.equal(resolved.basePaperItem, paperItem);
    assert.isTrue(isPaperPortalItem(resolved.item));
    assert.equal(resolved.item?.id, 4207);
    assert.equal(resolved.item?.libraryID, 7);
  });
});
