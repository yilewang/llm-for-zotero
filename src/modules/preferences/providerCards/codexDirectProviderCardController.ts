import { el, iconBtn } from "../../../utils/domHelpers";
import { t } from "../../../utils/i18n";
import {
  getCodexDirectCatalogSnapshot,
  loadCodexDirectCatalog,
  subscribeToCodexDirectCatalog,
} from "../../../codexAuth/modelCatalog";
import {
  getLastUsedModelEntryId,
  setLastUsedModelEntryId,
  type CodexDirectProviderGroup,
} from "../../../utils/modelProviders";
import {
  addCodexDirectModelRow,
  attachCodexDirectCatalogInteractions,
  buildCodexDirectModelOptions,
  removeCodexDirectModelRow,
  updateCodexDirectModelRow,
} from "../../../utils/codexDirectProviderCard";
import {
  createSelectRebuildGate,
  runAfterSelectChangeDispatch,
} from "../../../utils/providerModelPicker";
import {
  PROVIDER_MODEL_CONTROL_STYLE,
  createProviderModelRowBlueprint,
  createProviderModelSectionBlueprint,
} from "../../../utils/providerCardModelSection";
import { runCodexDirectConnectionTest } from "../../../utils/providerConnectionTest";

type ModelPicker = {
  container: HTMLElement;
  statusEl: HTMLElement;
  refresh: () => void;
};

function createModelPicker(args: {
  doc: Document;
  group: CodexDirectProviderGroup;
  rowId: string;
  helperStyle: string;
  isDisposed: () => boolean;
  onModelPicked: (model: string) => void;
}): ModelPicker {
  const { doc, group, rowId } = args;
  const container = el(
    doc,
    "div",
    "flex: 1; min-width: 0; display: flex; align-items: center; gap: 5px;",
  );
  const select = el(
    doc,
    "select",
    PROVIDER_MODEL_CONTROL_STYLE,
  ) as HTMLSelectElement;
  const statusEl = el(doc, "span", args.helperStyle);
  statusEl.style.display = "none";
  container.appendChild(select);

  let loading = false;
  let fetchToken = 0;
  let renderedSignature = "";
  const getRow = () => group.models.find((row) => row.id === rowId);

  const rewriteOptions = () => {
    if (args.isDisposed()) return;
    const savedModel = getRow()?.model.trim() || "";
    const snapshot = getCodexDirectCatalogSnapshot();
    const options =
      snapshot.status === "ready"
        ? buildCodexDirectModelOptions({
            group,
            rowId,
            catalog: snapshot.models,
          })
        : [];
    const signature = JSON.stringify({
      savedModel,
      status: snapshot.status,
      models: options.map((option) => [option.model, option.availability]),
    });
    if (signature === renderedSignature) return;
    renderedSignature = signature;
    select.textContent = "";
    if (!savedModel) {
      const placeholder = el(doc, "option") as HTMLOptionElement;
      placeholder.value = "";
      placeholder.textContent = t("Select a Codex Direct model…");
      placeholder.disabled = true;
      placeholder.selected = true;
      select.appendChild(placeholder);
    } else if (
      !options.some(
        (option) => option.model.toLowerCase() === savedModel.toLowerCase(),
      )
    ) {
      const saved = el(doc, "option") as HTMLOptionElement;
      saved.value = savedModel;
      saved.textContent = savedModel;
      select.appendChild(saved);
    }
    for (const model of options) {
      const option = el(doc, "option") as HTMLOptionElement;
      option.value = model.model;
      option.textContent =
        model.availability === "saved-unavailable"
          ? `${model.label} (${t("Unavailable")})`
          : model.label;
      select.appendChild(option);
    }
    select.value =
      options.find(
        (option) => option.model.toLowerCase() === savedModel.toLowerCase(),
      )?.model || savedModel;
  };
  const rebuildGate = createSelectRebuildGate(rewriteOptions);

  const updateStatus = () => {
    if (args.isDisposed()) return;
    const snapshot = getCodexDirectCatalogSnapshot();
    if (loading || snapshot.status === "loading") {
      statusEl.textContent = t("Fetching Codex Direct models…");
      statusEl.style.color = "var(--fill-secondary, #888)";
      statusEl.style.display = "block";
      return;
    }
    if (snapshot.status === "error") {
      statusEl.textContent = `${t("Couldn't fetch Codex Direct models:")} ${snapshot.error || ""}`;
      statusEl.style.color = "darkorange";
      statusEl.style.display = "block";
      return;
    }
    statusEl.style.display = "none";
  };

  const refreshCatalog = async () => {
    const token = ++fetchToken;
    loading = true;
    updateStatus();
    try {
      await loadCodexDirectCatalog();
    } catch (_error) {
      // The shared snapshot carries the user-facing retryable error.
    } finally {
      if (token === fetchToken && !args.isDisposed()) {
        loading = false;
        rebuildGate.requestRebuild();
        updateStatus();
      }
    }
  };

  attachCodexDirectCatalogInteractions({
    target: select,
    popupMayOpen: () => rebuildGate.popupMayOpen(),
    refreshCatalog: () => void refreshCatalog(),
  });
  select.addEventListener("blur", () => rebuildGate.popupClosed());
  select.addEventListener("change", () => {
    const model = select.value;
    rebuildGate.popupClosed();
    runAfterSelectChangeDispatch(() => {
      if (model && !args.isDisposed()) args.onModelPicked(model);
    });
  });

  rewriteOptions();
  updateStatus();
  return {
    container,
    statusEl,
    refresh: () => {
      rebuildGate.requestRebuild();
      updateStatus();
    },
  };
}

