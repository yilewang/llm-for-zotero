export type UndoEntry = {
  id: string;
  toolName: string;
  description: string;
  revert: () => Promise<void>;
};

const stacks = new Map<number, UndoEntry[]>();

const MAX_UNDO_DEPTH = 10;

export function pushUndoEntry(
  conversationKey: number,
  entry: UndoEntry,
): void {
  let stack = stacks.get(conversationKey);
  if (!stack) {
    stack = [];
    stacks.set(conversationKey, stack);
  }
  stack.push(entry);
  if (stack.length > MAX_UNDO_DEPTH) {
    stack.shift();
  }
}

export function peekUndoEntry(conversationKey: number): UndoEntry | null {
  const stack = stacks.get(conversationKey);
  return stack?.length ? stack[stack.length - 1] : null;
}

export function popUndoEntry(conversationKey: number): UndoEntry | null {
  const stack = stacks.get(conversationKey);
  if (!stack?.length) return null;
  const entry = stack.pop()!;
  if (!stack.length) {
    stacks.delete(conversationKey);
  }
  return entry;
}

export function clearUndoStack(conversationKey: number): void {
  stacks.delete(conversationKey);
}
