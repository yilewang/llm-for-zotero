import type { ConversationSystem } from "../../shared/types";
import type { OriginalAgentPermissionMode } from "../../shared/originalAgentPermissionMode";
import type { ClaudePermissionMode } from "../../shared/claudePermissionMode";
import { t } from "../../utils/i18n";
import {
  buildPermissionAccessibleLabel,
  getClaudePermissionModeFromSelectionKey,
  getOriginalPermissionModeFromSelectionKey,
  getOriginalPermissionOptions,
  type PermissionOption,
} from "../../shared/permissionOptions";
import {
  getOriginalAgentPermissionMode,
  setOriginalAgentPermissionMode,
} from "../../agent/originalAgentPermissionMode";
import {
  getClaudeBridgeUrl,
  getClaudePermissionModePref,
  getClaudeSettingSourcesByPref,
  setClaudePermissionModePref,
} from "../../claudeCode/prefs";
import {
  fetchClaudePermissionModeCatalog,
  reconcileClaudePermissionMode,
} from "../../claudeCode/permissionModes";
import { getConfiguredCodexAppServerBinaryPath } from "../../codexAppServer/binaryPath";
import {
  getCodexPermissionOptionCatalog,
  subscribeCodexPermissionProcessChanges,
  type CodexPermissionOptionCatalog,
} from "../../codexAppServer/permissionProfiles";
import { setCodexPermissionStatePref } from "../../codexAppServer/prefs";
import { applyCodexPermissionChoice } from "../../codexAppServer/permissionState";
import { resolveCodexNativeRuntimeCwd } from "../../codexAppServer/runtimeCwd";
import {
  positionFloatingMenu,
  setFloatingMenuOpen,
} from "./setupHandlers/controllers/menuController";
import { showStandaloneConfirmationDialog } from "./standaloneConfirmationDialog";

export const FOOTER_PERMISSION_MENU_OPEN_CLASS = "llm-permission-menu-open";

type VisiblePermissionSurface = {
  kind: "original" | "claude" | "codex";
  selectedKey: string;
  options: PermissionOption[];
};

export type PermissionSurface =
  | { kind: "hidden" }
  | VisiblePermissionSurface
  | {
      kind: "loading";
      provider: "claude" | "codex";
      message: string;
    }
  | {
      kind: "error";
      provider: "claude" | "codex";
      message: string;
    };

type PermissionCatalogLoaders = {
  loadClaudeOptions: () => Promise<PermissionOption[]>;
  loadCodexCatalog: () => Promise<CodexPermissionOptionCatalog>;
};

let permissionCatalogLoadersForTests: PermissionCatalogLoaders | null = null;

export function setFooterPermissionCatalogLoadersForTests(
  loaders?: PermissionCatalogLoaders,
): void {
  permissionCatalogLoadersForTests = loaders ?? null;
}

type RuntimeMode = "chat" | "agent";

export function resolvePermissionSurface(params: {
  conversationSystem: ConversationSystem;
  runtimeMode: RuntimeMode;
  originalSelectedId: OriginalAgentPermissionMode;
  claudeSelectedId: ClaudePermissionMode;
  claudeOptions?: PermissionOption[];
  codexCatalog?: CodexPermissionOptionCatalog;
}): PermissionSurface {
  if (params.conversationSystem === "claude_code") {
    return params.claudeOptions
      ? {
          kind: "claude",
          selectedKey: `claude:${params.claudeSelectedId}`,
          options: params.claudeOptions,
        }
      : {
          kind: "loading",
          provider: "claude",
          message: "Loading permissions…",
        };
  }
  if (params.conversationSystem === "codex") {
    return params.codexCatalog
      ? {
          kind: "codex",
          selectedKey: params.codexCatalog.selectedKey,
          options: params.codexCatalog.options,
        }
      : { kind: "loading", provider: "codex", message: "Loading permissions…" };
  }
  if (params.runtimeMode !== "agent") return { kind: "hidden" };
  return {
    kind: "original",
    selectedKey: `original:${params.originalSelectedId}`,
    options: getOriginalPermissionOptions(),
  };
}

