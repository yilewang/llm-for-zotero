import { assert } from "chai";
import { createNoteEditingSelectionTrackingLifecycle } from "../src/modules/contextPanel/noteEditing/selectionTrackingLifecycle";

type SelectionEventName = "selectionchange" | "mouseup" | "keyup";

class TrackingDocument {
  private readonly listeners = new Map<
    SelectionEventName,
    Set<EventListenerOrEventListenerObject>
  >();

  addEventListener(
    type: SelectionEventName,
    listener: EventListenerOrEventListenerObject,
  ): void {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(
    type: SelectionEventName,
    listener: EventListenerOrEventListenerObject,
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: SelectionEventName): void {
    const event = { type } as Event;
    for (const listener of this.listeners.get(type) || []) {
      if (typeof listener === "function") {
        listener(event);
      } else {
        listener.handleEvent(event);
      }
    }
  }

  listenerCount(type: SelectionEventName): number {
    return this.listeners.get(type)?.size || 0;
  }
}

describe("note editing selection tracking lifecycle", function () {
  it("disposes timers, document listeners, and its marker exactly once", function () {
    let nextTimerId = 1;
    const intervalCallbacks = new Map<number, () => void>();
    const timeoutCallbacks = new Map<number, () => void>();
    const clearedIntervals: number[] = [];
    const clearedTimeouts: number[] = [];
    const timerHost = {
      setInterval(callback: () => void): number {
        const timerId = nextTimerId++;
        intervalCallbacks.set(timerId, callback);
        return timerId;
      },
      clearInterval(timerId: number): void {
        clearedIntervals.push(timerId);
        intervalCallbacks.delete(timerId);
      },
      setTimeout(callback: () => void): number {
        const timerId = nextTimerId++;
        timeoutCallbacks.set(timerId, callback);
        return timerId;
      },
      clearTimeout(timerId: number): void {
        clearedTimeouts.push(timerId);
        timeoutCallbacks.delete(timerId);
      },
    };
    let refreshCount = 0;
    let markerCleanupCount = 0;
    const lifecycle = createNoteEditingSelectionTrackingLifecycle({
      timerHost,
      refresh: () => {
        refreshCount += 1;
      },
      onDispose: () => {
        markerCleanupCount += 1;
      },
    });
    const firstDocument = new TrackingDocument();
    const secondDocument = new TrackingDocument();

    lifecycle.trackSelectionDocument(firstDocument as unknown as Document);
    lifecycle.trackSelectionDocument(secondDocument as unknown as Document);
    firstDocument.dispatch("selectionchange");
    firstDocument.dispatch("mouseup");

    lifecycle.dispose();
    lifecycle.dispose();

    assert.deepEqual(clearedIntervals, [1]);
    assert.sameMembers(clearedTimeouts, [2, 3]);
    assert.equal(intervalCallbacks.size, 0);
    assert.equal(timeoutCallbacks.size, 0);
    assert.equal(markerCleanupCount, 1);
    assert.equal(refreshCount, 0);
    for (const doc of [firstDocument, secondDocument]) {
      assert.equal(doc.listenerCount("selectionchange"), 0);
      assert.equal(doc.listenerCount("mouseup"), 0);
      assert.equal(doc.listenerCount("keyup"), 0);
    }

    const lateDocument = new TrackingDocument();
    lifecycle.trackSelectionDocument(lateDocument as unknown as Document);
    lateDocument.dispatch("selectionchange");
    assert.equal(lateDocument.listenerCount("selectionchange"), 0);
    assert.equal(timeoutCallbacks.size, 0);
  });

  it("polls slowly and re-checks shortly after a click or key press", function () {
    let nextTimerId = 1;
    const intervals = new Map<number, number>();
    const timeouts = new Map<number, { callback: () => void; delay: number }>();
    const timerHost = {
      setInterval(_callback: () => void, delay: number): number {
        const timerId = nextTimerId++;
        intervals.set(timerId, delay);
        return timerId;
      },
      clearInterval(timerId: number): void {
        intervals.delete(timerId);
      },
      setTimeout(callback: () => void, delay: number): number {
        const timerId = nextTimerId++;
        timeouts.set(timerId, { callback, delay });
        return timerId;
      },
      clearTimeout(timerId: number): void {
        timeouts.delete(timerId);
      },
    };
    const runNextTimeout = (): number => {
      const [timerId, timer] = [...timeouts.entries()][0]!;
      timeouts.delete(timerId);
      timer.callback();
      return timer.delay;
    };
    let refreshCount = 0;
    const lifecycle = createNoteEditingSelectionTrackingLifecycle({
      timerHost,
      refresh: () => {
        refreshCount += 1;
      },
    });
    // The interval is a safety net for changes no event reports.
    assert.deepEqual([...intervals.values()], [2000]);

    const doc = new TrackingDocument();
    lifecycle.trackSelectionDocument(doc as unknown as Document);
    doc.dispatch("mouseup");
    doc.dispatch("keyup");
    // A burst keeps one pending check.
    assert.equal(timeouts.size, 1);

    // A note editor can mount after the click that opened it.
    const delays: number[] = [];
    while (timeouts.size) delays.push(runNextTimeout());
    assert.deepEqual(delays, [0, 250, 750]);
    assert.equal(refreshCount, 3);

    lifecycle.dispose();
    assert.equal(intervals.size, 0);
  });
});
