import { getAllSkills } from "../../../../agent/skills";
import type { AgentSkill } from "../../../../agent/skills/skillLoader";
import {
  getAgentApi,
  getCoreAgentRuntime,
  initAgentSubsystem,
} from "../../../../agent";
import type { ActionRequestContext } from "../../../../agent/actions";
import type {
  AgentConfirmationResolution,
  AgentPendingAction,
} from "../../../../agent/types";
import { renderPendingActionCard } from "../../agentTrace/render";
import { refreshClaudeSlashCommands } from "../../../../claudeCode/runtime";
import { createElement } from "../../../../utils/domHelpers";
import { t } from "../../../../utils/i18n";
import type { ModelProviderAuthMode } from "../../../../utils/modelProviders";
import type { ProviderProtocol } from "../../../../utils/providerProtocol";
import { getAgentModeEnabled } from "../../prefHelpers";
import {
  formatActionLabel,
  resolveActionCompletionStatusText,
} from "../../actionStatusText";
import { buildPaperKey } from "../../pdfContext";
import {
  resolvePaperScopedCommandInput,
  type PaperScopedActionCollectionCandidate,
  type PaperScopedActionProfile,
} from "../../paperScopeCommand";
import { resolveSlashActionChatMode } from "../../slashMenuBehavior";
import { resolveDisplayConversationKind } from "../../portalScope";
import { selectedCollectionContextCache } from "../../state";
import type { CollectionContextRef, PaperContextRef } from "../../types";
import {
  isFloatingMenuOpen,
  setFloatingMenuOpen,
  SLASH_MENU_OPEN_CLASS,
} from "./menuController";

type StatusLevel = "ready" | "warning" | "error";
type ActionPickerItem = {
  name: string;
  description: string;
  inputSchema: object;
};
type ActionProfile = {
  model?: string;
  apiBase?: string;
  apiKey?: string;
  authMode?: ModelProviderAuthMode;
  providerProtocol?: ProviderProtocol;
};

type ActionCommandControllerDeps = {
  body: Element;
  panelRoot: HTMLElement;
  inputBox: HTMLTextAreaElement;
  slashMenu: HTMLDivElement | null;
  uploadBtn: HTMLButtonElement | null;
  actionPicker: HTMLDivElement | null;
  actionPickerList: HTMLDivElement | null;
  actionHitlPanel: HTMLDivElement | null;
  chatBox: HTMLDivElement | null;
  getItem: () => Zotero.Item | null;
  getActiveActionToken: () => {
    query: string;
    slashStart: number;
    caretEnd: number;
  } | null;
  persistDraftInputForCurrentConversation: () => void;
  shouldRenderDynamicSlashMenu: () => boolean;
  shouldRenderSkillSlashMenu: () => boolean;
  isWebChatMode: () => boolean;
  isClaudeConversationSystem: () => boolean;
  getCurrentRuntimeMode: () => string;
  setCurrentRuntimeMode: (mode: "chat" | "agent") => void;
  getCurrentLibraryID: () => number;
  resolveCurrentPaperBaseItem: () => Zotero.Item | null;
  getAllEffectivePaperContexts: (item: Zotero.Item) => PaperContextRef[];
  getEffectivePdfModePaperContexts: (
    item: Zotero.Item,
    paperContexts: PaperContextRef[],
  ) => PaperContextRef[];
  getEffectiveFullTextPaperContexts: (
    item: Zotero.Item,
    paperContexts: PaperContextRef[],
  ) => PaperContextRef[];
  getSelectedProfile: () => ActionProfile | null;
  getDoSend: () =>
    | ((options?: {
        overrideText?: string;
        preserveInputDraft?: boolean;
      }) => Promise<void>)
    | null;
  closeRetryModelMenu: () => void;
  closeModelMenu: () => void;
  closeReasoningMenu: () => void;
  closeHistoryNewMenu: () => void;
  closeHistoryMenu: () => void;
  closeResponseMenu: () => void;
  closePromptMenu: () => void;
  closeExportMenu: () => void;
  setStatusMessage?: (message: string, level: StatusLevel) => void;
  logError: (message: string, error?: unknown) => void;
};

