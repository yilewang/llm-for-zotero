/**
 * The Inline Ask card: a floating box in the reader document where the user
 * asks about the selected text without opening the sidebar.
 *
 * Compose, top to bottom: the passage header (a grey quote line, then a
 * "Creator, year:" label and the selected text in the reader's serif; the
 * text is dimmer until the pointer is over it; three lines, a click shows
 * all of it; it stays put while the thread scrolls), the quick prompts as plain grey words, and one
 * filled composer box. The box holds the question field on its top line and,
 * on its bottom line, the model and effort buttons (left), the More button
 * and the send arrow (right). The More menu sets the text size of the whole
 * card (90 to 135 percent; Cmd/Ctrl with + - 0 does the same). The key hints are the field's tooltip. After a question the header
 * shrinks to two lines and the thread follows: the question in a bubble on
 * the right and the streamed answer. Under the latest answer sit quiet
 * message actions (Save as annotation, Continue in sidebar, Discard), and
 * the same composer box takes a follow-up.
 *
 * Save as annotation switches the card to an annotation card: the color
 * square (a click shows Zotero's eight colors), the page, the selected text
 * highlighted in that color, and the last answer as an editable plain-text
 * comment, with Cancel and Save. Escape, Back or Cancel return to the
 * answer; Mod+Enter saves. A failed save keeps the card and its payload, so
 * Save retries the same payload.
 *
 * Continue in sidebar hands the finished turns to the sidebar; the card
 * closes when the sidebar took them, and otherwise shows the reason under
 * the message actions and keeps its conversation.
 *
 * Quick prompts: right-clicking a word opens Edit, Delete, Add and Reset;
 * right-clicking the empty space of the row opens Add and Reset. Edit and
 * Add open a floating editor over the card (just under the row; Label is an
 * <input type=text>, Prompt a contenteditable box) with Cancel and Save;
 * Enter in Label or Mod+Enter in Prompt saves, Escape or a click outside the
 * editor cancels. Every change is saved at once.
 *
 * Model line: clicking the model opens the API models grouped by provider
 * (with a short note first when the sidebar's runtime cannot run here);
 * clicking the effort opens the levels the model offers. A pick is Inline
 * Ask's own choice; the next question uses it. Escape closes an open menu
 * first; text typed in the field stays.
 *
 * Close policy: before the first question an outside pointerdown closes the
 * card, as the Add Text prompt does. Once a question exists, only Escape,
 * Discard, or another overlay on the same document closes it; a new text
 * selection popup leaves it open (keepsOpenOnNewSelection).
 *
 * Width: DEFAULT_CARD_WIDTH, a reading measure. When the card replaces the
 * native popup it is centered on the popup.
 *
 * Inline styles only: plugin CSS does not reach reader documents. The card
 * has its own palette (inlineAskPalette), separate from the Add Text prompt.
 */
import {
  inlineAskAnswerToPlainText,
  renderInlineAskAnswer,
} from "./inlineAskAnswerRender";
import type { InlineAskModelMenuGroup } from "./inlineAskModel";
import type {
  InlineAskPromptEditing,
  InlineAskQuickPrompt,
} from "./inlineAskPrompts";
import {
  createInlineAskSession,
  finishedInlineAskTurns,
  type InlineAskSession,
  type InlineAskState,
  type InlineAskTurn,
  type InlineAskTurnRunner,
} from "./inlineAskSession";
import {
  collectPointerDocuments,
  createReaderOverlayEditor,
  createReaderOverlayElementFactory,
  isDarkReaderDocument,
  positionReaderOverlay,
  prepareReaderOverlaySlot,
  READER_OVERLAY_MARGIN,
  readerOverlayScheduler,
  registerReaderOverlay,
  releaseReaderOverlay,
  XHTML_NS,
  type ReaderOverlayAnchor,
  type ReaderOverlayHandle,
  type ReaderOverlayPalette,
} from "./readerOverlayShared";
import { classifySelectionPromptKey } from "./selectionPromptKeys";

const SVG_NS = "http://www.w3.org/2000/svg";

export type InlineAskOverlayLabels = {
  placeholder: string;
  followUpPlaceholder: string;
  /** The key hints; the question field's tooltip. */
  hint: string;
  send: string;
  /** Shown while the first chunk of an answer is on its way. */
  reading: string;
  discard: string;
  continueInSidebar: string;
  saveAsAnnotation: string;
  reasoningEffort: string;
  /** The More button's tooltip, and the text-size menu's strings. */
  more: string;
  textSize: string;
  resetTextSize: string;
  /** Shown when no model can answer. */
  modelUnavailable: string;
};

/** The model line: the model and effort the next question uses. */
export type InlineAskModelLine = {
  label: string;
  effort?: string;
  title?: string;
};

/** The model and effort menus behind the model line. */
export type InlineAskModelPicker = {
  /** The line now; read again after each pick. */
  line(): InlineAskModelLine | null;
  /** A short note shown first (or null), then the models by provider. */
  modelMenu(): { note: string | null; groups: InlineAskModelMenuGroup[] };
  pickModel(entryId: string): void;
  /** The section title and the levels the model in use offers. */
  effortMenu(): {
    title: string;
    levels: Array<{ value: string; label: string; selected: boolean }>;
  };
  pickEffort(value: string): void;
  /**
   * Called when the model or effort menu opens: may start loading model
   * data (the Codex Direct catalog) and calls `onChange` when it arrives,
   * so the card redraws its line and the open menu.
   */
  prepareMenu?(onChange: () => void): void;
};

export type InlineAskPromptEditingSetup = {
  api: InlineAskPromptEditing;
  labels: {
    edit: string;
    delete: string;
    add: string;
    reset: string;
    /** Placeholder of the Label field. */
    label: string;
    /** Placeholder of the Prompt field. */
    prompt: string;
    cancel: string;
    save: string;
  };
};

export type InlineAskSavePayload = { color: string; comment: string };

export type InlineAskSaveResult = { ok: true } | { ok: false; error: string };

/** A finished turn as the model got it (a quick prompt's full prompt). */
export type InlineAskContinueTurn = {
  role: "user" | "assistant";
  text: string;
};

/** Moves the turns to the sidebar; ok when the sidebar took them. */
export type InlineAskContinueInSidebar = (
  turns: InlineAskContinueTurn[],
) => Promise<{ ok: true } | { ok: false; error: string }>;

/** What the card needs for Save as annotation. */
export type InlineAskSaveSetup = {
  /** Zotero's highlight colors; the first is the default. */
  colors: Array<{ hex: string; label: string }>;
  /** "Page 17"; empty hides it. */
  pageText: string;
  labels: {
    color: string;
    back: string;
    cancel: string;
    save: string;
    addComment: string;
  };
  /** Why Save cannot run now (its tooltip), or null. Read on each check. */
  blockedReason: () => string | null;
  /** Writes the annotation; resolves ok only for a verified save. */
  save: (payload: InlineAskSavePayload) => Promise<InlineAskSaveResult>;
};

export type InlineAskOverlayInput = {
  /** Reader popup document (the renderTextSelectionPopup event's doc). */
  doc: Document;
  /** Popup row rect in viewport coordinates, measured at pointerdown. */
  anchor: ReaderOverlayAnchor;
  selectedText: string;
  /** "Ratzon et al., 2024": the passage's source; empty shows no label. */
  sourceLabel?: string;
  prompts: InlineAskQuickPrompt[];
  /** Null when no usable model exists; picker.line() replaces it. */
  model: InlineAskModelLine | null;
  /** Without it, the model line is display only. */
  modelPicker?: InlineAskModelPicker;
  /** Without it, right-clicking a pill does nothing of the card's own. */
  promptEditing?: InlineAskPromptEditingSetup;
  labels: InlineAskOverlayLabels;
  runTurn: InlineAskTurnRunner;
  createAbortController?: () => { signal?: AbortSignal; abort(): void } | null;
  /** Without it, Save as annotation stays disabled. */
  save?: InlineAskSaveSetup;
  /** Without it, Continue in sidebar stays disabled. */
  continueInSidebar?: InlineAskContinueInSidebar;
  /** The saved text size in percent (one of INLINE_ASK_TEXT_SIZES). */
  textSize?: number;
  /** Called when the user picks a new text size. */
  onTextSizeChange?: (size: number) => void;
  /** Called exactly once on any close path. */
  onClose?: () => void;
};

export type InlineAskOverlayHandle = ReaderOverlayHandle & {
  session: InlineAskSession;
  hasConversation(): boolean;
};

type SvgPart = { tag: string; attrs: Record<string, string> };

function svgIcon(
  doc: Document,
  size: number,
  attrs: Record<string, string>,
  parts: SvgPart[],
): Element {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  for (const [name, value] of Object.entries(attrs)) {
    svg.setAttribute(name, value);
  }
  for (const part of parts) {
    const node = doc.createElementNS(SVG_NS, part.tag);
    for (const [name, value] of Object.entries(part.attrs)) {
      node.setAttribute(name, value);
    }
    svg.appendChild(node);
  }
  return svg;
}

/** The up-arrow send glyph, drawn inside the card's send circle. */
function sendIcon(doc: Document): Element {
  return svgIcon(doc, 15, { fill: "none" }, [
    {
      tag: "path",
      attrs: {
        d: "M8 13V3.2M3.8 7.2 8 3l4.2 4.2",
        stroke: "currentColor",
        "stroke-width": "2",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      },
    },
  ]);
}

/** +1, -1 or 0 (reset) for Cmd/Ctrl with = + - 0; null for other keys. */
function textSizeKeyDirection(event: KeyboardEvent): number | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return null;
  if (event.key === "=" || event.key === "+") return 1;
  if (event.key === "-") return -1;
  if (event.key === "0") return 0;
  return null;
}

function closeIcon(doc: Document): Element {
  return svgIcon(
    doc,
    12,
    {
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.5",
      "stroke-linecap": "round",
    },
    [{ tag: "path", attrs: { d: "M4 4l8 8M12 4l-8 8" } }],
  );
}

/** The selection's highlight in the card: the color at 40% opacity. */
function markBackground(hex: string): string {
  return `${hex}66`;
}

/** The text sizes the More menu steps through, in percent. */
export const INLINE_ASK_TEXT_SIZES: readonly number[] = [
  90, 100, 110, 120, 135,
];

const PAPER_FONT = '"STIX Two Text","Times New Roman",Times,serif';

/**
 * About 65 characters per line at the default text size: a comfortable
 * reading measure.
 */
const DEFAULT_CARD_WIDTH = 460;
/** Below this the composer's model line and send arrow crowd each other. */
const MIN_CARD_WIDTH = 240;
/** The floating prompt editor; narrower when the card is. */
const FLOATING_EDITOR_WIDTH = 286;