export function attachFooterPermissionControl(params: {
  body: Element;
  control: HTMLDivElement | null;
  button: HTMLButtonElement | null;
  menu: HTMLDivElement | null;
  getConversationSystem: () => ConversationSystem;
  getRuntimeMode: () => RuntimeMode;
  onWarning?: (message: string) => void;
  loadClaudeOptions?: () => Promise<PermissionOption[]>;
  loadCodexCatalog?: () => Promise<CodexPermissionOptionCatalog>;
  confirmFullAccess?: () => boolean | Promise<boolean>;
}) {
  const { control, button, menu } = params;
  let generation = 0;
  let activeProvider: ConversationSystem | null = null;
  let disposed = false;
  let surface: PermissionSurface = { kind: "hidden" };
  let codexCatalog: CodexPermissionOptionCatalog | null = null;
  let inFlightCatalog: {
    provider: "claude_code" | "codex";
    key: string;
    promise: Promise<PermissionOption[] | CodexPermissionOptionCatalog>;
  } | null = null;

  const close = () => {
    if (!menu || !button) return;
    setFloatingMenuOpen(menu, FOOTER_PERMISSION_MENU_OPEN_CLASS, false);
    menu.replaceChildren();
    button.setAttribute("aria-expanded", "false");
  };

  const confirmFullAccess = async (): Promise<boolean> => {
    if (params.confirmFullAccess)
      return Boolean(await params.confirmFullAccess());
    close();
    button?.focus();
    return await showStandaloneConfirmationDialog(params.body.ownerDocument, {
      title: t("Enable Codex full access?"),
      message: t(
        "Codex will have unrestricted access to the internet and any file available to Codex.",
      ),
      confirmLabel: t("Enable full access"),
      cancelLabel: t("Cancel"),
      destructive: true,
    });
  };

  const persistSelection = async (
    next: VisiblePermissionSurface,
    option: PermissionOption,
  ): Promise<void> => {
    if (next.kind === "original") {
      const mode = getOriginalPermissionModeFromSelectionKey(
        option.selectionKey,
      );
      if (mode) setOriginalAgentPermissionMode(mode);
      return;
    }
    if (next.kind === "claude") {
      const mode = getClaudePermissionModeFromSelectionKey(option.selectionKey);
      if (mode) setClaudePermissionModePref(mode);
      return;
    }
    const activeCatalog = codexCatalog;
    const choice = activeCatalog?.choices.get(option.selectionKey);
    if (!activeCatalog || !choice) return;
    if (choice.kind === "preset" && choice.preset === "full") {
      if (!(await confirmFullAccess())) return;
      if (
        disposed ||
        surface !== next ||
        activeCatalog !== codexCatalog ||
        params.getConversationSystem() !== "codex"
      ) {
        return;
      }
    }
    setCodexPermissionStatePref(
      applyCodexPermissionChoice({
        current: activeCatalog.state,
        choice,
      }),
    );
  };

  const render = (next: PermissionSurface) => {
    surface = next;
    if (!control || !button || !menu) return;
    close();
    if (next.kind === "hidden") {
      control.style.display = "none";
      return;
    }
    control.style.display = "inline-flex";
    if (next.kind === "loading" || next.kind === "error") {
      button.disabled = true;
      button.textContent = next.kind === "loading" ? "loading…" : "unavailable";
      button.title = next.message;
      button.setAttribute("aria-label", next.message);
      return;
    }
    button.disabled = false;
    const selected = next.options.find(
      (option) => option.selectionKey === next.selectedKey,
    );
    const fallback: PermissionOption = {
      provider: next.kind,
      selectionKey: next.selectedKey,
      fullLabel: "Unavailable",
      compactLabel: "unavailable",
      description: "The saved permission value is not available.",
      available: false,
    };
    const selectedOption = selected ?? fallback;
    button.textContent = selectedOption.compactLabel;
    button.title = buildPermissionAccessibleLabel(selectedOption);
    button.setAttribute(
      "aria-label",
      buildPermissionAccessibleLabel(selectedOption),
    );

    for (const option of next.options) {
      const row = params.body.ownerDocument.createElement("button");
      row.type = "button";
      row.className = "llm-permission-option";
      row.dataset.permissionProvider = option.provider;
      row.dataset.selectionKey = option.selectionKey;
      row.dataset.permissionId = option.selectionKey;
      row.disabled = !option.available;
      row.setAttribute("role", "menuitemradio");
      row.setAttribute(
        "aria-checked",
        String(option.selectionKey === next.selectedKey),
      );
      row.classList.toggle(
        "llm-permission-option-selected",
        option.selectionKey === next.selectedKey,
      );
      const accessibleLabel = buildPermissionAccessibleLabel(option);
      row.setAttribute("aria-label", accessibleLabel);
      row.title = option.disabledReason
        ? `${accessibleLabel} — ${option.disabledReason}`
        : accessibleLabel;
      row.textContent = option.fullLabel;
      row.addEventListener("click", () => {
        if (!option.available) return;
        void (async () => {
          await persistSelection(next, option);
          close();
          await sync();
        })();
      });
      menu.appendChild(row);
    }
  };

  const loadClaude =
    params.loadClaudeOptions ??
    permissionCatalogLoadersForTests?.loadClaudeOptions ??
    (async () => {
      const catalog = await fetchClaudePermissionModeCatalog({
        bridgeUrl: getClaudeBridgeUrl(),
        settingSources: getClaudeSettingSourcesByPref(),
      });
      return catalog.options;
    });
  const loadCodex =
    params.loadCodexCatalog ??
    permissionCatalogLoadersForTests?.loadCodexCatalog ??
    (() =>
      getCodexPermissionOptionCatalog({
        codexPath: getConfiguredCodexAppServerBinaryPath(),
        cwd: resolveCodexNativeRuntimeCwd(),
      }));

  const sync = async () => {
    if (disposed) return;
    const currentGeneration = ++generation;
    const provider = params.getConversationSystem();
    if (provider !== activeProvider) {
      close();
      activeProvider = provider;
      codexCatalog = null;
      inFlightCatalog = null;
    }
    const common = {
      conversationSystem: provider,
      runtimeMode: params.getRuntimeMode(),
      originalSelectedId: getOriginalAgentPermissionMode(),
      claudeSelectedId: getClaudePermissionModePref(),
    };
    if (provider === "upstream") {
      render(resolvePermissionSurface(common));
      return;
    }
    render(resolvePermissionSurface(common));
    const catalogKey =
      provider === "claude_code"
        ? `${getClaudeBridgeUrl()}\u0000${getClaudeSettingSourcesByPref().join(",")}`
        : `${getConfiguredCodexAppServerBinaryPath()}\u0000${resolveCodexNativeRuntimeCwd()}`;
    let requestedPromise =
      inFlightCatalog?.provider === provider &&
      inFlightCatalog.key === catalogKey
        ? inFlightCatalog.promise
        : null;
    if (!requestedPromise) {
      requestedPromise =
        provider === "claude_code" ? loadClaude() : loadCodex();
      inFlightCatalog = {
        provider,
        key: catalogKey,
        promise: requestedPromise,
      };
    }
    try {
      const result = await requestedPromise;
      if (
        disposed ||
        currentGeneration !== generation ||
        provider !== params.getConversationSystem()
      ) {
        return;
      }
      if (inFlightCatalog?.promise === requestedPromise) inFlightCatalog = null;
      if (provider === "claude_code") {
        const options = result as PermissionOption[];
        const reconciliation = reconcileClaudePermissionMode({
          selectedId: getClaudePermissionModePref(),
          options,
        });
        if (reconciliation.selectedId !== getClaudePermissionModePref()) {
          setClaudePermissionModePref(reconciliation.selectedId);
          if (reconciliation.warning)
            params.onWarning?.(reconciliation.warning);
        }
        render(
          resolvePermissionSurface({
            ...common,
            claudeSelectedId: reconciliation.selectedId,
            claudeOptions: options,
          }),
        );
      } else {
        codexCatalog = result as CodexPermissionOptionCatalog;
        render(resolvePermissionSurface({ ...common, codexCatalog }));
      }
    } catch (error) {
      if (inFlightCatalog?.promise === requestedPromise) inFlightCatalog = null;
      if (
        disposed ||
        currentGeneration !== generation ||
        provider !== params.getConversationSystem()
      ) {
        return;
      }
      render({
        kind: "error",
        provider: provider === "claude_code" ? "claude" : "codex",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const onButtonClick = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!button || !menu || button.disabled) return;
    if (button.getAttribute("aria-expanded") === "true") {
      close();
      return;
    }
    if (
      surface.kind === "hidden" ||
      surface.kind === "loading" ||
      surface.kind === "error"
    ) {
      return;
    }
    render(surface);
    positionFloatingMenu(params.body, menu, button, {
      horizontalAlignment: "center",
      verticalPlacement: "above",
    });
    if (menu.scrollHeight <= menu.clientHeight) menu.style.overflowY = "hidden";
    setFloatingMenuOpen(menu, FOOTER_PERMISSION_MENU_OPEN_CLASS, true);
    button.setAttribute("aria-expanded", "true");
  };
  const stopMenuPointerEvent = (event: Event) => event.stopPropagation();
  const onOutsidePointerDown = (event: Event) => {
    if (!menu || menu.style.display === "none") return;
    const target = event.target as Node | null;
    if (target && (control?.contains(target) || menu.contains(target))) return;
    close();
  };
  const onEscape = (event: Event) => {
    const keyboardEvent = event as KeyboardEvent;
    if (
      keyboardEvent.key !== "Escape" ||
      !menu ||
      menu.style.display === "none"
    ) {
      return;
    }
    close();
    button?.focus();
    keyboardEvent.preventDefault();
    keyboardEvent.stopPropagation();
  };
  button?.addEventListener("click", onButtonClick);
  menu?.addEventListener("pointerdown", stopMenuPointerEvent);
  menu?.addEventListener("mousedown", stopMenuPointerEvent);
  params.body.ownerDocument.addEventListener(
    "pointerdown",
    onOutsidePointerDown,
    true,
  );
  params.body.ownerDocument.addEventListener("keydown", onEscape, true);
  const unsubscribeCodexProcessChanges = subscribeCodexPermissionProcessChanges(
    () => {
      if (params.getConversationSystem() !== "codex") return;
      inFlightCatalog = null;
      close();
      void sync();
    },
  );

  return {
    sync,
    close,
    dispose() {
      disposed = true;
      generation += 1;
      unsubscribeCodexProcessChanges();
      close();
      button?.removeEventListener("click", onButtonClick);
      menu?.removeEventListener("pointerdown", stopMenuPointerEvent);
      menu?.removeEventListener("mousedown", stopMenuPointerEvent);
      params.body.ownerDocument.removeEventListener(
        "pointerdown",
        onOutsidePointerDown,
        true,
      );
      params.body.ownerDocument.removeEventListener("keydown", onEscape, true);
    },
  };
}
