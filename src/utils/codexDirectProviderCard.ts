import type { CodexDirectCatalogModel } from "../codexAuth/modelCatalog";
import {
  createCodexDirectModelRow,
  type CodexDirectProviderGroup,
  type ModelProviderGroup,
} from "./modelProviders";

export type CodexDirectModelOption = {
  model: string;
  label: string;
  availability: "available" | "saved-unavailable";
};

type CodexDirectCatalogInteractionTarget = {
  addEventListener: (type: string, listener: () => void) => void;
};

export function attachCodexDirectCatalogInteractions(params: {
  target: CodexDirectCatalogInteractionTarget;
  popupMayOpen: () => void;
  refreshCatalog: () => void;
}): void {
  params.target.addEventListener("mousedown", () => {
    params.popupMayOpen();
    params.refreshCatalog();
  });
  params.target.addEventListener("keydown", params.popupMayOpen);
  params.target.addEventListener("focus", params.refreshCatalog);
}

function cloneGroup(group: CodexDirectProviderGroup): CodexDirectProviderGroup {
  return { ...group, models: group.models.map((row) => ({ ...row })) };
}

export function canOfferCodexDirectAuthMode(
  groups: ModelProviderGroup[],
  currentGroupId: string,
): boolean {
  return !groups.some(
    (group) => group.id !== currentGroupId && group.authMode === "codex_auth",
  );
}

export function buildCodexDirectModelOptions(params: {
  group: CodexDirectProviderGroup;
  rowId: string;
  catalog: CodexDirectCatalogModel[];
}): CodexDirectModelOption[] {
  const row = params.group.models.find(
    (candidate) => candidate.id === params.rowId,
  );
  const savedModel = row?.model.trim() || "";
  const usedModels = new Set(
    params.group.models
      .filter((candidate) => candidate.id !== params.rowId)
      .map((candidate) => candidate.model.trim().toLowerCase())
      .filter(Boolean),
  );
  const options: CodexDirectModelOption[] = [];
  if (
    savedModel &&
    !params.catalog.some(
      (model) => model.model.toLowerCase() === savedModel.toLowerCase(),
    )
  ) {
    options.push({
      model: savedModel,
      label: savedModel,
      availability: "saved-unavailable",
    });
  }
  for (const model of params.catalog) {
    if (
      usedModels.has(model.model.toLowerCase()) &&
      model.model.toLowerCase() !== savedModel.toLowerCase()
    ) {
      continue;
    }
    options.push({
      model: model.model,
      label: model.displayName || model.model,
      availability: "available",
    });
  }
  return options;
}

export function updateCodexDirectModelRow(
  group: CodexDirectProviderGroup,
  rowId: string,
  model: string,
): CodexDirectProviderGroup | null {
  const normalizedModel = model.trim();
  if (!normalizedModel) return null;
  const next = cloneGroup(group);
  const row = next.models.find((candidate) => candidate.id === rowId);
  if (!row) return null;
  if (
    next.models.some(
      (candidate) =>
        candidate.id !== rowId &&
        candidate.model.toLowerCase() === normalizedModel.toLowerCase(),
    )
  ) {
    return null;
  }
  row.model = normalizedModel;
  return next;
}

export function addCodexDirectModelRow(
  group: CodexDirectProviderGroup,
): CodexDirectProviderGroup | null {
  if (group.models.some((row) => !row.model.trim())) return null;
  const next = cloneGroup(group);
  next.models.push(createCodexDirectModelRow());
  return next;
}

export function removeCodexDirectModelRow(
  group: CodexDirectProviderGroup,
  rowId: string,
): CodexDirectProviderGroup | null {
  if (group.models.length <= 1) return null;
  const next = cloneGroup(group);
  if (!next.models.some((row) => row.id === rowId)) return null;
  next.models = next.models.filter((row) => row.id !== rowId);
  return next;
}
