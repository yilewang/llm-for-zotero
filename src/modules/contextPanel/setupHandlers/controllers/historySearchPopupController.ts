import { createElement } from "../../../../utils/domHelpers";
import {
  createHistoryActivityIndicator,
  observeHistoryActivity,
} from "../../historyActivity";
import {
  formatGlobalHistoryTimestamp,
  getHistoryEntryLabelType,
  getHistoryRowRuntimeLabel,
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
export const HISTORY_SEARCH_POPUP_DELETE_CLASS = "llm-standalone-search-delete";
export const HISTORY_SEARCH_POPUP_THEME_DARK_CLASS =
  "llm-history-search-theme-dark";
export const HISTORY_SEARCH_POPUP_THEME_LIGHT_CLASS =
  "llm-history-search-theme-light";

/**
 * Where the popup opens: centered over its parent by default, or right
 * under `anchor` (a follower window's History button), against the window's
 * right edge at full width.
 */
export type HistorySearchPopupOpenOptions = {
  anchor?: HTMLElement | null;
};

export type HistorySearchPopupController = {
  open: (options?: HistorySearchPopupOpenOptions) => void;
  close: () => void;
  toggle: (options?: HistorySearchPopupOpenOptions) => void;
  isOpen: () => boolean;
  destroy: () => void;
};

export type HistorySearchPopupControllerDeps = {
  parent: HTMLElement;
  loadEntries: () => Promise<ConversationHistoryEntry[]>;
  loadDocument: (
    entry: ConversationHistoryEntry,
  ) => Promise<HistorySearchDocument>;
  searchEntries?: (query: string) => Promise<{
    entries: ConversationHistoryEntry[];
    resultsByKey: Map<number, HistorySearchResult>;
  }>;
  onSelect: (
    entry: ConversationHistoryEntry,
  ) => boolean | void | Promise<boolean | void>;
  onDelete?: (entry: ConversationHistoryEntry) => void | Promise<void>;
  translate?: TranslateFn;
  log?: (...args: unknown[]) => void;
  resolveLabel?: (entry: ConversationHistoryEntry) => string;
  resolveScopeLabel?: (entry: ConversationHistoryEntry) => string;
  /** Names the runtime ("Codex", "Claude") on rows of those runtimes. */
  showRuntimeLabel?: boolean;
  /** Search box hint; defaults to "Search history". */
  searchPlaceholder?: string;
  /** Conversation keys to hide from every list the popup shows. */
  getExcludedConversationKeys?: () => ReadonlySet<number>;
};

export function shouldCloseHistorySearchPopupAfterSelection(
  result: boolean | void,
): boolean {
  return result !== false;
}

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

export function filterHistorySearchPopupVisibleEntries(
  entries: readonly ConversationHistoryEntry[],
  hiddenConversationKeys: ReadonlySet<number> = new Set<number>(),
): ConversationHistoryEntry[] {
  return entries.filter(
    (entry) =>
      !entry.isPendingDelete &&
      !hiddenConversationKeys.has(entry.conversationKey),
  );
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

  // color-mix() surfaces compute to color(srgb r g b [/ a]), channels 0-1.
  const srgb = normalized.match(
    /^color\(\s*srgb\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)(?:\s*\/\s*([0-9.]+%?))?\s*\)$/,
  );
  if (srgb) {
    const alpha = srgb[4]?.endsWith("%")
      ? Number.parseFloat(srgb[4]) / 100
      : srgb[4]
        ? Number.parseFloat(srgb[4])
        : 1;
    if (alpha <= 0) return null;
    return {
      r: Number.parseFloat(srgb[1]) * 255,
      g: Number.parseFloat(srgb[2]) * 255,
      b: Number.parseFloat(srgb[3]) * 255,
      a: alpha,
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
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
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

/**
 * Puts the Search history theme class (chip colours) on `target`, from the
 * first readable surface colour, else the window's dark-mode markers. The
 * popup overlay and the embedded lists share it.
 */
export function applyHistorySearchThemeClass(
  target: HTMLElement,
  colors: readonly string[],
): "dark" | "light" {
  const doc = target.ownerDocument;
  const root = doc.documentElement;
  const body = doc.body;
  const theme =
    resolveHistorySearchPopupThemeFromColors(colors) ||
    (target.closest(".window-is-dark") ||
    root?.classList.contains("window-is-dark") ||
    body?.classList.contains("window-is-dark") ||
    root?.hasAttribute("lwtheme-brighttext")
      ? "dark"
      : "light");
  target.classList.remove(
    HISTORY_SEARCH_POPUP_THEME_DARK_CLASS,
    HISTORY_SEARCH_POPUP_THEME_LIGHT_CLASS,
  );
  target.classList.add(
    theme === "dark"
      ? HISTORY_SEARCH_POPUP_THEME_DARK_CLASS
      : HISTORY_SEARCH_POPUP_THEME_LIGHT_CLASS,
  );
  return theme;
}

/**
 * Merges the view's optimistic-delete set with caller-excluded keys (for
 * example, the conversation already open in the main chat).
 */
export function mergeHistorySearchHiddenKeys(
  hiddenConversationKeys: ReadonlySet<number>,
  excludedConversationKeys?: ReadonlySet<number> | null,
): ReadonlySet<number> {
  if (!excludedConversationKeys || !excludedConversationKeys.size) {
    return hiddenConversationKeys;
  }
  if (!hiddenConversationKeys.size) return excludedConversationKeys;
  return new Set<number>([
    ...hiddenConversationKeys,
    ...excludedConversationKeys,
  ]);
}

/**
 * Caps the rendered rows (for a short "Recent" list). A missing, zero,
 * negative, or non-finite limit leaves the entries unchanged.
 */
export function limitHistorySearchListEntries<T>(
  entries: readonly T[],
  limit?: number,
): T[] {
  if (
    typeof limit !== "number" ||
    !Number.isFinite(limit) ||
    limit <= 0 ||
    entries.length <= limit
  ) {
    return [...entries];
  }
  return entries.slice(0, Math.floor(limit));
}

export type HistorySearchListView = {
  /** Root element the rows render into (the container that was passed in). */
  element: HTMLElement;
  /** Search box wired to the view, if any. */
  input: HTMLInputElement | null;
  /**
   * Activates the view and renders the list. Without an argument it uses the
   * current input value (or the empty query when there is no input). With an
   * argument it also writes that value into the input.
   */
  refresh: (query?: string) => void;
  /** Deactivates the view: cancels pending searches, empties rows and input. */
  clear: () => void;
  /** Whether the view is active (between refresh() and clear()/destroy()). */
  isActive: () => boolean;
  /** Clears the view and removes its listeners and activity observer. */
  destroy: () => void;
};

export type HistorySearchListViewDeps = {
  /** Element that receives the day labels and rows. */
  container: HTMLElement;
  /** Optional search box; omit it for a list without search (e.g. Recent). */
  input?: HTMLInputElement | null;
  loadEntries: () => Promise<ConversationHistoryEntry[]>;
  loadDocument: (
    entry: ConversationHistoryEntry,
  ) => Promise<HistorySearchDocument>;
  searchEntries?: (query: string) => Promise<{
    entries: ConversationHistoryEntry[];
    resultsByKey: Map<number, HistorySearchResult>;
  }>;
  onSelect: (entry: ConversationHistoryEntry) => unknown;
  onDelete?: (entry: ConversationHistoryEntry) => void | Promise<void>;
  /** Conversation keys to hide (merged with optimistic deletes). */
  getExcludedConversationKeys?: () => ReadonlySet<number>;
  /** Maximum number of rows to render. */
  limit?: number;
  translate?: TranslateFn;
  log?: (...args: unknown[]) => void;
  resolveLabel?: (entry: ConversationHistoryEntry) => string;
  resolveScopeLabel?: (entry: ConversationHistoryEntry) => string;
  /** Names the runtime ("Codex", "Claude") on rows of those runtimes. */
  showRuntimeLabel?: boolean;
};

export const HISTORY_SEARCH_EMBEDDED_CLASS = "llm-standalone-search-embedded";

/**
 * Renders the history search list (day groups, scope chip, meta line,
 * highlighted preview) into a given container, with delegated click and
 * keyboard handling. The popup controller and embedded panels share it.
 */
export function createHistorySearchListView(
  deps: HistorySearchListViewDeps,
): HistorySearchListView {
  const results = deps.container;
  const input = deps.input || null;
  const doc = results.ownerDocument;
  const translate: TranslateFn = deps.translate || ((label) => label);
  const log = deps.log || (() => undefined);
  const disposeHistoryActivity = observeHistoryActivity(results);

  let active = false;
  let destroyed = false;
  let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let searchSeq = 0;
  let renderedEntriesByKey = new Map<number, ConversationHistoryEntry>();
  const hiddenConversationKeys = new Set<number>();

  const resolveHiddenKeys = (): ReadonlySet<number> => {
    let excluded: ReadonlySet<number> | null = null;
    try {
      excluded = deps.getExcludedConversationKeys?.() || null;
    } catch (err) {
      log("LLM: history search excluded keys failed", err);
    }
    return mergeHistorySearchHiddenKeys(hiddenConversationKeys, excluded);
  };

  const currentQuery = () => input?.value || "";

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
    if (getHistoryEntryLabelType(entry) === "orphan") {
      return translate("Orphan");
    }
    return entry.kind === "paper"
      ? entry.sectionTitle || translate("Paper chat")
      : translate("Library chat");
  };

  const resolveScopeLabel = (entry: ConversationHistoryEntry): string => {
    const value = deps.resolveScopeLabel?.(entry);
    if (value) return value;
    if (getHistoryEntryLabelType(entry) === "orphan") {
      return translate("Orphan");
    }
    return entry.kind === "paper"
      ? entry.sectionTitle || translate("Paper chat")
      : translate("Library chat");
  };

  const renderEntries = (
    unlimitedEntries: ConversationHistoryEntry[],
    query: string,
    searchResultsByKey = new Map<number, HistorySearchResult>(),
  ) => {
    const entries = limitHistorySearchListEntries(unlimitedEntries, deps.limit);
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
        item.dataset.conversationSystem = entry.system;

        const textWrap = createElement(
          doc,
          "div",
          "llm-standalone-search-text",
        );
        const label = createElement(doc, "span", "llm-standalone-search-label");
        label.dataset.labelType = getHistoryEntryLabelType(entry);
        const labelText = resolveLabel(entry);
        label.textContent = labelText;

        const title = createElement(doc, "span", "llm-standalone-search-title");
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

        textWrap.append(
          label,
          createHistoryActivityIndicator(
            doc,
            entry.conversationKey,
            translate("Working"),
          ),
          title,
        );
        const runtimeLabel = deps.showRuntimeLabel
          ? getHistoryRowRuntimeLabel(entry.system)
          : "";
        if (runtimeLabel) {
          textWrap.appendChild(
            createElement(doc, "span", "llm-history-runtime-label", {
              textContent: runtimeLabel,
            }),
          );
        }
        if (deps.onDelete && entry.deletable) {
          const deleteButton = createElement(
            doc,
            "span",
            HISTORY_SEARCH_POPUP_DELETE_CLASS,
          ) as HTMLSpanElement;
          deleteButton.setAttribute("role", "button");
          deleteButton.setAttribute("tabindex", "0");
          deleteButton.setAttribute(
            "aria-label",
            `${translate("Delete conversation")}: ${displayTitle}`,
          );
          deleteButton.title = translate("Delete conversation");
          deleteButton.dataset.action = "delete";
          textWrap.appendChild(deleteButton);
        }
        item.appendChild(textWrap);

        const scopeLabel = resolveScopeLabel(entry);
        const timestamp =
          formatGlobalHistoryTimestamp(entry.lastActivityAt) ||
          entry.timestampText ||
          "";
        const metaText = timestamp
          ? `${scopeLabel} \u00B7 ${timestamp}`
          : scopeLabel;
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
      const allEntries = filterHistorySearchPopupVisibleEntries(
        sortHistorySearchPopupEntries(await deps.loadEntries()),
        resolveHiddenKeys(),
      );
      if (thisSeq !== searchSeq || !active) return;

      if (!query.trim()) {
        renderEntries(allEntries, "");
        return;
      }

      const normalizedQuery = normalizeHistorySearchQuery(query);
      if (deps.searchEntries) {
        const indexed = await deps.searchEntries(query);
        if (thisSeq !== searchSeq || !active) return;
        const visibleIndexedEntries = filterHistorySearchPopupVisibleEntries(
          indexed.entries,
          resolveHiddenKeys(),
        );
        const visibleIndexedKeys = new Set(
          visibleIndexedEntries.map((entry) => entry.conversationKey),
        );
        const visibleResultsByKey = new Map(
          Array.from(indexed.resultsByKey.entries()).filter(([key]) =>
            visibleIndexedKeys.has(key),
          ),
        );
        renderEntries(visibleIndexedEntries, query, visibleResultsByKey);
        return;
      }
      const documents = new Map<number, HistorySearchDocument>();
      await Promise.all(
        allEntries.map(async (entry) => {
          if (thisSeq !== searchSeq || !active) return;
          try {
            documents.set(
              entry.conversationKey,
              await deps.loadDocument(entry),
            );
          } catch (err) {
            log("LLM: history search popup indexing failed", {
              conversationKey: entry.conversationKey,
              error: err,
            });
          }
        }),
      );
      if (thisSeq !== searchSeq || !active) return;

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

  const cancelDebounce = () => {
    if (searchDebounceTimer !== null) {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = null;
    }
  };

  const onInput = () => {
    if (!active) return;
    if (searchDebounceTimer !== null) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      searchDebounceTimer = null;
      void runSearch(currentQuery());
    }, 300);
  };

  const entryFromItem = (
    item: HTMLElement | null,
  ): ConversationHistoryEntry | null => {
    if (!item) return null;
    const conversationKey = Number.parseInt(
      item.dataset.conversationKey || "",
      10,
    );
    if (!Number.isFinite(conversationKey) || conversationKey <= 0) return null;
    return renderedEntriesByKey.get(conversationKey) || null;
  };

  const selectResultFromTarget = (target: Element | null): boolean => {
    const item = target?.closest(
      ".llm-standalone-search-item",
    ) as HTMLDivElement | null;
    const entry = entryFromItem(item);
    if (!entry) return false;
    try {
      void Promise.resolve(deps.onSelect(entry)).catch((err) => {
        log("LLM: history search popup selection failed", err);
      });
    } catch (err) {
      log("LLM: history search popup selection failed", err);
    }
    return true;
  };

  const deleteResultFromTarget = (target: Element | null): boolean => {
    if (!deps.onDelete) return false;
    const deleteButton = target?.closest(
      `.${HISTORY_SEARCH_POPUP_DELETE_CLASS}`,
    ) as HTMLElement | null;
    if (!deleteButton) return false;
    const item = deleteButton.closest(
      ".llm-standalone-search-item",
    ) as HTMLDivElement | null;
    const entry = entryFromItem(item);
    if (!entry || !entry.deletable) return false;
    const conversationKey = entry.conversationKey;
    hiddenConversationKeys.add(conversationKey);
    void runSearch(currentQuery());
    void Promise.resolve(deps.onDelete(entry))
      .then(() => {
        hiddenConversationKeys.delete(conversationKey);
        if (active) void runSearch(currentQuery());
      })
      .catch((err) => {
        hiddenConversationKeys.delete(conversationKey);
        if (active) void runSearch(currentQuery());
        log("LLM: history search popup deletion failed", err);
      });
    return true;
  };

  const onResultsClick = (event: Event) => {
    if (deleteResultFromTarget(event.target as Element | null)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!selectResultFromTarget(event.target as Element | null)) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const onResultsKeydown = (event: Event) => {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.key !== "Enter" && keyboardEvent.key !== " ") return;
    if (deleteResultFromTarget(event.target as Element | null)) {
      keyboardEvent.preventDefault();
      keyboardEvent.stopPropagation();
      return;
    }
    if (!selectResultFromTarget(event.target as Element | null)) return;
    keyboardEvent.preventDefault();
    keyboardEvent.stopPropagation();
  };

  input?.addEventListener("input", onInput);
  results.addEventListener("click", onResultsClick);
  results.addEventListener("keydown", onResultsKeydown);

  const view: HistorySearchListView = {
    element: results,
    input,
    refresh: (query?: string) => {
      if (destroyed) return;
      cancelDebounce();
      if (typeof query === "string" && input) input.value = query;
      active = true;
      void runSearch(typeof query === "string" ? query : currentQuery());
    },
    clear: () => {
      searchSeq += 1;
      active = false;
      cancelDebounce();
      if (input) input.value = "";
      clearResults();
      renderedEntriesByKey.clear();
    },
    isActive: () => active,
    destroy: () => {
      if (destroyed) return;
      view.clear();
      destroyed = true;
      disposeHistoryActivity();
      input?.removeEventListener("input", onInput);
      results.removeEventListener("click", onResultsClick);
      results.removeEventListener("keydown", onResultsKeydown);
    },
  };
  return view;
}

export type EmbeddedHistorySearchListDeps = Omit<
  HistorySearchListViewDeps,
  "container" | "input"
> & {
  parent: HTMLElement;
  /** Render a search box above the rows (default true). */
  showSearch?: boolean;
  /** Where the search box goes (default: above the rows, inside the list). */
  searchHost?: HTMLElement | null;
};

export type EmbeddedHistorySearchListView = HistorySearchListView & {
  /** Re-reads the surface and puts the popup's theme class on the list. */
  syncTheme: () => void;
};

/**
 * Builds an inline (non-overlay) history list inside `parent`, reusing the
 * popup's classes under the `llm-standalone-search-embedded` modifier and the
 * popup's theme class, so its chips take the popup's colours.
 * The returned view's `element` is the embedded root.
 */
export function createEmbeddedHistorySearchList(
  deps: EmbeddedHistorySearchListDeps,
): EmbeddedHistorySearchListView {
  const { parent, showSearch = true, searchHost, ...listDeps } = deps;
  const doc = parent.ownerDocument;
  const translate: TranslateFn = deps.translate || ((label) => label);
  const root = createElement(
    doc,
    "div",
    `llm-standalone-search-popup ${HISTORY_SEARCH_EMBEDDED_CLASS}`,
  );
  let input: HTMLInputElement | null = null;
  let header: HTMLElement | null = null;
  if (showSearch) {
    header = createElement(
      doc,
      "div",
      `llm-standalone-search-header ${HISTORY_SEARCH_EMBEDDED_CLASS}-field`,
    );
    const icon = createElement(
      doc,
      "span",
      "llm-standalone-nav-icon llm-standalone-nav-icon-search llm-standalone-search-icon",
    );
    icon.setAttribute("aria-hidden", "true");
    input = createElement(doc, "input", "llm-standalone-search-input", {
      type: "text",
      placeholder: translate("Search history"),
    }) as HTMLInputElement;
    input.setAttribute("autocomplete", "off");
    input.setAttribute("spellcheck", "false");
    input.setAttribute("aria-label", translate("Search history"));
    header.append(icon, input);
    // Clicking the field's padding or icon focuses the input.
    header.addEventListener("mousedown", (event: Event) => {
      if (event.target === input) return;
      event.preventDefault();
      input?.focus();
    });
    if (searchHost) searchHost.appendChild(header);
    else root.appendChild(header);
  }
  const results = createElement(doc, "div", "llm-standalone-search-results");
  root.appendChild(results);
  parent.appendChild(root);

  // The popup's theme class, resolved from the surface the list sits on
  // (the first opaque ancestor background), then the window's colours.
  const syncTheme = () => {
    const win = doc.defaultView;
    if (!win) return;
    const colors: string[] = [];
    for (
      let element: Element | null = parent;
      element && colors.length < 8;
      element = element.parentElement
    ) {
      colors.push(win.getComputedStyle(element)?.backgroundColor || "");
    }
    const rootStyle = doc.documentElement
      ? win.getComputedStyle(doc.documentElement)
      : null;
    colors.push(
      rootStyle?.getPropertyValue("--material-sidepane") || "",
      rootStyle?.getPropertyValue("--material-background") || "",
    );
    applyHistorySearchThemeClass(root, colors);
  };

  const view = createHistorySearchListView({
    ...listDeps,
    container: results,
    input,
  });
  return {
    ...view,
    element: root,
    refresh: (query?: string) => {
      syncTheme();
      view.refresh(query);
    },
    syncTheme,
    destroy: () => {
      view.destroy();
      header?.remove();
      root.remove();
    },
  };
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
  const searchPlaceholder =
    deps.searchPlaceholder || translate("Search history");
  const input = createElement(doc, "input", "llm-standalone-search-input", {
    type: "text",
    placeholder: searchPlaceholder,
  }) as HTMLInputElement;
  input.setAttribute("autocomplete", "off");
  input.setAttribute("spellcheck", "false");
  input.setAttribute("aria-label", searchPlaceholder);

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

  const syncThemeClass = () => {
    const win = doc.defaultView;
    const root = doc.documentElement;
    const body = doc.body;
    const parentStyle = win?.getComputedStyle(deps.parent);
    const popupStyle = win?.getComputedStyle(popup);
    const rootStyle = root ? win?.getComputedStyle(root) : null;
    const bodyStyle = body ? win?.getComputedStyle(body) : null;
    applyHistorySearchThemeClass(overlay, [
      popupStyle?.backgroundColor || "",
      parentStyle?.backgroundColor || "",
      parentStyle?.getPropertyValue("--material-sidepane") || "",
      parentStyle?.getPropertyValue("--material-background") || "",
      rootStyle?.getPropertyValue("--material-sidepane") || "",
      rootStyle?.getPropertyValue("--material-background") || "",
      bodyStyle?.backgroundColor || "",
    ]);
  };

  const listView = createHistorySearchListView({
    container: results,
    input,
    loadEntries: deps.loadEntries,
    loadDocument: deps.loadDocument,
    searchEntries: deps.searchEntries,
    onDelete: deps.onDelete,
    translate,
    log,
    resolveLabel: deps.resolveLabel,
    resolveScopeLabel: deps.resolveScopeLabel,
    showRuntimeLabel: deps.showRuntimeLabel,
    getExcludedConversationKeys: deps.getExcludedConversationKeys,
    onSelect: (entry) =>
      Promise.resolve(deps.onSelect(entry))
        .then((result) => {
          if (shouldCloseHistorySearchPopupAfterSelection(result)) {
            controller.close();
          }
        })
        .catch((err) => {
          log("LLM: history search popup selection failed", err);
        }),
  });

  const placePopup = (anchor: HTMLElement | null | undefined) => {
    if (!anchor) {
      overlay.classList.remove("llm-standalone-search-overlay-anchored");
      overlay.style.removeProperty("padding-top");
      return;
    }
    // The button sits among the actions at the right of its row, so the
    // popup opens under that row against the window's right edge (CSS) at
    // its full width; aligning it with the button left it a narrow strip.
    const rect = anchor.getBoundingClientRect();
    overlay.classList.add("llm-standalone-search-overlay-anchored");
    overlay.style.paddingTop = `${Math.round(rect.bottom + 4)}px`;
  };

  const controller: HistorySearchPopupController = {
    open: (options) => {
      placePopup(options?.anchor);
      overlay.style.display = "flex";
      syncThemeClass();
      listView.clear();
      input.focus();
      listView.refresh("");
    },
    close: () => {
      overlay.style.display = "none";
      listView.clear();
    },
    toggle: (options) => {
      if (controller.isOpen()) {
        controller.close();
      } else {
        controller.open(options);
      }
    },
    isOpen: () => overlay.style.display !== "none",
    destroy: () => {
      controller.close();
      listView.destroy();
      overlay.remove();
    },
  };

  closeButton.addEventListener("click", () => controller.close());
  overlay.addEventListener("click", (event: Event) => {
    if (event.target === overlay) controller.close();
  });
  input.addEventListener("keydown", (event: Event) => {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.key !== "Escape") return;
    keyboardEvent.preventDefault();
    controller.close();
  });

  return controller;
}
