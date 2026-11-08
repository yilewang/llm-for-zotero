import type { StandaloneConversationSwitchDecision } from "./standaloneConversationSwitch";

/**
 * The typed surface a mounted panel publishes for code outside its setup
 * closure. setupHandlers publishes one handle per setup and unpublishes it at
 * cleanup; readers look it up by panel body.
 */
export type PanelHandle = {
  /** Re-derive the auto-loaded context source for the panel's current item. */
  refreshContextSourceForCurrentItem(): void;
  /**
   * Add Zotero items as default context to the panel's current conversation
   * (no new conversation), the way Zotero's "Add as context" action does.
   */
  addItemsAsDefaultContext(items: Zotero.Item[]): Promise<void> | void;
  /**
   * Add text as a removable selected-text chip, sent with the panel's next
   * message. Returns whether a chip was added (false for empty text, a
   * duplicate, a full chip list, or a panel with no conversation).
   * `question` is set as the chip's question, also on a duplicate chip.
   */
  addTextContext(
    text: string,
    opts: {
      source: "model" | "sidechat";
      focusInput?: boolean;
      question?: string;
    },
  ): boolean;
  /** Show the reasoning effort that the Claude runtime resolved. */
  applyResolvedClaudeEffort(effort: unknown): void;
  /**
   * Move a mounted paper chat to another paper's chat in place, after Zotero
   * rebound the panel host to that paper. Returns false, changing nothing,
   * when the panel is in a state only a full remount handles; the caller then
   * rebuilds. On true the panel draws the new conversation itself, once;
   * when it cannot, it calls `rebuild` for the host's full remount.
   */
  switchToPaperItem(
    nextItem: Zotero.Item,
    nextBasePaperItem: Zotero.Item | null,
    rebuild: () => void,
  ): boolean;
  /**
   * The standalone window's own panel: whether it can move to `nextItem`'s
   * conversation in place, or why it needs a full remount
   * (standaloneConversationSwitch.ts). Changes nothing.
   */
  resolveConversationSwitch(
    nextItem: Zotero.Item,
  ): StandaloneConversationSwitchDecision;
  /**
   * The standalone window's own panel: moves to `nextItem`'s conversation in
   * place, through the panel's own history switch, and draws it once. The
   * history reload after it does not tell the window's list (the window
   * marks the row itself). Resolves false when the panel cannot move in
   * place, a newer switch overtook this one, or the switch was refused; the
   * caller then remounts if this is still its latest switch.
   */
  switchConversationInPlace(nextItem: Zotero.Item): Promise<boolean>;
};

const panelHandles = new WeakMap<Element, PanelHandle>();

export function publishPanelHandle(body: Element, handle: PanelHandle): void {
  panelHandles.set(body, handle);
}

export function getPanelHandle(body: Element): PanelHandle | undefined {
  return panelHandles.get(body);
}

/**
 * Removes the handle only if it is still the one this publisher set, so a
 * stale cleanup cannot remove the handle of a later setup on the same body.
 */
export function unpublishPanelHandle(body: Element, handle: PanelHandle): void {
  if (panelHandles.get(body) === handle) {
    panelHandles.delete(body);
  }
}
