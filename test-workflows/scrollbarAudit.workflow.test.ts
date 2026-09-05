import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

function getWorkflowTestApi(): WorkflowTestApi {
  const api = (Zotero as any).LLMForZotero?.api?.workflowTest;
  assert.isOk(api, "workflow test API should be installed");
  return api as WorkflowTestApi;
}

function getStandaloneWindow(): Window {
  const win = (Zotero as any).LLMForZotero?.data?.standaloneWindow as
    | Window
    | undefined;
  assert.isOk(win && !win.closed, "standalone window should be open");
  return win as Window;
}

type ScrollerInfo = {
  desc: string;
  overflowY: string;
  scrollHeight: number;
  clientHeight: number;
  rect: { x: number; y: number; w: number; h: number };
};

function describeElement(el: Element): string {
  const id = el.id ? `#${el.id}` : "";
  const cls = (
    el.className && typeof el.className === "string" ? el.className : ""
  )
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .map((c) => `.${c}`)
    .join("");
  return `${el.tagName.toLowerCase()}${id}${cls}`;
}

/**
 * Every element in the document that can currently paint a vertical
 * scrollbar: computed overflow-y auto/scroll and real overflow, plus the
 * root/document scroller if it overflows.
 */
function collectVerticalScrollers(win: Window): ScrollerInfo[] {
  const doc = win.document;
  const out: ScrollerInfo[] = [];
  const all = Array.from(doc.querySelectorAll("*"));
  for (const el of all) {
    const he = el as HTMLElement;
    if (typeof he.getBoundingClientRect !== "function") continue;
    const rect = he.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) continue;
    let overflowY = "";
    let visibility = "";
    try {
      const cs = win.getComputedStyle(he);
      overflowY = cs?.overflowY || "";
      visibility = cs?.visibility || "";
    } catch {
      continue;
    }
    // visibility:hidden elements paint no scrollbar (e.g. collapsed hover
    // popups) — they are not user-visible scrollers.
    if (visibility !== "visible") continue;
    const scrollable = overflowY === "auto" || overflowY === "scroll";
    if (!scrollable) continue;
    if (he.scrollHeight <= he.clientHeight + 1) continue;
    out.push({
      desc: describeElement(he),
      overflowY,
      scrollHeight: he.scrollHeight,
      clientHeight: he.clientHeight,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
    });
  }
  const rootEl = doc.documentElement;
  if (rootEl && rootEl.scrollHeight > rootEl.clientHeight + 1) {
    out.push({
      desc: `(document root) ${describeElement(rootEl)}`,
      overflowY: win.getComputedStyle(rootEl)?.overflowY || "",
      scrollHeight: rootEl.scrollHeight,
      clientHeight: rootEl.clientHeight,
      rect: { x: 0, y: 0, w: rootEl.clientWidth, h: rootEl.clientHeight },
    });
  }
  return out;
}

/**
 * Turn-level containers must never be scroll containers. CSS computes
 * `overflow-y: auto` for any element that sets only `overflow-x: hidden`,
 * which lets Gecko paint a second turn-height scrollbar next to the
 * conversation scrollbar the moment streaming reflow makes the content
 * 1px taller than the box.
 */
function collectTurnLevelScrollContainers(
  win: Window,
  root?: Element,
): string[] {
  const scope = root || win.document;
  const offenders: string[] = [];
  const turnLevel = Array.from(
    scope.querySelectorAll(
      "#llm-chat-box, .llm-message-wrapper, .llm-bubble, .llm-agent-activity, .llm-rendered-markdown",
    ),
  );
  for (const el of turnLevel) {
    const he = el as HTMLElement;
    const cs = win.getComputedStyle(he);
    if (!cs) continue;
    if (he.id === "llm-chat-box") continue;
    if (cs.overflowY === "auto" || cs.overflowY === "scroll") {
      offenders.push(
        `${describeElement(he)} computed overflow-y=${cs.overflowY} ` +
          `(overflow-x=${cs.overflowX})`,
      );
    }
  }
  return offenders;
}

