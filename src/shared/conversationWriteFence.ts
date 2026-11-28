import { positiveIntOrZero } from "../core/values";
/**
 * Process-local serialization and generation fencing for conversation-owned
 * writes.  Clear uses the same lock as message/agent persistence, so a write
 * that has not entered its critical section cannot slip in after Clear's
 * transaction commits.
 */

const generations = new Map<number, number>();
const frozen = new Set<number>();
const locks = new Map<number, Promise<void>>();

export function getConversationWriteGeneration(
  conversationKey: number,
): number {
  const key = positiveIntOrZero(conversationKey);
  return key ? generations.get(key) || 0 : 0;
}

export function bumpConversationWriteGeneration(
  conversationKey: number,
): number {
  const key = positiveIntOrZero(conversationKey);
  if (!key) return 0;
  const next = getConversationWriteGeneration(key) + 1;
  generations.set(key, next);
  return next;
}

export function isConversationWriteGenerationCurrent(
  conversationKey: number,
  expectedGeneration: number,
): boolean {
  return (
    getConversationWriteGeneration(conversationKey) ===
    Math.max(0, Math.floor(Number(expectedGeneration)))
  );
}

export function freezeConversationWrites(conversationKey: number): void {
  const key = positiveIntOrZero(conversationKey);
  if (key) frozen.add(key);
}

export function unfreezeConversationWrites(conversationKey: number): void {
  const key = positiveIntOrZero(conversationKey);
  if (key) frozen.delete(key);
}

export function areConversationWritesFrozen(conversationKey: number): boolean {
  const key = positiveIntOrZero(conversationKey);
  return Boolean(key && frozen.has(key));
}

export async function withConversationWriteLock<T>(
  conversationKey: number,
  task: () => Promise<T> | T,
): Promise<T> {
  const key = positiveIntOrZero(conversationKey);
  if (!key) return task();
  const previous = locks.get(key) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(key, current);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (locks.get(key) === current) locks.delete(key);
  }
}

/**
 * Test-only: the promise the next writer for this key will wait on, or
 * undefined when no write holds or awaits the lock.
 */
export function getConversationWriteLockTailForTests(
  conversationKey: number,
): Promise<void> | undefined {
  return locks.get(positiveIntOrZero(conversationKey));
}
