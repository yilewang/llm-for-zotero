/**
 * The subagent half of the composer's model menu.
 *
 * The menu opens on the chat model list. A "Subagent" row at the bottom names
 * the model that reads papers for the chat model (digests and full reads; the
 * code calls it the reader). Clicking the row turns the menu into a second
 * page: a back row, a short explanation, then "Same as chat model", the
 * runtime's own models (Codex, Claude Code) and the configured API models
 * grouped by provider. One subagent is kept per runtime; picking one goes
 * back to the first page.
 *
 * This module only builds the DOM and reads or writes the selection through
 * its dependencies. The button itself never shows the subagent; only its
 * tooltip does (`describeReaderSelection`).
 */
import { t } from "../../../../utils/i18n";
import { createElement } from "../../../../utils/domHelpers";
import type { RuntimeModelEntry } from "../../../../utils/modelProviders";
import {
  sameReaderSelection,
  type ReaderRuntimeKey,
  type ReaderSelection,
} from "../../../../shared/readerSelection";
import { MENU_OPTION_SELECTED_CLASS } from "./menuController";

/** The page the model menu shows: the chat models or the subagent page. */
export type ReaderMenuPage = "chat" | "subagent";

/** How a reader reads in the button's tooltip: "<provider> · <model>". */
export type ReaderDescription = { providerLabel: string; modelLabel: string };

type ProviderGroup = { providerLabel: string; entries: RuntimeModelEntry[] };

function groupByProvider(entries: RuntimeModelEntry[]): ProviderGroup[] {
  const groups: ProviderGroup[] = [];
  const byLabel = new Map<string, ProviderGroup>();
  for (const entry of entries) {
    let group = byLabel.get(entry.providerLabel);
    if (!group) {
      group = { providerLabel: entry.providerLabel, entries: [] };
      byLabel.set(entry.providerLabel, group);
      groups.push(group);
    }
    group.entries.push(entry);
  }
  return groups;
}

/** The runtime's own provider label, for a reader model its list lacks. */
const RUNTIME_PROVIDER_LABEL: Record<ReaderRuntimeKey, string> = {
  agent: "",
  codex: "Codex",
  claude: "Claude Code",
};

/**
 * The reader as the tooltip names it, or null for Same as chat model. An
 * entry that is gone (or WebChat) is Same as chat, as it is when a paper is
 * read.
 */
export function describeReaderSelection(params: {
  runtime: ReaderRuntimeKey;
  selection: ReaderSelection | null;
  lookupEntry: (entryId: string) => RuntimeModelEntry | null;
  runtimeEntries: RuntimeModelEntry[];
}): ReaderDescription | null {
  const { selection } = params;
  if (!selection) return null;
  if (selection.kind === "entry") {
    const entry = params.lookupEntry(selection.entryId);
    if (!entry || entry.authMode === "webchat") return null;
    return {
      providerLabel: entry.providerLabel,
      modelLabel: entry.displayModelLabel || entry.model,
    };
  }
  const own = params.runtimeEntries.find(
    (entry) => entry.model === selection.model,
  );
  const providerLabel =
    own?.providerLabel || RUNTIME_PROVIDER_LABEL[params.runtime];
  if (!providerLabel) return null;
  return {
    providerLabel,
    modelLabel: own?.displayModelLabel || selection.model,
  };
}

/** The tooltip line, e.g. "Subagent: Codex · gpt-6.1-sol". */
export function formatReaderTooltipLine(
  description: ReaderDescription | null,
): string {
  return description
    ? `${t("Subagent")}: ${description.providerLabel} · ${description.modelLabel}`
    : "";
}

