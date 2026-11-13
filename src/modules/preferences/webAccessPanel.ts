import { config } from "../../../package.json";
import { AnysearchClient } from "../../webAccess/anysearchClient";
import { DeepSeekSearchClient } from "../../webAccess/deepseekSearchClient";
import {
  getDeepSeekSearchCredential,
  maskApiKey,
} from "../../webAccess/deepseekSearchKey";
import { WebAccessError } from "../../webAccess/errors";
import { t } from "../../utils/i18n";
import { createAbortController } from "../../utils/apiHelpers";
import { subscribeModelProviderGroups } from "../../utils/modelProviders";
import {
  getAnysearchApiKey,
  getWebAccessProvider,
  setAnysearchApiKey,
  setWebAccessProvider,
  type WebAccessProviderId,
} from "../../webAccess/prefs";

const NO_DEEPSEEK_PROFILE =
  "Add a DeepSeek model profile with the official API address (api.deepseek.com) to use DeepSeek search. Keys from other hosts do not work.";

function isProviderSetting(value: string): value is WebAccessProviderId {
  return ["tavily", "anysearch", "deepseek"].includes(value);
}

export type WebAccessPreferences = {
  /** Re-renders the card after a setting it depends on changed elsewhere. */
  refresh: () => void;
};

/** Saving/opening preferences never initiates a request; Test search is explicit. */
export function registerWebAccessPreferences(
  doc: Document,
): WebAccessPreferences {
  const provider = doc.querySelector(
    `#${config.addonRef}-web-access-provider`,
  ) as HTMLSelectElement | null;
  const key = doc.querySelector(
    `#${config.addonRef}-anysearch-api-key`,
  ) as HTMLInputElement | null;
  const anysearch = doc.querySelector(
    `#${config.addonRef}-anysearch-settings`,
  ) as HTMLElement | null;
  const tavily = doc.querySelector(
    `#${config.addonRef}-tavily-settings`,
  ) as HTMLElement | null;
  const testButton = doc.querySelector(
    `#${config.addonRef}-anysearch-test`,
  ) as HTMLButtonElement | null;
  const status = doc.querySelector(
    `#${config.addonRef}-anysearch-status`,
  ) as HTMLElement | null;
  const deepseek = doc.querySelector(
    `#${config.addonRef}-deepseek-search-settings`,
  ) as HTMLElement | null;
  const deepseekKey = doc.querySelector(
    `#${config.addonRef}-deepseek-search-key`,
  ) as HTMLElement | null;
  const deepseekTest = doc.querySelector(
    `#${config.addonRef}-deepseek-search-test`,
  ) as HTMLButtonElement | null;
  const deepseekStatus = doc.querySelector(
    `#${config.addonRef}-deepseek-search-status`,
  ) as HTMLElement | null;
  let settingsGeneration = 0;
  let pendingTest: AbortController | undefined;
  let shownSearchTarget = "";
  const invalidateTest = () => {
    settingsGeneration++;
    const previous = pendingTest;
    pendingTest = undefined;
    if (status) status.textContent = "";
    if (testButton) testButton.disabled = false;
    if (deepseekStatus) deepseekStatus.textContent = "";
    if (deepseekTest) deepseekTest.disabled = false;
    previous?.abort();
  };
  const render = () => {
    const chosen = getWebAccessProvider();
    const credential =
      chosen === "deepseek" ? getDeepSeekSearchCredential() : null;
    shownSearchTarget = `${chosen}:${credential?.apiKey || ""}`;
    if (provider) provider.value = chosen;
    if (tavily) tavily.hidden = chosen !== "tavily";
    if (anysearch) anysearch.hidden = chosen !== "anysearch";
    if (deepseek) deepseek.hidden = chosen !== "deepseek";
    if (deepseekKey) {
      deepseekKey.textContent = credential
        ? `${t("Key from your DeepSeek model profile")}${credential.label ? ` (${credential.label})` : ""}: ${maskApiKey(credential.apiKey)}`
        : t(NO_DEEPSEEK_PROFILE);
    }
  };
  if (key) {
    key.value = getAnysearchApiKey();
    const saveKey = () => {
      if (key.value.trim() !== getAnysearchApiKey()) invalidateTest();
      setAnysearchApiKey(key.value);
      key.value = getAnysearchApiKey();
    };
    key.addEventListener("input", invalidateTest);
    key.addEventListener("change", saveKey);
    key.addEventListener("blur", saveKey);
  }
  provider?.addEventListener("change", () => {
    invalidateTest();
    if (isProviderSetting(provider.value)) {
      setWebAccessProvider(provider.value);
    }
    render();
  });
  testButton?.addEventListener("click", () => {
    if (!status || testButton.disabled) return;
    if (getWebAccessProvider() !== "anysearch") {
      status.textContent = t("Select AnySearch before testing.");
      return;
    }
    // Save the visible key, including empty: never revive a previously saved key.
    if (key) {
      setAnysearchApiKey(key.value);
      key.value = getAnysearchApiKey();
    }
    const generation = ++settingsGeneration;
    let controller: AbortController;
    try {
      controller = createAbortController();
    } catch {
      status.textContent = t("AnySearch test search failed.");
      return;
    }
    pendingTest = controller;
    const testedKey = getAnysearchApiKey();
    const isCurrent = () =>
      generation === settingsGeneration &&
      getWebAccessProvider() === "anysearch" &&
      getAnysearchApiKey() === testedKey &&
      (!key || key.value.trim() === testedKey) &&
      (!provider || provider.value === "anysearch");
    testButton.disabled = true;
    status.textContent = t("Testing…");
    void (async () => {
      try {
        const result = await new AnysearchClient(testedKey).search({
          query: "Zotero reference management",
          maxResults: 3,
          signal: controller.signal,
        });
        if (!isCurrent()) return;
        status.textContent = [
          `${t("AnySearch results")}: ${result.results.length}`,
          ...result.results.map((entry) => `${entry.title}\n${entry.url}`),
          ...(result.requestId ? [`request_id: ${result.requestId}`] : []),
        ].join("\n");
      } catch (error) {
        if (!isCurrent()) return;
        status.textContent =
          error instanceof WebAccessError
            ? t(error.message)
            : t("AnySearch test search failed.");
      } finally {
        // An older completion must not clear a newer test's status or controls.
        if (generation === settingsGeneration) {
          pendingTest = undefined;
          testButton.disabled = false;
          if (!isCurrent()) status.textContent = "";
        }
      }
    })();
  });
  deepseekTest?.addEventListener("click", () => {
    if (!deepseekStatus || deepseekTest.disabled) return;
    if (getWebAccessProvider() !== "deepseek") {
      deepseekStatus.textContent = t("Select DeepSeek before testing.");
      return;
    }
    // The same key the Agent would use; there is no typed search key.
    const testedKey = getDeepSeekSearchCredential()?.apiKey || "";
    if (!testedKey) {
      deepseekStatus.textContent = t(NO_DEEPSEEK_PROFILE);
      return;
    }
    const generation = ++settingsGeneration;
    let controller: AbortController;
    try {
      controller = createAbortController();
    } catch {
      deepseekStatus.textContent = t("DeepSeek test search failed.");
      return;
    }
    pendingTest = controller;
    const isCurrent = () =>
      generation === settingsGeneration &&
      getWebAccessProvider() === "deepseek" &&
      getDeepSeekSearchCredential()?.apiKey === testedKey;
    deepseekTest.disabled = true;
    deepseekStatus.textContent = t("Testing…");
    void (async () => {
      try {
        const result = await new DeepSeekSearchClient(testedKey).search({
          query: "Zotero reference management",
          maxResults: 3,
          signal: controller.signal,
        });
        if (!isCurrent()) return;
        deepseekStatus.textContent = [
          `${t("DeepSeek results")}: ${result.results.length}`,
          ...result.results.map((entry) => `${entry.title}\n${entry.url}`),
        ].join("\n");
      } catch (error) {
        if (!isCurrent()) return;
        deepseekStatus.textContent =
          error instanceof WebAccessError
            ? t(error.message)
            : t("DeepSeek test search failed.");
      } finally {
        // An older completion must not clear a newer test's status or controls.
        if (generation === settingsGeneration) {
          pendingTest = undefined;
          deepseekTest.disabled = false;
          if (!isCurrent()) deepseekStatus.textContent = "";
        }
      }
    })();
  });
  // A DeepSeek model profile change can change the key that DeepSeek uses.
  const refresh = () => {
    const previous = shownSearchTarget;
    render();
    if (shownSearchTarget !== previous) invalidateTest();
  };
  const win = doc.defaultView;
  if (win) {
    const unsubscribe = subscribeModelProviderGroups(refresh);
    win.addEventListener("unload", unsubscribe, { once: true });
  }
  render();
  return { refresh };
}
