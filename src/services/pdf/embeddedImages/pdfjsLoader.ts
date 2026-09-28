import type * as PdfjsNamespace from "pdfjs-dist";
import type { PDFPageProxy } from "pdfjs-dist";
import { appLogger } from "../../../core/logging";

export const PDFJS_MODULE_URL = "resource://zotero/reader/pdf/build/pdf.mjs";
export const PDFJS_WORKER_URL =
  "resource://zotero/reader/pdf/build/pdf.worker.mjs";
const PDFJS_WEB_URL = "resource://zotero/reader/pdf/web/";

/** The pdf.js module Zotero bundles; typed by the matching pdfjs-dist. */
export type PdfjsModule = typeof PdfjsNamespace;

export type PdfjsLoadStrategy = "main-window-import" | "chrome-utils";

export type LoadedPdfjs = { pdfjs: PdfjsModule; strategy: PdfjsLoadStrategy };

/**
 * Keeps pdf.js off font faces and OffscreenCanvas (raw pixel data comes back
 * for images) and points it at Zotero's bundled CMaps, fonts and decoders.
 */
export const PDFJS_DOCUMENT_OPTIONS = {
  isOffscreenCanvasSupported: false,
  isImageDecoderSupported: false,
  disableFontFace: true,
  isEvalSupported: false,
  useWorkerFetch: false,
  cMapUrl: `${PDFJS_WEB_URL}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${PDFJS_WEB_URL}standard_fonts/`,
  wasmUrl: `${PDFJS_WEB_URL}wasm/`,
  iccUrl: `${PDFJS_WEB_URL}iccs/`,
};

let loading: Promise<LoadedPdfjs> | null = null;

function isPdfjsModule(value: unknown): value is PdfjsModule {
  const mod = value as Partial<PdfjsModule> | null;
  return Boolean(
    mod &&
    typeof mod.getDocument === "function" &&
    mod.OPS &&
    mod.Util &&
    mod.GlobalWorkerOptions,
  );
}

async function importViaMainWindow(): Promise<unknown> {
  const win = Zotero.getMainWindow?.() as
    | (Window & { eval?: (code: string) => unknown })
    | undefined;
  if (!win?.eval) throw new Error("Zotero main window is unavailable");
  // Evaluated in the window realm: the plugin bundle itself never contains
  // import() syntax, which the subscript sandbox may reject at parse time.
  return await (win.eval(
    `import(${JSON.stringify(PDFJS_MODULE_URL)})`,
  ) as Promise<unknown>);
}

async function importViaChromeUtils(): Promise<unknown> {
  const chromeUtils = (
    globalThis as {
      ChromeUtils?: { importESModule?: (url: string) => unknown };
    }
  ).ChromeUtils;
  if (!chromeUtils?.importESModule) {
    throw new Error("ChromeUtils.importESModule is unavailable");
  }
  return chromeUtils.importESModule(PDFJS_MODULE_URL);
}

const STRATEGIES: Array<[PdfjsLoadStrategy, () => Promise<unknown>]> = [
  ["main-window-import", importViaMainWindow],
  ["chrome-utils", importViaChromeUtils],
];

/** Tries every strategy in order; reports each failure for diagnostics. */
export async function tryPdfjsStrategies(): Promise<{
  loaded?: LoadedPdfjs;
  errors: Record<string, string>;
}> {
  const errors: Record<string, string> = {};
  for (const [strategy, load] of STRATEGIES) {
    try {
      const mod = await load();
      if (!isPdfjsModule(mod)) {
        errors[strategy] =
          "module lacks getDocument/OPS/Util/GlobalWorkerOptions";
        continue;
      }
      mod.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      return { loaded: { pdfjs: mod, strategy }, errors };
    } catch (error) {
      errors[strategy] = error instanceof Error ? error.message : String(error);
    }
  }
  return { errors };
}

export function loadPdfjs(): Promise<LoadedPdfjs> {
  if (!loading) {
    const attempt = tryPdfjsStrategies().then(({ loaded, errors }) => {
      if (loaded) return loaded;
      appLogger.warn("[Embedded images] pdf.js could not be loaded", errors);
      throw new Error(`pdf.js could not be loaded: ${JSON.stringify(errors)}`);
    });
    loading = attempt;
    attempt.catch(() => {
      if (loading === attempt) loading = null;
    });
  }
  return loading;
}

/** Looks an image object up in the page pool, then the shared pool. */
export function resolvePdfjsImageObject(
  page: PDFPageProxy,
  objId: string,
): unknown {
  const pools = objId.startsWith("g_")
    ? [page.commonObjs, page.objs]
    : [page.objs, page.commonObjs];
  for (const pool of pools) {
    try {
      if (!pool || !pool.has(objId)) continue;
      const value = pool.get(objId);
      if (value) return value;
    } catch {
      // pdf.js throws when the object is not resolved in this pool.
    }
  }
  return null;
}