export type ReaderMenuDeps = {
  doc: Document;
  getRuntime: () => ReaderRuntimeKey;
  getSelection: (runtime: ReaderRuntimeKey) => ReaderSelection | null;
  setSelection: (
    runtime: ReaderRuntimeKey,
    selection: ReaderSelection | null,
  ) => void;
  /** Configured API models a reader may use (never WebChat). */
  getApiEntries: () => RuntimeModelEntry[];
  /** The runtime's own models; empty for the plugin Agent. */
  getRuntimeEntries: () => RuntimeModelEntry[];
  lookupEntry: (entryId: string) => RuntimeModelEntry | null;
  /** The runtime catalog's loading, error and retry rows, if any. */
  appendRuntimeCatalogStatus: (menu: HTMLDivElement) => void;
  appendProviderSection: (menu: HTMLDivElement, label: string) => void;
  optionTitle: (entry: RuntimeModelEntry, own: boolean) => string;
  isPrimaryPointerEvent: (event: Event) => boolean;
  /** The chat model's name, for "Default · <model>". */
  getMainModelLabel: () => string;
  /** Whether the subagent page was ever opened (hides the New label). */
  getSubagentSeen: () => boolean;
  markSubagentSeen: () => void;
  /** Called after the page changed; rebuilds and repositions the menu. */
  onPageChange: (page: ReaderMenuPage) => void;
  /** Called after a subagent was picked; refreshes the button tooltip. */
  onPick: () => void;
};

