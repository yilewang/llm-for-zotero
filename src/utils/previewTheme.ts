/**
 * The one owner of how model drawings (```svg) and web pages (```html) meet
 * the light and dark themes.
 *
 * A source that colors itself with the named theme colors (`var(--llm-...)`)
 * and paints no fixed white background is "themed": it gets the colors of the
 * current theme and sits on the panel. Any other source is drawn for a white
 * page, so it is shown on a white card ("paper") in every theme. A paper
 * source that uses the names still gets the light sheet so they resolve.
 */

/** Where a preview sits: on a white card, or on the themed panel. */
export type PreviewSurface = "paper" | "themed";

/** The element attribute that records a preview's surface. */
export const PREVIEW_SURFACE_ATTRIBUTE = "data-llm-preview-surface";

/** The attribute that records which theme a themed preview is drawn in. */
export const PREVIEW_THEME_ATTRIBUTE = "data-llm-preview-theme";

/**
 * A source needs the theme sheet when it uses a named color and declares none
 * itself: a page that sets its own `--llm-text: #111` was drawn for its own
 * background.
 */
export function needsPreviewThemeSheet(source: string): boolean {
  const text = source || "";
  if (!/var\(\s*--llm-/i.test(text)) return false;
  return !/--llm-[\w-]+\s*:/i.test(text);
}

const LIGHT_PAINT = "(?:white|#f{3}|#f{6}|#fefefe|#fafafa)(?![\\w-])";
const FIXED_LIGHT_BACKGROUND = new RegExp(
  `<rect\\b[^>]*?\\bfill\\s*[=:]\\s*["']?\\s*${LIGHT_PAINT}|background(?:-color)?\\s*:\\s*${LIGHT_PAINT}`,
  "i",
);

/** A white (or near-white) rect or CSS background: drawn for a white page. */
export function paintsLightBackground(source: string): boolean {
  return FIXED_LIGHT_BACKGROUND.test(source || "");
}

/**
 * Themed means it needs the sheet and paints no fixed light background. A
 * source that mixes both styles stays on paper, with the light sheet.
 */
export function usesPreviewTheme(source: string): boolean {
  return needsPreviewThemeSheet(source) && !paintsLightBackground(source);
}

export function previewSurfaceFor(source: string): PreviewSurface {
  return usesPreviewTheme(source) ? "themed" : "paper";
}

/** The two app themes a preview can follow. */
export type PreviewThemeKey = "light" | "dark";

/**
 * The theme a preview is drawn in: a paper source always uses the light
 * theme (and opens on the white viewer), a themed one follows the app.
 */
export function previewThemeFor(
  source: string,
  themeKey: PreviewThemeKey,
): PreviewThemeKey {
  return usesPreviewTheme(source) ? themeKey : "light";
}

/** The named colors, used as `var(--llm-<name>)`. The prompt lists them. */
export const PREVIEW_COLOR_NAMES = [
  "text",
  "muted",
  "bg",
  "line",
  "blue",
  "green",
  "red",
  "amber",
  "purple",
  "gray",
] as const;

export type PreviewColorName = (typeof PREVIEW_COLOR_NAMES)[number];

/** Each value reads as a line or as text on its theme's background. */
export const PREVIEW_THEME_COLORS: Record<
  PreviewThemeKey,
  Record<PreviewColorName, string>
> = {
  light: {
    text: "#1f2937",
    muted: "#6b7280",
    bg: "#ffffff",
    line: "#d1d5db",
    blue: "#2563eb",
    green: "#15803d",
    red: "#dc2626",
    amber: "#b45309",
    purple: "#7c3aed",
    gray: "#737373",
  },
  dark: {
    text: "#e5e7eb",
    muted: "#9ca3af",
    bg: "#1e1e1e",
    line: "#4b5563",
    blue: "#60a5fa",
    green: "#4ade80",
    red: "#f87171",
    amber: "#fbbf24",
    purple: "#c4b5fd",
    gray: "#a3a3a3",
  },
};

/**
 * The one prompt sentence about colors. It sits in the cached prompt prefix:
 * keep it short, and keep its names equal to PREVIEW_COLOR_NAMES (tested).
 */
export const PREVIEW_COLOR_INSTRUCTION =
  'Color SVG and HTML only with currentColor or var(--llm-NAME), NAME = text, muted, bg, line, blue, green, red, amber, purple, gray (style="stroke:var(--llm-blue)"), not fixed colors like #333, so it reads in light and dark.';

function themeDeclarations(theme: PreviewThemeKey): string {
  const colors = PREVIEW_THEME_COLORS[theme];
  return [
    `color-scheme:${theme}`,
    ...PREVIEW_COLOR_NAMES.map((name) => `--llm-${name}:${colors[name]}`),
    "color:var(--llm-text)",
  ].join(";");
}

/** The attribute on a themed drawing's root that its sheet is scoped to. */
export const SVG_THEME_ATTRIBUTE = "data-llm-theme";

/**
 * The sheet inside a themed drawing. It is scoped to the drawing's root, so it
 * also holds when the drawing is placed inline in a chrome document. Text and
 * shapes without a fill take the text color; fills and strokes the model set
 * are kept.
 */
export function buildSvgPreviewThemeCss(theme: PreviewThemeKey): string {
  const root = `svg[${SVG_THEME_ATTRIBUTE}="${theme}"]`;
  return `${root}{${themeDeclarations(theme)}}${root}:not([fill]){fill:currentColor}`;
}

/** The root tag; a quoted attribute value may hold a `>`. */
const SVG_OPENING_TAG = /<svg\b(?:"[^"]*"|'[^']*'|[^>"'])*>/i;

/** A themed drawing: the sheet goes first inside it, before the model's content. */
export function applySvgPreviewTheme(
  svg: string,
  theme: PreviewThemeKey,
): string {
  const opening = svg.match(SVG_OPENING_TAG);
  if (!opening || opening.index === undefined) return svg;
  if (/\/\s*>$/.test(opening[0])) return svg;
  const nextOpening = opening[0].replace(
    /^<svg\b/i,
    `<svg ${SVG_THEME_ATTRIBUTE}="${theme}"`,
  );
  const end = opening.index + opening[0].length;
  return `${svg.slice(0, opening.index)}${nextOpening}<style>${buildSvgPreviewThemeCss(theme)}</style>${svg.slice(end)}`;
}

/**
 * A drawing leaving the plugin (PNG copy and save, note images): the light
 * sheet when themed, on white, so it reads anywhere. A background the model
 * set on the root still wins.
 */
export function buildSvgExportMarkup(svg: string): string {
  const themed = needsPreviewThemeSheet(svg)
    ? applySvgPreviewTheme(svg, "light")
    : svg;
  return themed.replace(SVG_OPENING_TAG, (opening) => {
    const styled = opening.replace(
      /\sstyle\s*=\s*(["'])([\s\S]*?)\1/i,
      (_match, quote: string, value: string) =>
        ` style=${quote}background:#ffffff;${value}${quote}`,
    );
    if (styled !== opening) return styled;
    return opening.replace(/^<svg\b/i, '<svg style="background:#ffffff"');
  });
}

/**
 * The sheet a page's frame gets right after the CSP meta. A paper page only
 * learns it is on a white card; a themed page gets the colors. The model's
 * own rules come later, so they win.
 */
export function buildHtmlPreviewThemeSheet(
  theme: PreviewThemeKey,
  surface: PreviewSurface,
  withColors: boolean = surface === "themed",
): string {
  if (surface === "paper") {
    // A paper page that uses the names still needs them to resolve (light).
    return withColors
      ? `<style>:root{${themeDeclarations("light")}}</style>`
      : "<style>:root{color-scheme:light}</style>";
  }
  return `<style>:root{${themeDeclarations(theme)}}body{background:transparent}</style>`;
}
