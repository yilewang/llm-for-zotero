/**
 * Preferences, sync state, export and citation formatting: the surfaces that
 * read or change Zotero's own configuration rather than the library's
 * contents, plus the two paths that hand items to Zotero's translator and CSL
 * engines.
 *
 * Split out of `zoteroGateway.ts`. The capability never names the facade: the
 * item lookup the export and citation paths used to reach through `this`
 * arrives as a constructor dependency, so a caller (or a test) that supplies
 * its own lookup gets exactly the behaviour it asked for.
 */

import { AGENT_WRITABLE_PREFS } from "./internal/metadataTables";
import { normalizeText } from "./internal/normalize";

/**
 * What the settings, export and citation paths need from the rest of the
 * gateway.
 *
 * `getItem` is the facade's own resolver rather than the free function in
 * `internal/itemResolution.ts` on purpose: the facade passes a thunk that
 * calls its method, so an instance-level override still steers which items an
 * export or a bibliography is built from.
 */
export type SettingsCapabilityDeps = {
  getItem(itemId: number | undefined): Zotero.Item | null;
};

/**
 * One work a structured citation cluster cites: a Zotero item by its id, or
 * an outside paper's CSL item by its CSL id.
 */
export type StructuredCitationItem =
  | { itemId: number; pageIndex?: number }
  | { outsideId: string };

/**
 * A CSL-JSON item formatted beside the library's items. Its id is never all
 * digits (Zotero items' CSL ids are) and never contains "/".
 */
export type OutsideCslItem = Readonly<{ id: string }> &
  Readonly<Record<string, unknown>>;

/** A bibliography entry, paired with its Zotero item or outside CSL item. */
export type StructuredBibliographyEntry =
  | { itemId: number; text: string; html: string }
  | { outsideId: string; text: string; html: string };

type CiteProcEngine = {
  free?: () => void;
  sys?: { retrieveItem?: (id: string | number) => unknown };
  updateItems?: (ids: Array<number | string>) => void;
  previewCitationCluster?: (
    citation: unknown,
    citationsPre: Array<[string, number]>,
    citationsPost: Array<[string, number]>,
    format: string,
  ) => string;
  makeBibliography?: () =>
    | [{ entry_ids?: Array<Array<string | number>> }, string[]]
    | false;
};

export class SettingsCapability {
  constructor(private readonly deps: SettingsCapabilityDeps) {}

  /** Reads the preferences the agent is allowed to see. */
  listSettings(): Array<{
    key: string;
    value: unknown;
    type: string;
    description: string;
  }> {
    const prefs = (
      Zotero as unknown as { Prefs?: { get?: (key: string) => unknown } }
    ).Prefs;
    return Object.entries(AGENT_WRITABLE_PREFS).map(([key, spec]) => {
      let value: unknown = undefined;
      try {
        value = prefs?.get?.(key);
      } catch {
        // An unset pref reads as undefined rather than failing the listing.
      }
      return { key, value, type: spec.type, description: spec.description };
    });
  }

  getSettingNativeState(key: string): { exists: boolean; value: unknown } {
    const setting = this.listSettings().find((entry) => entry.key === key);
    return setting
      ? { exists: true, value: setting.value }
      : { exists: false, value: undefined };
  }

  /** Restore an allowlisted preference without applying user-input coercion. */
  restoreSetting(params: {
    key: string;
    existed: boolean;
    value?: unknown;
  }): void {
    if (!AGENT_WRITABLE_PREFS[params.key]) {
      throw new Error(`Preference "${params.key}" is not agent-writable`);
    }
    const prefs = (
      Zotero as unknown as {
        Prefs?: {
          set?: (key: string, value: unknown) => void;
          clear?: (key: string) => void;
        };
      }
    ).Prefs;
    if (params.existed) {
      if (typeof prefs?.set !== "function") {
        throw new Error("Zotero.Prefs.set is unavailable");
      }
      prefs.set(params.key, params.value);
      return;
    }
    if (typeof prefs?.clear !== "function") {
      throw new Error(
        "Zotero.Prefs.clear is unavailable; an originally unset preference cannot be restored safely",
      );
    }
    prefs.clear(params.key);
  }