/** The Inline Ask card's colors; the Add Text prompt keeps its own. */
type InlineAskPalette = ReaderOverlayPalette & {
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

function inlineAskPalette(dark: boolean): InlineAskPalette {
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

function sidebarIcon(doc: Document): Element {
  return svgIcon(
    doc,
    14,
    { fill: "none", stroke: "currentColor", "stroke-width": "1.3" },
    [
      {
        tag: "rect",
        attrs: { x: "1.5", y: "2.5", width: "13", height: "11", rx: "2" },
      },
      { tag: "path", attrs: { d: "M10 2.5v11" } },
    ],
  );
}

function noteIcon(doc: Document): Element {
  return svgIcon(
    doc,
    13,
    {
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.4",
      "stroke-linejoin": "round",
    },
    [{ tag: "path", attrs: { d: "M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" } }],
  );
}

/** The spark glyph on the reader popup's Inline Ask button. */
export function createInlineAskSparkIcon(doc: Document): Element {
  return svgIcon(doc, 13, {}, [
    {
      tag: "path",
      attrs: {
        d: "M7 1.5l1.4 3.6 3.6 1.4-3.6 1.4L7 11.5 5.6 7.9 2 6.5l3.6-1.4z",
        fill: "currentColor",
      },
    },
    {
      tag: "path",
      attrs: {
        d: "M12.5 10l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z",
        fill: "currentColor",
      },
    },
  ]);
}

function buttonCss(
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

function setButtonDisabled(button: HTMLButtonElement, disabled: boolean) {
  button.disabled = disabled;
  button.style.opacity = disabled ? "0.45" : "";
  button.style.cursor = disabled ? "default" : "pointer";
}

function show(node: HTMLElement, visible: boolean, display = "") {
  node.style.display = visible ? display : "none";
}

export function openInlineAskOverlay(
  input: InlineAskOverlayInput,
): InlineAskOverlayHandle {
  const { doc, labels } = input;
  prepareReaderOverlaySlot(doc);
  const palette = inlineAskPalette(isDarkReaderDocument(doc));
  const { bg, fg, border, quoteFg, labelFg } = palette;
  const el = createReaderOverlayElementFactory(doc);
  const schedule = readerOverlayScheduler(doc);
  // One multiplier scales every text of the card (not the More button or its
  // menu). Each size below is its 100% value in px.
  let textSize = INLINE_ASK_TEXT_SIZES.includes(input.textSize ?? 100)
    ? (input.textSize ?? 100)
    : 100;
  const sizePx = (base: number) =>
    `${Math.round(base * textSize * 10) / 1000}px`;
  const scaled: Array<[HTMLElement, number]> = [];
  const scaleText = <T extends HTMLElement>(node: T, base: number): T => {
    scaled.push([node, base]);
    node.style.fontSize = sizePx(base);
    return node;
  };
  const currentLine = (): InlineAskModelLine | null => {
    if (!input.modelPicker) return input.model;
    try {
      return input.modelPicker.line();
    } catch {
      return input.model;
    }
  };
  const hasModel = () => Boolean(currentLine());

  // A reading width, never the narrow native popup's: over the popup the
  // card is centered on it (the popup is centered on the selection).
  const cardWidth = DEFAULT_CARD_WIDTH;
  const placementAnchor = input.anchor.cover
    ? (() => {
        const center = (input.anchor.left + input.anchor.right) / 2;
        return {
          ...input.anchor,
          left: center - cardWidth / 2,
          right: center + cardWidth / 2,
        };
      })()
    : input.anchor;
  const editorWidth = Math.min(FLOATING_EDITOR_WIDTH, cardWidth - 16);
  const root = el("div", [
    "position:fixed",
    "z-index:10000",
    "display:flex",
    "flex-direction:column",
    "gap:8px",
    `width:${cardWidth}px`,
    "max-width:calc(100vw - 16px)",
    "padding:12px 10px 10px",
    "box-sizing:border-box",
    `background:${bg}`,
    `color:${fg}`,
    `border:1px solid ${border}`,
    "border-radius:16px",
    `box-shadow:${palette.cardShadow}`,
    "font-size:12px",
    "line-height:1.35",
    "user-select:text",
    "-moz-user-select:text",
  ]);
  root.setAttribute("data-llm-inline-ask", "true");

  // The passage header: a quote line, then "Creator, year:" and the selected
  // text in the reader's serif. Clamped; a click shows all of it. The text is
  // dimmer until the pointer is over the passage or it is open.
  const quoteSection = el("div", [
    "display:grid",
    "grid-template-columns:3px minmax(0,1fr)",
    "column-gap:10px",
    "min-width:0",
    "padding:0 2px 0 0",
    "cursor:pointer",
  ]);
  const quoteBar = el("span", [
    "border-radius:2px",
    "align-self:stretch",
    "margin:4px 0",
    `background:${palette.quoteBar}`,
  ]);
  quoteBar.setAttribute("data-llm-inline-ask-quote-bar", "true");
  const quoteBody = el("div", ["min-width:0", "overflow-wrap:anywhere"]);
  quoteSection.append(quoteBar, quoteBody);
  const sourceText = (input.sourceLabel || "").trim();
  if (sourceText) {
    const quoteLabel = scaleText(
      el("span", [
        "font-weight:600",
        "letter-spacing:0.01em",
        `color:${labelFg}`,
      ]),
      11.5,
    );
    quoteLabel.setAttribute("data-llm-inline-ask-quote-label", "true");
    quoteLabel.textContent = `${sourceText}:`;
    quoteBody.append(quoteLabel, doc.createTextNode(" "));
  }
  const quote = scaleText(
    el("span", [
      `font-family:${PAPER_FONT}`,
      "line-height:1.6",
      "white-space:pre-wrap",
      `color:${palette.quoteRestFg}`,
      "transition:color 0.2s ease",
    ]),
    13.5,
  );
  quote.setAttribute("data-llm-inline-ask-quote", "true");
  quote.textContent = input.selectedText;
  quoteBody.append(quote);
  let quoteExpanded = false;
  let quoteHover = false;
  const syncQuoteColor = () => {
    quote.style.color =
      quoteHover || quoteExpanded ? quoteFg : palette.quoteRestFg;
  };
  const syncQuote = () => {
    const lines = session.getState().turns.length > 0 ? 2 : 3;
    const css = quoteExpanded
      ? {
          display: "block",
          "-webkit-line-clamp": "unset",
          "max-height": "170px",
          overflow: "auto",
        }
      : {
          display: "-webkit-box",
          "-webkit-line-clamp": String(lines),
          "max-height": "none",
          overflow: "hidden",
        };
    quoteBody.style.setProperty("-webkit-box-orient", "vertical");
    for (const [name, value] of Object.entries(css)) {
      quoteBody.style.setProperty(name, value);
    }
    quoteSection.setAttribute(
      "data-expanded",
      quoteExpanded ? "true" : "false",
    );
    syncQuoteColor();
  };
  const onQuoteClick = () => {
    // A drag-select inside the passage is not a toggle.
    try {
      if (doc.defaultView?.getSelection?.()?.toString()) return;
    } catch {
      // Toggle anyway.
    }
    quoteExpanded = !quoteExpanded;
    syncQuote();
  };
  const onQuoteEnter = () => {
    quoteHover = true;
    syncQuoteColor();
  };
  const onQuoteLeave = () => {
    quoteHover = false;
    syncQuoteColor();
  };

  // The thread: questions, answers, and the reading line.
  const thread = el("div", [
    "display:none",
    "flex-direction:column",
    "gap:8px",
    // About 20 lines of answer before it scrolls.
    "max-height:min(460px, 58vh)",
    "overflow:auto",
  ]);
  thread.setAttribute("data-llm-inline-ask-thread", "true");
  // Scrolled text fades out under the pinned passage.
  const syncThreadFade = () => {
    const fade =
      thread.scrollTop > 2
        ? "linear-gradient(to bottom, transparent 0, #000 16px)"
        : "none";
    thread.style.setProperty("mask-image", fade);
  };
  const reading = scaleText(
    el("div", [
      `color:${labelFg}`,
      "font-style:italic",
      "padding:0 2px",
      "display:none",
    ]),
    12,
  );
  reading.setAttribute("data-llm-inline-ask-reading", "true");
  reading.textContent = labels.reading;
  thread.append(reading);

  // The question field with the model pair and the send arrow inside.
  // The card redraws on every session change (render is defined below; the
  // session reports no change before the first send).
  const session: InlineAskSession = createInlineAskSession({
    runTurn: input.runTurn,
    onChange: (state) => render(state),
    createAbortController: input.createAbortController,
  });
  const canSendNow = () => {
    const phase = session.getState().phase;
    // While Continue in sidebar runs, the turns it moves must stay complete.
    if (continuing) return false;
    return hasModel() && (phase === "compose" || phase === "answered");
  };
  const syncSend = () => {
    setSendDisabled(!canSendNow() || !textBox.readText().trim());
  };
  const textBox = createReaderOverlayEditor({
    doc,
    placeholder: labels.placeholder,
    fieldCss: [
      "position:relative",
      "display:flex",
      "flex-direction:column",
      "gap:2px",
      "box-sizing:border-box",
      "padding:9px 4px 3px 11px",
      "border-radius:14px",
      `background:${palette.fieldBg}`,
      "cursor:text",
    ],
    editorCss: [
      "min-height:18px",
      "max-height:140px",
      "overflow-y:auto",
      "box-sizing:border-box",
      "padding:0 7px 0 0",
      "border:none",
      "background:transparent",
      `color:${fg}`,
      "font:inherit",
      "font-size:12px",
      "line-height:1.35",
      "white-space:pre-wrap",
      "overflow-wrap:anywhere",
      "outline:none",
      "cursor:text",
    ],
    placeholderCss: [
      "position:absolute",
      "left:11px",
      "top:9px",
      "right:11px",
      "overflow:hidden",
      "white-space:nowrap",
      "text-overflow:ellipsis",
      "pointer-events:none",
      `color:${palette.tertiary}`,
      "font-size:12px",
      "line-height:1.35",
    ],
    editorAttribute: "data-llm-inline-ask-editor",
    placeholderAttribute: "data-llm-inline-ask-placeholder",
    onInput: () => syncSend(),
  });
  const { field, editor } = textBox;
  scaleText(editor, 12);
  scaleText(textBox.placeholder, 12);
  field.setAttribute("data-llm-inline-ask-field", "true");
  // The key hints are the field's tooltip.
  editor.setAttribute("title", labels.hint);
  // The model pair and the send arrow share the box's bottom line.
  const fieldBar = el("div", [
    "display:flex",
    "align-items:center",
    "min-height:28px",
    "margin-left:-4px",
    "min-width:0",
    "cursor:default",
  ]);
  const modelPairCss = [
    `color:${palette.fill2}`,
    "font-weight:600",
    "font-size:11px",
    "line-height:1",
    "padding:5px 4px",
    "border-radius:5px",
    "white-space:nowrap",
    "overflow:hidden",
    "text-overflow:ellipsis",
  ];
  // With a picker the pair are buttons that open the model and effort
  // menus (like the composer's model and reasoning buttons).
  const picker = input.modelPicker;
  const pairTag = picker ? "button" : "span";
  const pairButtonCss = picker
    ? [
        "border:none",
        "background:transparent",
        "font-family:inherit",
        "margin:0",
        "cursor:pointer",
      ]
    : ["cursor:default"];
  const modelLabel = scaleText(
    el(pairTag, [...modelPairCss, ...pairButtonCss, "max-width:170px"]),
    11,
  );
  modelLabel.setAttribute("data-llm-inline-ask-model", "true");
  const effortLabel = scaleText(
    el(pairTag, [...modelPairCss, ...pairButtonCss, "max-width:90px"]),
    11,
  );
  effortLabel.setAttribute("data-llm-inline-ask-effort", "true");
  effortLabel.setAttribute("title", labels.reasoningEffort);
  for (const button of picker ? [modelLabel, effortLabel] : []) {
    button.setAttribute("type", "button");
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
  }
  if (input.model || picker) fieldBar.append(modelLabel, effortLabel);
  const spacer = el("span", ["flex:1 1 auto"]);
  // A filled circle, so the way to send reads at a glance.
  const sendBtn = el("button", [
    "flex:none",
    "width:26px",
    "height:26px",
    "margin:1px 2px 1px 0",
    "border-radius:999px",
    "border:none",
    `background:${palette.sendOffBg}`,
    `color:${palette.sendOffFg}`,
    "transition:background-color 120ms ease, color 120ms ease",
    "display:inline-flex",
    "align-items:center",
    "justify-content:center",
    "padding:0",
    "cursor:pointer",
  ]) as HTMLButtonElement;
  sendBtn.setAttribute("type", "button");
  sendBtn.setAttribute("data-llm-inline-ask-send", "true");
  sendBtn.setAttribute("title", labels.send);
  sendBtn.setAttribute("aria-label", labels.send);
  sendBtn.appendChild(sendIcon(doc));
  const setSendDisabled = (disabled: boolean) => {
    sendBtn.disabled = disabled;
    sendBtn.style.background = disabled ? palette.sendOffBg : palette.sendBg;
    sendBtn.style.color = disabled ? palette.sendOffFg : palette.sendFg;
    sendBtn.style.opacity = "";
    sendBtn.style.cursor = disabled ? "default" : "pointer";
  };
  // The More button opens the text-size menu; it is not scaled itself.
  const moreBtn = el("button", [
    "flex:none",
    "margin:0",
    "padding:3px 6px",
    "border:none",
    "background:transparent",
    `color:${palette.fill2}`,
    "font-family:inherit",
    "font-size:15px",
    "letter-spacing:1px",
    "line-height:1",
    "cursor:pointer",
  ]) as HTMLButtonElement;
  moreBtn.setAttribute("type", "button");
  moreBtn.setAttribute("data-llm-inline-ask-more", "true");
  moreBtn.setAttribute("title", labels.more);
  moreBtn.setAttribute("aria-label", labels.more);
  moreBtn.setAttribute("aria-haspopup", "menu");
  moreBtn.setAttribute("aria-expanded", "false");
  moreBtn.textContent = "\u22EF";
  fieldBar.append(spacer, moreBtn, sendBtn);
  field.append(fieldBar);
  // Secondary at rest, primary on hover or while the button's menu is open.
  const hoverTint = (node: HTMLElement, rest: () => string, on: string) => {
    node.addEventListener("mouseenter", () => {
      if ((node as HTMLButtonElement).disabled) return;
      node.style.color = on;
    });
    node.addEventListener("mouseleave", () => {
      node.style.color = rest();
    });
  };
  if (picker) {
    for (const button of [modelLabel, effortLabel]) {
      hoverTint(
        button,
        () =>
          button.getAttribute("aria-expanded") === "true" ? fg : palette.fill2,
        fg,
      );
    }
  }
  hoverTint(
    moreBtn,
    () =>
      moreBtn.getAttribute("aria-expanded") === "true" ? fg : palette.fill2,
    fg,
  );
  sendBtn.addEventListener("mouseenter", () => {
    if (!sendBtn.disabled) sendBtn.style.opacity = "0.85";
  });
  sendBtn.addEventListener("mouseleave", () => {
    sendBtn.style.opacity = "";
  });

  const notice = scaleText(
    el("div", [`color:${labelFg}`, "line-height:1.3"]),
    11,
  );
  notice.setAttribute("data-llm-inline-ask-notice", "true");
  notice.textContent = labels.modelUnavailable;

  const syncModelLine = () => {
    const line = currentLine();
    show(modelLabel, Boolean(line));
    modelLabel.textContent = line?.label || "";
    if (line?.title) modelLabel.setAttribute("title", line.title);
    else modelLabel.removeAttribute("title");
    show(effortLabel, Boolean(line?.effort));
    effortLabel.textContent = line?.effort || "";
    show(notice, !line);
  };
  syncModelLine();

  // Quick prompts: plain grey words, shifted left so the text lines up with
  // the passage.
  const pills = el("div", [
    "display:flex",
    "gap:2px",
    "flex-wrap:wrap",
    "margin-left:-4px",
    "min-height:22px",
    "cursor:grab",
  ]);
  pills.setAttribute("data-llm-inline-ask-pills", "true");
  const promptSetup = input.promptEditing;
  let shownPrompts: InlineAskQuickPrompt[] = input.prompts.slice();
  /** The prompt the editor is open for; id null for Add. */
  let editingPrompt: { id: string | null } | null = null;
  const pillCss = (editing: boolean) => [
    "display:inline-flex",
    "align-items:center",
    "padding:3px 6px",
    "border:none",
    "border-radius:6px",
    `background:${editing ? palette.hover : "none"}`,
    `color:${editing ? fg : labelFg}`,
    "font:inherit",
    "font-size:12px",
    "max-width:100%",
    "overflow:hidden",
    "text-overflow:ellipsis",
    "white-space:nowrap",
    "cursor:pointer",
  ];
  const renderPills = () => {
    for (let child = pills.firstChild; child; child = pills.firstChild) {
      pills.removeChild(child);
    }
    for (const prompt of shownPrompts) {
      const editing = editingPrompt?.id === prompt.id;
      const pill = el("button", pillCss(editing)) as HTMLButtonElement;
      pill.setAttribute("type", "button");
      pill.setAttribute("data-llm-inline-ask-pill", prompt.id);
      // The tooltip is the prompt the pill sends.
      pill.setAttribute("title", prompt.prompt);
      if (editing) pill.setAttribute("data-editing", "true");
      pill.textContent = prompt.label;
      pill.style.fontSize = sizePx(12);
      pill.addEventListener("mouseenter", () => {
        if (pill.disabled) return;
        pill.style.background = palette.hover;
        pill.style.color = fg;
      });
      pill.addEventListener("mouseleave", () => {
        if (editingPrompt?.id === prompt.id) return;
        pill.style.background = "none";
        pill.style.color = labelFg;
      });
      setButtonDisabled(pill, !hasModel());
      pills.append(pill);
    }
  };
  renderPills();

  // ── Quick-prompt editor (Edit / Add): floats over the card ─────────────
  /** The floating editor fits the card's current width. */
  const currentEditorWidth = () =>
    Math.min(
      FLOATING_EDITOR_WIDTH,
      (root.getBoundingClientRect().width || cardWidth) - 16,
    );
  const promptEditor = el("div", [
    "display:none",
    "position:absolute",
    "z-index:5",
    "flex-direction:column",
    "gap:6px",
    `width:${editorWidth}px`,
    "box-sizing:border-box",
    "padding:10px",
    `background:${bg}`,
    `border:1px solid ${palette.menuBorder}`,
    "border-radius:12px",
    `box-shadow:${palette.floatShadow}`,
    "min-width:0",
  ]);
  promptEditor.setAttribute("data-llm-inline-ask-prompt-editor", "true");
  const inputCss = [
    "width:100%",
    "min-width:0",
    "box-sizing:border-box",
    "padding:5px 8px",
    "border:1px solid transparent",
    "border-radius:6px",
    `background:${palette.fieldBg}`,
    `color:${fg}`,
    "font:inherit",
    "font-size:12px",
    "line-height:1.35",
    "outline:none",
  ];
  // <input type=text>: the reader's key handlers skip it (see
  // createReaderOverlayEditor), so letters and digits type.
  const labelInput = doc.createElementNS(XHTML_NS, "input") as HTMLInputElement;
  labelInput.style.cssText = inputCss.join(";");
  labelInput.setAttribute("type", "text");
  labelInput.setAttribute("data-llm-inline-ask-prompt-label", "true");
  labelInput.setAttribute("placeholder", promptSetup?.labels.label || "");
  labelInput.setAttribute("aria-label", promptSetup?.labels.label || "");
  const promptBox = createReaderOverlayEditor({
    doc,
    placeholder: promptSetup?.labels.prompt || "",
    fieldCss: ["position:relative", "min-width:0"],
    editorCss: [
      ...inputCss,
      "min-height:58px",
      "max-height:120px",
      "overflow-y:auto",
      "white-space:pre-wrap",
      "overflow-wrap:anywhere",
      "cursor:text",
    ],
    placeholderCss: [
      "position:absolute",
      "left:9px",
      "top:6px",
      "right:9px",
      "overflow:hidden",
      "white-space:nowrap",
      "text-overflow:ellipsis",
      "pointer-events:none",
      `color:${palette.tertiary}`,
      "font-size:12px",
      "line-height:1.35",
    ],
    editorAttribute: "data-llm-inline-ask-prompt-text",
    placeholderAttribute: "data-llm-inline-ask-prompt-placeholder",
  });
  const promptFooter = el("div", [
    "display:flex",
    "gap:6px",
    "align-items:center",
  ]);
  const cancelPromptBtn = el(
    "button",
    buttonCss(palette, "ghost"),
  ) as HTMLButtonElement;
  cancelPromptBtn.setAttribute("type", "button");
  cancelPromptBtn.setAttribute("data-llm-inline-ask-prompt-action", "cancel");
  cancelPromptBtn.textContent = promptSetup?.labels.cancel || "";
  const savePromptBtn = el(
    "button",
    buttonCss(palette, "primary"),
  ) as HTMLButtonElement;
  savePromptBtn.setAttribute("type", "button");
  savePromptBtn.setAttribute("data-llm-inline-ask-prompt-action", "save");
  savePromptBtn.textContent = promptSetup?.labels.save || "";
  promptFooter.append(
    el("span", ["flex:1 1 auto"]),
    cancelPromptBtn,
    savePromptBtn,
  );
  promptEditor.append(labelInput, promptBox.field, promptFooter);

  // ── Menus: the pill menu, and the model and effort menus ───────────────
  type OpenMenu = {
    kind: "prompt" | "model" | "effort" | "more";
    node: HTMLElement;
  };
  let openMenu: OpenMenu | null = null;
  /** The parts of the open More menu, updated in place on a size change. */
  let moreMenu: {
    value: HTMLElement;
    smaller: HTMLButtonElement;
    larger: HTMLButtonElement;
    dots: HTMLElement[];
    reset: HTMLButtonElement;
  } | null = null;
  /** A pointerdown that only closed the pill menu also swallows its click. */
  let swallowPillClick = false;

  const menuItemCss = [
    "display:flex",
    "align-items:center",
    "justify-content:flex-start",
    "box-sizing:border-box",
    "width:100%",
    "min-height:24px",
    "margin:0",
    "background:none",
    "border:none",
    `color:${fg}`,
    "padding:4px 8px",
    "font:inherit",
    "font-size:11px",
    "line-height:1.2",
    "text-align:left",
    "cursor:pointer",
    "border-radius:4px",
    "white-space:nowrap",
  ];
  const addHover = (
    node: HTMLElement,
    on: () => void,
    off: () => void,
  ): void => {
    node.addEventListener("mouseenter", on);
    node.addEventListener("mouseleave", off);
  };

  const closeMenus = () => {
    const menu = openMenu;
    if (!menu) return;
    openMenu = null;
    moreMenu = null;
    menu.node.remove();
    moreBtn.setAttribute("aria-expanded", "false");
    moreBtn.style.color = palette.fill2;
    for (const button of [modelLabel, effortLabel]) {
      if (!picker) break;
      button.setAttribute("aria-expanded", "false");
      button.style.color = palette.fill2;
    }
  };

  /** Mounts `node` in the card at a point relative to the card's corner. */
  const mountMenu = (
    kind: OpenMenu["kind"],
    node: HTMLElement,
    left: number,
    top: number,
    flipAbove?: number,
  ) => {
    node.style.left = `${Math.max(0, Math.round(left))}px`;
    node.style.top = `${Math.round(top)}px`;
    root.append(node);
    openMenu = { kind, node };
    if (flipAbove === undefined) return;
    // Open upwards when the menu would leave the window at the bottom.
    const vh = doc.defaultView?.innerHeight ?? 600;
    const menuRect = node.getBoundingClientRect();
    if (menuRect.bottom > vh - READER_OVERLAY_MARGIN && menuRect.height) {
      node.style.top = `${Math.round(flipAbove - menuRect.height)}px`;
    }
  };

  const openPromptMenu = (promptId: string | null, x: number, y: number) => {
    if (!promptSetup) return;
    closeMenus();
    const menu = el("div", [
      "position:absolute",
      "z-index:3",
      "display:flex",
      "flex-direction:column",
      "gap:2px",
      "min-width:64px",
      "padding:4px",
      "box-sizing:border-box",
      `background:${bg}`,
      `border:1px solid ${palette.menuBorder}`,
      "border-radius:6px",
      `box-shadow:${palette.menuShadow}`,
    ]);
    menu.setAttribute("data-llm-inline-ask-prompt-menu", promptId || "");
    menu.setAttribute("role", "menu");
    const items: Array<[string, string, boolean]> = promptId
      ? [
          ["edit", promptSetup.labels.edit, true],
          ["delete", promptSetup.labels.delete, true],
          ["add", promptSetup.labels.add, promptSetup.api.canAdd()],
          ["reset", promptSetup.labels.reset, true],
        ]
      : [
          ["add", promptSetup.labels.add, promptSetup.api.canAdd()],
          ["reset", promptSetup.labels.reset, true],
        ];
    for (const [action, text, enabled] of items) {
      const item = el("button", menuItemCss) as HTMLButtonElement;
      item.setAttribute("type", "button");
      item.setAttribute("role", "menuitem");
      item.setAttribute("data-llm-inline-ask-prompt-menu-item", action);
      item.textContent = text;
      if (!enabled) {
        item.disabled = true;
        item.style.opacity = "0.45";
        item.style.cursor = "not-allowed";
      }
      addHover(
        item,
        () => {
          if (!item.disabled) item.style.background = palette.hover;
        },
        () => {
          item.style.background = "none";
        },
      );
      item.addEventListener("click", (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        if (item.disabled) return;
        runPromptMenuAction(action, promptId);
      });
      menu.append(item);
    }
    const width = root.getBoundingClientRect().width || cardWidth;
    mountMenu("prompt", menu, Math.min(x, width - 130), y);
  };

  const menuPanelCss = [
    "position:absolute",
    "z-index:4",
    "display:grid",
    "gap:3px",
    "width:max-content",
    "min-width:150px",
    "max-width:240px",
    "max-height:min(320px, 60vh)",
    "overflow-y:auto",
    "padding:6px",
    "box-sizing:border-box",
    `border:1px solid ${palette.menuBorder}`,
    "border-radius:12px",
    `background:${bg}`,
    `box-shadow:${palette.menuShadow}`,
  ];
  const sectionCss = [
    "padding:4px 10px",
    "font-size:10px",
    "font-weight:600",
    `color:${labelFg}`,
  ];
  const optionCss = (selected: boolean) => [
    `border:1px solid ${selected ? palette.accent : "transparent"}`,
    "border-radius:8px",
    "background:none",
    `color:${fg}`,
    "text-align:left",
    "padding:7px 9px",
    "margin:0",
    "font:inherit",
    "font-size:11px",
    "line-height:1.2",
    "white-space:nowrap",
    "overflow:hidden",
    "text-overflow:ellipsis",
    "cursor:pointer",
  ];
  const menuOption = (
    attribute: string,
    value: string,
    text: string,
    selected: boolean,
    pick: () => void,
    title?: string,
  ): HTMLButtonElement => {
    const option = el("button", optionCss(selected)) as HTMLButtonElement;
    option.setAttribute("type", "button");
    option.setAttribute("role", "menuitemradio");
    option.setAttribute(attribute, value);
    option.setAttribute("aria-checked", selected ? "true" : "false");
    if (title) option.setAttribute("title", title);
    option.textContent = text;
    addHover(
      option,
      () => {
        if (!selected) option.style.borderColor = palette.menuBorder;
      },
      () => {
        if (!selected) option.style.borderColor = "transparent";
      },
    );
    option.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      pick();
    });
    return option;
  };
  const afterPick = () => {
    closeMenus();
    syncModelLine();
    syncSend();
    renderPills();
    schedule(() => {
      if (closed || editingPrompt) return;
      editor.focus({ preventScroll: true });
    }, 0);
  };

  // The picker's model data changed: redraw the line and any open menu.
  const onModelDataChange = () => {
    if (closed) return;
    syncModelLine();
    syncSend();
    const kind = openMenu?.kind;
    if (kind !== "model" && kind !== "effort") return;
    closeMenus();
    showModelMenu(kind);
  };
  const toggleModelMenu = (kind: "model" | "effort") => {
    if (!picker) return;
    if (openMenu?.kind === kind) {
      closeMenus();
      return;
    }
    closeMenus();
    try {
      picker.prepareMenu?.(onModelDataChange);
    } catch {
      // The menu shows what the picker has now.
    }
    showModelMenu(kind);
  };
  const showModelMenu = (kind: "model" | "effort") => {
    if (!picker) return;
    const button = kind === "model" ? modelLabel : effortLabel;
    const menu = el("div", menuPanelCss);
    menu.setAttribute("data-llm-inline-ask-model-menu", kind);
    menu.setAttribute("role", "menu");
    try {
      if (kind === "model") {
        const { note, groups } = picker.modelMenu();
        if (note) {
          const explain = el("div", [
            "padding:4px 10px 8px",
            "font-size:9.5px",
            "line-height:1.45",
            `color:${labelFg}`,
            "white-space:normal",
          ]);
          explain.setAttribute("data-llm-inline-ask-model-note", "true");
          explain.textContent = note;
          menu.append(explain);
        }
        for (const group of groups) {
          const section = el("div", sectionCss);
          section.setAttribute("data-llm-inline-ask-menu-section", "true");
          section.textContent = group.label;
          menu.append(section);
          for (const option of group.options) {
            menu.append(
              menuOption(
                "data-llm-inline-ask-model-option",
                option.entryId,
                option.label,
                option.selected,
                () => {
                  picker.pickModel(option.entryId);
                  afterPick();
                },
                option.title,
              ),
            );
          }
        }
      } else {
        const { title, levels } = picker.effortMenu();
        const section = el("div", sectionCss);
        section.setAttribute("data-llm-inline-ask-menu-section", "true");
        section.textContent = title;
        menu.append(section);
        for (const level of levels) {
          menu.append(
            menuOption(
              "data-llm-inline-ask-effort-option",
              level.value,
              level.label,
              level.selected,
              () => {
                picker.pickEffort(level.value);
                afterPick();
              },
            ),
          );
        }
      }
    } catch {
      return;
    }
    button.setAttribute("aria-expanded", "true");
    button.style.color = fg;
    const rootRect = root.getBoundingClientRect();
    const rect = button.getBoundingClientRect();
    mountMenu(
      kind,
      menu,
      rect.left - rootRect.left,
      rect.bottom - rootRect.top + 4,
      rect.top - rootRect.top - 4,
    );
  };

  const refreshPrompts = () => {
    if (promptSetup) {
      try {
        shownPrompts = promptSetup.api.list();
      } catch {
        // Keep the pills shown; the prefs could not be read.
      }
    }
    renderPills();
  };
  /** Where the floating editor's left edge goes: the clicked word's left. */
  let editAnchorX = 0;
  const placePromptEditor = () => {
    const rootRect = root.getBoundingClientRect();
    const rowRect = pills.getBoundingClientRect();
    const editorHeight = promptEditor.getBoundingClientRect().height;
    const width = currentEditorWidth();
    promptEditor.style.width = `${Math.round(width)}px`;
    const maxLeft = Math.max(6, rootRect.width - width - 8);
    const maxTop = Math.max(6, rootRect.height - editorHeight - 8);
    promptEditor.style.left = `${Math.round(
      Math.min(Math.max(6, editAnchorX - 14), maxLeft),
    )}px`;
    promptEditor.style.top = `${Math.round(
      Math.min(Math.max(6, rowRect.bottom - rootRect.top + 6), maxTop),
    )}px`;
  };
  const syncPromptEditor = () => {
    const inCompose = session.getState().phase === "compose";
    const visible = Boolean(editingPrompt) && inCompose;
    show(promptEditor, visible, "flex");
    if (visible) placePromptEditor();
  };
  const openPromptEditor = (prompt: InlineAskQuickPrompt | null) => {
    if (!promptSetup) return;
    closeMenus();
    editingPrompt = { id: prompt?.id ?? null };
    labelInput.value = prompt?.label || "";
    promptBox.setText(prompt?.prompt || "");
    renderPills();
    syncPromptEditor();
    schedule(() => {
      if (closed || !editingPrompt) return;
      labelInput.focus({ preventScroll: true });
    }, 0);
  };
  const closePromptEditor = (refocus: boolean) => {
    if (!editingPrompt) return;
    editingPrompt = null;
    renderPills();
    syncPromptEditor();
    if (!refocus) return;
    schedule(() => {
      if (closed || editingPrompt) return;
      editor.focus({ preventScroll: true });
    }, 0);
  };
  const savePrompt = () => {
    if (!promptSetup || !editingPrompt) return;
    const value = {
      label: (labelInput.value || "").trim(),
      prompt: promptBox.readText().trim(),
    };
    if (!value.label) {
      labelInput.focus({ preventScroll: true });
      return;
    }
    if (!value.prompt) {
      promptBox.editor.focus({ preventScroll: true });
      return;
    }
    try {
      if (editingPrompt.id) promptSetup.api.edit(editingPrompt.id, value);
      else promptSetup.api.add(value);
    } catch {
      // The prefs refused the write; the pills show what is stored.
    }
    editingPrompt = null;
    refreshPrompts();
    syncPromptEditor();
    schedule(() => {
      if (closed || editingPrompt) return;
      editor.focus({ preventScroll: true });
    }, 0);
  };
  function runPromptMenuAction(action: string, promptId: string | null) {
    closeMenus();
    if (!promptSetup) return;
    const prompt = shownPrompts.find((entry) => entry.id === promptId) || null;
    if (action === "edit" && prompt) {
      openPromptEditor(prompt);
      return;
    }
    if (action === "add") {
      if (promptSetup.api.canAdd()) openPromptEditor(null);
      return;
    }
    try {
      if (action === "delete" && promptId) promptSetup.api.remove(promptId);
      else if (action === "reset") promptSetup.api.reset();
      else return;
    } catch {
      // The prefs refused the write; the pills show what is stored.
    }
    if (action === "reset" || editingPrompt?.id === promptId) {
      editingPrompt = null;
      syncPromptEditor();
    }
    refreshPrompts();
  }

  // Message actions under the latest answer: Save as annotation, Continue in
  // sidebar (icon only), then Discard on the right.
  const footer = el("div", [
    "display:none",
    "align-items:center",
    "gap:2px",
    "margin:-3px 0 0 -4px",
  ]);
  footer.setAttribute("data-llm-inline-ask-footer", "true");
  const actionCss = [
    "display:inline-flex",
    "align-items:center",
    "gap:5px",
    "border:none",
    "background:none",
    `color:${labelFg}`,
    "font:inherit",
    "line-height:1.35",
    "padding:4px 6px",
    "border-radius:6px",
    "white-space:nowrap",
    "cursor:pointer",
  ];
  const quietAction = (): HTMLButtonElement => {
    const button = scaleText(
      el("button", actionCss) as HTMLButtonElement,
      11.5,
    );
    button.setAttribute("type", "button");
    button.addEventListener("mouseenter", () => {
      if (button.disabled) return;
      button.style.color = fg;
      button.style.background = palette.hover;
    });
    button.addEventListener("mouseleave", () => {
      button.style.color = labelFg;
      button.style.background = "none";
    });
    return button;
  };
  const discardBtn = quietAction();
  discardBtn.setAttribute("data-llm-inline-ask-action", "discard");
  discardBtn.textContent = labels.discard;
  const footerSpacer = el("span", ["flex:1 1 auto"]);
  const sidebarBtn = quietAction();
  sidebarBtn.setAttribute("data-llm-inline-ask-action", "sidebar");
  sidebarBtn.setAttribute("title", labels.continueInSidebar);
  sidebarBtn.setAttribute("aria-label", labels.continueInSidebar);
  sidebarBtn.appendChild(sidebarIcon(doc));
  const saveBtn = quietAction();
  saveBtn.setAttribute("data-llm-inline-ask-action", "save");
  saveBtn.appendChild(noteIcon(doc));
  saveBtn.appendChild(doc.createTextNode(labels.saveAsAnnotation));
  setButtonDisabled(sidebarBtn, true);
  setButtonDisabled(saveBtn, true);
  footer.append(saveBtn, sidebarBtn, footerSpacer, discardBtn);
  // Why Continue in sidebar did not move the conversation.
  const sidebarError = scaleText(
    el("div", [
      "display:none",
      `color:${labelFg}`,
      "line-height:1.3",
      "padding:0 2px",
      "overflow-wrap:anywhere",
    ]),
    11,
  );
  sidebarError.setAttribute("data-llm-inline-ask-sidebar-error", "true");
  // The message actions and the reason sit at the end of the thread, after
  // the latest answer (turns are inserted before the reading line).
  thread.append(footer, sidebarError);

  // ── The annotation card (Save as annotation) ───────────────────────────
  const saveSetup = input.save;
  const colors = saveSetup?.colors.length
    ? saveSetup.colors
    : [{ hex: "#ffd400", label: "" }];
  const saveView = el("div", [
    "display:none",
    "flex-direction:column",
    "gap:8px",
    "min-width:0",
  ]);
  saveView.setAttribute("data-llm-inline-ask-save-view", "true");
  const saveHeader = el("div", [
    "display:flex",
    "align-items:center",
    "gap:7px",
    "min-width:0",
  ]);
  const colorSquare = el("button", [
    "flex:none",
    "width:14px",
    "height:14px",
    "border-radius:3px",
    "border:none",
    "padding:0",
    "cursor:pointer",
    `background:${colors[0].hex}`,
  ]) as HTMLButtonElement;
  colorSquare.setAttribute("type", "button");
  colorSquare.setAttribute("data-llm-inline-ask-color", "toggle");
  colorSquare.setAttribute("title", saveSetup?.labels.color || "");
  colorSquare.setAttribute("aria-label", saveSetup?.labels.color || "");
  colorSquare.setAttribute("aria-expanded", "false");
  const pageText = scaleText(
    el("span", [`color:${labelFg}`, "line-height:1.2", "white-space:nowrap"]),
    11,
  );
  pageText.setAttribute("data-llm-inline-ask-page", "true");
  pageText.textContent = saveSetup?.pageText || "";
  show(pageText, Boolean(saveSetup?.pageText));
  const saveHeaderSpacer = el("span", ["flex:1 1 auto"]);
  const backBtn = el(
    "button",
    buttonCss(palette, "ghost", ["padding:4px 6px"]),
  ) as HTMLButtonElement;
  backBtn.setAttribute("type", "button");
  backBtn.setAttribute("data-llm-inline-ask-save-action", "back");
  backBtn.setAttribute("title", saveSetup?.labels.back || "");
  backBtn.setAttribute("aria-label", saveSetup?.labels.back || "");
  backBtn.appendChild(closeIcon(doc));
  saveHeader.append(colorSquare, pageText, saveHeaderSpacer, backBtn);

  const colorRow = el("div", ["display:none", "gap:6px", "align-items:center"]);
  colorRow.setAttribute("data-llm-inline-ask-colors", "true");
  const colorDots: HTMLButtonElement[] = colors.map(({ hex, label }) => {
    const dot = el("button", [
      "flex:none",
      "width:12px",
      "height:12px",
      "border-radius:50%",
      "border:none",
      "padding:0",
      "cursor:pointer",
      `background:${hex}`,
    ]) as HTMLButtonElement;
    dot.setAttribute("type", "button");
    dot.setAttribute("data-llm-inline-ask-color-dot", hex);
    dot.setAttribute("title", label);
    dot.setAttribute("aria-label", label);
    colorRow.append(dot);
    return dot;
  });

  const markClamp = scaleText(
    el("div", [
      `font-family:${PAPER_FONT}`,
      "line-height:1.4",
      "display:-webkit-box",
      "-webkit-box-orient:vertical",
      "-webkit-line-clamp:3",
      "overflow:hidden",
      "overflow-wrap:anywhere",
    ]),
    13,
  );
  const mark = el("mark", [
    `background:${markBackground(colors[0].hex)}`,
    "color:inherit",
    "padding:0 1px",
  ]);
  mark.setAttribute("data-llm-inline-ask-mark", "true");
  mark.textContent = input.selectedText;
  markClamp.append(mark);

  const commentBox = createReaderOverlayEditor({
    doc,
    placeholder: saveSetup?.labels.addComment || "",
    fieldCss: [
      "position:relative",
      `border-top:1px solid ${border}`,
      "padding-top:8px",
    ],
    editorCss: [
      "min-height:18px",
      "max-height:min(240px, 40vh)",
      "overflow:auto",
      "box-sizing:border-box",
      "border:none",
      "background:transparent",
      `color:${fg}`,
      "font:inherit",
      "font-size:12px",
      "line-height:1.5",
      "white-space:pre-wrap",
      "overflow-wrap:anywhere",
      "outline:none",
      "cursor:text",
    ],
    placeholderCss: [
      "position:absolute",
      "left:0",
      "top:8px",
      "right:0",
      "overflow:hidden",
      "white-space:nowrap",
      "text-overflow:ellipsis",
      "pointer-events:none",
      `color:${labelFg}`,
      "font-size:12px",
      "line-height:1.5",
    ],
    editorAttribute: "data-llm-inline-ask-comment",
    placeholderAttribute: "data-llm-inline-ask-comment-placeholder",
  });

  const saveError = scaleText(
    el("div", [
      "display:none",
      `color:${labelFg}`,
      "line-height:1.3",
      "overflow-wrap:anywhere",
    ]),
    11,
  );
  saveError.setAttribute("data-llm-inline-ask-save-error", "true");

  const saveFooter = el("div", [
    "display:flex",
    "gap:6px",
    "align-items:center",
  ]);
  const cancelSaveBtn = scaleText(
    el("button", buttonCss(palette, "ghost")) as HTMLButtonElement,
    12,
  );
  cancelSaveBtn.setAttribute("type", "button");
  cancelSaveBtn.setAttribute("data-llm-inline-ask-save-action", "cancel");
  cancelSaveBtn.textContent = saveSetup?.labels.cancel || "";
  const confirmSaveBtn = scaleText(
    el("button", buttonCss(palette, "primary")) as HTMLButtonElement,
    12,
  );
  confirmSaveBtn.setAttribute("type", "button");
  confirmSaveBtn.setAttribute("data-llm-inline-ask-save-action", "save");
  confirmSaveBtn.textContent = saveSetup?.labels.save || "";
  saveFooter.append(
    el("span", ["flex:1 1 auto"]),
    cancelSaveBtn,
    confirmSaveBtn,
  );

  scaleText(commentBox.editor, 12);
  scaleText(commentBox.placeholder, 12);
  saveView.append(
    saveHeader,
    colorRow,
    markClamp,
    commentBox.field,
    saveError,
    saveFooter,
  );

  // The corner grips: drag a corner to resize the card. Each grip is an
  // invisible hit area that straddles its corner. While the pointer is over
  // it (or a drag from it runs), an arc shows just outside the card's corner.
  const RESIZE_CORNERS = [
    "top-left",
    "top-right",
    "bottom-left",
    "bottom-right",
  ] as const;
  type ResizeCorner = (typeof RESIZE_CORNERS)[number];
  const resizeGrips = new Map<ResizeCorner, HTMLElement>();
  const resizeArcs = new Map<ResizeCorner, HTMLElement>();
  const hoveredCorners = new Set<ResizeCorner>();
  const syncResizeArcs = () => {
    for (const [corner, arc] of resizeArcs) {
      const on = hoveredCorners.has(corner) || drag?.corner === corner;
      arc.style.opacity = on ? "1" : "0";
    }
  };
  const resizeListeners: Array<[HTMLElement, string, () => void]> = [];
  for (const corner of RESIZE_CORNERS) {
    const isTop = corner.startsWith("top");
    const isLeft = corner.endsWith("left");
    // The box reaches 12px into the card and 6px outside it.
    const grip = el("div", [
      "position:absolute",
      isTop ? "top:-7px" : "bottom:-7px",
      isLeft ? "left:-7px" : "right:-7px",
      "width:18px",
      "height:18px",
      "z-index:20",
      isTop === isLeft ? "cursor:nwse-resize" : "cursor:nesw-resize",
      "touch-action:none",
    ]);
    grip.setAttribute("data-llm-inline-ask-resize", corner);
    // The arc is drawn for the bottom-right corner and mirrored for the rest.
    // It is concentric with the card's 16px corner, 4.5px outside it, and its
    // straight tails run 6px along the two edges.
    const arc = el("div", [
      "position:absolute",
      "inset:0",
      "pointer-events:none",
      "opacity:0",
      "transition:opacity 120ms ease",
      `color:${palette.labelFg}`,
    ]);
    arc.setAttribute("data-llm-inline-ask-resize-arc", corner);
    const svg = doc.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 18 18");
    svg.setAttribute("width", "18");
    svg.setAttribute("height", "18");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2.5");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute(
      "style",
      `display:block;overflow:visible;transform:scale(${isLeft ? -1 : 1},${isTop ? -1 : 1})`,
    );
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M16.5 -10V-4A20.5 20.5 0 0 1 -4 16.5H-10");
    svg.appendChild(path);
    arc.append(svg);
    grip.append(arc);
    const onEnter = () => {
      hoveredCorners.add(corner);
      syncResizeArcs();
    };
    const onLeave = () => {
      hoveredCorners.delete(corner);
      syncResizeArcs();
    };
    grip.addEventListener("mouseenter", onEnter);
    grip.addEventListener("mouseleave", onLeave);
    resizeListeners.push([grip, "mouseenter", onEnter]);
    resizeListeners.push([grip, "mouseleave", onLeave]);
    resizeGrips.set(corner, grip);
    resizeArcs.set(corner, arc);
  }

  root.append(
    quoteSection,
    thread,
    pills,
    field,
    notice,
    promptEditor,
    saveView,
    ...resizeGrips.values(),
  );

  // ── Rendering ──────────────────────────────────────────────────────────
  const turnNodes: Array<{
    node: HTMLElement;
    rendered: string;
    base: number;
  }> = [];
  let lastPhase: InlineAskState["phase"] = "compose";

  const renderTurn = (turn: InlineAskTurn, index: number) => {
    let entry = turnNodes[index];
    if (!entry) {
      const node =
        turn.role === "user"
          ? el("div", [
              "align-self:flex-end",
              "max-width:88%",
              "box-sizing:border-box",
              `background:${palette.fieldBg}`,
              "border-radius:12px",
              "padding:6px 10px",
              `color:${fg}`,
              "font-size:12px",
              "line-height:1.4",
              "white-space:pre-wrap",
              "overflow-wrap:anywhere",
            ])
          : el("div", [
              `color:${fg}`,
              "font-size:12.5px",
              "line-height:1.55",
              "padding:0 2px",
              "overflow-wrap:anywhere",
            ]);
      if (turn.role === "user") {
        node.setAttribute("data-llm-inline-ask-question", "true");
        node.textContent = turn.shownText;
      }
      const base = turn.role === "user" ? 12 : 12.5;
      node.style.fontSize = sizePx(base);
      thread.insertBefore(node, reading);
      entry = { node, rendered: "", base };
      turnNodes[index] = entry;
    }
    if (turn.role !== "assistant") return;
    const signature = `${turn.status}\u0000${turn.text}`;
    if (entry.rendered === signature) return;
    entry.rendered = signature;
    entry.node.setAttribute("data-llm-inline-ask-answer", turn.status);
    if (turn.status === "error") {
      entry.node.textContent = turn.text;
      entry.node.style.color = labelFg;
      return;
    }
    renderInlineAskAnswer(doc, entry.node, turn.text, palette);
  };

  const keepInViewport = () => {
    const vh = doc.defaultView?.innerHeight ?? 600;
    const rect = root.getBoundingClientRect();
    if (rect.top + rect.height <= vh - READER_OVERLAY_MARGIN) return;
    const top = Math.max(
      READER_OVERLAY_MARGIN,
      vh - READER_OVERLAY_MARGIN - rect.height,
    );
    root.style.top = `${Math.round(top)}px`;
  };

  // ── Save as annotation state ───────────────────────────────────────────
  let view: "thread" | "save" = "thread";
  let color = colors[0].hex;
  let colorsOpen = false;
  let saving = false;
  /** The payload of the last failed save; Save retries it unless edited. */
  let frozen: InlineAskSavePayload | null = null;

  const lastAnswerText = (): string => {
    const turns = session.getState().turns;
    for (let index = turns.length - 1; index >= 0; index--) {
      const turn = turns[index];
      if (
        turn.role === "assistant" &&
        turn.status === "done" &&
        turn.text.trim()
      )
        return turn.text;
    }
    return "";
  };
  const readBlockedReason = (): string | null => {
    try {
      return saveSetup?.blockedReason() ?? null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  /** Null when Save as annotation can open; else the tooltip ("" for none). */
  const saveUnavailable = (): string | null => {
    if (!saveSetup) return "";
    if (session.getState().phase !== "answered" || !lastAnswerText()) return "";
    return readBlockedReason();
  };
  const syncFooterSave = () => {
    const reason = saveUnavailable();
    setButtonDisabled(saveBtn, reason !== null);
    if (reason) saveBtn.setAttribute("title", reason);
    else saveBtn.removeAttribute("title");
  };
  const applyColor = (hex: string) => {
    color = hex;
    colorSquare.style.background = hex;
    mark.style.background = markBackground(hex);
    for (const dot of colorDots) {
      const selected =
        dot.getAttribute("data-llm-inline-ask-color-dot") === hex;
      dot.setAttribute("aria-pressed", selected ? "true" : "false");
      dot.style.boxShadow = selected ? `0 0 0 2px ${bg}, 0 0 0 3px ${fg}` : "";
    }
  };
  const setColorsOpen = (open: boolean) => {
    colorsOpen = open;
    show(colorRow, open, "flex");
    colorSquare.setAttribute("aria-expanded", open ? "true" : "false");
  };
  const showSaveError = (text: string) => {
    saveError.textContent = text;
    show(saveError, Boolean(text));
  };
  const syncSaveButtons = () => {
    setButtonDisabled(confirmSaveBtn, saving);
    setButtonDisabled(cancelSaveBtn, saving);
    setButtonDisabled(backBtn, saving);
  };
  const applyView = () => {
    const inSave = view === "save";
    root.setAttribute("data-view", view);
    show(saveView, inSave, "flex");
    if (!inSave) return;
    closeMenus();
    for (const node of [
      quoteSection,
      thread,
      field,
      notice,
      pills,
      promptEditor,
    ])
      show(node, false);
  };

  // ── Continue in sidebar state ──────────────────────────────────────────
  let continuing = false;
  let sidebarErrorText = "";
  const continueTurns = () => finishedInlineAskTurns(session.getState().turns);
  const canContinue = () =>
    Boolean(input.continueInSidebar) &&
    !continuing &&
    view === "thread" &&
    session.getState().phase === "answered" &&
    continueTurns().length > 0;
  const syncSidebar = () => {
    setButtonDisabled(sidebarBtn, !canContinue());
    // A move in flight cannot be discarded: the sidebar would still show
    // the chat the user threw away.
    setButtonDisabled(discardBtn, continuing);
    sidebarError.textContent = sidebarErrorText;
    show(
      sidebarError,
      Boolean(sidebarErrorText) &&
        view === "thread" &&
        session.getState().phase === "answered",
    );
  };
  const runContinue = () => {
    const run = input.continueInSidebar;
    if (!run || !canContinue()) return;
    const turns = continueTurns();
    continuing = true;
    sidebarErrorText = "";
    syncSidebar();
    syncSend();
    let pending: ReturnType<InlineAskContinueInSidebar>;
    try {
      pending = run(turns);
    } catch (error) {
      pending = Promise.reject(error);
    }
    void pending
      .then(
        (result) => result,
        (error): { ok: false; error: string } => ({
          ok: false,
          error:
            error instanceof Error && error.message
              ? error.message
              : String(error || ""),
        }),
      )
      .then((result) => {
        if (closed) return;
        continuing = false;
        if (result.ok) {
          // The sidebar shows the conversation now.
          close();
          return;
        }
        sidebarErrorText = result.error;
        syncSidebar();
        syncSend();
      });
  };

  const render = (state: InlineAskState) => {
    const { phase, turns } = state;
    root.setAttribute("data-phase", phase);
    turns.forEach(renderTurn);
    show(thread, turns.length > 0, "flex");
    syncQuote();
    show(reading, phase === "waiting");
    const canType = phase === "compose" || phase === "answered";
    show(field, canType, "flex");
    show(pills, phase === "compose", "flex");
    if (phase !== lastPhase) {
      // A question leaves compose: the pill editor and any menu close.
      closeMenus();
      if (phase !== "compose") editingPrompt = null;
      renderPills();
    }
    syncPromptEditor();
    show(footer, phase !== "compose", "flex");
    textBox.setPlaceholder(
      phase === "compose" ? labels.placeholder : labels.followUpPlaceholder,
    );
    if (phase === "answered" && lastPhase !== "answered") {
      textBox.setText("");
      schedule(() => {
        if (closed) return;
        editor.focus({ preventScroll: true });
      }, 0);
    }
    if (phase !== "answered") sidebarErrorText = "";
    lastPhase = phase;
    syncSend();
    syncFooterSave();
    syncSidebar();
    applyView();
    thread.scrollTop = thread.scrollHeight;
    syncThreadFade();
    if (root.isConnected) keepInViewport();
  };

  // ── Text size ──────────────────────────────────────────────────────────
  const applyTextSize = () => {
    const atBottom =
      thread.scrollHeight - thread.scrollTop - thread.clientHeight < 4;
    for (const [node, base] of scaled) node.style.fontSize = sizePx(base);
    for (const pill of Array.from(pills.children)) {
      (pill as HTMLElement).style.fontSize = sizePx(12);
    }
    for (const entry of turnNodes) {
      if (entry) entry.node.style.fontSize = sizePx(entry.base);
    }
    root.setAttribute("data-text-size", String(textSize));
    syncQuote();
    if (atBottom) thread.scrollTop = thread.scrollHeight;
    syncThreadFade();
    if (editingPrompt) placePromptEditor();
    if (root.isConnected) keepInViewport();
    if (moreMenu) refreshMoreMenu();
  };
  const setTextSize = (size: number) => {
    if (size === textSize || !INLINE_ASK_TEXT_SIZES.includes(size)) return;
    textSize = size;
    applyTextSize();
    try {
      input.onTextSizeChange?.(size);
    } catch {
      // The size still applies to this card.
    }
  };
  /** Moves one step: 1 larger, -1 smaller, 0 back to 100. */
  const stepTextSize = (direction: number) => {
    if (direction === 0) {
      setTextSize(100);
      return;
    }
    const index = INLINE_ASK_TEXT_SIZES.indexOf(textSize);
    const next = INLINE_ASK_TEXT_SIZES[index + direction];
    if (next !== undefined) setTextSize(next);
  };
  root.setAttribute("data-text-size", String(textSize));

  const toggleMoreMenu = () => {
    if (openMenu?.kind === "more") {
      closeMenus();
      return;
    }
    closeMenus();
    showMoreMenu();
  };
  /** Opens above the button, right-aligned to it, in the card's coordinates. */
  const placeMoreMenu = () => {
    if (!openMenu || openMenu.kind !== "more") return;
    const node = openMenu.node;
    const rootRect = root.getBoundingClientRect();
    const buttonRect = moreBtn.getBoundingClientRect();
    const menuRect = node.getBoundingClientRect();
    const originX = rootRect.left + root.clientLeft;
    const originY = rootRect.top + root.clientTop;
    let top = buttonRect.top - originY - 4 - menuRect.height;
    // No room above the window's top edge: open below the button instead.
    if (buttonRect.top - 4 - menuRect.height < READER_OVERLAY_MARGIN) {
      top = buttonRect.bottom - originY + 4;
    }
    node.style.left = `${Math.max(
      0,
      Math.round(buttonRect.right - originX - menuRect.width),
    )}px`;
    node.style.top = `${Math.round(top)}px`;
  };
  const refreshMoreMenu = () => {
    const parts = moreMenu;
    if (!parts) return;
    parts.value.textContent = `${textSize}%`;
    const index = INLINE_ASK_TEXT_SIZES.indexOf(textSize);
    const atEnd = [index <= 0, index >= INLINE_ASK_TEXT_SIZES.length - 1];
    [parts.smaller, parts.larger].forEach((button, i) => {
      button.disabled = atEnd[i];
      button.style.color = atEnd[i] ? palette.fill3 : fg;
      button.style.cursor = atEnd[i] ? "default" : "pointer";
      button.style.background = "none";
    });
    parts.dots.forEach((dot, i) => {
      dot.style.background = i === index ? fg : palette.fill3;
    });
    // Reset stays in the menu, inactive at 100 percent: a row that came and
    // went would change the menu's height and move the A buttons under the
    // pointer between two clicks.
    const atDefault = textSize === 100;
    parts.reset.disabled = atDefault;
    parts.reset.style.color = atDefault ? palette.fill3 : fg;
    parts.reset.style.cursor = atDefault ? "default" : "pointer";
    parts.reset.style.pointerEvents = atDefault ? "none" : "";
  };
  const showMoreMenu = () => {
    const menu = el("div", menuPanelCss);
    menu.setAttribute("data-llm-inline-ask-more-menu", "true");
    menu.setAttribute("role", "menu");
    const heading = el("div", sectionCss);
    heading.setAttribute("data-llm-inline-ask-menu-section", "true");
    heading.textContent = labels.textSize;
    const row = el("div", [
      "display:flex",
      "align-items:center",
      "justify-content:space-between",
      "gap:6px",
    ]);
    const stepButton = (
      step: "smaller" | "larger",
      glyphSize: number,
      direction: number,
    ) => {
      const button = el("button", [
        "flex:none",
        // The glyph sits in the middle of the button, both ways.
        "display:inline-flex",
        "align-items:center",
        "justify-content:center",
        "text-align:center",
        "width:34px",
        "height:30px",
        "box-sizing:border-box",
        "margin:0",
        "padding:0",
        "border:none",
        "border-radius:7px",
        "background:none",
        `color:${fg}`,
        `font-family:${PAPER_FONT}`,
        `font-size:${glyphSize}px`,
        "line-height:1",
        "cursor:pointer",
      ]) as HTMLButtonElement;
      button.setAttribute("type", "button");
      button.setAttribute("role", "menuitem");
      button.setAttribute("data-llm-inline-ask-text-size-step", step);
      button.textContent = "A";
      addHover(
        button,
        () => {
          if (!button.disabled) button.style.background = palette.hover;
        },
        () => {
          button.style.background = "none";
        },
      );
      button.addEventListener("click", (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        if (button.disabled) return;
        stepTextSize(direction);
        refocusEditor();
      });
      return button;
    };
    const smaller = stepButton("smaller", 12, -1);
    const larger = stepButton("larger", 18, 1);
    const value = el("span", [
      "font-size:11px",
      `color:${palette.fill2}`,
      "font-variant-numeric:tabular-nums",
    ]);
    value.setAttribute("data-llm-inline-ask-text-size-value", "true");
    row.append(smaller, value, larger);
    const dotRow = el("div", [
      "display:flex",
      "justify-content:center",
      "gap:5px",
      "padding:0 0 3px",
    ]);
    const dots = INLINE_ASK_TEXT_SIZES.map(() =>
      el("span", ["width:5px", "height:5px", "border-radius:50%"]),
    );
    dotRow.append(...dots);
    const reset = menuOption(
      "data-llm-inline-ask-text-size-step",
      "reset",
      labels.resetTextSize,
      false,
      () => {
        stepTextSize(0);
        refocusEditor();
      },
    );
    reset.setAttribute("role", "menuitem");
    reset.removeAttribute("aria-checked");
    menu.append(heading, row, dotRow, reset);
    moreBtn.setAttribute("aria-expanded", "true");
    moreBtn.style.color = fg;
    mountMenu("more", menu, 0, 0);
    moreMenu = { value, smaller, larger, dots, reset };
    refreshMoreMenu();
    // Placed once: a size step grows the card under the menu, and a menu
    // that followed the More button would move the A buttons between clicks.
    placeMoreMenu();
  };
  /** After a menu click the editor takes the keys again. */
  const refocusEditor = () => {
    schedule(() => {
      if (closed || editingPrompt || view !== "thread") return;
      editor.focus({ preventScroll: true });
    }, 0);
  };

  const openSaveView = (): boolean => {
    if (view === "save" || saveUnavailable() !== null) return false;
    const draft = frozen ?? {
      color: colors[0].hex,
      comment: inlineAskAnswerToPlainText(lastAnswerText()),
    };
    applyColor(draft.color);
    commentBox.setText(draft.comment);
    setColorsOpen(false);
    showSaveError("");
    syncSaveButtons();
    view = "save";
    render(session.getState());
    schedule(() => {
      if (closed || view !== "save") return;
      commentBox.editor.focus({ preventScroll: true });
      commentBox.placeCaretAtEnd();
    }, 0);
    return true;
  };
  const closeSaveView = () => {
    if (view !== "save" || saving) return;
    view = "thread";
    render(session.getState());
    schedule(() => {
      if (closed || view !== "thread") return;
      editor.focus({ preventScroll: true });
    }, 0);
  };
  const runSave = () => {
    if (!saveSetup || view !== "save" || saving) return;
    const reason = readBlockedReason();
    if (reason) {
      showSaveError(reason);
      return;
    }
    const payload: InlineAskSavePayload = {
      color,
      comment: commentBox.readText().trim(),
    };
    frozen = payload;
    saving = true;
    showSaveError("");
    syncSaveButtons();
    let pending: Promise<InlineAskSaveResult>;
    try {
      pending = saveSetup.save({ ...payload });
    } catch (error) {
      pending = Promise.reject(error);
    }
    void pending
      .then(
        (result) => result,
        (error): InlineAskSaveResult => ({
          ok: false,
          error:
            error instanceof Error && error.message
              ? error.message
              : String(error || ""),
        }),
      )
      .then((result) => {
        if (closed) return;
        saving = false;
        if (result.ok) {
          // The highlight now shows natively; the card's work is done.
          close();
          return;
        }
        syncSaveButtons();
        showSaveError(result.error);
      });
  };

  // ── Events ─────────────────────────────────────────────────────────────
  let closed = false;
  let pointerDocs: Document[] = [];
  const sendTyped = () => {
    if (!canSendNow()) return;
    const text = textBox.readText().trim();
    if (!text) return;
    if (session.send(text)) textBox.setText("");
  };
  const onDocPointerDown = (e: Event) => {
    const target = e.target as Node | null;
    if (target && root.contains(target)) return;
    closeMenus();
    // Once a question exists, a click elsewhere keeps the conversation.
    if (session.hasConversation()) return;
    close();
  };
  // Escape steps back one level: an open menu, then the prompt editor, then
  // the save view, and last the card itself.
  const handleEscape = () => {
    if (openMenu) {
      closeMenus();
      return;
    }
    if (editingPrompt && view === "thread") {
      closePromptEditor(true);
      return;
    }
    if (view === "save") {
      closeSaveView();
      return;
    }
    // Not while Continue in sidebar moves the conversation (see Discard).
    if (continuing) return;
    close();
  };
  // Escape from the page or a reader view: keys outside the card never reach
  // onKeyDown, so the card would stay open until the user clicked into it.
  const onDocKeyDown = (e: Event) => {
    const keyEvent = e as KeyboardEvent;
    if (classifySelectionPromptKey(keyEvent) !== "close") return;
    const target = e.target as Node | null;
    if (target && root.contains(target)) return;
    e.preventDefault();
    e.stopPropagation();
    handleEscape();
  };
  // Zotero's window handles Cmd/Ctrl + = - 0 before the reader page sees
  // them, so the card takes them in the window that holds the reader, while
  // the key comes from inside the card.
  const chromeWin = ((): Window | null => {
    try {
      const top = (
        doc.defaultView as unknown as {
          browsingContext?: { topChromeWindow?: Window | null };
        } | null
      )?.browsingContext?.topChromeWindow;
      if (top) return top;
    } catch {
      // Not reachable from here; the reader instance knows its window.
    }
    try {
      const readers = (
        Zotero.Reader as unknown as {
          _readers?: Array<{ _iframeWindow?: Window; _window?: Window }>;
        }
      )._readers;
      const reader = readers?.find((candidate) => {
        const readerDoc = candidate._iframeWindow?.document;
        return Boolean(readerDoc && readerDoc.isSameNode(doc));
      });
      return reader?._window ?? null;
    } catch {
      return null;
    }
  })();
  const onChromeKeyDown = (e: Event) => {
    const direction = textSizeKeyDirection(e as KeyboardEvent);
    if (direction === null) return;
    const target = e.target as Node | null;
    if (!target || !root.contains(target)) return;
    e.preventDefault();
    e.stopPropagation();
    stepTextSize(direction);
  };
  const onKeyDown = (e: Event) => {
    const keyEvent = e as KeyboardEvent;
    const action = classifySelectionPromptKey(keyEvent);
    const modEnter =
      action === "submit" && Boolean(keyEvent.metaKey || keyEvent.ctrlKey);
    // Keeps bubble-phase listeners above the card out. The reader's window
    // capture listeners have already run; see createReaderOverlayEditor.
    e.stopPropagation();
    // Cmd/Ctrl with + - 0 sets the card's text size, not the reader's zoom.
    const direction = textSizeKeyDirection(keyEvent);
    if (direction !== null) {
      e.preventDefault();
      stepTextSize(direction);
      return;
    }
    if (action === "close") {
      e.preventDefault();
      handleEscape();
      return;
    }
    if (editingPrompt && view === "thread") {
      const target = e.target as Node | null;
      if (target && labelInput.contains(target)) {
        // Enter in Label saves; other keys type.
        if (action === "submit") {
          e.preventDefault();
          savePrompt();
        }
        return;
      }
      if (target && promptBox.editor.contains(target)) {
        // Mod+Enter in Prompt saves; Enter is a new line.
        if (modEnter) {
          e.preventDefault();
          savePrompt();
        }
        return;
      }
    }
    if (view === "save") {
      // Mod+Enter saves; a plain Enter is a new line in the comment (or the
      // focused button's own key).
      if (modEnter) {
        e.preventDefault();
        runSave();
      }
      return;
    }
    if (modEnter && session.getState().phase === "answered") {
      // Mod+Enter on an answer opens the save view; it never sends.
      e.preventDefault();
      openSaveView();
      return;
    }
    if (action !== "submit") return;
    const target = e.target as Node | null;
    // Enter on a button belongs to the button.
    if (!target || !editor.contains(target)) return;
    e.preventDefault();
    sendTyped();
  };
  const stop = (e: Event) => e.stopPropagation();
  const onSendClick = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    sendTyped();
  };
  const onDiscardClick = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    if (continuing) return;
    close();
  };
  const onSaveClick = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    openSaveView();
  };
  const onSidebarClick = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    runContinue();
  };
  const clickActions: Array<[HTMLElement, () => void]> = [
    [colorSquare, () => setColorsOpen(!colorsOpen)],
    [backBtn, closeSaveView],
    [cancelSaveBtn, closeSaveView],
    [confirmSaveBtn, runSave],
    ...colorDots.map((dot): [HTMLElement, () => void] => [
      dot,
      () => applyColor(dot.getAttribute("data-llm-inline-ask-color-dot")!),
    ]),
  ];
  const saveViewListeners = clickActions.map(
    ([node, run]): [HTMLElement, (e: Event) => void] => [
      node,
      (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        run();
      },
    ],
  );
  const onRootPointerDown = (e: Event) => {
    swallowPillClick = false;
    // A press outside the floating editor cancels it (the right-click menu
    // that Edit or Add came from is already closed by then).
    const pressed = e.target as Node | null;
    if (
      editingPrompt &&
      pressed &&
      !promptEditor.contains(pressed) &&
      !(openMenu && openMenu.node.contains(pressed))
    ) {
      closePromptEditor(false);
      if (pills.contains(pressed)) swallowPillClick = true;
    }
    const menu = openMenu;
    if (!menu) return;
    const target = e.target as Node | null;
    if (target && menu.node.contains(target)) return;
    // The model and effort buttons toggle their own menu on click.
    if (
      menu.kind !== "prompt" &&
      target &&
      (modelLabel.contains(target) ||
        effortLabel.contains(target) ||
        moreBtn.contains(target))
    )
      return;
    closeMenus();
    if (menu.kind === "prompt" && target && pills.contains(target)) {
      swallowPillClick = true;
    }
  };
  const findPill = (target: unknown): HTMLElement | null => {
    for (
      let node = target as HTMLElement | null;
      node && node !== pills;
      node = node.parentNode as HTMLElement | null
    ) {
      if (
        typeof node.getAttribute === "function" &&
        node.getAttribute("data-llm-inline-ask-pill") !== null
      )
        return node;
    }
    return null;
  };
  const onPillsClick = (e: Event) => {
    const pill = findPill(e.target);
    if (!pill) return;
    e.preventDefault();
    e.stopPropagation();
    if (swallowPillClick) {
      swallowPillClick = false;
      return;
    }
    // Pills belong to the first question; they hide after it. While the
    // prompt editor is open a pill does not send.
    if (!hasModel() || editingPrompt) return;
    if (session.getState().phase !== "compose") return;
    const prompt = shownPrompts.find(
      (entry) => entry.id === pill.getAttribute("data-llm-inline-ask-pill"),
    );
    if (prompt) session.send(prompt.prompt, prompt.label);
  };
  const onPillsContextMenu = (e: Event) => {
    if (!promptSetup || session.getState().phase !== "compose") return;
    e.preventDefault();
    e.stopPropagation();
    const pill = findPill(e.target);
    const mouse = e as MouseEvent;
    const rootRect = root.getBoundingClientRect();
    // The floating editor starts near the clicked word (or the click).
    editAnchorX = pill
      ? pill.getBoundingClientRect().left - rootRect.left
      : (Number(mouse.clientX) || rootRect.left) - rootRect.left;
    openPromptMenu(
      pill?.getAttribute("data-llm-inline-ask-pill") || null,
      (Number(mouse.clientX) || rootRect.left) - rootRect.left,
      (Number(mouse.clientY) || rootRect.top) - rootRect.top,
    );
  };
  const onModelClick = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    toggleModelMenu("model");
  };
  const onEffortClick = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    toggleModelMenu("effort");
  };
  const onMoreClick = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    toggleMoreMenu();
  };
  const onCancelPromptClick = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    closePromptEditor(true);
  };
  const onSavePromptClick = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    savePrompt();
  };
  const focusBorder = (node: HTMLElement) => ({
    focus: () => {
      node.style.borderColor = palette.accent;
    },
    blur: () => {
      node.style.borderColor = "transparent";
    },
  });
  const labelFocus = focusBorder(labelInput);
  const promptFocus = focusBorder(promptBox.editor);
  // A click on the empty space of the composer box focuses the field.
  const onFieldMouseDown = (e: Event) => {
    const target = e.target as Node | null;
    if (!target || editor.contains(target)) return;
    for (const control of [modelLabel, effortLabel, moreBtn, sendBtn]) {
      if (control.contains(target)) return;
    }
    e.preventDefault();
    editor.focus({ preventScroll: true });
    textBox.placeCaretAtEnd();
  };

  // ── Move and resize by dragging ────────────────────────────────────────
  type Drag = {
    kind: "move" | "resize";
    /** The grabbed corner, for a resize. */
    corner: ResizeCorner | null;
    pointerId: number;
    startX: number;
    startY: number;
    startLeft: number;
    startTop: number;
    startWidth: number;
    startBottom: number;
    /** The answer area's max height at the start, and its room to grow. */
    startThreadMax: number;
    threadLimit: number;
    /** Room to grow upward, for a top corner. */
    topLimit: number;
  };
  let drag: Drag | null = null;
  /** The answer area's max height once the user has set it. */
  let chosenThreadMax: number | null = null;
  const viewSize = () => ({
    vw: doc.defaultView?.innerWidth ?? 800,
    vh: doc.defaultView?.innerHeight ?? 600,
  });
  // A real event's target is a different wrapper of the same node than the
  // one this code holds, so compare nodes, not references.
  const isNode = (node: Node, target: unknown) => {
    try {
      return Boolean(target) && node.isSameNode(target as Node);
    } catch {
      return false;
    }
  };
  // The composer's empty space focuses the field instead (onFieldMouseDown).
  const isBlankTarget = (target: unknown) =>
    isNode(root, target) || isNode(pills, target);
  const threadMaxNow = () => {
    if (chosenThreadMax !== null) return chosenThreadMax;
    const computed = parseFloat(
      doc.defaultView?.getComputedStyle(thread)?.maxHeight || "",
    );
    return Number.isFinite(computed)
      ? computed
      : thread.getBoundingClientRect().height;
  };
  const endDrag = () => {
    const ending = drag;
    if (!ending) return;
    drag = null;
    syncResizeArcs();
    root.style.cursor = "";
    root.style.userSelect = "text";
    root.style.setProperty("-moz-user-select", "text");
    try {
      root.releasePointerCapture(ending.pointerId);
    } catch {
      // Not captured (or already released).
    }
    doc.removeEventListener("pointermove", onDragMove, true);
    doc.removeEventListener("pointerup", onDragEnd, true);
    doc.removeEventListener("pointercancel", onDragEnd, true);
  };
  const onDragMove = (e: Event) => {
    const pointer = e as PointerEvent;
    const current = drag;
    if (!current || pointer.pointerId !== current.pointerId) return;
    e.preventDefault();
    const dx = pointer.clientX - current.startX;
    const dy = pointer.clientY - current.startY;
    const { vw, vh } = viewSize();
    if (current.kind === "move") {
      const rect = root.getBoundingClientRect();
      const left = Math.max(
        READER_OVERLAY_MARGIN,
        Math.min(
          current.startLeft + dx,
          vw - READER_OVERLAY_MARGIN - rect.width,
        ),
      );
      const top = Math.max(
        READER_OVERLAY_MARGIN,
        Math.min(
          current.startTop + dy,
          vh - READER_OVERLAY_MARGIN - rect.height,
        ),
      );
      root.style.left = `${Math.round(left)}px`;
      root.style.top = `${Math.round(top)}px`;
      return;
    }
    const corner = current.corner ?? "bottom-right";
    const startRight = current.startLeft + current.startWidth;
    if (corner.endsWith("left")) {
      // The right edge stays; the left edge follows the pointer.
      const width = Math.max(
        MIN_CARD_WIDTH,
        Math.min(current.startWidth - dx, startRight - READER_OVERLAY_MARGIN),
      );
      root.style.width = `${Math.round(width)}px`;
      root.style.left = `${Math.round(startRight - width)}px`;
    } else {
      const left = parseFloat(root.style.left) || current.startLeft;
      const width = Math.max(
        MIN_CARD_WIDTH,
        Math.min(current.startWidth + dx, vw - READER_OVERLAY_MARGIN - left),
      );
      root.style.width = `${Math.round(width)}px`;
    }
    if (corner.startsWith("top")) {
      // The bottom edge stays; the top edge follows the answer area's height.
      // Without an answer area there is nothing to resize.
      if (doc.defaultView?.getComputedStyle(thread)?.display === "none") {
        syncThreadFade();
        return;
      }
      chosenThreadMax = Math.round(
        Math.max(80, Math.min(current.startThreadMax - dy, current.topLimit)),
      );
      thread.style.maxHeight = `${chosenThreadMax}px`;
      const height = root.getBoundingClientRect().height;
      root.style.top = `${Math.round(
        Math.max(READER_OVERLAY_MARGIN, current.startBottom - height),
      )}px`;
    } else {
      chosenThreadMax = Math.round(
        Math.max(
          80,
          Math.min(current.startThreadMax + dy, current.threadLimit),
        ),
      );
      thread.style.maxHeight = `${chosenThreadMax}px`;
    }
    syncThreadFade();
  };
  const onDragEnd = (e: Event) => {
    if (drag && (e as PointerEvent).pointerId !== drag.pointerId) return;
    endDrag();
    if (root.isConnected) keepInViewport();
  };
  const onCardPointerDown = (e: Event) => {
    const pointer = e as PointerEvent;
    if (drag || pointer.button !== 0 || pointer.isPrimary === false) return;
    let corner: ResizeCorner | null = null;
    for (const [name, node] of resizeGrips) {
      if (node.contains(pointer.target as Node | null)) corner = name;
    }
    const grip = corner !== null;
    if (!grip && !isBlankTarget(pointer.target)) return;
    const rect = root.getBoundingClientRect();
    const { vh } = viewSize();
    const threadHeight = thread.getBoundingClientRect().height;
    const startThreadMax = threadMaxNow();
    // Growing the answer area may not push the card's bottom out of view.
    const room = vh - READER_OVERLAY_MARGIN - rect.bottom;
    const threadLimit =
      threadHeight + room >= thread.scrollHeight
        ? Number.POSITIVE_INFINITY
        : threadHeight + room;
    // Growing it upward may not push the card's top out of view.
    const roomAbove = rect.top - READER_OVERLAY_MARGIN;
    const topLimit =
      threadHeight + roomAbove >= thread.scrollHeight
        ? Number.POSITIVE_INFINITY
        : threadHeight + roomAbove;
    drag = {
      kind: grip ? "resize" : "move",
      corner,
      pointerId: pointer.pointerId,
      startX: pointer.clientX,
      startY: pointer.clientY,
      startLeft: rect.left,
      startTop: rect.top,
      startWidth: rect.width,
      startBottom: rect.bottom,
      startThreadMax,
      threadLimit,
      topLimit,
    };
    syncResizeArcs();
    // No text selection while dragging.
    root.style.userSelect = "none";
    root.style.setProperty("-moz-user-select", "none");
    if (!grip) root.style.cursor = "grabbing";
    try {
      root.setPointerCapture(pointer.pointerId);
    } catch {
      // The document listeners below carry the drag without capture.
    }
    doc.addEventListener("pointermove", onDragMove, true);
    doc.addEventListener("pointerup", onDragEnd, true);
    doc.addEventListener("pointercancel", onDragEnd, true);
  };
  // The grab cursor shows over the card's own blank padding only; text keeps
  // its text cursor.
  const onCardHover = (e: Event) => {
    if (drag) return;
    root.style.cursor = isNode(root, e.target) ? "grab" : "";
  };

  function close() {
    if (closed) return;
    closed = true;
    endDrag();
    // Remove the card and registry entry first: a dead nested document can
    // make the listener removals below throw.
    root.remove();
    releaseReaderOverlay(doc, handle);
    session.dispose();
    for (const pointerDoc of pointerDocs) {
      try {
        pointerDoc.removeEventListener("pointerdown", onDocPointerDown, true);
        pointerDoc.removeEventListener("keydown", onDocKeyDown, true);
      } catch {
        // The reader recreated that view; its listeners are gone with it.
      }
    }
    root.removeEventListener("keydown", onKeyDown);
    try {
      chromeWin?.removeEventListener("keydown", onChromeKeyDown, true);
    } catch {
      // The window closed with the reader.
    }
    root.removeEventListener("keyup", stop);
    root.removeEventListener("keypress", stop);
    sendBtn.removeEventListener("click", onSendClick);
    discardBtn.removeEventListener("click", onDiscardClick);
    saveBtn.removeEventListener("click", onSaveClick);
    sidebarBtn.removeEventListener("click", onSidebarClick);
    for (const [node, listener] of saveViewListeners)
      node.removeEventListener("click", listener);
    commentBox.detach();
    field.removeEventListener("mousedown", onFieldMouseDown);
    quoteSection.removeEventListener("click", onQuoteClick);
    quoteSection.removeEventListener("mouseenter", onQuoteEnter);
    quoteSection.removeEventListener("mouseleave", onQuoteLeave);
    thread.removeEventListener("scroll", syncThreadFade);
    moreBtn.removeEventListener("click", onMoreClick);
    textBox.detach();
    root.removeEventListener("pointerdown", onRootPointerDown);
    root.removeEventListener("pointerdown", onCardPointerDown);
    root.removeEventListener("pointermove", onCardHover);
    for (const [node, type, listener] of resizeListeners)
      node.removeEventListener(type, listener);
    pills.removeEventListener("click", onPillsClick);
    pills.removeEventListener("contextmenu", onPillsContextMenu);
    if (picker) {
      modelLabel.removeEventListener("click", onModelClick);
      effortLabel.removeEventListener("click", onEffortClick);
    }
    cancelPromptBtn.removeEventListener("click", onCancelPromptClick);
    savePromptBtn.removeEventListener("click", onSavePromptClick);
    labelInput.removeEventListener("focus", labelFocus.focus);
    labelInput.removeEventListener("blur", labelFocus.blur);
    promptBox.editor.removeEventListener("focus", promptFocus.focus);
    promptBox.editor.removeEventListener("blur", promptFocus.blur);
    promptBox.detach();
    input.onClose?.();
  }

  const handle: InlineAskOverlayHandle = {
    close,
    root,
    session,
    hasConversation: () => session.hasConversation(),
    keepsOpenOnNewSelection: () => session.hasConversation(),
  };

  (doc.body || doc.documentElement).appendChild(root);
  registerReaderOverlay(doc, handle);
  render(session.getState());
  positionReaderOverlay(root, doc, placementAnchor);

  pointerDocs = collectPointerDocuments(doc);
  for (const pointerDoc of pointerDocs) {
    pointerDoc.addEventListener("pointerdown", onDocPointerDown, true);
    pointerDoc.addEventListener("keydown", onDocKeyDown, true);
  }
  root.addEventListener("keydown", onKeyDown);
  chromeWin?.addEventListener("keydown", onChromeKeyDown, true);
  root.addEventListener("keyup", stop);
  root.addEventListener("keypress", stop);
  sendBtn.addEventListener("click", onSendClick);
  discardBtn.addEventListener("click", onDiscardClick);
  saveBtn.addEventListener("click", onSaveClick);
  sidebarBtn.addEventListener("click", onSidebarClick);
  for (const [node, listener] of saveViewListeners)
    node.addEventListener("click", listener);
  commentBox.attach();
  field.addEventListener("mousedown", onFieldMouseDown);
  quoteSection.addEventListener("click", onQuoteClick);
  quoteSection.addEventListener("mouseenter", onQuoteEnter);
  quoteSection.addEventListener("mouseleave", onQuoteLeave);
  thread.addEventListener("scroll", syncThreadFade);
  moreBtn.addEventListener("click", onMoreClick);
  textBox.attach();
  root.addEventListener("pointerdown", onRootPointerDown);
  root.addEventListener("pointerdown", onCardPointerDown);
  root.addEventListener("pointermove", onCardHover);
  pills.addEventListener("click", onPillsClick);
  pills.addEventListener("contextmenu", onPillsContextMenu);
  if (picker) {
    modelLabel.addEventListener("click", onModelClick);
    effortLabel.addEventListener("click", onEffortClick);
  }
  cancelPromptBtn.addEventListener("click", onCancelPromptClick);
  savePromptBtn.addEventListener("click", onSavePromptClick);
  labelInput.addEventListener("focus", labelFocus.focus);
  labelInput.addEventListener("blur", labelFocus.blur);
  promptBox.editor.addEventListener("focus", promptFocus.focus);
  promptBox.editor.addEventListener("blur", promptFocus.blur);
  promptBox.attach();
  // Deferred so focus lands after the popup's pointerdown handler finishes.
  schedule(() => {
    if (closed) return;
    editor.focus({ preventScroll: true });
  }, 0);
  return handle;
}
