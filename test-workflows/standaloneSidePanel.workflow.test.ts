import { assert } from "chai";
import {
  getModelEntryById,
  setModelProviderGroups,
} from "../src/utils/modelProviders";
import type {
  WorkflowTestApi,
  WorkflowTestComposerMetrics,
  WorkflowTestFixture,
  WorkflowTestStandaloneSidePanelDiagnostics,
} from "../src/modules/contextPanel/workflowTestTypes";
import {
  installHeldChatProvider,
  type HeldChatProvider,
} from "./helpers/heldChatProvider";

/**
 * The standalone window's side panel: a third column opened from the tab
 * row's trailing toggle. It holds tabs: past chats opened read-only from the
 * new-tab page's Search history list, and temporary side chats on the main
 * chat's paper or library. Each paper and the library chat have their own.
 *
 * Everything runs in the real window; sends go through the side chat's own
 * composer and the real send flow, and only the network is scripted (a held
 * fake provider).
 */

declare const Zotero: any;

const PREF_PREFIX = "extensions.zotero.llmforzotero.";
const API_BASE = "https://workflow-standalone-side-panel.invalid/v1";
const GROUP_ID = "workflow-side-panel-group";
const ENTRY_ID = "workflow-side-panel-model";
const MODEL = "side-panel-model";

const SAVED_PREF_KEYS = [
  "modelProviderGroups",
  "modelProviderGroupsMigrationVersion",
  "lastUsedModelEntryId",
  "lastUsedRuntimeMode",
  "conversationSystem",
  "enableCodexAppServerMode",
  "enableClaudeCodeMode",
  "outputTokenAutoMigrationNoticePending",
];

function getWorkflowTestApi(): WorkflowTestApi {
  const api = (Zotero as any).LLMForZotero?.api?.workflowTest;
  assert.isOk(api, "workflow test API should be installed");
  return api as WorkflowTestApi;
}