  /**
   * Writes one allowlisted preference.
   *
   * Anything outside the allowlist is refused by name. `Zotero.Prefs` also
   * holds sync credentials, the data directory and proxy settings, and an
   * agent that can rewrite those can lock a user out of their own library.
   */
  async updateSetting(params: { key: string; value: unknown }): Promise<{
    key: string;
    previousValue: unknown;
    value: unknown;
    status: "updated" | "unchanged" | "refused";
    reason?: string;
  }> {
    const spec = AGENT_WRITABLE_PREFS[params.key];
    if (!spec) {
      return {
        key: params.key,
        previousValue: undefined,
        value: params.value,
        status: "refused",
        reason: `"${params.key}" is not a preference the agent may change. The ones it may are listed by library_settings with action:'list'.`,
      };
    }
    const prefs = (
      Zotero as unknown as {
        Prefs?: {
          get?: (key: string) => unknown;
          set?: (key: string, value: unknown) => void;
        };
      }
    ).Prefs;
    if (!prefs?.set) {
      return {
        key: params.key,
        previousValue: undefined,
        value: params.value,
        status: "refused",
        reason: "Zotero.Prefs is not available in this build",
      };
    }

    let coerced: unknown = params.value;
    if (spec.type === "boolean") coerced = Boolean(params.value);
    else if (spec.type === "number") {
      const numeric = Number(params.value);
      if (!Number.isFinite(numeric)) {
        return {
          key: params.key,
          previousValue: prefs.get?.(params.key),
          value: params.value,
          status: "refused",
          reason: `"${params.key}" expects a number`,
        };
      }
      coerced = numeric;
    } else coerced = String(params.value ?? "");

    const previousValue = prefs.get?.(params.key);
    if (previousValue === coerced) {
      return {
        key: params.key,
        previousValue,
        value: coerced,
        status: "unchanged",
      };
    }
    prefs.set(params.key, coerced);
    return {
      key: params.key,
      previousValue,
      value: coerced,
      status: "updated",
    };
  }

  /** Sync state, and a way to start one. */
  getSyncStatus(): {
    configured: boolean;
    username?: string;
    lastSyncAt?: number;
    inProgress: boolean;
  } {
    const sync = Zotero as unknown as {
      Sync?: {
        Runner?: { syncInProgress?: boolean; lastSyncStatus?: string };
      };
      Users?: { getCurrentUsername?: () => string };
      Prefs?: { get?: (key: string) => unknown };
    };
    let username: string | undefined;
    try {
      username = sync.Users?.getCurrentUsername?.() || undefined;
    } catch {
      username = undefined;
    }
    return {
      configured: Boolean(username),
      username,
      inProgress: Boolean(sync.Sync?.Runner?.syncInProgress),
    };
  }

  /** The export formats Zotero can write. */
  listExportFormats(): Array<{ id: string; label: string }> {
    const translators = (
      Zotero as unknown as {
        Translators?: {
          getAllForType?: (
            type: string,
          ) => Promise<Array<{ translatorID: string; label: string }>>;
        };
      }
    ).Translators;
    void translators;
    // Deliberately synchronous and static: the async translator listing is a
    // separate call shape, and these are the formats users actually name.
    return [
      { id: "14763d24-8ba0-45df-8f52-b8d1108e7ac9", label: "BibTeX" },
      { id: "9cb70025-a888-4a29-a210-93ec52da40d4", label: "BibLaTeX" },
      { id: "32d59d2d-b65a-4da4-b0a3-bdd3cfb979e7", label: "RIS" },
      { id: "bc03b4fe-436d-4a1f-ba59-de4d2d7a63f7", label: "CSL JSON" },
      { id: "14763d25-8ba0-45df-8f52-b8d1108e7ac9", label: "Zotero RDF" },
      { id: "b8f9f5e6-b6a9-4b0e-a3f0-9e29ff9e14cf", label: "Simple Evernote" },
    ];
  }

