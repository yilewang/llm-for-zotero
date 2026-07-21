import type { ConversationSystem } from "../../shared/types";
import { createElement } from "../../utils/domHelpers";

export type RuntimeConversationSystem = Exclude<ConversationSystem, "upstream">;

export const RUNTIME_CONVERSATION_SYSTEMS = [
  "codex",
  "claude_code",
] as const satisfies readonly RuntimeConversationSystem[];

type RuntimeSystemButtonMap<T> = Record<RuntimeConversationSystem, T>;

export type RuntimeSystemControls = {
  group: HTMLElement | null;
  buttons: RuntimeSystemButtonMap<HTMLButtonElement | null>;
};

export type CreatedRuntimeSystemControls = {
  group: HTMLElement;
  buttons: RuntimeSystemButtonMap<HTMLButtonElement>;
};

export type RuntimeSystemControlState = {
  groupVisible: boolean;
  groupBusy: boolean;
  buttons: RuntimeSystemButtonMap<{
    visible: boolean;
    active: boolean;
    disabled: boolean;
    label: string;
  }>;
};

export type RuntimeSystemControlsStateInput = {
  activeSystem: ConversationSystem;
  codexEnabled: boolean;
  claudeEnabled: boolean;
  hidden?: boolean;
  busy?: boolean;
};

type CreateRuntimeSystemControlsOptions = {
  groupId?: string;
  groupClassName?: string;
  buttonClassName?: string;
  buttonIds?: Partial<RuntimeSystemButtonMap<string>>;
};

const RUNTIME_SYSTEM_LABELS: RuntimeSystemButtonMap<string> = {
  codex: "Codex",
  claude_code: "Claude Code",
};

function isRuntimeSystemEnabled(
  system: RuntimeConversationSystem,
  input: RuntimeSystemControlsStateInput,
): boolean {
  return system === "codex" ? input.codexEnabled : input.claudeEnabled;
}

export function isRuntimeConversationSystem(
  value: unknown,
): value is RuntimeConversationSystem {
  return value === "codex" || value === "claude_code";
}

export function resolveRuntimeSystemToggleTarget(
  currentSystem: ConversationSystem,
  clickedSystem: RuntimeConversationSystem,
): ConversationSystem {
  return currentSystem === clickedSystem ? "upstream" : clickedSystem;
}

export function resolveRuntimeSystemControlsState(
  input: RuntimeSystemControlsStateInput,
): RuntimeSystemControlState {
  const hidden = input.hidden === true;
  const busy = input.busy === true;
  const buttons = {} as RuntimeSystemControlState["buttons"];
  let groupVisible = false;

  for (const system of RUNTIME_CONVERSATION_SYSTEMS) {
    const visible = !hidden && isRuntimeSystemEnabled(system, input);
    const active = visible && input.activeSystem === system;
    groupVisible ||= visible;
    buttons[system] = {
      visible,
      active,
      disabled: visible && busy,
      label: active
        ? "Switch to upstream mode"
        : `Switch to ${RUNTIME_SYSTEM_LABELS[system]} mode`,
    };
  }

  return {
    groupVisible,
    groupBusy: groupVisible && busy,
    buttons,
  };
}

export function createRuntimeSystemControls(
  doc: Document,
  options: CreateRuntimeSystemControlsOptions = {},
): CreatedRuntimeSystemControls {
  const group = createElement(
    doc,
    "div",
    ["llm-runtime-system-controls", options.groupClassName]
      .filter(Boolean)
      .join(" "),
    options.groupId ? { id: options.groupId } : undefined,
  );
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "Conversation runtime");

  const buttons = {} as CreatedRuntimeSystemControls["buttons"];
  for (const system of RUNTIME_CONVERSATION_SYSTEMS) {
    const button = createElement(
      doc,
      "button",
      [
        "llm-runtime-system-toggle",
        `llm-runtime-system-toggle--${system.replace("_", "-")}`,
        options.buttonClassName,
      ]
        .filter(Boolean)
        .join(" "),
      {
        type: "button",
        title: `Switch to ${RUNTIME_SYSTEM_LABELS[system]} mode`,
      },
    );
    const buttonId = options.buttonIds?.[system];
    if (buttonId) button.id = buttonId;
    button.dataset.conversationSystem = system;
    button.dataset.active = "false";
    button.setAttribute("aria-pressed", "false");
    button.setAttribute("aria-label", button.title);

    const icon = createElement(
      doc,
      "span",
      [
        "llm-runtime-system-toggle-icon",
        `llm-runtime-system-toggle-icon--${system.replace("_", "-")}`,
      ].join(" "),
    );
    icon.setAttribute("aria-hidden", "true");
    button.append(icon);
    group.append(button);
    buttons[system] = button;
  }

  return { group, buttons };
}

export function syncRuntimeSystemControls(
  controls: RuntimeSystemControls,
  input: RuntimeSystemControlsStateInput,
): RuntimeSystemControlState {
  const state = resolveRuntimeSystemControlsState(input);
  if (controls.group) {
    const visibleCount = RUNTIME_CONVERSATION_SYSTEMS.filter(
      (system) => state.buttons[system].visible,
    ).length;
    controls.group.style.display = state.groupVisible ? "inline-flex" : "none";
    controls.group.dataset.visibleCount = String(visibleCount);
    controls.group.dataset.activeSystem = isRuntimeConversationSystem(
      input.activeSystem,
    )
      ? input.activeSystem
      : "";
    controls.group.setAttribute(
      "aria-busy",
      state.groupBusy ? "true" : "false",
    );
    if (state.groupVisible) {
      controls.group.removeAttribute("aria-hidden");
    } else {
      controls.group.setAttribute("aria-hidden", "true");
    }
  }

  for (const system of RUNTIME_CONVERSATION_SYSTEMS) {
    const button = controls.buttons[system];
    if (!button) continue;
    const buttonState = state.buttons[system];
    button.style.display = buttonState.visible ? "inline-flex" : "none";
    button.dataset.active = buttonState.active ? "true" : "false";
    button.disabled = buttonState.disabled;
    button.title = buttonState.label;
    button.setAttribute("aria-label", buttonState.label);
    button.setAttribute("aria-pressed", buttonState.active ? "true" : "false");
  }

  return state;
}
