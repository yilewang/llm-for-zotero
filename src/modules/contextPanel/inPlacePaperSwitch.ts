/**
 * The asynchronous half of moving a mounted paper chat to another paper in
 * place. The panel has already taken the next paper's identity; this draws
 * that paper's chat, and when nothing drew it, never leaves the previous
 * paper's messages on screen under the next paper's identity.
 */

export type InPlacePaperSwitchSteps = {
  /** Whether this run is still the panel's latest in-place switch. */
  isLatest: () => boolean;
  /** Moves to the next paper's conversation; true once it drew the chat. */
  switchConversation: () => Promise<boolean>;
  /** Whether the plain load-and-draw fallback may still run. */
  canDrawFallback: () => boolean;
  /** Loads and draws the next paper's chat; true once it drew. */
  drawFallback: () => Promise<boolean>;
  /**
   * Whether the user opened another conversation meanwhile and it was
   * drawn; that conversation is kept as it is.
   */
  movedToOtherConversation: () => boolean;
  /** Removes the previous paper's chat, which nothing replaced. */
  clearUndrawn: () => void;
  /**
   * Rebuilds the whole panel for the next paper. Zotero sends no further
   * render for a paper it already rendered, so nothing else would.
   */
  rebuild: () => void;
  /** Lets the chat box take input again. */
  release: () => void;
  onError?: (error: unknown) => void;
};

let forcedFailures = 0;

// Test-only: make the next N in-place switches fail so workflow tests can
// drive the failure path through the real switch. The failure comes after a
// timer turn, as a real one does after Zotero rendered the next paper.
export function forceInPlacePaperSwitchFailuresForTests(count: number): void {
  forcedFailures = Math.max(0, Math.floor(count));
}

/** Test-only: forced failures not yet used by a switch. */
export function getForcedInPlacePaperSwitchFailuresForTests(): number {
  return forcedFailures;
}

/** Resolves true when the next paper's chat was drawn. */
export async function runInPlacePaperSwitch(
  steps: InPlacePaperSwitchSteps,
): Promise<boolean> {
  let drawn = false;
  try {
    if (forcedFailures > 0) {
      forcedFailures--;
      await new Promise((resolve) => setTimeout(resolve, 0));
      throw new Error("Forced in-place paper switch failure");
    }
    drawn = await steps.switchConversation();
    if (!drawn && steps.canDrawFallback()) {
      drawn = await steps.drawFallback();
    }
  } catch (error) {
    drawn = false;
    steps.onError?.(error);
  }
  // A newer switch owns the panel now; this one must not touch it.
  if (!steps.isLatest()) return drawn;
  if (!drawn && !steps.movedToOtherConversation()) {
    steps.clearUndrawn();
    steps.rebuild();
  }
  steps.release();
  return drawn;
}
