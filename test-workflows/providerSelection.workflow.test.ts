import { assert } from "chai";
import {
  getModelProviderGroups,
  getRuntimeModelEntries,
  setModelProviderGroups,
} from "../src/utils/modelProviders";
import { resolveProviderTransportEndpoint } from "../src/utils/providerTransport";

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

describe("workflow: explicit provider selection", function () {
  this.timeout(30000);

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
