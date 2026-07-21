const DEFAULT_INTERACTION_GRACE_MS = 250;

/**
 * Emitted by citation navigation after a quote search has populated fresher
 * source evidence but did not navigate successfully. The panel owns the
 * response so navigation never mutates quote provenance directly.
 */
export const QUOTE_PROVENANCE_REVALIDATION_REQUEST_EVENT =
  "llm-quote-provenance-revalidation-request";

let activeNavigationCount = 0;
let interactionGraceUntil = 0;

export function beginQuoteNavigationActivity(): () => void {
  activeNavigationCount += 1;
  interactionGraceUntil = Math.max(
    interactionGraceUntil,
    Date.now() + DEFAULT_INTERACTION_GRACE_MS,
  );
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    activeNavigationCount = Math.max(0, activeNavigationCount - 1);
    interactionGraceUntil = Math.max(
      interactionGraceUntil,
      Date.now() + DEFAULT_INTERACTION_GRACE_MS,
    );
  };
}

export function noteQuoteValidationUserActivity(
  graceMs = DEFAULT_INTERACTION_GRACE_MS,
): void {
  interactionGraceUntil = Math.max(
    interactionGraceUntil,
    Date.now() + Math.max(0, graceMs),
  );
}

export function isQuoteValidationPreempted(now = Date.now()): boolean {
  return activeNavigationCount > 0 || now < interactionGraceUntil;
}

export function resetQuoteValidationActivityForTests(): void {
  activeNavigationCount = 0;
  interactionGraceUntil = 0;
}
