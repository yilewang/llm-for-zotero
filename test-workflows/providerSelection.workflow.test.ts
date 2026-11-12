import { assert } from "chai";
import {
  getModelProviderGroups,
  getRuntimeModelEntries,
  setModelProviderGroups,
} from "../src/utils/modelProviders";
import { resolveProviderTransportEndpoint } from "../src/utils/providerTransport";
import type { ProviderProtocol } from "../src/utils/providerProtocol";
import type { ProviderPresetId } from "../src/utils/providerPresets";

const prefix = "extensions.zotero.llmforzotero";
const groupId = "workflow-provider-selection";
const presetSelector = `#llmforzotero-provider-preset-${groupId}`;
const urlSelector = `#llmforzotero-api-base-${groupId}`;

async function waitFor(condition: () => boolean, message: string) {
  const deadline = Date.now() + 10000;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.isTrue(condition(), message);
}

async function openPreferences(): Promise<Window> {
  const win = (
    Zotero.Utilities.Internal as unknown as {
      openPreferences: (pane: string) => Window;
    }
  ).openPreferences("llmforzotero-preferences");
  await waitFor(
    () => Boolean(win.document.querySelector(presetSelector)),
    "provider preferences should render",
  );
  return win;
}

async function closePreferences(win: Window) {
  win.close();
  await waitFor(() => win.closed, "preferences should finish closing");
}

function changeValue(
  element: HTMLInputElement | HTMLSelectElement,
  value: string,
  type: string,
) {
  element.value = value;
  const event = element.ownerDocument.createEvent("Event");
  event.initEvent(type, true, false);
  element.dispatchEvent(event);
}

async function assertIconLoads(win: Window, icon: Element, asset: string) {
  const style = win.getComputedStyle(icon)!;
  const image =
    style.backgroundImage !== "none" ? style.backgroundImage : style.maskImage;
  assert.include(image, asset, "native CSS resolves the bundled asset");
  const url = image.match(/url\(["']?(.*?)["']?\)/)![1];
  const img = win.document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "img",
  ) as HTMLImageElement;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error(`Could not load ${asset}`));
    img.src = url;
  });
  assert.isAbove(img.naturalWidth, 0, "SVG decodes in Zotero");
}

