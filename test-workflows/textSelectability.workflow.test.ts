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
 * The used value of `user-select`: `auto` defers to the nearest ancestor with
 * a concrete value, and chrome documents root at `none` — which is exactly why
 * hint text has been unselectable. An element only reads as selectable when
 * the first concrete value up its chain is `text`.
 */
function effectiveUserSelect(win: Window, el: Element): string {
  let node: Element | null = el;
  while (node) {
    let value = "";
    try {
      const cs = win.getComputedStyle(node as HTMLElement);
      value =
        (cs as CSSStyleDeclaration & { userSelect?: string }).userSelect ||
        cs.getPropertyValue("user-select") ||
        "";
    } catch {
      return "unknown";
    }
    if (value && value !== "auto") return value;
    node = node.parentElement;
  }
  return "text";
}

/**
 * Interactive controls keep `user-select: none` by design; everything else
 * that shows text must be selectable so users can copy hints, statuses, and
 * error messages.
 */
const INTERACTIVE_SELECTOR = [
  "button",
  "select",
  "option",
  "summary",
  "input",
  "textarea",
  "a",
  "[role='button']",
  "[role='tab']",
  "[role='menuitem']",
  "[draggable='true']",
  "[aria-hidden='true']",
].join(", ");

/**
 * `requireLaidOut` restricts the audit to text that is on screen right now —
 * right for the chat surface, where collapsed menus and popups would
 * otherwise register as false offenders. The preferences pane sets it false:
 * its inactive tab panels measure 0x0 yet become visible the moment the user
 * clicks a tab, so their text must be selectable too.
 */
function collectUnselectableTextOffenders(
  win: Window,
  root: Element,
  requireLaidOut: boolean,
): { offenders: string[]; examined: number; diagnostics: string } {
  const offenders: string[] = [];
  const seen = new Set<string>();
  let examined = 0;
  let withText = 0;
  let skippedInteractive = 0;
  let skippedHidden = 0;
  let skippedZeroRect = 0;
  const all = Array.from(root.querySelectorAll("*"));
  for (const el of all) {
    const he = el as HTMLElement;
    const hasDirectText = Array.from(he.childNodes).some(
      (node) =>
        node.nodeType === 3 && (node.textContent || "").trim().length >= 2,
    );
    if (!hasDirectText) continue;
    withText += 1;
    if (he.closest(INTERACTIVE_SELECTOR)) {
      skippedInteractive += 1;
      continue;
    }
    let cs: CSSStyleDeclaration | null = null;
    try {
      cs = win.getComputedStyle(he);
    } catch {
      continue;
    }
    if (!cs || cs.display === "none" || cs.visibility !== "visible") {
      skippedHidden += 1;
      continue;
    }
    if (requireLaidOut) {
      const rect = he.getBoundingClientRect?.();
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        skippedZeroRect += 1;
        continue;
      }
    }
    const cursor = cs.cursor || "";
    // Drag affordances and resize handles legitimately suppress selection.
    if (cursor === "grab" || cursor.includes("resize")) continue;
    examined += 1;
    const effective = effectiveUserSelect(win, he);
    if (effective === "text" || effective === "all") continue;
    const line =
      `${describeElement(he)} user-select=${effective} ` +
      `text="${(he.textContent || "").trim().slice(0, 48)}"`;
    if (seen.has(line)) continue;
    seen.add(line);
    offenders.push(line);
  }
  const diagnostics =
    `elements=${all.length} withDirectText=${withText} ` +
    `skipped(interactive=${skippedInteractive}, hidden=${skippedHidden}, ` +
    `zeroRect=${skippedZeroRect}) examined=${examined}`;
  return { offenders, examined, diagnostics };
}

/**
 * An unrendered surface reports zero-size rects for every node, which would
 * let the audit "pass" without inspecting anything. Each surface therefore
 * declares how much visible text it must have seen for the run to count.
 */
