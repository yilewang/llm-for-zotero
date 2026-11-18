/**
 * Settings → Agent → Runtimes: the built-in Agent is always listed; Codex,
 * Claude Code and Antigravity are listed once the user adds them.
 *
 * A runtime counts as added when the `addedRuntimeSystems` pref names it or
 * its enable switch is on (so a runtime switched on before this list existed
 * stays listed). "Add runtime" adds one and switches it on; "Remove" switches
 * it off and takes it off the list. Both work through the row's own enable
 * switch, so its existing handler does the enabling (and, for Antigravity,
 * prepares storage first). A removed runtime's chats stay in History.
 */

import { config } from "../../../package.json";
import { t } from "../../utils/i18n";
import {
  RUNTIME_CONVERSATION_SYSTEMS,
  getRuntimeConversationSystemDescriptor,
  type RuntimeConversationSystem,
} from "../../core/conversations/conversationSystems";
import { isRuntimeConversationSystemEnabled } from "../../shared/conversationSystemPrefs";
import { RUNTIME_SYSTEM_DISPLAY_ORDER } from "../contextPanel/runtimeBadge";

export const ADDED_RUNTIME_SYSTEMS_PREF = "addedRuntimeSystems";

const HTML_NS = "http://www.w3.org/1999/xhtml";

/** Each runtime's Settings row and its enable switch. */
const RUNTIME_ROWS: Record<
  RuntimeConversationSystem,
  { row: string; enableId: string; requirement: string }
> = {
  codex: {
    row: "codex",
    enableId: "codex-app-server-enable",
    requirement: "Runs the Codex CLI. Needs codex installed and signed in.",
  },
  claude_code: {
    row: "claude",
    enableId: "agent-backend-mode",
    requirement:
      "Runs Claude Code through its bridge. Needs claude installed and signed in.",
  },
  antigravity: {
    row: "antigravity",
    enableId: "antigravity-enable",
    requirement: "Runs the Antigravity CLI. Needs agy installed and signed in.",
  },
};

function prefKey(): string {
  return `${config.prefsPrefix}.${ADDED_RUNTIME_SYSTEMS_PREF}`;
}

/** The runtimes the user added, in registry order. */
export function getAddedRuntimeSystems(): RuntimeConversationSystem[] {
  const raw = String(Zotero.Prefs.get(prefKey(), true) || "");
  const names = new Set(raw.split(",").map((name) => name.trim()));
  return RUNTIME_CONVERSATION_SYSTEMS.filter((system) => names.has(system));
}

export function setAddedRuntimeSystems(
  systems: readonly RuntimeConversationSystem[],
): void {
  const wanted = new Set(systems);
  Zotero.Prefs.set(
    prefKey(),
    RUNTIME_CONVERSATION_SYSTEMS.filter((system) => wanted.has(system)).join(
      ",",
    ),
    true,
  );
}

/** Listed in Settings: added, or switched on. */
export function isRuntimeListed(system: RuntimeConversationSystem): boolean {
  return (
    getAddedRuntimeSystems().includes(system) ||
    isRuntimeConversationSystemEnabled(system)
  );
}

