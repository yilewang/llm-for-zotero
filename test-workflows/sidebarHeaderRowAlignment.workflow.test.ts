/**
 * The Independent sidebar's two header rows sit beside Zotero's own two rows
 * in the library tab: the Paper chat | Library chat toggle beside the items
 * toolbar (new item, search), and the action row (new chat, history, runtime
 * systems, panel actions) beside the item list's column headers (Title, Year,
 * Publication). Each plugin row must share its native row's centre line, so
 * the two panes read as one band. The plugin's font size must not move them.
 */
import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

const LAYOUT_PREF = "extensions.zotero.llmforzotero.sidebarLayout";
/** Half a CSS pixel either way: what a 2x screen can still show. */
const TOLERANCE = 0.5;
const FONT_SCALES = [1, 1.4, 1.8];

function getWorkflowTestApi(): WorkflowTestApi {
  const api = (Zotero as any).LLMForZotero?.api?.workflowTest;
  assert.isOk(api, "workflow test API should be installed");
  return api as WorkflowTestApi;
}

const centreY = (rect: DOMRect) => rect.top + rect.height / 2;

describe("workflow: sidebar header rows align with the item list", function () {
  this.timeout(60000);

  let api: WorkflowTestApi;
  let fixture: WorkflowTestFixture | null = null;
  let win: any;
  let savedLayout: unknown;

  before(function () {
    win = Zotero.getMainWindow();
    savedLayout = Zotero.Prefs.get(LAYOUT_PREF, true);
  });

  after(function () {
    if (savedLayout === undefined) Zotero.Prefs.clear?.(LAYOUT_PREF, true);
    else Zotero.Prefs.set(LAYOUT_PREF, savedLayout as never, true);
  });

  beforeEach(async function () {
    api = getWorkflowTestApi();
    await api.reset();
  });

  afterEach(async function () {
    if (fixture) await api.cleanupFixture(fixture);
    fixture = null;
    await api.reset();
  });

  async function until(check: () => boolean, message: string) {
    const deadline = Date.now() + 10000;
    while (!check() && Date.now() < deadline) {
      await Zotero.Promise.delay(50);
    }
    assert.isTrue(check(), message);
  }

  function libraryDetails(): any {
    return Array.from(win.document.querySelectorAll("item-details")).find(
      (node: any) =>
        node.tabType === "library" && node.getBoundingClientRect().width > 0,
    );
  }

  /** Select the fixture in the library tab and open its Independent chat. */
  async function openIndependentChat(itemId: number): Promise<HTMLElement> {
    Zotero.Prefs.set(LAYOUT_PREF, "independent", true);
    win.Zotero_Tabs.select("zotero-pane");
    await win.ZoteroPane.selectItem(itemId);
    const details = libraryDetails();
    assert.isOk(details, "the library tab's item details is visible");
    const section = () =>
      details.querySelector(".llm-dedicated-chat-pane") as HTMLElement | null;
    const mainVisible = () =>
      (section()?.querySelector("#llm-main")?.getBoundingClientRect().height ||
        0) > 0;
    if (
      win.document.documentElement.getAttribute("data-llm-pane-view") !==
        "chat" ||
      details.sidenav._collapsed ||
      !mainVisible()
    ) {
      const paneID = section()?.dataset.pane;
      const button: any = Array.from(
        details.sidenav.querySelectorAll("[data-pane]"),
      ).find((node: any) => node.getAttribute("data-pane") === paneID);
      assert.isOk(button, "the plugin's rail icon exists");
      button.dispatchEvent(
        new win.MouseEvent("click", { bubbles: true, detail: 1, button: 0 }),
      );
    }
    await until(
      () =>
        win.document.documentElement.getAttribute("data-llm-pane-view") ===
          "chat" &&
        !details.sidenav._collapsed &&
        mainVisible(),
      "the Independent chat is open and visible",
    );
    return section()!.querySelector("#llm-main") as HTMLElement;
  }

  function nativeRows() {
    const doc = win.document as Document;
    const toolbar = doc.querySelector("#zotero-items-toolbar");
    const columnHeader = doc.querySelector(
      "#zotero-items-tree .virtualized-table-header",
    );
    assert.isOk(toolbar, "the items toolbar is rendered");
    assert.isOk(columnHeader, "the item list's column header is rendered");
    return {
      toolbar: toolbar!.getBoundingClientRect(),
      columnHeader: columnHeader!.getBoundingClientRect(),
    };
  }

  function pluginRows(root: HTMLElement) {
    const tabs = root.querySelector(".llm-header-mode-tabs");
    const newChat = root.querySelector("#llm-history-new");
    const clear = root.querySelector("#llm-clear");
    assert.isOk(tabs, "the Paper chat | Library chat toggle is rendered");
    assert.isOk(newChat, "the new chat button is rendered");
    assert.isOk(clear, "the delete button is rendered");
    return {
      tabs: tabs!.getBoundingClientRect(),
      newChat: newChat!.getBoundingClientRect(),
      clear: clear!.getBoundingClientRect(),
    };
  }

  it("centres the toggle on the items toolbar and the actions on the column headers", async function () {
    fixture = await api.createPaperWithPdfFixture({
      title: "Header Row Alignment Paper",
      pdfTitle: "Header Row Alignment PDF",
    });
    const root = await openIndependentChat(fixture.parentItemId);
    const previousScale = root.style.getPropertyValue("--llm-font-scale");
    const docRoot = win.document.documentElement as HTMLElement;
    const span = (selector: string) => {
      const rect = root
        .closest(".llm-dedicated-chat-pane")
        ?.querySelector(selector)
        ?.getBoundingClientRect();
      return rect ? `${rect.top.toFixed(1)}–${rect.bottom.toFixed(1)}` : "none";
    };
    const sizes = () =>
      [
        "--llm-library-toggle-row-height",
        "--llm-library-header-row-gap",
        "--llm-library-action-row-height",
      ]
        .map((name) => docRoot.style.getPropertyValue(name) || "unset")
        .join(" / ");
    const report: string[] = [];
    const offsets: number[] = [];
    try {
      for (const scale of FONT_SCALES) {
        root.style.setProperty("--llm-font-scale", String(scale));
        await Zotero.Promise.delay(100);
        const native = nativeRows();
        const plugin = pluginRows(root);
        const measured = {
          toggle: centreY(plugin.tabs) - centreY(native.toolbar),
          newChat: centreY(plugin.newChat) - centreY(native.columnHeader),
          clear: centreY(plugin.clear) - centreY(native.columnHeader),
        };
        offsets.push(measured.toggle, measured.newChat, measured.clear);
        report.push(
          `scale ${scale}: toggle ${measured.toggle.toFixed(2)}, ` +
            `new chat ${measured.newChat.toFixed(2)}, delete ${measured.clear.toFixed(2)} ` +
            `(toolbar ${native.toolbar.top.toFixed(1)}–${native.toolbar.bottom.toFixed(1)}, ` +
            `column header ${native.columnHeader.top.toFixed(1)}–${native.columnHeader.bottom.toFixed(1)}; ` +
            `toggle row ${span(".llm-header-toggle-row")}, action row ${span(".llm-header-nav-row")}; ` +
            `aligned ${docRoot.getAttribute("data-llm-library-header-aligned") || "unset"}, sizes ${sizes()})`,
        );
      }
    } finally {
      if (previousScale)
        root.style.setProperty("--llm-font-scale", previousScale);
      else root.style.removeProperty("--llm-font-scale");
    }
    Zotero.debug(`HEADER_ROW_ALIGNMENT ${JSON.stringify(report)}`, 1);
    for (const offset of offsets) {
      assert.isAtMost(Math.abs(offset), TOLERANCE, report.join("\n"));
    }
  });
});
