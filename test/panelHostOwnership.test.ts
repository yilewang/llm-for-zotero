import { assert } from "chai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "mocha";

import { beginPanelRequest } from "../src/modules/contextPanel/chat";
import { COMPOSER_BOUND_KEYS } from "../src/modules/contextPanel/composerKeyBindings";
import {
  bindEmbeddedPanelHost,
  bindStandalonePanelHost,
  clearPanelHostBinding,
  evaluatePanelOwnership,
  isPanelHostCompatibleWithPaper,
  getConversationScopeIdentityForTests,
  requireCurrentPanelOwnership,
  resolveSelectionSurfaceForBody,
  shouldOwnershipFenceSwallowEvent,
} from "../src/modules/contextPanel/panelHostOwnership";
import { createRuntimeSystemControls } from "../src/modules/contextPanel/runtimeSystemControls";
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

  it("allows empty library navigation while rejecting delayed paper work", function () {
    const panel = fakePanel({ conversationKey: 0 });
    panel.root.dataset.itemId = "";
    panel.root.dataset.conversationKind = "";
    bindEmbeddedPanelHost(panel.body, null, "library");
    assert.equal(evaluatePanelOwnership(panel.body), "match");
    assert.equal(
      evaluatePanelOwnership(panel.body, fakePaper(101)),
      "stale-candidate",
    );
    assert.isFalse(
      requireCurrentPanelOwnership(
        panel.body,
        fakePaper(101),
        "delayed-render",
      ),
    );
    assert.isUndefined(panel.root.dataset.ownershipBlocked);
    panel.root.dataset.libraryId = "2";
    assert.equal(evaluatePanelOwnership(panel.body), "unresolved");
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

  it("puts the standalone window on its own selection surface and every sidebar panel on the shared one", function () {
    const paper = fakePaper(101);
    const library = fakePanel({ conversationKey: 101, paperItemID: 101 });
    const reader = fakePanel({
      conversationKey: 101,
      paperItemID: 101,
      tabID: "reader-a",
    });
    const window = fakePanel({
      conversationKey: 101,
      paperItemID: 101,
      standalone: true,
    });
    bindEmbeddedPanelHost(library.body, paper, "library");
    bindEmbeddedPanelHost(reader.body, paper, "reader");
    assert.equal(resolveSelectionSurfaceForBody(library.body), "embedded");
    assert.equal(resolveSelectionSurfaceForBody(reader.body), "embedded");
    // Before the window binds its host, its panel root marks it.
    assert.equal(resolveSelectionSurfaceForBody(window.body), "standalone");
    bindStandalonePanelHost(window.body, paper);
    assert.equal(resolveSelectionSurfaceForBody(window.body), "standalone");
    assert.equal(resolveSelectionSurfaceForBody(null), "embedded");
    for (const panel of [library, reader, window]) {
      clearPanelHostBinding(panel.body);
    }
  });
});

/**
 * A DOM fake that evaluates the selector strings production actually ships.
 *
 * `matches` understands `#id` and `.class` simple selectors and comma lists of
 * them, and throws on anything else, so a selector the fence relies on can
 * never silently "match" here. The elements under test are built by the
 * production factory (`createRuntimeSystemControls`), so if the fence's
 * selector and the class names the panel or the standalone window render ever
 * drift apart, these tests fail.
 */
class SelectorElement {
  readonly nodeType = 1;
  id = "";
  className = "";
  title = "";
  type = "";
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly children: SelectorElement[] = [];
  parentElement: SelectorElement | null = null;
  private readonly attributes = new Map<string, string>();

