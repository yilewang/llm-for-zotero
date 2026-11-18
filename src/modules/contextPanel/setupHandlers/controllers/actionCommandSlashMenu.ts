import { getAgentApi, initAgentSubsystem } from "../../../../agent";
import { getAllSkills } from "../../../../agent/skills";
import type { AgentSkill } from "../../../../agent/skills/skillLoader";
import { refreshClaudeSlashCommands } from "../../../../claudeCode/runtime";
import { listAntigravitySlashCommands } from "../../../../antigravity/commands";
import { loadAntigravityPickerSlashCommands } from "../../../../antigravity/runtime";
import {
  usesExternalTurnHost,
  type RuntimeConversationSystem,
} from "../../../../core/conversations/conversationSystems";
import { t } from "../../../../utils/i18n";
import { resolveDisplayConversationKind } from "../../portalScope";
import { resolveSlashActionChatMode } from "../../slashMenuBehavior";
import {
  isPagedLibraryActionForMode,
  buildCommandDefaultInput,
  shouldExecuteAgentActionImmediatelyFromSlash,
  type ActionChatMode,
} from "./actionCommandParams";

export type SlashMenuActionItem = {
  name: string;
  description: string;
  inputSchema: object;
};

export type ActionCommandSlashMenuContext = {
  body: Element;
  inputBox: HTMLTextAreaElement;
  slashMenu: HTMLDivElement | null;
  getItem: () => Zotero.Item | null;
  getSelectedProfile: () => { authMode?: string } | null;
  /** The panel's runtime, or null for the plugin's own systems. */
  getRuntimeConversationSystem: () => RuntimeConversationSystem | null;
  clearAgentSlashItems: () => void;
  clearSkillSlashItems: () => void;
  consumeActiveActionToken: () => boolean;
  closeSlashMenu: () => void;
  handleSkillSelection: (skill: AgentSkill) => void;
  insertCommandToken: (action: SlashMenuActionItem) => void;
  executeAgentAction: (
    action: SlashMenuActionItem,
    parsedInput?: Record<string, unknown>,
    userQuery?: string,
  ) => void | Promise<void>;
  buildActionRequestContext: () => { mode: ActionChatMode };
};

type RuntimeSlashMenuItem = {
  name: string;
  description: string;
  argumentHint?: string;
};

/** Where a runtime's own slash commands come from. */
type RuntimeCommandSource = {
  label: string;
  loadingText: string;
  list: () => RuntimeSlashMenuItem[];
  refresh: () => Promise<unknown>;
};

/**
 * The panel runtime's own commands, for a runtime that runs through the
 * external turn host and so takes slash messages as its own commands.
 */
function runtimeCommandSource(
  context: ActionCommandSlashMenuContext,
): RuntimeCommandSource | null {
  const system = context.getRuntimeConversationSystem();
  if (!usesExternalTurnHost(system)) return null;
  switch (system) {
    case "claude_code":
      return {
        label: "Claude Code",
        loadingText: t("Loading Claude commands..."),
        // This panel is on Claude Code, whatever the other surface chose.
        list: () =>
          getAgentApi().listSlashCommands?.({
            conversationSystem: "claude_code",
          }) || [],
        refresh: () =>
          initAgentSubsystem().then((coreRuntime) =>
            refreshClaudeSlashCommands(coreRuntime, false),
          ),
      };
    case "antigravity":
      return {
        label: "Antigravity",
        loadingText: t("Loading Antigravity commands..."),
        list: () => listAntigravitySlashCommands(),
        refresh: () => loadAntigravityPickerSlashCommands(),
      };
    default:
      return null;
  }
}

function firstSentence(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const match = /^(.+?(?:[。！？]|[.!?](?=\s|$)))/.exec(normalized);
  if (match) return match[1];
  return normalized.length <= 80
    ? normalized
    : `${normalized.slice(0, 77).trimEnd()}...`;
}

export function renderSkillsInSlashMenu(
  context: ActionCommandSlashMenuContext,
  query = "",
): void {
  const list = context.slashMenu?.querySelector(".llm-action-picker-list");
  if (!list) return;
  const ownerDoc = context.body.ownerDocument;
  if (!ownerDoc) return;
  context.clearSkillSlashItems();
  const allSkills = getAllSkills();
  if (!allSkills.length) return;
  const filtered = query
    ? allSkills.filter(
        (skill: AgentSkill) =>
          skill.id.toLowerCase().includes(query) ||
          skill.description.toLowerCase().includes(query) ||
          t(skill.description).toLowerCase().includes(query),
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
    button.disabled = false;
    button.setAttribute("aria-disabled", "false");
    button.title = t(skill.description) || skill.id;
    const titleEl = ownerDoc.createElement("span");
    titleEl.className = "llm-action-picker-title";
    titleEl.textContent = skill.id;
    const descEl = ownerDoc.createElement("span");
    descEl.className = "llm-action-picker-description";
    descEl.textContent = t(skill.description);
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
      context.consumeActiveActionToken();
      context.closeSlashMenu();
      context.handleSkillSelection(skill);
    });
    list.insertBefore(button, baseAnchor);
  });
}

