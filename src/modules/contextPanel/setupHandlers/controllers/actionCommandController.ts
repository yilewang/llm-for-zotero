import type { AgentSkill } from "../../../../agent/skills/skillLoader";
import { getAgentApi, initAgentSubsystem } from "../../../../agent";
import type { ActionRequestContext } from "../../../../agent/actions";
import { createElement } from "../../../../utils/domHelpers";
import type { ModelProviderAuthMode } from "../../../../utils/modelProviders";
import type { ProviderProtocol } from "../../../../utils/providerProtocol";
import { getAgentModeEnabled } from "../../prefHelpers";
import { formatActionLabel } from "../../actionStatusText";
import { renderPendingActionCard } from "../../agentTrace/render";
import { buildPaperKey } from "../../pdfContext";
import {
  resolvePaperScopedCommandInput,
  type PaperScopedActionCollectionCandidate,
  type PaperScopedActionProfile,
  type PaperScopedActionTagCandidate,
} from "../../paperScopeCommand";
import { resolveDisplayConversationKind } from "../../portalScope";
import {
  selectedCollectionContextCache,
  selectedTagContextCache,
} from "../../state";
import type {
  CollectionContextRef,
  PaperContextRef,
  TagContextRef,
} from "../../types";
import {
  isFloatingMenuOpen,
  setFloatingMenuOpen,
  SLASH_MENU_OPEN_CLASS,
} from "./menuController";
import {
  isPagedLibraryActionForMode,
  parseCommandParams,
} from "./actionCommandParams";
export {
  isPagedLibraryActionForMode,
  shouldExecuteAgentActionImmediatelyFromSlash,
} from "./actionCommandParams";
import {
  activateCommandRowState,
  clearCommandRowState,
} from "./commandRowState";
import {
  createActionCommandLifecycle,
  type ActionCommandLifecycle,
} from "./actionCommandLifecycle";
export {
  attachActionCompletionEscapeDismissal,
  getPagedReviewTransitionText,
  isPagedReviewNavigationResolution,
  renderActionCompletionCard,
  renderActionTransitionCard,
} from "./actionCommandLifecycle";
import { runAgentActionWithLifecycle } from "./actionExecutionRunner";
import {
  renderAgentActionsInSlashMenu as renderAgentActionsSlashSection,
  renderSkillsInSlashMenu as renderSkillsSlashSection,
  type ActionCommandSlashMenuContext,
} from "./actionCommandSlashMenu";

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
type ActionMenuTrigger = "/" | "$";
type ActiveActionToken = {
  query: string;
  slashStart: number;
  caretEnd: number;
  trigger: ActionMenuTrigger;
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
  getActiveActionToken: () => ActiveActionToken | null;
  persistDraftInputForCurrentConversation: () => void;
  shouldRenderDynamicSlashMenu: () => boolean;
  shouldRenderSkillSlashMenu: () => boolean;
  isWebChatMode: () => boolean;
  isClaudeConversationSystem: () => boolean;
  getCurrentRuntimeMode: () => string;
  setCurrentRuntimeMode: (mode: "chat" | "agent") => void;
  getCurrentLibraryID: () => number;
  getConversationKey?: () => number | null;
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
  renderDynamicSlashMenuSections: (
    query?: string,
    trigger?: ActionMenuTrigger,
  ) => void;
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

  const setBaseSlashItemsVisible = (visible: boolean): void => {
    if (!slashMenu) return;
    Array.from(slashMenu.querySelectorAll("[data-slash-base-item]")).forEach(
      (element) => {
        (element as HTMLElement).style.display = visible ? "" : "none";
      },
    );
  };

  const getVisibleSlashItems = (): HTMLButtonElement[] => {
    if (!slashMenu) return [];
    const win = body.ownerDocument?.defaultView;
    return Array.from(
      slashMenu.querySelectorAll(".llm-action-picker-item"),
    ).filter((element) => {
      if ((element as HTMLButtonElement).disabled) return false;
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
    setBaseSlashItemsVisible(true);
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

  const renderDynamicSlashMenuSections = (
    query = "",
    trigger: ActionMenuTrigger = "/",
  ) => {
    if (trigger === "$") {
      clearAgentSlashItems();
      setBaseSlashItemsVisible(false);
      if (deps.shouldRenderSkillSlashMenu()) {
        renderSkillsInSlashMenu(query);
      } else {
        clearSkillSlashItems();
      }
      return;
    }
    setBaseSlashItemsVisible(true);
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
    if (token.trigger === "$" && !deps.shouldRenderSkillSlashMenu()) {
      closeSlashMenu();
      return;
    }
    renderDynamicSlashMenuSections(
      token.query.toLowerCase().trim(),
      token.trigger,
    );
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

  const actionLifecycle: ActionCommandLifecycle = createActionCommandLifecycle({
    body,
    actionHitlPanel,
    chatBox,
    syncHasActionCardAttr,
  });
  const { closeActionHitlPanel } = actionLifecycle;

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
        selectedTagContexts: [],
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
      selectedTagContexts: [
        ...(selectedTagContextCache.get(item.id) || []),
      ] as TagContextRef[],
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

  const getPaperScopedTagCandidates = async (): Promise<
    PaperScopedActionTagCandidate[]
  > => {
    const libraryID = deps.getCurrentLibraryID();
    if (!libraryID) return [];
    const tags = await getAgentApi().getZoteroGateway().listLibraryTags({
      libraryID,
    });
    return tags.map((entry) => ({
      name: entry.name,
      type: entry.type,
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
        await getPaperScopedTagCandidates(),
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
    userQuery?: string,
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
    const requestContext = buildActionRequestContext();
    const actionMode = requestContext.mode;
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
      if (isPagedLibraryActionForMode(action.name, actionMode)) {
        input = {
          ...input,
          ...parseCommandParams(action.name, "", actionMode),
        };
      } else if (paperScopeProfile) {
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
    const trimmedUserQuery = userQuery?.trim();
    if (trimmedUserQuery && input.userQuery === undefined) {
      input.userQuery = trimmedUserQuery;
    }
    const selectedProfile = deps.getSelectedProfile();
    await runAgentActionWithLifecycle({
      actionName: action.name,
      input,
      requestContext,
      libraryID: deps.getCurrentLibraryID(),
      llm: selectedProfile?.model
        ? {
            model: selectedProfile.model,
            apiBase: selectedProfile.apiBase || "",
            apiKey: selectedProfile.apiKey,
            authMode: selectedProfile.authMode,
            providerProtocol: selectedProfile.providerProtocol,
          }
        : undefined,
      isPagedLibraryAction: isPagedLibraryActionForMode(
        action.name,
        actionMode,
      ),
      lifecycle: actionLifecycle,
      setStatus,
      logError: deps.logError,
    });
  };

  const clearForcedSkill = (): void => {
    forcedSkillId = null;
    forcedSkillBadge = null;
    clearCommandRowState({ body, inputBox });
  };

  const clearCommandChip = (): void => {
    activeCommandAction = null;
    activeCommandBadge = null;
    clearCommandRowState({ body, inputBox });
  };

  const dispatchComposerInput = (): void => {
    const EventCtor =
      (inputBox.ownerDocument?.defaultView as any)?.Event ?? Event;
    inputBox.dispatchEvent(new EventCtor("input", { bubbles: true }));
  };

  const handleSkillSelection = (skill: AgentSkill): void => {
    clearForcedSkill();
    clearCommandChip();
    forcedSkillId = skill.id;
    const isCodexAppServerSkill =
      deps.getSelectedProfile()?.authMode === "codex_app_server";
    if (
      !isCodexAppServerSkill &&
      deps.getCurrentRuntimeMode() !== "agent" &&
      getAgentModeEnabled()
    ) {
      deps.setCurrentRuntimeMode("agent");
    }
    forcedSkillBadge = activateCommandRowState({
      body,
      inputBox,
      label: `/${skill.id}`,
      kind: "skill",
      dispatchInput: dispatchComposerInput,
    });
  };

  const insertCommandToken = (action: ActionPickerItem): void => {
    clearForcedSkill();
    clearCommandChip();
    activeCommandAction = action;
    activeCommandBadge = activateCommandRowState({
      body,
      inputBox,
      label: `/${action.name}`,
      kind: "command",
      clearInput: true,
      dispatchInput: dispatchComposerInput,
    });
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
      wrapper.className =
        "llm-action-inline-card llm-action-inline-card-review";
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
    if (actionName === "compact") {
      if (deps.getCurrentRuntimeMode() !== "agent" && getAgentModeEnabled()) {
        deps.setCurrentRuntimeMode("agent");
      }
      inputBox.value = "/compact";
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
    const actionMode = buildActionRequestContext().mode;
    const paperScopeProfile =
      getAgentApi().getPaperScopedActionProfile(actionName);
    if (isPagedLibraryActionForMode(actionName, actionMode)) {
      void executeAgentAction(
        action,
        parseCommandParams(actionName, params, actionMode),
      );
      return;
    }
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
      void executeAgentAction(action, {
        ...input,
        ...(params.trim() ? { userQuery: params.trim() } : {}),
      });
      return;
    }
    let input = parseCommandParams(actionName, params, actionMode);
    const needsScopeConfirm =
      actionName !== "organize_unfiled" && actionName !== "discover_related";
    if (needsScopeConfirm && !params.trim()) {
      const scopeInput = await showScopeConfirmation(actionName);
      if (!scopeInput) return;
      input = { ...input, ...scopeInput };
    }
    void executeAgentAction(action, input);
  };

  const slashMenuContext: ActionCommandSlashMenuContext = {
    body,
    inputBox,
    slashMenu,
    getItem: deps.getItem,
    getSelectedProfile: deps.getSelectedProfile,
    isClaudeConversationSystem: deps.isClaudeConversationSystem,
    clearAgentSlashItems,
    clearSkillSlashItems,
    consumeActiveActionToken,
    closeSlashMenu,
    handleSkillSelection,
    insertCommandToken,
    executeAgentAction,
    buildActionRequestContext,
  };

  const renderSkillsInSlashMenu = (query = ""): void =>
    renderSkillsSlashSection(slashMenuContext, query);

  const renderAgentActionsInSlashMenu = (query = ""): void =>
    renderAgentActionsSlashSection(slashMenuContext, query);

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
