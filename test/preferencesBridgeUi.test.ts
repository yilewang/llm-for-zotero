import { assert } from "chai";
import { describe, it } from "mocha";
import { readFileSync } from "node:fs";
import { t } from "../src/utils/i18n";
import { getOriginalPermissionOptions } from "../src/shared/permissionOptions";

describe("bridge settings UI behavior", function () {
  it("persists bridge URL only on commit events", function () {
    const events: string[] = [];
    const commitBridgeUrl = () => {
      events.push("commit");
    };

    const inputListeners = new Map<string, () => void>();
    const input = {
      value: "http://127.0.0.1:19787",
      addEventListener(type: string, fn: () => void) {
        inputListeners.set(type, fn);
      },
    } as unknown as HTMLInputElement;

    input.addEventListener("change", commitBridgeUrl);
    input.addEventListener("blur", commitBridgeUrl);

    assert.isUndefined(inputListeners.get("input"));
    inputListeners.get("change")?.();
    inputListeners.get("blur")?.();
    assert.deepEqual(events, ["commit", "commit"]);
  });

  it("renders compact model input mode controls in advanced settings", function () {
    const preferenceScript = readFileSync(
      "src/modules/preferenceScript.ts",
      "utf8",
    );

    assert.include(preferenceScript, "getModelInputModeOptionsForRuntime");
    assert.include(preferenceScript, "INPUT_MODE_SELECT_SM_STYLE");
    assert.include(preferenceScript, 't("Input mode")');
    assert.include(preferenceScript, "inputModeOptions.length > 0");
    assert.include(preferenceScript, "normalizeModelInputModeForRuntime");
    assert.include(preferenceScript, "width: 108px");
  });

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
      assert.equal(
        t(
          "Requested actions run without review. Existing-note edits are applied and then shown as a diff. The agent asks only for genuine ambiguity in the request or for dangerous shell commands.",
        ),
        "请求的操作无需审核即可执行。对现有笔记的编辑会先应用，再以差异形式展示。仅在请求确有歧义或涉及危险的 shell 命令时，Agent 才会询问。",
      );
      // Reading the English text from the option catalog keeps the Chinese
      // string from silently falling back to English when the copy changes.
      const yolo = getOriginalPermissionOptions().find(
        (option) => option.selectionKey === "original:yolo",
      )!;
      assert.equal(
        t(yolo.description),
        "Agent 自行判断并执行，不再询问，且可以执行超出字面请求的操作。明确的禁止事项、受保护条目、数据库、计划完整性检查、仅限对话的记忆，以及导入已发现论文前的论文选择卡片仍然生效。同样适用于 Claude Code 或 Codex 调用的插件工具。",
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
      'id="__addonRef__-codex-app-server-card"',
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
});
