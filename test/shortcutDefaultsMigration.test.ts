/// <reference types="zotero-types" />

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "chai";
import { after, beforeEach, describe, it } from "mocha";
import {
  BUILTIN_SHORTCUT_FILES,
  config,
} from "../src/modules/contextPanel/constants";
import {
  getCustomShortcuts,
  getDeletedShortcutIds,
  getShortcutLabelOverrides,
  getShortcutOrder,
  getShortcutOverrides,
  isKnownBuiltinDefaultLabel,
  isKnownBuiltinDefaultPrompt,
  migrateShortcutDefaultsIfNeeded,
  resetShortcutsToDefault,
  setCustomShortcuts,
  setDeletedShortcutIds,
  setShortcutLabelOverrides,
  setShortcutOrder,
  setShortcutOverrides,
} from "../src/modules/contextPanel/prefHelpers";

const here = dirname(fileURLToPath(import.meta.url));
const prefKey = (key: string) => `${config.prefsPrefix}.${key}`;

describe("shortcut defaults migration", function () {
  const originalZotero = globalThis.Zotero;
  let prefStore: Map<string, unknown>;
  let clearCalls: string[];

  function installPrefs(options: { clear?: boolean } = {}): void {
    const withClear = options.clear !== false;
    const prefs: {
      get: (key: string) => unknown;
      set: (key: string, value: unknown) => void;
      clear?: (key: string) => void;
    } = {
      get: (key: string) => prefStore.get(key),
      set: (key: string, value: unknown) => {
        prefStore.set(key, value);
      },
    };
    if (withClear) {
      prefs.clear = (key: string) => {
        clearCalls.push(key);
        prefStore.delete(key);
      };
    }

    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Prefs: prefs,
    } as typeof Zotero;
  }

  beforeEach(function () {
    prefStore = new Map();
    clearCalls = [];
    installPrefs();
  });

  after(function () {
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
  });

  it("removes an old unchanged built-in summary override", function () {
    setShortcutOverrides({
      summarize: "Summarize the document in 3-5 bullet points.",
    });

    migrateShortcutDefaultsIfNeeded();

    assert.notProperty(getShortcutOverrides(), "summarize");
  });

  it("preserves a customized built-in summary override", function () {
    setShortcutOverrides({
      summarize: "Explain this paper for a first-year PhD student.",
    });

    migrateShortcutDefaultsIfNeeded();

    assert.equal(
      getShortcutOverrides().summarize,
      "Explain this paper for a first-year PhD student.",
    );
  });

  it("restores the Diagram built-in when old saved state is missing it", function () {
    setShortcutOrder(["summarize", "key-points", "methodology", "limitations"]);
    setDeletedShortcutIds(["mermaid-diagram"]);

    migrateShortcutDefaultsIfNeeded();

    assert.include(getShortcutOrder(), "mermaid-diagram");
    assert.notInclude(getDeletedShortcutIds(), "mermaid-diagram");
  });

  it("reruns after the previous shortcut migration marker and repairs Diagram", function () {
    prefStore.set(prefKey("shortcutDefaultsMigrationVersion"), 1);
    setShortcutOrder(["summarize", "key-points", "methodology", "limitations"]);
    setDeletedShortcutIds(["mermaid-diagram"]);

    migrateShortcutDefaultsIfNeeded();

    assert.equal(prefStore.get(prefKey("shortcutDefaultsMigrationVersion")), 2);
    assert.include(getShortcutOrder(), "mermaid-diagram");
    assert.notInclude(getDeletedShortcutIds(), "mermaid-diagram");
  });

  it("does not override user deletions after the current migration marker", function () {
    prefStore.set(prefKey("shortcutDefaultsMigrationVersion"), 2);
    setDeletedShortcutIds(["mermaid-diagram"]);

    migrateShortcutDefaultsIfNeeded();

    assert.deepEqual(getDeletedShortcutIds(), ["mermaid-diagram"]);
  });

  it("preserves custom shortcuts including a custom Diagram label with a different prompt", function () {
    setCustomShortcuts([
      {
        id: "custom-shortcut-diagram",
        label: "Diagram",
        prompt: "Make a concept map focused only on methods.",
      },
    ]);

    migrateShortcutDefaultsIfNeeded();

    assert.deepEqual(getCustomShortcuts(), [
      {
        id: "custom-shortcut-diagram",
        label: "Diagram",
        prompt: "Make a concept map focused only on methods.",
      },
    ]);
  });

  it("dedupes order/custom state and prevents built-in ID collisions", function () {
    setDeletedShortcutIds([
      "summarize",
      "summarize",
      "unknown",
      "mermaid-diagram",
    ]);
    prefStore.set(
      prefKey("customShortcuts"),
      JSON.stringify([
        { id: "custom-shortcut-a", label: "A", prompt: "Prompt A" },
        { id: "custom-shortcut-a", label: "B", prompt: "Prompt B" },
        { id: "custom-shortcut-b", label: "A", prompt: "Prompt A" },
        { id: "summarize", label: "Bad", prompt: "Should not render" },
        {
          id: "custom-shortcut-c",
          label: "Diagram",
          prompt: "Different prompt",
        },
      ]),
    );
    setShortcutOrder([
      "custom-shortcut-a",
      "custom-shortcut-a",
      "summarize",
      "missing",
      "mermaid-diagram",
    ]);

    migrateShortcutDefaultsIfNeeded();

    assert.deepEqual(getDeletedShortcutIds(), ["summarize"]);
    assert.deepEqual(
      getCustomShortcuts().map((shortcut) => shortcut.id),
      ["custom-shortcut-a", "custom-shortcut-c"],
    );

    const order = getShortcutOrder();
    assert.lengthOf(order, new Set(order).size);
    assert.notInclude(order, "summarize");
    assert.notInclude(order, "missing");
    assert.include(order, "mermaid-diagram");
    assert.include(order, "custom-shortcut-a");
    assert.include(order, "custom-shortcut-c");
  });

  it("strips unmodified English and Chinese built-in default prompts and labels while preserving user edits", function () {
    setShortcutOverrides({
      summarize:
        "Give a one-sentence overview, then summarize the paper section by section under its own headings, with 1-3 sentences per section.",
      "key-points": "List the key points as concise bullet points.",
      methodology: "Custom methodology prompt in English.",
      limitations: "用中文解释这篇论文的局限性和潜在弱点。",
      "mermaid-diagram":
        "Generate a Mermaid flowchart to help me understand the paper's main idea, method, key findings, and conclusion.",
    });
    setShortcutLabelOverrides({
      summarize: "Summarize",
      "key-points": "要点",
      methodology: "My Method",
      limitations: "自定义局限",
      "mermaid-diagram": "流程图",
    });

    migrateShortcutDefaultsIfNeeded();

    assert.deepEqual(getShortcutOverrides(), {
      methodology: "Custom methodology prompt in English.",
    });
    assert.deepEqual(getShortcutLabelOverrides(), {
      methodology: "My Method",
      limitations: "自定义局限",
    });
    assert.isTrue(
      isKnownBuiltinDefaultPrompt(
        "summarize",
        "Give a concise narrative overview of the paper in 1-2 short paragraphs, covering the research question, approach, main findings, and significance.",
      ),
    );
    assert.isFalse(
      isKnownBuiltinDefaultPrompt(
        "summarize",
        "Summarize in 2 bullet points with focus on equations.",
      ),
    );
    assert.isTrue(isKnownBuiltinDefaultLabel("mermaid-diagram", "Diagram"));
    assert.isTrue(isKnownBuiltinDefaultLabel("mermaid-diagram", "流程图"));
    assert.isFalse(isKnownBuiltinDefaultLabel("mermaid-diagram", "My Flow"));
  });

  it("safely falls back to {} when shortcuts or shortcutLabels contain non-object JSON", function () {
    for (const rawValue of ["123", '"str"', "[1,2]", "true", "null"]) {
      prefStore.set(prefKey("shortcuts"), rawValue);
      prefStore.set(prefKey("shortcutLabels"), rawValue);

      assert.deepEqual(getShortcutOverrides(), {});
      assert.deepEqual(getShortcutLabelOverrides(), {});
    }
  });
});