export function createActionCommandController(
  deps: ActionCommandControllerDeps,
): {
  isActionPickerOpen: () => boolean;
  closeActionPicker: () => void;
  moveActionPickerSelection: (delta: number) => void;
  selectActiveActionPickerItem: () => Promise<void>;
  renderDynamicSlashMenuSections: (query?: string) => void;
  scheduleActionPickerTrigger: () => void;
  closeSlashMenu: () => void;
  openSlashMenuWithSelection: () => void;
  moveSlashMenuSelection: (delta: number) => void;
  selectActiveSlashMenuItem: () => void;
  syncHasActionCardAttr: () => void;
  clearForcedSkill: () => void;
  clearCommandChip: () => void;
  clearCommandRowSelection: () => boolean;
  getActiveCommandAction: () => { name: string } | null;
  consumeForcedSkillIds: () => string[] | undefined;
  handleInlineCommand: (actionName: string, params: string) => Promise<void>;
  consumeActiveActionToken: () => boolean;
} {
  const {
    body,
    panelRoot,
    inputBox,
    slashMenu,
    uploadBtn,
    actionPicker,
    actionPickerList,
    actionHitlPanel,
    chatBox,
  } = deps;
  let slashMenuActiveIndex = -1;
  let actionPickerItems: ActionPickerItem[] = [];
  let actionPickerActiveIndex = 0;
  let forcedSkillId: string | null = null;
  let forcedSkillBadge: HTMLElement | null = null;
  let activeCommandAction: ActionPickerItem | null = null;
  let activeCommandBadge: HTMLElement | null = null;

  const setStatus = (message: string, level: StatusLevel) => {
    deps.setStatusMessage?.(message, level);
  };

  const consumeActiveActionToken = (): boolean => {
    const token = deps.getActiveActionToken();
    if (!token) return false;
    const beforeSlash = inputBox.value.slice(0, token.slashStart);
    const afterCaret = inputBox.value.slice(token.caretEnd);
    inputBox.value = `${beforeSlash}${afterCaret}`;
    deps.persistDraftInputForCurrentConversation();
    const nextCaret = beforeSlash.length;
    inputBox.setSelectionRange(nextCaret, nextCaret);
    return true;
  };

  const clearAgentSlashItems = () => {
    if (!slashMenu) return;
    Array.from(slashMenu.querySelectorAll("[data-slash-agent-item]")).forEach(
      (element) => (element as Element).remove(),
    );
  };

  const clearSkillSlashItems = () => {
    if (!slashMenu) return;
    slashMenu
      .querySelectorAll("[data-slash-skill-item]")
      .forEach((element: Element) => element.remove());
  };

  const getVisibleSlashItems = (): HTMLButtonElement[] => {
    if (!slashMenu) return [];
    const win = body.ownerDocument?.defaultView;
    return Array.from(
      slashMenu.querySelectorAll(".llm-action-picker-item"),
    ).filter((element) => {
      const style = win?.getComputedStyle(element as Element);
      return style ? style.display !== "none" : true;
    }) as HTMLButtonElement[];
  };

  const updateSlashMenuSelection = () => {
    const items = getVisibleSlashItems();
    items.forEach((item, index) => {
      item.setAttribute(
        "aria-selected",
        index === slashMenuActiveIndex ? "true" : "false",
      );
    });
    if (
      slashMenuActiveIndex < 0 ||
      !items[slashMenuActiveIndex] ||
      !slashMenu
    ) {
      return;
    }
    const activeItem = items[slashMenuActiveIndex];
    let offsetTop = 0;
    let element: HTMLElement | null = activeItem;
    while (element && element !== slashMenu) {
      offsetTop += element.offsetTop;
      element = element.offsetParent as HTMLElement | null;
    }
    const itemBottom = offsetTop + activeItem.offsetHeight;
    if (offsetTop < slashMenu.scrollTop) {
      slashMenu.scrollTop = offsetTop;
    } else if (itemBottom > slashMenu.scrollTop + slashMenu.clientHeight) {
      slashMenu.scrollTop = itemBottom - slashMenu.clientHeight;
    }
  };

  const openSlashMenuWithSelection = () => {
    slashMenuActiveIndex = 0;
    setFloatingMenuOpen(slashMenu, SLASH_MENU_OPEN_CLASS, true);
    updateSlashMenuSelection();
  };

  const closeSlashMenu = () => {
    slashMenuActiveIndex = -1;
    clearAgentSlashItems();
    if (slashMenu) {
      Array.from(slashMenu.querySelectorAll(".llm-action-picker-item")).forEach(
        (el) => (el as HTMLButtonElement).removeAttribute("aria-selected"),
      );
    }
    setFloatingMenuOpen(slashMenu, SLASH_MENU_OPEN_CLASS, false);
    if (uploadBtn) {
      uploadBtn.setAttribute("aria-expanded", "false");
    }
  };

  const moveSlashMenuSelection = (delta: number) => {
    const items = getVisibleSlashItems();
    if (!items.length) return;
    slashMenuActiveIndex =
      (slashMenuActiveIndex + delta + items.length) % items.length;
    updateSlashMenuSelection();
  };

  const selectActiveSlashMenuItem = () => {
    const items = getVisibleSlashItems();
    if (slashMenuActiveIndex >= 0 && items[slashMenuActiveIndex]) {
      items[slashMenuActiveIndex].click();
    }
  };

  const isActionPickerOpen = () =>
    Boolean(actionPicker && actionPicker.style.display !== "none");

  const closeActionPicker = () => {
    if (actionPicker) actionPicker.style.display = "none";
    if (actionPickerList) actionPickerList.innerHTML = "";
    actionPickerItems = [];
    actionPickerActiveIndex = 0;
  };

  const renderActionPicker = () => {
    if (!actionPicker || !actionPickerList) return;
    const ownerDoc = body.ownerDocument;
    if (!ownerDoc) return;
    actionPickerList.innerHTML = "";
    if (!actionPickerItems.length) {
      actionPickerList.appendChild(
        createElement(ownerDoc, "div", "llm-action-picker-empty", {
          textContent: "No actions matched.",
        }),
      );
      actionPicker.style.display = "block";
      return;
    }
    actionPickerItems.forEach((action, index) => {
      const option = createElement(
        ownerDoc,
        "div",
        "llm-action-picker-item",
        {},
      );
      option.setAttribute("role", "option");
      option.setAttribute(
        "aria-selected",
        index === actionPickerActiveIndex ? "true" : "false",
      );
      option.tabIndex = -1;
      option.append(
        createElement(ownerDoc, "div", "llm-action-picker-title", {
          textContent: action.name,
        }),
        createElement(ownerDoc, "div", "llm-action-picker-description", {
          textContent: action.description,
        }),
      );
      option.addEventListener("mousedown", (event: Event) => {
        event.preventDefault();
        actionPickerActiveIndex = index;
        void selectActionPickerItem(index);
      });
      actionPickerList.appendChild(option);
    });
    actionPicker.style.display = "block";
  };

  const moveActionPickerSelection = (delta: number) => {
    if (!actionPickerItems.length) return;
    actionPickerActiveIndex =
      (actionPickerActiveIndex + delta + actionPickerItems.length) %
      actionPickerItems.length;
    renderActionPicker();
  };

  const renderDynamicSlashMenuSections = (query = "") => {
    if (!deps.shouldRenderDynamicSlashMenu()) {
      clearAgentSlashItems();
      clearSkillSlashItems();
      return;
    }
    renderAgentActionsInSlashMenu(query);
    if (deps.shouldRenderSkillSlashMenu()) {
      renderSkillsInSlashMenu(query);
    } else {
      clearSkillSlashItems();
    }
  };

  const scheduleActionPickerTrigger = () => {
    if (!deps.getItem()) {
      closeActionPicker();
      return;
    }
    try {
      if (deps.isWebChatMode()) {
        closeActionPicker();
        closeSlashMenu();
        return;
      }
    } catch {
      /* keep slash closed if mode cannot be resolved */
    }
    closeActionPicker();
    const token = deps.getActiveActionToken();
    if (!token) {
      closeSlashMenu();
      return;
    }
    renderDynamicSlashMenuSections(token.query.toLowerCase().trim());
    if (!isFloatingMenuOpen(slashMenu)) {
      deps.closeRetryModelMenu();
      deps.closeModelMenu();
      deps.closeReasoningMenu();
      deps.closeHistoryNewMenu();
      deps.closeHistoryMenu();
      deps.closeResponseMenu();
      deps.closePromptMenu();
      deps.closeExportMenu();
      openSlashMenuWithSelection();
    } else {
      slashMenuActiveIndex = 0;
      updateSlashMenuSelection();
    }
  };

  const syncHasActionCardAttr = () => {
    const hasCard = Boolean(
      chatBox?.querySelector(
        ".llm-action-inline-card, .llm-action-progress-card",
      ),
    );
    if (hasCard) {
      panelRoot.dataset.hasActionCard = "true";
    } else {
      delete panelRoot.dataset.hasActionCard;
    }
  };

  const closeActionHitlPanel = () => {
    if (actionHitlPanel) {
      actionHitlPanel.style.display = "none";
      actionHitlPanel.innerHTML = "";
    }
    chatBox?.querySelector(".llm-action-inline-card")?.remove();
    syncHasActionCardAttr();
  };

  const showActionHitlCard = (
    requestId: string,
    action: AgentPendingAction,
  ): Promise<AgentConfirmationResolution> =>
    new Promise((resolve) => {
      getAgentApi().registerPendingConfirmation(requestId, (resolution) => {
        closeActionHitlPanel();
        resolve(resolution);
      });
      const ownerDoc = body.ownerDocument;
      if (!ownerDoc || !chatBox) return;
      chatBox.querySelector(".llm-action-inline-card")?.remove();
      const wrapper = ownerDoc.createElement("div");
      wrapper.className = "llm-action-inline-card";
      wrapper.appendChild(
        renderPendingActionCard(ownerDoc, { requestId, action }),
      );
      chatBox.appendChild(wrapper);
      chatBox.scrollTop = chatBox.scrollHeight;
      syncHasActionCardAttr();
    });

  const createActionProgressIndicator = (actionName: string) => {
    const ownerDoc = body.ownerDocument;
    let element: HTMLDivElement | null = null;
    let stepText: HTMLDivElement | null = null;
    let summaryText: HTMLDivElement | null = null;

    const ensureMounted = () => {
      if (!ownerDoc || !chatBox) return;
      if (element && element.isConnected) return;
      chatBox.querySelector(".llm-action-progress-card")?.remove();
      const wrapper = ownerDoc.createElement("div");
      wrapper.className = "llm-action-progress-card";
      const header = ownerDoc.createElement("div");
      header.className = "llm-action-progress-header";
      const title = ownerDoc.createElement("div");
      title.className = "llm-action-progress-title";
      title.textContent = `${formatActionLabel(actionName)}`;
      const typing = ownerDoc.createElement("div");
      typing.className = "llm-typing llm-action-progress-typing";
      typing.innerHTML =
        '<span class="llm-typing-dot"></span><span class="llm-typing-dot"></span><span class="llm-typing-dot"></span>';
      header.append(title, typing);
      wrapper.appendChild(header);
      stepText = ownerDoc.createElement("div");
      stepText.className = "llm-action-progress-step";
      stepText.textContent = "Starting...";
      wrapper.appendChild(stepText);
      summaryText = ownerDoc.createElement("div");
      summaryText.className = "llm-action-progress-summary";
      summaryText.textContent = "";
      wrapper.appendChild(summaryText);
      chatBox.appendChild(wrapper);
      chatBox.scrollTop = chatBox.scrollHeight;
      element = wrapper;
      syncHasActionCardAttr();
    };

    ensureMounted();
    return {
      setStep(stepName: string, index: number, total: number) {
        ensureMounted();
        if (stepText) stepText.textContent = `${stepName} (${index}/${total})`;
        if (summaryText) summaryText.textContent = "";
      },
      setSummary(summary: string) {
        ensureMounted();
        if (summaryText) summaryText.textContent = summary;
      },
      hide() {
        element?.remove();
        element = null;
        stepText = null;
        summaryText = null;
        syncHasActionCardAttr();
      },
      remove() {
        element?.remove();
        element = null;
        stepText = null;
        summaryText = null;
        syncHasActionCardAttr();
      },
    };
  };

  const getNeedsUserInputFields = (
    _actionName: string,
    schema: object,
  ): string[] => {
    const typedSchema = schema as { required?: string[] };
    if (!typedSchema.required?.length) return [];
    const autoFillable = new Set(["itemId"]);
    return typedSchema.required.filter((field) => !autoFillable.has(field));
  };

  const buildActionInput = (
    _actionName: string,
    schema: object,
    extraFields: Record<string, string>,
  ): Record<string, unknown> => {
    const input: Record<string, unknown> = { ...extraFields };
    const typedSchema = schema as { required?: string[] };
    if (typedSchema.required?.includes("itemId")) {
      const realItem = deps.resolveCurrentPaperBaseItem() || deps.getItem();
      if (realItem?.id) input.itemId = realItem.id;
    }
    return input;
  };

  const buildActionRequestContext = (): ActionRequestContext & {
    mode: "paper" | "library";
  } => {
    const item = deps.getItem();
    if (!item) {
      return {
        mode: "library",
        selectedPaperContexts: [],
        fullTextPaperContexts: [],
        selectedCollectionContexts: [],
      };
    }
    const allPaperContexts = deps.getAllEffectivePaperContexts(item);
    const pdfModeKeys = new Set(
      deps
        .getEffectivePdfModePaperContexts(item, allPaperContexts)
        .map((paperContext) => buildPaperKey(paperContext)),
    );
    const selectedPaperContexts = allPaperContexts.filter(
      (paperContext) => !pdfModeKeys.has(buildPaperKey(paperContext)),
    );
    return {
      mode:
        resolveDisplayConversationKind(item) === "global" ? "library" : "paper",
      activeItemId:
        Number(deps.resolveCurrentPaperBaseItem()?.id || 0) || undefined,
      selectedPaperContexts,
      fullTextPaperContexts: deps.getEffectiveFullTextPaperContexts(
        item,
        selectedPaperContexts,
      ),
      selectedCollectionContexts: [
        ...(selectedCollectionContextCache.get(item.id) || []),
      ] as CollectionContextRef[],
    };
  };

  const getPaperScopedCollectionCandidates =
    (): PaperScopedActionCollectionCandidate[] => {
      const libraryID = deps.getCurrentLibraryID();
      if (!libraryID) return [];
      return getAgentApi()
        .getZoteroGateway()
        .listCollectionSummaries(libraryID)
        .map((entry) => ({
          collectionId: entry.collectionId,
          name: entry.name,
          path: entry.path,
        }));
    };

  const resolvePaperScopedActionInput = async (
    actionName: string,
    params: string,
    profile: PaperScopedActionProfile,
  ): Promise<Record<string, unknown> | "scope_required" | null> => {
    try {
      await initAgentSubsystem();
      const result = resolvePaperScopedCommandInput(
        params,
        buildActionRequestContext(),
        profile,
        getPaperScopedCollectionCandidates(),
      );
      if (result.kind === "error") {
        setStatus(result.error, "error");
        return null;
      }
      if (result.kind === "scope_required") return "scope_required";
      return result.input;
    } catch (error) {
      deps.logError(`LLM: failed to resolve /${actionName} input`, error);
      setStatus("Agent system unavailable", "error");
      return null;
    }
  };

  const getPaperScopedPromptOptions = (
    profile: PaperScopedActionProfile,
  ): {
    firstScopeLabel?: string;
    firstScopeInput?: Record<string, unknown>;
    allScopeLabel?: string;
    allScopeInput?: Record<string, unknown>;
  } => ({
    firstScopeLabel:
      profile.scopePromptOptions?.first?.label || "First 20 papers",
    firstScopeInput: profile.scopePromptOptions?.first?.input || {
      scope: "all",
      limit: 20,
    },
    allScopeLabel: profile.scopePromptOptions?.all?.label || "Whole library",
    allScopeInput: profile.scopePromptOptions?.all?.input || { scope: "all" },
  });

  const showActionLaunchForm = (
    actionName: string,
    requiredFields: string[],
    schema: object,
  ): Promise<Record<string, unknown> | null> =>
    new Promise((resolve) => {
      const ownerDoc = body.ownerDocument;
      if (!ownerDoc || !chatBox) {
        resolve(null);
        return;
      }
      const properties =
        (schema as { properties?: Record<string, { description?: string }> })
          .properties || {};
      chatBox.querySelector(".llm-action-inline-card")?.remove();
      const wrapper = ownerDoc.createElement("div");
      wrapper.className = "llm-action-inline-card";
      const form = createElement(ownerDoc, "div", "llm-action-launch-form", {});
      form.appendChild(
        createElement(ownerDoc, "div", "llm-action-launch-form-header", {
          textContent: formatActionLabel(actionName),
        }),
      );
      const fieldEls: Array<{
        name: string;
        input: HTMLInputElement | HTMLTextAreaElement;
      }> = [];
      for (const fieldName of requiredFields) {
        const label = createElement(
          ownerDoc,
          "label",
          "llm-action-launch-form-label",
          {
            textContent: properties[fieldName]?.description ?? fieldName,
          },
        );
        const input = createElement(
          ownerDoc,
          "textarea",
          "llm-action-launch-form-input llm-input",
          { placeholder: fieldName },
        ) as HTMLTextAreaElement;
        input.rows = 2;
        form.append(label, input);
        fieldEls.push({ name: fieldName, input });
      }
      const buttons = createElement(
        ownerDoc,
        "div",
        "llm-action-launch-form-btns",
        {},
      );
      const runButton = createElement(
        ownerDoc,
        "button",
        "llm-action-launch-form-run-btn",
        { textContent: "Run", type: "button" },
      ) as HTMLButtonElement;
      const cancelButton = createElement(
        ownerDoc,
        "button",
        "llm-action-launch-form-cancel-btn",
        { textContent: "Cancel", type: "button" },
      ) as HTMLButtonElement;
      buttons.append(runButton, cancelButton);
      form.appendChild(buttons);
      wrapper.appendChild(form);
      const dismiss = () => {
        closeActionHitlPanel();
        inputBox.focus({ preventScroll: true });
      };
      runButton.addEventListener("click", () => {
        const filled: Record<string, unknown> = {};
        for (const { name, input } of fieldEls)
          filled[name] = input.value.trim();
        dismiss();
        resolve(filled);
      });
      cancelButton.addEventListener("click", () => {
        dismiss();
        resolve(null);
      });
      chatBox.appendChild(wrapper);
      chatBox.scrollTop = chatBox.scrollHeight;
      fieldEls[0]?.input.focus();
    });

  const executeAgentAction = async (
    action: ActionPickerItem,
    parsedInput?: Record<string, unknown>,
  ): Promise<void> => {
    inputBox.focus({ preventScroll: true });
    try {
      await initAgentSubsystem();
    } catch (error) {
      deps.logError("LLM: failed to init agent subsystem", error);
      setStatus("Error: Agent system unavailable", "error");
      return;
    }
    const paperScopeProfile = getAgentApi().getPaperScopedActionProfile(
      action.name,
    );
    let input: Record<string, unknown>;
    if (parsedInput) {
      input = parsedInput;
      const typedSchema = action.inputSchema as { required?: string[] };
      if (typedSchema.required?.includes("itemId") && !input.itemId) {
        const realItem = deps.resolveCurrentPaperBaseItem() || deps.getItem();
        if (realItem?.id) input.itemId = realItem.id;
      }
    } else {
      const needsInput = getNeedsUserInputFields(
        action.name,
        action.inputSchema,
      );
      let extraFields: Record<string, string> = {};
      if (needsInput.length) {
        const filled = await showActionLaunchForm(
          action.name,
          needsInput,
          action.inputSchema,
        );
        if (!filled) return;
        extraFields = Object.fromEntries(
          Object.entries(filled).map(([key, value]) => [key, String(value)]),
        );
      }
      input = buildActionInput(action.name, action.inputSchema, extraFields);
      if (paperScopeProfile) {
        const resolvedInput = await resolvePaperScopedActionInput(
          action.name,
          "",
          paperScopeProfile,
        );
        if (!resolvedInput) return;
        if (resolvedInput === "scope_required") {
          const scopeInput = await showScopeConfirmation(
            action.name,
            getPaperScopedPromptOptions(paperScopeProfile),
          );
          if (!scopeInput) return;
          input = { ...input, ...scopeInput };
        } else {
          input = { ...input, ...resolvedInput };
        }
      }
    }
    setStatus(`Running: ${formatActionLabel(action.name)}...`, "ready");
    const progressIndicator = createActionProgressIndicator(action.name);
    let lastProgressSummary = "";
    try {
      const agentApi = getAgentApi();
      const selectedProfile = deps.getSelectedProfile();
      const actionLlmConfig = selectedProfile?.model
        ? {
            model: selectedProfile.model,
            apiBase: selectedProfile.apiBase || "",
            apiKey: selectedProfile.apiKey,
            authMode: selectedProfile.authMode,
            providerProtocol: selectedProfile.providerProtocol,
          }
        : undefined;
      const result = await agentApi.runAction(action.name, input, {
        libraryID: deps.getCurrentLibraryID(),
        requestContext: buildActionRequestContext(),
        confirmationMode: "native_ui",
        llm: actionLlmConfig,
        onProgress: (event) => {
          if (event.type === "step_start") {
            progressIndicator.setStep(event.step, event.index, event.total);
            setStatus(`${event.step} (${event.index}/${event.total})`, "ready");
          } else if (event.type === "step_done") {
            if (event.summary) {
              lastProgressSummary = event.summary;
              progressIndicator.setSummary(event.summary);
              setStatus(event.summary, "ready");
            }
          } else if (event.type === "confirmation_required") {
            progressIndicator.hide();
          }
        },
        requestConfirmation: (requestId, pendingAction) =>
          showActionHitlCard(requestId, pendingAction),
      });
      setStatus(
        result.ok
          ? resolveActionCompletionStatusText({
              actionName: action.name,
              lastProgressSummary,
            })
          : `${formatActionLabel(action.name)} failed: ${result.error}`,
        result.ok ? "ready" : "error",
      );
    } catch (error) {
      deps.logError("LLM: action picker run error", error);
      setStatus(`Error: ${String(error)}`, "error");
    } finally {
      progressIndicator.remove();
    }
  };

  const clearForcedSkill = (): void => {
    forcedSkillId = null;
    forcedSkillBadge = null;
    const row = body.querySelector("#llm-command-row");
    if (row) {
      row.removeAttribute("data-active");
      row.classList.remove("llm-command-row--skill");
    }
    if (inputBox.dataset.originalPlaceholder !== undefined) {
      inputBox.placeholder = inputBox.dataset.originalPlaceholder;
      delete inputBox.dataset.originalPlaceholder;
    }
  };

  const clearCommandChip = (): void => {
    activeCommandAction = null;
    activeCommandBadge = null;
    const row = body.querySelector("#llm-command-row");
    if (row) {
      row.removeAttribute("data-active");
      row.classList.remove("llm-command-row--skill");
    }
    if (inputBox.dataset.originalPlaceholder !== undefined) {
      inputBox.placeholder = inputBox.dataset.originalPlaceholder;
      delete inputBox.dataset.originalPlaceholder;
    }
  };

  const handleSkillSelection = (skill: AgentSkill): void => {
    clearForcedSkill();
    clearCommandChip();
    forcedSkillId = skill.id;
    if (deps.getCurrentRuntimeMode() !== "agent" && getAgentModeEnabled()) {
      deps.setCurrentRuntimeMode("agent");
    }
    const row = body.querySelector("#llm-command-row");
    const badgeEl = body.querySelector("#llm-command-row-badge");
    if (!row || !badgeEl) return;
    badgeEl.textContent = `/${skill.id}`;
    row.classList.add("llm-command-row--skill");
    row.setAttribute("data-active", "");
    forcedSkillBadge = row as HTMLElement;
    if (inputBox.dataset.originalPlaceholder === undefined) {
      inputBox.dataset.originalPlaceholder = inputBox.placeholder;
    }
    inputBox.placeholder = "";
    inputBox.value = "";
    inputBox.focus({ preventScroll: true });
    const EventCtor =
      (inputBox.ownerDocument?.defaultView as any)?.Event ?? Event;
    inputBox.dispatchEvent(new EventCtor("input", { bubbles: true }));
  };

  const insertCommandToken = (action: ActionPickerItem): void => {
    clearForcedSkill();
    clearCommandChip();
    activeCommandAction = action;
    const row = body.querySelector("#llm-command-row");
    const badgeEl = body.querySelector("#llm-command-row-badge");
    if (!row || !badgeEl) return;
    badgeEl.textContent = `/${action.name}`;
    row.classList.remove("llm-command-row--skill");
    row.setAttribute("data-active", "");
    activeCommandBadge = row as HTMLElement;
    if (inputBox.dataset.originalPlaceholder === undefined) {
      inputBox.dataset.originalPlaceholder = inputBox.placeholder;
    }
    inputBox.placeholder = "";
    inputBox.value = "";
    inputBox.focus({ preventScroll: true });
    const EventCtor =
      (inputBox.ownerDocument?.defaultView as any)?.Event ?? Event;
    inputBox.dispatchEvent(new EventCtor("input", { bubbles: true }));
  };

  const parseCommandParams = (
    _actionName: string,
    params: string,
  ): Record<string, unknown> => {
    const input: Record<string, unknown> = {};
    if (!params) return input;
    const lower = params.toLowerCase();
    const firstNMatch = /(?:for\s+)?(?:first|top)\s+(\d+)\s*items?/i.exec(
      params,
    );
    if (firstNMatch) {
      input.limit = parseInt(firstNMatch[1], 10);
      return input;
    }
    const lastNMatch = /(?:for\s+)?last\s+(\d+)\s*items?/i.exec(params);
    if (lastNMatch) {
      input.limit = parseInt(lastNMatch[1], 10);
      return input;
    }
    const collectionMatch = /(?:for\s+)?collection\s+(.+)/i.exec(params);
    if (collectionMatch) {
      input.scope = "collection";
      input.collectionName = collectionMatch[1].trim();
      return input;
    }
    if (
      lower.includes("whole library") ||
      lower.includes("for all") ||
      lower === "all"
    ) {
      input.scope = "all";
      return input;
    }
    const bareNumber = /^(\d+)$/.exec(params.trim());
    if (bareNumber) input.limit = parseInt(bareNumber[1], 10);
    return input;
  };

  const showScopeConfirmation = (
    actionName: string,
    options?: {
      firstScopeLabel?: string;
      firstScopeInput?: Record<string, unknown>;
      allScopeLabel?: string;
      allScopeInput?: Record<string, unknown>;
    },
  ): Promise<Record<string, unknown> | null> =>
    new Promise((resolve) => {
      const requestId = `scope-confirm-${actionName}-${Date.now()}`;
      const firstScopeLabel = options?.firstScopeLabel || "First 20 items";
      const firstScopeInput = options?.firstScopeInput || { limit: 20 };
      const allScopeLabel = options?.allScopeLabel || "Whole library";
      const allScopeInput = options?.allScopeInput || { scope: "all" };
      getAgentApi().registerPendingConfirmation(requestId, (resolution) => {
        closeActionHitlPanel();
        if (!resolution.approved || resolution.actionId === "cancel") {
          resolve(null);
          return;
        }
        resolve(
          resolution.actionId === "all" ? allScopeInput : firstScopeInput,
        );
      });
      const ownerDoc = body.ownerDocument;
      if (!ownerDoc || !chatBox) return;
      chatBox.querySelector(".llm-action-inline-card")?.remove();
      const wrapper = ownerDoc.createElement("div");
      wrapper.className = "llm-action-inline-card";
      wrapper.appendChild(
        renderPendingActionCard(ownerDoc, {
          requestId,
          action: {
            toolName: actionName,
            mode: "review" as const,
            title: `${formatActionLabel(actionName)}`,
            description: "What scope should this action run on?",
            confirmLabel: "Run",
            cancelLabel: "Cancel",
            actions: [
              {
                id: "first20",
                label: firstScopeLabel,
                style: "primary" as const,
              },
              { id: "all", label: allScopeLabel, style: "secondary" as const },
              { id: "cancel", label: "Cancel", style: "secondary" as const },
            ],
            defaultActionId: "first20",
            cancelActionId: "cancel",
            fields: [],
          },
        }),
      );
      chatBox.appendChild(wrapper);
      chatBox.scrollTop = chatBox.scrollHeight;
    });

  const handleInlineCommand = async (
    actionName: string,
    params: string,
  ): Promise<void> => {
    if (deps.isClaudeConversationSystem()) {
      inputBox.value = params.trim()
        ? `/${actionName} ${params.trim()}`
        : `/${actionName}`;
      await deps.getDoSend()?.();
      return;
    }
    if (
      actionName === "library_statistics" ||
      actionName === "literature_review"
    ) {
      if (deps.getCurrentRuntimeMode() !== "agent" && getAgentModeEnabled()) {
        deps.setCurrentRuntimeMode("agent");
      }
      inputBox.dataset.commandAction = actionName;
      inputBox.dataset.commandParams = params.trim();
      inputBox.value =
        actionName === "library_statistics"
          ? params.trim()
            ? `Show my library statistics: ${params.trim()}`
            : "Show my library statistics and give me a comprehensive overview."
          : params.trim()
            ? `Conduct a literature review on: ${params.trim()}`
            : "I'd like to do a literature review.";
      await deps.getDoSend()?.();
      return;
    }
    let allActions: ActionPickerItem[] = [];
    try {
      await initAgentSubsystem();
      allActions = getAgentApi().listActions();
    } catch {
      setStatus("Agent system unavailable", "error");
      return;
    }
    const action = allActions.find(
      (candidate) => candidate.name === actionName,
    );
    if (!action) {
      setStatus(`Unknown action: ${actionName}`, "error");
      return;
    }
    const paperScopeProfile =
      getAgentApi().getPaperScopedActionProfile(actionName);
    if (paperScopeProfile) {
      const resolvedInput = await resolvePaperScopedActionInput(
        actionName,
        params,
        paperScopeProfile,
      );
      if (!resolvedInput) return;
      const input =
        resolvedInput === "scope_required"
          ? await showScopeConfirmation(
              actionName,
              getPaperScopedPromptOptions(paperScopeProfile),
            )
          : resolvedInput;
      if (!input) return;
      void executeAgentAction(action, input);
      return;
    }
    let input = parseCommandParams(actionName, params);
    const needsScopeConfirm =
      actionName !== "organize_unfiled" && actionName !== "discover_related";
    if (needsScopeConfirm && !params.trim()) {
      const scopeInput = await showScopeConfirmation(actionName);
      if (!scopeInput) return;
      input = { ...input, ...scopeInput };
    }
    void executeAgentAction(action, input);
  };

  const renderSkillsInSlashMenu = (query = "") => {
    const list = slashMenu?.querySelector(".llm-action-picker-list");
    if (!list) return;
    const ownerDoc = body.ownerDocument;
    if (!ownerDoc) return;
    clearSkillSlashItems();
    const allSkills = getAllSkills();
    if (!allSkills.length) return;
    const filtered = query
      ? allSkills.filter(
          (skill: AgentSkill) =>
            skill.id.toLowerCase().includes(query) ||
            skill.description.toLowerCase().includes(query),
        )
      : allSkills;
    if (!filtered.length) return;
    const baseAnchor =
      list.querySelector("[data-slash-section='base']") ||
      list.querySelector("[data-slash-base-item]") ||
      null;
    const mkSkillEl = (tag: string, className: string): HTMLElement => {
      const element = ownerDoc.createElement(tag);
      element.className = className;
      element.setAttribute("data-slash-skill-item", "true");
      return element;
    };
    const sectionLabel = mkSkillEl("div", "llm-slash-menu-section");
    sectionLabel.setAttribute("aria-hidden", "true");
    sectionLabel.textContent = t("Skills");
    list.insertBefore(sectionLabel, baseAnchor);
    filtered.forEach((skill: AgentSkill) => {
      const button = mkSkillEl(
        "button",
        "llm-action-picker-item",
      ) as HTMLButtonElement;
      button.type = "button";
      button.title = skill.description || skill.id;
      const titleEl = ownerDoc.createElement("span");
      titleEl.className = "llm-action-picker-title";
      titleEl.textContent = skill.id;
      const descEl = ownerDoc.createElement("span");
      descEl.className = "llm-action-picker-description";
      descEl.textContent = skill.description;
      const badgeEl = ownerDoc.createElement("span");
      badgeEl.className = "llm-action-picker-badge";
      badgeEl.textContent = t(
        skill.source === "system"
          ? "System"
          : skill.source === "customized"
            ? "Customized"
            : "Personal",
      );
      button.append(titleEl, descEl, badgeEl);
      button.addEventListener("click", (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        consumeActiveActionToken();
        closeSlashMenu();
        handleSkillSelection(skill);
      });
      list.insertBefore(button, baseAnchor);
    });
  };

  const firstSentence = (text: string): string => {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) return "";
    const match = /^(.+?[.!?])(?:\s|$)/.exec(normalized);
    if (match) return match[1];
    return normalized.length <= 80
      ? normalized
      : `${normalized.slice(0, 77).trimEnd()}...`;
  };

  type ClaudeSlashMenuItem = {
    name: string;
    description: string;
    argumentHint?: string;
  };

  const renderAgentActionsInSlashMenu = (query = "") => {
    clearAgentSlashItems();
    const ownerDoc = body.ownerDocument;
    const list = slashMenu?.querySelector(".llm-action-picker-list");
    if (!ownerDoc || !list) return;
    const firstBase = list.firstChild;
    const mkAgentEl = (tag: string, className: string): HTMLElement => {
      const element = ownerDoc.createElement(tag);
      element.className = className;
      element.setAttribute("data-slash-agent-item", "true");
      return element;
    };
    if (deps.isClaudeConversationSystem()) {
      let commands: ClaudeSlashMenuItem[] = [];
      try {
        commands = getAgentApi().listSlashCommands?.() || [];
      } catch {
        commands = [];
      }
      if (!commands.length) {
        const loading = mkAgentEl("div", "llm-slash-menu-section");
        loading.setAttribute("aria-hidden", "true");
        loading.textContent = t("Loading Claude commands...");
        list.insertBefore(loading, firstBase);
        void refreshClaudeSlashCommands(getCoreAgentRuntime(), false)
          .then(() => {
            renderAgentActionsInSlashMenu(query);
          })
          .catch(() => {});
        const baseLabel = mkAgentEl("div", "llm-slash-menu-section");
        baseLabel.setAttribute("aria-hidden", "true");
        baseLabel.textContent = t("Base actions");
        list.insertBefore(baseLabel, firstBase);
        return;
      }
      const filtered = query
        ? commands.filter(
            (command) =>
              command.name.toLowerCase().includes(query) ||
              command.description.toLowerCase().includes(query),
          )
        : commands;
      if (filtered.length) {
        const section = mkAgentEl("div", "llm-slash-menu-section");
        section.setAttribute("aria-hidden", "true");
        section.textContent = "Claude Code";
        list.insertBefore(section, firstBase);
        filtered.forEach((command) => {
          const button = mkAgentEl(
            "button",
            "llm-action-picker-item",
          ) as HTMLButtonElement;
          button.type = "button";
          button.title = command.description;
          const titleEl = ownerDoc.createElement("span");
          titleEl.className = "llm-action-picker-title";
          titleEl.textContent = `/${command.name}`;
          button.append(titleEl);
          button.addEventListener("click", (event: Event) => {
            event.preventDefault();
            event.stopPropagation();
            consumeActiveActionToken();
            closeSlashMenu();
            insertCommandToken({
              name: command.name,
              description: command.description,
              inputSchema: { type: "object", properties: {} },
            });
          });
          list.insertBefore(button, firstBase);
        });
      }
      const baseLabel = mkAgentEl("div", "llm-slash-menu-section");
      baseLabel.setAttribute("aria-hidden", "true");
      baseLabel.textContent = t("Base actions");
      list.insertBefore(baseLabel, firstBase);
      return;
    }
    const chatMode = resolveSlashActionChatMode(
      resolveDisplayConversationKind(deps.getItem()),
    );
    let allActions: ActionPickerItem[] = [];
    try {
      allActions = getAgentApi().listActions(chatMode);
    } catch {
      void initAgentSubsystem()
        .then(() => {
          renderAgentActionsInSlashMenu(query);
        })
        .catch(() => {});
      return;
    }
    const filtered = query
      ? allActions.filter(
          (action) =>
            action.name.toLowerCase().includes(query) ||
            action.description.toLowerCase().includes(query),
        )
      : allActions;
    const baseAnchor = list.querySelector("[data-slash-base-item]") || null;
    const baseLabel = mkAgentEl("div", "llm-slash-menu-section");
    baseLabel.setAttribute("aria-hidden", "true");
    baseLabel.setAttribute("data-slash-section", "base");
    baseLabel.textContent = t("Base actions");
    list.insertBefore(baseLabel, baseAnchor);
    const agentLabel = mkAgentEl("div", "llm-slash-menu-section");
    agentLabel.setAttribute("aria-hidden", "true");
    agentLabel.textContent = t("Agent actions");
    list.insertBefore(agentLabel, baseLabel);
    filtered.forEach((action) => {
      const button = mkAgentEl(
        "button",
        "llm-action-picker-item",
      ) as HTMLButtonElement;
      button.type = "button";
      button.title = action.description;
      const titleEl = ownerDoc.createElement("span");
      titleEl.className = "llm-action-picker-title";
      titleEl.textContent = action.name;
      const descEl = ownerDoc.createElement("span");
      descEl.className = "llm-action-picker-description";
      descEl.textContent = firstSentence(action.description);
      button.append(titleEl, descEl);
      button.addEventListener("click", (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        consumeActiveActionToken();
        closeSlashMenu();
        insertCommandToken(action);
      });
      list.insertBefore(button, baseLabel);
    });
  };

  const selectActionPickerItem = async (index: number): Promise<void> => {
    const action = actionPickerItems[index];
    if (!action) return;
    consumeActiveActionToken();
    closeActionPicker();
    await executeAgentAction(action);
  };

  return {
    isActionPickerOpen,
    closeActionPicker,
    moveActionPickerSelection,
    selectActiveActionPickerItem: () =>
      selectActionPickerItem(actionPickerActiveIndex),
    renderDynamicSlashMenuSections,
    scheduleActionPickerTrigger,
    closeSlashMenu,
    openSlashMenuWithSelection,
    moveSlashMenuSelection,
    selectActiveSlashMenuItem,
    syncHasActionCardAttr,
    clearForcedSkill,
    clearCommandChip,
    clearCommandRowSelection: () => {
      if (forcedSkillId) {
        clearForcedSkill();
        return true;
      }
      if (activeCommandAction) {
        clearCommandChip();
        return true;
      }
      return false;
    },
    getActiveCommandAction: () => activeCommandAction,
    consumeForcedSkillIds: () => {
      if (!forcedSkillId) return undefined;
      const ids = [forcedSkillId];
      clearForcedSkill();
      return ids;
    },
    handleInlineCommand,
    consumeActiveActionToken,
  };
}