export function renderAgentActionsInSlashMenu(
  context: ActionCommandSlashMenuContext,
  query = "",
): void {
  context.clearAgentSlashItems();
  const ownerDoc = context.body.ownerDocument;
  const list = context.slashMenu?.querySelector(".llm-action-picker-list");
  if (!ownerDoc || !list) return;
  const firstBase = list.firstChild;
  const mkAgentEl = (tag: string, className: string): HTMLElement => {
    const element = ownerDoc.createElement(tag);
    element.className = className;
    element.setAttribute("data-slash-agent-item", "true");
    return element;
  };
  const commandSource = runtimeCommandSource(context);
  if (commandSource) {
    let commands: RuntimeSlashMenuItem[] = [];
    try {
      commands = commandSource.list();
    } catch {
      commands = [];
    }
    if (!commands.length) {
      const loading = mkAgentEl("div", "llm-slash-menu-section");
      loading.setAttribute("aria-hidden", "true");
      loading.textContent = commandSource.loadingText;
      list.insertBefore(loading, firstBase);
      void commandSource
        .refresh()
        .then(() => {
          // Re-render only when the list arrived, or the loader would loop.
          if (commandSource.list().length) {
            renderAgentActionsInSlashMenu(context, query);
          } else {
            loading.remove();
          }
        })
        .catch(() => {
          loading.remove();
        });
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
      section.textContent = commandSource.label;
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
          context.consumeActiveActionToken();
          context.closeSlashMenu();
          context.insertCommandToken({
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
    resolveDisplayConversationKind(context.getItem()),
  );
  let allActions: SlashMenuActionItem[] = [];
  try {
    allActions = getAgentApi().listActions(chatMode);
  } catch {
    void initAgentSubsystem()
      .then(() => {
        renderAgentActionsInSlashMenu(context, query);
      })
      .catch(() => {});
    return;
  }
  const filtered = query
    ? allActions.filter(
        (action) =>
          action.name.toLowerCase().includes(query) ||
          action.description.toLowerCase().includes(query) ||
          t(action.description).toLowerCase().includes(query),
      )
    : allActions;
  const baseAnchor = list.querySelector("[data-slash-base-item]") || null;
  const baseLabel = mkAgentEl("div", "llm-slash-menu-section");
  baseLabel.setAttribute("aria-hidden", "true");
  baseLabel.setAttribute("data-slash-section", "base");
  baseLabel.textContent = t("Base actions");
  list.insertBefore(baseLabel, baseAnchor);
  const selectedProfile = context.getSelectedProfile();
  const compactAction: SlashMenuActionItem = {
    name: "compact",
    description:
      selectedProfile?.authMode === "codex_app_server"
        ? "Compact the current Codex context."
        : "Compact the current agent context.",
    inputSchema: { type: "object", properties: {} },
  };
  if (
    !query ||
    compactAction.name.includes(query) ||
    compactAction.description.toLowerCase().includes(query) ||
    t(compactAction.description).toLowerCase().includes(query)
  ) {
    const button = mkAgentEl(
      "button",
      "llm-action-picker-item",
    ) as HTMLButtonElement;
    button.type = "button";
    button.title = t(compactAction.description);
    const titleEl = ownerDoc.createElement("span");
    titleEl.className = "llm-action-picker-title";
    titleEl.textContent = "/compact";
    const descEl = ownerDoc.createElement("span");
    descEl.className = "llm-action-picker-description";
    descEl.textContent = t(compactAction.description);
    button.append(titleEl, descEl);
    button.addEventListener("click", (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      context.consumeActiveActionToken();
      context.closeSlashMenu();
      context.insertCommandToken(compactAction);
    });
    list.insertBefore(button, baseAnchor);
  }
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
    button.title = t(action.description);
    const titleEl = ownerDoc.createElement("span");
    titleEl.className = "llm-action-picker-title";
    titleEl.textContent = action.name;
    const descEl = ownerDoc.createElement("span");
    descEl.className = "llm-action-picker-description";
    descEl.textContent = firstSentence(t(action.description));
    button.append(titleEl, descEl);
    button.addEventListener("click", (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      context.consumeActiveActionToken();
      context.closeSlashMenu();
      const userQuery = context.inputBox.value.trim();
      const actionMode = context.buildActionRequestContext().mode;
      const hasPaperScopeProfile = Boolean(
        getAgentApi().getPaperScopedActionProfile(action.name),
      );
      if (
        shouldExecuteAgentActionImmediatelyFromSlash(
          action.name,
          actionMode,
          hasPaperScopeProfile,
        )
      ) {
        const parsedInput = isPagedLibraryActionForMode(action.name, actionMode)
          ? buildCommandDefaultInput(action.name, actionMode)
          : undefined;
        void context.executeAgentAction(action, parsedInput, userQuery);
        return;
      }
      context.insertCommandToken(action);
    });
    list.insertBefore(button, baseLabel);
  });
}
