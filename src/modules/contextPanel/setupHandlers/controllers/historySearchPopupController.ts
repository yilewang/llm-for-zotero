import { createElement } from "../../../../utils/domHelpers";
import {
  formatGlobalHistoryTimestamp,
  groupHistoryEntriesByDay,
  type ConversationHistoryEntry,
} from "./conversationHistoryController";
import {
  appendHistorySearchHighlightedText,
  buildHistorySearchResults,
  normalizeHistorySearchQuery,
  type HistorySearchDocument,
  type HistorySearchResult,
} from "./historySearchController";

type TranslateFn = (label: string) => string;

export const HISTORY_SEARCH_POPUP_ITEM_TAG = "div";
export const HISTORY_SEARCH_POPUP_THEME_DARK_CLASS =
  "llm-history-search-theme-dark";
export const HISTORY_SEARCH_POPUP_THEME_LIGHT_CLASS =
  "llm-history-search-theme-light";

export type HistorySearchPopupController = {
  open: () => void;
  close: () => void;
  toggle: () => void;
  isOpen: () => boolean;
  destroy: () => void;
};

export type HistorySearchPopupControllerDeps = {
  parent: HTMLElement;
  loadEntries: () => Promise<ConversationHistoryEntry[]>;
  loadDocument: (
    entry: ConversationHistoryEntry,
  ) => Promise<HistorySearchDocument>;
  onSelect: (entry: ConversationHistoryEntry) => void | Promise<void>;
  translate?: TranslateFn;
  log?: (...args: unknown[]) => void;
  resolveLabel?: (entry: ConversationHistoryEntry) => string;
  resolveScopeLabel?: (entry: ConversationHistoryEntry) => string;
};

export function sortHistorySearchPopupEntries(
  entries: readonly ConversationHistoryEntry[],
): ConversationHistoryEntry[] {
  return [...entries].sort((a, b) => {
    if (b.lastActivityAt !== a.lastActivityAt) {
      return b.lastActivityAt - a.lastActivityAt;
    }
    return b.conversationKey - a.conversationKey;
  });
}

export function mapHistorySearchPopupResults(
  entries: readonly ConversationHistoryEntry[],
  results: readonly HistorySearchResult[],
): {
  entries: ConversationHistoryEntry[];
  resultsByKey: Map<number, HistorySearchResult>;
} {
  const entriesByKey = new Map(
    entries.map((entry) => [entry.conversationKey, entry]),
  );
  const resultsByKey = new Map<number, HistorySearchResult>();
  const mappedEntries: ConversationHistoryEntry[] = [];
  for (const result of results) {
    const entry = entriesByKey.get(result.entry.conversationKey);
    if (!entry) continue;
    mappedEntries.push(entry);
    resultsByKey.set(entry.conversationKey, result);
  }
  return { entries: mappedEntries, resultsByKey };
}

type RgbColor = { r: number; g: number; b: number; a: number };

function parseCssColor(value: string): RgbColor | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "transparent") return null;

  const hex = normalized.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const raw = hex[1];
    const expanded =
      raw.length === 3
        ? raw
            .split("")
            .map((char) => `${char}${char}`)
            .join("")
        : raw;
    return {
      r: Number.parseInt(expanded.slice(0, 2), 16),
      g: Number.parseInt(expanded.slice(2, 4), 16),
      b: Number.parseInt(expanded.slice(4, 6), 16),
      a: 1,
    };
  }

  const rgb = normalized.match(
    /^rgba?\(\s*([0-9.]+)(?:,|\s)\s*([0-9.]+)(?:,|\s)\s*([0-9.]+)(?:\s*[,/]\s*([0-9.]+%?))?\s*\)$/,
  );
  if (!rgb) return null;
  const alpha = rgb[4]?.endsWith("%")
    ? Number.parseFloat(rgb[4]) / 100
    : rgb[4]
      ? Number.parseFloat(rgb[4])
      : 1;
  if (alpha <= 0) return null;
  return {
    r: Number.parseFloat(rgb[1]),
    g: Number.parseFloat(rgb[2]),
    b: Number.parseFloat(rgb[3]),
    a: alpha,
  };
}

function relativeLuminance({ r, g, b }: RgbColor): number {
  const toLinear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.03928
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  };
  const red = toLinear(r);
  const green = toLinear(g);
  const blue = toLinear(b);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function resolveHistorySearchPopupThemeFromColors(
  colors: readonly string[],
): "dark" | "light" | null {
  for (const color of colors) {
    const parsed = parseCssColor(color);
    if (!parsed) continue;
    return relativeLuminance(parsed) < 0.32 ? "dark" : "light";
  }
  return null;
}

