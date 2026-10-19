import { assert } from "chai";
import { describe, it } from "mocha";
import { readFileSync } from "node:fs";
import { t } from "../src/utils/i18n";
import { getOriginalPermissionOptions } from "../src/shared/permissionOptions";

describe("bridge settings UI behavior", function () {
  it("translates model input mode preference strings in Chinese locale", function () {
    const globalWithZotero = globalThis as typeof globalThis & {
      Zotero?: { locale?: string };
    };
    const previousZotero = globalWithZotero.Zotero;
    globalWithZotero.Zotero = { locale: "zh-CN" };

    try {
      assert.equal(t("Input mode"), "输入模式");
      assert.equal(t("Text only"), "仅文本");
      assert.equal(t("Vision allowed"), "允许视觉");
      assert.equal(
        t(
          "Temperature: randomness (0–2)  ·  Edited Max tokens and set Input cap override detected/default limits  ·  Input mode: auto/text-only/vision",
        ),
        "温度：随机性 (0–2)  ·  编辑后的最大 Token 数和已设置的输入上限会覆盖检测值/默认值  ·  输入模式：自动/仅文本/视觉",
      );
      assert.equal(
        t(
          "Temperature: randomness (0–2)  ·  Edited Max tokens and set Input cap override detected/default limits",
        ),
        "温度：随机性 (0–2)  ·  编辑后的最大 Token 数和已设置的输入上限会覆盖检测值/默认值",
      );
    } finally {
      if (previousZotero) {
        globalWithZotero.Zotero = previousZotero;
      } else {
        delete globalWithZotero.Zotero;
      }
    }
  });

  it("translates the Original Agent permission instructions precisely", function () {
    const globalWithZotero = globalThis as typeof globalThis & {
      Zotero?: { locale?: string };
    };
    const previousZotero = globalWithZotero.Zotero;
    globalWithZotero.Zotero = { locale: "zh-CN" };

    try {
      assert.equal(t("Original Agent Mode"), "原生 Agent 模式");
      assert.equal(t("Permission mode"), "权限模式");
      const options = getOriginalPermissionOptions();
      const safe = options.find(
        (option) => option.selectionKey === "original:safe",
      )!;
      assert.equal(
        t(safe.description),
        "所有外部写入（包括创建新笔记）在执行前都会显示以供审核。读取操作无需审核。",
      );
      // Reading the English text from the option catalog keeps the Chinese
      // string from silently falling back to English when the copy changes.
      const yolo = options.find(
        (option) => option.selectionKey === "original:yolo",
      )!;
      assert.equal(
        t(yolo.description),
        "原生 Agent 执行操作时不会请求权限确认或调用审批模型，包括有歧义或危险的操作。用户要求的审核流程、执行完整性及所发现论文的选择卡片仍然有效。Claude Code、Codex 和外部 MCP 调用方保留各自的权限控制。",
      );
    } finally {
      if (previousZotero) {
        globalWithZotero.Zotero = previousZotero;
      } else {
        delete globalWithZotero.Zotero;
      }
    }
  });

  it("groups Original Agent controls and Tavily in one card", function () {
    const preferences = readFileSync("addon/content/preferences.xhtml", "utf8");
    const originalAgentCardStart = preferences.indexOf(
      'id="__addonRef__-original-agent-card"',
    );
    const originalAgentCardEnd = preferences.indexOf(
      'id="__addonRef__-deepseek-harness-card"',
    );
    const originalAgentCard = preferences.slice(
      originalAgentCardStart,
      originalAgentCardEnd,
    );

    assert.isAtLeast(originalAgentCardStart, 0);
    assert.isAbove(originalAgentCardEnd, originalAgentCardStart);
    assert.include(originalAgentCard, 'id="__addonRef__-enable-agent-mode"');
    assert.include(
      originalAgentCard,
      'id="__addonRef__-original-agent-permission-mode"',
    );
    assert.include(originalAgentCard, 'id="__addonRef__-tavily-card"');
  });

  it("gives DeepSeek Harness its own sibling card and controls", function () {
    const preferences = readFileSync("addon/content/preferences.xhtml", "utf8");
    const originalStart = preferences.indexOf(
      'id="__addonRef__-original-agent-card"',
    );
    const harnessStart = preferences.indexOf(
      'id="__addonRef__-deepseek-harness-card"',
    );
    const codexStart = preferences.indexOf(
      'id="__addonRef__-codex-app-server-card"',
    );
    assert.isAbove(harnessStart, originalStart);
    assert.isAbove(codexStart, harnessStart);
    const original = preferences.slice(originalStart, harnessStart);
    const harness = preferences.slice(harnessStart, codexStart);
    assert.notInclude(original, 'id="__addonRef__-deepseek-harness-node-path"');
    for (const id of [
      "enable-deepseek-harness",
      "deepseek-harness-node-path",
      "deepseek-harness-worker-path",
    ]) {
      assert.include(harness, `id="__addonRef__-${id}"`);
    }
    assert.include(
      harness,
      'aria-controls="__addonRef__-agent-row-harness-body"',
    );
    assert.notInclude(preferences, 'id="__addonRef__-agent-execution-engine"');
  });
});
