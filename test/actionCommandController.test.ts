import { assert } from "chai";
import { setUserSkills, type AgentSkill } from "../src/agent/skills";
import { createActionCommandLifecycle } from "../src/modules/contextPanel/setupHandlers/controllers/actionCommandLifecycle";
import {
  attachActionCompletionEscapeDismissal,
  createActionCommandController,
  isPagedLibraryActionForMode,
  isPagedReviewNavigationResolution,
  renderActionTransitionCard,
  shouldExecuteAgentActionImmediatelyFromSlash,
} from "../src/modules/contextPanel/setupHandlers/controllers/actionCommandController";
import { parseInlineActionCommand } from "../src/modules/contextPanel/setupHandlers/controllers/actionCommandParams";
import type {
  AgentConfirmationResolution,
  AgentPendingAction,
} from "../src/agent/types";
import type { PaperScopedActionProfile } from "../src/agent/actions";

class FakeEvent {
  defaultPrevented = false;
  propagationStopped = false;

  constructor(
    public readonly type: string,
    public readonly key = "",
  ) {}

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.propagationStopped = true;
  }
}

class FakeClassList {
  private readonly tokens = new Set<string>();

  add(...tokens: string[]): void {
    for (const token of tokens) {
      if (token) this.tokens.add(token);
    }
  }

  remove(...tokens: string[]): void {
    for (const token of tokens) this.tokens.delete(token);
  }

  contains(token: string): boolean {
    return this.tokens.has(token);
  }

  setFromClassName(className: string): void {
    this.tokens.clear();
    for (const token of className.split(/\s+/)) {
      if (token) this.tokens.add(token);
    }
  }

  toString(): string {
    return Array.from(this.tokens).join(" ");
  }
}

class FakeElement {
  readonly classList = new FakeClassList();
  readonly dataset: Record<string, string | undefined> = {};
  readonly style: Record<string, string> = { display: "" };
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  private readonly listeners = new Map<
    string,
    Array<(event: FakeEvent) => void>
  >();
  private classNameValue = "";
  parentElement: FakeElement | null = null;
  textContent = "";
  title = "";
  type = "";
  disabled = false;
  value = "";
  placeholder = "";
  selectionStart = 0;
  selectionEnd = 0;
  scrollTop = 0;
  clientHeight = 0;
  offsetTop = 0;
  offsetHeight = 0;
  private innerHTMLValue = "";

  constructor(
    readonly ownerDocument: FakeDocument,
    readonly tagName: string,
  ) {}

  set className(value: string) {
    this.classNameValue = value;
    this.classList.setFromClassName(value);
  }

  get className(): string {
    return this.classNameValue || this.classList.toString();
  }

  set innerHTML(value: string) {
    this.innerHTMLValue = value;
    if (value === "") {
      for (const child of this.children) child.parentElement = null;
      this.children.length = 0;
      this.textContent = "";
    }
  }

  get innerHTML(): string {
    return this.innerHTMLValue;
  }

  append(...nodes: Array<FakeElement | string>): void {
    for (const node of nodes) {
      if (typeof node === "string") {
        this.textContent += node;
      } else {
        this.appendChild(node);
      }
    }
  }

  appendChild(child: FakeElement): FakeElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child: FakeElement, reference: FakeElement | null): FakeElement {
    child.parentElement = this;
    if (!reference) {
      this.children.push(child);
      return child;
    }
    const index = this.children.indexOf(reference);
    if (index < 0) {
      this.children.push(child);
    } else {
      this.children.splice(index, 0, child);
    }
    return child;
  }

  remove(): void {
    const parent = this.parentElement;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children.splice(index, 1);
    this.parentElement = null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name.startsWith("data-")) {
      const key = name
        .slice(5)
        .replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
      this.dataset[key] = value;
    }
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event: FakeEvent): boolean {
    for (const listener of this.listeners.get(event.type) || []) {
      listener(event);
    }
    return !event.defaultPrevented;
  }

  click(): void {
    this.dispatchEvent(new FakeEvent("click"));
  }

  focus(): void {
    // No focus tracking needed.
  }

  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const matches: FakeElement[] = [];
    for (const child of this.children) {
      if (matchesSelector(child, selector)) matches.push(child);
      matches.push(...child.querySelectorAll(selector));
    }
    return matches;
  }
}

