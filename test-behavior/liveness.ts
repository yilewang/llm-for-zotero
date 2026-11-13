// Pure decisions for the Node runner: is Zotero still running the suite?
// No Zotero globals and no I/O, so the runner and unit tests can both import it.
export const HEARTBEAT_STALE_MS = 120_000;
export const STARTUP_GRACE_MS = 600_000;
// A poll gap longer than this means the machine slept; timers stop during sleep.
export const RESUME_GAP_MS = 30_000;

export interface LivenessState {
  now: number;
  launchedAt: number;
  heartbeatAt?: number;
  quitRecordedAt?: number;
  // The time of the first poll after a long gap; stale windows start no earlier.
  resumedAt?: number;
}

export function launcherLivenessError(
  state: LivenessState,
): string | undefined {
  const { now, launchedAt, heartbeatAt, quitRecordedAt, resumedAt } = state;
  if (quitRecordedAt !== undefined && quitRecordedAt >= launchedAt)
    return `Zotero quit during the run at ${new Date(quitRecordedAt).toISOString()}; the suite did not finish. Inspect partial evidence.`;
  if (heartbeatAt !== undefined) {
    if (now - Math.max(heartbeatAt, resumedAt ?? 0) > HEARTBEAT_STALE_MS)
      return `Zotero stopped responding: no heartbeat since ${new Date(heartbeatAt).toISOString()}. Inspect partial evidence.`;
    return undefined;
  }
  if (now - Math.max(launchedAt, resumedAt ?? 0) > STARTUP_GRACE_MS)
    return "Zotero never started the suite: no heartbeat within 10 minutes of launch.";
  return undefined;
}

// Zotero rewrites sessionCheckpoints.json at startup without the quit flags,
// so a file older than the launch belongs to a previous session.
export function quitRecordedAt(
  checkpoints: unknown,
  mtimeMs: number,
  launchedAt: number,
): number | undefined {
  const granted =
    typeof checkpoints === "object" &&
    checkpoints !== null &&
    (checkpoints as Record<string, unknown>)["quit-application-granted"] ===
      true;
  return granted && mtimeMs >= launchedAt ? mtimeMs : undefined;
}