function assertSelectable(
  win: Window,
  root: Element,
  minimumExamined: number,
  surface: string,
  requireLaidOut = true,
): void {
  const { offenders, examined, diagnostics } = collectUnselectableTextOffenders(
    win,
    root,
    requireLaidOut,
  );
  assert.isAtLeast(
    examined,
    minimumExamined,
    `${surface}: audited only ${examined} visible text elements — the surface did not render, so this check proves nothing (${diagnostics})`,
  );
  assert.deepEqual(
    offenders,
    [],
    `unselectable text in ${surface} (of ${examined} audited):\n${offenders.join("\n")}`,
  );
}

describe("workflow: hint and message text is selectable", function () {
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

  it("standalone chat surface exposes no unselectable text", async function () {
    const fixture = await api.createPaperWithPdfFixture({
      title: "Selectability Audit Paper",
      pdfTitle: "Selectability Audit Paper PDF",
    });
    fixtures.push(fixture);
    await api.openStandaloneForItem(fixture.parentItemId);
    const win = getStandaloneWindow();
    const root = win.document.documentElement;
    assert.isOk(root, "standalone document root");
    assertSelectable(win, root, 10, "the standalone chat surface");
  });

  it("sidebar chat panel exposes no unselectable text", async function () {
    const fixture = await api.createPaperWithPdfFixture({
      title: "Selectability Audit Sidepanel Paper",
      pdfTitle: "Selectability Audit Sidepanel Paper PDF",
    });
    fixtures.push(fixture);
    const panel = await api.renderPanelForItem(fixture.parentItemId);
    await api.seedPanelStoredTurn(
      panel.panelId,
      "Sidepanel selectability question",
      "Sidepanel assistant answer that the user must be able to copy.",
    );

    const mainWin = Zotero.getMainWindow();
    const host = mainWin.document.querySelector(
      '[data-llm-workflow-test="true"]',
    ) as HTMLElement | null;
    assert.isOk(host, "workflow panel host should be mounted");
    assertSelectable(mainWin, host as Element, 5, "the sidebar chat panel");
  });

  it("plugin preferences pane exposes no unselectable text", async function () {
    const prefsWin = (
      Zotero.Utilities.Internal as unknown as {
        openPreferences: (pane: string) => Window;
      }
    ).openPreferences("llmforzotero-preferences");
    assert.isOk(prefsWin, "preferences window should open");
    try {
      // The pane is injected before it is laid out; auditing it while every
      // node still measures 0x0 would inspect nothing at all.
      const deadline = Date.now() + 30000;
      let paneRoot: Element | null = null;
      while (Date.now() < deadline) {
        paneRoot = prefsWin.document.querySelector("#llmforzotero-prefs");
        const rect = (
          paneRoot as HTMLElement | null
        )?.getBoundingClientRect?.();
        // #llmforzotero-model-sections is filled in by the pane's own script,
        // so children there mean the dynamic settings UI is really built.
        const modelSections = paneRoot?.querySelector(
          "#llmforzotero-model-sections",
        );
        if (
          paneRoot &&
          rect &&
          rect.height > 0 &&
          modelSections &&
          modelSections.childElementCount > 0
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      assert.isOk(paneRoot, "plugin preferences pane should render");
      assert.isAbove(
        (paneRoot as HTMLElement).getBoundingClientRect().height,
        0,
        "preferences pane should be laid out before the audit",
      );
      assertSelectable(
        prefsWin,
        paneRoot as Element,
        50,
        "the preferences pane",
        false,
      );
    } finally {
      // The pane runs its own scripts (provider cards, catalog refreshes).
      // Leaving the window half-closed lets that work land during whichever
      // suite runs next, so wait for the close to actually complete.
      prefsWin.close();
      const closeDeadline = Date.now() + 10000;
      while (!prefsWin.closed && Date.now() < closeDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.isTrue(
        prefsWin.closed,
        "preferences window should close before the next suite runs",
      );
    }
  });
});