  append(...children: SelectorElement[]): void {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  matches(selector: string): boolean {
    return selector
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .some((simple) => {
        if (simple.startsWith("#")) return this.id === simple.slice(1);
        if (simple.startsWith(".")) {
          return this.className.split(/\s+/).includes(simple.slice(1));
        }
        throw new Error(
          `SelectorElement cannot evaluate the selector "${simple}"`,
        );
      });
  }

  closest(selector: string): SelectorElement | null {
    let node: SelectorElement | null = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }
}

const selectorDocument = {
  createElementNS: () => new SelectorElement(),
} as unknown as Document;

function buildProductionRuntimeToggles(surface: "panel" | "standalone") {
  // The exact options the two surfaces pass in buildUI.ts and
  // standaloneWindow.ts.
  const controls =
    surface === "panel"
      ? createRuntimeSystemControls(selectorDocument, {
          groupId: "llm-runtime-system-controls",
          groupClassName: "llm-panel-runtime-system-controls",
          buttonClassName: "llm-panel-runtime-system-toggle",
          buttonIds: {
            codex: "llm-codex-system-toggle",
            claude_code: "llm-claude-system-toggle",
          },
        })
      : createRuntimeSystemControls(selectorDocument, {
          groupClassName: "llm-standalone-runtime-system-controls",
          buttonClassName: "llm-standalone-runtime-system-toggle",
        });
  const button = controls.buttons.codex as unknown as SelectorElement;
  return { button, icon: button.children[0] };
}

/** The composer, with a plain wrapper so nothing about it is a runtime control. */
function buildComposer(): SelectorElement {
  const section = new SelectorElement();
  section.className = "llm-input-section";
  const input = new SelectorElement();
  input.id = "llm-input";
  section.append(input);
  return input;
}

function fenceEvent(params: {
  type: string;
  target: unknown;
  key?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
}): Event {
  return {
    type: params.type,
    target: params.target,
    key: params.key,
    metaKey: params.metaKey === true,
    ctrlKey: params.ctrlKey === true,
    shiftKey: params.shiftKey === true,
  } as unknown as Event;
}

describe("panel ownership fence", function () {
  const originalZotero = globalThis.Zotero;

  beforeEach(function () {
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Prefs: { get: () => undefined },
      Items: { get: () => null },
      Libraries: { userLibraryID: 1 },
      Profile: { dir: "/tmp/zotero-profile" },
      Tabs: { selectedID: "reader-a" },
    } as typeof Zotero;
  });

  afterEach(function () {
    clearAllState();
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
  });

  /**
   * A panel whose verdict for `staleItem` is `stale-candidate`: the state in
   * which the fence refuses the panel's input.
   */
  function buildRefusingPanel() {
    const mountedItem = fakePaper(202);
    const staleItem = fakePaper(101);
    const panel = fakePanel({
      conversationKey: 202,
      paperItemID: 202,
      tabID: "reader-a",
    });
    bindEmbeddedPanelHost(panel.body, mountedItem, "reader");
    activeContextPanels.set(panel.body, () => mountedItem);
    assert.equal(
      evaluatePanelOwnership(panel.body, staleItem),
      "stale-candidate",
      "the fixture must be in the state where the fence refuses",
    );
    return { panel, staleItem, mountedItem };
  }

  it("swallows the panel's ordinary input while it does not own its conversation", function () {
    const { panel, staleItem } = buildRefusingPanel();
    const composer = buildComposer();

    for (const event of [
      fenceEvent({ type: "keydown", target: composer, key: "a" }),
      fenceEvent({ type: "input", target: composer }),
      fenceEvent({ type: "paste", target: composer }),
      fenceEvent({ type: "click", target: composer }),
    ]) {
      assert.isTrue(
        shouldOwnershipFenceSwallowEvent(panel.body, staleItem, event),
        `${event.type} must stay fenced`,
      );
    }
    clearPanelHostBinding(panel.body);
  });

  it("delivers the runtime controls both surfaces render", function () {
    const { panel, staleItem } = buildRefusingPanel();
    const sidebar = buildProductionRuntimeToggles("panel");
    const standalone = buildProductionRuntimeToggles("standalone");
    const modeToggle = new SelectorElement();
    modeToggle.id = "llm-runtime-mode-toggle";

    for (const target of [
      sidebar.button,
      // The click usually lands on the icon inside the button.
      sidebar.icon,
      standalone.button,
      standalone.icon,
      modeToggle,
    ]) {
      assert.isFalse(
        shouldOwnershipFenceSwallowEvent(
          panel.body,
          staleItem,
          fenceEvent({ type: "click", target }),
        ),
        "the controls that end the blocked state must be delivered",
      );
    }
    clearPanelHostBinding(panel.body);
  });

  it("delivers application accelerators but never the keys the composer binds", function () {
    const { panel, staleItem } = buildRefusingPanel();
    const composer = buildComposer();

    // The reported symptom: Cmd+Q with focus in the composer must reach Zotero.
    assert.isFalse(
      shouldOwnershipFenceSwallowEvent(
        panel.body,
        staleItem,
        fenceEvent({
          type: "keydown",
          target: composer,
          key: "q",
          metaKey: true,
        }),
      ),
      "Cmd+Q typed in the composer must leave the panel",
    );
    assert.isFalse(
      shouldOwnershipFenceSwallowEvent(
        panel.body,
        staleItem,
        fenceEvent({
          type: "keydown",
          target: composer,
          key: "w",
          ctrlKey: true,
        }),
      ),
      "Ctrl+W must leave the panel",
    );

    // Cmd+Enter is a send: the composer's Enter branch has no modifier
    // exclusion, so an exemption here would let a refusing panel write.
    assert.isTrue(
      shouldOwnershipFenceSwallowEvent(
        panel.body,
        staleItem,
        fenceEvent({
          type: "keydown",
          target: composer,
          key: "Enter",
          metaKey: true,
        }),
      ),
      "Cmd+Enter on the composer must stay fenced",
    );
    assert.isTrue(
      shouldOwnershipFenceSwallowEvent(
        panel.body,
        staleItem,
        fenceEvent({
          type: "keydown",
          target: buildComposer().parentElement,
          key: "Enter",
          metaKey: true,
        }),
      ),
      "Enter is never exempt, wherever it is aimed",
    );
    // Cmd+ArrowUp recalls the previous message into the composer.
    assert.isTrue(
      shouldOwnershipFenceSwallowEvent(
        panel.body,
        staleItem,
        fenceEvent({
          type: "keydown",
          target: composer,
          key: "ArrowUp",
          metaKey: true,
        }),
      ),
      "Cmd+ArrowUp on the composer must stay fenced",
    );
    clearPanelHostBinding(panel.body);
  });

  it("swallows nothing once the panel owns its conversation again", function () {
    const { panel, mountedItem } = buildRefusingPanel();
    const composer = buildComposer();

    assert.isFalse(
      shouldOwnershipFenceSwallowEvent(
        panel.body,
        mountedItem,
        fenceEvent({ type: "keydown", target: composer, key: "a" }),
      ),
    );
    clearPanelHostBinding(panel.body);
  });
});