class FakeDocument {
  private readonly listeners = new Map<
    string,
    Array<(event: FakeEvent) => void>
  >();

  readonly defaultView = {
    Event: FakeEvent,
    getComputedStyle: (element: FakeElement) => ({
      display: element.style.display || "",
    }),
  };

  createElement(tagName: string): FakeElement {
    return new FakeElement(this, tagName.toLowerCase());
  }

  addEventListener(
    type: string,
    listener: (event: FakeEvent) => void,
    _options?: unknown,
  ): void {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(
    type: string,
    listener: (event: FakeEvent) => void,
    _options?: unknown,
  ): void {
    const listeners = this.listeners.get(type) || [];
    this.listeners.set(
      type,
      listeners.filter((entry) => entry !== listener),
    );
  }

  dispatchEvent(event: FakeEvent): boolean {
    for (const listener of this.listeners.get(event.type) || []) {
      listener(event);
    }
    return !event.defaultPrevented;
  }
}

function matchesSelector(element: FakeElement, selector: string): boolean {
  if (selector.startsWith("#")) {
    return element.getAttribute("id") === selector.slice(1);
  }
  if (selector.startsWith(".")) {
    return element.classList.contains(selector.slice(1));
  }
  const attrMatch = /^\[([^=\]]+)(?:=['"]?([^'"\]]+)['"]?)?\]$/.exec(selector);
  if (attrMatch) {
    const [, attrName, expected] = attrMatch;
    const actual = element.getAttribute(attrName);
    if (actual === null) return false;
    return expected === undefined || actual === expected;
  }
  return false;
}

function makeSkill(id: string): AgentSkill {
  return {
    id,
    description: `${id} description`,
    version: 1,

    contexts: ["any"],
    activation: "both",
    instruction: `${id} instructions`,
    source: "personal",
  };
}

type ActiveActionTokenFixture = {
  query: string;
  slashStart: number;
  caretEnd: number;
  trigger: "/" | "$";
};

function findSkillButton(
  list: FakeElement,
  skillId: string,
): FakeElement | null {
  return (
    list
      .querySelectorAll(".llm-action-picker-item")
      .find((element) =>
        element.children.some((child) => child.textContent === skillId),
      ) || null
  );
}

function createControllerHarness(
  options: {
    inputValue?: string;
    activeToken?: ActiveActionTokenFixture | null;
    shouldRenderDynamicSlashMenu?: () => boolean;
    shouldRenderSkillSlashMenu?: () => boolean;
    isClaudeConversationSystem?: () => boolean;
    authMode?: "codex_app_server";
    onSend?: (text: string) => void;
  } = {},
) {
  const doc = new FakeDocument();
  const body = doc.createElement("div");
  const panelRoot = doc.createElement("div");
  const inputBox = doc.createElement("textarea");
  inputBox.value = options.inputValue || "";
  inputBox.placeholder = "Ask anything";
  inputBox.selectionStart = inputBox.value.length;
  inputBox.selectionEnd = inputBox.value.length;

  const slashMenu = doc.createElement("div");
  slashMenu.style.display = "none";
  const slashList = doc.createElement("div");
  slashList.className = "llm-action-picker-list";
  const baseItem = doc.createElement("button");
  baseItem.className = "llm-action-picker-item";
  baseItem.setAttribute("data-slash-base-item", "true");
  slashList.appendChild(baseItem);
  slashMenu.appendChild(slashList);

  const commandRow = doc.createElement("div");
  commandRow.setAttribute("id", "llm-command-row");
  const commandBadge = doc.createElement("span");
  commandBadge.setAttribute("id", "llm-command-row-badge");
  commandRow.appendChild(commandBadge);

  body.append(panelRoot, inputBox, slashMenu, commandRow);

  let runtimeSwitches = 0;
  const controller = createActionCommandController({
    body: body as unknown as Element,
    panelRoot: panelRoot as unknown as HTMLElement,
    inputBox: inputBox as unknown as HTMLTextAreaElement,
    slashMenu: slashMenu as unknown as HTMLDivElement,
    uploadBtn: null,
    actionPicker: null,
    actionPickerList: null,
    actionHitlPanel: null,
    chatBox: null,
    getItem: () => ({ id: 101 }) as unknown as Zotero.Item,
    getActiveActionToken: () => options.activeToken || null,
    persistDraftInputForCurrentConversation: () => undefined,
    shouldRenderDynamicSlashMenu:
      options.shouldRenderDynamicSlashMenu || (() => true),
    shouldRenderSkillSlashMenu:
      options.shouldRenderSkillSlashMenu || (() => true),
    isWebChatMode: () => false,
    isClaudeConversationSystem:
      options.isClaudeConversationSystem || (() => false),
    getCurrentRuntimeMode: () => "chat",
    activatePlanMode: () => undefined,
    isPlanAvailable: () => false,
    setCurrentRuntimeMode: () => {
      runtimeSwitches += 1;
    },
    getCurrentLibraryID: () => 1,
    resolveCurrentPaperBaseItem: () => null,
    getAllEffectivePaperContexts: () => [],
    getEffectivePdfModePaperContexts: () => [],
    getEffectiveFullTextPaperContexts: () => [],
    getSelectedProfile: () =>
      options.authMode ? { authMode: options.authMode } : null,
    getDoSend: () => async () => {
      options.onSend?.(inputBox.value);
    },
    closeRetryModelMenu: () => undefined,
    closeModelMenu: () => undefined,
    closeReasoningMenu: () => undefined,
    closeHistoryNewMenu: () => undefined,
    closeHistoryMenu: () => undefined,
    closeResponseMenu: () => undefined,
    closePromptMenu: () => undefined,
    closeExportMenu: () => undefined,
    setStatusMessage: () => undefined,
    logError: () => undefined,
  });

  return {
    baseItem,
    body,
    commandBadge,
    commandRow,
    controller,
    inputBox,
    panelRoot,
    slashList,
    slashMenu,
    getRuntimeSwitches: () => runtimeSwitches,
  };
}

