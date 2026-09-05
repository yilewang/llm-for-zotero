/**
 * Per-body chat render-cycle claims.
 *
 * On a full panel render, both onRender's deferred IIFE and onAsyncRender
 * historically called refreshChat, rebuilding the whole conversation twice
 * back-to-back. Neither call can simply be removed: onAsyncRender is not
 * guaranteed to fire for every body, and the deferred call may wake up after
 * a newer render cycle has replaced the panel. These claims let whichever
 * path gets there first render once, and the other skip.
 */

export type ChatRenderCycle = { rendered: boolean };

const pendingChatRenderCycles = new WeakMap<Element, ChatRenderCycle>();

/** Start a new cycle for a full panel render; supersedes any previous cycle. */
export function beginChatRenderCycle(body: Element): ChatRenderCycle {
  const cycle: ChatRenderCycle = { rendered: false };
  pendingChatRenderCycles.set(body, cycle);
  return cycle;
}

/**
 * Deferred-onRender path. True when this cycle is still the body's current
 * cycle and nothing rendered yet; the claim is then taken.
 */
export function claimDeferredChatRender(
  body: Element,
  cycle: ChatRenderCycle,
): boolean {
  if (pendingChatRenderCycles.get(body) !== cycle) return false;
  if (cycle.rendered) return false;
  cycle.rendered = true;
  return true;
}

/**
 * The body's current cycle, captured by onAsyncRender in the same synchronous
 * block that consumes the sync-render flag — claiming must later be affine to
 * THIS cycle, not to whatever cycle is current at claim time, or a stale
 * in-flight async render could steal a newer cycle's claim and pin the
 * previous item's conversation on screen after a fast tab switch.
 */
export function currentChatRenderCycle(body: Element): ChatRenderCycle | null {
  return pendingChatRenderCycles.get(body) ?? null;
}

/**
 * onAsyncRender path. With a captured cycle the claim is shared with the
 * deferred path and refused when a newer cycle superseded it; without one
 * (async-only render, no sync onRender) onAsyncRender owns the render
 * unconditionally.
 */
export function claimAsyncChatRender(
  body: Element,
  cycle: ChatRenderCycle | null,
): boolean {
  if (!cycle) return true;
  if (pendingChatRenderCycles.get(body) !== cycle) return false;
  if (cycle.rendered) return false;
  cycle.rendered = true;
  return true;
}

/**
 * The instruction the latest onRender leaves for its onAsyncRender
 * counterpart. Exactly one claim exists per body at a time — every onRender
 * overwrites it — so the claim's item key always identifies the item of the
 * NEWEST sync render. A body-wide boolean cannot carry that identity: a stale
 * in-flight onAsyncRender that starts after a fast tab switch would consume
 * the newer render's flag, capture the newer cycle, and paint the previous
 * item's conversation into the new item's panel while suppressing the
 * deferred fallback that would have corrected it.
 */
export type PanelRenderClaim =
  | {
      /** onRender built UI + handlers synchronously; async skips that work. */
      kind: "sync-rendered";
      itemKey: string;
      /** The cycle begun by that onRender; null when it began none (placeholder path). */
      cycle: ChatRenderCycle | null;
    }
  | {
      /** Same-item render that only needs the context source refreshed. */
      kind: "context-refresh";
      itemKey: string;
    };

const panelRenderClaims = new WeakMap<Element, PanelRenderClaim>();
/**
 * The item key of the latest onRender for each body, kept SEPARATELY from the
 * one-shot claim. Consuming the claim must not erase the body's identity: a
 * stale async render that arrives after the rightful one consumed the claim
 * would otherwise read "none", be treated as an async-only render, and
 * rebuild the previous item's panel over the current one. The owner entry is
 * never cleared — it is overwritten by the next onRender and garbage-collected
 * with the body.
 */
const panelRenderOwners = new WeakMap<Element, string>();

/** Called by onRender. Overwrites any pending claim — latest render wins. */
export function setPanelRenderClaim(
  body: Element,
  claim: PanelRenderClaim,
): void {
  panelRenderOwners.set(body, claim.itemKey);
  panelRenderClaims.set(body, claim);
}

export type TakePanelRenderClaimResult =
  | { outcome: "none" }
  /**
   * The body is owned by a different item: a newer onRender superseded the
   * calling async render, which must bail without touching the panel. Any
   * pending claim stays for the rightful async render.
   */
  | { outcome: "stale" }
  | { outcome: "sync-rendered"; cycle: ChatRenderCycle | null }
  | { outcome: "context-refresh" };

/** Called by onAsyncRender in its synchronous prefix, before any await. */
export function takePanelRenderClaim(
  body: Element,
  itemKey: string,
): TakePanelRenderClaimResult {
  // Ownership is authoritative and outlives the claim. A body that never
  // rendered has no owner to defend, so its first async-only render proceeds.
  const owner = panelRenderOwners.get(body);
  if (owner !== undefined && owner !== itemKey) return { outcome: "stale" };
  const claim = panelRenderClaims.get(body);
  if (!claim) return { outcome: "none" };
  panelRenderClaims.delete(body);
  if (claim.kind === "sync-rendered") {
    return { outcome: "sync-rendered", cycle: claim.cycle };
  }
  return { outcome: "context-refresh" };
}
