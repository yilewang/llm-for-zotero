import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";
import { getReaderContextPanelForTab } from "../src/modules/contextPanel/readerPopupPanelRouting";

describe("workflow: dedicated native chat pane", function () {
  this.timeout(45000);
  let api: WorkflowTestApi;
  let win: any;
  let fixtures: Awaited<
    ReturnType<WorkflowTestApi["createPaperWithPdfFixture"]>
  >[];
  const readers: any[] = [];
  const layoutPref = "extensions.zotero.llmforzotero.sidebarLayout";
  let originalLayout: unknown;

  async function until(check: () => boolean, message: string) {
    const deadline = Date.now() + 10000;
    while (!check() && Date.now() < deadline) await Zotero.Promise.delay(50);
    assert.isTrue(
      check(),
      `${message}; selected=${win.Zotero_Tabs.selectedID}; view=${win.document.documentElement.getAttribute("data-llm-pane-view")}; collapsed=${activeDetails()?.sidenav?._collapsed}; panels=${JSON.stringify(Array.from(win.document.querySelectorAll("#llm-main")).map((node: any) => ({ ...node.dataset, height: node.getBoundingClientRect().height })))}`,
    );
  }

  function activeDetails(): any {
    const readerPane = getReaderContextPanelForTab(
      win.document,
      win.Zotero_Tabs.selectedID,
    );
    if (readerPane) return readerPane;
    return Array.from(win.document.querySelectorAll("item-details")).find(
      (node: any) =>
        node.tabType === "library" && node.getBoundingClientRect().width > 0,
    );
  }

  async function clickPane(pane: string) {
    const details = activeDetails();
    assert.isOk(details, "native item details is visible");
    const paneID =
      pane === "llm-context-panel"
        ? details.querySelector(".llm-dedicated-chat-pane")?.dataset.pane
        : pane;
    const button: any = Array.from(
      details.sidenav.querySelectorAll("[data-pane]"),
    ).find((node: any) => node.getAttribute("data-pane") === paneID);
    assert.isOk(button, `native ${pane} icon exists`);
    button.dispatchEvent(
      new win.MouseEvent("click", { bubbles: true, detail: 1, button: 0 }),
    );
    await Zotero.Promise.delay(300);
    await until(
      () => !details._disableScrollHandler,
      "native pane navigation settles",
    );
    return details;
  }

  async function openChatPane() {
    const details = activeDetails();
    assert.isOk(details, "native item details is visible");
    // An open independent chat closes on a second rail click. Setup must
    // preserve that state; clickPane remains a literal click for toggle tests.
    if (
      win.document.documentElement.getAttribute("data-llm-pane-view") !==
        "chat" ||
      details.sidenav._collapsed
    )
      await clickPane("llm-context-panel");
    await until(
      () =>
        !details.sidenav._collapsed &&
        details
          .querySelector(".llm-dedicated-chat-pane #llm-main")
          ?.getBoundingClientRect().height > 0,
      "chat is open and visible",
    );
    return details;
  }

  /**
   * Independent: the toggle row, then the actions row. Stacked: one row, with
   * the mode chip in the actions row and no toggle row. Neither has a docked
   * title row or a divider under the header.
   */
  function assertHeaderRows(
    details: Element,
    layout: "independent" | "stacked",
  ) {
    const section = details.querySelector(".llm-dedicated-chat-pane")!;
    assert.isNull(
      section.querySelector(".llm-docked-title-row"),
      `no docked title row (${layout})`,
    );
    const toggleRow = section.querySelector(".llm-header-toggle-row")!;
    const navRow = section.querySelector(".llm-header-nav-row")!;
    const chip = section.querySelector("#llm-mode-capsule")!;
    const firstRow = layout === "independent" ? toggleRow : navRow;
    if (layout === "independent") {
      assert.isAbove(toggleRow.getBoundingClientRect().height, 0);
      assert.isAtMost(
        toggleRow.getBoundingClientRect().bottom,
        navRow.getBoundingClientRect().top + 0.5,
        `the toggle row sits above the actions row (${layout})`,
      );
      assert.equal(
        chip.getBoundingClientRect().width,
        0,
        `no mode chip (${layout})`,
      );
    } else {
      assert.equal(
        toggleRow.getBoundingClientRect().height,
        0,
        `no toggle row (${layout})`,
      );
      assert.isAbove(
        chip.getBoundingClientRect().width,
        0,
        `the mode chip shows (${layout})`,
      );
      assert.isTrue(navRow.contains(chip), `the chip is in the one row`);
    }
    assert.equal(
      win.getComputedStyle(navRow).borderBottomStyle,
      "none",
      `no divider under the actions row (${layout})`,
    );
    // The first row opens the header, a few pixels under the panel's top.
    const panelTop = section
      .querySelector(".llm-panel")!
      .getBoundingClientRect().top;
    const gap = firstRow.getBoundingClientRect().top - panelTop;
    assert.isAtLeast(gap, 0, `first row starts inside the panel (${layout})`);
    assert.isAtMost(gap, 12, `first row leads the header (${layout})`);
  }

  /**
   * Pick a mode with the control the layout shows: the tab (Independent) or
   * the chip (Stacked). Closed chips toggle; open chips pick the clicked row.
   */
  function pickMode(panel: Element, mode: "paper" | "library") {
    const layout = win.document.documentElement.getAttribute(
      "data-llm-sidebar-layout",
    );
    if (layout === "stacked") {
      const chip = panel.querySelector("#llm-mode-capsule") as HTMLElement;
      assert.isAbove(chip.getBoundingClientRect().width, 0, "chip shows");
      if (chip.dataset.mode === mode) return;
      const target =
        chip.dataset.expanded === "true" ? mode : chip.dataset.mode;
      const shown = panel.querySelector(
        `#llm-mode-option-${target}`,
      ) as HTMLElement;
      shown.dispatchEvent(
        new win.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      return;
    }
    (
      panel.querySelector(
        mode === "paper" ? "#llm-paper-chat-tab" : "#llm-library-chat-tab",
      ) as HTMLElement
    ).click();
  }

  function assertSidebarGaps(details: Element) {
    const panel = details.querySelector(".llm-panel")!;
    const chip = panel.querySelector(".llm-shortcuts > .llm-shortcut-btn")!;
    assert.isAbove(
      chip.getBoundingClientRect().width,
      0,
      "shortcut is visible",
    );
    assert.closeTo(
      chip.getBoundingClientRect().left - panel.getBoundingClientRect().left,
      5,
      0.05,
      "shortcut outer edge is 5px from the Independent sidebar boundary",
    );
    const composer = panel.querySelector(":scope > .llm-input-section")!;
    assert.isAbove(
      composer.getBoundingClientRect().width,
      0,
      "composer is visible",
    );
    assert.closeTo(
      composer.getBoundingClientRect().left -
        panel.getBoundingClientRect().left,
      5,
      0.05,
      "composer outer edge aligns with the shortcuts at 5px",
    );
    assert.closeTo(
      panel.getBoundingClientRect().right -
        composer.getBoundingClientRect().right,
      5,
      0.05,
      "composer right edge is 5px from the Independent sidebar boundary",
    );
  }

  async function captureWindow(target: any, filename: string) {
    const canvas = target.document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "canvas",
    );
    const scale = target.devicePixelRatio || 1;
    canvas.width = target.innerWidth * scale;
    canvas.height = target.innerHeight * scale;
    const context = canvas.getContext("2d");
    context.scale(scale, scale);
    context.drawWindow(
      target,
      0,
      0,
      target.innerWidth,
      target.innerHeight,
      "#ffffff",
    );
    const binary = target.atob(canvas.toDataURL("image/png").split(",")[1]);
    await win.IOUtils.write(
      PathUtils.join(Zotero.DataDirectory.dir, filename),
      Uint8Array.from(binary, (char: any) => char.charCodeAt(0)),
    );
  }

  before(async function () {
    // Native runner always launches an isolated .scaffold/test profile/data.
    assert.isTrue(
      Zotero.DataDirectory.dir
        .replace(/\\/g, "/")
        .endsWith("/.scaffold/test/data"),
      "native test data stays inside the isolated scaffold profile",
    );
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    originalLayout = Zotero.Prefs.get(layoutPref, true);
    Zotero.Prefs.set(layoutPref, "independent", true);
    win = Zotero.getMainWindow();
    fixtures = [];
    for (const title of ["Dedicated pane A", "Dedicated pane B"])
      fixtures.push(
        await api.createPaperWithPdfFixture({ title, pdfTitle: title }),
      );
    await win.ZoteroPane.selectItem(fixtures[0].parentItemId);
  });

  after(async function () {
    for (const reader of readers) reader.close();
    for (const fixture of fixtures || []) await api.cleanupFixture(fixture);
    await api.reset();
    if (originalLayout === undefined) Zotero.Prefs.clear(layoutPref, true);
    else Zotero.Prefs.set(layoutPref, originalLayout as string, true);
  });

  function libraryIcon() {
    const details = win.document.getElementById("zotero-item-details");
    const paneID = details.querySelector(".llm-dedicated-chat-pane")?.dataset
      .pane;
    return Array.from(details.sidenav.querySelectorAll("[data-pane]")).find(
      (node: any) => node.getAttribute("data-pane") === paneID,
    ) as any;
  }

  it("aligns shortcuts and the composer at a 5px left gap after switching sidebar layouts", async function () {
    const details = await openChatPane();
    assertSidebarGaps(details);
    assertHeaderRows(details, "independent");
    Zotero.Prefs.set(layoutPref, "stacked", true);
    await until(
      () =>
        win.document.documentElement.getAttribute("data-llm-pane-view") ===
        "stacked",
      "Stacked layout applies",
    );
    await until(
      () =>
        ((
          details.querySelector(
            ".llm-dedicated-chat-pane #llm-mode-capsule",
          ) as HTMLElement | null
        )?.getBoundingClientRect().width ?? 0) > 0,
      "stacked chat header is laid out",
    );
    assertHeaderRows(details, "stacked");
    Zotero.Prefs.set(layoutPref, "independent", true);
    await openChatPane();
    assertSidebarGaps(details);
  });

  it("greys out the library rail with no selection and blocks activation", async function () {
    win.ZoteroPane.itemsView.selection.clearSelection();
    await until(
      () => Boolean(libraryIcon()?.hasAttribute("disabled")),
      "empty rail is disabled",
    );
    const icon = libraryIcon();
    assert.isAbove(
      icon.getBoundingClientRect().height,
      0,
      "disabled icon stays visible",
    );
    const nativeIcon = win.document.querySelector(
      '#zotero-view-item-sidenav [data-pane="info"]',
    );
    assert.equal(
      win.getComputedStyle(icon).opacity,
      win.getComputedStyle(nativeIcon).opacity,
      "disabled appearance matches native tabs",
    );
    icon.dispatchEvent(
      new win.MouseEvent("click", { bubbles: true, button: 0 }),
    );
    assert.notEqual(
      win.document.documentElement.getAttribute("data-llm-pane-view"),
      "chat",
    );
    await captureWindow(win, "empty-library-sidebar.png");
    await win.ZoteroPane.selectItem(fixtures[0].parentItemId);
    await until(
      () => !libraryIcon().hasAttribute("disabled"),
      "selection enables rail",
    );
  });

  for (const layout of ["independent", "stacked"] as const) {
    it(`drops multiple papers into a fresh sidebar Library chat in ${layout} layout`, async function () {
      Zotero.Prefs.set(layoutPref, layout, true);
      await until(
        () =>
          win.document.documentElement.getAttribute(
            "data-llm-sidebar-layout",
          ) === layout,
        "requested layout applies",
      );
      await win.ZoteroPane.selectItem(fixtures[0].parentItemId);
      await openChatPane();
      const details = win.document.getElementById("zotero-item-details");
      const section = details.querySelector(".llm-dedicated-chat-pane");
      const panel = () => section.querySelector("#llm-main");
      // Selecting an item and opening its native pane do not await the
      // extension's asynchronous conversation refresh. Capture the draft
      // only after this exact paper context is bound, not a previous panel.
      await until(
        () =>
          panel()?.dataset.conversationKind === "paper" &&
          panel()?.dataset.itemId === String(fixtures[0].parentItemId),
        "selected paper context settles before the draft snapshot",
      );
      const previousKey = panel().dataset.itemId;
      const input = panel().querySelector("#llm-input");
      input.value = "Preserve the previous draft";
      input.dispatchEvent(new win.Event("input", { bubbles: true }));
      await win.ZoteroPane.selectItems(fixtures.map((f) => f.parentItemId));
      await until(
        () => !libraryIcon().hasAttribute("disabled"),
        "multiple selection enables rail",
      );
      await openChatPane();
      const transfer = new win.DataTransfer();
      transfer.setData(
        "zotero/item",
        fixtures.map((f) => f.parentItemId).join(","),
      );
      // Cover both the body shown in the request and the existing composer target.
      const dropInput = panel().querySelector("#llm-input");
      if (dropInput.disabled) {
        assert.equal(
          win.getComputedStyle(dropInput).pointerEvents,
          "none",
          "disabled textarea lets native drops reach the composer surface",
        );
      }
      const inputRect = dropInput.getBoundingClientRect();
      const dropTarget =
        layout === "independent"
          ? section
          : win.document.elementFromPoint(
              inputRect.left + inputRect.width / 2,
              inputRect.top + inputRect.height / 2,
            );
      for (const type of ["dragenter", "dragover"]) {
        dropTarget.dispatchEvent(
          new win.DragEvent(type, {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
          }),
        );
      }
      assert.isOk(panel().querySelector(".llm-input-drop-active"));
      dropTarget.dispatchEvent(
        new win.DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        }),
      );
      await until(
        () =>
          panel().dataset.conversationKind === "global" &&
          panel().querySelectorAll("[data-paper-context-item-id]").length === 2,
        "drop prepares a library chat and renders both context chips",
      );
      // The header shows the moment the library chat lands, before any
      // history refresh: the mode control and the history bar never diverge.
      for (const selector of [
        ...(layout === "independent"
          ? [".llm-header-toggle-row", "#llm-library-chat-tab"]
          : ["#llm-mode-capsule", "#llm-mode-option-library"]),
        "#llm-history-bar",
        "#llm-history-new",
      ]) {
        const rect = panel().querySelector(selector).getBoundingClientRect();
        assert.isAbove(rect.height, 0, `${selector} is visible (${layout})`);
      }
      assert.isTrue(
        panel()
          .querySelector("#llm-library-chat-tab")
          .classList.contains("active"),
        "Library chat is the active tab",
      );
      assert.equal(
        panel()
          .querySelector("#llm-mode-option-library")
          .getAttribute("aria-pressed"),
        "true",
        "the chip shows Library chat",
      );
      assertHeaderRows(details, layout);
      await until(
        () => Boolean(panel().querySelector(".llm-standalone-start-page")),
        "the fresh Library chat shows the Library start page",
      );
      assert.isNull(
        panel().querySelector(".llm-start-page"),
        `no Paper chat start page in a Library chat (${layout})`,
      );
      const key = panel().dataset.itemId;
      assert.isNull(
        panel().querySelector(".llm-input-drop-active"),
        "drop feedback clears",
      );
      const persisted = await api.getWorkflowConversationPersistenceSnapshot(
        "upstream",
        Number(key),
      );
      assert.equal(
        persisted.catalogRows,
        1,
        "new chat has a native catalog row",
      );
      assert.equal(persisted.messageRows, 0, "drop does not send a question");
      assert.notEqual(key, previousKey, "drop creates its own conversation");
      assert.sameMembers(
        Array.from(
          panel().querySelectorAll("[data-paper-context-item-id]"),
        ).map((chip: any) => Number(chip.dataset.paperContextItemId)),
        fixtures.map((f) => f.pdfAttachmentId),
      );
      assert.equal(panel().querySelector("#llm-input").value, "");
      assert.isFalse(panel().querySelector("#llm-input").disabled);
      assert.strictEqual(
        win.document.activeElement,
        panel().querySelector("#llm-input"),
      );
      await captureWindow(win, `multi-paper-sidebar-${layout}.png`);
      win.ZoteroPane.itemsView.selection.clearSelection();
      await until(
        () => Boolean(libraryIcon()?.hasAttribute("disabled")),
        "clearing selection disables rail",
      );
      await win.ZoteroPane.selectItem(fixtures[1].parentItemId);
      await openChatPane();
      await until(
        () => panel().dataset.itemId === key,
        "prepared library chat survives selection changes",
      );
      assert.lengthOf(
        panel().querySelectorAll("[data-paper-context-item-id]"),
        2,
      );
      pickMode(panel(), "paper");
      await until(
        () => panel().dataset.conversationKind === "paper",
        "paper mode remains available",
      );
      await win.ZoteroPane.selectItem(fixtures[0].parentItemId);
      await until(
        () => panel().dataset.itemId === previousKey,
        `return to the original paper chat ${previousKey}; fixture=${fixtures[0].parentItemId}`,
      );
      assert.equal(
        panel().querySelector("#llm-input").value,
        "Preserve the previous draft",
      );
      Zotero.Prefs.set(layoutPref, "independent", true);
      await until(
        () =>
          win.document.documentElement.getAttribute(
            "data-llm-sidebar-layout",
          ) === "independent",
        "independent layout is restored",
      );
    });
  }

  it("toggles chat closed and open through its rail icon without losing the draft", async function () {
    const details = await openChatPane();
    const section = details.querySelector(".llm-dedicated-chat-pane");
    await until(() => {
      const current = section.querySelector("#llm-main");
      if (!current) return false;
      const state = api.inspectNativeDraftPersistence(
        current,
        Number(current.dataset.itemId),
        "",
      );
      return (
        Boolean(state.handlersInitialized) &&
        state.handlerKey === state.mountedKey &&
        state.ownership === "match"
      );
    }, "the mounted conversation owns input before entering a draft");
    const root = section.querySelector("#llm-main");
    const conversationKey = root.dataset.itemId;
    const input = section.querySelector("#llm-input") as HTMLTextAreaElement;
    const previousDraft = input.value;
    const draft = "Keep this draft when toggling the chat rail";
    input.value = draft;
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    const assertDraftStored = (stage: string) => {
      const state = api.inspectNativeDraftPersistence(
        section.querySelector("#llm-main"),
        Number(conversationKey),
        draft,
      );
      assert.isTrue(
        state.cacheMatchesExpected,
        `${stage}: addon-owned draft cache; ${JSON.stringify(state)}`,
      );
    };
    try {
      assertDraftStored("immediately after input");
      await clickPane("llm-context-panel");
      assert.isTrue(
        details.sidenav._collapsed,
        "clicking the active chat icon closes the native pane",
      );
      assert.equal(
        win.document.documentElement.getAttribute("data-llm-pane-view"),
        "details",
      );
      assert.strictEqual(section.querySelector("#llm-main"), root);
      assert.equal(input.value, draft, "closing retains the draft");
      assertDraftStored("after closing, before reopening");

      await clickPane("llm-context-panel");
      await until(
        () =>
          !details.sidenav._collapsed &&
          section.querySelector("#llm-main")?.getBoundingClientRect().height >
            0,
        "the next rail click reopens chat",
      );
      assert.equal(
        win.document.documentElement.getAttribute("data-llm-pane-view"),
        "chat",
      );
      assert.equal(
        section.querySelector("#llm-main").dataset.itemId,
        conversationKey,
        "reopening preserves the conversation",
      );
      assertDraftStored("after reopening");
      // Conversation identity is published before the asynchronous load restores
      // its composer. Check that completion, not only a visible empty shell.
      await until(
        () =>
          section.querySelector("#llm-main")?.dataset.itemId ===
            conversationKey &&
          section.querySelector("#llm-input")?.value === draft,
        "the reopened conversation restores its persisted draft",
      );
      assert.equal(
        section.querySelector("#llm-input").value,
        draft,
        "reopening preserves the draft",
      );
    } finally {
      const currentInput = section.querySelector("#llm-input");
      currentInput.value = previousDraft;
      currentInput.dispatchEvent(new win.Event("input", { bubbles: true }));
    }
  });

  it("uses the whole native pane and restores details through their icon", async function () {
    const details = await openChatPane();
    const section = details.querySelector(
      "item-pane-custom-section.llm-dedicated-chat-pane",
    );
    await until(
      () => Boolean(section.querySelector("#llm-main")),
      "chat rendered",
    );
    assert.equal(
      win.document.documentElement.getAttribute("data-llm-pane-view"),
      "chat",
    );
    const header = details.querySelector("item-pane-header");
    assert.equal(
      header.getBoundingClientRect().height,
      0,
      "item header is outside chat view",
    );
    for (const other of details.getPanes()) {
      if (other !== section)
        assert.equal(
          other.getBoundingClientRect().height,
          0,
          "other sections are outside chat view",
        );
    }
    const viewport = details
      .querySelector(".zotero-view-item")
      .getBoundingClientRect();
    const chat = section.getBoundingClientRect();
    assert.isAbove(chat.height, 200);
    assert.closeTo(chat.top, viewport.top, 2);
    assert.closeTo(
      chat.height,
      viewport.height,
      2,
      "chat occupies the pane height",
    );
    const input = section.querySelector("#llm-input") as HTMLTextAreaElement;
    assert.isOk(input);
    input.value = "Unsent draft remains in this conversation";
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    assert.isAtMost(
      input.getBoundingClientRect().bottom,
      viewport.bottom + 2,
      "composer stays in the pane",
    );
    const root = section.querySelector("#llm-main");
    const toolbar = section.querySelector(".llm-header-top");
    assertHeaderRows(details, "independent");
    const navRow = section.querySelector(".llm-header-nav-row");
    assert.closeTo(
      navRow.getBoundingClientRect().width,
      root.getBoundingClientRect().width,
      0.5,
      "the header divider spans the whole panel",
    );
    assert.isNull(
      section.querySelector("[data-chat-mode]"),
      "segmented toggle is removed",
    );
    assert.isNull(
      section.querySelector(".llm-docked-more"),
      "overflow toolbar is removed",
    );
    for (const id of [
      "llm-history-new",
      "llm-history-toggle",
      "llm-paper-chat-tab",
      "llm-library-chat-tab",
      "llm-popout",
      "llm-settings",
      "llm-export",
      "llm-clear",
    ]) {
      const action = toolbar.querySelector(`#${id}`);
      assert.isAbove(
        action.getBoundingClientRect().width,
        0,
        `${id} is visible in the classic toolbar`,
      );
    }
    // With no docked close button, the plugin's rail icon closes the chat.
    const icon: any = Array.from(
      details.sidenav.querySelectorAll("[data-pane]"),
    ).find(
      (node: any) => node.getAttribute("data-pane") === section.dataset.pane,
    );
    icon.dispatchEvent(
      new win.MouseEvent("click", { bubbles: true, detail: 1, button: 0 }),
    );
    await Zotero.Promise.delay(100);
    assert.isTrue(
      details.sidenav._collapsed,
      "the rail icon collapses the native sidebar",
    );
    icon.dispatchEvent(
      new win.MouseEvent("click", { bubbles: true, detail: 1, button: 0 }),
    );
    await Zotero.Promise.delay(300);
    assert.isFalse(
      details.sidenav._collapsed,
      "plugin icon reopens the sidebar",
    );
    assert.equal(
      section.querySelector("#llm-input").value,
      "Unsent draft remains in this conversation",
      "closing preserves the draft",
    );
    await clickPane("info");
    assert.equal(section.getBoundingClientRect().height, 0);
    assert.isAbove(header.getBoundingClientRect().height, 0);
    await clickPane("llm-context-panel");
    assert.strictEqual(
      section.querySelector("#llm-main"),
      root,
      "navigation preserves the mounted conversation",
    );
    assert.equal(
      (section.querySelector("#llm-input") as HTMLTextAreaElement).value,
      "Unsent draft remains in this conversation",
    );

    // Keep a native rendering artifact beside the disposable test database.
    const canvas = win.document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "canvas",
    );
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    canvas
      .getContext("2d")
      .drawWindow(
        win,
        viewport.left,
        viewport.top,
        canvas.width,
        canvas.height,
        "#ffffff",
      );
    const binary = win.atob(canvas.toDataURL("image/png").split(",")[1]);
    await (win.IOUtils as any).write(
      PathUtils.join(Zotero.DataDirectory.dir, "dedicated-chat-pane.png"),
      Uint8Array.from(binary, (char: any) => char.charCodeAt(0)),
    );
  });

  it("switches sidebar layout from Customization without replacing the chat", async function () {
    let preferences: any;
    const prefKey = "extensions.zotero.llmforzotero.sidebarLayout";
    const original = Zotero.Prefs.get(prefKey, true);
    const details = await openChatPane();
    const section = details.querySelector(".llm-dedicated-chat-pane");
    const root = section.querySelector("#llm-main");
    const input = section.querySelector("#llm-input");
    const previousDraft = input.value;
    // Type the draft the way a user does. The composer stores the draft on
    // every input event, and the panel reloads the stored draft whenever the
    // pointer enters it. Setting .value alone leaves the store holding the
    // previous test's draft, which then replaces this one as soon as the
    // cursor rests over the pane.
    input.value = "Keep this draft across layout changes";
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    const openPreferences = async () => {
      preferences = (Zotero.Utilities.Internal as any).openPreferences(
        "llmforzotero-preferences",
      );
      await until(
        () =>
          preferences.document.querySelector("#llmforzotero-sidebar-layout")
            ?.dataset.preferenceBound === "true",
        "sidebar layout setting exists",
      );
      preferences.document
        .querySelector('[data-pref-tab="customization"]')
        .click();
      return preferences.document.querySelector("#llmforzotero-sidebar-layout");
    };
    const choose = (select: any, value: string) => {
      select.value = value;
      const event = preferences.document.createEvent("Event");
      event.initEvent("change", true, false);
      select.dispatchEvent(event);
    };
    try {
      Zotero.Prefs.clear(prefKey, true);
      let select = await openPreferences();
      assert.equal(select.value, "stacked", "Stacked is the default");
      choose(select, "independent");
      await until(
        () =>
          win.document.documentElement.getAttribute("data-llm-pane-view") ===
          "chat",
        "explicit Independent choice applies",
      );
      assert.isAbove(
        select.getBoundingClientRect().height,
        0,
        "setting is in Customization",
      );
      await captureWindow(preferences, "sidebar-layout-customization.png");
      choose(select, "stacked");
      await until(
        () =>
          win.document.documentElement.getAttribute("data-llm-pane-view") ===
          "stacked",
        "stacked layout applies immediately",
      );
      assert.isAbove(
        details.querySelector("item-pane-header").getBoundingClientRect()
          .height,
        0,
        "native details return",
      );
      assertHeaderRows(details, "stacked");
      assert.isTrue(
        section.querySelector("collapsible-section").collapsible,
        "stacked section is collapsible",
      );
      assert.strictEqual(
        section.querySelector("#llm-main"),
        root,
        "layout switch preserves the mounted chat",
      );
      assert.equal(input.value, "Keep this draft across layout changes");
      preferences.close();
      await until(() => preferences.closed, "preferences close");
      await clickPane("llm-context-panel");
      assert.isAbove(
        section.getBoundingClientRect().height,
        100,
        "stacked chat is visible after clicking its rail icon",
      );
      await captureWindow(win, "stacked-sidebar.png");
      select = await openPreferences();
      assert.equal(select.value, "stacked", "layout choice is remembered");
      choose(select, "independent");
      await until(
        () =>
          win.document.documentElement.getAttribute("data-llm-pane-view") ===
          "chat",
        "independent layout returns",
      );
      assertHeaderRows(details, "independent");
      assert.equal(
        details.querySelector("item-pane-header").getBoundingClientRect()
          .height,
        0,
      );
      assert.strictEqual(section.querySelector("#llm-main"), root);
      assert.equal(input.value, "Keep this draft across layout changes");
    } finally {
      const currentInput = section.querySelector("#llm-input");
      if (currentInput) {
        currentInput.value = previousDraft;
        currentInput.dispatchEvent(new win.Event("input", { bubbles: true }));
      }
      preferences?.close();
      Zotero.Prefs.set(prefKey, original || "stacked", true);
    }
  });

  it("follows reader tabs and preserves an explicitly selected Library chat", async function () {
    for (const fixture of fixtures) {
      const reader = (await Zotero.Reader.open(
        fixture.pdfAttachmentId,
      )) as _ZoteroTypes.ReaderInstance;
      readers.push(reader);
      await reader._initPromise;
      await reader._waitForReader();
    }
    await openChatPane();
    assertHeaderRows(activeDetails(), "independent");
    const panel = () =>
      activeDetails().querySelector("#llm-main") as HTMLElement;
    await until(
      () =>
        panel()?.dataset.contextOwnerItemId ===
        String(fixtures[1].parentItemId),
      `paper B context follows its tab; selected=${win.Zotero_Tabs.selectedID}, roots=${JSON.stringify(Array.from(win.document.querySelectorAll("#llm-main")).map((node: any) => ({ ...node.dataset })))}`,
    );
    await until(() => {
      const current = panel();
      const chip = current?.querySelector(".llm-shortcuts > .llm-shortcut-btn");
      return (
        current?.dataset.contextOwnerItemId ===
          String(fixtures[1].parentItemId) &&
        Boolean(chip && chip.getBoundingClientRect().width > 0)
      );
    }, "paper B shortcuts finish rendering before measuring their alignment");
    assertSidebarGaps(activeDetails());
    win.Zotero_Tabs.select(readers[0].tabID);
    await until(
      () =>
        panel()?.dataset.contextOwnerItemId ===
        String(fixtures[0].parentItemId),
      "paper A context follows its tab",
    );
    assert.equal(
      win.document.documentElement.getAttribute("data-llm-pane-view"),
      "chat",
    );
    (panel().querySelector("#llm-library-chat-tab") as HTMLElement).click();
    await until(
      () => panel()?.dataset.conversationKind === "global",
      "Library chat is selected",
    );
    const conversation = panel().dataset.itemId;
    // The rail icon closes the open chat, and a second click reopens it.
    await clickPane("llm-context-panel");
    assert.isTrue(activeDetails().sidenav._collapsed, "rail icon closes chat");
    await clickPane("llm-context-panel");
    await until(
      () =>
        panel()?.dataset.conversationKind === "global" &&
        panel()?.dataset.itemId === conversation,
      "Library chat survives closing and reopening",
    );
    win.Zotero_Tabs.select(readers[1].tabID);
    await until(
      () =>
        panel()?.dataset.conversationKind === "global" &&
        panel()?.dataset.itemId === conversation,
      "Library chat stays locked across tabs",
    );
    (panel().querySelector("#llm-paper-chat-tab") as HTMLElement).click();
    await until(
      () =>
        panel()?.dataset.conversationKind === "paper" &&
        panel()?.dataset.contextOwnerItemId ===
          String(fixtures[1].parentItemId),
      "Paper chat resumes with the active paper",
    );
  });
  it("keeps stacked reader contexts and disables the empty library rail", async function () {
    const key = "extensions.zotero.llmforzotero.sidebarLayout";
    try {
      Zotero.Prefs.set(key, "stacked", true);
      await clickPane("llm-context-panel");
      const panel = () => activeDetails().querySelector("#llm-main");
      assert.equal(
        win.document.documentElement.getAttribute("data-llm-pane-view"),
        "stacked",
      );
      assert.isTrue(
        activeDetails().querySelector(
          ".llm-dedicated-chat-pane > collapsible-section",
        ).collapsible,
      );
      // Hover opens a two-row picker; clicking the current row no longer
      // toggles. Exercise that real state rather than assuming a closed chip.
      const modeChip = panel().querySelector("#llm-mode-capsule");
      modeChip.dispatchEvent(
        new win.PointerEvent("pointerenter", { pointerType: "mouse" }),
      );
      assert.equal(modeChip.dataset.expanded, "true", "hover opens modes");
      pickMode(panel(), "library");
      await until(
        () => panel().dataset.conversationKind === "global",
        "Library chat opens in stacked reader",
      );
      const conversation = panel().dataset.itemId;
      win.Zotero_Tabs.select(readers[0].tabID);
      await until(
        () => panel().dataset.itemId === conversation,
        "stacked reader tabs preserve Library lock",
      );
      await Zotero.Promise.delay(300);
      pickMode(panel(), "paper");
      await until(
        () =>
          panel().dataset.contextOwnerItemId ===
            String(fixtures[0].parentItemId) &&
          panel().dataset.conversationKind === "paper",
        "stacked Paper chat follows active reader",
      );
      win.Zotero_Tabs.select("zotero-pane");
      await win.ZoteroPane.selectItem(fixtures[0].parentItemId);
      win.ZoteroPane.itemsView.selection.clearSelection();
      await Zotero.Promise.delay(300);
      await until(
        () => Boolean(libraryIcon()?.hasAttribute("disabled")),
        "stacked empty rail is disabled",
      );
      assert.equal(
        win.document.documentElement.getAttribute("data-llm-pane-view"),
        "stacked",
      );
      await win.ZoteroPane.selectItem(fixtures[0].parentItemId);
      await until(
        () =>
          win.document.documentElement.getAttribute("data-llm-pane-view") ===
          "stacked",
        "selecting a paper restores the chosen stacked layout",
      );
    } finally {
      Zotero.Prefs.set(key, "independent", true);
    }
  });
});
