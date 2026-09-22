import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

describe("workflow: reading a full Codex panel during native streaming", function () {
  this.timeout(90000);
  const prefix = "extensions.zotero.llmforzotero.";
  const preferences = {
    enableCodexAppServerMode: true,
    enableClaudeCodeMode: false,
    conversationSystem: "upstream",
    codexAppServerModel: "gpt-5.4",
    codexAppServerReasoning: "auto",
  };
  type Replay = Awaited<
    ReturnType<WorkflowTestApi["createCodexStreamingScrollReplay"]>
  >;
  let api: WorkflowTestApi;
  let fixture: WorkflowTestFixture | undefined;
  let replay: Replay | undefined;
  let panelId: string;
  let body: HTMLElement;
  let box: HTMLDivElement;
  let win: Window;
  const saved = new Map<string, unknown>();
  const delay = (ms: number) => Zotero.Promise.delay(ms);
  const findReading = (marker: string) => {
    const node = Array.from(box.querySelectorAll<HTMLElement>("p, li")).find(
      (node) => node.textContent?.trim().includes(marker),
    );
    // Measure the readable text after a tight list gains paragraph wrappers.
    return node?.querySelector<HTMLElement>(":scope > p") || node;
  };
  const state = (marker: string) => {
    const target = findReading(marker);
    return {
      top: box.scrollTop,
      height: box.scrollHeight,
      viewportHeight: box.clientHeight,
      offset: target
        ? target.getBoundingClientRect().top - box.getBoundingClientRect().top
        : null,
      snapshot: replay!.snapshot(),
    };
  };
  const sendWheel = (delta: number) => {
    const rect = box.getBoundingClientRect();
    win.windowUtils.sendWheelEvent(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
      0,
      delta,
      0,
      win.WheelEvent.DOM_DELTA_LINE,
      0,
      0,
      delta,
      win.windowUtils.WHEEL_EVENT_ASYNC_ENABLED!,
    );
  };
  async function read(marker: string, offset = 12) {
    assert.equal(replay!.snapshot()?.mode, "followBottom");
    let trusted = 0;
    const onWheel = (event: WheelEvent) => {
      if (event.isTrusted) trusted++;
    };
    box.addEventListener("wheel", onWheel);
    try {
      sendWheel(-3);
      await delay(400);
    } finally {
      box.removeEventListener("wheel", onWheel);
    }
    assert.equal(
      trusted,
      1,
      "the native wheel reaches the production lifecycle",
    );
    assert.equal(replay!.snapshot()?.mode, "manual");
    const target = findReading(marker);
    assert.exists(target, `reading target ${marker}`);
    // Position the same destination as a longer upward wheel gesture. The real
    // scroll event updates the production snapshot; no snapshot helper is used.
    box.scrollTop +=
      target!.getBoundingClientRect().top -
      box.getBoundingClientRect().top -
      offset;
    await delay(350);
    assert.equal(replay!.snapshot()?.mode, "manual");
    return state(marker);
  }
  function monitor(marker: string) {
    const samples: Array<ReturnType<typeof state> & { phase: string }> = [];
    const writes: Array<{
      before: number;
      target: number;
      stack: string;
      snapshot: ReturnType<Replay["snapshot"]>;
    }> = [];
    const record = (phase: string) => {
      samples.push({ phase, ...state(marker) });
    };
    const own = Object.getOwnPropertyDescriptor(box, "scrollTop");
    let owner: object | null = box;
    let descriptor: PropertyDescriptor | undefined;
    while (owner && !descriptor) {
      descriptor = Object.getOwnPropertyDescriptor(owner, "scrollTop");
      owner = Object.getPrototypeOf(owner);
    }
    assert.isFunction(descriptor?.get);
    assert.isFunction(descriptor?.set);
    Object.defineProperty(box, "scrollTop", {
      configurable: true,
      get: () => descriptor!.get!.call(box),
      set: (target: number) => {
        writes.push({
          before: descriptor!.get!.call(box),
          target,
          stack: new Error().stack?.split("\n").slice(0, 8).join("\n") || "",
          snapshot: replay!.snapshot(),
        });
        descriptor!.set!.call(box, target);
      },
    });
    const observer = new win.MutationObserver(() => record("mutation"));
    observer.observe(body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["style", "open"],
    });
    const onScroll = () => record("scroll");
    box.addEventListener("scroll", onScroll);
    record("start");
    return {
      samples,
      writes,
      record,
      dispose: () => {
        observer.disconnect();
        box.removeEventListener("scroll", onScroll);
        if (own) Object.defineProperty(box, "scrollTop", own);
        else Reflect.deleteProperty(box, "scrollTop");
      },
    };
  }

  beforeEach(async function () {
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    for (const [name, value] of Object.entries(preferences)) {
      saved.set(name, Zotero.Prefs.get(prefix + name, true));
      Zotero.Prefs.set(prefix + name, value, true);
    }
    api.configurePermissionCatalogs();
    fixture = await api.createPaperWithPdfFixture({
      title: "Codex streaming scroll",
      pdfTitle: "Codex streaming scroll PDF",
    });
    const panel = await api.renderPanelForItem(fixture.parentItemId);
    panelId = panel.panelId;
    assert.equal(
      (await api.clickPanelSystemToggle(panel.panelId, "codex"))
        .conversationSystem,
      "codex",
    );
    const doc = Zotero.getMainWindow().document;
    win = doc.defaultView!;
    body = doc.querySelector<HTMLElement>(
      `[data-workflow-panel-id="${panel.panelId}"]`,
    )!;
    Object.assign(body.style, {
      left: "30px",
      top: "30px",
      width: "340px",
      height: "640px",
      zIndex: "2147483647",
    });
    Object.assign(body.querySelector<HTMLElement>(".llm-chat-shell")!.style, {
      flex: "1 1 0",
      height: "auto",
      minHeight: "80px",
      maxHeight: "none",
    });
    box = body.querySelector<HTMLDivElement>("#llm-chat-box")!;
    replay = await api.createCodexStreamingScrollReplay(panel.panelId);
    assert.isAbove(box.scrollHeight - box.clientHeight, 2000);
    assert.exists(body.querySelector(".llm-agent-activity-details[open]"));
    assert.isAbove(body.querySelectorAll(".llm-quote-card").length, 0);
  });

  afterEach(async function () {
    replay?.dispose();
    replay = undefined;
    try {
      await api.reset();
      if (fixture) await api.cleanupFixture(fixture);
    } finally {
      fixture = undefined;
      for (const [name, value] of saved) {
        if (value === undefined) Zotero.Prefs.clear(prefix + name, true);
        else Zotero.Prefs.set(prefix + name, value, true);
      }
      saved.clear();
    }
  });

  for (const marker of ["历史证据 08：", "当前证据 08："]) {
    it(`keeps ${marker} still while Codex text, tools and status update`, async function () {
      const before = await read(marker);
      const probe = monitor(marker);
      try {
        for (let chunk = 0; chunk < 4; chunk++)
          await replay!.appendChunk(chunk);
        await delay(400);
        probe.record("settled");
        const diagnostic = JSON.stringify({
          before,
          writes: probe.writes,
          samples: probe.samples,
        });
        console.log(`Codex scroll ${marker}: ${diagnostic}`);
        assert.include(box.textContent || "", "追加限制 04");
        assert.include(
          body.querySelector("#llm-status")?.textContent || "",
          "第 4 组",
        );
        for (const sample of probe.samples) {
          assert.isNotNull(sample.offset, diagnostic);
          assert.closeTo(sample.offset!, before.offset!, 1, diagnostic);
          assert.equal(sample.snapshot?.mode, "manual", diagnostic);
        }
      } finally {
        probe.dispose();
      }
    });
  }

  it("keeps the fourth numbered item visible when a streamed blank line makes its list loose", async function () {
    replay!.dispose();
    replay = await api.createCodexStreamingScrollReplay(panelId, {
      tightList: true,
    });
    const marker = "当前证据 04：";
    const items = () =>
      Array.from(findReading(marker)!.closest("ol")!.children);
    assert.lengthOf(items(), 8);
    assert.isTrue(items().every((item) => !item.querySelector(":scope > p")));
    assert.equal(
      new Set(items().map((item) => item.textContent!.trim().slice(0, 160)))
        .size,
      1,
      "ordinal matching must handle list items with the same anchor prefix",
    );
    // The fourth item crosses the viewport top, so its preceding item cannot
    // become the reading anchor merely because its last pixels remain visible.
    const before = await read(marker, -12);
    const probe = monitor(marker);
    try {
      await replay!.appendChunk(0);
      await delay(400);
      probe.record("loose-list-settled");
      const diagnostic = JSON.stringify({
        before,
        writes: probe.writes,
        samples: probe.samples,
      });
      console.log(`Codex tight-to-loose list: ${diagnostic}`);
      assert.lengthOf(items(), 9, diagnostic);
      assert.isTrue(
        items().every((item) => !!item.querySelector(":scope > p")),
        diagnostic,
      );
      for (const sample of probe.samples) {
        assert.isNotNull(sample.offset, diagnostic);
        assert.closeTo(sample.offset!, before.offset!, 1, diagnostic);
        assert.equal(sample.snapshot?.mode, "manual", diagnostic);
      }
    } finally {
      probe.dispose();
    }

    // A subsequent real wheel gesture must remain usable, and the next delta
    // must preserve its new reading position instead of restoring the old one.
    const topBeforeWheel = box.scrollTop;
    sendWheel(-1);
    await delay(400);
    const afterWheel = state(marker);
    assert.isBelow(afterWheel.top, topBeforeWheel);
    const continued = monitor(marker);
    try {
      await replay!.appendChunk(1);
      await delay(400);
      continued.record("continued-list-settled");
      const diagnostic = JSON.stringify({
        afterWheel,
        writes: continued.writes,
        samples: continued.samples,
      });
      assert.lengthOf(items(), 10, diagnostic);
      for (const sample of continued.samples) {
        assert.isNotNull(sample.offset, diagnostic);
        assert.closeTo(sample.offset!, afterWheel.offset!, 1, diagnostic);
        assert.equal(sample.snapshot?.mode, "manual", diagnostic);
      }
    } finally {
      continued.dispose();
    }
  });

  it("lets real wheel gestures browse the active numbered translation while Codex streams", async function () {
    const marker = "当前证据 08：";
    const before = await read(marker);
    async function run(streaming: boolean) {
      box.scrollTop = before.top;
      await delay(400);
      const probe = monitor(marker);
      let output: Promise<void> | undefined;
      const started = Date.now();
      try {
        if (streaming)
          output = (async () => {
            for (let chunk = 0; chunk < 4; chunk++)
              await replay!.appendChunk(chunk);
          })();
        let sent = 0;
        while (Date.now() - started < 1900) {
          const elapsed = Date.now() - started;
          const times = [0, 70, 140, 210, 750, 820];
          if (sent < times.length && elapsed >= times[sent]) {
            sendWheel(sent < 4 ? -3 : 1);
            sent++;
          }
          probe.record(`sample:${elapsed}`);
          await delay(15);
        }
        await output;
        await delay(400);
        probe.record("settled");
        return {
          start: before.top,
          end: box.scrollTop,
          samples: probe.samples,
          writes: probe.writes,
        };
      } finally {
        if (output) await output;
        probe.dispose();
      }
    }
    const control = await run(false);
    const streaming = await run(true);
    const diagnostic = JSON.stringify({ control, streaming });
    console.log(`Codex concurrent wheel: ${diagnostic}`);
    assert.isAbove(control.start - control.end, 50, diagnostic);
    assert.closeTo(
      streaming.start - streaming.end,
      control.start - control.end,
      2,
      diagnostic,
    );
    assert.isEmpty(control.writes, diagnostic);
    assert.isEmpty(streaming.writes, diagnostic);
    const upward = streaming.samples.filter(
      (sample) =>
        sample.phase.startsWith("sample:") &&
        Number(sample.phase.slice(7)) < 700,
    );
    for (let index = 1; index < upward.length; index++)
      assert.isAtMost(upward[index].top - upward[index - 1].top, 1, diagnostic);
    assert.equal(replay!.snapshot()?.mode, "manual", diagnostic);
  });
});
