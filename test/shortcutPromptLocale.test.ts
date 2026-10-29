/// <reference types="zotero-types" />

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "chai";
import { after, beforeEach, describe, it } from "mocha";
import {
  BUILTIN_SHORTCUT_FILES,
  config,
} from "../src/modules/contextPanel/constants";
import {
  resetShortcutsToDefault,
  setCustomShortcuts,
  setDeletedShortcutIds,
  setShortcutLabelOverrides,
  setShortcutOverrides,
} from "../src/modules/contextPanel/prefHelpers";
import {
  loadShortcutText,
  renderShortcuts,
} from "../src/modules/contextPanel/shortcuts";
import { shortcutTextCache } from "../src/modules/contextPanel/state";
import { initI18n } from "../src/utils/i18n";

const here = dirname(fileURLToPath(import.meta.url));

type FakeResponse = { ok: boolean; text: () => Promise<string> };

interface FakeElement {
  nodeType: number;
  tagName: string;
  className: string;
  type: string;
  textContent: string;
  title: string;
  value: string;
  disabled: boolean;
  draggable: boolean;
  dataset: Record<string, string>;
  style: Record<string, string>;
  children: FakeElement[];
  parentElement: FakeElement | null;
  onclick?: (e: unknown) => unknown;
  oncontextmenu?: (e: unknown) => unknown;
  ondragstart?: (e: unknown) => unknown;
  ondragenter?: (e: unknown) => unknown;
  ondragover?: (e: unknown) => unknown;
  ondragleave?: (e: unknown) => unknown;
  ondrop?: (e: unknown) => unknown;
  ondragend?: (e: unknown) => unknown;
  innerHTML: string;
  classList: {
    add: (cls: string) => void;
    remove: (cls: string) => void;
  };
  appendChild: (child: FakeElement) => FakeElement;
  contains: (node: FakeElement | null) => boolean;
  closest: (selector: string) => FakeElement | null;
  querySelector: (selector: string) => FakeElement | null;
  querySelectorAll: (selector: string) => FakeElement[];
  addEventListener: () => void;
  click: () => void;
}

function createFakeElement(tagName = "div"): FakeElement {
  const classes = new Set<string>();
  let innerText = "";
  const el: FakeElement = {
    nodeType: 1,
    tagName,
    get className() {
      return Array.from(classes).join(" ");
    },
    set className(val: string) {
      classes.clear();
      for (const token of val.split(/\s+/).filter(Boolean)) {
        classes.add(token);
      }
    },
    type: "",
    get textContent() {
      if (el.children.length > 0) {
        return el.children.map((c) => c.textContent).join("");
      }
      return innerText;
    },
    set textContent(val: string) {
      innerText = val;
      if (val === "") {
        el.children = [];
      }
    },
    title: "",
    value: "",
    disabled: false,
    draggable: false,
    dataset: {},
    style: {},
    children: [],
    parentElement: null,
    get innerHTML() {
      return "";
    },
    set innerHTML(_val: string) {
      el.children = [];
      innerText = "";
    },
    classList: {
      add: (cls: string) => {
        classes.add(cls);
      },
      remove: (cls: string) => {
        classes.delete(cls);
      },
    },
    appendChild(child: FakeElement) {
      child.parentElement = el;
      el.children.push(child);
      return child;
    },
    contains(node: FakeElement | null): boolean {
      let cur: FakeElement | null = node;
      while (cur) {
        if (cur === el) return true;
        cur = cur.parentElement;
      }
      return false;
    },
    closest(selector: string): FakeElement | null {
      let cur: FakeElement | null = el;
      while (cur) {
        if (
          selector === ".llm-shortcut-btn" &&
          cur.className.split(/\s+/).includes("llm-shortcut-btn")
        ) {
          return cur;
        }
        cur = cur.parentElement;
      }
      return null;
    },
    querySelector(selector: string): FakeElement | null {
      return el.querySelectorAll(selector)[0] || null;
    },
    querySelectorAll(selector: string): FakeElement[] {
      const results: FakeElement[] = [];
      const match = (node: FakeElement): boolean => {
        if (selector === ".llm-shortcut-btn") {
          return node.className.split(/\s+/).includes("llm-shortcut-btn");
        }
        const idMatch = selector.match(
          /^\.llm-shortcut-btn\[data-shortcut-id="([^"]+)"\]$/,
        );
        if (idMatch) {
          return (
            node.className.split(/\s+/).includes("llm-shortcut-btn") &&
            node.dataset.shortcutId === idMatch[1]
          );
        }
        if (selector === ".llm-shortcut-drop-target") {
          return node.className
            .split(/\s+/)
            .includes("llm-shortcut-drop-target");
        }
        return false;
      };
      const visit = (node: FakeElement) => {
        for (const child of node.children) {
          if (match(child)) results.push(child);
          visit(child);
        }
      };
      visit(el);
      return results;
    },
    addEventListener() {},
    click() {},
  };
  return el;
}