export function createHistorySearchPopupController(
  deps: HistorySearchPopupControllerDeps,
): HistorySearchPopupController {
  const doc = deps.parent.ownerDocument;
  const translate: TranslateFn = deps.translate || ((label) => label);
  const log = deps.log || (() => undefined);

  const overlay = createElement(doc, "div", "llm-standalone-search-overlay");
  overlay.style.display = "none";

  const popup = createElement(doc, "div", "llm-standalone-search-popup");
  const header = createElement(doc, "div", "llm-standalone-search-header");
  const input = createElement(doc, "input", "llm-standalone-search-input", {
    type: "text",
    placeholder: translate("Search history"),
  }) as HTMLInputElement;
  input.setAttribute("autocomplete", "off");
  input.setAttribute("spellcheck", "false");
  input.setAttribute("aria-label", translate("Search history"));

  const closeButton = createElement(
    doc,
    "button",
    "llm-standalone-search-close",
    {
      type: "button",
      textContent: "\u00D7",
      title: translate("Close"),
    },
  ) as HTMLButtonElement;
  const results = createElement(doc, "div", "llm-standalone-search-results");

  header.append(input, closeButton);
  popup.append(header, results);
  overlay.appendChild(popup);
  deps.parent.appendChild(overlay);

  let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let searchSeq = 0;
  let renderedEntriesByKey = new Map<number, ConversationHistoryEntry>();

  const syncThemeClass = () => {
    overlay.classList.remove(
      HISTORY_SEARCH_POPUP_THEME_DARK_CLASS,
      HISTORY_SEARCH_POPUP_THEME_LIGHT_CLASS,
    );
    const win = doc.defaultView;
    const root = doc.documentElement;
    const parentStyle = win?.getComputedStyle(deps.parent);
    const popupStyle = win?.getComputedStyle(popup);
    const theme =
      resolveHistorySearchPopupThemeFromColors([
        popupStyle?.backgroundColor || "",
        parentStyle?.backgroundColor || "",
      ]) ||
      (deps.parent.closest(".window-is-dark") ||
      root?.classList.contains("window-is-dark") ||
      root?.hasAttribute("lwtheme-brighttext")
        ? "dark"
        : "light");
    overlay.classList.add(
      theme === "dark"
        ? HISTORY_SEARCH_POPUP_THEME_DARK_CLASS
        : HISTORY_SEARCH_POPUP_THEME_LIGHT_CLASS,
    );
  };

  const clearResults = () => {
    if (typeof (results as any).replaceChildren === "function") {
      (results as any).replaceChildren();
    } else {
      results.textContent = "";
    }
  };

  const resolveLabel = (entry: ConversationHistoryEntry): string => {
    const value = deps.resolveLabel?.(entry);
    if (value) return value;
    return entry.kind === "paper"
      ? entry.sectionTitle || translate("Paper chat")
      : translate("Library chat");
  };

  const resolveScopeLabel = (entry: ConversationHistoryEntry): string => {
    const value = deps.resolveScopeLabel?.(entry);
    if (value) return value;
    return entry.kind === "paper"
      ? entry.sectionTitle || translate("Paper chat")
      : translate("Library chat");
  };

  const renderEntries = (
    entries: ConversationHistoryEntry[],
    query: string,
    searchResultsByKey = new Map<number, HistorySearchResult>(),
  ) => {
    clearResults();
    renderedEntriesByKey = new Map(
      entries.map((entry) => [entry.conversationKey, entry]),
    );

    if (!entries.length) {
      const empty = createElement(doc, "div", "llm-standalone-search-empty", {
        textContent: query
          ? translate("No matching history")
          : translate("No conversations yet"),
      });
      results.appendChild(empty);
      return;
    }

    const groups = groupHistoryEntriesByDay(entries, { translate });
    for (const group of groups) {
      const dayLabel = createElement(
        doc,
        "div",
        "llm-standalone-search-day-label",
        { textContent: group.label },
      );
      results.appendChild(dayLabel);

      for (const entry of group.items) {
        // Use <div> instead of <button>: Gecko/XUL button layout can collapse
        // multi-line custom content in the Zotero sidebar.
        const item = createElement(
          doc,
          HISTORY_SEARCH_POPUP_ITEM_TAG,
          "llm-standalone-search-item",
        ) as HTMLDivElement;
        item.setAttribute("role", "button");
        item.setAttribute("tabindex", "0");
        item.dataset.conversationKey = String(entry.conversationKey);

        const textWrap = createElement(
          doc,
          "div",
          "llm-standalone-search-text",
        );
        const label = createElement(
          doc,
          "span",
          "llm-standalone-search-label",
        );
        label.dataset.labelType = entry.kind === "paper" ? "paper" : "library";
        const labelText = resolveLabel(entry);
        label.textContent = labelText;

        const title = createElement(
          doc,
          "span",
          "llm-standalone-search-title",
        );
        const displayTitle = entry.title || translate("Untitled chat");
        const searchResult = searchResultsByKey.get(entry.conversationKey);
        if (searchResult?.titleRanges.length) {
          appendHistorySearchHighlightedText(
            title,
            displayTitle,
            searchResult.titleRanges,
          );
        } else {
          title.textContent = displayTitle;
        }

        textWrap.append(label, title);
        item.appendChild(textWrap);

        const scopeLabel = resolveScopeLabel(entry);
        const timestamp =
          formatGlobalHistoryTimestamp(entry.lastActivityAt) ||
          entry.timestampText ||
          "";
        const metaText = timestamp ? `${scopeLabel} \u00B7 ${timestamp}` : scopeLabel;
        const meta = createElement(doc, "div", "llm-standalone-search-meta", {
          textContent: metaText,
        });
        item.appendChild(meta);

        if (searchResult?.previewText) {
          const preview = createElement(
            doc,
            "div",
            "llm-standalone-search-preview",
          );
          appendHistorySearchHighlightedText(
            preview,
            searchResult.previewText,
            searchResult.previewRanges,
          );
          item.appendChild(preview);
        }

        item.title = `${labelText}: ${entry.title || translate("Untitled chat")}`;
        results.appendChild(item);
      }
    }
  };

  const runSearch = async (query: string) => {
    const thisSeq = ++searchSeq;
    try {
      const allEntries = sortHistorySearchPopupEntries(
        await deps.loadEntries(),
      ).filter((entry) => !entry.isPendingDelete);
      if (thisSeq !== searchSeq || !controller.isOpen()) return;

      if (!query.trim()) {
        renderEntries(allEntries, "");
        return;
      }

      const normalizedQuery = normalizeHistorySearchQuery(query);
      const documents = new Map<number, HistorySearchDocument>();
      await Promise.all(
        allEntries.map(async (entry) => {
          if (thisSeq !== searchSeq || !controller.isOpen()) return;
          try {
            documents.set(entry.conversationKey, await deps.loadDocument(entry));
          } catch (err) {
            log("LLM: history search popup indexing failed", {
              conversationKey: entry.conversationKey,
              error: err,
            });
          }
        }),
      );
      if (thisSeq !== searchSeq || !controller.isOpen()) return;

      const rawResults = buildHistorySearchResults(
        allEntries,
        normalizedQuery,
        documents,
      );
      const mapped = mapHistorySearchPopupResults(allEntries, rawResults);
      renderEntries(mapped.entries, query, mapped.resultsByKey);
    } catch (err) {
      log("LLM: history search popup failed", err);
    }
  };

  const controller: HistorySearchPopupController = {
    open: () => {
      overlay.style.display = "flex";
      syncThemeClass();
      input.value = "";
      clearResults();
      renderedEntriesByKey.clear();
      input.focus();
      void runSearch("");
    },
    close: () => {
      searchSeq += 1;
      overlay.style.display = "none";
      input.value = "";
      clearResults();
      renderedEntriesByKey.clear();
      if (searchDebounceTimer !== null) {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = null;
      }
    },
    toggle: () => {
      if (controller.isOpen()) {
        controller.close();
      } else {
        controller.open();
      }
    },
    isOpen: () => overlay.style.display !== "none",
    destroy: () => {
      controller.close();
      overlay.remove();
    },
  };

  closeButton.addEventListener("click", () => controller.close());
  overlay.addEventListener("click", (event: Event) => {
    if (event.target === overlay) controller.close();
  });
  input.addEventListener("input", () => {
    if (searchDebounceTimer !== null) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      searchDebounceTimer = null;
      void runSearch(input.value);
    }, 300);
  });
  input.addEventListener("keydown", (event: Event) => {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.key !== "Escape") return;
    keyboardEvent.preventDefault();
    controller.close();
  });
  const selectResultFromTarget = (target: Element | null): boolean => {
    const item = target?.closest(
      ".llm-standalone-search-item",
    ) as HTMLDivElement | null;
    if (!item) return false;
    const conversationKey = Number.parseInt(
      item.dataset.conversationKey || "",
      10,
    );
    if (!Number.isFinite(conversationKey) || conversationKey <= 0) return false;
    const entry = renderedEntriesByKey.get(conversationKey);
    if (!entry) return false;
    controller.close();
    void Promise.resolve(deps.onSelect(entry)).catch((err) => {
      log("LLM: history search popup selection failed", err);
    });
    return true;
  };

  results.addEventListener("click", (event: Event) => {
    if (!selectResultFromTarget(event.target as Element | null)) return;
    event.preventDefault();
    event.stopPropagation();
  });
  results.addEventListener("keydown", (event: Event) => {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.key !== "Enter" && keyboardEvent.key !== " ") return;
    if (!selectResultFromTarget(event.target as Element | null)) return;
    keyboardEvent.preventDefault();
    keyboardEvent.stopPropagation();
  });

  return controller;
}
