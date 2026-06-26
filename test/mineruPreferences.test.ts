import { assert } from "chai";
import { readFileSync } from "fs";

describe("MinerU preferences", function () {
  let preferences = "";
  let preferenceScript = "";
  let prefs = "";
  let i18n = "";

  before(function () {
    preferences = readFileSync("addon/content/preferences.xhtml", "utf8");
    preferenceScript = readFileSync("src/modules/preferenceScript.ts", "utf8");
    prefs = readFileSync("addon/prefs.js", "utf8");
    i18n = readFileSync("src/utils/i18n.ts", "utf8");
  });

  it("renders a segmented cloud/local mode chooser instead of the old local checkbox", function () {
    assert.include(preferences, "__addonRef__-mineru-mode-segmented");
    assert.include(preferences, 'role="group"');
    assert.include(preferences, 'aria-label="MinerU parsing mode"');
    assert.include(preferences, 'id="__addonRef__-mineru-mode-cloud"');
    assert.include(preferences, 'data-mineru-mode="cloud"');
    assert.include(preferences, 'id="__addonRef__-mineru-mode-local"');
    assert.include(preferences, 'data-mineru-mode="local"');
    assert.include(preferences, ">Cloud</html:button");
    assert.include(preferences, ">Local</html:button");
    assert.notInclude(preferences, "Use local MinerU server");
  });

  it("keeps segmented mode chooser labels translatable", function () {
    assert.include(i18n, '"MinerU parsing mode"');
    assert.include(i18n, "Cloud:");
    assert.include(i18n, "Local:");
  });

  it("renders a cloud parsing model selector with the supported cloud models", function () {
    assert.include(preferences, "__addonRef__-mineru-cloud-model-section");
    assert.include(preferences, 'for="__addonRef__-mineru-cloud-model"');
    assert.include(preferences, 'id="__addonRef__-mineru-cloud-model"');
    assert.include(preferences, '<html:option value="pipeline">pipeline');
    assert.include(preferences, '<html:option value="vlm">vlm (recommended)');
    assert.include(preferences, "vlm uses a vision-language model");
    assert.include(prefs, 'pref("mineruCloudModel", "vlm");');
  });

  it("renders a shared force OCR option for MinerU parsing", function () {
    assert.include(preferences, 'for="__addonRef__-mineru-force-ocr"');
    assert.include(preferences, 'id="__addonRef__-mineru-force-ocr"');
    assert.include(preferences, "Force OCR");
    assert.include(
      preferences,
      "Use OCR even when MinerU would normally auto-detect PDF text.",
    );
    assert.include(prefs, 'pref("mineruForceOcr", false);');
  });

  it("marks MinerU cloud keys as required and removes keyless proxy copy", function () {
    assert.include(preferences, "An API key is required.");
    assert.include(preferences, "API Key (Required)");
    assert.include(preferences, 'id="__addonRef__-mineru-api-key"');
    assert.include(preferences, 'type="password"');
    assert.notInclude(preferences, "__addonRef__-mineru-api-key-copy");
    assert.notInclude(preferences, "Copy MinerU API key");
    assert.include(preferences, "Connects directly to mineru.net.");
    assert.notInclude(preferences, "No API key needed to start");
    assert.notInclude(
      preferences,
      "The built-in MinerU API may no longer be supported",
    );
  });

  it("wires the cloud parsing model selector in the preference script", function () {
    assert.include(preferenceScript, "getMineruCloudModel");
    assert.include(preferenceScript, "setMineruCloudModel");
    assert.include(preferenceScript, "normalizeMineruCloudModel");
    assert.include(preferenceScript, "type MineruCloudModel");
    assert.include(preferenceScript, "mineruCloudModeButton");
    assert.include(preferenceScript, "mineruLocalModeButton");
    assert.include(preferenceScript, "applyMineruModeButtonState");
    assert.include(preferenceScript, "getSelectedMineruApiKeyText");
    assert.include(
      preferenceScript,
      'mineruApiKeyInput.addEventListener("copy"',
    );
    assert.include(preferenceScript, 'clipboardData.setData("text/plain"');
    assert.notInclude(preferenceScript, "mineruApiKeyCopyButton");
    assert.notInclude(
      preferenceScript,
      "copyTextToClipboard(mineruApiKeyInput.value)",
    );
    assert.notInclude(i18n, "Copied MinerU API key");
    assert.include(preferenceScript, "mineruCloudModelSection");
    assert.include(preferenceScript, "mineruCloudModelSelect");
    assert.include(preferenceScript, "mineruCloudModelSection.style.display");
    assert.include(preferenceScript, "mineruForceOcrInput");
    assert.include(preferenceScript, "isMineruForceOcrEnabled");
    assert.include(preferenceScript, "setMineruForceOcrEnabled");
    assert.include(preferenceScript, 'mode === "cloud" ? "flex" : "none"');
    assert.include(preferenceScript, "Enter your MinerU API key first");
    assert.notInclude(preferenceScript, "mineruLocalModeInput");
    assert.notInclude(preferenceScript, "testProxyConnection");
  });
});
