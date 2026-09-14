import { assert } from "chai";
import { installStandaloneSidebarFlyout } from "../src/modules/contextPanel/standaloneSidebarFlyout";

type Listener = (event: any) => void;

class FakeElement {
  readonly listeners = new Map<string, Listener[]>();
  readonly children: FakeElement[] = [];

  addEventListener(type: string, listener: Listener): void {
    const current = this.listeners.get(type) || [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  removeEventListener(type: string, listener: Listener): void {
    const current = this.listeners.get(type) || [];
    const index = current.indexOf(listener);
    if (index >= 0) current.splice(index, 1);
  }

  contains(node: unknown): boolean {
    if (node === this) return true;
    return this.children.some((child) => child.contains(node));
  }

  dispatch(type: string, event: Record<string, unknown> = {}): void {
    for (const listener of [...(this.listeners.get(type) || [])]) {
      listener({ relatedTarget: null, ...event });
    }
  }
}

function createHarness(options?: { collapsed?: boolean }) {
  const toggle = new FakeElement();
  const panel = new FakeElement();
  const panelChild = new FakeElement();
  panel.children.push(panelChild);
  const opened: boolean[] = [];
  let collapsed = options?.collapsed ?? true;
  const timers = new Map<number, () => void>();
  let nextTimerId = 1;
  const win = {
    setTimeout(fn: () => void) {
      const id = nextTimerId++;
      timers.set(id, fn);
      return id;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
  };
  const dispose = installStandaloneSidebarFlyout({
    win: win as unknown as Window,
    toggle: toggle as unknown as HTMLElement,
    panel: panel as unknown as HTMLElement,
    isCollapsed: () => collapsed,
    setOpen: (open: boolean) => opened.push(open),
  });
  return {
    toggle,
    panel,
    panelChild,
    opened,
    dispose,
    runTimers() {
      const pending = [...timers.values()];
      timers.clear();
      for (const fn of pending) fn();
    },
    pendingTimers: () => timers.size,
    setCollapsed(value: boolean) {
      collapsed = value;
    },
  };
}

describe("standalone sidebar hover flyout", function () {
  it("reveals the sidebar when the pointer reaches the collapse toggle", function () {
    const harness = createHarness();

    harness.toggle.dispatch("mouseenter");

    assert.deepEqual(harness.opened, [true]);
  });

  it("stays open while the pointer travels from the toggle into the panel", function () {
    const harness = createHarness();
    harness.toggle.dispatch("mouseenter");
    harness.opened.length = 0;

    harness.toggle.dispatch("mouseleave", {
      relatedTarget: harness.panelChild,
    });
    harness.runTimers();

    assert.deepEqual(harness.opened, []);
  });

  it("closes once the pointer leaves both the toggle and the panel", function () {
    const harness = createHarness();
    harness.toggle.dispatch("mouseenter");
    harness.opened.length = 0;

    harness.toggle.dispatch("mouseleave", { relatedTarget: new FakeElement() });
    assert.deepEqual(
      harness.opened,
      [],
      "closing must be deferred, not instant",
    );
    harness.runTimers();

    assert.deepEqual(harness.opened, [false]);
  });

  it("cancels a pending close when the pointer comes back", function () {
    const harness = createHarness();
    harness.toggle.dispatch("mouseenter");
    harness.opened.length = 0;
    harness.toggle.dispatch("mouseleave", { relatedTarget: new FakeElement() });

    harness.panel.dispatch("mouseenter");
    harness.runTimers();

    assert.deepEqual(harness.opened, []);
    assert.equal(harness.pendingTimers(), 0);
  });

  it("closes immediately when an action inside the panel is chosen", function () {
    const harness = createHarness();
    harness.toggle.dispatch("mouseenter");
    harness.opened.length = 0;

    harness.panel.dispatch("click");

    assert.deepEqual(harness.opened, [false]);
  });

  it("closes immediately on Escape", function () {
    const harness = createHarness();
    harness.toggle.dispatch("mouseenter");
    harness.opened.length = 0;

    harness.panel.dispatch("keydown", { key: "Escape" });

    assert.deepEqual(harness.opened, [false]);
  });

  it("never opens while the sidebar is permanently expanded", function () {
    const harness = createHarness({ collapsed: false });

    harness.toggle.dispatch("mouseenter");

    assert.deepEqual(harness.opened, []);
  });

  it("stops responding once disposed", function () {
    const harness = createHarness();
    harness.dispose();

    harness.toggle.dispatch("mouseenter");

    assert.deepEqual(harness.opened, []);
  });
});
