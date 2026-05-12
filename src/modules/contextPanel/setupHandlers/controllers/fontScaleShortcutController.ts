import {
  FONT_SCALE_DEFAULT_PERCENT,
  FONT_SCALE_MAX_PERCENT,
  FONT_SCALE_MIN_PERCENT,
  FONT_SCALE_STEP_PERCENT,
} from "../../constants";
import { applyPanelFontScale } from "../../prefHelpers";
import { panelFontScalePercent, setPanelFontScalePercent } from "../../state";
import { clampNumber } from "../../textUtils";

export function attachFontScaleShortcutController(panelDoc: Document): void {
  if (
    (panelDoc as unknown as { __llmFontScaleShortcut?: boolean })
      .__llmFontScaleShortcut
  ) {
    return;
  }

  const isEventWithinActivePanel = (event: Event) => {
    const panel = panelDoc.querySelector("#llm-main") as HTMLElement | null;
    if (!panel) return null;
    const standaloneRoot = panelDoc.getElementById(
      "llmforzotero-standalone-chat-root",
    ) as HTMLElement | null;
    if (standaloneRoot) return panel;
    const target = event.target as Node | null;
    const activeEl = panelDoc.activeElement;
    const inPanel = Boolean(
      (target && panel.contains(target)) ||
      (activeEl && panel.contains(activeEl)),
    );
    return inPanel ? panel : null;
  };

  const applyDelta = (
    event: Event,
    delta: number | null,
    reset: boolean = false,
  ) => {
    if (!reset && delta === null) return;
    const panel = isEventWithinActivePanel(event);
    if (!panel) return;
    setPanelFontScalePercent(
      reset
        ? FONT_SCALE_DEFAULT_PERCENT
        : clampNumber(
            panelFontScalePercent + (delta || 0),
            FONT_SCALE_MIN_PERCENT,
            FONT_SCALE_MAX_PERCENT,
          ),
    );
    event.preventDefault();
    event.stopPropagation();
    applyPanelFontScale(panel);
    const standaloneRoot = panelDoc.getElementById(
      "llmforzotero-standalone-chat-root",
    ) as HTMLElement | null;
    if (standaloneRoot) applyPanelFontScale(standaloneRoot);
  };

  panelDoc.addEventListener(
    "keydown",
    (event: Event) => {
      const keyboardEvent = event as KeyboardEvent;
      if (
        !(keyboardEvent.metaKey || keyboardEvent.ctrlKey) ||
        keyboardEvent.altKey
      ) {
        return;
      }

      if (
        keyboardEvent.key === "+" ||
        keyboardEvent.key === "=" ||
        keyboardEvent.code === "Equal" ||
        keyboardEvent.code === "NumpadAdd"
      ) {
        applyDelta(keyboardEvent, FONT_SCALE_STEP_PERCENT);
      } else if (
        keyboardEvent.key === "-" ||
        keyboardEvent.key === "_" ||
        keyboardEvent.code === "Minus" ||
        keyboardEvent.code === "NumpadSubtract"
      ) {
        applyDelta(keyboardEvent, -FONT_SCALE_STEP_PERCENT);
      } else if (
        keyboardEvent.key === "0" ||
        keyboardEvent.code === "Digit0" ||
        keyboardEvent.code === "Numpad0"
      ) {
        applyDelta(keyboardEvent, null, true);
      }
    },
    true,
  );

  panelDoc.addEventListener(
    "command",
    (event: Event) => {
      const target = event.target as Element | null;
      const commandId = target?.id || "";
      if (
        commandId === "cmd_fullZoomEnlarge" ||
        commandId === "cmd_textZoomEnlarge"
      ) {
        applyDelta(event, FONT_SCALE_STEP_PERCENT);
      } else if (
        commandId === "cmd_fullZoomReduce" ||
        commandId === "cmd_textZoomReduce"
      ) {
        applyDelta(event, -FONT_SCALE_STEP_PERCENT);
      } else if (
        commandId === "cmd_fullZoomReset" ||
        commandId === "cmd_textZoomReset"
      ) {
        applyDelta(event, null, true);
      }
    },
    true,
  );

  (
    panelDoc as unknown as { __llmFontScaleShortcut?: boolean }
  ).__llmFontScaleShortcut = true;
}
