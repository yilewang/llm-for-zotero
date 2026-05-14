export type BlockStreamFlushReason =
  | "boundary"
  | "timer"
  | "hard-cap"
  | "event"
  | "final"
  | "cancel"
  | "error";

export type BlockStreamCoalescer = {
  pushText: (delta: string) => void;
  flushNow: (reason: BlockStreamFlushReason) => void;
  cancel: () => void;
  getFullText: () => string;
  hasPending: () => boolean;
};

export type BlockStreamCoalescerOptions = {
  onBlock: (block: string, reason: BlockStreamFlushReason) => void;
  minBoundaryChars?: number;
  targetChars?: number;
  hardCapChars?: number;
  maxWaitMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
};

const DEFAULT_MIN_BOUNDARY_CHARS = 180;
const DEFAULT_TARGET_CHARS = 360;
const DEFAULT_HARD_CAP_CHARS = 800;
const DEFAULT_MAX_WAIT_MS = 450;

function defaultSetTimer(callback: () => void, delayMs: number): unknown {
  return setTimeout(callback, delayMs);
}

function defaultClearTimer(timer: unknown): void {
  clearTimeout(timer as ReturnType<typeof setTimeout>);
}

function endsAtMarkdownBlockBoundary(text: string): boolean {
  if (/\n\s*\n$/u.test(text)) return true;
  if (/(?:^|\n)\s{0,3}(?:```|~~~)[^\n]*\n$/u.test(text)) return true;
  return false;
}

function endsAtReadableBoundary(text: string): boolean {
  return /(?:[.!?。！？]\s*|\s)$/u.test(text);
}

function shouldFlushPendingText(
  text: string,
  thresholds: {
    minBoundaryChars: number;
    targetChars: number;
    hardCapChars: number;
  },
): BlockStreamFlushReason | null {
  if (!text) return null;
  if (text.length >= thresholds.hardCapChars) return "hard-cap";
  if (
    text.length >= thresholds.minBoundaryChars &&
    endsAtMarkdownBlockBoundary(text)
  ) {
    return "boundary";
  }
  if (text.length >= thresholds.targetChars && endsAtReadableBoundary(text)) {
    return "boundary";
  }
  return null;
}

export function createBlockStreamCoalescer(
  options: BlockStreamCoalescerOptions,
): BlockStreamCoalescer {
  const minBoundaryChars =
    options.minBoundaryChars ?? DEFAULT_MIN_BOUNDARY_CHARS;
  const targetChars = options.targetChars ?? DEFAULT_TARGET_CHARS;
  const hardCapChars = options.hardCapChars ?? DEFAULT_HARD_CAP_CHARS;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const setTimerFn = options.setTimer ?? defaultSetTimer;
  const clearTimerFn = options.clearTimer ?? defaultClearTimer;
  let pendingText = "";
  let fullText = "";
  let timer: unknown = null;
  let cancelled = false;

  const clearPendingTimer = () => {
    if (timer === null) return;
    clearTimerFn(timer);
    timer = null;
  };

  const flushNow = (reason: BlockStreamFlushReason): void => {
    if (!pendingText) {
      clearPendingTimer();
      return;
    }
    const block = pendingText;
    pendingText = "";
    clearPendingTimer();
    options.onBlock(block, reason);
  };

  const scheduleTimer = () => {
    if (timer !== null || !pendingText || maxWaitMs <= 0) return;
    timer = setTimerFn(() => {
      timer = null;
      flushNow("timer");
    }, maxWaitMs);
  };

  return {
    pushText(delta: string): void {
      if (cancelled || !delta) return;
      pendingText += delta;
      fullText += delta;
      const reason = shouldFlushPendingText(pendingText, {
        minBoundaryChars,
        targetChars,
        hardCapChars,
      });
      if (reason) {
        flushNow(reason);
        return;
      }
      scheduleTimer();
    },

    flushNow,

    cancel(): void {
      cancelled = true;
      pendingText = "";
      clearPendingTimer();
    },

    getFullText(): string {
      return fullText;
    },

    hasPending(): boolean {
      return Boolean(pendingText);
    },
  };
}
