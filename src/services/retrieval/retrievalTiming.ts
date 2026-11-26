/**
 * Wall-clock phases of one library retrieval. Counts only ever told us how
 * many candidate builds ran; this says where the seconds went.
 */
export type RetrievalPhase =
  | "scope"
  | "plan"
  | "records"
  | "pool_bm25"
  | "quicksearch"
  | "probe_loop"
  | "triage"
  | "index_search"
  | "paper_snippets"
  | "fallback_snippets"
  | "rank"
  | "total";

export type RetrievalTimingReport = {
  startedAt: number;
  totalMs: number;
  phases: Partial<Record<RetrievalPhase, number>>;
  counters: Record<string, number>;
};

export type RetrievalTimer = {
  span<T>(phase: RetrievalPhase, fn: () => Promise<T>): Promise<T>;
  spanSync<T>(phase: RetrievalPhase, fn: () => T): T;
  count(name: string, by?: number): void;
  finish(): RetrievalTimingReport;
};

const RECENT_LIMIT = 20;
const recent: RetrievalTimingReport[] = [];

export function createRetrievalTimer(
  now: () => number = Date.now,
): RetrievalTimer {
  const startedAt = now();
  const phases: Partial<Record<RetrievalPhase, number>> = {};
  const counters: Record<string, number> = Object.create(null);
  const add = (phase: RetrievalPhase, ms: number) => {
    phases[phase] = (phases[phase] || 0) + Math.max(0, ms);
  };
  return {
    async span(phase, fn) {
      const start = now();
      try {
        return await fn();
      } finally {
        add(phase, now() - start);
      }
    },
    spanSync(phase, fn) {
      const start = now();
      try {
        return fn();
      } finally {
        add(phase, now() - start);
      }
    },
    count(name, by = 1) {
      counters[name] = (counters[name] || 0) + by;
    },
    finish() {
      return {
        startedAt,
        totalMs: now() - startedAt,
        phases: { ...phases },
        counters: { ...counters },
      };
    },
  };
}

export function recordRetrievalTiming(report: RetrievalTimingReport): void {
  recent.unshift(report);
  if (recent.length > RECENT_LIMIT) recent.length = RECENT_LIMIT;
}

export function getRecentRetrievalTimings(
  limit = RECENT_LIMIT,
): RetrievalTimingReport[] {
  return recent.slice(0, Math.max(0, Math.floor(limit)));
}
