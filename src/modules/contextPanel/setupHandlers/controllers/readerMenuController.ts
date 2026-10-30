/**
 * The Reader half of the composer's model menu.
 *
 * The menu has a "Main | Reader" switch at the top. Main is the model list as
 * it always was. Reader picks the model that reads papers for the host
 * (digests and full reads): "Same as main", then the runtime's own models
 * (Codex, Claude Code), then the configured API models grouped by provider.
 * One reader is kept per runtime; picking one closes the menu.
 *
 * This module only builds the DOM and reads or writes the selection through
 * its dependencies. The button itself never shows the reader; only its
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

export type ReaderMenuTab = "main" | "reader";

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
 * The reader as the tooltip names it, or null for Same as main. An entry
 * that is gone (or WebChat) is Same as main, as it is when a paper is read.
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

/** The tooltip line, e.g. "Reader: Codex · gpt-6.1-sol". */
export function formatReaderTooltipLine(
  description: ReaderDescription | null,
): string {
  return description
    ? `${t("Reader")}: ${description.providerLabel} · ${description.modelLabel}`
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
  /** Called after the tab changed; rebuilds and repositions the menu. */
  onTabChange: (tab: ReaderMenuTab) => void;
  /** Called after a reader was picked; closes the menu, refreshes the tooltip. */
  onPick: () => void;
};

export function createReaderMenuController(deps: ReaderMenuDeps) {
  let tab: ReaderMenuTab = "main";

  const appendSwitch = (menu: HTMLDivElement) => {
    const group = createElement(
      deps.doc,
      "div",
      "llm-standalone-tab-group llm-model-menu-switch",
    );
    group.setAttribute("role", "tablist");
    for (const value of ["main", "reader"] as const) {
      const button = createElement(
        deps.doc,
        "button",
        `llm-standalone-tab${tab === value ? " active" : ""}`,
        {
          type: "button",
          textContent: value === "main" ? t("Main") : t("Reader"),
        },
      );
      button.dataset.modelMenuTab = value;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(tab === value));
      button.addEventListener("click", (event: Event) => {
        if (!deps.isPrimaryPointerEvent(event)) return;
        event.preventDefault();
        event.stopPropagation();
        if (tab === value) return;
        tab = value;
        deps.onTabChange(value);
      });
      group.appendChild(button);
    }
    menu.appendChild(group);
  };

  const appendOption = (
    menu: HTMLDivElement,
    params: {
      label: string;
      title?: string;
      selected: boolean;
      dataset: Record<string, string>;
      selection: ReaderSelection | null;
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
    });
    menu.appendChild(option);
  };

  /** Same as main, the runtime's own models, then the API models by provider. */
  const appendReaderList = (menu: HTMLDivElement) => {
    const runtime = deps.getRuntime();
    const apiEntries = deps.getApiEntries();
    const runtimeEntries = deps.getRuntimeEntries();
    // An entry that is gone reads as Same as main, here and when reading.
    const stored = deps.getSelection(runtime);
    const selection =
      stored?.kind === "entry" &&
      !apiEntries.some((entry) => entry.entryId === stored.entryId)
        ? null
        : stored;
    appendOption(menu, {
      label: t("Same as main"),
      selected: !selection,
      dataset: { readerOption: "same" },
      selection: null,
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
    /** The tab the menu shows now. */
    getTab: () => tab,
    /** The menu always opens on Main. */
    resetTab: () => {
      tab = "main";
    },
    appendSwitch,
    appendReaderList,
  };
}