export function createReaderMenuController(deps: ReaderMenuDeps) {
  let page: ReaderMenuPage = "chat";

  const setPage = (next: ReaderMenuPage) => {
    if (page === next) return;
    page = next;
    deps.onPageChange(next);
  };

  /** The selection as the menu shows it; a gone entry reads as Same as chat. */
  const shownSelection = (): ReaderSelection | null => {
    const stored = deps.getSelection(deps.getRuntime());
    return stored?.kind === "entry" &&
      !deps.getApiEntries().some((entry) => entry.entryId === stored.entryId)
      ? null
      : stored;
  };

  /** The "Subagent" row pinned to the bottom of the chat model page. */
  const appendSubagentRow = (menu: HTMLDivElement) => {
    const doc = deps.doc;
    const footer = createElement(doc, "div", "llm-model-menu-subagent-footer");
    const row = createElement(doc, "button", "llm-model-menu-subagent-row", {
      type: "button",
    });
    row.dataset.modelMenuSubagent = "open";
    const description = describeReaderSelection({
      runtime: deps.getRuntime(),
      selection: shownSelection(),
      lookupEntry: deps.lookupEntry,
      runtimeEntries: deps.getRuntimeEntries(),
    });
    const value = description
      ? description.modelLabel
      : t("Same as chat model");
    const icon = createElement(doc, "span", "llm-model-menu-subagent-icon");
    icon.setAttribute("aria-hidden", "true");
    const text = createElement(doc, "span", "llm-model-menu-subagent-text");
    const top = createElement(doc, "span", "llm-model-menu-subagent-label", {
      textContent: t("Subagent"),
    });
    if (!deps.getSubagentSeen()) {
      top.appendChild(
        createElement(doc, "span", "llm-model-menu-subagent-new", {
          textContent: t("New"),
        }),
      );
    }
    const valueEl = createElement(
      doc,
      "span",
      "llm-model-menu-subagent-value",
      {
        textContent: value,
      },
    );
    text.append(top, valueEl);
    const chevron = createElement(
      doc,
      "span",
      "llm-model-menu-subagent-chevron",
    );
    chevron.setAttribute("aria-hidden", "true");
    row.append(icon, text, chevron);
    row.title = description
      ? `${t("Subagent")}: ${description.providerLabel} · ${description.modelLabel}`
      : `${t("Subagent")}: ${t("Same as chat model")}`;
    row.addEventListener("click", (event: Event) => {
      if (!deps.isPrimaryPointerEvent(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!deps.getSubagentSeen()) deps.markSubagentSeen();
      setPage("subagent");
    });
    footer.appendChild(row);
    menu.appendChild(footer);
  };

  /** The back row and the explanation at the top of the subagent page. */
  const appendSubagentHeader = (menu: HTMLDivElement) => {
    const doc = deps.doc;
    const back = createElement(doc, "button", "llm-model-menu-back", {
      type: "button",
      textContent: t("Subagent"),
      title: t("Back to chat models"),
    });
    back.dataset.modelMenuSubagent = "back";
    back.addEventListener("click", (event: Event) => {
      if (!deps.isPrimaryPointerEvent(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setPage("chat");
    });
    menu.appendChild(back);
    const explain = createElement(doc, "div", "llm-model-menu-explain", {
      textContent: t(
        "A helper your chat model sends off to read whole papers. It reads, then hands notes back, and your chat model writes the answer. A fast, low-cost model works well here.",
      ),
    });
    menu.appendChild(explain);
  };

  const appendOption = (
    menu: HTMLDivElement,
    params: {
      label: string;
      title?: string;
      selected: boolean;
      dataset: Record<string, string>;
      selection: ReaderSelection | null;
      /** A second, smaller line under the label. */
      note?: string;
    },
  ) => {
    const option = createElement(
      deps.doc,
      "button",
      "llm-response-menu-item llm-model-option",
      {
        type: "button",
        textContent: params.label,
        ...(params.title ? { title: params.title } : {}),
      },
    );
    if (params.note) {
      option.classList.add("llm-model-option-with-note");
      option.appendChild(
        createElement(deps.doc, "span", "llm-model-option-note", {
          textContent: params.note,
        }),
      );
    }
    option.classList.toggle(MENU_OPTION_SELECTED_CLASS, params.selected);
    for (const [key, value] of Object.entries(params.dataset)) {
      option.dataset[key] = value;
    }
    option.addEventListener("click", (event: Event) => {
      if (!deps.isPrimaryPointerEvent(event)) return;
      event.preventDefault();
      event.stopPropagation();
      deps.setSelection(deps.getRuntime(), params.selection);
      deps.onPick();
      setPage("chat");
    });
    menu.appendChild(option);
  };

  /** The subagent page: back row, explanation, Same as chat model, the
   *  runtime's own models, then the API models by provider. */
  const appendReaderList = (menu: HTMLDivElement) => {
    const runtime = deps.getRuntime();
    const apiEntries = deps.getApiEntries();
    const runtimeEntries = deps.getRuntimeEntries();
    // An entry that is gone reads as Same as chat, here and when reading.
    const selection = shownSelection();
    appendSubagentHeader(menu);
    const mainLabel = deps.getMainModelLabel();
    appendOption(menu, {
      label: t("Same as chat model"),
      selected: !selection,
      dataset: { readerOption: "same" },
      selection: null,
      note: mainLabel ? `${t("Default")} · ${mainLabel}` : t("Default"),
    });
    if (runtime !== "agent") {
      deps.appendRuntimeCatalogStatus(menu);
      const own =
        selection?.kind === "model" &&
        !runtimeEntries.some((entry) => entry.model === selection.model)
          ? // The picked model is not in the list yet (the catalog loads
            // late); keep it visible and selected rather than lose it.
            [
              {
                providerLabel: RUNTIME_PROVIDER_LABEL[runtime],
                entries: [
                  {
                    entryId: `reader::${selection.model}`,
                    model: selection.model,
                    displayModelLabel: selection.model,
                    providerLabel: RUNTIME_PROVIDER_LABEL[runtime],
                  } as RuntimeModelEntry,
                  ...runtimeEntries,
                ],
              },
            ]
          : groupByProvider(runtimeEntries);
      for (const group of own) {
        deps.appendProviderSection(menu, group.providerLabel);
        for (const entry of group.entries) {
          const asSelection: ReaderSelection = {
            kind: "model",
            model: entry.model,
          };
          appendOption(menu, {
            label: entry.displayModelLabel || entry.model || "default",
            title: deps.optionTitle(entry, true),
            selected: sameReaderSelection(selection, asSelection),
            dataset: { readerModel: entry.model },
            selection: asSelection,
          });
        }
      }
    }
    for (const group of groupByProvider(apiEntries)) {
      deps.appendProviderSection(menu, group.providerLabel);
      for (const entry of group.entries) {
        const asSelection: ReaderSelection = {
          kind: "entry",
          entryId: entry.entryId,
        };
        appendOption(menu, {
          label: entry.displayModelLabel || entry.model || "default",
          title: deps.optionTitle(entry, false),
          selected: sameReaderSelection(selection, asSelection),
          dataset: { readerEntryId: entry.entryId },
          selection: asSelection,
        });
      }
    }
  };

  return {
    /** The page the menu shows now. */
    getPage: () => page,
    /** The menu always opens on the chat model page. */
    resetPage: () => {
      page = "chat";
    },
    appendSubagentRow,
    appendReaderList,
  };
}