export function registerRuntimeRows(doc: Document): void {
  const byId = <T extends Element>(id: string) =>
    doc.querySelector(`#${config.addonRef}-${id}`) as T | null;
  const rowOf = (system: RuntimeConversationSystem) =>
    doc.querySelector(
      `[data-llm-agent-row="${RUNTIME_ROWS[system].row}"]`,
    ) as HTMLElement | null;
  const switchOf = (system: RuntimeConversationSystem) =>
    byId<HTMLInputElement>(RUNTIME_ROWS[system].enableId);
  const lastRow = rowOf(
    RUNTIME_SYSTEM_DISPLAY_ORDER[RUNTIME_SYSTEM_DISPLAY_ORDER.length - 1],
  );
  if (!lastRow?.parentElement) return;

  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
  ) => {
    const element = doc.createElementNS(
      HTML_NS,
      tag,
    ) as HTMLElementTagNameMap[K];
    element.className = className;
    return element;
  };

  const addWrap = el("div", "llm-pref-add-runtime");
  const addButton = el("button", "llm-pref-add-runtime-btn");
  addButton.type = "button";
  addButton.id = `${config.addonRef}-add-runtime`;
  addButton.setAttribute("aria-haspopup", "menu");
  addButton.setAttribute("aria-expanded", "false");
  addButton.textContent = t("+ Add runtime");
  const menu = el("div", "llm-pref-add-runtime-menu");
  menu.id = `${config.addonRef}-add-runtime-menu`;
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  addWrap.append(addButton, menu);
  lastRow.after(addWrap);

  const setSwitch = (system: RuntimeConversationSystem, on: boolean) => {
    const input = switchOf(system);
    if (!input || input.checked === on) return;
    input.checked = on;
    // The Settings window's own Event: one made in the plugin's scope is
    // refused by its elements.
    const EventCtor = doc.defaultView?.Event ?? Event;
    input.dispatchEvent(new EventCtor("change", { bubbles: true }));
  };

  const closeMenu = () => {
    menu.hidden = true;
    addButton.setAttribute("aria-expanded", "false");
  };

  const render = () => {
    const missing: RuntimeConversationSystem[] = [];
    for (const system of RUNTIME_SYSTEM_DISPLAY_ORDER) {
      const row = rowOf(system);
      const listed = isRuntimeListed(system);
      if (row) row.hidden = !listed;
      if (!listed) missing.push(system);
    }
    addWrap.hidden = missing.length === 0;
    menu.replaceChildren(
      ...missing.map((system) => {
        const item = el("button", "llm-pref-add-runtime-item");
        item.type = "button";
        item.setAttribute("role", "menuitem");
        item.dataset.runtimeSystem = system;
        const icon = el(
          "span",
          `llm-pref-row-icon llm-pref-row-icon--${RUNTIME_ROWS[system].row}`,
        );
        const name = el("span", "llm-pref-add-runtime-name");
        name.textContent = getRuntimeConversationSystemDescriptor(system).label;
        const note = el("span", "llm-pref-add-runtime-note");
        note.textContent = t(RUNTIME_ROWS[system].requirement);
        item.append(icon, name, note);
        item.addEventListener("click", () => {
          closeMenu();
          setAddedRuntimeSystems([...getAddedRuntimeSystems(), system]);
          render();
          setSwitch(system, true);
        });
        return item;
      }),
    );
  };

  for (const system of RUNTIME_SYSTEM_DISPLAY_ORDER) {
    const row = rowOf(system);
    const head = row?.querySelector(".llm-pref-row-head");
    const tag = head?.querySelector(".llm-pref-row-tag");
    if (!head || !tag) continue;
    head.classList.add("llm-pref-row-head--removable");
    const remove = el("button", "llm-pref-row-remove");
    remove.type = "button";
    remove.textContent = t("Remove");
    remove.dataset.runtimeSystem = system;
    remove.setAttribute(
      "aria-label",
      `${t("Remove")} ${getRuntimeConversationSystemDescriptor(system).label}`,
    );
    remove.addEventListener("click", () => {
      setSwitch(system, false);
      setAddedRuntimeSystems(
        getAddedRuntimeSystems().filter((added) => added !== system),
      );
      render();
    });
    tag.before(remove);
  }

  addButton.addEventListener("click", (event) => {
    event.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    addButton.setAttribute("aria-expanded", String(open));
  });
  doc.addEventListener("click", (event) => {
    if (!addWrap.contains(event.target as Node)) closeMenu();
  });
  doc.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key === "Escape") closeMenu();
  });
  // A runtime switched on before this list existed joins it, so switching
  // it off by hand later keeps its row.
  const switchedOn = RUNTIME_SYSTEM_DISPLAY_ORDER.filter((system) =>
    isRuntimeConversationSystemEnabled(system),
  );
  const added = getAddedRuntimeSystems();
  if (switchedOn.some((system) => !added.includes(system))) {
    setAddedRuntimeSystems([...added, ...switchedOn]);
  }
  render();
}
