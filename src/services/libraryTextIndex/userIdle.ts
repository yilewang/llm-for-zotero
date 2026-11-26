import { appLogger } from "../../core/logging";

export type UserIdleTracker = {
  isIdle(): boolean;
  onChange(listener: (idle: boolean) => void): () => void;
  dispose(): void;
};

let testOverride: boolean | null = null;

/** null = use the real idle service. */
export function setUserIdleForTests(idle: boolean | null): void {
  testOverride = idle;
}

type IdleObserver = {
  observe(subject: unknown, topic: string, data?: unknown): void;
};
type IdleService = {
  addIdleObserver(observer: IdleObserver, seconds: number): void;
  removeIdleObserver(observer: IdleObserver, seconds: number): void;
};

function getIdleService(): IdleService | null {
  try {
    const cc = (
      globalThis as unknown as {
        Components?: {
          classes?: Record<
            string,
            { getService: (iface: unknown) => IdleService }
          >;
          interfaces?: Record<string, unknown>;
        };
      }
    ).Components;
    const factory = cc?.classes?.["@mozilla.org/widget/useridleservice;1"];
    return factory
      ? factory.getService(cc?.interfaces?.nsIUserIdleService)
      : null;
  } catch {
    return null;
  }
}

/**
 * Mirrors Zotero's own full-text content processor: prefetch work runs only
 * after the user has been idle for `idleSeconds`.
 */
export function createUserIdleTracker(idleSeconds: number): UserIdleTracker {
  const listeners = new Set<(idle: boolean) => void>();
  let idle = false;
  const service = getIdleService();
  const observer: IdleObserver = {
    observe(_subject, topic) {
      if (topic !== "idle" && topic !== "active" && topic !== "idle-daily")
        return;
      const next = topic === "idle" || topic === "idle-daily";
      if (next === idle) return;
      idle = next;
      for (const listener of listeners) {
        try {
          listener(idle);
        } catch {
          // A listener bug must not break idle tracking.
        }
      }
    },
  };
  let observing = false;
  if (service) {
    try {
      service.addIdleObserver(observer, idleSeconds);
      observing = true;
    } catch (error) {
      appLogger.debug("LLM index: could not observe user idle", error);
    }
  }
  if (!observing) {
    // No idle service (unit tests, unusual hosts): nothing to gate on, so
    // prefetch may run.
    idle = true;
    appLogger.debug(
      "LLM index: user idle service unavailable; prefetch is not idle-gated",
    );
  }
  return {
    isIdle: () => (testOverride === null ? idle : testOverride),
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => {
      listeners.clear();
      if (!observing || !service) return;
      observing = false;
      try {
        service.removeIdleObserver(observer, idleSeconds);
      } catch {
        // Already removed.
      }
    },
  };
}
