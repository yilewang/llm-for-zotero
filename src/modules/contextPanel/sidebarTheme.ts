import { config } from "../../../package.json";

export const SIDEBAR_THEME_PREF = `${config.prefsPrefix}.sidebarTheme`;
export const SIDEBAR_CUSTOM_COLOR_PREF = `${config.prefsPrefix}.sidebarCustomColor`;
export const DEFAULT_SIDEBAR_CUSTOM_COLOR = "#c8edcc";

/** Accept only opaque RGB hex colors, never arbitrary CSS. */
export function normalizeSidebarCustomColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const hex = value.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{6}$/.test(hex)) return `#${hex}`;
  if (/^[0-9a-f]{3}$/.test(hex))
    return `#${Array.from(hex, (c) => c + c).join("")}`;
  return null;
}

export function getSidebarCustomColor(): string {
  try {
    return (
      normalizeSidebarCustomColor(
        Zotero.Prefs.get(SIDEBAR_CUSTOM_COLOR_PREF, true),
      ) || DEFAULT_SIDEBAR_CUSTOM_COLOR
    );
  } catch {
    return DEFAULT_SIDEBAR_CUSTOM_COLOR;
  }
}

/** Choose black or white by relative luminance for at least 4.5:1 contrast. */
export function sidebarCustomColorIsDark(color: string): boolean {
  const hex =
    normalizeSidebarCustomColor(color) || DEFAULT_SIDEBAR_CUSTOM_COLOR;
  const channels = [1, 3, 5].map((start) => {
    const value = parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return (
    channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722 < 0.179
  );
}

export const SIDEBAR_THEMES = {
  default: "Default (follow Zotero)",
  dark: "Dark",
  green: "Soft green",
  sepia: "Sepia",
  beanGreen: "Bean green",
  skyBlue: "Sky blue",
  grassGreen: "Grass green",
  custom: "Custom color",
} as const;
export type SidebarTheme = keyof typeof SIDEBAR_THEMES;

export function normalizeSidebarTheme(value: unknown): SidebarTheme {
  return typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(SIDEBAR_THEMES, value)
    ? (value as SidebarTheme)
    : "default";
}

export function getSidebarTheme(): SidebarTheme {
  try {
    return normalizeSidebarTheme(Zotero.Prefs.get(SIDEBAR_THEME_PREF, true));
  } catch {
    return "default";
  }
}

/** Observe once per host window; retained and newly created panels share it. */
export function installSidebarThemePreference(doc: Document): () => void {
  const root = doc.documentElement;
  const apply = () => {
    const theme = getSidebarTheme();
    const color = getSidebarCustomColor();
    root.style.setProperty(
      "--llm-custom-background",
      theme === "custom" ? color : "",
    );
    if (theme === "custom") {
      root.setAttribute(
        "data-llm-sidebar-theme",
        sidebarCustomColorIsDark(color) ? "custom-dark" : "custom-light",
      );
    } else if (theme === "default")
      root.removeAttribute("data-llm-sidebar-theme");
    else root.setAttribute("data-llm-sidebar-theme", theme);
  };
  apply();
  const prefs = typeof Zotero !== "undefined" ? Zotero.Prefs : undefined;
  const observers = [SIDEBAR_THEME_PREF, SIDEBAR_CUSTOM_COLOR_PREF].map((key) =>
    prefs?.registerObserver?.(key, apply, true),
  );
  return () => {
    for (const observer of observers) {
      if (observer !== undefined) prefs?.unregisterObserver?.(observer);
    }
    root.style.setProperty("--llm-custom-background", "");
    root.removeAttribute("data-llm-sidebar-theme");
  };
}