export function createCodexDirectProviderCardController(args: {
  doc: Document;
  group: CodexDirectProviderGroup;
  sectionLabelStyle: string;
  outlineButtonStyle: string;
  helperStyle: string;
  onGroupChange: (group: CodexDirectProviderGroup) => void;
  getFetch: () => typeof fetch | undefined;
}) {
  let disposed = false;
  const pickers: ModelPicker[] = [];
  const { section, addButton } = createProviderModelSectionBlueprint({
    doc: args.doc,
    sectionLabelStyle: args.sectionLabelStyle,
    title: t("Model names"),
    addTitle: t("Add model"),
  });
  const syncAddButton = () => {
    addButton.disabled = args.group.models.some((row) => !row.model.trim());
    addButton.style.opacity = addButton.disabled ? "0.45" : "1";
    addButton.style.cursor = addButton.disabled ? "not-allowed" : "pointer";
  };
  syncAddButton();
  addButton.addEventListener("click", () => {
    if (addButton.disabled || disposed) return;
    const next = addCodexDirectModelRow(args.group);
    if (next) args.onGroupChange(next);
  });

  for (const row of args.group.models) {
    const {
      row: rowWrap,
      controls,
      testButton,
      status,
    } = createProviderModelRowBlueprint({
      doc: args.doc,
      outlineButtonStyle: args.outlineButtonStyle,
      testLabel: t("Test"),
    });
    const picker = createModelPicker({
      doc: args.doc,
      group: args.group,
      rowId: row.id,
      helperStyle: args.helperStyle,
      isDisposed: () => disposed,
      onModelPicked: (model) => {
        const next = updateCodexDirectModelRow(args.group, row.id, model);
        if (next) args.onGroupChange(next);
      },
    });
    pickers.push(picker);
    controls.append(picker.container, testButton);
    if (args.group.models.length > 1) {
      const removeButton = iconBtn(args.doc, "×", t("Remove model"));
      removeButton.addEventListener("click", () => {
        if (disposed) return;
        const wasSelected = getLastUsedModelEntryId() === row.id;
        const next = removeCodexDirectModelRow(args.group, row.id);
        if (!next) return;
        if (wasSelected) setLastUsedModelEntryId(next.models[0]?.id || "");
        args.onGroupChange(next);
      });
      controls.appendChild(removeButton);
    }
    testButton.disabled = !row.model.trim();
    const runTest = async () => {
      if (disposed) return;
      testButton.disabled = true;
      status.style.display = "block";
      status.textContent = t("Fetching Codex model catalog…");
      status.style.color = "var(--fill-secondary, #888)";
      try {
        const result = await runCodexDirectConnectionTest({
          fetchFn: args.getFetch(),
          modelName: row.model,
        });
        if (disposed) return;
        const catalogLine = `✓ ${t("Catalog:")} ${result.catalogCount} ${t("models; test model:")} ${result.modelName}`;
        if (result.inferenceError) {
          status.textContent = `${catalogLine}\n✗ ${t("Inference:")} ${t(result.inferenceError)}`;
          status.style.color = "darkorange";
        } else {
          status.textContent = `${catalogLine}\n✓ ${t("Inference:")} "${result.reply}"`;
          status.style.color = "green";
        }
      } catch (error) {
        if (disposed) return;
        status.textContent = `✗ ${t("Catalog:")} ${
          error instanceof Error ? error.message : String(error)
        }\n${t("Inference was not run.")}`;
        status.style.color = "red";
      } finally {
        if (!disposed) testButton.disabled = !row.model.trim();
      }
    };
    testButton.addEventListener("click", () => void runTest());
    testButton.addEventListener("command", () => void runTest());
    rowWrap.append(picker.statusEl, status);
    section.appendChild(rowWrap);
  }

  const unsubscribe = subscribeToCodexDirectCatalog(() => {
    if (!disposed) pickers.forEach((picker) => picker.refresh());
  });
  void loadCodexDirectCatalog().catch(() => undefined);

  return {
    element: section,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
    },
  };
}

export type CodexDirectProviderCardController = ReturnType<
  typeof createCodexDirectProviderCardController
>;
