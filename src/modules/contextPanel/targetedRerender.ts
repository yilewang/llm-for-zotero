/**
 * Resolution logic for targeted assistant-message re-renders.
 *
 * A refresh may request that only specific assistant messages be rebuilt
 * (streaming flushes, quote revalidation). Targeting is only safe when every
 * requested message is an assistant message present in the history AND its
 * rendered wrapper is still in the DOM; otherwise the caller must fall back
 * to a full rebuild.
 */

type WrapperLike = {
  dataset: { messageRole?: string; messageIndex?: string };
};

export type TargetedRerenderResolution<M, W> = {
  useTargetedRerender: boolean;
  targetedMessageWrappers: Map<M, W>;
};

export function resolveTargetedAssistantRerenders<
  M extends { role: string },
  W extends WrapperLike,
>(
  history: readonly M[],
  requestedRerenders: ReadonlySet<M> | undefined,
  renderedWrappers: readonly W[],
): TargetedRerenderResolution<M, W> {
  const targetedMessageWrappers = new Map<M, W>();
  if (!requestedRerenders?.size) {
    return { useTargetedRerender: false, targetedMessageWrappers };
  }
  for (const message of requestedRerenders) {
    const messageIndex = history.indexOf(message);
    if (message.role !== "assistant" || messageIndex < 0) {
      return { useTargetedRerender: false, targetedMessageWrappers: new Map() };
    }
    const wrapper = renderedWrappers.find(
      (candidate) =>
        candidate.dataset.messageRole === "assistant" &&
        candidate.dataset.messageIndex === `${messageIndex}`,
    );
    if (!wrapper) {
      return { useTargetedRerender: false, targetedMessageWrappers: new Map() };
    }
    targetedMessageWrappers.set(message, wrapper);
  }
  return { useTargetedRerender: true, targetedMessageWrappers };
}
