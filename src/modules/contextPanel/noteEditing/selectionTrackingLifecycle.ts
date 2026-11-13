export type NoteEditingSelectionTrackingTimerHost = {
  setInterval(callback: () => void, delay: number): number;
  clearInterval(timerId: number): void;
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(timerId: number): void;
};

export type NoteEditingSelectionTrackingLifecycle = {
  trackSelectionDocument: (doc: Document) => void;
  dispose: () => void;
};

// Delays, after a click or key press, of the follow-up checks. A note editor
// opened by that click can mount its document a moment later; these catch
// it without polling every 250 ms all the time.
const SETTLE_CHECK_DELAYS_MS = [0, 250, 750];

export function createNoteEditingSelectionTrackingLifecycle(params: {
  timerHost: NoteEditingSelectionTrackingTimerHost;
  refresh: () => void;
  onDispose?: () => void;
  debounceDelayMs?: number;
  intervalDelayMs?: number;
}): NoteEditingSelectionTrackingLifecycle {
  const debounceDelayMs = params.debounceDelayMs ?? 150;
  // Safety net only: tracked documents report selection changes, and clicks
  // and key presses in the main window trigger the settle checks. Each tick
  // reads the item selection and scans for note editors.
  const intervalDelayMs = params.intervalDelayMs ?? 2000;
  const trackedSelectionDocuments = new Set<Document>();
  let debounceTimer: number | null = null;
  let immediateTimer: number | null = null;
  let disposed = false;

  const refresh = () => {
    if (!disposed) params.refresh();
  };
  const debouncedRefresh: EventListener = () => {
    if (disposed) return;
    if (debounceTimer !== null) {
      params.timerHost.clearTimeout(debounceTimer);
    }
    debounceTimer = params.timerHost.setTimeout(() => {
      debounceTimer = null;
      refresh();
    }, debounceDelayMs);
  };
  const scheduleSettleCheck = (step: number) => {
    immediateTimer = params.timerHost.setTimeout(() => {
      immediateTimer = null;
      refresh();
      if (!disposed && step + 1 < SETTLE_CHECK_DELAYS_MS.length) {
        scheduleSettleCheck(step + 1);
      }
    }, SETTLE_CHECK_DELAYS_MS[step]!);
  };
  const immediateRefresh: EventListener = () => {
    if (disposed) return;
    if (immediateTimer !== null) {
      params.timerHost.clearTimeout(immediateTimer);
    }
    // A new event restarts the sequence, so a burst keeps one pending check.
    scheduleSettleCheck(0);
  };
  const intervalId = params.timerHost.setInterval(refresh, intervalDelayMs);

  const trackSelectionDocument = (doc: Document) => {
    if (disposed || trackedSelectionDocuments.has(doc)) return;
    trackedSelectionDocuments.add(doc);
    doc.addEventListener("selectionchange", debouncedRefresh, true);
    doc.addEventListener("mouseup", immediateRefresh, true);
    doc.addEventListener("keyup", immediateRefresh, true);
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    params.timerHost.clearInterval(intervalId);
    if (debounceTimer !== null) {
      params.timerHost.clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (immediateTimer !== null) {
      params.timerHost.clearTimeout(immediateTimer);
      immediateTimer = null;
    }
    for (const doc of trackedSelectionDocuments) {
      doc.removeEventListener("selectionchange", debouncedRefresh, true);
      doc.removeEventListener("mouseup", immediateRefresh, true);
      doc.removeEventListener("keyup", immediateRefresh, true);
    }
    trackedSelectionDocuments.clear();
    params.onDispose?.();
  };

  return { trackSelectionDocument, dispose };
}