describe("workflow: standalone side panel", function () {
  this.timeout(240_000);

  let api: WorkflowTestApi;
  let provider: HeldChatProvider;
  const previousPrefs = new Map<string, unknown>();
  const fixtures: WorkflowTestFixture[] = [];

  async function until(
    check: () => boolean | Promise<boolean>,
    describe: () => string,
    timeoutMs = 10_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await Zotero.Promise.delay(50);
    }
    if (await check()) return;
    assert.fail(describe());
  }

  async function waitForSide(
    check: (state: WorkflowTestStandaloneSidePanelDiagnostics) => boolean,
    label: string,
    timeoutMs = 10_000,
  ): Promise<WorkflowTestStandaloneSidePanelDiagnostics> {
    let state = await api.getStandaloneSidePanelDiagnostics();
    await until(
      async () => {
        state = await api.getStandaloneSidePanelDiagnostics();
        return check(state);
      },
      () => `${label}: ${JSON.stringify(state)}`,
      timeoutMs,
    );
    return state;
  }

  /**
   * The panel state once no inactive tab still fades out of its fill. Tab
   * backgrounds have a 0.15s transition, so a tab read just after it stops
   * being active shows a colour part-way to transparent.
   */
  function waitForSettledTabs(
    label: string,
  ): Promise<WorkflowTestStandaloneSidePanelDiagnostics> {
    return waitForSide(
      (state) =>
        (state.design.browserTabs?.tabs || []).every(
          (tab) => tab.active || tab.background === "rgba(0, 0, 0, 0)",
        ),
      `${label}: inactive tabs settle to no fill`,
    );
  }

  const standaloneWin = (): Window | null => {
    const win = (Zotero as any).LLMForZotero?.data?.standaloneWindow as
      | Window
      | undefined;
    return win && !win.closed ? win : null;
  };

  function luminance(color: string): number {
    const parts = color.match(/[\d.]+/g)?.map(Number) || [];
    // rgb(r, g, b) is 0-255; color(srgb r g b) is 0-1.
    const scale = color.startsWith("color(") ? 255 : 1;
    const [r = 0, g = 0, b = 0] = parts.slice(0, 3).map((v) => v * scale);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function assertOnMainTitleLine(
    page: WorkflowTestStandaloneSidePanelDiagnostics["design"]["newTabPage"],
    label: string,
  ) {
    assert.isOk(page, `${label}: the New tab page shows`);
    assert.isNotNull(page!.mainTitleTopPx, `${label}: main start page shows`);
    assert.closeTo(
      page!.titleTopPx,
      page!.mainTitleTopPx!,
      0.5,
      `${label}: the titles share a line`,
    );
    assert.closeTo(
      page!.subtitleTopPx!,
      page!.mainSubtitleTopPx!,
      0.5,
      `${label}: the taglines share a line`,
    );
  }

  /** The panel's bar and rows use the window's own metrics. */
  function assertSameDesign(state: WorkflowTestStandaloneSidePanelDiagnostics) {
    const { design } = state;
    // The strip starts at the main tab row's top and ends where the row's
    // 32px buttons end, halfway between the row's height and theirs.
    assert.closeTo(
      design.barHeightPx,
      (design.tabRowHeightPx + 32) / 2,
      0.5,
      "bar height",
    );
    if (design.sideTitle) {
      assert.isOk(design.mainTitle, JSON.stringify(design));
      assert.equal(design.sideTitle.fontSize, design.mainTitle!.fontSize);
      assert.equal(design.sideTitle.fontWeight, design.mainTitle!.fontWeight);
      assert.closeTo(
        design.sideTitle.topPx,
        design.mainTitle!.topPx,
        0.5,
        "the title lines are y-aligned across the divider",
      );
    }
    if (design.launchRow && design.navRow) {
      assert.equal(design.launchRow.fontSize, design.navRow.fontSize);
      assert.equal(design.launchRow.fontWeight, design.navRow.fontWeight);
      assert.closeTo(design.launchRow.heightPx, design.navRow.heightPx, 0.5);
    }
  }

  /**
   * Browser-style tabs on a darker strip: the strip starts at the main tab
   * row's top and ends with the 32px ⇤ toggle, every part of the strip is
   * centred in the band the tabs fill, the first tab sits 8px in, the
   * active one is the panel surface with matching flares on both sides and
   * runs straight into the content, and inactive ones have no fill.
   */
  function assertBrowserTabs(
    state: WorkflowTestStandaloneSidePanelDiagnostics,
  ) {
    const strip = state.design.browserTabs;
    assert.isOk(strip, JSON.stringify(state.design));
    assert.isNotEmpty(strip!.tabs);
    assert.isBelow(
      luminance(strip!.stripBackground),
      luminance(state.panelBackground),
      "the strip is a step darker than the panel",
    );
    assert.closeTo(
      strip!.tabs[0].leftPx - strip!.panelLeftPx,
      8,
      0.5,
      "the first tab sits 8px in",
    );
    assert.closeTo(strip!.stripBottomPx, strip!.contentTopPx, 0.5);
    assert.closeTo(
      strip!.stripTopPx,
      strip!.tabRowTopPx,
      0.5,
      "the strip's top is the main tab row's",
    );
    assert.isNotNull(strip!.navToggleBottomPx, "the ⇤ toggle is shown");
    assert.closeTo(
      strip!.stripBottomPx,
      strip!.navToggleBottomPx!,
      0.5,
      "the strip's bottom is the 32px ⇤ toggle's",
    );
    const centres = strip!.centres;
    assert.closeTo(
      centres.toggle,
      centres.tabRow,
      0.5,
      "the →| toggle on the main tab row's middle line",
    );
    assert.closeTo(
      centres.mainSwitch,
      centres.tabRow,
      0.5,
      "Paper chat | Library chat on the main tab row's middle line",
    );
    // The band the tabs fill: from where they start to the strip's bottom.
    const line = (strip!.mainSwitchTopPx + strip!.stripBottomPx) / 2;
    const onLine = (value: number | null, label: string) => {
      assert.isNotNull(value, label);
      assert.closeTo(value!, line, 0.5, `${label} centred in the tab band`);
    };
    onLine(centres.newTabButton, "the + button");
    onLine(centres.closeButton, "the panel's ×");
    assert.lengthOf(centres.tabs, strip!.tabs.length);
    for (const [index, tab] of centres.tabs.entries()) {
      onLine(tab.icon, `tab ${index} icon`);
      onLine(tab.title, `tab ${index} title`);
      if (strip!.tabs[index].active) onLine(tab.close, `tab ${index} ×`);
    }
    for (const tab of strip!.tabs) {
      assert.closeTo(
        tab.bottomPx,
        strip!.stripBottomPx,
        0.5,
        "every tab runs to the strip's bottom",
      );
      assert.closeTo(
        tab.topPx,
        strip!.mainSwitchTopPx,
        0.5,
        "each tab starts where Paper chat | Library chat starts",
      );
      if (tab.active) {
        assert.equal(tab.background, state.panelBackground, "raised tab");
        assert.closeTo(
          tab.bottomPx,
          strip!.stripBottomPx,
          0.5,
          "the active tab meets the content",
        );
        assert.match(tab.radius, /^8px 8px 0px 0px$/);
        assert.equal(tab.flareBefore.widthPx, 8);
        assert.equal(tab.flareAfter.widthPx, 8);
        assert.include(tab.flareBefore.image, "radial-gradient");
        assert.include(tab.flareAfter.image, "radial-gradient");
      } else {
        assert.equal(tab.background, "rgba(0, 0, 0, 0)", "no fill");
      }
    }
  }

  /** A panel composer has the main composer's box and rows. */
  function assertSameComposer(
    state: WorkflowTestStandaloneSidePanelDiagnostics,
    composer: WorkflowTestComposerMetrics | null | undefined,
    label: string,
  ) {
    const main = state.main.composer;
    assert.isOk(main && composer, `${label}: ${JSON.stringify(state)}`);
    for (const key of [
      "boxHeightPx",
      "contextRowHeightPx",
      "inputHeightPx",
      "toolRowHeightPx",
    ] as const) {
      assert.closeTo(composer![key], main![key], 1, `${label} ${key}`);
    }
    assert.equal(composer!.placeholderFontStyle, main!.placeholderFontStyle);
    const toolHeight = Math.max(...main!.toolButtonHeightsPx);
    for (const height of composer!.toolButtonHeightsPx) {
      assert.isAtMost(height, toolHeight + 1, `${label}: one-line buttons`);
    }
  }

  function pressFontScaleShortcut(key: "=" | "0") {
    const win = standaloneWin() as any;
    assert.isOk(win, "the standalone window is open");
    win.document.dispatchEvent(
      new win.KeyboardEvent("keydown", {
        key,
        code: key === "=" ? "Equal" : "Digit0",
        metaKey: true,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  }

  /**
   * An open or close slide: 280 ms of eased frames in which the window's
   * left and top edges stay, its width moves one way, the main chat keeps
   * its width, and (closing) the panel keeps its tabs until the end.
   */
  function assertSlide(
    frames: Awaited<
      ReturnType<WorkflowTestApi["recordStandaloneSidePanelSlide"]>
    >,
    direction: "open" | "close",
  ) {
    const first = frames[0];
    const last = frames[frames.length - 1];
    const widths = frames.map((frame) => frame.outerWidth);
    const label = (text: string) =>
      `${direction}: ${text} ${JSON.stringify(
        frames.map((frame) => [
          Math.round(frame.timeMs),
          frame.outerWidth,
          Math.round(frame.mainWidthPx),
          frame.panelTabCount,
        ]),
      )}`;
    for (const frame of frames) {
      assert.closeTo(frame.screenX, first.screenX, 1, label("x stays"));
      assert.closeTo(frame.screenY, first.screenY, 1, label("y stays"));
      assert.closeTo(
        frame.mainWidthPx,
        first.mainWidthPx,
        2,
        label("the main chat keeps its width every frame"),
      );
      assert.closeTo(
        frame.mainLeftPx,
        first.mainLeftPx,
        1,
        label("the main chat keeps its place every frame"),
      );
      assert.equal(
        frame.columnsScrollLeft,
        0,
        label("the columns never scroll"),
      );
    }
    for (let index = 1; index < widths.length; index++) {
      if (direction === "open") {
        assert.isAtLeast(widths[index], widths[index - 1], label("grows"));
      } else {
        assert.isAtMost(widths[index], widths[index - 1], label("shrinks"));
      }
    }
    if (direction === "close") {
      for (const frame of frames) {
        if (frame.outerWidth === last.outerWidth) break;
        assert.isTrue(frame.panelShown, label("the panel shows to the end"));
        assert.isAbove(frame.panelTabCount, 0, label("its tabs stay"));
      }
      assert.isFalse(last.panelShown, label("then it is gone"));
    } else {
      assert.isTrue(last.panelShown);
    }
  }

  /** New tab, then History, then a past chat (opens its read-only tab). */
  async function pickPastChat(conversationKey: number) {
    let state = await api.getStandaloneSidePanelDiagnostics();
    if (state.view !== "newtab") {
      state = await api.clickStandaloneSidePanelControl("new-tab");
    }
    state = await api.clickStandaloneSidePanelControl("new-history");
    assert.equal(state.view, "history", JSON.stringify(state.tabs));
    return api.clickStandaloneSidePanelHistoryRow(conversationKey);
  }

  /** Sends in the shown side chat and streams the answer. */
  async function askSideChat(question: string, answer: string) {
    await api.sendStandaloneSideChat(question);
    const stream = await provider.waitForStream(question);
    stream.push(answer);
    stream.finish();
    return waitForSide(
      (state) =>
        Boolean(
          state.sideChat?.messageTexts.some((text) => text.includes(answer)) &&
          state.sideChat.sendMainButtons > 0,
        ),
      `the side chat shows ${answer}`,
      30_000,
    );
  }

  before(async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    api = getWorkflowTestApi();
    for (const key of SAVED_PREF_KEYS) {
      previousPrefs.set(key, Zotero.Prefs.get(PREF_PREFIX + key, true));
    }
    provider = installHeldChatProvider(API_BASE);
    Zotero.Prefs.set(PREF_PREFIX + "conversationSystem", "upstream", true);
    Zotero.Prefs.set(PREF_PREFIX + "enableCodexAppServerMode", false, true);
    Zotero.Prefs.set(PREF_PREFIX + "enableClaudeCodeMode", false, true);
    Zotero.Prefs.set(PREF_PREFIX + "lastUsedRuntimeMode", "chat", true);
    setModelProviderGroups([
      {
        id: GROUP_ID,
        authMode: "api_key",
        apiBase: API_BASE,
        apiKey: "workflow-dummy-key",
        providerProtocol: "openai_chat_compat",
        models: [
          {
            id: ENTRY_ID,
            model: MODEL,
            temperature: 0.3,
            outputTokenLimit: { mode: "auto" },
          },
        ],
      },
    ] as any);
    Zotero.Prefs.set(PREF_PREFIX + "lastUsedModelEntryId", ENTRY_ID, true);
    assert.isOk(getModelEntryById(ENTRY_ID), "the fake model is configured");
  });

  after(async function () {
    provider?.restore();
    await api.closeStandalone();
    await api.reset();
    for (const [key, value] of previousPrefs) {
      if (value === undefined) Zotero.Prefs.clear(PREF_PREFIX + key, true);
      else Zotero.Prefs.set(PREF_PREFIX + key, value, true);
    }
  });

  beforeEach(async function () {
    await api.reset();
    api.enableLiveAgentSending();
  });

  afterEach(async function () {
    provider.failOpenStreams("workflow case ended");
    await Zotero.Promise.delay(300);
    await api.closeStandalone();
    for (const fixture of fixtures.splice(0)) {
      await api.cleanupFixture(fixture);
    }
    await api.reset();
  });

  it("holds past chats and side chats in tabs, opened from the new-tab page", async function () {
    const fixture = await api.createPaperWithPdfFixture({
      title: "Side panel workflow paper",
      pdfTitle: "Side panel workflow paper PDF",
      pages: ["Side panel workflow paper: one short page of text."],
    });
    fixtures.push(fixture);

    // Two past chats (saved) and a fresh main chat on the same paper.
    await api.openStandaloneForItem(fixture.parentItemId);
    // The paper's first chat sits on its legacy default key, which History
    // does not list; the past chats are the next ones, on catalog keys.
    await api.seedStandaloneConversation([
      { role: "user", text: "side-panel-first-question" },
      { role: "assistant", text: "side-panel-first-answer" },
    ]);
    const markListed = (key: number, title: string) =>
      // History lists chats with a user turn; a real send counts it, the
      // seed does not, so count it here (and give the chat its title).
      Zotero.DB.queryAsync(
        `UPDATE llm_for_zotero_paper_conversations
            SET user_turn_count = 1, title = ?, last_activity_at = ?
          WHERE conversation_key = ?`,
        [title, Date.now(), key],
      );
    await api.startNewStandaloneConversation();
    const PAST_QUESTION = "side-panel-past-question-marker";
    const PAST_ANSWER = "side-panel-past-answer-marker";
    const PAST_TITLE = "Side panel past chat";
    const past = await api.seedStandaloneConversation([
      { role: "user", text: PAST_QUESTION },
      { role: "assistant", text: PAST_ANSWER },
    ]);
    const pastKey = Number(past.conversationKey);
    assert.isAbove(pastKey, 0);
    await markListed(pastKey, PAST_TITLE);
    await api.startNewStandaloneConversation();
    const SECOND_TITLE = "Side panel second past chat";
    const second = await api.seedStandaloneConversation([
      { role: "user", text: "side-panel-second-question" },
      { role: "assistant", text: "side-panel-second-answer" },
    ]);
    const secondKey = Number(second.conversationKey);
    await markListed(secondKey, SECOND_TITLE);
    const fresh = await api.startNewStandaloneConversation();
    const mainKey = Number(fresh.conversationKey);
    assert.notEqual(mainKey, pastKey);

    // Closed: the toggle names what it opens.
    let side = await api.getStandaloneSidePanelDiagnostics();
    assert.isFalse(side.open);
    assert.equal(side.toggleExpanded, "false");
    assert.equal(side.toggleControls, "llm-standalone-side-panel");
    assert.equal(side.toggleLabel, "Open side panel");

    // Leave the screen room for the panel, so the window can grow in full.
    {
      const win = standaloneWin()!;
      const room = side.window.availWidth - 480;
      if (side.window.availWidth && win.outerWidth > room) {
        await api.resizeStandaloneWindow(
          Math.max(900, room - (win.outerWidth - win.innerWidth)),
          win.innerHeight,
        );
      }
      // Off the screen's left edge, so a move to x = 0 shows.
      win.moveTo(
        side.window.availLeft + 120,
        Math.max(win.screenY, (win.screen as any).availTop || 0),
      );
      await Zotero.Promise.delay(300);
    }
    const beforeOpen = await api.getStandaloneSidePanelDiagnostics();
    const assertWindowStays = (
      state: WorkflowTestStandaloneSidePanelDiagnostics,
      label: string,
    ) => {
      assert.closeTo(
        state.window.screenX,
        beforeOpen.window.screenX,
        1,
        `${label}: the window's left edge stays`,
      );
      assert.closeTo(
        state.window.screenY,
        beforeOpen.window.screenY,
        1,
        `${label}: the window's top edge stays`,
      );
    };

    // The panel opens on the new-tab page: no tabs yet and only two rows,
    // Side chat then History; no search field or list. It slides open like
    // the History pane: the window's right edge moves over 280 ms while the
    // main chat keeps its width.
    const openFrames = await api.recordStandaloneSidePanelSlide("toggle");
    assertSlide(openFrames, "open");
    side = await api.getStandaloneSidePanelDiagnostics();
    assert.isTrue(side.open);
    assert.equal(side.toggleExpanded, "true");
    assert.equal(side.toggleLabel, "Close side panel");
    assert.equal(side.view, "newtab");
    assert.deepEqual(side.tabs, []);
    assert.isTrue(side.newTabButton.visible, "+ always shows");
    // The New tab tab marks the page; "+" never keeps a box at rest.
    assert.isTrue(side.newTabTab.active);
    assert.isFalse(side.newTabButton.pressed);
    assert.deepInclude(
      side.newTabTab,
      { present: true, active: true, title: "New tab", closeVisible: true },
      "the new-tab page is itself the active tab",
    );
    assert.deepEqual(side.launchRows, [
      "sidechat",
      "history",
      "misc",
      "progress",
    ]);
    // The New tab page is the chat start page: its title and tagline, and
    // the four rows (left-aligned together), centred in the panel.
    const newTabStart = side.design.newTabPage;
    assert.isOk(newTabStart, JSON.stringify(side.design));
    assert.equal(newTabStart!.title, "LLM-for-Zotero");
    assert.equal(newTabStart!.subtitle, "Ask on the side, or read a past chat");
    assert.equal(newTabStart!.subtitleFontStyle, "italic");
    assert.closeTo(newTabStart!.centreDxPx, 0, 1, "centred across");
    // The main chat shows its start page, so the title and tagline sit on
    // the main title's and tagline's lines.
    assertOnMainTitleLine(newTabStart, "fresh main chat");
    assert.lengthOf(newTabStart!.rowLefts, 4);
    assert.closeTo(newTabStart!.rowLefts[0], newTabStart!.rowLefts[1], 0.5);
    assert.closeTo(newTabStart!.rowLefts[0], newTabStart!.rowLefts[2], 0.5);
    assert.closeTo(newTabStart!.rowLefts[0], newTabStart!.rowLefts[3], 0.5);
    const newTabTitle = side.design.startTitle!;
    assert.isNull(side.design.searchField, "no search field on New tab");
    assert.deepEqual(side.historyKeys, [], "no history list on New tab");
    assertSameDesign(side);
    // Opening the panel widens the window by the panel and its divider; the
    // main chat keeps its width and the History pane its state.
    side = await waitForSide(
      (state) =>
        state.window.outerWidth >=
        beforeOpen.window.outerWidth + state.panelWidthPx + 5 - 2,
      "the window widens for the panel",
    );
    assert.closeTo(
      side.window.outerWidth,
      beforeOpen.window.outerWidth + side.panelWidthPx + 5,
      2,
      "the window grows by the panel and its divider",
    );
    assertWindowStays(side, "open");
    assert.closeTo(
      side.mainContentWidthPx,
      beforeOpen.mainContentWidthPx,
      2,
      "the main chat keeps its width",
    );
    assert.equal(
      side.sidebarState,
      beforeOpen.sidebarState,
      "the History pane keeps its state",
    );
    // The Side chat row's icon is the dashed speech bubble, not the History
    // pane's "New chat" plus.
    const iconMask = (selector: string) => {
      const win = standaloneWin() as any;
      const element = win.document.querySelector(selector);
      return element
        ? String(win.getComputedStyle(element, "::before").maskImage)
        : "";
    };
    {
      const sideChatIcon = iconMask(
        "[data-side-launch='sidechat'] .llm-standalone-nav-icon",
      );
      assert.include(sideChatIcon, "stroke-dasharray");
      assert.notEqual(
        sideChatIcon,
        iconMask(".llm-standalone-sidebar .llm-standalone-nav-icon-new-chat"),
      );
      // The New tab tab shows a house; the strip's "+" button keeps the plus.
      const homeIcon = iconMask(
        ".llm-standalone-side-panel-tab[data-side-tab-kind='newtab'] .llm-standalone-side-panel-tab-icon",
      );
      assert.include(homeIcon, "M3 10a2 2", "the New tab tab is a house");
      assert.notInclude(homeIcon, "M15 21v-8", "an outline with no door");
      assert.include(
        iconMask(
          ".llm-standalone-side-panel-bar > .llm-standalone-side-panel-icon-new-tab",
        ),
        "action-history-new.svg",
        "the + button keeps the plus",
      );
    }
    assert.isAtLeast(side.panelWidthPx, 300);
    // A draggable divider like the History pane's (no drawn line), and its own surface.
    assert.isTrue(side.splitter.visible, "the divider shows while open");
    assert.closeTo(side.splitter.widthPx, 5, 0.5);
    assert.equal(side.splitter.cursor, "col-resize");
    assert.notEqual(
      side.panelBackground,
      side.mainBackground,
      "the side panel reads apart from the main chat",
    );
    const theme = standaloneWin()?.document.getElementById(
      "llmforzotero-standalone-chat-root",
    )?.dataset.standaloneTheme;
    if (theme === "dark") {
      assert.isAbove(
        luminance(side.panelBackground),
        luminance(side.mainBackground),
        "in the dark theme the side panel is a step lighter than the main chat",
      );
    } else if (theme === "light") {
      assert.isBelow(
        luminance(side.panelBackground),
        luminance(side.mainBackground),
        "in the light theme the side panel is a step darker than the main chat",
      );
    }
    // The divider works like the History pane's: it follows the pointer
    // and moves width between the main chat and the panel; the window keeps
    // its width.
    const pressSplitterKey = (key: "ArrowLeft" | "ArrowRight") => {
      const win = standaloneWin() as any;
      win.document
        .querySelector(".llm-standalone-side-panel-resizer")
        .dispatchEvent(
          new win.KeyboardEvent("keydown", {
            key,
            bubbles: true,
            cancelable: true,
          }),
        );
    };
    const beforeDrag = side;
    side = await api.dragStandaloneSidePanelSplitter(-40);
    assert.closeTo(
      side.panelWidthPx,
      beforeDrag.panelWidthPx + 40,
      2,
      "drag left: the panel grows",
    );
    assert.closeTo(
      side.mainContentWidthPx,
      beforeDrag.mainContentWidthPx - 40,
      2,
      "drag left: the main chat shrinks",
    );
    const afterLeftDrag = side;
    side = await api.dragStandaloneSidePanelSplitter(40);
    assert.closeTo(
      side.mainContentWidthPx,
      afterLeftDrag.mainContentWidthPx + 40,
      2,
      "drag right: the main chat grows",
    );
    assert.closeTo(
      side.panelWidthPx,
      afterLeftDrag.panelWidthPx - 40,
      2,
      "drag right: the panel shrinks",
    );
    pressSplitterKey("ArrowLeft");
    await Zotero.Promise.delay(100);
    const afterKey = await api.getStandaloneSidePanelDiagnostics();
    assert.isAbove(
      afterKey.panelWidthPx,
      side.panelWidthPx,
      "ArrowLeft grows the panel",
    );
    pressSplitterKey("ArrowRight");
    await Zotero.Promise.delay(600);
    side = await api.getStandaloneSidePanelDiagnostics();
    assert.closeTo(side.panelWidthPx, beforeDrag.panelWidthPx, 1);
    assert.equal(
      side.window.outerWidth,
      beforeDrag.window.outerWidth,
      "dragging never resizes the window",
    );
    assertWindowStays(side, "drag");

    // History turns the New tab tab into the History tab: the Search history
    // field and list, without the main chat.
    side = await api.clickStandaloneSidePanelControl("new-history");
    assert.equal(side.view, "history");
    assert.isFalse(side.newTabTab.present, "the New tab tab became History");
    assert.lengthOf(side.tabs, 1);
    assert.deepInclude(side.tabs[0], {
      kind: "history",
      title: "History",
      active: true,
    });
    assert.include(
      iconMask(
        ".llm-standalone-side-panel-tab[data-side-tab-kind='history'] .llm-standalone-side-panel-tab-icon",
      ),
      "M12 7v5l3 2",
      "the History tab has the clock icon",
    );
    side = await waitForSide(
      (state) =>
        state.historyKeys.includes(pastKey) &&
        state.historyKeys.includes(secondKey),
      "the History tab lists the past chats",
    );
    assert.notInclude(side.historyKeys, mainKey);
    const field = side.design.searchField;
    assert.isOk(field, "the History tab shows the search field");
    assert.isTrue(field!.hasLens, "the field has the lens icon");
    {
      const title = side.design.mainTitle!;
      assert.closeTo(
        field!.topPx + field!.heightPx / 2,
        title.topPx + title.heightPx / 2,
        1,
        "the search field sits on the main title's line",
      );
    }
    assert.equal(field!.placeholder, "Search history");
    // The embedded chips are the Search history popup's chips.
    const popupChips = await api.readStandaloneSearchPopupChipColors();
    assert.isNotEmpty(popupChips, "the popup lists chats");
    side = await api.getStandaloneSidePanelDiagnostics();
    assert.isNotEmpty(side.design.sideChips, "the list has chips");
    for (const chip of side.design.sideChips) {
      const popupChip = popupChips.find((entry) => entry.type === chip.type);
      if (!popupChip) continue;
      assert.deepEqual(chip, popupChip, `the ${chip.type} chip colours`);
    }

    // Forget the past chat's in-memory history so the tab loads (borrows) it.
    await api.evictStandaloneConversationFromMemory(pastKey);
    // A past chat opens in a read-only tab with the main chat's renderer.
    side = await api.clickStandaloneSidePanelHistoryRow(pastKey);
    assert.equal(side.view, "readonly");
    assert.lengthOf(side.tabs, 1);
    assert.deepInclude(side.tabs[0], {
      kind: "readonly",
      title: PAST_TITLE,
      active: true,
      closeVisible: true,
    });
    assert.isTrue(side.newTabButton.visible, "+ follows the last tab");
    assert.isFalse(side.newTabButton.pressed);
    assert.isFalse(
      side.newTabTab.present,
      "the opened tab replaced the History tab",
    );
    side = await waitForSide(
      (state) =>
        Boolean(
          state.readOnly?.messageTexts.some((text) =>
            text.includes(PAST_ANSWER),
          ),
        ),
      "the read-only tab renders the past answer",
    );
    assertSameDesign(side);
    assertBrowserTabs(await waitForSettledTabs("browser tabs"));
    const readOnly = side.readOnly!;
    assert.equal(readOnly.conversationKey, pastKey);
    assert.equal(readOnly.title, PAST_TITLE);
    assert.equal(readOnly.pill, "Read-only");
    assert.isTrue(readOnly.inputDisabled, "the composer is disabled");
    assert.equal(
      readOnly.placeholder,
      "This chat is read-only. Open it as your main chat to keep going.",
    );
    assert.deepEqual(readOnly.actionButtons, ["add-paper", "open-main"]);
    assert.equal(readOnly.statusText, "Read-only");
    assert.equal(readOnly.editableBubbles, 0, "no inline edit");
    assert.equal(readOnly.retryButtons, 0, "no retry");
    assert.equal(readOnly.deleteButtons, 0, "no delete");
    assert.equal(readOnly.forkButtons, 0, "no fork");
    assert.isAtLeast(readOnly.copyButtons, 1, "copy stays");
    assert.isAtLeast(readOnly.quoteButtons, 1);
    // The composer is the main one: the paper chip in the context row, the
    // same input and tool row, the two buttons in the tools' place, and the
    // footer's neutral style.
    assertSameComposer(side, readOnly.composer, "read-only");
    assert.lengthOf(readOnly.composer!.contextChips, 1, "the paper chip");
    assert.deepEqual(readOnly.composer!.toolButtons, [
      "Add this paper to main chat",
      "Open as main chat",
    ]);
    assert.equal(readOnly.composer!.statusClass, "llm-status");

    // Quote in main chat adds the answer as a chip to the main chat.
    side = await api.clickStandaloneChatMessageAction(
      "readonly",
      "llm-message-action-quote-main",
    );
    assert.equal(side.main.conversationKey, mainKey);
    assert.isTrue(
      side.main.selectedContextTexts.some((text) => text.includes(PAST_ANSWER)),
      `the main chat holds the quoted answer: ${JSON.stringify(side.main)}`,
    );

    // The read-only copy is display-only: a real load of the same key must
    // replace it and clear the borrowed mark, not trust it as loaded.
    const probe = await api.probeStandaloneReadOnlyBorrowedLoad(
      fixture.parentItemId,
    );
    assert.equal(probe.conversationKey, pastKey);
    assert.isTrue(probe.borrowedBefore, "the tab borrowed the history");
    assert.isFalse(probe.loadedBefore, "the borrow is not a real load");
    assert.isTrue(probe.loadedAfter, "the real load ran");
    assert.isFalse(probe.borrowedAfter, "the borrowed mark is cleared");

    // "+" shows the new-tab page; the same chat again focuses its tab, a
    // second chat opens a second tab.
    side = await api.clickStandaloneSidePanelControl("new-tab");
    assert.equal(side.view, "newtab");
    assert.isTrue(side.newTabTab.active);
    assert.isFalse(side.newTabButton.pressed);
    assert.isNull(side.activeTab);
    assert.deepInclude(side.newTabTab, { present: true, active: true });
    assert.equal(side.newTabTab.index, 1, "New tab is the last tab");
    // "+" again focuses the existing New tab; its × shows the tab before it.
    side = await api.clickStandaloneSidePanelControl("new-tab");
    assert.lengthOf(side.tabs, 1);
    assert.equal(side.stripTabCount, 2, "one New tab, not two");
    side = await api.clickStandaloneSidePanelControl("newtab-tab-close");
    assert.isFalse(side.newTabTab.present);
    assert.equal(side.view, "readonly");
    assert.equal(side.tabs[0].active, true);
    await api.clickStandaloneSidePanelControl("new-tab");
    side = await api.clickStandaloneSidePanelControl("new-history");
    assert.equal(side.view, "history");
    // "+" from the History tab opens a New tab; History again focuses the
    // open History tab instead of adding a second one.
    side = await api.clickStandaloneSidePanelControl("new-tab");
    assert.equal(side.view, "newtab");
    assert.lengthOf(side.tabs, 2);
    side = await api.clickStandaloneSidePanelControl("new-history");
    assert.equal(side.view, "history");
    assert.lengthOf(side.tabs, 2, "one History tab");
    assert.isFalse(side.newTabTab.present);
    side = await api.clickStandaloneSidePanelHistoryRow(pastKey);
    assert.lengthOf(side.tabs, 1, "the open tab is focused, not doubled");
    assert.equal(side.view, "readonly");
    await pickPastChat(secondKey);
    side = await waitForSettledTabs("second past chat");
    assert.deepEqual(
      side.tabs.map((tab) => [tab.title, tab.active]),
      [
        [PAST_TITLE, false],
        [SECOND_TITLE, true],
      ],
    );
    assert.isFalse(side.tabs[0].closeVisible, "× only on the active tab");
    assertBrowserTabs(side);

    // A side chat tab: the main chat's composer and footer, a Temporary pill.
    await api.clickStandaloneSidePanelControl("new-tab");
    side = await api.clickStandaloneSidePanelControl("new-sidechat");
    assert.equal(side.view, "sidechat");
    assert.lengthOf(side.tabs, 3);
    assert.deepInclude(side.tabs[2], {
      kind: "sidechat",
      title: "Side chat",
      active: true,
    });
    assert.equal(
      iconMask(
        ".llm-standalone-side-panel-tab[data-side-tab-kind='sidechat'] .llm-standalone-side-panel-tab-icon",
      ),
      iconMask("[data-side-launch='sidechat'] .llm-standalone-nav-icon"),
      "the side chat tab has the side chat icon",
    );
    side = await waitForSide(
      (state) => Boolean(state.sideChat?.conversationKey),
      "the side chat mounts",
    );
    const sideChat = side.sideChat!;
    {
      const emptyTitle = side.design.startTitle;
      assert.isOk(emptyTitle, "the empty side chat shows its start page");
      assert.equal(newTabTitle.fontSize, emptyTitle!.fontSize, "same title");
      assert.equal(newTabTitle.fontWeight, emptyTitle!.fontWeight);
    }
    assert.equal(sideChat.pill, "Temporary");
    assert.equal(sideChat.conversationKind, "paper");
    assert.equal(
      sideChat.placeholder,
      "Ask a side question about this paper...",
    );
    assert.closeTo(
      sideChat.inputHeightPx,
      side.main.inputHeightPx,
      1,
      "the side chat's input box is as tall as the main one",
    );
    assert.equal(sideChat.statusText, "Ready");

    const QUESTION_1 = "side-panel-side-question-one";
    const ANSWER_1 = "side-panel-side-answer-one";
    side = await askSideChat(QUESTION_1, ANSWER_1);
    assert.equal(side.tabs[2].title, QUESTION_1, "titled by its question");
    assert.equal(side.sideChat!.retryButtons, 0, "no retry in a side chat");
    assertSameComposer(side, side.sideChat!.composer, "side chat");
    assert.isTrue(side.sideChat!.composer!.modelNameShown, "the model's name");
    assert.equal(side.sideChat!.composer!.statusText, "Ready");
    assert.equal(
      side.sideChat!.composer!.statusClass,
      "llm-status",
      "Ready keeps the neutral style after an answer",
    );
    assert.equal(side.titleText, "Side chat");
    assertSameDesign(side);
    assertBrowserTabs(await waitForSettledTabs("browser tabs"));
    // The font-size shortcut scales every panel chat with the main chat.
    pressFontScaleShortcut("=");
    side = await waitForSide(
      (state) =>
        state.design.mainFontScale !== "" &&
        state.design.sideFontScales.length > 0 &&
        state.design.sideFontScales.every(
          (scale) => scale === state.design.mainFontScale,
        ),
      "the panel chats follow the font-size shortcut",
    );
    assertSameDesign(side);
    pressFontScaleShortcut("0");
    assert.equal(side.sideChat!.editableBubbles, 0, "no inline edit");
    assert.equal(side.sideChat!.forkButtons, 0, "no fork");
    const firstSideTab = side.activeTab!;
    const firstSideKey = side.sideChat!.conversationKey;

    // Send to main chat adds the side answer to the main chat.
    side = await api.clickStandaloneChatMessageAction(
      "sidechat",
      "llm-message-action-send-main",
    );
    assert.isTrue(
      side.main.selectedContextTexts.some((text) => text.includes(ANSWER_1)),
      `the main chat holds the side answer: ${JSON.stringify(side.main)}`,
    );

    // A second side chat is its own conversation; each answer stays in its
    // own tab.
    await api.clickStandaloneSidePanelControl("new-tab");
    side = await api.clickStandaloneSidePanelControl("new-sidechat");
    assert.lengthOf(side.tabs, 4);
    side = await waitForSide(
      (state) =>
        Boolean(state.sideChat?.conversationKey) &&
        state.sideChat!.conversationKey !== firstSideKey,
      "the second side chat mounts on its own key",
    );
    assert.lengthOf(side.sideChat!.messageTexts, 0, "a new side chat");
    const QUESTION_2 = "side-panel-side-question-two";
    const ANSWER_2 = "side-panel-side-answer-two";
    side = await askSideChat(QUESTION_2, ANSWER_2);
    const secondSideTab = side.activeTab!;
    const secondSideKey = side.sideChat!.conversationKey;
    {
      const first = side.sideChats.find((chat) => chat.tabId === firstSideTab)!;
      const second = side.sideChats.find(
        (chat) => chat.tabId === secondSideTab,
      )!;
      assert.isTrue(first.messageTexts.some((text) => text.includes(ANSWER_1)));
      assert.isFalse(
        first.messageTexts.some((text) => text.includes(ANSWER_2)),
      );
      assert.isTrue(
        second.messageTexts.some((text) => text.includes(ANSWER_2)),
      );
      assert.isFalse(
        second.messageTexts.some((text) => text.includes(ANSWER_1)),
      );
      assert.isFalse(first.shown, "the first side chat stays mounted, hidden");
    }

    // "/" in the main chat: Add side chat names the shown side chat and
    // attaches it.
    const slash = await api.openStandaloneSlashSideChatItem();
    assert.isTrue(slash.visible, "the main chat offers Add side chat");
    assert.isFalse(slash.disabled, "a side chat with an answer can be added");
    assert.equal(slash.hint, `Attach “${QUESTION_2}” as context`);
    side = await api.clickStandaloneSlashSideChatItem();
    assert.include(side.main.selectedContextSources, "sidechat");
    assert.isTrue(
      side.main.selectedContextTexts.some((text) => text.includes(ANSWER_2)),
      "the shown side chat's transcript is attached",
    );

    // Library chat has its own tabs: the paper's are put away, alive, and
    // come back unchanged with Paper chat (no move, no context note).
    // The panel stays open across the switch; Library chat has no tabs yet,
    // so it shows the New tab page.
    await api.clickStandaloneTab("open");
    side = await waitForSide(
      (state) => state.open && state.view === "newtab",
      "Library chat keeps the side panel open on its own New tab page",
    );
    assert.lengthOf(side.tabs, 0, "the paper's tabs are not Library chat's");
    await api.clickStandaloneTab("paper");
    side = await waitForSide(
      (state) =>
        state.open &&
        state.tabs.length === 4 &&
        state.activeTab === secondSideTab,
      "Paper chat brings the paper's tabs back",
    );
    assert.equal(side.sideChat!.conversationKey, secondSideKey);
    assert.lengthOf(side.sideChat!.contextNotes, 0);
    assert.equal(
      side.sideChat!.placeholder,
      "Ask a side question about this paper...",
    );
    side = await api.clickStandaloneSidePanelTab(2);
    assert.equal(side.activeTab, firstSideTab);
    assert.equal(side.sideChat!.conversationKey, firstSideKey);
    assert.isTrue(
      side.sideChat!.messageTexts.some((text) => text.includes(ANSWER_1)),
      "the side chat keeps its messages",
    );
    const movedSideKeys = side.sideChats.map((chat) => chat.conversationKey);

    // Closing a side chat tab with messages asks first, inside that tab.
    side = await api.clickStandaloneSidePanelTab(3, "close");
    assert.equal(side.activeTab, secondSideTab, "the tab shows its question");
    assert.isTrue(side.sideChat!.confirmVisible);
    assert.equal(
      side.sideChat!.confirmText,
      "Close this side chat? It is not saved, so these messages will be gone.",
    );
    side = await api.clickStandaloneSidePanelControl("confirm-keep");
    assert.lengthOf(side.tabs, 4);
    assert.isFalse(side.sideChat!.confirmVisible);
    side = await api.clickStandaloneSidePanelTab(3, "close");
    side = await api.clickStandaloneSidePanelControl("confirm-discard");
    assert.lengthOf(side.tabs, 3);
    assert.equal(side.activeTab, firstSideTab, "the left neighbour shows");
    // A read-only tab closes without asking.
    side = await api.clickStandaloneSidePanelTab(1, "close");
    assert.deepEqual(
      side.tabs.map((tab) => tab.kind),
      ["readonly", "sidechat"],
    );

    // Closing the panel with an unsaved side chat asks on the panel.
    side = await api.clickStandaloneSidePanelControl("toggle");
    assert.isTrue(side.open);
    assert.isTrue(side.panelConfirm.visible);
    assert.equal(
      side.panelConfirm.text,
      "Close the side panel? 1 side chat is not saved, so its messages will be gone.",
    );
    side = await api.clickStandaloneSidePanelControl("panel-confirm-keep");
    assert.isTrue(side.open);
    assert.isFalse(side.panelConfirm.visible);
    assert.lengthOf(side.tabs, 2);
    side = await api.clickStandaloneSidePanelControl("close");
    assert.isTrue(side.panelConfirm.visible);
    // It slides closed the same way, its tabs shown until the end.
    const closeFrames = await api.recordStandaloneSidePanelSlide(
      "panel-confirm-discard",
    );
    assertSlide(closeFrames, "close");
    side = await api.getStandaloneSidePanelDiagnostics();
    assert.isFalse(side.open);
    // Closing gives the width back.
    side = await waitForSide(
      (state) =>
        Math.abs(state.window.outerWidth - beforeOpen.window.outerWidth) <= 2,
      "the window narrows back when the panel closes",
    );
    assertWindowStays(side, "close");
    assert.closeTo(
      side.mainContentWidthPx,
      beforeOpen.mainContentWidthPx,
      2,
      "closing keeps the main chat's width",
    );
    assert.equal(side.sidebarState, beforeOpen.sidebarState);
    assert.equal(side.toggleExpanded, "false");
    assert.equal(side.toggleLabel, "Open side panel");
    assert.deepEqual(side.tabs, []);
    // Nothing of either side chat is kept or was ever stored.
    for (const key of new Set([
      firstSideKey,
      secondSideKey,
      ...movedSideKeys,
    ])) {
      const lifecycle = await api.readChatTurnLifecycle(key);
      assert.lengthOf(lifecycle.memory, 0, `side chat ${key} left memory`);
      assert.lengthOf(lifecycle.storedRows, 0, `side chat ${key} not stored`);
    }

    // Opening again starts at the new-tab page with no tabs.
    side = await api.clickStandaloneSidePanelControl("toggle");
    assert.equal(side.view, "newtab");
    assert.deepEqual(side.tabs, []);

    // If the user resizes the window while the panel is open, closing it
    // keeps the user's width.
    side = await waitForSide(
      (state) =>
        state.window.outerWidth >=
        beforeOpen.window.outerWidth + state.panelWidthPx + 5 - 2,
      "the window widens again",
    );
    {
      const win = standaloneWin()!;
      await api.resizeStandaloneWindow(win.innerWidth - 40, win.innerHeight);
    }
    const userWidth = (await api.getStandaloneSidePanelDiagnostics()).window
      .outerWidth;
    side = await api.clickStandaloneSidePanelControl("toggle");
    assert.equal(side.toggleExpanded, "false", "closing at once");
    side = await waitForSide((state) => !state.open, "the close slide ends");
    await Zotero.Promise.delay(600);
    side = await api.getStandaloneSidePanelDiagnostics();
    assert.closeTo(
      side.window.outerWidth,
      userWidth,
      2,
      "a width the user chose stays",
    );

    // Open as main chat switches the main chat, as Search history does. The
    // main chat was a new, empty one, so no tab takes the opened chat's place.
    await api.clickStandaloneTab("paper");
    side = await api.clickStandaloneSidePanelControl("toggle");
    side = await pickPastChat(pastKey);
    side = await api.clickStandaloneSidePanelControl("readonly-open-main");
    side = await waitForSide(
      (state) => state.main.conversationKey === pastKey,
      "the past chat becomes the main chat",
    );
    await Zotero.Promise.delay(300);
    side = await api.getStandaloneSidePanelDiagnostics();
    assert.deepEqual(side.tabs, [], "an empty main chat opens no tab");
    assert.equal(side.view, "newtab");

    // With a main chat that has turns, the two chats swap: the previous
    // main chat shows read-only in the opened chat's tab, both ways.
    side = await pickPastChat(secondKey);
    assert.equal(side.readOnly?.conversationKey, secondKey);
    side = await api.clickStandaloneSidePanelControl("readonly-open-main");
    side = await waitForSide(
      (state) =>
        state.main.conversationKey === secondKey &&
        state.view === "readonly" &&
        state.readOnly?.conversationKey === pastKey,
      "the previous main chat shows read-only in the panel",
    );
    assert.lengthOf(side.tabs, 1, "it takes the opened chat's tab");
    assert.include(side.readOnly!.messageTexts.join(" "), PAST_ANSWER);
    side = await api.clickStandaloneSidePanelControl("readonly-open-main");
    side = await waitForSide(
      (state) =>
        state.main.conversationKey === pastKey &&
        state.readOnly?.conversationKey === secondKey,
      "swapping back shows the other chat read-only",
    );
    assert.lengthOf(side.tabs, 1);
    side = await api.clickStandaloneSidePanelTab(0, "close");
    assert.deepEqual(side.tabs, []);
    assert.equal(side.view, "newtab");
    side = await api.clickStandaloneSidePanelControl("new-history");
    side = await waitForSide(
      (state) =>
        state.historyKeys.includes(secondKey) &&
        !state.historyKeys.includes(pastKey),
      "the History tab now hides the new main chat",
    );
    side = await api.clickStandaloneSidePanelTab(0, "close");
    assert.equal(side.view, "newtab", "closing History shows New tab");
    assert.deepEqual(side.tabs, []);

    // Ask in side chat: with no side chat, a main-chat answer opens one
    // quoting it.
    side = await waitForSide(
      (state) => state.main.askSideButtons > 0,
      "main-chat answers offer Ask in side chat",
    );
    side = await api.clickStandaloneChatMessageAction(
      "main",
      "llm-message-action-ask-side",
    );
    assert.equal(side.view, "sidechat");
    assert.lengthOf(side.tabs, 1);
    side = await waitForSide(
      (state) =>
        Boolean(
          state.sideChat?.selectedContextTexts.some((text) =>
            text.includes(PAST_ANSWER),
          ),
        ),
      "the side chat holds the main-chat answer as a quote",
    );
    assert.lengthOf(side.sideChat!.messageTexts, 0, "a new side chat");
    const askTab = side.activeTab;
    // With a read-only tab shown, it goes to the most recent side chat.
    await api.clickStandaloneSidePanelControl("new-tab");
    side = await pickPastChat(secondKey);
    assert.equal(side.view, "readonly");
    side = await api.clickStandaloneChatMessageAction(
      "main",
      "llm-message-action-ask-side",
    );
    assert.equal(side.activeTab, askTab, "the same side chat, no new tab");
    assert.lengthOf(side.tabs, 2);
  });

  it("puts the New tab page's title on the main start page's title line", async function () {
    const fixture = await api.createPaperWithPdfFixture({
      title: "Side panel title line paper",
      pdfTitle: "Side panel title line paper PDF",
      pages: ["Side panel title line paper: one short page of text."],
    });
    fixtures.push(fixture);
    await api.openStandaloneForItem(fixture.parentItemId);
    await api.clickStandaloneTab("open");
    // Earlier files leave messages in the default library chat; the start
    // page needs an empty one.
    await api.startNewStandaloneConversation();
    await api.clickStandaloneSidePanelControl("toggle");
    const aligned = (state: WorkflowTestStandaloneSidePanelDiagnostics) => {
      const page = state.design.newTabPage;
      return Boolean(
        page &&
        page.mainTitleTopPx !== null &&
        Math.abs(page.titleTopPx - page.mainTitleTopPx) <= 0.5,
      );
    };
    let side = await waitForSide(aligned, "library chat start page");
    assertOnMainTitleLine(side.design.newTabPage, "library chat");

    // A shorter window moves the main title; the side title follows.
    const win = standaloneWin()!;
    await api.resizeStandaloneWindow(win.innerWidth, win.innerHeight - 160);
    side = await waitForSide(aligned, "shorter window");
    assertOnMainTitleLine(side.design.newTabPage, "shorter window");

    // With a chat in the main column there is no main title: the page
    // centres in its column.
    await api.seedStandaloneConversation([
      { role: "user", text: "title-line-question" },
      { role: "assistant", text: "title-line-answer" },
    ]);
    side = await waitForSide(
      (state) => state.design.newTabPage?.mainTitleTopPx === null,
      "main chat shows messages",
    );
    side = await waitForSide(
      (state) => Math.abs(state.design.newTabPage?.centreDyPx ?? 99) <= 12,
      "the page centres without a main title",
    );

    // A new main chat brings the start page, and the title line, back.
    await api.startNewStandaloneConversation();
    side = await waitForSide(aligned, "new main chat");
    assertOnMainTitleLine(side.design.newTabPage, "new main chat");
  });

  it("keeps the window in place when the screen has little room on the right", async function () {
    const fixture = await api.createPaperWithPdfFixture({
      title: "Side panel edge paper",
      pdfTitle: "Side panel edge paper PDF",
      pages: ["Side panel edge paper: one short page of text."],
    });
    fixtures.push(fixture);
    await api.openStandaloneForItem(fixture.parentItemId);
    const win = standaloneWin()!;
    await api.resizeStandaloneWindow(900, win.innerHeight);
    const screen = win.screen as any;
    const screenRight = (screen.availLeft || 0) + screen.availWidth;
    // 100 px of room on the right: less than the panel needs.
    win.moveTo(
      screenRight - win.outerWidth - 100,
      Math.max(win.screenY, screen.availTop || 0),
    );
    await Zotero.Promise.delay(300);
    const before = await api.getStandaloneSidePanelDiagnostics();
    let side = await api.clickStandaloneSidePanelControl("toggle");
    assert.isTrue(side.open);
    side = await waitForSide(
      (state) => state.window.outerWidth >= before.window.outerWidth + 98,
      "the window grows to the screen's right edge",
    );
    await Zotero.Promise.delay(300);
    side = await api.getStandaloneSidePanelDiagnostics();
    assert.closeTo(side.window.screenX, before.window.screenX, 1, "x stays");
    assert.closeTo(side.window.screenY, before.window.screenY, 1, "y stays");
    assert.closeTo(
      side.window.outerWidth,
      before.window.outerWidth + 100,
      2,
      "the window grows only as far as the screen allows",
    );
    // The rest comes from the columns (the History pane may fold away).
    assert.isAtLeast(side.panelWidthPx, 300, "the panel still shows");
    side = await api.clickStandaloneSidePanelControl("toggle");
    assert.equal(side.toggleExpanded, "false", "closing at once");
    side = await waitForSide((state) => !state.open, "the close slide ends");
    side = await waitForSide(
      (state) =>
        Math.abs(state.window.outerWidth - before.window.outerWidth) <= 2,
      "the window narrows back",
    );
    assert.closeTo(side.window.screenX, before.window.screenX, 1);
    assert.closeTo(side.window.screenY, before.window.screenY, 1);
  });
});
