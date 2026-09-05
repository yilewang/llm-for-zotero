import type { ReasoningConfig } from "../../../../shared/llm";
import {
  getModelProviderGroups,
  type RuntimeModelEntry,
} from "../../../../utils/modelProviders";
import { t } from "../../../../utils/i18n";
import {
  getCodexDirectCatalogSnapshot,
  getCodexDirectReasoningChoices,
  loadCodexDirectCatalog,
  reconcileCodexDirectReasoningChoice,
  subscribeToCodexDirectCatalog,
} from "../../../../codexAuth/modelCatalog";
import {
  getCodexDirectReasoningSelection,
  setCodexDirectReasoningSelection,
} from "../../../../codexAuth/reasoningPrefs";
import {
  buildCodexReasoningConfig,
  type CodexReasoningChoice,
} from "../../../../codex/catalogSelection";

type CatalogStatusRenderer = (params: {
  menu: HTMLDivElement;
  status: "idle" | "loading" | "ready" | "error";
  modelCount: number;
  loadingMessage: string;
  errorMessage: string;
  errorTitle?: string;
  emptyMessage: string;
  retryLabel: string;
  onRetry: (event: Event) => void;
}) => boolean;

type ReasoningChoiceRenderer = (params: {
  menu: HTMLDivElement;
  choices: CodexReasoningChoice[];
  currentValue: string;
  onSelect: (value: string) => void;
}) => void;

export type CodexDirectReasoningSelection = {
  mode: string;
  choices: CodexReasoningChoice[];
};

export function createCodexDirectModelReasoningController(params: {
  getSelectedEntry: () => RuntimeModelEntry | null;
  isRuntimeConversationSystem: () => boolean;
  onStateChange: () => void;
}) {
  let disposed = false;

  const hasConfiguredProvider = () =>
    getModelProviderGroups().some(
      (group) =>
        group.authMode === "codex_auth" &&
        group.models.some((model) => model.model.trim()),
    );

  const getSelectedEntry = (): RuntimeModelEntry | null => {
    if (params.isRuntimeConversationSystem()) return null;
    const selected = params.getSelectedEntry();
    return selected?.authMode === "codex_auth" ? selected : null;
  };

  const resolveReasoningSelection = (): CodexDirectReasoningSelection => {
    const selected = getSelectedEntry();
    if (!selected) return { mode: "auto", choices: [] };
    const stored = getCodexDirectReasoningSelection(selected.model);
    const choices = getCodexDirectReasoningChoices(selected.model);
    const mode = reconcileCodexDirectReasoningChoice(selected.model, stored);
    if (getCodexDirectCatalogSnapshot().status === "ready" && mode !== stored) {
      setCodexDirectReasoningSelection(selected.model, mode);
    }
    return { mode, choices };
  };

  const ensureCatalog = (force = false): void => {
    if (!hasConfiguredProvider()) return;
    void loadCodexDirectCatalog(force ? { force: true } : undefined).catch(
      () => undefined,
    );
  };

  const appendCatalogStatus = (args: {
    menu: HTMLDivElement;
    renderStatus: CatalogStatusRenderer;
    appendEmptyState: (menu: HTMLDivElement, message: string) => void;
    isPrimaryPointerEvent: (event: Event) => boolean;
  }): void => {
    if (params.isRuntimeConversationSystem() || !hasConfiguredProvider())
      return;
    const snapshot = getCodexDirectCatalogSnapshot();
    const selected = params.getSelectedEntry();
    const hasSavedModel = selected?.authMode === "codex_auth";
    const statusHandled = args.renderStatus({
      menu: args.menu,
      status: snapshot.status,
      modelCount: snapshot.models.length,
      loadingMessage: hasSavedModel
        ? t("Loading Codex Direct models. Current model is unverified.")
        : t("Loading Codex Direct models…"),
      errorMessage: hasSavedModel
        ? t("Could not load Codex Direct models. Current model is unverified.")
        : t("Could not load Codex Direct models."),
      errorTitle: snapshot.error,
      emptyMessage: t("Codex Direct did not return any available models."),
      retryLabel: t("Retry loading Codex Direct models"),
      onRetry: (event) => {
        if (!args.isPrimaryPointerEvent(event)) return;
        event.preventDefault();
        event.stopPropagation();
        ensureCatalog(true);
      },
    });
    if (
      !statusHandled &&
      selected?.catalogAvailability === "saved-unavailable"
    ) {
      args.appendEmptyState(
        args.menu,
        t(
          "The saved Codex Direct model is no longer available. Select another model before sending.",
        ),
      );
    }
  };

  const appendReasoningChoices = (args: {
    menu: HTMLDivElement;
    renderChoices: ReasoningChoiceRenderer;
    closeMenu: () => void;
  }): boolean => {
    const entry = getSelectedEntry();
    if (!entry) return false;
    const selection = resolveReasoningSelection();
    args.renderChoices({
      menu: args.menu,
      choices: selection.choices,
      currentValue: selection.mode,
      onSelect: (value) => {
        setCodexDirectReasoningSelection(entry.model, value);
        args.closeMenu();
        params.onStateChange();
      },
    });
    return true;
  };

  const getRetryReasoning = (
    entry: RuntimeModelEntry,
  ): ReasoningConfig | undefined => {
    if (entry.authMode !== "codex_auth") return undefined;
    return buildCodexReasoningConfig(
      reconcileCodexDirectReasoningChoice(
        entry.model,
        getCodexDirectReasoningSelection(entry.model),
      ),
    );
  };

  const getSendReasoning = (): ReasoningConfig | undefined => {
    const entry = getSelectedEntry();
    if (!entry) return undefined;
    if (entry.catalogAvailability === "saved-unavailable") {
      throw new Error(
        "The saved Codex Direct model is unavailable. Select a model from the current catalog before sending.",
      );
    }
    return buildCodexReasoningConfig(resolveReasoningSelection().mode);
  };

  const unsubscribe = subscribeToCodexDirectCatalog(() => {
    if (!disposed) params.onStateChange();
  });
  ensureCatalog();

  return {
    hasConfiguredProvider,
    getSelectedEntry,
    resolveReasoningSelection,
    ensureCatalog,
    appendCatalogStatus,
    appendReasoningChoices,
    getRetryReasoning,
    getSendReasoning,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
    },
  };
}

export type CodexDirectModelReasoningController = ReturnType<
  typeof createCodexDirectModelReasoningController
>;
