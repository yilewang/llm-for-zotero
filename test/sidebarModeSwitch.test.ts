import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "chai";
import { describe, it } from "mocha";
import {
  createSidebarModeSwitch,
  syncSidebarModeSwitch,
  type SidebarModeSwitchState,
} from "../src/modules/contextPanel/sidebarModeSwitch";
import { WEBCHAT_TARGETS } from "../src/webchat/types";
import {
  collectFakeText,
  fakeDocument,
  type FakeElement,
} from "./helpers/fakeDom";

/**
 * The Stacked layout's mode chip: its DOM and how it follows the panel's mode.
 * Hover, focus and keyboard are exercised live in
 * test-workflows/sidebarChatModeToggle.workflow.test.ts.
 */
describe("sidebar mode switch (the Stacked mode chip)", function () {
  const paperState: SidebarModeSwitchState = {
    activeTab: "paper",
    paperLabel: "Paper chat",
    libraryLabel: "Library chat",
    disabled: false,
  };
  const fitLabels = ["Paper chat", "Library chat", "Note chat"];

  function build(state: SidebarModeSwitchState = paperState): FakeElement {
    return createSidebarModeSwitch(fakeDocument, state, {
      ariaLabel: "Chat mode",
      fitLabels,
    }) as unknown as FakeElement;
  }

  function option(capsule: FakeElement, tab: "paper" | "library") {
    const match = capsule
      .findAllByClass("llm-mode-switch-option")
      .find((node) => node.dataset.tab === tab);
    assert.isOk(match, `${tab} option is rendered`);
    return match as FakeElement & { tabIndex?: number };
  }

  function label(node: FakeElement): string {
    return node.findByClass("llm-mode-switch-label")?.textContent || "";
  }

  it("builds the chip closed, showing the current mode", function () {
    const capsule = build();
    assert.equal(capsule.id, "llm-mode-capsule");
    assert.isTrue(capsule.classList.contains("llm-mode-switch"));
    assert.equal(capsule.getAttribute("role"), "group");
    assert.equal(capsule.getAttribute("aria-label"), "Chat mode");
    assert.equal(capsule.dataset.expanded, "false");
    assert.equal(capsule.dataset.mode, "paper");
    assert.equal(capsule.dataset.static, "false");
    // Track and pill are decoration; the two options are the controls.
    for (const part of ["llm-mode-switch-track", "llm-mode-switch-thumb"]) {
      const node = capsule.findByClass(part);
      assert.isOk(node, part);
      assert.equal(node!.getAttribute("aria-hidden"), "true");
    }
    const paper = option(capsule, "paper");
    const library = option(capsule, "library");
    assert.equal(paper.tagName, "button");
    assert.equal(paper.type, "button");
    assert.equal(label(paper), "Paper chat");
    assert.equal(label(library), "Library chat");
    assert.equal(paper.getAttribute("aria-pressed"), "true");
    assert.equal(library.getAttribute("aria-pressed"), "false");
    // Closed, only the chip itself is a tab stop.
    assert.equal(paper.tabIndex, 0);
    assert.equal(library.tabIndex, -1);
    assert.isFalse(paper.disabled);
    assert.isFalse(library.disabled);
  });

  it("stays a plain chip inside the header capsule, with no caret", function () {
    const capsule = build();
    // The capsule header wraps this element as it is: hover opens the switch,
    // and the sizer keeps the chip one width. No caret marks it as a menu.
    assert.isOk(capsule.findByClass("llm-mode-switch-sizer"));
    assert.isUndefined(
      capsule.findByClass("llm-mode-switch-caret") ?? undefined,
    );
    assert.notInclude(
      collectFakeText(capsule as never),
      "\u25be",
      "no caret glyph in the chip",
    );
  });

  it("sizes the chip to every label its paper slot can show", function () {
    const capsule = build();
    const sizer = capsule.findByClass("llm-mode-switch-sizer");
    assert.isOk(sizer);
    assert.equal(sizer!.getAttribute("aria-hidden"), "true");
    const entries = sizer!.children.map((child) => collectFakeText(child));
    for (const text of fitLabels) assert.include(entries, text);
    // WebChat shows its site with the connection dot in the same slot.
    for (const target of WEBCHAT_TARGETS) {
      const entry = sizer!.children.find(
        (child) => collectFakeText(child) === target.displayName,
      );
      assert.isOk(entry, target.displayName);
      assert.isOk(entry!.findByClass("llm-webchat-dot"), "with its dot");
    }
  });

  it("follows the mode it is synced to, whichever control changed it", function () {
    const capsule = build();
    syncSidebarModeSwitch(capsule as unknown as HTMLElement, {
      ...paperState,
      activeTab: "library",
    });
    assert.equal(capsule.dataset.mode, "library");
    assert.equal(
      option(capsule, "paper").getAttribute("aria-pressed"),
      "false",
    );
    assert.equal(
      option(capsule, "library").getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(option(capsule, "paper").tabIndex, -1);
    assert.equal(option(capsule, "library").tabIndex, 0);
  });

  it("keeps both options reachable while the switch is open", function () {
    const capsule = build();
    capsule.dataset.expanded = "true";
    syncSidebarModeSwitch(capsule as unknown as HTMLElement, paperState);
    assert.equal(option(capsule, "paper").tabIndex, 0);
    assert.equal(option(capsule, "library").tabIndex, 0);
  });

  it("holds a note session's chip static and closes an open switch", function () {
    const capsule = build();
    capsule.dataset.expanded = "true";
    syncSidebarModeSwitch(capsule as unknown as HTMLElement, {
      ...paperState,
      paperLabel: "Note chat",
      disabled: true,
    });
    assert.equal(capsule.dataset.static, "true");
    assert.equal(capsule.dataset.expanded, "false");
    assert.equal(label(option(capsule, "paper")), "Note chat");
    assert.isTrue(option(capsule, "paper").disabled);
    assert.isTrue(option(capsule, "library").disabled);
    assert.equal(option(capsule, "library").tabIndex, -1);

    syncSidebarModeSwitch(capsule as unknown as HTMLElement, paperState);
    assert.equal(capsule.dataset.static, "false");
    assert.equal(label(option(capsule, "paper")), "Paper chat");
    assert.isFalse(option(capsule, "paper").disabled);
  });

  it("names the WebChat site in the paper slot's tooltip only while shown", function () {
    const capsule = build();
    syncSidebarModeSwitch(capsule as unknown as HTMLElement, {
      ...paperState,
      paperLabel: "chatgpt",
      paperTitle: "ChatGPT Web Sync (chatgpt.com)",
      disabled: true,
    });
    const paper = option(capsule, "paper");
    assert.equal(label(paper), "chatgpt");
    assert.equal(paper.title, "ChatGPT Web Sync (chatgpt.com)");
    syncSidebarModeSwitch(capsule as unknown as HTMLElement, paperState);
    assert.equal(paper.title, "");
    assert.equal(option(capsule, "library").title, "");
  });
});