/** Geometry of the container chain, for the failure report. */
function collectChainGeometry(win: Window): string[] {
  const doc = win.document;
  const selectors = [
    "#llmforzotero-standalone-chat-root",
    ".llm-standalone-lower",
    ".llm-standalone-content-wrapper",
    ".llm-standalone-content",
    "#llm-main",
    ".llm-header",
    "#llm-chat-shell",
    "#llm-chat-box",
    ".llm-input-section",
    "#llm-context-previews",
    "#llm-compose-area",
    "#llm-input",
    ".llm-status-bar",
  ];
  const lines: string[] = [];
  for (const selector of selectors) {
    const el = doc.querySelector(selector) as HTMLElement | null;
    if (!el) {
      lines.push(`${selector}: <missing>`);
      continue;
    }
    const rect = el.getBoundingClientRect();
    const cs = win.getComputedStyle(el);
    lines.push(
      `${selector}: rect=(${Math.round(rect.x)},${Math.round(rect.y)} ` +
        `${Math.round(rect.width)}x${Math.round(rect.height)}) ` +
        `scrollH=${el.scrollHeight} clientH=${el.clientHeight} ` +
        `overflowY=${cs.overflowY} display=${cs.display} flex=${cs.flex}`,
    );
  }
  return lines;
}

const LONG_PARAGRAPH =
  "Fisher information gives a lower bound on mutual information, and the " +
  "derivation walks through the Cramér–Rao bound, the Gaussian channel " +
  "approximation, and the efficient-coding limit in some detail so the " +
  "message occupies multiple rendered lines in the conversation view. ";

const LONG_ASSISTANT_MARKDOWN = [
  "## One sentence version",
  "",
  "This section builds Brunel & Nadal's (1998) classic argument that " +
    "**Fisher information gives a lower bound on mutual information** — " +
    "and it's built in three steps.",
  "",
  "### Step 1 — the estimator view",
  "",
  LONG_PARAGRAPH,
  "",
  "### Step 2 — the channel view",
  "",
  LONG_PARAGRAPH,
  "",
  "- point one about the bound",
  "- point two about the Gaussian approximation",
  "- point three about efficient coding",
  "",
  "### Step 3 — putting it together",
  "",
  LONG_PARAGRAPH,
  LONG_PARAGRAPH,
].join("\n");

