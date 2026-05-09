import { assert } from "chai";
import { config } from "../package.json";
import {
  getConfiguredCodexAppServerBinaryPath,
  getEffectiveCodexAppServerBinaryPath,
} from "../src/codexAppServer/binaryPath";
import { setCodexBinaryPathPref } from "../src/codexAppServer/prefs";
import {
  setModelProviderGroups,
  type ModelProviderGroup,
} from "../src/utils/modelProviders";

let originalZotero: typeof Zotero | undefined;

function makeCodexProviderGroup(path: string): ModelProviderGroup {
  return {
    id: "provider-codex",
    apiBase: path,
    apiKey: "",
    authMode: "codex_app_server",
    providerProtocol: "codex_responses",
    models: [
      {
        id: "model-codex",
        model: "gpt-5.4",
        temperature: 0.3,
        maxTokens: 4096,
      },
    ],
  };
}

describe("codexAppServer binary path", function () {
  before(function () {
    originalZotero = globalThis.Zotero;
  });

  beforeEach(function () {
    const prefStore = new Map<string, unknown>();
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Prefs: {
        get: (key: string) => prefStore.get(key),
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      },
    } as typeof Zotero;
    prefStore.set(`${config.prefsPrefix}.modelProviderGroups`, "");
  });

  after(function () {
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
  });

  it("uses the selected provider path before global defaults", function () {
    setCodexBinaryPathPref("C:\\Global\\codex.cmd");
    setModelProviderGroups([makeCodexProviderGroup("C:\\Provider\\codex.cmd")]);

    assert.equal(
      getEffectiveCodexAppServerBinaryPath("C:\\Selected\\codex.cmd"),
      "C:\\Selected\\codex.cmd",
    );
  });

  it("uses the Agent Codex CLI path preference when no provider path is selected", function () {
    setCodexBinaryPathPref(
      "C:\\Users\\ocean\\AppData\\Roaming\\npm\\codex.cmd",
    );

    assert.equal(
      getEffectiveCodexAppServerBinaryPath(""),
      "C:\\Users\\ocean\\AppData\\Roaming\\npm\\codex.cmd",
    );
  });

  it("falls back to the visible provider-level Codex CLI Path", function () {
    setModelProviderGroups([
      makeCodexProviderGroup("C:\\nvm4w\\nodejs\\codex.cmd"),
    ]);

    assert.equal(
      getConfiguredCodexAppServerBinaryPath(),
      "C:\\nvm4w\\nodejs\\codex.cmd",
    );
  });

  it("leaves Codex auto-detection active when configured values are blank or URLs", function () {
    setCodexBinaryPathPref("https://chatgpt.com/backend-api/codex/responses");
    setModelProviderGroups([
      makeCodexProviderGroup("https://chatgpt.com/backend-api/codex/responses"),
    ]);

    assert.equal(getConfiguredCodexAppServerBinaryPath(), "");
  });
});
