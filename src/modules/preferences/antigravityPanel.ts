/**
 * The Antigravity row in Settings → agent runtimes, laid out like the Codex
 * and Claude Code rows: the enable switch, model and thinking, permission
 * level, a connection test, and the agy path.
 *
 * Opening Settings never starts agy: the model list comes from the catalog
 * remembered from earlier turns, and only Refresh or Test connection start
 * the Antigravity CLI.
 */

import { config } from "../../../package.json";
import { t } from "../../utils/i18n";
import { applyAntigravityModePreferenceChange } from "../../antigravity/modePreference";
import {
  getAntigravityBinaryPathPref,
  getAntigravityPermissionModePref,
  getAntigravityRuntimeModelPref,
  getAntigravityThoughtLevelPref,
  isAntigravityModeEnabled,
  setAntigravityBinaryPathPref,
  setAntigravityPermissionModePref,
  setAntigravityRuntimeModelPref,
  setAntigravityThoughtLevelPref,
} from "../../antigravity/prefs";
import {
  getRememberedAntigravityModelCatalog,
  type AntigravityModelCatalog,
} from "../../antigravity/modelCatalog";
import {
  buildAgyLaunchOptions,
  loadAntigravityPickerModelCatalog,
} from "../../antigravity/runtime";
import { getOrStartAgyClient } from "../../antigravity/agyProcess";
import { getAntigravityPermissionOptions } from "../../shared/permissionOptions";
import { isAntigravityPermissionMode } from "../../shared/antigravityPermissionMode";
import { ensureDir } from "../../utils/geckoFs";

export type AntigravityPreferences = {
  /** The row's summary: on or off, the model, and the permission level. */
  summary: () => { on: boolean; parts: string[] };
};

