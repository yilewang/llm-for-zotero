import { assert } from "chai";
import {
  createStandaloneSidebarView,
  setStandaloneSidebarCollapsedChromeHost,
  setStandaloneSidebarFlyoutOpen,
  setStandaloneSidebarState,
} from "../src/modules/contextPanel/standaloneSidebarView";

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  parentElement: FakeElement | null = null;
  className = "";
  id = "";
  textContent = "";
  title = "";
  type = "";
  tabIndex = -1;

  constructor(readonly tagName: string) {}

  private adopt(child: FakeElement): void {
    child.parentElement?.removeChild(child);
    child.parentElement = this;
  }

  removeChild(child: FakeElement): void {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    if (child.parentElement === this) child.parentElement = null;
  }

  append(...children: FakeElement[]): void {
    for (const child of children) {
      this.adopt(child);
      this.children.push(child);
    }
  }

  prepend(...children: FakeElement[]): void {
    for (const child of [...children].reverse()) {
      this.adopt(child);
      this.children.unshift(child);
    }
  }

  appendChild(child: FakeElement): FakeElement {
    this.adopt(child);
    this.children.push(child);
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
}

class FakeDocument {
  createElementNS(_namespace: string, tagName: string): FakeElement {
    return new FakeElement(tagName);
  }
}

function createView() {
  return createStandaloneSidebarView(
    new FakeDocument() as unknown as Document,
    (value) => value,
  );
}

describe("standalone sidebar view", function () {
  it("reserves the header row for the native window buttons and the collapse toggle", function () {
    const view = createView();

    assert.deepEqual(view.header.children, [
      view.windowButtons,
      view.toggleButton,
    ]);
    assert.include(view.windowButtons.className, "llm-window-buttons");
    assert.equal(view.windowButtons.getAttribute("aria-hidden"), "true");
  });

  it("no longer renders a library icon or library name in the header", function () {
    const view = createView();

    const rendered = JSON.stringify(view.panel, (key, value) =>
      key === "parentElement" ? undefined : value,
    );
    assert.notInclude(rendered, "llm-standalone-library-icon");
    assert.notInclude(rendered, "llm-standalone-library-name");
    assert.notInclude(rendered, "My Library");
  });

  it("keeps New chat, Search history, and Skills in the top navigation", function () {
    const view = createView();

    assert.deepEqual(
      view.primaryNavigation.children.flatMap((child) =>
        child.dataset.sidebarAction
          ? [child.dataset.sidebarAction]
          : child.children
              .map((nested) => nested.dataset.sidebarAction)
              .filter(Boolean),
      ),
      ["new-chat", "search-history", "skills"],
    );
    assert.deepEqual(
      [
        view.newChatLabel,
        view.searchButton.children[1],
        view.skillsLabel,
        view.preferencesLabel,
      ].map((label) => label.textContent),
      ["New chat", "Search history", "Skills", "Preferences"],
    );
    assert.deepEqual(view.panel.children, [
      view.header,
      view.primaryNavigation,
      view.historyRegion,
      view.preferencesRegion,
    ]);
    assert.equal(view.preferencesRegion.children[0], view.footerDivider);
    assert.equal(view.preferencesRegion.children[1], view.preferencesButton);
  });

  it("does not render a Chats label or an independently collapsible section", function () {
    const view = createView();

    assert.equal(view.searchButton.dataset.sidebarAction, "search-history");
    assert.equal(
      view.searchButton.getAttribute("aria-label"),
      "Search history",
    );
    assert.notInclude(
      JSON.stringify(view.panel, (key, value) =>
        key === "parentElement" ? undefined : value,
      ),
      "chat-section-state",
    );
  });

  it("uses one stateful sidebar for expanded and collapsed presentation", function () {
    const view = createView();

    setStandaloneSidebarState(view, "collapsed");
    assert.equal(view.root.dataset.sidebarState, "collapsed");
    assert.equal(
      view.toggleButton.getAttribute("aria-label"),
      "Expand sidebar",
    );
    assert.equal(view.toggleButton.getAttribute("aria-expanded"), "false");

    setStandaloneSidebarState(view, "expanded");
    assert.equal(view.root.dataset.sidebarState, "expanded");
    assert.equal(
      view.toggleButton.getAttribute("aria-label"),
      "Collapse sidebar",
    );
    assert.equal(view.toggleButton.getAttribute("aria-expanded"), "true");
  });

  it("hands the window controls and the collapse toggle to the tab row when collapsed", function () {
    const view = createView();
    const tabRowLeading = new FakeElement("div");
    setStandaloneSidebarCollapsedChromeHost(
      view,
      tabRowLeading as unknown as HTMLElement,
    );
    const runtimeControls = new FakeElement("div");
    tabRowLeading.append(runtimeControls);

    setStandaloneSidebarState(view, "collapsed");

    // The rail is gone entirely while collapsed, so nothing may be left
    // behind in it: both the traffic lights and the toggle move out.
    assert.deepEqual(tabRowLeading.children, [
      view.windowButtons,
      view.toggleButton,
      runtimeControls,
    ]);
    assert.deepEqual(view.header.children, []);
  });

  it("returns the window controls and the toggle to the header when the rail expands", function () {
    const view = createView();
    const tabRowLeading = new FakeElement("div");
    setStandaloneSidebarCollapsedChromeHost(
      view,
      tabRowLeading as unknown as HTMLElement,
    );

    setStandaloneSidebarState(view, "collapsed");
    setStandaloneSidebarState(view, "expanded");

    assert.deepEqual(tabRowLeading.children, []);
    assert.deepEqual(view.header.children, [
      view.windowButtons,
      view.toggleButton,
    ]);
  });

  it("keeps the header intact when no tab row host is offered", function () {
    const view = createView();

    setStandaloneSidebarState(view, "collapsed");

    assert.deepEqual(view.header.children, [
      view.windowButtons,
      view.toggleButton,
    ]);
  });

  it("tracks the hover flyout separately from the permanent state", function () {
    const view = createView();
    setStandaloneSidebarState(view, "collapsed");

    setStandaloneSidebarFlyoutOpen(view, true);
    assert.equal(view.root.dataset.sidebarFlyout, "open");
    assert.equal(view.toggleButton.getAttribute("aria-expanded"), "true");
    assert.equal(view.root.dataset.sidebarState, "collapsed");

    setStandaloneSidebarFlyoutOpen(view, false);
    assert.equal(view.root.dataset.sidebarFlyout, "closed");
    assert.equal(view.toggleButton.getAttribute("aria-expanded"), "false");
  });

  it("dismisses an open flyout as soon as the sidebar state changes", function () {
    const view = createView();
    setStandaloneSidebarState(view, "collapsed");
    setStandaloneSidebarFlyoutOpen(view, true);

    setStandaloneSidebarState(view, "expanded");

    assert.equal(view.root.dataset.sidebarFlyout, "closed");
  });
});