describe("workflow: conversation view has a single scrollbar", function () {
  this.timeout(60000);
  const api = getWorkflowTestApi();
  const fixtures: WorkflowTestFixture[] = [];

  after(async function () {
    await api.closeStandalone();
    for (const fixture of fixtures) {
      await api.cleanupFixture(fixture);
    }
    await api.reset();
  });

  it("standalone window shows exactly one vertical scroller (.llm-messages)", async function () {
    const fixture = await api.createPaperWithPdfFixture({
      title: "Scrollbar Audit Paper",
      pdfTitle: "Scrollbar Audit Paper PDF",
    });
    fixtures.push(fixture);
    await api.openStandaloneForItem(fixture.parentItemId);

    const turns: Array<{ role: "user" | "assistant"; text: string }> = [];
    for (let index = 0; index < 3; index++) {
      turns.push({
        role: "user",
        text: `Question ${index + 1}: ${LONG_PARAGRAPH}`,
      });
      turns.push({ role: "assistant", text: LONG_ASSISTANT_MARKDOWN });
    }
    await api.seedStandaloneConversation(turns);

    const win = getStandaloneWindow();
    const scrollers = collectVerticalScrollers(win);
    const report = [
      "vertical scrollers:",
      ...scrollers.map(
        (s) =>
          `  ${s.desc} overflowY=${s.overflowY} ` +
          `scrollH=${s.scrollHeight} clientH=${s.clientHeight} ` +
          `rect=(${s.rect.x},${s.rect.y} ${s.rect.w}x${s.rect.h})`,
      ),
      "chain geometry:",
      ...collectChainGeometry(win).map((line) => `  ${line}`),
    ].join("\n");

    const messagesScrollers = scrollers.filter((s) =>
      s.desc.includes("llm-messages"),
    );
    assert.lengthOf(
      messagesScrollers,
      1,
      `.llm-messages should be the conversation scroller\n${report}`,
    );
    assert.lengthOf(
      scrollers,
      1,
      `only .llm-messages may scroll the conversation\n${report}`,
    );
    assert.deepEqual(
      collectTurnLevelScrollContainers(win),
      [],
      `turn-level containers must not be scroll containers\n${report}`,
    );
  });

  it("sidepanel turn containers are not scroll containers", async function () {
    const fixture = await api.createPaperWithPdfFixture({
      title: "Scrollbar Audit Sidepanel Paper",
      pdfTitle: "Scrollbar Audit Sidepanel Paper PDF",
    });
    fixtures.push(fixture);
    const panel = await api.renderPanelForItem(fixture.parentItemId);
    await api.seedPanelStoredTurn(
      panel.panelId,
      `Sidepanel question: ${LONG_PARAGRAPH}`,
      LONG_ASSISTANT_MARKDOWN,
    );

    const mainWin = Zotero.getMainWindow();
    const host = mainWin.document.querySelector(
      '[data-llm-workflow-test="true"]',
    ) as HTMLElement | null;
    assert.isOk(host, "workflow panel host should be mounted");
    const hostStyle = mainWin.getComputedStyle(host as HTMLElement);
    assert.notInclude(
      ["auto", "scroll"],
      hostStyle.overflowY,
      "panel host body must not be a vertical scroll container",
    );
    assert.deepEqual(
      collectTurnLevelScrollContainers(mainWin, host as HTMLElement),
      [],
      "sidepanel turn-level containers must not be scroll containers",
    );
  });

  it("streaming agent turn does not add a second vertical scroller", async function () {
    const fixture = await api.createPaperWithPdfFixture({
      title: "Scrollbar Audit Streaming Paper",
      pdfTitle: "Scrollbar Audit Streaming Paper PDF",
    });
    fixtures.push(fixture);
    await api.openStandaloneForItem(fixture.parentItemId);

    const runId = "workflow-scroll-audit-run";
    let seq = 0;
    const traceEvent = (payload: Record<string, unknown>) => ({
      runId,
      seq: ++seq,
      eventType: payload.type as string,
      payload,
      createdAt: Date.now(),
    });
    const traceEvents = [
      traceEvent({
        type: "status",
        text: "Validating the request against the attached context.",
      }),
      traceEvent({
        type: "status",
        text: "Request and attached context received",
      }),
      traceEvent({
        type: "reasoning",
        round: 1,
        summary: "Reading the paper's Section 2 first, then explain it.",
        details:
          "The derivation hinges on the Cramér–Rao bound, so start from the " +
          "estimator variance and connect it to the mutual information lower " +
          "bound before simplifying to the high-level story.",
      }),
      traceEvent({
        type: "tool_call",
        callId: "call-1",
        name: "read_document",
        args: { lines: "1-200" },
      }),
      traceEvent({
        type: "tool_result",
        callId: "call-1",
        name: "read_document",
        ok: true,
        content: "Read lines 1-200",
      }),
      traceEvent({ type: "status", text: "ready" }),
    ];

    await api.seedStandaloneConversation([
      { role: "user", text: `Earlier question: ${LONG_PARAGRAPH}` },
      { role: "assistant", text: LONG_ASSISTANT_MARKDOWN },
      {
        role: "user",
        text:
          "hard for me to understand section 2, the math derivation here. " +
          "could you provide me an easy-understanding version? can be more " +
          "high level",
      },
      {
        role: "assistant",
        text: `${LONG_ASSISTANT_MARKDOWN}\n\n${LONG_ASSISTANT_MARKDOWN}`,
        runMode: "agent",
        streaming: true,
        modelName: "claude-sonnet-5",
        pendingAgentTraceEvents: traceEvents as never,
      },
    ]);

    const reports: string[] = [];
    let paintedFailures = 0;
    const scrollContainerOffenders = new Set<string>();
    for (const size of [
      { width: 900, height: 900 },
      { width: 505, height: 850 },
    ]) {
      const resized = await api.resizeStandaloneWindow(size.width, size.height);
      const win = getStandaloneWindow();
      const scrollers = collectVerticalScrollers(win);
      const nonMessages = scrollers.filter(
        (s) => !s.desc.includes("llm-messages"),
      );
      if (nonMessages.length > 0) paintedFailures += 1;
      for (const offender of collectTurnLevelScrollContainers(win)) {
        scrollContainerOffenders.add(offender);
      }
      reports.push(
        [
          `size ${resized.innerWidth}x${resized.innerHeight} vertical scrollers:`,
          ...scrollers.map(
            (s) =>
              `  ${s.desc} overflowY=${s.overflowY} ` +
              `scrollH=${s.scrollHeight} clientH=${s.clientHeight} ` +
              `rect=(${s.rect.x},${s.rect.y} ${s.rect.w}x${s.rect.h})`,
          ),
          "chain geometry:",
          ...collectChainGeometry(win).map((line) => `  ${line}`),
        ].join("\n"),
      );
    }
    const report = reports.join("\n\n");

    assert.strictEqual(
      paintedFailures,
      0,
      `only .llm-messages may scroll during a streaming agent turn\n${report}`,
    );
    assert.deepEqual(
      Array.from(scrollContainerOffenders),
      [],
      `turn-level containers must not be scroll containers ` +
        `(computed overflow-y visible)\n${report}`,
    );
  });
});
