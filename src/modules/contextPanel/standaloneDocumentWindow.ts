import { config } from "../../../package.json";
import { HTML_NS } from "../../utils/domHelpers";
import { installStandaloneWindowTitlebar } from "./standaloneWindowTitlebar";

const WINDOW_FEATURES =
  "chrome,extrachrome,menubar,resizable,scrollbars,status,centerscreen,dialog=no,dependent=no";
const DEFAULT_DOCUMENT_FONT_SIZE_PX = 15.5;
const MIN_DOCUMENT_FONT_SCALE = 0.7;
const MAX_DOCUMENT_FONT_SCALE = 2;
const DOCUMENT_FONT_SCALE_STEP = 0.1;

const THEME_VARIABLES = [
  "--fill-primary",
  "--fill-secondary",
  "--fill-tertiary",
  "--fill-quaternary",
  "--fill-quinary",
  "--stroke-secondary",
  "--material-background",
  "--material-sidepane",
  "--color-accent",
] as const;

type OpenDialogWindow = Window & {
  openDialog?: (...args: unknown[]) => Window | null;
};

type StandaloneDocumentWindowOptions = {
  sourceDoc: Document;
  chromeDocument: string;
  windowName: string;
  rootId: string;
  title: string;
  minWidth?: number;
  minHeight?: number;
  render: (doc: Document, root: HTMLElement, targetWin: Window) => void;
  onInitializationFailure?: (error: unknown) => void;
};

const openDocumentWindows = new Map<string, Window>();

function installSourceTheme(sourceDoc: Document, targetDoc: Document): void {
  const sourceWin = sourceDoc.defaultView;
  if (!sourceWin) return;
  const computed = sourceWin.getComputedStyle(sourceDoc.documentElement);
  const variables = THEME_VARIABLES.map((name) => {
    const value = computed?.getPropertyValue(name).trim() || "";
    return value ? `${name}: ${value};` : "";
  })
    .filter(Boolean)
    .join("\n");
  if (!variables) return;
  const style = targetDoc.createElementNS(HTML_NS, "style") as HTMLStyleElement;
  style.textContent = `:root {\n${variables}\n}`;
  targetDoc.documentElement?.prepend(style);
}

function installAddonStylesheet(targetDoc: Document): void {
  const css = targetDoc.createElementNS(HTML_NS, "link") as HTMLLinkElement;
  css.rel = "stylesheet";
  css.type = "text/css";
  css.href = `chrome://${config.addonRef}/content/zoteroPane.css`;
  targetDoc.documentElement?.appendChild(css);
}

export function openStandaloneDocumentWindow(
  options: StandaloneDocumentWindowOptions,
): boolean {
  const existing = openDocumentWindows.get(options.windowName);
  if (existing && !existing.closed) {
    existing.focus();
    return true;
  }
  if (existing?.closed) openDocumentWindows.delete(options.windowName);

  const opener = options.sourceDoc.defaultView as OpenDialogWindow | null;
  if (!opener || typeof opener.openDialog !== "function") return false;
  const newWin = opener.openDialog(
    `chrome://${config.addonRef}/content/${options.chromeDocument}`,
    options.windowName,
    WINDOW_FEATURES,
  ) as Window | null;
  if (!newWin) return false;

  openDocumentWindows.set(options.windowName, newWin);
  newWin.addEventListener(
    "unload",
    () => {
      if (openDocumentWindows.get(options.windowName) === newWin) {
        openDocumentWindows.delete(options.windowName);
      }
    },
    { once: true },
  );

  let attempts = 0;
  let initialized = false;
  let documentFontScale = 1;
  const setDocumentFontScale = (scale: number) => {
    documentFontScale = Math.max(
      MIN_DOCUMENT_FONT_SCALE,
      Math.min(MAX_DOCUMENT_FONT_SCALE, Math.round(scale * 10) / 10),
    );
    const fontSize =
      Math.round(DEFAULT_DOCUMENT_FONT_SIZE_PX * documentFontScale * 100) / 100;
    newWin.document.documentElement?.style.setProperty(
      "--llm-document-font-size",
      `${fontSize}px`,
    );
  };
  const failInitialization = (error: unknown) => {
    if (initialized) return;
    initialized = true;
    if (openDocumentWindows.get(options.windowName) === newWin) {
      openDocumentWindows.delete(options.windowName);
    }
    try {
      newWin.close();
    } catch {
      // The failed chrome window may already be closing.
    }
    options.onInitializationFailure?.(error);
  };
  const tryInitialize = () => {
    if (initialized || newWin.closed) return;
    const doc = newWin.document;
    const root = doc.getElementById(options.rootId) as HTMLElement | null;
    if (!root) {
      attempts += 1;
      if (attempts < 40) {
        newWin.setTimeout(tryInitialize, 25);
      } else {
        failInitialization(new Error("Standalone document root was not found"));
      }
      return;
    }
    try {
      doc.title = options.title;
      doc.documentElement?.setAttribute(
        "minwidth",
        String(options.minWidth ?? 720),
      );
      doc.documentElement?.setAttribute(
        "minheight",
        String(options.minHeight ?? 520),
      );
      installSourceTheme(options.sourceDoc, doc);
      installAddonStylesheet(doc);
      installStandaloneWindowTitlebar(doc, doc.documentElement);
      setDocumentFontScale(1);
      options.render(doc, root, newWin);
      newWin.addEventListener(
        "keydown",
        (event: KeyboardEvent) => {
          if (event.metaKey || event.ctrlKey) {
            if (event.key === "+" || event.key === "=") {
              event.preventDefault();
              setDocumentFontScale(
                documentFontScale + DOCUMENT_FONT_SCALE_STEP,
              );
              return;
            }
            if (event.key === "-" || event.key === "_") {
              event.preventDefault();
              setDocumentFontScale(
                documentFontScale - DOCUMENT_FONT_SCALE_STEP,
              );
              return;
            }
            if (event.key === "0") {
              event.preventDefault();
              setDocumentFontScale(1);
              return;
            }
          }
          const closeShortcut =
            event.key === "Escape" ||
            ((event.metaKey || event.ctrlKey) && event.key === "w");
          if (!closeShortcut) return;
          event.preventDefault();
          newWin.close();
        },
        true,
      );
      initialized = true;
    } catch (error) {
      failInitialization(error);
    }
  };
  newWin.addEventListener("load", tryInitialize, { once: true });
  newWin.setTimeout(tryInitialize, 0);
  return true;
}
