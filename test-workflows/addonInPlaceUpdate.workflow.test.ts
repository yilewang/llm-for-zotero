import { assert } from "chai";
import { config, version } from "../package.json";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

// Zotero applies a plugin update inside the running app: the old shutdown
// runs, then the new startup runs in the same main windows. These tests stop
// and start the real plugin through AddonManager (the tests themselves run in
// the separate scaffold test plugin, so they keep running) and check that the
// windows end in the same state as after a fresh Zotero start.
describe("workflow: plugin in-place update", function () {
  this.timeout(90000);

  const STYLE_ID = `${config.addonRef}-styles`;
  const KATEX_STYLE_ID = `${config.addonRef}-katex-styles`;
  const KEY_ID = `${config.addonRef}-key-standalone`;
  const FTL_HREF = `${config.addonRef}-mainWindow.ftl`;
  const REOPEN_MARKER = "__llmForZoteroReopenStandalone";
  const SECTION_SELECTOR = "item-pane-custom-section.llm-dedicated-chat-pane";
  const OLD_SECTION_MARK = "data-update-test-old-section";

  function pluginGlobal(): any {
    return (Zotero as any)[config.addonInstance];
  }

  async function getPluginAddon(): Promise<any> {
    const { AddonManager } = ChromeUtils.importESModule(
      "resource://gre/modules/AddonManager.sys.mjs",
    ) as any;
    const addon = await AddonManager.getAddonByID(config.addonID);
    assert.isOk(addon, "the plugin is installed");
    return addon;
  }

  async function until(
    check: () => boolean,
    message: string,
    timeoutMs = 30000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (check()) return;
      } catch {
        // Not ready yet.
      }
      await Zotero.Promise.delay(50);
    }
    assert.fail(message);
  }

  function count(doc: Document, selector: string): number {
    return doc.querySelectorAll(selector).length;
  }

  function windowState(win: Window) {
    const doc = win.document;
    const link = (id: string) =>
      doc.getElementById(id) as HTMLLinkElement | null;
    return {
      styles: count(doc, `[id="${STYLE_ID}"]`),
      katexStyles: count(doc, `[id="${KATEX_STYLE_ID}"]`),
      keys: count(doc, `[id="${KEY_ID}"]`),
      ftlLinks: count(doc, `link[rel="localization"][href="${FTL_HREF}"]`),
      sections: count(doc, SECTION_SELECTOR),
      styleHref: link(STYLE_ID)?.href || "",
      katexHref: link(KATEX_STYLE_ID)?.href || "",
    };
  }

  function sheetRuleCount(win: Window, id: string): number {
    const link = win.document.getElementById(id) as HTMLLinkElement | null;
    return link?.sheet?.cssRules.length || 0;
  }

  async function stopPlugin(addon: any): Promise<any> {
    const previous = pluginGlobal();
    await addon.disable();
    await until(() => !pluginGlobal(), "the plugin global is removed");
    return previous;
  }

  async function startPlugin(addon: any, previous: unknown): Promise<void> {
    await addon.enable();
    await until(
      () =>
        pluginGlobal() !== previous &&
        pluginGlobal()?.data?.initialized === true,
      "the restarted plugin finishes startup",
    );
  }

  function api(): WorkflowTestApi {
    const testApi = pluginGlobal()?.api?.workflowTest;
    assert.isOk(testApi, "workflow test API should be installed");
    return testApi as WorkflowTestApi;
  }

  // An old version's shutdown left its window DOM behind and, when it threw,
  // its addon object as well. The new startup must replace all of it.
  function leaveOldVersionBehind(): { staleHooksCalled: () => boolean } {
    let called = false;
    for (const win of Zotero.getMainWindows()) {
      const doc = win.document;
      const staleLink = (id: string, path: string) => {
        const link = doc.createElement("link") as HTMLLinkElement;
        link.id = id;
        link.rel = "stylesheet";
        link.type = "text/css";
        link.href = `chrome://${config.addonRef}/content/${path}`;
        doc.documentElement?.appendChild(link);
      };
      staleLink(STYLE_ID, "zoteroPane.css");
      staleLink(KATEX_STYLE_ID, "vendor/katex/katex.min.css");
      const keyset = doc.getElementById("mainKeyset");
      for (let i = 0; i < 2; i += 1) {
        const key = (doc as any).createXULElement("key");
        key.id = KEY_ID;
        keyset?.appendChild(key);
      }
      const ftl = doc.createElementNS("http://www.w3.org/1999/xhtml", "link");
      ftl.setAttribute("rel", "localization");
      ftl.setAttribute("href", FTL_HREF);
      (doc.head || doc.documentElement)?.appendChild(ftl);
    }
    const noop = async () => {
      called = true;
    };
    (Zotero as any)[config.addonInstance] = {
      // Versions before this fix stored no version.
      data: { alive: true, initialized: true },
      hooks: {
        onStartup: noop,
        onShutdown: noop,
        onMainWindowLoad: noop,
        onMainWindowUnload: noop,
      },
    };
    return { staleHooksCalled: () => called };
  }

  let pluginAddon: any;

  before(async function () {
    pluginAddon = await getPluginAddon();
  });

  after(async function () {
    // Leave a working plugin for the workflow tests that follow. A fake
    // global left by a failed restart must not pass for the real plugin, so
    // require this version's own data and a live standalone-capable API.
    delete (Zotero as any)[REOPEN_MARKER];
    if (!pluginAddon.isActive) await pluginAddon.enable();
    await until(
      () =>
        pluginGlobal()?.data?.initialized === true &&
        pluginGlobal()?.data?.version === version &&
        pluginGlobal()?.data?.alive === true &&
        typeof pluginGlobal()?.hooks?.onShutdown === "function" &&
        Boolean(pluginGlobal()?.api?.workflowTest),
      "the real plugin is running again after the update tests",
    );
  });

  it("restarts into one fresh copy of its window DOM, replacing an old version's leftovers", async function () {
    const before = Zotero.getMainWindows().map(windowState);
    for (const state of before) {
      assert.deepInclude(state, { styles: 1, katexStyles: 1, keys: 1 });
    }

    // Zotero reuses an item pane section element whose paneID is registered
    // again, and that element keeps the old version's hooks and chat panel.
    for (const win of Zotero.getMainWindows()) {
      win.document
        .querySelectorAll(SECTION_SELECTOR)
        .forEach((node: Element) => node.setAttribute(OLD_SECTION_MARK, "1"));
    }

    for (const win of Zotero.getMainWindows()) {
      assert.isAtLeast(
        count(win.document, SECTION_SELECTOR),
        1,
        "the item pane has a section to clean up",
      );
    }

    const previous = await stopPlugin(pluginAddon);
    for (const win of Zotero.getMainWindows()) {
      assert.deepInclude(
        windowState(win),
        { styles: 0, katexStyles: 0, keys: 0, ftlLinks: 0, sections: 0 },
        "shutdown removes the plugin's window DOM",
      );
    }

    const stale = leaveOldVersionBehind();
    const staleObject = pluginGlobal();
    await startPlugin(pluginAddon, staleObject);

    assert.isFalse(
      stale.staleHooksCalled(),
      "bootstrap calls the new version's hooks, not the old object's",
    );
    assert.notStrictEqual(pluginGlobal(), previous);
    assert.equal(pluginGlobal().data.version, version);
    assert.isTrue(pluginGlobal().data.alive);

    for (const win of Zotero.getMainWindows()) {
      const state = windowState(win);
      const message = JSON.stringify(state);
      assert.equal(state.styles, 1, message);
      assert.equal(state.katexStyles, 1, message);
      assert.equal(state.keys, 1, message);
      assert.equal(state.ftlLinks, 1, message);
      assert.equal(
        count(win.document, `${SECTION_SELECTOR}[${OLD_SECTION_MARK}]`),
        0,
        `no item pane keeps the old section: ${message}`,
      );
      assert.include(state.styleHref, `?v=${version}`, message);
      assert.include(state.katexHref, `?v=${version}`, message);
      // A versioned chrome:// URL must still load, or the panel has no CSS.
      await until(
        () =>
          sheetRuleCount(win, STYLE_ID) > 0 &&
          sheetRuleCount(win, KATEX_STYLE_ID) > 0,
        `the versioned stylesheets load: ${message}`,
        10000,
      );
    }
  });

  // Not covered here: a startup that finds an old version's section element
  // still in the item pane. Zotero builds those elements from its own section
  // registry, so a stand-in element would not exercise the real removal path.
  // The shutdown-side removal above is the tested half.

  it("reopens the standalone window on the same paper after an update", async function () {
    const fixture = await api().createPaperWithPdfFixture({
      title: "In-place Update Reopen Paper",
      pdfTitle: "In-place Update Reopen Paper PDF",
    });
    try {
      await reopenCheck(fixture.parentItemId);
    } finally {
      await api().closeStandalone();
      await api().cleanupFixture(fixture);
    }
  });

  it("reopens the library chat after an update when no paper was open", async function () {
    await reopenCheck(null);
  });

  async function reopenCheck(paperItemID: number | null): Promise<void> {
    const before = paperItemID
      ? await api().openStandaloneForItem(paperItemID)
      : await api().openStandaloneForLibraryAfterRestart();
    assert.equal(before.activeTab, paperItemID ? "paper" : "open");
    const standalone = pluginGlobal().data.standaloneWindow as Window;
    assert.isOk(standalone && !standalone.closed, "standalone window is open");
    const mainCss = standalone.document.querySelector(
      'link[rel="stylesheet"][href*="zoteroPane.css"]',
    ) as HTMLLinkElement | null;
    assert.include(mainCss?.href || "", `?v=${version}`);
    assert.isAbove(mainCss?.sheet?.cssRules.length || 0, 0);

    // The bootstrap shutdown for an update; disable/enable below only
    // unloads and reloads the script, as Zotero does between the two calls.
    const previous = pluginGlobal();
    await previous.hooks.onShutdown({ isUpgrade: true });
    assert.deepEqual(
      (Zotero as any)[REOPEN_MARKER],
      { initialItemID: paperItemID },
      "shutdown records the open chat",
    );
    await until(() => standalone.closed, "shutdown closes the window");
    await stopPlugin(pluginAddon);
    await startPlugin(pluginAddon, previous);

    await until(() => {
      const win = pluginGlobal().data.standaloneWindow as Window | undefined;
      return Boolean(win && !win.closed);
    }, "the new version reopens the standalone window");
    assert.isUndefined(
      (Zotero as any)[REOPEN_MARKER],
      "the reopen marker is cleared",
    );
    // Clicking the tab that is already active reads the window's state.
    const after = await api().clickStandaloneTab(
      paperItemID ? "paper" : "open",
    );
    assert.equal(after.activeTab, before.activeTab, "same chat kind");
    assert.equal(
      after.conversationKey,
      before.conversationKey,
      "the same chat comes back",
    );
    await api().closeStandalone();
  }
});
