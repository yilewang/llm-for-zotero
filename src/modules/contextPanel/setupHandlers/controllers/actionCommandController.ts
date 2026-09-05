import type { AgentSkill } from "../../../../agent/skills/skillLoader";
import { getAgentApi, initAgentSubsystem } from "../../../../agent";
import type { ActionRequestContext } from "../../../../agent/actions";
import { createElement } from "../../../../utils/domHelpers";
import type { ModelProviderAuthMode } from "../../../../utils/modelProviders";
import type { ProviderProtocol } from "../../../../utils/providerProtocol";
import {
  callUtilityLLM,
  describeUtilityLLMFailure,
} from "../../../../utils/utilityLLM";
import type { ModelProfileOverride } from "../../../../modelCapabilities";
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
  resolveNaturalLanguageActionIntent,
  resolvePagedCollectionScopeInput,
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
  paperScopeProfile?: PaperScopedActionProfile;
};
type ActionProfile = {
  model?: string;
  apiBase?: string;
  apiKey?: string;
  authMode?: ModelProviderAuthMode;
  providerProtocol?: ProviderProtocol;
  profileOverride?: ModelProfileOverride;
};
/**
 * Scope inference blocks the slash command the user just typed, and asks for
 * only ~220 tokens, so it stays on the short end of the utility budgets.
 */
const ACTION_SCOPE_TIMEOUT_MS = 10_000;

type ActionMenuTrigger = "/" | "$";
type ActiveActionToken = {
  query: string;
  slashStart: number;
  caretEnd: number;
  trigger: ActionMenuTrigger;
};

