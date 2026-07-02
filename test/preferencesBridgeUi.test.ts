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

    assert.include(preferenceScript, "MODEL_INPUT_MODE_OPTIONS");
    assert.include(preferenceScript, "INPUT_MODE_SELECT_SM_STYLE");
    assert.include(preferenceScript, 't("Input mode")');
    assert.include(preferenceScript, "normalizeModelInputMode");
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
          "Temperature: randomness (0–2)  ·  Max tokens: output limit  ·  Input cap: context limit  ·  Input mode: auto/text-only/vision",
        ),
        "温度：随机性 (0–2)  ·  最大 Token 数：输出限制  ·  输入上限：上下文限制  ·  输入模式：自动/仅文本/视觉",
      );
    } finally {
      if (previousZotero) {
        globalWithZotero.Zotero = previousZotero;
      } else {
        delete globalWithZotero.Zotero;
      }
    }
  });
});
