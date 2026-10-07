import { config } from "../../../package.json";
import { AnysearchClient } from "../../webAccess/anysearchClient";
import { WebAccessError } from "../../webAccess/errors";
import { t } from "../../utils/i18n";
import { createAbortController } from "../../utils/apiHelpers";
import {
  getAnysearchApiKey,
  getWebAccessProvider,
  setAnysearchApiKey,
  setWebAccessProvider,
} from "../../webAccess/prefs";

/** Saving/opening preferences never initiates a request; Test search is explicit. */
export function registerWebAccessPreferences(doc: Document): void {
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
  let settingsGeneration = 0;
  let pendingTest: AbortController | undefined;
  const invalidateTest = () => {
    settingsGeneration++;
    const previous = pendingTest;
    pendingTest = undefined;
    if (status) status.textContent = "";
    if (testButton) testButton.disabled = false;
    previous?.abort();
  };
  const render = () => {
    const selected = getWebAccessProvider();
    if (provider) provider.value = selected;
    if (anysearch) anysearch.hidden = selected !== "anysearch";
    if (tavily) tavily.hidden = selected !== "tavily";
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
    if (provider.value === "tavily" || provider.value === "anysearch") {
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
  render();
}