function byId<T extends Element>(doc: Document, id: string): T | null {
  return doc.querySelector(`#${config.addonRef}-${id}`) as T | null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerAntigravityPreferences(
  doc: Document,
  deps: {
    /** A modal yes/no. */
    confirm: (title: string, text: string) => boolean;
    /** Called after a setting the row summary shows changed. */
    onChange: () => void;
  },
): AntigravityPreferences {
  const enable = byId<HTMLInputElement>(doc, "antigravity-enable");
  const settings = byId<HTMLDivElement>(doc, "antigravity-settings");
  const modelSelect = byId<HTMLSelectElement>(doc, "antigravity-model");
  const modelRefresh = byId<HTMLButtonElement>(
    doc,
    "antigravity-model-refresh",
  );
  const modelStatus = byId<HTMLElement>(doc, "antigravity-model-status");
  const levelSelect = byId<HTMLSelectElement>(doc, "antigravity-thought-level");
  const permissionSelect = byId<HTMLSelectElement>(
    doc,
    "antigravity-permission-mode",
  );
  const testButton = byId<HTMLButtonElement>(doc, "antigravity-test");
  const status = byId<HTMLElement>(doc, "antigravity-status");
  const pathInput = byId<HTMLInputElement>(doc, "antigravity-path");

  const option = (value: string, label: string): HTMLOptionElement => {
    const element = doc.createElement("option");
    element.value = value;
    element.textContent = label;
    return element;
  };

  let catalog: AntigravityModelCatalog | null =
    getRememberedAntigravityModelCatalog();

  const renderLevels = () => {
    if (!levelSelect) return;
    const model = catalog?.models.find(
      (entry) =>
        entry.id ===
        (getAntigravityRuntimeModelPref() || catalog?.defaultModel),
    );
    const levels = model?.thoughtLevels ?? [];
    levelSelect.replaceChildren(
      option("", t("Default")),
      ...levels.map((level) => option(level.value, level.name)),
    );
    const picked = getAntigravityThoughtLevelPref();
    levelSelect.value = levels.some((level) => level.value === picked)
      ? picked
      : "";
    levelSelect.disabled = levels.length === 0;
  };

  const renderModels = () => {
    if (!modelSelect) return;
    const picked = getAntigravityRuntimeModelPref();
    const models = catalog?.models ?? [];
    modelSelect.replaceChildren(
      option("", t("Default")),
      ...models.map((model) => option(model.id, model.name)),
    );
    // A saved model the catalog does not list yet stays visible and chosen.
    if (picked && !models.some((model) => model.id === picked)) {
      modelSelect.appendChild(option(picked, picked));
    }
    modelSelect.value = picked;
    renderLevels();
  };

  const refreshModels = async () => {
    if (modelStatus) modelStatus.textContent = t("Loading models…");
    if (modelRefresh) modelRefresh.disabled = true;
    try {
      catalog = await loadAntigravityPickerModelCatalog(true);
      renderModels();
      if (modelStatus)
        modelStatus.textContent = `${catalog.models.length} ${t("models")}`;
    } catch (error) {
      if (modelStatus) modelStatus.textContent = errorText(error);
    } finally {
      if (modelRefresh) modelRefresh.disabled = false;
    }
  };

  const renderPermissions = () => {
    if (!permissionSelect) return;
    permissionSelect.replaceChildren(
      ...getAntigravityPermissionOptions().map((entry) =>
        option(
          entry.selectionKey.replace(/^antigravity:/, ""),
          entry.fullLabel,
        ),
      ),
    );
    permissionSelect.value = getAntigravityPermissionModePref();
  };

  const applyEnabledUi = (enabled: boolean) => {
    if (enable) enable.checked = enabled;
    if (settings) settings.style.display = enabled ? "flex" : "none";
    deps.onChange();
  };

  applyEnabledUi(isAntigravityModeEnabled());
  renderModels();
  renderPermissions();
  if (pathInput) pathInput.value = getAntigravityBinaryPathPref();

  enable?.addEventListener("change", () => {
    const enabled = enable.checked;
    void (async () => {
      try {
        await applyAntigravityModePreferenceChange(enabled);
        applyEnabledUi(enabled);
      } catch (error) {
        // Storage could not be prepared: the mode stays off.
        applyEnabledUi(false);
        if (status) {
          status.textContent = `${t("Antigravity could not be turned on:")} ${errorText(error)}`;
        }
      }
    })();
  });

  modelSelect?.addEventListener("change", () => {
    setAntigravityRuntimeModelPref(modelSelect.value);
    renderLevels();
    setAntigravityThoughtLevelPref(levelSelect?.value || "");
    deps.onChange();
  });
  levelSelect?.addEventListener("change", () => {
    setAntigravityThoughtLevelPref(levelSelect.value);
  });
  modelRefresh?.addEventListener("click", () => void refreshModels());

  permissionSelect?.addEventListener("change", () => {
    const mode = permissionSelect.value;
    if (!isAntigravityPermissionMode(mode)) return;
    if (
      mode === "full-access" &&
      getAntigravityPermissionModePref() !== "full-access" &&
      !deps.confirm(
        t("Enable Antigravity full access?"),
        t(
          "Antigravity will run every tool without asking, including commands and file changes, with the access your computer account has.",
        ),
      )
    ) {
      permissionSelect.value = getAntigravityPermissionModePref();
      return;
    }
    setAntigravityPermissionModePref(mode);
    deps.onChange();
  });

  testButton?.addEventListener("click", () => {
    void (async () => {
      if (status) status.textContent = t("Starting the Antigravity CLI…");
      testButton.disabled = true;
      try {
        const launch = buildAgyLaunchOptions(
          getAntigravityPermissionModePref(),
        );
        await ensureDir(launch.cwd);
        const client = await getOrStartAgyClient(launch);
        const version = client.getInitializeResult().agentInfo?.version;
        catalog = await loadAntigravityPickerModelCatalog(true);
        renderModels();
        if (status) {
          status.textContent = `${t("Connected and signed in.")} ${t("Antigravity CLI")} ${version || ""} · ${catalog.models.length} ${t("models")}`;
        }
      } catch (error) {
        if (status) status.textContent = errorText(error);
      } finally {
        testButton.disabled = false;
      }
    })();
  });

  pathInput?.addEventListener("change", () => {
    setAntigravityBinaryPathPref(pathInput.value);
  });

  return {
    summary: () => {
      const on = Boolean(enable?.checked);
      if (!on) return { on, parts: [t("Off")] };
      const model = modelSelect?.selectedOptions?.[0]?.textContent?.trim();
      const permission =
        permissionSelect?.selectedOptions?.[0]?.textContent?.trim();
      return {
        on,
        parts: [model || t("Default model"), permission || ""],
      };
    },
  };
}
