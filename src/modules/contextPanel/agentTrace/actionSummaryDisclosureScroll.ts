import { closestElement } from "../chatScrollGeometry";
import {
  cancelChatNavigation,
  cancelChatScrollFollow,
} from "../chatScrollSnapshots";

/** Bind before the control's disclosure handler, so its old layout is saved. */
export function bindActionSummaryDisclosureScroll(control: HTMLElement): void {
  control.addEventListener("click", (event) => {
    // Object chips navigate independently and prevent the native disclosure
    // action. Keyboard/assistive activation still reaches this click handler.
    if (
      event.defaultPrevented ||
      closestElement(event.target as Element | null, ".llm-agent-action-link")
    )
      return;
    const chatBox = closestElement(
      control,
      "#llm-chat-box",
    ) as HTMLDivElement | null;
    const root =
      chatBox && (closestElement(chatBox, "#llm-main") as HTMLElement | null);
    const key = Number(root?.dataset.itemId);
    if (!chatBox || !Number.isFinite(key) || key <= 0) return;
    // An explicit activation means the reader wants to inspect this card.
    // A toggle listener runs too late, after native expansion and lazy detail
    // rendering. Programmatic expansion must keep its existing scroll intent.
    cancelChatNavigation(chatBox);
    cancelChatScrollFollow(key, chatBox);
  });
}
