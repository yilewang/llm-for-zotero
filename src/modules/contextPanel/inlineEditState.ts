/**
 * The message edit ("Editing" widget) open in each chat panel.
 *
 * Every panel (each sidebar pane and the standalone window) keeps its own
 * edit, keyed by the panel body: which prompt it edits, the composer section
 * it borrowed into the widget, where that section came from, and the draft
 * the composer held before. One panel's edit never routes another panel's
 * send, never blocks another panel from editing, and never moves another
 * panel's composer.
 *
 * When the same conversation shows in two panels, the widget shows only in
 * the panel where Edit was clicked; the other panel shows the conversation
 * as usual. When a turn starts in the conversation from anywhere else (the
 * other panel sends, or a writer with no panel), the edit ends: sending it
 * later would cut that newer turn off. What was typed in the edit stays in
 * the panel's composer.
 */

export type InlineEditTarget = {
  conversationKey: number;
  userTimestamp: number;
  assistantTimestamp: number;
  /** Text currently typed in the inline textarea (preserved across refreshes). */
  currentText: string;
  /**
   * The newest prompt the conversation had when the edit opened. A newer
   * prompt (a turn added from elsewhere) ends the edit.
   */
  latestUserTimestamp?: number;
};

export type InlineEditBorrowedInputSection = {
  /** The panel's .llm-input-section, moved into the edit widget. */
  el: HTMLElement | null;
  /** Its original parent, for putting it back. */
  parent: Element | null;
  /** Its original next sibling, for putting it back. */
  nextSib: Node | null;
};

type InlineEditSession = {
  target: InlineEditTarget | null;
  /** Restores the borrowed composer and draft when the edit ends. */
  cleanup: (() => void) | null;
  inputSection: InlineEditBorrowedInputSection;
  /** Draft text that was in the composer when the edit started. */
  savedDraft: string;
  /**
   * True while the edit is ended because a turn started elsewhere in its
   * conversation; the cleanup then gives the composer the edited text.
   */
  superseded: boolean;
};

const sessions = new WeakMap<Element, InlineEditSession>();
/** Bodies with an edit open, so a deleted conversation can release them. */
const bodiesEditing = new Set<Element>();

function emptySection(): InlineEditBorrowedInputSection {
  return { el: null, parent: null, nextSib: null };
}

function sessionFor(body: Element): InlineEditSession {
  let session = sessions.get(body);
  if (!session) {
    session = {
      target: null,
      cleanup: null,
      inputSection: emptySection(),
      savedDraft: "",
      superseded: false,
    };
    sessions.set(body, session);
  }
  return session;
}

export function getInlineEditTarget(body: Element): InlineEditTarget | null {
  return sessions.get(body)?.target || null;
}

export function setInlineEditTarget(
  body: Element,
  target: InlineEditTarget | null,
): void {
  sessionFor(body).target = target;
  if (target) bodiesEditing.add(body);
  else bodiesEditing.delete(body);
}

export function getInlineEditCleanup(body: Element): (() => void) | null {
  return sessions.get(body)?.cleanup || null;
}

export function setInlineEditCleanup(
  body: Element,
  cleanup: (() => void) | null,
): void {
  sessionFor(body).cleanup = cleanup;
}

export function getInlineEditBorrowedInputSection(
  body: Element,
): InlineEditBorrowedInputSection {
  return { ...(sessions.get(body)?.inputSection || emptySection()) };
}

export function setInlineEditBorrowedInputSection(
  body: Element,
  el: HTMLElement | null,
  parent: Element | null,
  nextSib: Node | null,
): void {
  sessionFor(body).inputSection = { el, parent, nextSib };
}

export function getInlineEditSavedDraft(body: Element): string {
  return sessions.get(body)?.savedDraft || "";
}

export function setInlineEditSavedDraft(body: Element, text: string): void {
  sessionFor(body).savedDraft = text;
}

/**
 * End the panel's edit: put its borrowed composer and draft back (the
 * cleanup) and forget the edit. Other panels' edits are untouched.
 */
export function endInlineEdit(body: Element): void {
  const session = sessions.get(body);
  if (!session) return;
  const cleanup = session.cleanup;
  session.cleanup = null;
  cleanup?.();
  sessions.delete(body);
  bodiesEditing.delete(body);
}

/**
 * Forget the panel's edit without touching its DOM: for a panel whose DOM is
 * gone (a detached panel's teardown).
 */
export function releaseInlineEdit(body: Element): void {
  sessions.delete(body);
  bodiesEditing.delete(body);
}

/**
 * A conversation was deleted: end every panel's edit of it. A mounted panel
 * gets its composer back (the cleanup runs); a panel whose DOM is gone, or
 * a deletion finishing with no panel mounted, only drops the references so a
 * stale cleanup never writes into a detached composer.
 */
export function releaseInlineEditsForConversation(
  conversationKey: number,
): void {
  for (const body of [...bodiesEditing]) {
    if (sessions.get(body)?.target?.conversationKey === conversationKey) {
      if (body.isConnected) endInlineEdit(body);
      else releaseInlineEdit(body);
    }
  }
}

/** Whether the edit is ending because a turn started elsewhere (read in its cleanup). */
export function isInlineEditSuperseded(body: Element): boolean {
  return Boolean(sessions.get(body)?.superseded);
}

/**
 * End the panel's edit because a turn started elsewhere in its conversation.
 * Its composer comes back holding the text typed in the edit rather than the
 * draft it held before: the edited text is the user's latest input, and the
 * pre-edit draft was already set aside once by opening the edit.
 */
export function endInlineEditSuperseded(body: Element): void {
  const session = sessions.get(body);
  if (!session?.target) return;
  if (!body.isConnected) {
    releaseInlineEdit(body);
    return;
  }
  session.savedDraft = session.target.currentText;
  session.superseded = true;
  endInlineEdit(body);
}

/**
 * A turn started in the conversation: end every edit of it in the other
 * panels (all of them when no panel started it). The starting panel's own
 * edit is the one being sent.
 */
export function endInlineEditsForTurnStartedElsewhere(
  conversationKey: number,
  startingBody?: Element | null,
): void {
  for (const body of [...bodiesEditing]) {
    if (body === startingBody) continue;
    if (sessions.get(body)?.target?.conversationKey === conversationKey) {
      endInlineEditSuperseded(body);
    }
  }
}

/** The newest prompt timestamp in a conversation's history, or 0. */
export function getLatestUserTurnTimestamp(
  history: ReadonlyArray<{ role: string; timestamp: number }>,
): number {
  let latest = 0;
  for (const message of history) {
    if (message.role === "user" && message.timestamp > latest) {
      latest = message.timestamp;
    }
  }
  return latest;
}

/**
 * Whether the conversation got a prompt newer than any it had when the edit
 * opened: a turn added from elsewhere, which sending the edit would cut off.
 */
export function hasNewerUserTurnThanInlineEdit(
  target: InlineEditTarget,
  history: ReadonlyArray<{ role: string; timestamp: number }>,
): boolean {
  const latestAtStart = Number(target.latestUserTimestamp);
  if (!Number.isFinite(latestAtStart) || latestAtStart <= 0) return false;
  return getLatestUserTurnTimestamp(history) > latestAtStart;
}
