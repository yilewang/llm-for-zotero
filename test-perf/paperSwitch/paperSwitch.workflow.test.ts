import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../../src/modules/contextPanel/workflowTestTypes";
import { appendMessage } from "../../src/utils/chatStore";

declare const Zotero: any;
declare const Services: any;

const enabled = Services.env.get("LLM_FOR_ZOTERO_PAPER_SWITCH_BENCH") === "1";
const SWITCHES = Number(
  Services.env.get("LLM_FOR_ZOTERO_PAPER_SWITCH_BENCH_SWITCHES") || "20",
);
const TURNS = Number(
  Services.env.get("LLM_FOR_ZOTERO_PAPER_SWITCH_BENCH_TURNS") || "20",
);
const LABEL =
  Services.env.get("LLM_FOR_ZOTERO_PAPER_SWITCH_BENCH_LABEL") || "unlabelled";

type SwitchSample = {
  index: number;
  target: string;
  /** Time the awaited selectItem call blocked the caller. */
  selectMs: number;
  /** Until the panel shows the target paper's full conversation. */
  visibleMs: number;
  /** Until the panel stopped changing for SETTLE_MS (last change time). */
  settledMs: number;
  /** Longest gap between animation frames during the switch. */
  maxFrameGapMs: number;
  /** Times a new panel root (#llm-main) was inserted. */
  panelRebuilds: number;
  /** Times the whole conversation was drawn into the chat box. */
  chatDraws: number;
};

const SETTLE_MS = 400;

function assistantText(paper: string, turn: number): string {
  return [
    `**${paper} answer ${turn}.** The method fits a model with loss $L(\\theta) = \\sum_i (y_i - f_\\theta(x_i))^2$ and reports the result below.`,
    "",
    "- First point about the sample size and the effect estimate.",
    "- Second point, with inline maths $\\alpha = 0.05$ and a [link](https://example.org).",
    "- Third point comparing the baseline against the proposed method.",
    "",
    "$$\\hat{\\beta} = (X^\\top X)^{-1} X^\\top y$$",
    "",
    "```python",
    "def fit(x, y):",
    "    return np.linalg.lstsq(x, y, rcond=None)[0]",
    "```",
    "",
    "In short, the effect holds across the reported conditions, although the authors note limits in how the data were collected.",
  ].join("\n");
}

