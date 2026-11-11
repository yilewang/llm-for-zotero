/**
 * Click actions for start-page tip rows (`data-start-tip-action`).
 * One delegated listener per chat box; the rows come from src/utils/i18n.ts.
 */
import { PREFERENCES_PANE_ID } from "./constants";
import { openPluginPreferencesTab } from "../../utils/preferencesStartTab";

const EXTENSION_URL = "https://github.com/yilewang/sync-for-zotero/releases";
const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;

const wiredChatBoxes = new WeakSet<Element>();

function launchUrl(url: string): void {
  (Zotero as unknown as { launchURL?: (url: string) => void }).launchURL?.(url);
}

function insertAtSign(input: HTMLTextAreaElement): void {
  const win = input.ownerDocument.defaultView;
  if (!win || input.disabled) return;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  input.value = `${input.value.slice(0, start)}@${input.value.slice(end)}`;
  input.setSelectionRange(start + 1, start + 1);
  input.focus({ preventScroll: true });
  // The same event typing produces; the paper picker reads the caret on it.
  input.dispatchEvent(
    new win.InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: "@",
    }),
  );
}

function runAction(action: string, domain: string, body: Element): void {
  const input = body.querySelector("#llm-input") as HTMLTextAreaElement | null;
  switch (action) {
    case "insert-at":
      if (input) insertAtSign(input);
      return;
    case "focus-input":
      if (input && !input.disabled) input.focus({ preventScroll: true });
      return;
    case "screenshot": {
      const button = body.querySelector(
        "#llm-screenshot",
      ) as HTMLButtonElement | null;
      if (button && !button.disabled) button.click();
      return;
    }
    case "prefs:mineru":
      openPluginPreferencesTab(PREFERENCES_PANE_ID, "mineru");
      return;
    case "prefs:agent":
      openPluginPreferencesTab(PREFERENCES_PANE_ID, "agent");
      return;
    case "open-site":
      if (DOMAIN_PATTERN.test(domain)) launchUrl(`https://${domain}`);
      return;
    case "open-extension":
      launchUrl(EXTENSION_URL);
      return;
  }
}

export function wireStartPageTipActions(chatBox: Element, body: Element): void {
  if (wiredChatBoxes.has(chatBox)) return;
  wiredChatBoxes.add(chatBox);
  const activate = (event: Event) => {
    const target = event.target as Element | null;
    const row = target?.closest?.(
      "[data-start-tip-action]",
    ) as HTMLElement | null;
    if (!row || !chatBox.contains(row)) return;
    event.preventDefault();
    try {
      runAction(
        row.dataset.startTipAction || "",
        row.dataset.startTipDomain || "",
        body,
      );
    } catch (error) {
      ztoolkit.log("LLM: start page tip action failed", error);
    }
  };
  chatBox.addEventListener("click", activate);
  // The rows are role="button" list items, so Enter and Space act as a click.
  chatBox.addEventListener("keydown", (event: Event) => {
    const key = (event as KeyboardEvent).key;
    if (key === "Enter" || key === " ") activate(event);
  });
}