describe("built-in shortcut prompt locale", function () {
  const globals = globalThis as typeof globalThis & {
    Zotero?: typeof Zotero;
    ztoolkit?: unknown;
  };
  const originalZotero = globals.Zotero;
  const originalToolkit = globals.ztoolkit;
  const englishUri = `chrome://${config.addonRef}/content/shortcuts/summarize.txt`;
  const chineseUri = `chrome://${config.addonRef}/content/shortcuts/zh-CN/summarize.txt`;
  let prefStore: Map<string, unknown>;
  let responses: Map<string, FakeResponse>;
  let fetched: string[];

  function install(locale: string, localePref?: string): void {
    prefStore = new Map();
    if (localePref !== undefined) {
      prefStore.set("extensions.zotero.llmforzotero.locale", localePref);
    }
    globals.Zotero = {
      locale,
      Prefs: {
        get: (key: string) => prefStore.get(key),
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
        clear: (key: string) => {
          prefStore.delete(key);
        },
      },
    } as unknown as typeof Zotero;
    initI18n();
  }

  function loadDiskShortcutResponses(): void {
    responses.clear();
    for (const shortcut of BUILTIN_SHORTCUT_FILES) {
      const enPath = resolve(here, "../addon/content/shortcuts", shortcut.file);
      const zhPath = resolve(
        here,
        "../addon/content/shortcuts/zh-CN",
        shortcut.file,
      );
      const enText = readFileSync(enPath, "utf8");
      const zhText = readFileSync(zhPath, "utf8");
      responses.set(
        `chrome://${config.addonRef}/content/shortcuts/${shortcut.file}`,
        { ok: true, text: async () => enText },
      );
      responses.set(
        `chrome://${config.addonRef}/content/shortcuts/zh-CN/${shortcut.file}`,
        { ok: true, text: async () => zhText },
      );
    }
  }

  function createPanelFixture() {
    const body = createFakeElement("div");
    const container = createFakeElement("div");
    const menu = createFakeElement("div");
    const menuEdit = createFakeElement("button");
    const menuDelete = createFakeElement("button");
    const menuAdd = createFakeElement("button");
    const menuMove = createFakeElement("button");
    const menuReset = createFakeElement("button");
    const inputBox = createFakeElement("textarea");
    const sendBtn = createFakeElement("button");
    const statusEl = createFakeElement("div");
    let sendClicks = 0;
    sendBtn.click = () => {
      sendClicks += 1;
    };

    const bySelector = new Map<string, FakeElement>([
      ["#llm-shortcuts", container],
      ["#llm-shortcut-menu", menu],
      ["#llm-shortcut-menu-edit", menuEdit],
      ["#llm-shortcut-menu-delete", menuDelete],
      ["#llm-shortcut-menu-add", menuAdd],
      ["#llm-shortcut-menu-move", menuMove],
      ["#llm-shortcut-menu-reset", menuReset],
      ["#llm-input", inputBox],
      ["#llm-send", sendBtn],
      ["#llm-status", statusEl],
    ]);

    body.querySelector = (sel: string) => bySelector.get(sel) || null;
    (body as unknown as { ownerDocument: unknown }).ownerDocument = {
      createElementNS: (_ns: string, tag: string) => createFakeElement(tag),
      addEventListener: () => {},
    };

    const item = {
      id: 42,
      isNote: () => false,
    } as unknown as Zotero.Item;

    return {
      body: body as unknown as Element,
      container,
      menuEdit,
      menuDelete,
      menuAdd,
      menuMove,
      menuReset,
      inputBox,
      getSendClicks: () => sendClicks,
      item,
    };
  }

  beforeEach(function () {
    shortcutTextCache.clear();
    fetched = [];
    responses = new Map([
      [englishUri, { ok: true, text: async () => "English prompt" }],
      [chineseUri, { ok: true, text: async () => "中文提示" }],
    ]);
    const fakeFetch = async (uri: string): Promise<FakeResponse> => {
      fetched.push(uri);
      const response = responses.get(uri);
      if (!response) throw new Error(`not found: ${uri}`);
      return response;
    };
    globals.ztoolkit = {
      getGlobal: (name: string) => (name === "fetch" ? fakeFetch : undefined),
    };
  });

  after(function () {
    globals.Zotero = originalZotero;
    globals.ztoolkit = originalToolkit;
    shortcutTextCache.clear();
    initI18n();
  });

  it("fetches only the English prompt for an English locale", async function () {
    install("en-US");
    const text = await loadShortcutText("summarize.txt");
    assert.equal(text, "English prompt");
    assert.deepEqual(fetched, [englishUri]);
  });

  it("fetches the zh-CN prompt when the plugin language is Chinese", async function () {
    install("en-US", "zh-CN");
    const text = await loadShortcutText("summarize.txt");
    assert.equal(text, "中文提示");
    assert.deepEqual(fetched, [chineseUri]);
  });

  it("falls back to the English prompt when the zh-CN file is missing", async function () {
    install("en-US", "zh-CN");
    responses.set(chineseUri, { ok: false, text: async () => "" });
    const text = await loadShortcutText("summarize.txt");
    assert.equal(text, "English prompt");
    assert.deepEqual(fetched, [chineseUri, englishUri]);
  });

  it("falls back to the English prompt when the zh-CN fetch throws", async function () {
    install("en-US", "zh-CN");
    responses.delete(chineseUri);
    const text = await loadShortcutText("summarize.txt");
    assert.equal(text, "English prompt");
    assert.deepEqual(fetched, [chineseUri, englishUri]);
  });

  it("caches prompts per locale key", async function () {
    install("zh-CN", "auto");
    assert.equal(await loadShortcutText("summarize.txt"), "中文提示");
    assert.equal(await loadShortcutText("summarize.txt"), "中文提示");
    assert.deepEqual(fetched, [chineseUri]);

    install("en-US", "en-US");
    assert.equal(await loadShortcutText("summarize.txt"), "English prompt");
    assert.equal(await loadShortcutText("summarize.txt"), "English prompt");
    assert.deepEqual(fetched, [chineseUri, englishUri]);
  });

  it("still throws when the English prompt cannot be loaded", async function () {
    install("en-US");
    responses.set(englishUri, { ok: false, text: async () => "" });
    let error: unknown;
    try {
      await loadShortcutText("summarize.txt");
    } catch (caught) {
      error = caught;
    }
    assert.instanceOf(error, Error);
    assert.match((error as Error).message, /Failed to load summarize\.txt/);
  });

  it("ships a non-empty zh-CN prompt for every built-in shortcut with required constraints", function () {
    for (const shortcut of BUILTIN_SHORTCUT_FILES) {
      const enPath = resolve(here, "../addon/content/shortcuts", shortcut.file);
      const zhPath = resolve(
        here,
        "../addon/content/shortcuts/zh-CN",
        shortcut.file,
      );
      assert.isTrue(existsSync(enPath), `missing ${shortcut.file}`);
      assert.isTrue(existsSync(zhPath), `missing zh-CN/${shortcut.file}`);
      const enContent = readFileSync(enPath, "utf8").trim();
      const zhContent = readFileSync(zhPath, "utf8").trim();
      assert.isNotEmpty(enContent);
      assert.isNotEmpty(zhContent);
      if (shortcut.id === "mermaid-diagram") {
        assert.include(enContent, "classDef/class");
        assert.include(zhContent, "classDef/class");
      }
      if (shortcut.id === "summarize") {
        assert.include(enContent, "1-3 sentences per section");
        assert.include(zhContent, "每节 1-3 句");
      }
    }
  });

  it("renders Chinese built-in shortcut labels and prompts on first install in zh-CN UI", async function () {
    install("zh-CN", "auto");
    loadDiskShortcutResponses();
    const {
      body,
      container,
      menuEdit,
      menuDelete,
      menuAdd,
      menuMove,
      menuReset,
      item,
    } = createPanelFixture();

    await renderShortcuts(body, item);

    const buttons = container.children;
    assert.deepEqual(
      buttons.map((b) => b.dataset.label),
      ["摘要", "要点", "方法论", "局限性", "流程图"],
    );
    assert.deepEqual(
      buttons.map((b) => b.textContent),
      ["摘要", "要点", "方法论", "局限性", "流程图"],
    );
    assert.include(buttons[0].dataset.prompt, "用中文先以一句话概述论文");
    assert.include(buttons[4].dataset.prompt, "生成一个 Mermaid 流程图");
    assert.equal(menuEdit.textContent, "编辑");
    assert.equal(menuDelete.textContent, "删除");
    assert.equal(menuAdd.textContent, "添加");
    assert.equal(menuMove.textContent, "移动");
    assert.equal(menuReset.textContent, "重置");
  });

  it("renders English built-in shortcut labels and prompts on first install in en-US UI", async function () {
    install("en-US", "auto");
    loadDiskShortcutResponses();
    const { body, container, item } = createPanelFixture();

    await renderShortcuts(body, item);

    const buttons = container.children;
    assert.deepEqual(
      buttons.map((b) => b.dataset.label),
      ["Summarize", "Key Points", "Methodology", "Limitations", "Diagram"],
    );
    assert.include(
      buttons[0].dataset.prompt,
      "Give a one-sentence overview, then summarize the paper section by section",
    );
    assert.include(
      buttons[4].dataset.prompt,
      "Generate a Mermaid flowchart to help me understand the paper's main idea",
    );
  });

  it("falls back to English labels and prompts for other locales (fr-FR, de-DE)", async function () {
    for (const locale of ["fr-FR", "de-DE"]) {
      install(locale, "auto");
      loadDiskShortcutResponses();
      const { body, container, item } = createPanelFixture();

      await renderShortcuts(body, item);

      const buttons = container.children;
      assert.deepEqual(
        buttons.map((b) => b.dataset.label),
        ["Summarize", "Key Points", "Methodology", "Limitations", "Diagram"],
      );
      assert.include(
        buttons[0].dataset.prompt,
        "Give a one-sentence overview, then summarize the paper section by section",
      );
    }
  });

  it("dynamically switches built-in labels and prompts when toggling UI language between en-US and zh-CN", async function () {
    install("en-US", "en-US");
    loadDiskShortcutResponses();
    const { body, container, item } = createPanelFixture();

    await renderShortcuts(body, item);
    assert.deepEqual(
      container.children.map((b) => b.dataset.label),
      ["Summarize", "Key Points", "Methodology", "Limitations", "Diagram"],
    );
    assert.include(
      container.children[1].dataset.prompt,
      "List the key points as concise bullet points.",
    );

    // Switch preference to zh-CN dynamically without restarting
    prefStore.set("extensions.zotero.llmforzotero.locale", "zh-CN");
    await renderShortcuts(body, item);
    assert.deepEqual(
      container.children.map((b) => b.dataset.label),
      ["摘要", "要点", "方法论", "局限性", "流程图"],
    );
    assert.equal(
      container.children[1].dataset.prompt,
      "用中文以简明的要点列出这篇论文的关键点。",
    );

    // Switch back to en-US
    prefStore.set("extensions.zotero.llmforzotero.locale", "en-US");
    await renderShortcuts(body, item);
    assert.deepEqual(
      container.children.map((b) => b.dataset.label),
      ["Summarize", "Key Points", "Methodology", "Limitations", "Diagram"],
    );
  });

  it("preserves user-customized built-in prompts/labels and custom shortcuts across language switches", async function () {
    install("en-US", "en-US");
    loadDiskShortcutResponses();
    setShortcutOverrides({
      summarize: "My custom English summary instruction.",
    });
    setShortcutLabelOverrides({
      summarize: "My Summary",
    });
    setCustomShortcuts([
      {
        id: "custom-shortcut-1",
        label: "Reviewer 2",
        prompt: "Critique the statistical power of the experiments.",
      },
    ]);

    const { body, container, item } = createPanelFixture();
    await renderShortcuts(body, item);

    // Switch to zh-CN
    prefStore.set("extensions.zotero.llmforzotero.locale", "zh-CN");
    await renderShortcuts(body, item);

    const byId = new Map(
      container.children.map((b) => [b.dataset.shortcutId, b]),
    );
    // Customized built-in stays intact
    assert.equal(byId.get("summarize")?.dataset.label, "My Summary");
    assert.equal(
      byId.get("summarize")?.dataset.prompt,
      "My custom English summary instruction.",
    );
    // Unmodified built-in switches to Chinese
    assert.equal(byId.get("key-points")?.dataset.label, "要点");
    assert.equal(
      byId.get("key-points")?.dataset.prompt,
      "用中文以简明的要点列出这篇论文的关键点。",
    );
    // Custom shortcut stays intact
    assert.equal(byId.get("custom-shortcut-1")?.dataset.label, "Reviewer 2");
    assert.equal(
      byId.get("custom-shortcut-1")?.dataset.prompt,
      "Critique the statistical power of the experiments.",
    );
  });

  it("restores default templates in the current UI language when resetShortcutsToDefault is called", async function () {
    install("zh-CN", "zh-CN");
    loadDiskShortcutResponses();
    setShortcutOverrides({ summarize: "Custom override" });
    setShortcutLabelOverrides({ summarize: "Custom label" });
    setDeletedShortcutIds(["limitations"]);
    setCustomShortcuts([
      { id: "custom-shortcut-1", label: "Extra", prompt: "Extra prompt" },
    ]);

    const { body, container, item } = createPanelFixture();
    resetShortcutsToDefault();
    shortcutTextCache.clear();
    await renderShortcuts(body, item);

    assert.deepEqual(
      container.children.map((b) => b.dataset.label),
      ["摘要", "要点", "方法论", "局限性", "流程图"],
    );
    assert.include(
      container.children[0].dataset.prompt,
      "用中文先以一句话概述论文",
    );
  });

  it("does not resurrect deleted built-in shortcuts when switching UI language", async function () {
    install("en-US", "en-US");
    loadDiskShortcutResponses();
    const { body, container, item } = createPanelFixture();
    await renderShortcuts(body, item);

    // User deletes methodology and limitations after migration
    setDeletedShortcutIds(["methodology", "limitations"]);
    await renderShortcuts(body, item);
    assert.deepEqual(
      container.children.map((b) => b.dataset.shortcutId),
      ["summarize", "key-points", "mermaid-diagram"],
    );

    // Switch to zh-CN
    prefStore.set("extensions.zotero.llmforzotero.locale", "zh-CN");
    await renderShortcuts(body, item);
    assert.deepEqual(
      container.children.map((b) => b.dataset.shortcutId),
      ["summarize", "key-points", "mermaid-diagram"],
    );
    assert.deepEqual(
      container.children.map((b) => b.dataset.label),
      ["摘要", "要点", "流程图"],
    );
  });

  it("migrates unmodified legacy English defaults in prefs to follow zh-CN while keeping user-edited English overrides", async function () {
    install("zh-CN", "zh-CN");
    loadDiskShortcutResponses();
    // Simulate a legacy installation that persisted unmodified English defaults for summarize & key-points,
    // plus a genuinely user-edited English prompt for methodology
    setShortcutOverrides({
      summarize:
        "Give a one-sentence overview, then summarize the paper section by section under its own headings, with 1-3 sentences per section.",
      "key-points": "List the key points as concise bullet points.",
      methodology: "Explain the experimental setup and baseline comparisons.",
    });
    setShortcutLabelOverrides({
      summarize: "Summarize",
      "key-points": "Key Points",
    });

    const { body, container, item } = createPanelFixture();
    await renderShortcuts(body, item);

    const byId = new Map(
      container.children.map((b) => [b.dataset.shortcutId, b]),
    );
    assert.equal(byId.get("summarize")?.dataset.label, "摘要");
    assert.include(
      byId.get("summarize")?.dataset.prompt,
      "用中文先以一句话概述论文",
    );
    assert.equal(byId.get("key-points")?.dataset.label, "要点");
    assert.equal(
      byId.get("key-points")?.dataset.prompt,
      "用中文以简明的要点列出这篇论文的关键点。",
    );
    assert.equal(byId.get("methodology")?.dataset.label, "方法论");
    assert.equal(
      byId.get("methodology")?.dataset.prompt,
      "Explain the experimental setup and baseline comparisons.",
    );
  });

  it("populates #llm-input with the resolved localized prompt and triggers #llm-send on click", async function () {
    install("zh-CN", "zh-CN");
    loadDiskShortcutResponses();
    const { body, container, inputBox, getSendClicks, item } =
      createPanelFixture();

    await renderShortcuts(body, item);

    const diagramBtn = container.children.find(
      (b) => b.dataset.shortcutId === "mermaid-diagram",
    );
    assert.isDefined(diagramBtn);
    container.onclick?.({
      target: diagramBtn,
      preventDefault: () => {},
      stopPropagation: () => {},
    });

    assert.equal(inputBox.value, diagramBtn!.dataset.prompt);
    assert.include(inputBox.value, "生成一个 Mermaid 流程图");
    assert.include(inputBox.value, "classDef/class");
    assert.equal(getSendClicks(), 1);
  });

  it("resets effective locale to auto (following Zotero.locale) when locale pref is cleared", async function () {
    install("zh-CN", "en-US");
    loadDiskShortcutResponses();
    const { body, container, item } = createPanelFixture();

    await renderShortcuts(body, item);
    assert.deepEqual(
      container.children.map((b) => b.dataset.label),
      ["Summarize", "Key Points", "Methodology", "Limitations", "Diagram"],
    );

    // Clear the explicit locale preference; effective locale should fall back to Zotero.locale ("zh-CN")
    prefStore.delete("extensions.zotero.llmforzotero.locale");
    await renderShortcuts(body, item);
    assert.deepEqual(
      container.children.map((b) => b.dataset.label),
      ["摘要", "要点", "方法论", "局限性", "流程图"],
    );
  });
});