  /**
   * Exports items through a Zotero translator.
   *
   * All export was unreachable: the census found the whole domain at zero
   * covered operations, so "give me these as BibTeX" had no path.
   */
  async exportItems(params: {
    itemIds: number[];
    translatorId: string;
  }): Promise<{ output: string; itemCount: number }> {
    const TranslateExport = (
      Zotero as unknown as {
        Translate?: { Export?: new () => unknown };
      }
    ).Translate?.Export;
    if (!TranslateExport) {
      throw new Error("Zotero.Translate.Export is not available in this build");
    }
    const items = params.itemIds
      .map((itemId) => this.deps.getItem(itemId))
      .filter((item): item is Zotero.Item => Boolean(item));
    if (!items.length) {
      throw new Error("None of those item IDs resolved to an item.");
    }

    const translation = new TranslateExport() as {
      setItems: (items: unknown[]) => void;
      setTranslator: (id: string) => void;
      setHandler: (
        event: string,
        handler: (...args: unknown[]) => void,
      ) => void;
      translate: () => void;
      string?: string;
    };
    translation.setItems(items);
    translation.setTranslator(params.translatorId);

    return new Promise((resolve, reject) => {
      translation.setHandler("done", (_obj: unknown, worked: unknown) => {
        if (!worked) {
          reject(
            new Error(
              `Zotero could not export with translator ${params.translatorId}.`,
            ),
          );
          return;
        }
        resolve({
          output: String(translation.string || ""),
          itemCount: items.length,
        });
      });
      try {
        translation.translate();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** The citation styles installed in Zotero. */
  listCitationStyles(): Array<{ id: string; title: string }> {
    const styles = (
      Zotero as unknown as {
        Styles?: {
          getVisible?: () => Array<{ styleID: string; title: string }>;
          getAll?: () => Record<string, { styleID: string; title: string }>;
        };
      }
    ).Styles;
    try {
      const visible = styles?.getVisible?.();
      if (visible?.length) {
        return visible.map((style) => ({
          id: String(style.styleID),
          title: normalizeText(style.title),
        }));
      }
      return Object.values(styles?.getAll?.() || {}).map((style) => ({
        id: String(style.styleID),
        title: normalizeText(style.title),
      }));
    } catch {
      return [];
    }
  }

  /**
   * Formats citations or a bibliography through Zotero's own CSL engine.
   *
   * The most dangerous everyday gap in the whole census: asked for "the APA
   * reference for this paper" the agent had no tool at all, so it produced a
   * plausible-looking citation from memory. A fabricated reference is worse
   * than a refusal in a reference manager, and it is the one thing this
   * product exists to get right.
   */
  formatBibliography(params: {
    itemIds: number[];
    styleId?: string;
    locale?: string;
    format?: "text" | "html";
    mode?: "bibliography" | "citation";
  }): {
    styleId: string;
    styleTitle: string;
    output: string;
    format: "text" | "html";
    itemCount: number;
  } {
    const Styles = (
      Zotero as unknown as {
        Styles?: {
          get?: (id: string) => unknown;
          getVisible?: () => Array<{ styleID: string; title: string }>;
        };
      }
    ).Styles;
    const Cite = (
      Zotero as unknown as {
        Cite?: {
          makeFormattedBibliographyOrCitationList?: (
            engine: unknown,
            items: unknown[],
            format: string,
          ) => string;
        };
      }
    ).Cite;
    if (!Styles?.get || !Cite?.makeFormattedBibliographyOrCitationList) {
      throw new Error(
        "Zotero's citation engine is not available in this build, so a citation cannot be formatted. Do not write one from memory.",
      );
    }

    const styleId =
      params.styleId ||
      String(
        (
          Zotero as unknown as {
            Prefs?: { get?: (key: string) => unknown };
          }
        ).Prefs?.get?.("export.quickCopy.setting") || "",
      ).replace(/^bibliography(?:\/[^/]*)?=/, "") ||
      "http://www.zotero.org/styles/apa";

    const style = Styles.get(styleId) as {
      title?: string;
      getCiteProc?: (
        locale: string,
        format: string,
        options?: { cache?: boolean },
      ) => {
        free?: () => void;
        updateItems?: (ids: number[]) => void;
        previewCitationCluster?: (
          citation: unknown,
          a: unknown[],
          b: unknown[],
          format: string,
        ) => string;
      };
    } | null;
    if (!style?.getCiteProc) {
      throw new Error(
        `Citation style "${styleId}" is not installed. List the available ones with library_search({ entity:'citationStyles', mode:'list' }).`,
      );
    }

    const items = params.itemIds
      .map((itemId) => this.deps.getItem(itemId))
      .filter((item): item is Zotero.Item => Boolean(item))
      .filter((item) => !item.isNote?.());
    if (!items.length) {
      throw new Error("None of those item IDs resolved to a citable item.");
    }

    const outputFormat = params.format === "html" ? "html" : "text";
    const locale = params.locale || "en-US";
    const engine = style.getCiteProc(locale, outputFormat, { cache: true });
    try {
      if (params.mode === "citation") {
        engine.updateItems?.(items.map((item) => Number(item.id)));
        const output =
          engine.previewCitationCluster?.(
            {
              citationItems: items.map((item) => ({ id: item.id })),
              properties: {},
            },
            [],
            [],
            outputFormat,
          ) || "";
        return {
          styleId,
          styleTitle: normalizeText(style.title) || styleId,
          output,
          format: outputFormat,
          itemCount: items.length,
        };
      }
      const output =
        Cite.makeFormattedBibliographyOrCitationList(
          engine,
          items,
          outputFormat,
        ) || "";
      return {
        styleId,
        styleTitle: normalizeText(style.title) || styleId,
        output,
        format: outputFormat,
        itemCount: items.length,
      };
    } finally {
      engine.free?.();
    }
  }

  /**
   * Formats document citation clusters and keeps bibliography entries paired
   * with their Zotero items. Unlike formatBibliography(), this preserves the
   * structure needed for source navigation and multi-surface serialization.
   *
   * Outside papers (`outsideItems`, cited by `outsideId`) are formatted in
   * the same engine run, so the bibliography is one list in the style's
   * order. They need an engine of their own: the cached engine is shared
   * per style and locale, so its item lookup is never wrapped.
   */
  formatStructuredCitations(params: {
    clusters: Array<{
      citationId: string;
      items: StructuredCitationItem[];
    }>;
    outsideItems?: readonly OutsideCslItem[];
    styleId?: string;
    locale?: string;
  }): {
    styleId: string;
    styleTitle: string;
    locale: string;
    clusters: Array<{ citationId: string; text: string; html: string }>;
    bibliographyEntries: StructuredBibliographyEntry[];
  } {
    const Styles = (
      Zotero as unknown as {
        Styles?: { get?: (id: string) => unknown };
      }
    ).Styles;
    if (!Styles?.get) {
      throw new Error("Zotero's citation style registry is unavailable");
    }
    const styleId =
      params.styleId ||
      String(
        (
          Zotero as unknown as {
            Prefs?: { get?: (key: string) => unknown };
          }
        ).Prefs?.get?.("export.quickCopy.setting") || "",
      ).replace(/^bibliography(?:\/[^/]*)?=/, "") ||
      "http://www.zotero.org/styles/apa";
    const locale = params.locale || "en-US";
    const style = Styles.get(styleId) as {
      title?: string;
      getCiteProc?: (
        locale: string,
        format: string,
        options?: { cache?: boolean },
      ) => CiteProcEngine;
    };
    if (!style?.getCiteProc) {
      throw new Error(`Citation style "${styleId}" is not installed`);
    }
    const itemIds = Array.from(
      new Set(
        params.clusters.flatMap((cluster) =>
          cluster.items.flatMap((item) =>
            "itemId" in item ? [Number(item.itemId)] : [],
          ),
        ),
      ),
    ).filter((itemId) => Number.isInteger(itemId) && itemId > 0);
    const outsideById = new Map(
      (params.outsideItems || []).map((item) => [String(item.id), item]),
    );
    for (const id of outsideById.keys()) {
      // A digit-only id is a Zotero item's; a "/" breaks citeproc's ids.
      if (!id || /^\d+$/.test(id) || id.includes("/")) {
        throw new Error(`Outside citation item id "${id}" is invalid`);
      }
    }
    const outsideIds = Array.from(
      new Set(
        params.clusters.flatMap((cluster) =>
          cluster.items.flatMap((item) =>
            "outsideId" in item ? [String(item.outsideId)] : [],
          ),
        ),
      ),
    );
    for (const id of outsideIds) {
      if (!outsideById.has(id)) {
        throw new Error(`Outside citation item "${id}" was not supplied`);
      }
    }
    if (!itemIds.length && !outsideIds.length) {
      throw new Error("A structured citation bundle requires citable items");
    }
    const citeProc = (outputFormat: "text" | "html"): CiteProcEngine => {
      if (!outsideIds.length)
        return style.getCiteProc!(locale, outputFormat, { cache: true });
      const engine = style.getCiteProc!(locale, outputFormat, {
        cache: false,
      });
      const sys = engine.sys;
      const retrieveItem = sys?.retrieveItem;
      if (!sys || typeof retrieveItem !== "function") {
        engine.free?.();
        throw new Error(
          "Zotero's citation engine cannot format papers outside the library",
        );
      }
      // citeproc asks for every id as a string; each answer is a fresh copy
      // because the engine annotates the items it is given.
      sys.retrieveItem = (id: string | number) => {
        const outside = outsideById.get(String(id));
        return outside
          ? JSON.parse(JSON.stringify(outside))
          : retrieveItem.call(sys, id);
      };
      return engine;
    };
    const format = (outputFormat: "text" | "html") => {
      const engine = citeProc(outputFormat);
      try {
        engine.updateItems?.(
          outsideIds.length ? [...itemIds, ...outsideIds] : itemIds,
        );
        const clusters = params.clusters.map((cluster) => {
          const output =
            engine.previewCitationCluster?.(
              {
                citationID: cluster.citationId,
                citationItems: cluster.items.map((item) =>
                  "outsideId" in item
                    ? { id: item.outsideId }
                    : {
                        id: item.itemId,
                        ...(typeof item.pageIndex === "number"
                          ? {
                              locator: String(item.pageIndex + 1),
                              label: "page",
                            }
                          : {}),
                      },
                ),
                properties: { noteIndex: 0 },
              },
              // previewCitationCluster() does not register the previewed
              // citation in citeproc's citation registry. Passing an earlier
              // preview as citationsPre therefore makes Zotero look up a
              // citation that does not exist and crashes on citationItems.
              // Document clusters are serialized independently, so preview
              // each one without synthetic prior/post citation IDs.
              [],
              [],
              outputFormat,
            ) || "";
          return { citationId: cluster.citationId, output };
        });
        const bibliography = engine.makeBibliography?.();
        if (!bibliography) {
          throw new Error(
            `Citation style "${styleId}" did not produce a bibliography`,
          );
        }
        const [metadata, entries] = bibliography;
        const entryIds = metadata.entry_ids || [];
        // Entries pair by their CSL id as a string: a Zotero item's digits,
        // or an outside item's own id.
        const bibliographyEntries = entries.map((output, index) => ({
          id: String(entryIds[index]?.[0] ?? ""),
          output,
        }));
        const expected = new Set([...itemIds.map(String), ...outsideIds]);
        if (
          bibliographyEntries.length !== expected.size ||
          bibliographyEntries.some((entry) => !expected.has(entry.id))
        ) {
          throw new Error(
            "Zotero's citation engine returned an unresolvable bibliography",
          );
        }
        return { clusters, bibliographyEntries };
      } finally {
        engine.free?.();
      }
    };
    const textOutput = format("text");
    const htmlOutput = format("html");
    const htmlClusters = new Map(
      htmlOutput.clusters.map((cluster) => [
        cluster.citationId,
        cluster.output,
      ]),
    );
    const htmlEntries = new Map(
      htmlOutput.bibliographyEntries.map((entry) => [entry.id, entry.output]),
    );
    return {
      styleId,
      styleTitle: normalizeText(style.title) || styleId,
      locale,
      clusters: textOutput.clusters.map((cluster) => ({
        citationId: cluster.citationId,
        text: cluster.output,
        html: htmlClusters.get(cluster.citationId) || cluster.output,
      })),
      bibliographyEntries: textOutput.bibliographyEntries.map((entry) => {
        const html = htmlEntries.get(entry.id) || entry.output;
        return outsideById.has(entry.id)
          ? { outsideId: entry.id, text: entry.output, html }
          : { itemId: Number(entry.id), text: entry.output, html };
      }),
    };
  }
}
