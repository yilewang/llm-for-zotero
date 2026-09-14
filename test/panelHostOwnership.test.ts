import { assert } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";

import { beginPanelRequest } from "../src/modules/contextPanel/chat";
import {
  bindEmbeddedPanelHost,
  bindStandalonePanelHost,
  clearPanelHostBinding,
  evaluatePanelOwnership,
  isPanelHostCompatibleWithPaper,
  getConversationScopeIdentityForTests,
  requireCurrentPanelOwnership,
} from "../src/modules/contextPanel/panelHostOwnership";
import { createGlobalPortalItem } from "../src/modules/contextPanel/portalScope";
import {
  activeContextPanels,
  clearAllState,
} from "../src/modules/contextPanel/state";

type FakePanel = {
  body: Element;
  root: HTMLElement;
  chatBox: {
    innerHTML: string;
    replaceChildren: (...nodes: unknown[]) => void;
  };
  controls: Array<{ disabled: boolean }>;
};

function fakePaper(id: number, libraryID = 1): Zotero.Item {
  return {
    id,
    libraryID,
    parentID: undefined,
    isAttachment: () => false,
    isRegularItem: () => true,
    isNote: () => false,
    getAttachments: () => [],
    getField: () => `Paper ${id}`,
  } as unknown as Zotero.Item;
}

function fakeNote(
  id: number,
  parentID: number | undefined,
  libraryID = 1,
): Zotero.Item {
  return {
    id,
    libraryID,
    parentID,
    isAttachment: () => false,
    isRegularItem: () => false,
    isNote: () => true,
    getNoteTitle: () => `Note ${id}`,
  } as unknown as Zotero.Item;
}

function fakePanel(params: {
  conversationKey: number;
  libraryID?: number;
  paperItemID?: number;
  kind?: "paper" | "global";
  noteID?: number;
  noteParentItemID?: number;
  system?: "upstream" | "claude_code" | "codex";
  tabID?: string;
  initialized?: boolean;
  standalone?: boolean;
}): FakePanel {
  const controls = [{ disabled: false }, { disabled: false }];
  const root = {
    dataset: {
      itemId: `${params.conversationKey}`,
      libraryId: `${params.libraryID || 1}`,
      basePaperItemId: params.paperItemID ? `${params.paperItemID}` : "",
      conversationKind: params.kind || "paper",
      conversationSystem: params.system || "upstream",
      noteId: params.noteID ? `${params.noteID}` : "",
      noteParentItemId: params.noteParentItemID
        ? `${params.noteParentItemID}`
        : "",
      handlersInitialized: params.initialized === false ? "" : "1",
      standalone: params.standalone ? "true" : "",
    },
    setAttribute: () => undefined,
    querySelectorAll: () => controls,
    contains: () => true,
  } as unknown as HTMLElement;
  const chatBox = {
    innerHTML: "foreign paper marker",
    replaceChildren: (...nodes: unknown[]) => {
      chatBox.innerHTML = nodes.length ? "Restoring this conversation…" : "";
    },
    appendChild: () => {
      chatBox.innerHTML = "Restoring this conversation…";
    },
  };
  const hidden = { style: { display: "" } };
  const status = { textContent: "foreign status", className: "" };
  const tabOwner = {
    getAttribute: () => params.tabID || "",
  } as unknown as Element;
  const body = {
    isConnected: true,
    ownerDocument: {
      createElement: () => ({ className: "", textContent: "" }),
    },
    closest: (selector: string) =>
      selector === "[data-tab-id]" && params.tabID ? tabOwner : null,
    querySelector: (selector: string) => {
      if (selector === "#llm-main") return root;
      if (selector === "#llm-chat-box") return chatBox;
      if (selector === "#llm-status") return status;
      if (selector === "#llm-context-previews") {
        return { replaceChildren: () => undefined };
      }
      return hidden;
    },
  } as unknown as Element;
  return { body, root, chatBox, controls };
}

