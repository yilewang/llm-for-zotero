let activeActionId: string | null = null;
let mutationTail: Promise<void> = Promise.resolve();

export function getActiveMutationActionId(): string | null {
  return activeActionId;
}

/**
 * Serialize the actual Zotero write window across every conversation.
 *
 * The runtime's ordinary lock is intentionally per conversation, so two
 * conversations can otherwise overlap. A process-global action id would then
 * attribute native notifier events to whichever write happened to set it
 * last. Keeping this narrow global queue around the forward call, post-image
 * capture, and notifier flush makes attribution deterministic without
 * serializing read-only planning or confirmation UI.
 */
export async function withActiveMutationAction<T>(
  actionId: string | null,
  task: () => Promise<T>,
): Promise<T> {
  const predecessor = mutationTail;
  let release!: () => void;
  mutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await predecessor;
  const previous = activeActionId;
  activeActionId = actionId;
  try {
    return await task();
  } finally {
    activeActionId = previous;
    release();
  }
}