type LlmActionScopeChoice = {
  status: "match" | "ambiguous" | "no_match" | "not_action";
  actionName?: string;
  scope?: "collection" | "tag" | "all";
  collectionId?: number;
  tagName?: string;
  tagScope?: "allTagged" | "untagged";
  confidence?: number;
  reason?: string;
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
  getDoSend: () => (() => Promise<void>) | null;
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

  const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    Boolean(value && typeof value === "object" && !Array.isArray(value));

  const getActionSchemaProperties = (
    action: Pick<ActionPickerItem, "inputSchema">,
  ): Record<string, unknown> => {
    const schema = action.inputSchema;
    if (!isPlainObject(schema) || !isPlainObject(schema.properties)) return {};
    return schema.properties;
  };

  const getActionScopeEnum = (
    action: Pick<ActionPickerItem, "inputSchema">,
  ): string[] => {
    const scope = getActionSchemaProperties(action).scope;
    if (!isPlainObject(scope) || !Array.isArray(scope.enum)) return [];
    return scope.enum.filter(
      (entry): entry is string => typeof entry === "string",
    );
  };

  const actionSupportsCollectionScope = (action: ActionPickerItem): boolean =>
    Boolean(action.paperScopeProfile?.allowedScopes.includes("collection")) ||
    (Boolean(getActionSchemaProperties(action).collectionId) &&
      getActionScopeEnum(action).includes("collection"));

  const actionSupportsTagScope = (action: ActionPickerItem): boolean =>
    Boolean(action.paperScopeProfile?.allowedScopes.includes("tag"));

  const normalizeIntentText = (text: string): string =>
    text
      .toLowerCase()
      .replace(/[_-]+/g, " ")
      .replace(/[^\p{L}\p{N}/\s]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();

  const stripActionLaunchPrefix = (text: string): string =>
    text
      .trim()
      .replace(
        /^(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:(?:run|start|launch|use|do|perform|execute)\s+)?/i,
        "",
      )
      .trim();

  const getActionAliases = (actionName: string): string[] => {
    const aliases = new Set<string>([
      actionName,
      actionName.replace(/[_-]+/g, " "),
    ]);
    if (actionName === "auto_tag") {
      aliases.add("auto tag");
      aliases.add("autotag");
    }
    if (actionName === "audit_library") {
      aliases.add("audit library");
      aliases.add("audit");
    }
    return Array.from(aliases)
      .map((alias) => normalizeIntentText(alias))
      .filter(Boolean);
  };

  const textMentionsAction = (
    text: string,
    actions: ActionPickerItem[],
  ): boolean => {
    const normalizedTexts = [
      normalizeIntentText(text),
      normalizeIntentText(stripActionLaunchPrefix(text)),
    ].filter(Boolean);
    if (!normalizedTexts.length) return false;
    return actions.some((action) =>
      getActionAliases(action.name).some((alias) =>
        normalizedTexts.some(
          (normalized) =>
            normalized === alias ||
            normalized.startsWith(`${alias} `) ||
            normalized.includes(`/${normalizeIntentText(action.name)}`),
        ),
      ),
    );
  };

  const scoreCollectionCandidate = (
    text: string,
    collection: PaperScopedActionCollectionCandidate,
  ): number => {
    const tokens = new Set(
      normalizeIntentText(text)
        .split(/\s+/)
        .filter((token) => token.length > 2),
    );
    const candidateTokens = normalizeIntentText(
      `${collection.name} ${collection.path || ""}`,
    )
      .split(/\s+/)
      .filter((token) => token.length > 2);
    return candidateTokens.reduce(
      (score, token) => score + (tokens.has(token) ? 1 : 0),
      0,
    );
  };

  const selectCollectionCandidatesForLlm = (
    text: string,
    collections: PaperScopedActionCollectionCandidate[],
    requestContext: ActionRequestContext,
  ): PaperScopedActionCollectionCandidate[] => {
    const selectedIds = new Set(
      (requestContext.selectedCollectionContexts || [])
        .map((entry) => Number(entry.collectionId))
        .filter((id) => Number.isFinite(id) && id > 0)
        .map((id) => Math.floor(id)),
    );
    const selected = collections.filter((entry) =>
      selectedIds.has(Math.floor(entry.collectionId)),
    );
    const scored = collections
      .filter((entry) => !selectedIds.has(Math.floor(entry.collectionId)))
      .map((entry) => ({ entry, score: scoreCollectionCandidate(text, entry) }))
      .sort((left, right) => right.score - left.score);
    const lexicalMatches = scored
      .filter((entry) => entry.score > 0)
      .map((entry) => entry.entry);
    const fallback = scored.map((entry) => entry.entry);
    const out = [...selected, ...lexicalMatches, ...fallback];
    const seen = new Set<number>();
    return out
      .filter((entry) => {
        const id = Math.floor(entry.collectionId);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .slice(0, 200);
  };

  const textHasScopeSignalForLlm = (params: {
    text: string;
    collectionCandidates: PaperScopedActionCollectionCandidate[];
    tagCandidates: PaperScopedActionTagCandidate[];
  }): boolean => {
    const normalized = normalizeIntentText(params.text);
    if (!normalized) return false;
    if (
      /\b(?:about|all|collection|current|entire|folder|library|scope|selected|selection|tag|whole)\b/u.test(
        normalized,
      )
    ) {
      return true;
    }
    const ignoredTokens = new Set([
      "action",
      "audit",
      "auto",
      "please",
      "run",
      "tag",
    ]);
    const signalTokens = new Set(
      normalized
        .split(/\s+/)
        .filter((token) => token.length > 2 && !ignoredTokens.has(token)),
    );
    if (!signalTokens.size) return false;
    const hasSignalToken = (value: string | undefined): boolean =>
      normalizeIntentText(value || "")
        .split(/\s+/)
        .some((token) => token.length > 2 && signalTokens.has(token));
    if (
      params.collectionCandidates.some(
        (entry) => hasSignalToken(entry.name) || hasSignalToken(entry.path),
      )
    ) {
      return true;
    }
    return params.tagCandidates.some((entry) => hasSignalToken(entry.name));
  };

  const extractJsonObject = (text: string): Record<string, unknown> | null => {
    const trimmed = text.trim();
    const candidates = [
      trimmed,
      trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1),
    ].filter((entry) => entry.startsWith("{") && entry.endsWith("}"));
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        if (isPlainObject(parsed)) return parsed;
      } catch {
        // Try the next candidate.
      }
    }
    return null;
  };

  const parseLlmActionScopeChoice = (
    raw: string,
  ): LlmActionScopeChoice | null => {
    const parsed = extractJsonObject(raw);
    if (!parsed) return null;
    const status = parsed.status;
    if (
      status !== "match" &&
      status !== "ambiguous" &&
      status !== "no_match" &&
      status !== "not_action"
    ) {
      return null;
    }
    const scope =
      parsed.scope === "collection" ||
      parsed.scope === "tag" ||
      parsed.scope === "all"
        ? parsed.scope
        : undefined;
    const tagScope =
      parsed.tagScope === "allTagged" || parsed.tagScope === "untagged"
        ? parsed.tagScope
        : undefined;
    const collectionId = Number(parsed.collectionId);
    const confidence = Number(parsed.confidence);
    return {
      status,
      actionName:
        typeof parsed.actionName === "string"
          ? parsed.actionName.trim()
          : undefined,
      scope,
      collectionId:
        Number.isFinite(collectionId) && collectionId > 0
          ? Math.floor(collectionId)
          : undefined,
      tagName:
        typeof parsed.tagName === "string" && parsed.tagName.trim()
          ? parsed.tagName.trim()
          : undefined,
      tagScope,
      confidence: Number.isFinite(confidence) ? confidence : undefined,
      reason:
        typeof parsed.reason === "string" ? parsed.reason.trim() : undefined,
    };
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

  /**
   * Narrows a paged action to the user's selected chips.
   *
   * Scope used to be resolved by the pre-turn natural-language interceptor,
   * which also handled explicit slash commands on its way past. Removing that
   * interceptor took this with it, so "/auto_tag this folder" with the
   * Dynamical_System chip selected silently fell back to `scope: "all"` and
   * paged the entire library — with no card mentioning the change.
   *
   * Only applied when the command did not name a scope itself: an explicit
   * `collection <name>` must still win over whatever happens to be selected.
   */
  const applySelectedChipScope = (
    actionName: string,
    input: Record<string, unknown>,
  ): Record<string, unknown> => {
    if (input.scope && input.scope !== "all") return input;
    // organize_unfiled operates on unfiled items by definition; narrowing it
    // to a collection is meaningless and the resolver rejects it outright.
    if (actionName === "organize_unfiled") return input;
    const requestContext = buildActionRequestContext();
    const collectionIds = (requestContext.selectedCollectionContexts || [])
      .map((entry) => Number(entry.collectionId))
      .filter((id) => Number.isFinite(id) && id > 0);
    if (collectionIds.length) {
      return { ...input, scope: "collection", collectionIds };
    }
    const tags = (requestContext.selectedTagContexts || [])
      .map((entry) => String(entry.name || "").trim())
      .filter(Boolean);
    if (tags.length) {
      return { ...input, scope: "tag", tags };
    }
    return input;
  };

  const resolvePagedLibraryActionInput = (
    actionName: string,
    params: string,
    actionMode: "paper" | "library",
    baseInput?: Record<string, unknown>,
  ): Record<string, unknown> | null => {
    const input = {
      ...parseCommandParams(actionName, params, actionMode),
      ...(baseInput || {}),
    };
    try {
      const resolution = resolvePagedCollectionScopeInput({
        actionName,
        rawParams: params,
        baseInput: input,
        collectionCandidates: getPaperScopedCollectionCandidates(),
      });
      if (resolution.kind === "error") {
        setStatus(
          resolution.error,
          actionName === "organize_unfiled" ? "warning" : "error",
        );
        return null;
      }
      return applySelectedChipScope(actionName, resolution.input);
    } catch (error) {
      deps.logError(`LLM: failed to resolve /${actionName} input`, error);
      setStatus("Agent system unavailable", "error");
      return null;
    }
  };

  const buildLlmScopeResolverPrompt = (params: {
    text: string;
    actions: ActionPickerItem[];
    collections: PaperScopedActionCollectionCandidate[];
    tags: PaperScopedActionTagCandidate[];
    requestContext: ActionRequestContext;
  }): string => {
    const selectedCollections =
      params.requestContext.selectedCollectionContexts || [];
    const selectedTags = params.requestContext.selectedTagContexts || [];
    return [
      "Resolve whether the user wants to launch one Zotero library action and identify the requested scope.",
      "Return ONLY a JSON object. No prose. No markdown.",
      "Schema:",
      '{"status":"match|ambiguous|no_match|not_action","actionName":"<action or empty>","scope":"collection|tag|all","collectionId":123,"tagName":"...","tagScope":"allTagged|untagged","confidence":0.0,"reason":"short"}',
      "Rules:",
      "- Only choose actionName from AVAILABLE_ACTIONS.",
      "- Only choose collectionId from AVAILABLE_COLLECTIONS.",
      "- Only choose tagName/tagScope from AVAILABLE_TAGS.",
      "- Use selected scopes for words like this/current/selected.",
      "- Resolve descriptive collection phrases semantically, e.g. 'the folder about dynamical systems'.",
      "- Return status ambiguous if multiple listed collections/tags plausibly match.",
      "- Return status no_match if the action is clear but no listed scope matches.",
      "- Return status not_action if the user is asking a question about an action instead of asking to run it.",
      "- Do not choose whole library unless the user explicitly says whole/all/entire library.",
      "",
      `USER_TEXT: ${params.text}`,
      "",
      "AVAILABLE_ACTIONS:",
      ...params.actions.map((action) =>
        JSON.stringify({
          name: action.name,
          collectionScope: actionSupportsCollectionScope(action),
          tagScope: actionSupportsTagScope(action),
        }),
      ),
      "",
      "SELECTED_COLLECTIONS:",
      ...(selectedCollections.length
        ? selectedCollections.map((entry) =>
            JSON.stringify({
              collectionId: entry.collectionId,
              name: entry.name,
            }),
          )
        : ["[]"]),
      "",
      "SELECTED_TAGS:",
      ...(selectedTags.length
        ? selectedTags.map((entry) =>
            JSON.stringify({
              name: entry.name,
              normalizedName: entry.normalizedName,
              scope: entry.scope,
              includeAutomatic: entry.includeAutomatic,
            }),
          )
        : ["[]"]),
      "",
      "AVAILABLE_COLLECTIONS:",
      ...params.collections.map((entry) =>
        JSON.stringify({
          collectionId: entry.collectionId,
          name: entry.name,
          path: entry.path || entry.name,
        }),
      ),
      "",
      "AVAILABLE_TAGS:",
      ...(params.tags.length
        ? params.tags.slice(0, 200).map((entry) =>
            JSON.stringify({
              name: entry.name,
              type: entry.type,
            }),
          )
        : ["[]"]),
    ].join("\n");
  };

  const resolveLlmNaturalLanguageActionIntent = async (params: {
    text: string;
    actions: ActionPickerItem[];
    requestContext: ActionRequestContext & { mode: "paper" | "library" };
    collectionCandidates: PaperScopedActionCollectionCandidate[];
    tagCandidates: PaperScopedActionTagCandidate[];
  }) => {
    const selectedProfile = deps.getSelectedProfile();
    if (!selectedProfile?.model) {
      return {
        kind: "error" as const,
        error:
          "Could not infer the collection from this description because no model is configured. Select a folder chip or use collection <name>.",
      };
    }
    if (
      selectedProfile.authMode === "webchat" ||
      selectedProfile.providerProtocol === "web_sync"
    ) {
      return {
        kind: "error" as const,
        error:
          "Could not infer the collection from this description in WebChat mode. Select a folder chip or use collection <name>.",
      };
    }

    const eligibleActions = params.actions.filter(
      (action) =>
        actionSupportsCollectionScope(action) || actionSupportsTagScope(action),
    );
    if (
      !eligibleActions.length ||
      !textMentionsAction(params.text, eligibleActions) ||
      !textHasScopeSignalForLlm({
        text: params.text,
        collectionCandidates: params.collectionCandidates,
        tagCandidates: params.tagCandidates,
      })
    ) {
      return { kind: "none" as const };
    }

    const collections = selectCollectionCandidatesForLlm(
      params.text,
      params.collectionCandidates,
      params.requestContext,
    );
    const prompt = buildLlmScopeResolverPrompt({
      text: params.text,
      actions: eligibleActions,
      collections,
      tags: params.tagCandidates,
      requestContext: params.requestContext,
    });
    const result = await callUtilityLLM({
      prompt,
      model: selectedProfile.model,
      apiBase: selectedProfile.apiBase || "",
      apiKey: selectedProfile.apiKey,
      authMode: selectedProfile.authMode,
      providerProtocol: selectedProfile.providerProtocol,
      profileOverride: selectedProfile.profileOverride,
      temperature: 0,
      jsonBudget: 220,
      timeoutMs: ACTION_SCOPE_TIMEOUT_MS,
    });
    if (!result.ok) {
      deps.logError(
        "LLM: failed to infer action scope",
        describeUtilityLLMFailure(result),
      );
      return {
        kind: "error" as const,
        error:
          "Could not infer the collection from this description. Select a folder chip or use collection <name>.",
      };
    }
    const raw = result.text;

    const choice = parseLlmActionScopeChoice(raw);
    if (!choice) {
      return {
        kind: "error" as const,
        error:
          "Could not parse the inferred action scope. Select a folder chip or use collection <name>.",
      };
    }
    if (choice.status === "not_action") return { kind: "none" as const };
    const action = eligibleActions.find(
      (candidate) => candidate.name === choice.actionName,
    );
    if (!action) return { kind: "none" as const };
    if (choice.status === "ambiguous") {
      return {
        kind: "error" as const,
        error:
          choice.reason ||
          `The ${action.name} scope is ambiguous. Select a folder chip or name one collection exactly.`,
      };
    }
    if (choice.status === "no_match") {
      return {
        kind: "error" as const,
        error:
          choice.reason ||
          `Could not match that description to a ${action.name} scope.`,
      };
    }
    if ((choice.confidence ?? 1) < 0.55) {
      return {
        kind: "error" as const,
        error:
          "The inferred action scope was too uncertain. Select a folder chip or name one collection exactly.",
      };
    }

    let syntheticText = "";
    if (choice.scope === "collection" && choice.collectionId) {
      const collection = params.collectionCandidates.find(
        (entry) => Math.floor(entry.collectionId) === choice.collectionId,
      );
      if (!collection) {
        return {
          kind: "error" as const,
          error: `The inferred collection ${choice.collectionId} is not available.`,
        };
      }
      syntheticText = `/${action.name} collection ${collection.path || collection.name}`;
    } else if (choice.scope === "tag" && (choice.tagName || choice.tagScope)) {
      syntheticText = `/${action.name} tag ${
        choice.tagName ||
        (choice.tagScope === "allTagged" ? "all tagged" : "untagged")
      }`;
    } else if (choice.scope === "all") {
      syntheticText = `/${action.name} whole library`;
    } else {
      return {
        kind: "error" as const,
        error:
          "The inferred action did not include a usable scope. Select a folder chip or use collection <name>.",
      };
    }

    return resolveNaturalLanguageActionIntent({
      text: syntheticText,
      mode: params.requestContext.mode,
      actions: eligibleActions,
      requestContext: params.requestContext,
      collectionCandidates: params.collectionCandidates,
      tagCandidates: params.tagCandidates,
    });
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
    if (
      trimmedUserQuery &&
      isPagedLibraryActionForMode(action.name, actionMode)
    ) {
      const resolvedInput = resolvePagedLibraryActionInput(
        action.name,
        trimmedUserQuery,
        actionMode,
        input,
      );
      if (!resolvedInput) return;
      input = resolvedInput;
    }
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
            profileOverride: selectedProfile.profileOverride,
          }
        : undefined,
      conversationKey: deps.getConversationKey?.() ?? null,
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

  const clearSubmittedActionDraft = (): void => {
    inputBox.value = "";
    dispatchComposerInput();
    deps.persistDraftInputForCurrentConversation();
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
      const input = resolvePagedLibraryActionInput(
        actionName,
        params,
        actionMode,
      );
      if (!input) return;
      void executeAgentAction(action, input);
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