/**
 * The composer's keydown handler in `setupHandlers.ts` is the owner of the keys
 * the panel binds, and `COMPOSER_BOUND_KEYS` is that handler's declaration of
 * them. The ownership fence reads the same declaration to decide which
 * accelerators it may exempt, so the two can only stay in step if the
 * declaration matches the handler. These cases read the handler's source and
 * hold it to that: a key bound in the handler but missing from the declaration
 * would be exempted by a modifier and reopen the write path the fence closes.
 */
describe("composer key bindings", function () {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const handlerPath = resolve(
    testDir,
    "..",
    "src/modules/contextPanel/setupHandlers.ts",
  );

  /**
   * The body of the composer's keydown handler, so a key comparison made by
   * some other listener in the same file is not mistaken for a composer
   * binding.
   */
  function composerKeydownHandlerSource(): string {
    const source = readFileSync(handlerPath, "utf8");
    const start = source.indexOf('inputBox.addEventListener("keydown"');
    assert.isAtLeast(
      start,
      0,
      "the composer keydown handler must still be registered on inputBox",
    );
    const end = source.indexOf("\n  });", start);
    assert.isAbove(
      end,
      start,
      "the composer keydown handler must end at its own indentation",
    );
    return source.slice(start, end);
  }

  function keysComparedInHandler(): string[] {
    const handler = composerKeydownHandlerSource();
    const keys = new Set<string>();
    for (const match of handler.matchAll(/\bke\.key === "([^"]+)"/g)) {
      keys.add(match[1]);
    }
    assert.isAtLeast(
      keys.size,
      1,
      "the handler must still compare keys by literal",
    );
    return [...keys].sort();
  }

  it("declares every key its keydown handler binds", function () {
    for (const key of keysComparedInHandler()) {
      assert.isTrue(
        COMPOSER_BOUND_KEYS.has(key),
        `the composer binds "${key}", so COMPOSER_BOUND_KEYS must list it or ` +
          `the ownership fence will exempt it under Cmd/Ctrl`,
      );
    }
  });

  it("declares nothing its keydown handler does not bind", function () {
    const bound = new Set(keysComparedInHandler());
    for (const key of COMPOSER_BOUND_KEYS) {
      assert.isTrue(
        bound.has(key),
        `COMPOSER_BOUND_KEYS lists "${key}", but the composer's keydown ` +
          `handler no longer binds it`,
      );
    }
  });

  it("is what the ownership fence keeps behind the fence", function () {
    const fenceSource = readFileSync(
      resolve(testDir, "..", "src/modules/contextPanel/panelHostOwnership.ts"),
      "utf8",
    );
    assert.notMatch(
      fenceSource,
      /PANEL_BOUND_KEYS/,
      "the fence must read the composer's declaration, not a second list",
    );
    assert.match(
      fenceSource,
      /COMPOSER_BOUND_KEYS/,
      "the fence must read the composer's declaration",
    );
  });
});
