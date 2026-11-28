import type { ReaderOverlayPalette } from "./readerOverlayShared";

/** The Inline Ask card's colors (the note editor's inline popup uses them
 *  too); the Add Text prompt keeps its own. */
export type InlineAskPalette = ReaderOverlayPalette & {
  /** Placeholder text. */
  tertiary: string;
  /** The send circle when a question can go, and its arrow. */
  sendBg: string;
  sendFg: string;
  /** The send circle while the field is empty or a turn runs. */
  sendOffBg: string;
  sendOffFg: string;
  menuBorder: string;
  cardShadow: string;
  menuShadow: string;
  floatShadow: string;
  /** The passage text at rest (the full color on hover and when open). */
  quoteRestFg: string;
  /** The quote line beside the passage. */
  quoteBar: string;
};

export function inlineAskPalette(dark: boolean): InlineAskPalette {
  return dark
    ? {
        bg: "#1e1e20",
        fg: "#ececee",
        border: "rgba(255,255,255,0.1)",
        fieldBg: "#2c2c2f",
        quoteFg: "#f4f4f6",
        labelFg: "#9a9aa0",
        fill2: "#9a9aa0",
        fill3: "#4a4a50",
        accent: "#0a84ff",
        accentTint: "rgba(10,132,255,0.16)",
        accentFg: "#ffffff",
        hover: "rgba(255,255,255,0.07)",
        tertiary: "#6c6c72",
        sendBg: "#ececee",
        sendFg: "#1e1e20",
        sendOffBg: "rgba(255,255,255,0.12)",
        sendOffFg: "#85858b",
        menuBorder: "rgba(255,255,255,0.12)",
        cardShadow: "0 4px 14px rgba(0,0,0,.38)",
        menuShadow: "0 8px 18px rgba(0,0,0,.24)",
        floatShadow: "0 12px 30px rgba(0,0,0,.5)",
        quoteRestFg: "rgba(244,244,246,0.7)",
        quoteBar: "rgba(255,255,255,0.17)",
      }
    : {
        bg: "#ffffff",
        fg: "#1f1f1f",
        border: "rgba(0,0,0,0.12)",
        fieldBg: "#f1f1f2",
        quoteFg: "#1a1a1a",
        labelFg: "#6b6b70",
        fill2: "#6b6b70",
        fill3: "#c4c4c8",
        accent: "#3478f6",
        accentTint: "rgba(52,120,246,0.1)",
        accentFg: "#ffffff",
        hover: "rgba(0,0,0,0.055)",
        tertiary: "#a2a2a7",
        sendBg: "#1f1f1f",
        sendFg: "#ffffff",
        sendOffBg: "rgba(0,0,0,0.09)",
        sendOffFg: "#8e8e93",
        menuBorder: "rgba(0,0,0,0.14)",
        cardShadow: "0 4px 14px rgba(0,0,0,.16)",
        menuShadow: "0 8px 18px rgba(0,0,0,.14)",
        floatShadow: "0 12px 30px rgba(0,0,0,.2)",
        quoteRestFg: "rgba(26,26,26,0.7)",
        quoteBar: "rgba(0,0,0,0.16)",
      };
}

/** A text button in the card: plain, ghost (no frame) or primary. */
export function inlineAskButtonCss(
  palette: InlineAskPalette,
  variant: "plain" | "ghost" | "primary",
  extra: string[] = [],
): string[] {
  const base = [
    "display:inline-flex",
    "align-items:center",
    "justify-content:center",
    "gap:5px",
    "padding:4px 9px",
    `border:1px solid ${palette.border}`,
    "border-radius:6px",
    `background:${palette.fieldBg}`,
    `color:${palette.fg}`,
    "white-space:nowrap",
    "font:inherit",
    "font-size:12px",
    "line-height:1.35",
    "cursor:pointer",
  ];
  if (variant === "ghost") {
    base.push(
      "background:transparent",
      "border-color:transparent",
      `color:${palette.labelFg}`,
    );
  }
  if (variant === "primary") {
    base.push(
      `background:${palette.accent}`,
      `border-color:${palette.accent}`,
      `color:${palette.accentFg}`,
    );
  }
  return [...base, ...extra];
}
