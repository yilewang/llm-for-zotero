/**
 * The "Add side chat" item at the end of the main chat's "/" menu.
 *
 * The item and its separator are hidden unless the panel body registers a
 * `sideChatSlashItem` provider (see chatPanelExtensions). Each time the menu
 * opens, the item reads the provider's state: disabled with a "start first"
 * hint when no side chat has an answer, enabled with an "attach" hint naming
 * the side chat otherwise.
 */
import { t } from "../../utils/i18n";
import {
  getChatPanelExtensions,
  type ChatPanelSideChatSlashItem,
} from "./chatPanelExtensions";

export const SIDE_CHAT_SLASH_ITEM_ID = "llm-slash-side-chat-option";
export const SIDE_CHAT_SLASH_SEPARATOR_ATTR = "data-slash-side-chat-separator";

export type SideChatSlashItemView = {
  visible: boolean;
  disabled: boolean;
  /** An English i18n key; "{title}" stands for `title`. */
  hint: string;
  title: string;
};

type ProviderState = { available: boolean; title: string };

/** No provider: hidden. Provider without an answered side chat: disabled. */
export function resolveSideChatSlashItemView(
  state: { available: boolean; title?: string } | null,
): SideChatSlashItemView {
  if (!state) {
    return { visible: false, disabled: true, hint: "", title: "" };
  }
  return state.available
    ? {
        visible: true,
        disabled: false,
        hint: "Attach \u201c{title}\u201d as context",
        title: String(state.title || "").trim(),
      }
    : {
        visible: true,
        disabled: true,
        hint: "Start a side chat first",
        title: "",
      };
}

function readProviderState(
  provider: ChatPanelSideChatSlashItem | undefined,
): ProviderState | null {
  if (!provider) return null;
  try {
    const state = provider.getState();
    return {
      available: state.available === true,
      title: String(state.title || ""),
    };
  } catch {
    return { available: false, title: "" };
  }
}

/** Applies the provider's current state to the item and its separator. */
export function syncSideChatSlashItem(
  body: Element,
  slashMenu: Element | null,
): void {
  if (!slashMenu) return;
  const button = slashMenu.querySelector(
    `#${SIDE_CHAT_SLASH_ITEM_ID}`,
  ) as HTMLButtonElement | null;
  if (!button) return;
  const separator = slashMenu.querySelector(
    `[${SIDE_CHAT_SLASH_SEPARATOR_ATTR}]`,
  ) as HTMLElement | null;
  const view = resolveSideChatSlashItemView(
    readProviderState(getChatPanelExtensions(body)?.sideChatSlashItem),
  );
  const display = view.visible ? "" : "none";
  button.style.display = display;
  if (separator) separator.style.display = display;
  button.disabled = view.disabled;
  button.setAttribute("aria-disabled", view.disabled ? "true" : "false");
  const hint = button.querySelector(
    ".llm-action-picker-hint",
  ) as HTMLElement | null;
  const hintText = view.hint
    ? t(view.hint).replace("{title}", view.title || t("Side chat"))
    : "";
  if (hint) hint.textContent = hintText;
  button.title = hintText;
}

/** Runs the provider's attach action when the item is enabled. */
export function attachSideChatFromSlashItem(body: Element): boolean {
  const provider = getChatPanelExtensions(body)?.sideChatSlashItem;
  if (!readProviderState(provider)?.available) return false;
  provider!.attach();
  return true;
}