describe("measurement: switching papers in the library side panel", function () {
  this.timeout(900000);

  it("times repeated switches between two papers with seeded chats", async function () {
    if (!enabled) {
      this.skip();
      return;
    }
    assert.include(
      Zotero.DataDirectory.dir,
      ".scaffold/test/data",
      "disposable profile only",
    );
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    const win = Zotero.getMainWindow() as any;
    const layoutPref = "extensions.zotero.llmforzotero.sidebarLayout";
    const previousLayout = Zotero.Prefs.get(layoutPref, true);
    const fixtures: WorkflowTestFixture[] = [];
    const report = {
      schema: 1,
      label: LABEL,
      zoteroVersion: Zotero.version,
      workload: {
        switches: SWITCHES,
        turnsPerPaper: TURNS,
        settleMs: SETTLE_MS,
      },
      warmup: [] as SwitchSample[],
      samples: [] as SwitchSample[],
    };
    const save = () =>
      Zotero.File.putContentsAsync(
        `${Zotero.DataDirectory.dir}/paper-switch-bench.json`,
        JSON.stringify(report, null, 2),
      );

    const until = async (check: () => boolean, message: string) => {
      const deadline = Date.now() + 20000;
      while (!check() && Date.now() < deadline) await Zotero.Promise.delay(20);
      assert.isTrue(check(), message);
    };
    const details = () => win.document.getElementById("zotero-item-details");
    const section = () =>
      details()?.querySelector(".llm-dedicated-chat-pane") as Element | null;
    const panel = () =>
      section()?.querySelector("#llm-main") as HTMLElement | null;

    const openChatPane = async () => {
      const d = details();
      if (
        win.document.documentElement.getAttribute("data-llm-pane-view") !==
          "chat" ||
        d.sidenav._collapsed
      ) {
        const paneID =
          section()?.getAttribute("data-pane") ||
          (section() as any)?.dataset?.pane;
        const button = Array.from(
          d.sidenav.querySelectorAll("[data-pane]"),
        ).find((node: any) => node.getAttribute("data-pane") === paneID) as
          | Element
          | undefined;
        assert.isOk(button, "chat rail icon exists");
        button!.dispatchEvent(
          new win.MouseEvent("click", { bubbles: true, detail: 1, button: 0 }),
        );
      }
      await until(
        () =>
          !d.sidenav._collapsed &&
          (panel()?.getBoundingClientRect().height || 0) > 0 &&
          Boolean(panel()?.dataset.handlersInitialized),
        "chat pane is open",
      );
    };

    const expectedWrappers = TURNS * 2;
    const showsPaper = (fixture: WorkflowTestFixture, marker: string) => {
      const root = panel();
      if (!root || root.dataset.ownershipBlocked) return false;
      if (root.dataset.basePaperItemId !== `${fixture.parentItemId}`)
        return false;
      const chatBox = root.querySelector("#llm-chat-box");
      if (!chatBox) return false;
      const wrappers = chatBox.querySelectorAll(".llm-message-wrapper");
      if (wrappers.length !== expectedWrappers) return false;
      return (wrappers[wrappers.length - 1].textContent || "").includes(marker);
    };

    const measureSwitch = async (
      index: number,
      fixture: WorkflowTestFixture,
      marker: string,
    ): Promise<SwitchSample> => {
      const host = section()!;
      let panelRebuilds = 0;
      let chatDraws = 0;
      let lastMutationAt = 0;
      const observer = new win.MutationObserver((records: any[]) => {
        lastMutationAt = performance.now();
        let wrappersAdded = 0;
        for (const record of records) {
          for (const node of Array.from(record.addedNodes) as any[]) {
            if (node.nodeType !== 1) continue;
            if (node.id === "llm-main") panelRebuilds++;
            if (node.classList?.contains("llm-message-wrapper"))
              wrappersAdded++;
            else
              wrappersAdded +=
                node.querySelectorAll?.(".llm-message-wrapper").length || 0;
          }
        }
        // One full draw adds every message wrapper in one task.
        if (wrappersAdded >= expectedWrappers / 2) chatDraws++;
      });
      observer.observe(host, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
      let maxFrameGapMs = 0;
      let lastFrame = performance.now();
      let framesRunning = true;
      const onFrame = (now: number) => {
        maxFrameGapMs = Math.max(maxFrameGapMs, now - lastFrame);
        lastFrame = now;
        if (framesRunning) win.requestAnimationFrame(onFrame);
      };
      win.requestAnimationFrame(onFrame);
      await Zotero.Promise.delay(50);
      lastFrame = performance.now();
      maxFrameGapMs = 0;

      const startedAt = performance.now();
      lastMutationAt = startedAt;
      await win.ZoteroPane.selectItem(fixture.parentItemId);
      const selectMs = performance.now() - startedAt;
      await until(
        () => showsPaper(fixture, marker),
        `panel shows ${marker} (switch ${index})`,
      );
      const visibleMs = performance.now() - startedAt;
      // Settled: no change to the panel for SETTLE_MS.
      while (performance.now() - lastMutationAt < SETTLE_MS) {
        await Zotero.Promise.delay(25);
      }
      framesRunning = false;
      observer.disconnect();
      assert.isTrue(showsPaper(fixture, marker), "still on the target paper");
      return {
        index,
        target: marker,
        selectMs: Math.round(selectMs * 10) / 10,
        visibleMs: Math.round(visibleMs * 10) / 10,
        settledMs: Math.round((lastMutationAt - startedAt) * 10) / 10,
        maxFrameGapMs: Math.round(maxFrameGapMs * 10) / 10,
        panelRebuilds,
        chatDraws,
      };
    };

    try {
      await api.reset();
      Zotero.Prefs.set(layoutPref, "independent", true);
      const papers = ["Switch bench A", "Switch bench B"];
      for (const title of papers) {
        const fixture = await api.createPaperWithPdfFixture({
          title,
          pdfTitle: title,
        });
        fixtures.push(fixture);
        const base = Date.now() - TURNS * 10000;
        for (let turn = 1; turn <= TURNS; turn++) {
          await appendMessage(fixture.parentItemId, {
            role: "user",
            text: `${title} question ${turn}: what does the paper find?`,
            timestamp: base + turn * 1000,
          });
          await appendMessage(fixture.parentItemId, {
            role: "assistant",
            text: assistantText(title, turn),
            timestamp: base + turn * 1000 + 1,
          });
        }
      }
      const markers = papers.map((title) => `${title} answer ${TURNS}.`);

      await win.ZoteroPane.selectItem(fixtures[0].parentItemId);
      await openChatPane();
      await until(
        () => showsPaper(fixtures[0], markers[0]),
        "first paper's chat is shown",
      );
      // Warm both conversations and the rendering modules.
      for (let n = 0; n < 4; n++) {
        const target = (n + 1) % 2;
        report.warmup.push(
          await measureSwitch(n, fixtures[target], markers[target]),
        );
      }
      for (let n = 0; n < SWITCHES; n++) {
        const target = (n + 1) % 2;
        report.samples.push(
          await measureSwitch(n, fixtures[target], markers[target]),
        );
        await save();
      }
    } finally {
      await save();
      await api.reset();
      for (const fixture of fixtures) await api.cleanupFixture(fixture);
      if (previousLayout === undefined) Zotero.Prefs.clear(layoutPref, true);
      else Zotero.Prefs.set(layoutPref, previousLayout, true);
    }
  });
});
