export const STABLE_ANIMATION_DELAY_PROPERTY = "--llm-stable-animation-delay";

export function getStableAnimationDelay(
  startedAt: number | undefined,
  now = Date.now(),
): string {
  const normalizedStart = Number(startedAt);
  const normalizedNow = Number(now);
  if (
    !Number.isFinite(normalizedStart) ||
    normalizedStart <= 0 ||
    !Number.isFinite(normalizedNow)
  ) {
    return "0ms";
  }
  return `${-Math.max(0, normalizedNow - normalizedStart)}ms`;
}

export function applyStableAnimationPhase(
  element: HTMLElement,
  startedAt: number | undefined,
  now = Date.now(),
): void {
  element.style.setProperty(
    STABLE_ANIMATION_DELAY_PROPERTY,
    getStableAnimationDelay(startedAt, now),
  );
}
