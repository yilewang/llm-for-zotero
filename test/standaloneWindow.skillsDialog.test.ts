import { assert } from "chai";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { showStandaloneConfirmationDialog } from "../src/modules/contextPanel/standaloneConfirmationDialog";
import { showShortcutEditDialog } from "../src/modules/contextPanel/shortcutEditDialog";

class FakeEvent {
  defaultPrevented = false;
  propagationStopped = false;
  target: FakeElement | null = null;

  constructor(
    readonly type: string,
    readonly key = "",
  ) {}

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.propagationStopped = true;
  }
}

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly style: Record<string, string> = {};
  private readonly listeners = new Map<
    string,
    Array<(event: FakeEvent) => void>
  >();
  parentElement: FakeElement | null = null;
  className = "";
  id = "";
  textContent = "";
  type = "";
  value = "";
  maxLength = 0;
  disabled = false;
  selected = false;

  constructor(
    readonly ownerDocument: FakeDocument,
    readonly tagName: string,
  ) {}

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) this.appendChild(node);
  }

  appendChild(child: FakeElement): FakeElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  remove(): void {
    const parent = this.parentElement;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children.splice(index, 1);
    this.parentElement = null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event: FakeEvent): boolean {
    event.target ??= this;
    for (const listener of this.listeners.get(event.type) || []) {
      listener(event);
    }
    return !event.defaultPrevented;
  }

  click(): void {
    this.dispatchEvent(new FakeEvent("click"));
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
  }

  select(): void {
    this.selected = true;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const matches: FakeElement[] = [];
    for (const child of this.children) {
      if (matchesSelector(child, selector)) matches.push(child);
      matches.push(...child.querySelectorAll(selector));
    }
    return matches;
  }
}

class FakeDocument {
  readonly body = new FakeElement(this, "body");
  readonly documentElement = new FakeElement(this, "html");
  private readonly listeners = new Map<
    string,
    Array<(event: FakeEvent) => void>
  >();
  activeElement: FakeElement | null = null;

  createElementNS(_namespace: string, tagName: string): FakeElement {
    return new FakeElement(this, tagName.toLowerCase());
  }

  addEventListener(
    type: string,
    listener: (event: FakeEvent) => void,
    _options?: unknown,
  ): void {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(
    type: string,
    listener: (event: FakeEvent) => void,
    _options?: unknown,
  ): void {
    const listeners = this.listeners.get(type) || [];
    this.listeners.set(
      type,
      listeners.filter((entry) => entry !== listener),
    );
  }

  dispatchEvent(event: FakeEvent): boolean {
    for (const listener of this.listeners.get(event.type) || []) {
      listener(event);
    }
    return !event.defaultPrevented;
  }
}

function matchesSelector(element: FakeElement, selector: string): boolean {
  if (selector.startsWith(".")) {
    return element.className.split(/\s+/).includes(selector.slice(1));
  }
  if (selector.startsWith("#")) {
    return element.id === selector.slice(1);
  }
  return false;
}

describe("standalone skills restore confirmation", function () {
  function createRestoreDialog(doc: FakeDocument): Promise<boolean> {
    return showStandaloneConfirmationDialog(doc as unknown as Document, {
      title: "Restore skill to default?",
      message:
        "Restore evidence-based-qa to the shipped default? Your customizations in this file will be lost.",
      confirmLabel: "Restore",
      cancelLabel: "Cancel",
      destructive: true,
    });
  }

  function readRestoreHandlerSource(): string {
    const source = readFileSync(
      resolve("src/modules/contextPanel/standaloneWindow.ts"),
      "utf8",
    );
    const start = source.indexOf(
      "// Context menu: Restore to default (customized built-ins only)",
    );
    const end = source.indexOf("// Context menu: Delete", start);
    assert.isAtLeast(start, 0, "restore handler marker should exist");
    assert.isAbove(
      end,
      start,
      "restore handler should end before delete handler",
    );
    return source.slice(start, end);
  }

  it("uses an in-window dialog with a meaningful title instead of native confirm", function () {
    const restoreHandler = readRestoreHandlerSource();

    assert.notInclude(restoreHandler, ".confirm(");
    assert.include(restoreHandler, "showStandaloneConfirmationDialog");
    assert.include(restoreHandler, "Restore skill to default?");
  });

  it("renders a titled in-window restore dialog and resolves on restore", async function () {
    const doc = new FakeDocument();
    const result = createRestoreDialog(doc);

    const overlay = doc.body.querySelector(".llm-standalone-confirm-overlay");
    assert.isNotNull(overlay);
    assert.equal(
      overlay?.querySelector(".llm-standalone-confirm-title")?.textContent,
      "Restore skill to default?",
    );
    assert.include(
      overlay?.querySelector(".llm-standalone-confirm-message")?.textContent ||
        "",
      "evidence-based-qa",
    );
    assert.equal(doc.activeElement?.textContent, "Cancel");

    overlay?.querySelector(".llm-standalone-confirm-primary")?.click();

    assert.isTrue(await result);
    assert.isNull(doc.body.querySelector(".llm-standalone-confirm-overlay"));
  });

  it("cancels the restore dialog on Escape", async function () {
    const doc = new FakeDocument();
    const result = createRestoreDialog(doc);

    const event = new FakeEvent("keydown", "Escape");
    doc.dispatchEvent(event);

    assert.isFalse(await result);
    assert.isTrue(event.defaultPrevented);
    assert.isTrue(event.propagationStopped);
    assert.isNull(doc.body.querySelector(".llm-standalone-confirm-overlay"));
  });

  it("cancels when the reference design's backdrop is clicked", async function () {
    const doc = new FakeDocument();
    const result = createRestoreDialog(doc);
    const overlay = doc.body.querySelector(".llm-standalone-confirm-overlay");

    overlay?.click();
    assert.isFalse(await result);
    assert.isNull(doc.body.querySelector(".llm-standalone-confirm-overlay"));
  });
});

describe("shortcut edit dialog", function () {
  it("uses the reference document modal and returns edited fields", async function () {
    const doc = new FakeDocument();
    const result = showShortcutEditDialog(doc as unknown as Document, {
      title: "Edit Shortcut",
      initialLabel: "Summarize",
      initialPrompt: "",
      labelText: "Label",
      promptText: "Prompt",
      confirmLabel: "Save",
      cancelLabel: "Cancel",
    });

    const overlay = doc.body.querySelector(".llm-shortcut-edit-overlay");
    assert.equal(overlay?.parentElement, doc.body);
    const controls =
      overlay?.querySelectorAll(".llm-shortcut-edit-control") || [];
    const confirm = overlay?.querySelector(".llm-modal-primary");
    assert.lengthOf(controls, 2);
    assert.equal(doc.activeElement, controls[0]);
    assert.isTrue(controls[0].selected);
    assert.isTrue(confirm?.disabled);

    controls[1].value = "Summarize the selected paper";
    controls[1].dispatchEvent(new FakeEvent("input"));
    assert.isFalse(confirm?.disabled);
    overlay
      ?.querySelector(".llm-shortcut-edit-form")
      ?.dispatchEvent(new FakeEvent("submit"));

    assert.deepEqual(await result, {
      label: "Summarize",
      prompt: "Summarize the selected paper",
    });
    assert.isNull(doc.body.querySelector(".llm-shortcut-edit-overlay"));
  });
});
