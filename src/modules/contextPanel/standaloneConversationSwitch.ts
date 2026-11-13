/**
 * Whether the standalone window can move its mounted panel to another
 * conversation in place, or must rebuild the panel (a full remount).
 *
 * In place, the panel keeps its DOM, listeners and controllers and swaps only
 * the conversation, through the panel's own history switch (the one its
 * history menu uses): the old conversation's draft is saved, the next one's
 * draft, chips, runtime mode, request state and scroll position are restored,
 * and the chat is drawn once.
 *
 * Only a switch between two conversations of the same runtime, the same mode
 * (Paper chat or Library chat), the same library and, for Paper chat, the
 * same paper moves in place. Everything else keeps the full remount:
 * - a runtime change: the runtime's controls, model catalog and retention are
 *   set up at mount;
 * - a mode, library or paper change: the panel's context (paper chips, the
 *   auto-loaded paper, shortcuts) and its host binding belong to the mount;
 * - a note session (current or next): a note has its own item-scoped history;
 * - WebChat: its sessions live on the web, not in the panel's history;
 * - a runtime switch in flight, or an open message edit: the panel is in the
 *   middle of its own change;
 * - no live panel, a panel that is not the window's own, or a panel whose
 *   ownership fence is up.
 */
import type { ConversationSystem } from "../../shared/types";

export type ConversationSwitchScope = {
  system: ConversationSystem;
  kind: "global" | "paper";
  libraryID: number;
  /** The paper a Paper chat belongs to; 0 for Library chat. */
  basePaperItemID: number;
  isNote: boolean;
};

export type StandaloneConversationSwitchInput = {
  /** The panel is set up, connected and has a conversation. */
  panelAlive: boolean;
  /** The panel is the standalone window's own panel. */
  standalonePanel: boolean;
  /** The panel is the window's temporary side chat. */
  sidePanel: boolean;
  ownershipBlocked: boolean;
  webChat: boolean;
  runtimeSwitchInFlight: boolean;
  inlineEditOpen: boolean;
  current: ConversationSwitchScope;
  next: ConversationSwitchScope;
};

export type StandaloneRemountReason =
  | "no-panel"
  | "not-standalone"
  | "ownership-blocked"
  | "webchat"
  | "busy"
  | "note"
  | "runtime-changed"
  | "mode-changed"
  | "library-changed"
  | "paper-changed";

export type StandaloneConversationSwitchDecision =
  | { inPlace: true }
  | { inPlace: false; reason: StandaloneRemountReason };

export function resolveStandaloneConversationSwitch(
  input: StandaloneConversationSwitchInput,
): StandaloneConversationSwitchDecision {
  const remount = (
    reason: StandaloneRemountReason,
  ): StandaloneConversationSwitchDecision => ({ inPlace: false, reason });
  if (!input.panelAlive) return remount("no-panel");
  if (!input.standalonePanel || input.sidePanel) {
    return remount("not-standalone");
  }
  if (input.ownershipBlocked) return remount("ownership-blocked");
  if (input.webChat) return remount("webchat");
  if (input.runtimeSwitchInFlight || input.inlineEditOpen) {
    return remount("busy");
  }
  const { current, next } = input;
  if (current.isNote || next.isNote) return remount("note");
  if (current.system !== next.system) return remount("runtime-changed");
  if (current.kind !== next.kind) return remount("mode-changed");
  if (current.libraryID !== next.libraryID) return remount("library-changed");
  if (
    current.kind === "paper" &&
    (!current.basePaperItemID ||
      current.basePaperItemID !== next.basePaperItemID)
  ) {
    return remount("paper-changed");
  }
  return { inPlace: true };
}

/**
 * What the window does when its panel reports a conversation change. The
 * window's own switches set `activeConversationKey` before the panel moves,
 * so the same key means nothing to do. Another key is a switch the panel
 * made by itself, and the window adopts it.
 */
export function decidePanelIdentityAdoption(
  activeConversationKey: number,
  panelConversationKey: number,
): "adopt" | "ignore" {
  const panelKey = Math.floor(Number(panelConversationKey));
  if (!Number.isFinite(panelKey) || panelKey <= 0) return "ignore";
  return panelKey === Math.floor(Number(activeConversationKey))
    ? "ignore"
    : "adopt";
}