describe("workflow: explicit provider selection", function () {
  this.timeout(30000);

  it("renders bundled logos and refreshes the header when switching presets", async function () {
    const keys = [
      "modelProviderGroups",
      "modelProviderGroupsMigrationVersion",
      "lastUsedModelEntryId",
      "outputTokenAutoMigrationNoticePending",
    ];
    const previous = new Map(
      keys.map((key) => [key, Zotero.Prefs.get(`${prefix}.${key}`, true)]),
    );
    let win: Window | undefined;
    try {
      setModelProviderGroups([
        {
          id: groupId,
          authMode: "api_key",
          apiBase: "https://api.openai.com/v1",
          apiKey: "",
          presetIdOverride: "openai",
          providerProtocol: "openai_chat_compat",
          models: [
            {
              id: "workflow-logo-model",
              model: "demo-model",
              temperature: 0.3,
              outputTokenLimit: { mode: "auto" },
            },
          ],
        },
        {
          id: "workflow-webchat-icon",
          authMode: "webchat",
          providerProtocol: "web_sync",
          models: ["chatgpt.com", "chat.deepseek.com"].map((model, index) => ({
            id: `workflow-webchat-model-${index}`,
            model,
            temperature: 0.3,
            outputTokenLimit: { mode: "auto" as const },
          })),
        },
      ]);
      win = await openPreferences();
      for (const [preset, modifier, label, asset] of [
        ["openai", "preset-openai", "OpenAI · API", "providers/openai.svg"],
        ["gemini", "preset-gemini", "Gemini · API", "providers/gemini.svg"],
        ["customized", "provider", "Customized · API", "custom-api.svg"],
      ]) {
        const select = win.document.querySelector(
          presetSelector,
        ) as HTMLSelectElement;
        if (select.value !== preset) {
          changeValue(select, preset, "change");
          await waitFor(
            () => !select.isConnected,
            "preset selection rerenders the card",
          );
        }
        const row = win.document.querySelector(
          `[data-llm-provider-row="${groupId}"]`,
        )!;
        const icon = row.querySelector(`.llm-pref-row-icon--${modifier}`)!;
        assert.isOk(icon, `${preset} header icon`);
        assert.include(
          row.querySelector(".llm-pref-row-sub")!.textContent!,
          label,
        );
        await assertIconLoads(win, icon, asset);
        const toggle = row.querySelector(
          ".llm-pref-row-toggle",
        ) as HTMLButtonElement;
        if (row.getAttribute("data-open") === "true") toggle.click();
        toggle.click();
        assert.equal(row.getAttribute("data-open"), "true");
        toggle.click();
        assert.equal(row.getAttribute("data-open"), "false");
      }
      await closePreferences(win);
      win = await openPreferences();
      assert.isOk(
        win.document.querySelector(".llm-pref-row-icon--provider"),
        "customized icon survives reopening",
      );
      const webchatIcon = win.document.querySelector(
        ".llm-pref-row-icon--webchat",
      )!;
      assert.isOk(webchatIcon, "mixed WebChat keeps its generic icon");
      assert.equal(
        win.getComputedStyle(webchatIcon)!.maskImage,
        "none",
        "WebChat artwork retains its colors",
      );
      await assertIconLoads(win, webchatIcon, "webchat-connection.svg");
    } finally {
      if (win && !win.closed) await closePreferences(win);
      for (const [key, value] of previous) {
        if (value === undefined) Zotero.Prefs.clear(`${prefix}.${key}`, true);
        else Zotero.Prefs.set(`${prefix}.${key}`, value, true);
      }
    }
  });

  for (const scenario of [
    {
      preset: "opencode",
      url: "https://opencode.ai/zen/v1",
      protocol: "anthropic_messages",
      model: "claude-sonnet-4-6",
      levels: ["low", "medium", "high", "max", "none"],
    },
    {
      preset: "opencode_go",
      url: "https://opencode.ai/zen/go/v1",
      protocol: "anthropic_messages",
      model: "claude-sonnet-4-6",
      levels: ["low", "medium", "high", "max", "none"],
    },
    {
      preset: "local_openai",
      url: "http://localhost:1234/v1",
      protocol: "openai_chat_compat",
      model: "qwen3-8b",
      levels: ["off", "on"],
    },
    {
      preset: "ollama",
      url: "http://localhost:11434",
      protocol: "ollama_native",
      model: "qwen3:8b",
      levels: ["minimal", "default"],
    },
  ]) {
    it(`preserves ${scenario.preset} reasoning levels when editing and reopening preferences`, async function () {
      const keys = [
        "modelProviderGroups",
        "modelProviderGroupsMigrationVersion",
        "lastUsedModelEntryId",
        "outputTokenAutoMigrationNoticePending",
      ];
      const previous = new Map(
        keys.map((key) => [key, Zotero.Prefs.get(`${prefix}.${key}`, true)]),
      );
      let win: Window | undefined;
      try {
        setModelProviderGroups([
          {
            id: groupId,
            authMode: "api_key",
            apiBase: scenario.url,
            apiKey: "",
            presetIdOverride: scenario.preset as ProviderPresetId,
            providerProtocol: scenario.protocol as ProviderProtocol,
            models: [
              {
                id: "workflow-reasoning-model",
                model: scenario.model,
                temperature: 0.3,
                outputTokenLimit: { mode: "auto" },
              },
            ],
          },
        ]);
        const openAdvanced = () => {
          const row = win!.document.querySelector(
            `[data-llm-provider-row="${groupId}"]`,
          )!;
          if (row.getAttribute("data-open") !== "true") {
            row
              .querySelector<HTMLButtonElement>(".llm-pref-row-toggle")!
              .click();
          }
          const advanced = row.querySelector<HTMLElement>(
            ".llm-pref-advanced-panel",
          )!;
          if (advanced.getAttribute("data-open") !== "true") {
            row
              .querySelector<HTMLButtonElement>(
                'button[title="Advanced options"]',
              )!
              .click();
          }
          assert.equal(advanced.getAttribute("data-open"), "true");
          assert.isAbove(advanced.getBoundingClientRect().height, 0);
          return advanced;
        };
        const levels = (panel: HTMLElement) =>
          (
            Array.from(
              panel.querySelectorAll<HTMLInputElement>(
                'input[list^="llm-reasoning-levels-"]',
              ),
            ) as HTMLInputElement[]
          ).map((input) => input.value);

        win = await openPreferences();
        const advanced = openAdvanced();
        assert.sameMembers(
          levels(advanced),
          scenario.levels,
          "detected model-family levels are visible without catalog metadata",
        );
        const modelInput = win.document.querySelector<HTMLInputElement>(
          `[data-llm-provider-row="${groupId}"] .llm-pref-model-row input`,
        )!;
        assert.isOk(modelInput, "model input exists");
        changeValue(modelInput, "workflow-unknown-model", "input");
        assert.isEmpty(
          levels(advanced),
          "changing the model clears the previous family's levels",
        );
        changeValue(modelInput, scenario.model, "input");
        assert.sameMembers(
          levels(advanced),
          scenario.levels,
          "returning to the model restores its levels",
        );
        await closePreferences(win);
        win = await openPreferences();
        assert.sameMembers(
          levels(openAdvanced()),
          scenario.levels,
          "levels survive reopening Preferences",
        );
        assert.notProperty(
          getModelProviderGroups()[0].models[0],
          "profileOverride",
          "displaying detected levels does not persist an override",
        );
      } finally {
        if (win && !win.closed) await closePreferences(win);
        for (const [key, value] of previous) {
          if (value === undefined) Zotero.Prefs.clear(`${prefix}.${key}`, true);
          else Zotero.Prefs.set(`${prefix}.${key}`, value, true);
        }
      }
    });
  }

  for (const scenario of [
    {
      preset: "local_openai",
      url: "http://localhost:11434/v1",
      endpoint: "http://localhost:11434/v1/chat/completions",
      protocol: "openai_chat_compat",
    },
    {
      preset: "ollama",
      url: "http://localhost:1234",
      endpoint: "http://localhost:1234/api/chat",
      protocol: "ollama_native",
    },
  ]) {
    it(`keeps ${scenario.preset} after editing the port and reopening preferences`, async function () {
      const keys = [
        "modelProviderGroups",
        "modelProviderGroupsMigrationVersion",
        "lastUsedModelEntryId",
        "outputTokenAutoMigrationNoticePending",
      ];
      const previous = new Map(
        keys.map((key) => [key, Zotero.Prefs.get(`${prefix}.${key}`, true)]),
      );
      let win: Window | undefined;
      try {
        setModelProviderGroups([
          {
            id: groupId,
            authMode: "api_key",
            apiBase: "http://localhost:1234/v1",
            apiKey: "",
            providerProtocol: "openai_chat_compat",
            presetIdOverride: "customized",
            models: [
              {
                id: "workflow-provider-model",
                model: "local-model",
                temperature: 0.3,
                outputTokenLimit: { mode: "auto" },
              },
            ],
          },
        ]);
        win = await openPreferences();
        const doc = win.document;
        const select = doc.querySelector(presetSelector) as HTMLSelectElement;
        changeValue(select, scenario.preset, "change");
        await waitFor(
          () => !select.isConnected,
          "preset change should finish rerendering",
        );
        const input = doc.querySelector(urlSelector) as HTMLInputElement;
        assert.isFalse(
          input.readOnly,
          "local provider URL should stay editable",
        );
        changeValue(input, scenario.url, "input");
        await closePreferences(win);
        win = await openPreferences();

        assert.equal(
          (win.document.querySelector(presetSelector) as HTMLSelectElement)
            .value,
          scenario.preset,
        );
        assert.equal(
          (win.document.querySelector(urlSelector) as HTMLInputElement).value,
          scenario.url,
        );
        const [saved] = getModelProviderGroups();
        const [runtime] = getRuntimeModelEntries();
        assert.equal(saved.presetIdOverride, scenario.preset);
        assert.equal(runtime.providerProtocol, scenario.protocol);
        assert.equal(
          resolveProviderTransportEndpoint({
            apiBase: runtime.apiBase,
            protocol: runtime.providerProtocol,
          }),
          scenario.endpoint,
        );
      } finally {
        if (win && !win.closed) await closePreferences(win);
        for (const [key, value] of previous) {
          if (value === undefined) Zotero.Prefs.clear(`${prefix}.${key}`, true);
          else Zotero.Prefs.set(`${prefix}.${key}`, value, true);
        }
      }
    });
  }
});