describe("panel host ownership", function () {
  const originalZotero = globalThis.Zotero;
  const items = new Map<number, Zotero.Item>();

  beforeEach(function () {
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Prefs: { get: () => undefined },
      Items: { get: (itemID: number) => items.get(itemID) || null },
      Libraries: { userLibraryID: 1 },
      Profile: { dir: "/tmp/zotero-profile" },
      Tabs: { selectedID: "reader-a" },
    } as typeof Zotero;
  });

  afterEach(function () {
    items.clear();
    clearAllState();
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
  });

  it("returns match for host A, mounted A, candidate A", function () {
    const itemA = fakePaper(101);
    const panel = fakePanel({
      conversationKey: 101,
      paperItemID: 101,
      tabID: "reader-a",
    });
    bindEmbeddedPanelHost(panel.body, itemA, "reader");
    activeContextPanels.set(panel.body, () => itemA);

    assert.equal(evaluatePanelOwnership(panel.body, itemA), "match");
  });

  it("treats delayed A work as stale without clearing a valid B panel", function () {
    const itemA = fakePaper(101);
    const itemB = fakePaper(202);
    const panel = fakePanel({
      conversationKey: 202,
      paperItemID: 202,
      tabID: "reader-b",
    });
    bindEmbeddedPanelHost(panel.body, itemB, "reader");
    activeContextPanels.set(panel.body, () => itemB);

    assert.equal(evaluatePanelOwnership(panel.body, itemA), "stale-candidate");
    assert.isFalse(
      requireCurrentPanelOwnership(panel.body, itemA, "delayed-render"),
    );
    assert.equal(panel.chatBox.innerHTML, "foreign paper marker");
  });

  it("clears and disables host A when mounted scope belongs to B", function () {
    const itemA = fakePaper(101);
    const itemB = fakePaper(202);
    const panel = fakePanel({
      conversationKey: 202,
      paperItemID: 202,
      tabID: "reader-a",
    });
    bindEmbeddedPanelHost(panel.body, itemA, "reader");
    activeContextPanels.set(panel.body, () => itemB);

    assert.equal(evaluatePanelOwnership(panel.body, itemB), "host-mismatch");
    assert.isNull(beginPanelRequest(panel.body, itemB));
    assert.equal(panel.chatBox.innerHTML, "Restoring this conversation…");
    assert.isTrue(panel.controls.every((control) => control.disabled));
  });

  it("fails closed when an initialized embedded panel has no host", function () {
    const itemA = fakePaper(101);
    const panel = fakePanel({ conversationKey: 101, paperItemID: 101 });

    assert.equal(evaluatePanelOwnership(panel.body, itemA), "unresolved");
    assert.isFalse(
      requireCurrentPanelOwnership(panel.body, itemA, "unresolved-action"),
    );
    assert.equal(panel.chatBox.innerHTML, "Restoring this conversation…");
  });

  it("allows only same-library global scope in explicit global mode", function () {
    const host = fakePaper(101, 1);
    const sameLibraryGlobal = createGlobalPortalItem(1, 2_000_000_001);
    const otherLibraryGlobal = createGlobalPortalItem(2, 2_000_000_002);
    const panel = fakePanel({
      conversationKey: sameLibraryGlobal.id,
      kind: "global",
      libraryID: 1,
    });
    bindEmbeddedPanelHost(panel.body, host, "library");
    activeContextPanels.set(panel.body, () => sameLibraryGlobal);

    assert.equal(
      evaluatePanelOwnership(panel.body, sameLibraryGlobal),
      "match",
    );
    assert.equal(
      evaluatePanelOwnership(panel.body, otherLibraryGlobal),
      "stale-candidate",
    );
  });

  it("matches only the exact note and parent scope", function () {
    const parentA = fakePaper(101);
    const parentB = fakePaper(202);
    const noteA = fakeNote(301, parentA.id);
    const noteB = fakeNote(302, parentA.id);
    const noteOnB = fakeNote(303, parentB.id);
    items.set(parentA.id, parentA);
    items.set(parentB.id, parentB);
    const panel = fakePanel({
      conversationKey: noteA.id,
      paperItemID: parentA.id,
      noteID: noteA.id,
      noteParentItemID: parentA.id,
    });
    bindEmbeddedPanelHost(panel.body, noteA, "library");

    assert.deepInclude(getConversationScopeIdentityForTests(noteA), {
      conversationKey: noteA.id,
      kind: "note",
      libraryID: 1,
      noteID: noteA.id,
      noteParentItemID: parentA.id,
    });
    assert.equal(evaluatePanelOwnership(panel.body, noteA), "match");
    assert.isTrue(isPanelHostCompatibleWithPaper(panel.body, noteA));
    assert.isFalse(isPanelHostCompatibleWithPaper(panel.body, parentA));
    assert.isFalse(isPanelHostCompatibleWithPaper(panel.body, noteB));
    assert.equal(evaluatePanelOwnership(panel.body, noteB), "stale-candidate");
    assert.equal(
      evaluatePanelOwnership(panel.body, noteOnB),
      "stale-candidate",
    );
  });

  it("blocks a mounted note whose parent differs from its Zotero host", function () {
    const parentA = fakePaper(101);
    const parentB = fakePaper(202);
    const hostNote = fakeNote(301, parentA.id);
    const mountedNote = fakeNote(302, parentB.id);
    items.set(parentA.id, parentA);
    items.set(parentB.id, parentB);
    const panel = fakePanel({
      conversationKey: parentB.id,
      paperItemID: parentB.id,
      noteID: mountedNote.id,
      noteParentItemID: parentB.id,
    });
    bindEmbeddedPanelHost(panel.body, hostNote, "library");

    assert.equal(
      evaluatePanelOwnership(panel.body, mountedNote),
      "host-mismatch",
    );
  });

  it("uses the preferred provider system for a note-focused conversation", function () {
    const parent = fakePaper(101);
    const note = fakeNote(301, parent.id);
    items.set(parent.id, parent);
    (globalThis.Zotero.Prefs as { get: (key: string) => unknown }).get = (
      key,
    ) => {
      if (key.endsWith("conversationSystem")) return "codex";
      if (key.endsWith("enableCodexAppServerMode")) return true;
      return undefined;
    };
    const scope = getConversationScopeIdentityForTests(note);
    assert.isOk(scope);
    const panel = fakePanel({
      conversationKey: scope!.conversationKey,
      paperItemID: parent.id,
      noteID: note.id,
      noteParentItemID: parent.id,
      system: "codex",
    });
    bindEmbeddedPanelHost(panel.body, note, "library");

    assert.equal(evaluatePanelOwnership(panel.body, note), "match");
  });

  it("allows deliberate standalone cross-paper switching", function () {
    const itemA = fakePaper(101);
    const itemB = fakePaper(202);
    const panel = fakePanel({
      conversationKey: 202,
      paperItemID: 202,
      standalone: true,
    });
    bindStandalonePanelHost(panel.body, itemA);
    activeContextPanels.set(panel.body, () => itemB);

    assert.equal(evaluatePanelOwnership(panel.body, itemB), "match");
    clearPanelHostBinding(panel.body);
  });
});
