/// <reference types="zotero-types" />

import { assert } from "chai";
import { after, before, beforeEach, describe, it } from "mocha";
import {
  isGlobalPortalItem,
  isPaperPortalItem,
  resolveActiveNoteSession,
  resolveInitialPanelItemState,
  resolveNoteConversationSystemSwitch,
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

  it("keeps item notes on their own conversation while exposing the parent paper", function () {
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
      title: "Item Note",
      parentItemId: 42,
      displayConversationKind: "paper",
      capabilities: {
        showModeSwitch: false,
        showNewConversation: false,
        showHistory: false,
      },
    });
  });

  it("keeps standalone notes in open-chat semantics without remapping them", function () {
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
      title: "Standalone Note",
      parentItemId: undefined,
      displayConversationKind: "global",
      capabilities: {
        showModeSwitch: false,
        showNewConversation: false,
        showHistory: false,
      },
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

  it("does not allow active notes to enter Claude Code mode", function () {
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
      "upstream",
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

  it("normalizes note-session runtime switches without allowing Claude Code", function () {
    assert.equal(
      resolveNoteConversationSystemSwitch({
        nextSystem: "codex",
        codexAvailable: true,
      }),
      "codex",
    );
    assert.isNull(
      resolveNoteConversationSystemSwitch({
        nextSystem: "codex",
        codexAvailable: false,
      }),
    );
    assert.equal(
      resolveNoteConversationSystemSwitch({
        nextSystem: "upstream",
        codexAvailable: false,
      }),
      "upstream",
    );
    assert.isNull(
      resolveNoteConversationSystemSwitch({
        nextSystem: "claude_code",
        codexAvailable: true,
      }),
    );
  });

  it("falls back to upstream paper state when Claude mode is disabled", function () {
    let claudeEnabled = false;
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
          if (String(key).endsWith("enableClaudeCodeMode")) return claudeEnabled;
          if (String(key).endsWith("conversationSystem")) return "claude_code";
          return originalPrefs?.get?.(key, true) ?? "";
        },
      },
    } as typeof Zotero;

    const claudePortal = createClaudePaperPortalItem(paperItem, 3500005254) as Zotero.Item;
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