describe("actionCommandController", function () {
  afterEach(function () {
    setUserSkills([]);
  });

  const autoTagIntentProfile: PaperScopedActionProfile = {
    targetMode: "multi",
    allowedScopes: ["current", "selection", "collection", "tag", "all"],
    defaultEmptyInput: "selection_or_prompt",
    paperRequirement: "bibliographic",
    supportsLimit: true,
  };

  const autoTagIntentAction = {
    name: "auto_tag",
    description: "Auto tag",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["all", "collection", "tag"] },
        collectionIds: { type: "array", items: { type: "number" } },
        tagNames: { type: "array", items: { type: "string" } },
        tagScopes: { type: "array", items: { type: "string" } },
      },
    },
    paperScopeProfile: autoTagIntentProfile,
  };

  const auditLibraryIntentAction = {
    name: "audit_library",
    description: "Audit library",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["all", "collection"] },
        collectionId: { type: "number" },
      },
    },
  };

  const organizeUnfiledIntentAction = {
    name: "organize_unfiled",
    description: "Organize unfiled",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number" },
      },
    },
  };

  const scopedIntentActions = [
    autoTagIntentAction,
    auditLibraryIntentAction,
    organizeUnfiledIntentAction,
  ];

  const scopedIntentCollections = [
    {
      collectionId: 13,
      name: "Dynamical_System",
      path: "Lab/Dynamical_System",
    },
    { collectionId: 55, name: "Neuroscience", path: "Lab/Neuroscience" },
  ];

  it("sends every free-text slash argument through the Agent turn", async function () {
    for (const params of [
      "this folder",
      "前十篇论文",
      "collection Bayesian",
      "do not change existing tags",
      "10",
    ]) {
      const sent: string[] = [];
      const { controller } = createControllerHarness({
        onSend: (text) => {
          sent.push(text);
        },
      });
      await controller.handleInlineCommand("auto_tag", params);
      assert.deepEqual(sent, [`/auto_tag ${params}`]);
    }
  });

  it("routes immediate action chips by chat mode", function () {
    assert.isFalse(isPagedLibraryActionForMode("auto_tag", "paper"));
    assert.isTrue(isPagedLibraryActionForMode("auto_tag", "library"));
    assert.isTrue(
      shouldExecuteAgentActionImmediatelyFromSlash("auto_tag", "paper", true),
    );
    assert.isTrue(
      shouldExecuteAgentActionImmediatelyFromSlash(
        "complete_metadata",
        "paper",
        true,
      ),
    );
    assert.isTrue(
      shouldExecuteAgentActionImmediatelyFromSlash(
        "discover_related",
        "paper",
        true,
      ),
    );
    assert.isTrue(
      shouldExecuteAgentActionImmediatelyFromSlash("auto_tag", "library", true),
    );
    assert.isFalse(
      shouldExecuteAgentActionImmediatelyFromSlash(
        "discover_related",
        "library",
        true,
      ),
    );
  });

  it("parses full-message slash actions before normal chat send", function () {
    assert.deepEqual(
      parseInlineActionCommand("/auto_tag collection Geometry"),
      {
        actionName: "auto_tag",
        params: "collection Geometry",
      },
    );
    assert.deepEqual(parseInlineActionCommand("  /audit_library 10  "), {
      actionName: "audit_library",
      params: "10",
    });
    assert.isNull(parseInlineActionCommand("please run /auto_tag"));
    assert.isNull(parseInlineActionCommand("/"));
  });

  it("recognizes paged review navigation as a transition instead of a close", function () {
    const action: AgentPendingAction = {
      toolName: "apply_tags",
      mode: "review",
      title: "Page 1 of 3: Add tags",
      actions: [
        { id: "confirm", label: "Confirm" },
        { id: "cancel", label: "Cancel", approved: false },
        { id: "next", label: "Next page", approved: false },
        { id: "refresh", label: "Refresh", approved: false },
      ],
      fields: [],
    };

    assert.isTrue(
      isPagedReviewNavigationResolution(action, {
        approved: false,
        actionId: "next",
      }),
    );
    assert.isTrue(
      isPagedReviewNavigationResolution(action, {
        approved: false,
        actionId: "refresh",
      }),
    );
    assert.isFalse(
      isPagedReviewNavigationResolution(action, {
        approved: false,
        actionId: "cancel",
      }),
    );
    assert.isFalse(
      isPagedReviewNavigationResolution(action, {
        approved: true,
        actionId: "confirm",
      }),
    );
  });

  it("renders a paged review transition status card", function () {
    const doc = new FakeDocument();
    const card = renderActionTransitionCard(
      doc as unknown as Document,
      "previous",
    ) as unknown as FakeElement;

    assert.equal(card.getAttribute("role"), "status");
    assert.equal(card.getAttribute("aria-live"), "polite");
    assert.exists(card.querySelector(".llm-agent-hitl-status-content"));
    assert.include(card.className, "llm-plan-container");
    assert.equal(
      card.querySelector(".llm-plan-status")?.textContent,
      "Working",
    );
    assert.equal(
      card.querySelector(".llm-plan-title")?.textContent,
      "Rendering previous page",
    );
    assert.include(
      card.querySelector(".llm-agent-hitl-description")?.textContent || "",
      "previous review page",
    );
  });

  it("uses the shared action-card visual hierarchy for progress", function () {
    const doc = new FakeDocument();
    const body = doc.createElement("div");
    const chatBox = doc.createElement("div");
    body.appendChild(chatBox);
    const lifecycle = createActionCommandLifecycle({
      body: body as unknown as Element,
      actionHitlPanel: null,
      chatBox: chatBox as unknown as HTMLDivElement,
      syncHasActionCardAttr: () => undefined,
    });

    const progress = lifecycle.createActionProgressIndicator("apply_tags");
    const card = chatBox.querySelector(".llm-action-progress-card");

    assert.equal(
      card?.querySelector(".llm-plan-status")?.textContent,
      "Working",
    );
    assert.exists(card?.querySelector(".llm-plan-title"));
    assert.include(card?.className || "", "llm-plan-container");
    progress.remove();
  });

  it("replaces an approved action HITL card with a working state", async function () {
    const doc = new FakeDocument();
    const body = doc.createElement("div");
    const chatBox = doc.createElement("div");
    body.appendChild(chatBox);
    let syncCalls = 0;
    let resolveConfirmation:
      | ((resolution: AgentConfirmationResolution) => void)
      | null = null;
    const lifecycle = createActionCommandLifecycle({
      body: body as unknown as Element,
      actionHitlPanel: null,
      chatBox: chatBox as unknown as HTMLDivElement,
      registerPendingConfirmation: (_requestId, resolve) => {
        resolveConfirmation = resolve;
      },
      syncHasActionCardAttr: () => {
        syncCalls += 1;
      },
    });

    const pendingAction: AgentPendingAction = {
      toolName: "apply_tags",
      mode: "review",
      title: "Add tags",
      description: "Apply reviewed tags.",
      confirmLabel: "Apply",
      cancelLabel: "Cancel",
      fields: [],
      actions: [
        { id: "confirm", label: "Apply", approved: true },
        { id: "cancel", label: "Cancel", approved: false },
      ],
    };
    const resolutionPromise = lifecycle.showActionHitlCard(
      "action-confirm-1",
      pendingAction,
    );

    assert.equal(
      chatBox.querySelector(".llm-plan-title")?.textContent,
      "Add tags",
    );
    assert.isFunction(resolveConfirmation);
    resolveConfirmation?.({ approved: true, actionId: "confirm" });
    const resolution = await resolutionPromise;

    assert.deepEqual(resolution, {
      approved: true,
      actionId: "confirm",
    });
    assert.equal(
      chatBox.querySelector(".llm-plan-title")?.textContent,
      "Working on approved action",
    );
    assert.include(
      chatBox.querySelector(".llm-agent-hitl-description")?.textContent || "",
      "approved action",
    );
    assert.isAtLeast(syncCalls, 2);
  });

  it("dismisses action completion status on Escape and unregisters the listener", function () {
    const doc = new FakeDocument();
    let dismissCalls = 0;
    const cleanup = attachActionCompletionEscapeDismissal(
      doc as unknown as Document,
      () => {
        dismissCalls += 1;
      },
    );

    const enterEvent = new FakeEvent("keydown", "Enter");
    doc.dispatchEvent(enterEvent);
    assert.equal(dismissCalls, 0);
    assert.isFalse(enterEvent.defaultPrevented);

    const escapeEvent = new FakeEvent("keydown", "Escape");
    doc.dispatchEvent(escapeEvent);
    assert.equal(dismissCalls, 1);
    assert.isTrue(escapeEvent.defaultPrevented);
    assert.isTrue(escapeEvent.propagationStopped);

    cleanup();
    doc.dispatchEvent(new FakeEvent("keydown", "Escape"));
    assert.equal(dismissCalls, 1);
  });

  it("shows a skill chip instead of inserting a $skill draft in Codex app-server mode", function () {
    setUserSkills([makeSkill("evidence-based-qa")]);
    const doc = new FakeDocument();
    const body = doc.createElement("div");
    const panelRoot = doc.createElement("div");
    const inputBox = doc.createElement("textarea");
    inputBox.value = "/evidence";
    inputBox.placeholder = "Ask anything";
    inputBox.selectionStart = inputBox.value.length;
    inputBox.selectionEnd = inputBox.value.length;

    const slashMenu = doc.createElement("div");
    slashMenu.style.display = "grid";
    const slashList = doc.createElement("div");
    slashList.className = "llm-action-picker-list";
    const baseItem = doc.createElement("button");
    baseItem.setAttribute("data-slash-base-item", "true");
    slashList.appendChild(baseItem);
    slashMenu.appendChild(slashList);

    const commandRow = doc.createElement("div");
    commandRow.setAttribute("id", "llm-command-row");
    const commandBadge = doc.createElement("span");
    commandBadge.setAttribute("id", "llm-command-row-badge");
    commandRow.appendChild(commandBadge);

    body.append(panelRoot, inputBox, slashMenu, commandRow);

    let runtimeSwitches = 0;
    const controller = createActionCommandController({
      body: body as unknown as Element,
      panelRoot: panelRoot as unknown as HTMLElement,
      inputBox: inputBox as unknown as HTMLTextAreaElement,
      slashMenu: slashMenu as unknown as HTMLDivElement,
      uploadBtn: null,
      actionPicker: null,
      actionPickerList: null,
      actionHitlPanel: null,
      chatBox: null,
      getItem: () => ({ id: 101 }) as unknown as Zotero.Item,
      getActiveActionToken: () => ({
        query: "evidence",
        slashStart: 0,
        caretEnd: inputBox.value.length,
        trigger: "/",
      }),
      persistDraftInputForCurrentConversation: () => undefined,
      shouldRenderDynamicSlashMenu: () => true,
      shouldRenderSkillSlashMenu: () => true,
      isWebChatMode: () => false,
      isClaudeConversationSystem: () => false,
      getCurrentRuntimeMode: () => "chat",
      activatePlanMode: () => undefined,
      isPlanAvailable: () => false,
      setCurrentRuntimeMode: () => {
        runtimeSwitches += 1;
      },
      getCurrentLibraryID: () => 1,
      resolveCurrentPaperBaseItem: () => null,
      getAllEffectivePaperContexts: () => [],
      getEffectivePdfModePaperContexts: () => [],
      getEffectiveFullTextPaperContexts: () => [],
      getSelectedProfile: () => ({
        authMode: "codex_app_server",
      }),
      getDoSend: () => null,
      closeRetryModelMenu: () => undefined,
      closeModelMenu: () => undefined,
      closeReasoningMenu: () => undefined,
      closeHistoryNewMenu: () => undefined,
      closeHistoryMenu: () => undefined,
      closeResponseMenu: () => undefined,
      closePromptMenu: () => undefined,
      closeExportMenu: () => undefined,
      setStatusMessage: () => undefined,
      logError: () => undefined,
    });

    controller.renderDynamicSlashMenuSections("evidence");
    const skillButton = findSkillButton(slashList, "evidence-based-qa");
    assert.isOk(skillButton, "expected slash menu to render the skill button");

    skillButton!.click();

    assert.equal(commandBadge.textContent, "/evidence-based-qa");
    assert.equal(commandRow.getAttribute("data-active"), "");
    assert.isTrue(commandRow.classList.contains("llm-command-row--skill"));
    assert.notInclude(inputBox.value, "$evidence-based-qa");
    assert.equal(runtimeSwitches, 0);
    assert.deepEqual(controller.consumeForcedSkillIds(), ["evidence-based-qa"]);
  });

  it("renders only skills for dollar-triggered skill search", function () {
    setUserSkills([makeSkill("evidence-based-qa")]);
    const { baseItem, controller, slashList } = createControllerHarness({
      inputValue: "$evidence",
      activeToken: {
        query: "evidence",
        slashStart: 0,
        caretEnd: "$evidence".length,
        trigger: "$",
      },
    });
    const agentItem = slashList.ownerDocument.createElement("button");
    agentItem.className = "llm-action-picker-item";
    agentItem.setAttribute("data-slash-agent-item", "true");
    slashList.appendChild(agentItem);

    controller.renderDynamicSlashMenuSections("evidence", "$");

    assert.equal(baseItem.style.display, "none");
    assert.isNull(slashList.querySelector("[data-slash-agent-item]"));
    assert.isOk(findSkillButton(slashList, "evidence-based-qa"));
  });

  it("selects a dollar skill into the composer chip and preserves remaining draft text", function () {
    setUserSkills([makeSkill("evidence-based-qa")]);
    const inputValue = "Please use $evidence";
    const { commandBadge, commandRow, controller, inputBox, slashList } =
      createControllerHarness({
        inputValue,
        authMode: "codex_app_server",
        activeToken: {
          query: "evidence",
          slashStart: inputValue.indexOf("$evidence"),
          caretEnd: inputValue.length,
          trigger: "$",
        },
      });

    controller.renderDynamicSlashMenuSections("evidence", "$");
    const skillButton = findSkillButton(slashList, "evidence-based-qa");
    assert.isOk(skillButton, "expected dollar menu to render the skill button");

    skillButton!.click();

    assert.equal(commandBadge.textContent, "/evidence-based-qa");
    assert.equal(commandRow.getAttribute("data-active"), "");
    assert.isTrue(commandRow.classList.contains("llm-command-row--skill"));
    assert.equal(inputBox.value, "Please use ");
    assert.deepEqual(controller.consumeForcedSkillIds(), ["evidence-based-qa"]);
  });

  it("does not open the dollar skill menu when skills are disabled for Claude Code mode", function () {
    setUserSkills([makeSkill("evidence-based-qa")]);
    const { controller, slashList, slashMenu } = createControllerHarness({
      inputValue: "$evidence",
      activeToken: {
        query: "evidence",
        slashStart: 0,
        caretEnd: "$evidence".length,
        trigger: "$",
      },
      shouldRenderSkillSlashMenu: () => false,
      isClaudeConversationSystem: () => true,
    });

    controller.scheduleActionPickerTrigger();

    assert.equal(slashMenu.style.display, "none");
    assert.isNull(slashList.querySelector("[data-slash-skill-item]"));
  });
});
