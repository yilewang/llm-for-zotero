/**
 * Tearing a chat off the standalone window: drag a list row (or the chat
 * title) and release it anywhere but where the drag started, and a torn-off
 * window opens on that chat where the drag ended.
 *
 * Pure: no Zotero or DOM access, so the decision runs under node. The window
 * code reads the drag and the screen, and passes them in.
 */
import type { ConversationSystem } from "../../shared/types";
import type { TornChatIdentity } from "./tornChatWindows";

/** The only data a tear-off drag carries (no text or URL: no desktop files). */
export const TEAR_OFF_MIME = "application/x-llmforzotero-chat";

/** A rectangle in screen pixels. */
export type ScreenRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/** A point in screen pixels. */
export type ScreenPoint = { screenX: number; screenY: number };

export type TearOffDragEndInput = {
  /** True when the user cancelled the drag (Escape). */
  userCancelled: boolean;
  /**
   * True when the drag's own source region took the drop: the chat list
   * for a row, the title row for the title.
   */
  droppedOnSource: boolean;
  /** Where dragend says the drag ended, in screen pixels. */
  screenX: number;
  screenY: number;
  /** The last point a `drag` event reported during the drag, if any. */
  lastDragPoint: ScreenPoint | null;
  /** The available area of the screen the drag ended on. */
  dropScreen: ScreenRect;
  /** The size the torn-off window opens at. */
  windowSize: { width: number; height: number };
  /**
   * Where the pointer holds the drag image, from the image's top-left
   * corner: the window opens where the image was. Zero when omitted.
   */
  grabOffset?: { x: number; y: number };
};

export type TearOffDragEndDecision =
  | { kind: "ignore" }
  | { kind: "open"; screenX: number; screenY: number };

const CONVERSATION_SYSTEMS: readonly ConversationSystem[] = [
  "upstream",
  "claude_code",
  "codex",
];

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0
  );
}

export function encodeTornChatIdentity(identity: TornChatIdentity): string {
  const payload: TornChatIdentity = {
    system: identity.system,
    conversationKey: identity.conversationKey,
    kind: identity.kind,
    libraryID: identity.libraryID,
  };
  if (identity.kind === "paper") payload.paperItemID = identity.paperItemID;
  return JSON.stringify(payload);
}

/** The identity a tear-off drag carries, or null for anything malformed. */
export function decodeTornChatIdentity(raw: string): TornChatIdentity | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Record<string, unknown>;
  const system = value.system as ConversationSystem;
  if (!CONVERSATION_SYSTEMS.includes(system)) return null;
  if (value.kind !== "paper" && value.kind !== "global") return null;
  if (!isPositiveInteger(value.conversationKey)) return null;
  if (!isPositiveInteger(value.libraryID)) return null;
  const identity: TornChatIdentity = {
    system,
    conversationKey: value.conversationKey,
    kind: value.kind,
    libraryID: value.libraryID,
  };
  if (value.kind === "paper") {
    if (!isPositiveInteger(value.paperItemID)) return null;
    identity.paperItemID = value.paperItemID;
  }
  return identity;
}

/**
 * A point a drag event can stand behind: finite, and not exactly (0, 0),
 * which some platforms report for every drag event.
 */
export function isUsableDragPoint(screenX: number, screenY: number): boolean {
  return (
    Number.isFinite(screenX) &&
    Number.isFinite(screenY) &&
    !(screenX === 0 && screenY === 0)
  );
}

/**
 * Where a drag ended: dragend's own point, or the last drag point when
 * dragend's is not usable; null when neither is.
 */
export function tearOffDropPoint(
  screenX: number,
  screenY: number,
  lastDragPoint: ScreenPoint | null,
): ScreenPoint | null {
  if (isUsableDragPoint(screenX, screenY)) return { screenX, screenY };
  if (
    lastDragPoint &&
    isUsableDragPoint(lastDragPoint.screenX, lastDragPoint.screenY)
  ) {
    return { screenX: lastDragPoint.screenX, screenY: lastDragPoint.screenY };
  }
  return null;
}

/** The axis position that keeps `size` inside [start, start + extent). */
function clampAxis(
  position: number,
  start: number,
  extent: number,
  size: number,
): number {
  return Math.max(start, Math.min(position, start + extent - size));
}

/**
 * What a finished drag does: nothing when it was cancelled, it was dropped
 * back on its own source region, or no point says where it ended;
 * otherwise a torn-off window opens with its top-left corner at the drop
 * point, moved so the whole window lies on the drop screen. A release
 * anywhere else opens one, over a Zotero window included.
 */
export function classifyTearOffDragEnd(
  input: TearOffDragEndInput,
): TearOffDragEndDecision {
  if (input.userCancelled) return { kind: "ignore" };
  if (input.droppedOnSource) return { kind: "ignore" };
  const point = tearOffDropPoint(
    input.screenX,
    input.screenY,
    input.lastDragPoint,
  );
  if (!point) return { kind: "ignore" };
  const screenX = point.screenX - (input.grabOffset?.x ?? 0);
  const screenY = point.screenY - (input.grabOffset?.y ?? 0);
  const { dropScreen, windowSize } = input;
  return {
    kind: "open",
    screenX: clampAxis(
      screenX,
      dropScreen.left,
      dropScreen.width,
      windowSize.width,
    ),
    screenY: clampAxis(
      screenY,
      dropScreen.top,
      dropScreen.height,
      windowSize.height,
    ),
  };
}
