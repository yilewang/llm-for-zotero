import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderEvent } from "../runtime.js";
import type { ClaudeStepTracker } from "../event-mapper/claude-step-tracker.js";

type Waiter = {
  resolve: (value: IteratorResult<ProviderEvent>) => void;
  reject: (reason?: unknown) => void;
};

export type HotRuntimeTurn = {
  runId: string;
  sessionId?: string;
  finalText: string;
  awaitingAutoCompact: boolean;
  compactOnly: boolean;
  queueEvent: (event: ProviderEvent) => void;
  finish: () => void;
  fail: (error: Error) => void;
  events: AsyncIterable<ProviderEvent>;
};

export type HotRuntimeEntry = {
  conversationKey: string;
  mounts: Set<string>;
  closeTimer: NodeJS.Timeout | null;
  closeRequested: boolean;
  lastActivityAt: number;
  query: Query | null;
  bootstrapPromise: Promise<void> | null;
  input: AsyncIterable<SDKUserMessage>;
  pushMessage: (message: SDKUserMessage) => void;
  closeInput: () => void;
  providerSessionId?: string;
  configSignature?: string;
  providerIdentity?: string;
  lastUsageSnapshot?: { contextTokens: number; contextWindow?: number };
  currentTurn: HotRuntimeTurn | null;
  currentTurnMessage?: SDKUserMessage;
  /** Claude's step list for this runtime; set when its reader starts. */
  stepTracker?: ClaudeStepTracker;
  pendingEarlyRuntimeError?: Error;
  pendingEarlyRuntimeQueryOptions?: Record<string, unknown>;
};

function createMessageChannel(): {
  input: AsyncIterable<SDKUserMessage>;
  pushMessage: (message: SDKUserMessage) => void;
  closeInput: () => void;
} {
  const queue: SDKUserMessage[] = [];
  let waiter: ((value: IteratorResult<SDKUserMessage>) => void) | null = null;
  let closed = false;
  return {
    input: {
      [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
        return {
          next(): Promise<IteratorResult<SDKUserMessage>> {
            if (queue.length > 0) {
              return Promise.resolve({ value: queue.shift()!, done: false });
            }
            if (closed) {
              return Promise.resolve({
                value: undefined,
                done: true,
              } as IteratorResult<SDKUserMessage>);
            }
            return new Promise((resolve) => {
              waiter = resolve;
            });
          },
        };
      },
    },
    pushMessage(message: SDKUserMessage) {
      if (closed) throw new Error("Hot runtime input is closed");
      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve({ value: message, done: false });
        return;
      }
      queue.push(message);
    },
    closeInput() {
      closed = true;
      queue.length = 0;
      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve({
          value: undefined,
          done: true,
        } as IteratorResult<SDKUserMessage>);
      }
    },
  };
}

export function createHotRuntimeTurn(runId: string): HotRuntimeTurn {
  const events: ProviderEvent[] = [];
  let done = false;
  let error: Error | null = null;
  let waiter: Waiter | null = null;

  const flush = () => {
    if (!waiter) return;
    if (events.length > 0) {
      const next = events.shift()!;
      const resolve = waiter.resolve;
      waiter = null;
      resolve({ value: next, done: false });
      return;
    }
    if (error) {
      const reject = waiter.reject;
      waiter = null;
      reject(error);
      return;
    }
    if (done) {
      const resolve = waiter.resolve;
      waiter = null;
      resolve({
        value: undefined,
        done: true,
      } as IteratorResult<ProviderEvent>);
    }
  };

  return {
    runId,
    finalText: "",
    awaitingAutoCompact: false,
    compactOnly: false,
    queueEvent(event: ProviderEvent) {
      if (done || error) return;
      events.push(event);
      flush();
    },
    finish() {
      done = true;
      flush();
    },
    fail(nextError: Error) {
      if (done || error) return;
      error = nextError;
      flush();
    },
    events: {
      [Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
        return {
          next(): Promise<IteratorResult<ProviderEvent>> {
            if (events.length > 0) {
              return Promise.resolve({ value: events.shift()!, done: false });
            }
            if (error) {
              return Promise.reject(error);
            }
            if (done) {
              return Promise.resolve({
                value: undefined,
                done: true,
              } as IteratorResult<ProviderEvent>);
            }
            return new Promise((resolve, reject) => {
              waiter = { resolve, reject };
            });
          },
        };
      },
    },
  };
}

export function createHotRuntimeEntry(
  conversationKey: string,
): HotRuntimeEntry {
  const channel = createMessageChannel();
  return {
    conversationKey,
    mounts: new Set<string>(),
    closeTimer: null,
    closeRequested: false,
    lastActivityAt: Date.now(),
    query: null,
    bootstrapPromise: null,
    input: channel.input,
    pushMessage: channel.pushMessage,
    closeInput: channel.closeInput,
    providerSessionId: undefined,
    configSignature: undefined,
    providerIdentity: undefined,
    lastUsageSnapshot: undefined,
    currentTurn: null,
    currentTurnMessage: undefined,
    pendingEarlyRuntimeError: undefined,
    pendingEarlyRuntimeQueryOptions: undefined,
  };
}

export class HotRuntimePool {
  private readonly entries = new Map<string, HotRuntimeEntry>();
  private readonly graceMs: number;

  constructor(options?: { graceMs?: number }) {
    this.graceMs = options?.graceMs ?? 3000;
  }

  ensure(conversationKey: string): HotRuntimeEntry {
    const existing = this.entries.get(conversationKey);
    if (existing) return existing;
    const created = createHotRuntimeEntry(conversationKey);
    this.entries.set(conversationKey, created);
    return created;
  }

  get(conversationKey: string): HotRuntimeEntry | undefined {
    return this.entries.get(conversationKey);
  }

  retain(conversationKey: string, mountId: string): HotRuntimeEntry {
    const entry = this.ensure(conversationKey);
    entry.mounts.add(mountId);
    entry.lastActivityAt = Date.now();
    entry.closeRequested = false;
    if (entry.closeTimer) {
      clearTimeout(entry.closeTimer);
      entry.closeTimer = null;
    }
    return entry;
  }

  release(
    conversationKey: string,
    mountId: string,
    onExpire: (entry: HotRuntimeEntry) => void,
  ): void {
    const entry = this.entries.get(conversationKey);
    if (!entry) return;
    entry.mounts.delete(mountId);
    entry.lastActivityAt = Date.now();
    this.scheduleCloseIfIdle(entry, onExpire);
  }

  scheduleCloseIfIdle(
    entry: HotRuntimeEntry,
    onExpire: (entry: HotRuntimeEntry) => void,
  ): void {
    if (entry.mounts.size > 0 || entry.currentTurn) return;
    if (entry.closeTimer) return;
    entry.closeRequested = true;
    entry.closeTimer = setTimeout(() => {
      entry.closeTimer = null;
      if (entry.mounts.size > 0 || entry.currentTurn) return;
      this.entries.delete(entry.conversationKey);
      onExpire(entry);
    }, this.graceMs);
  }

  delete(conversationKey: string): HotRuntimeEntry | undefined {
    const entry = this.entries.get(conversationKey);
    if (!entry) return undefined;
    this.entries.delete(conversationKey);
    if (entry.closeTimer) {
      clearTimeout(entry.closeTimer);
      entry.closeTimer = null;
    }
    return entry;
  }
}
