import { assert } from "chai";
import { describe, it } from "mocha";
import { readFileSync } from "node:fs";
import { t } from "../src/utils/i18n";

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

  it("translates the library write mode copy around its literal mode names", function () {
    const globalWithZotero = globalThis as typeof globalThis & {
      Zotero?: { locale?: string };
    };
    const previousZotero = globalWithZotero.Zotero;
    globalWithZotero.Zotero = { locale: "zh-CN" };

    try {
      assert.equal(t("Library Write Mode"), "文献库写入模式");
      assert.equal(
        t(
          "reviews every library change before it happens, and batch jobs pause on each page.",
        ),
        "会在每次更改文献库之前进行审核，批处理任务会在每一页暂停。",
      );
      assert.equal(
        t(
          "lets the agent apply changes on its own judgement, including whole-library batch jobs — every run is still recorded and can be reverted from the agent history. This is separate from the Claude Code permission mode, which governs the bridge only.",
        ),
        "允许 Agent 自主判断并应用更改，包括整个文献库的批处理任务——每次运行仍会被记录，并可从 Agent 历史记录中撤销。此模式与 Claude Code 权限模式相互独立；后者仅控制桥接服务。",
      );
      assert.equal(t("safe"), "安全");
      assert.equal(t("yolo"), "全自动");
    } finally {
      if (previousZotero) {
        globalWithZotero.Zotero = previousZotero;
      } else {
        delete globalWithZotero.Zotero;
      }
    }
  });
});
