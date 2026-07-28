export type UndoEntry = {
  id: string;
  toolName: string;
  description: string;
  revert: () => Promise<void>;
  /** Optional inverse of `revert`; re-applies the undone change (redo). */
  restore?: () => Promise<void>;
};

const stacks = new Map<number, UndoEntry[]>();

const MAX_UNDO_DEPTH = 10;

/** Pairs an undo action with its inverse (redo) behind a tiny state machine. */
export function createUndoRedoPair(actions: {
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}): { revert: () => Promise<void>; restore: () => Promise<void> } {
  let applied = true; // true = change in effect; false = undone
  let inFlight: Promise<void> | null = null;

  const run = (fn: () => Promise<void>, nextState: boolean): Promise<void> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        await fn();
        applied = nextState;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  return {
    revert: () => (applied ? run(actions.undo, false) : Promise.resolve()),
    restore: () => (!applied ? run(actions.redo, true) : Promise.resolve()),
  };
}

export function pushUndoEntry(conversationKey: number, entry: UndoEntry): void {
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
