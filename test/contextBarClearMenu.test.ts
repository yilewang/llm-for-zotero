import { assert } from "chai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isContextBarEmptyAreaTarget,
  syncContextBarClearMenuState,
} from "../src/modules/contextPanel/setupHandlers/controllers/contextBarClearMenuController";

const testDir = dirname(fileURLToPath(import.meta.url));

function source(path: string): string {
  return readFileSync(resolve(testDir, "..", path), "utf8");
}

class FakeClassList {
  private readonly values = new Set<string>();

  constructor(className = "") {
    for (const value of className.split(/\s+/)) {
      if (value) this.values.add(value);
    }
  }

  contains(value: string): boolean {
    return this.values.has(value);
  }
}

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly classList: FakeClassList;
  parentElement: FakeElement | null = null;
  hidden = false;
  disabled = false;

  constructor(readonly className = "") {
    this.classList = new FakeClassList(className);
  }

  appendChild(child: FakeElement): void {
    child.parentElement = this;
    this.children.push(child);
  }

  contains(target: FakeElement | null): boolean {
    if (!target) return false;
    if (target === this) return true;
    return this.children.some((child) => child.contains(target));
  }

  closest(selector: string): FakeElement | null {
    let cursor: FakeElement | null = this;
    const className = selector.startsWith(".") ? selector.slice(1) : selector;
    while (cursor) {
      if (cursor.classList.contains(className)) return cursor;
      cursor = cursor.parentElement;
    }
    return null;
  }
}

describe("context bar clear menu", function () {
  it("does not render the old explicit trash button", function () {
    const buildUiSource = source("src/modules/contextPanel/buildUI.ts");
    const cssSource = source("addon/content/zoteroPane.css");

    assert.notInclude(buildUiSource, "llm-context-clear-all");
    assert.notInclude(cssSource, "llm-context-clear-all");
  });

  it("opens only from empty context bar area, not chips or controls", function () {
    const contextBar = new FakeElement("llm-context-previews");
    const chip = new FakeElement("llm-paper-context-chip");
    const chipLabel = new FakeElement("llm-paper-context-chip-label");
    const runtimeToggle = new FakeElement("llm-context-agent-toggle");
    chip.appendChild(chipLabel);
    contextBar.appendChild(runtimeToggle);
    contextBar.appendChild(chip);

    assert.isTrue(
      isContextBarEmptyAreaTarget(
        contextBar as unknown as Element,
        contextBar as unknown as EventTarget,
      ),
    );
    assert.isFalse(
      isContextBarEmptyAreaTarget(
        contextBar as unknown as Element,
        chipLabel as unknown as EventTarget,
      ),
    );
    assert.isFalse(
      isContextBarEmptyAreaTarget(
        contextBar as unknown as Element,
        runtimeToggle as unknown as EventTarget,
      ),
    );
  });

  it("keeps the context menu option visible but disabled when nothing can clear", function () {
    const menu = new FakeElement() as unknown as HTMLDivElement;
    const clearButton = new FakeElement() as unknown as HTMLButtonElement;

    syncContextBarClearMenuState({
      menu,
      clearButton,
      hasContext: false,
    });

    assert.isFalse(menu.hidden);
    assert.isTrue(clearButton.disabled);

    syncContextBarClearMenuState({
      menu,
      clearButton,
      hasContext: true,
    });

    assert.isFalse(clearButton.disabled);
  });
});