describe("shortcut reset", function () {
  const originalZotero = globalThis.Zotero;
  let prefStore: Map<string, unknown>;
  let clearCalls: string[];

  function installPrefs(options: { clear?: boolean } = {}): void {
    const withClear = options.clear !== false;
    const prefs: {
      get: (key: string) => unknown;
      set: (key: string, value: unknown) => void;
      clear?: (key: string) => void;
    } = {
      get: (key: string) => prefStore.get(key),
      set: (key: string, value: unknown) => {
        prefStore.set(key, value);
      },
    };
    if (withClear) {
      prefs.clear = (key: string) => {
        clearCalls.push(key);
        prefStore.delete(key);
      };
    }

    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Prefs: prefs,
    } as typeof Zotero;
  }

  function seedShortcutPrefs(): void {
    prefStore.set(
      prefKey("shortcuts"),
      JSON.stringify({ summarize: "Custom" }),
    );
    prefStore.set(
      prefKey("shortcutLabels"),
      JSON.stringify({ summarize: "S" }),
    );
    prefStore.set(prefKey("shortcutDeleted"), JSON.stringify(["limitations"]));
    prefStore.set(
      prefKey("customShortcuts"),
      JSON.stringify([
        { id: "custom-shortcut-a", label: "A", prompt: "Prompt A" },
      ]),
    );
    prefStore.set(
      prefKey("shortcutOrder"),
      JSON.stringify(["custom-shortcut-a"]),
    );
  }

  beforeEach(function () {
    prefStore = new Map();
    clearCalls = [];
    installPrefs();
  });

  after(function () {
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
  });

  it("clears all shortcut prefs with Zotero.Prefs.clear when available", function () {
    seedShortcutPrefs();

    resetShortcutsToDefault();

    for (const key of [
      "shortcuts",
      "shortcutLabels",
      "shortcutDeleted",
      "customShortcuts",
      "shortcutOrder",
    ]) {
      assert.isFalse(prefStore.has(prefKey(key)), `${key} should be cleared`);
      assert.include(clearCalls, prefKey(key));
    }
  });

  it("falls back to empty shortcut values when Prefs.clear is unavailable", function () {
    installPrefs({ clear: false });
    seedShortcutPrefs();

    resetShortcutsToDefault();

    assert.deepEqual(getShortcutOverrides(), {});
    assert.deepEqual(getDeletedShortcutIds(), []);
    assert.deepEqual(getCustomShortcuts(), []);
    assert.deepEqual(getShortcutOrder(), []);
  });

  it("resets to the current five built-in shortcut identities", function () {
    seedShortcutPrefs();

    resetShortcutsToDefault();

    assert.deepEqual(
      BUILTIN_SHORTCUT_FILES.map((shortcut) => shortcut.id),
      [
        "summarize",
        "key-points",
        "methodology",
        "limitations",
        "mermaid-diagram",
      ],
    );
    assert.equal(BUILTIN_SHORTCUT_FILES.length, 5);
    assert.deepEqual(getShortcutOverrides(), {});
    assert.deepEqual(getDeletedShortcutIds(), []);
    assert.deepEqual(getCustomShortcuts(), []);
  });

  it("clears cached shortcut prompt text during the UI reset path", function () {
    const source = readFileSync(
      resolve(here, "../src/modules/contextPanel/shortcuts.ts"),
      "utf8",
    );

    assert.match(
      source,
      /resetShortcutsToDefault\(\);\s*shortcutTextCache\.clear\(\);/s,
    );
  });
});
