import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

const prefix = "extensions.zotero.llmforzotero.";

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!check() && Date.now() < deadline) await Zotero.Promise.delay(50);
  assert.isTrue(check(), message);
}

function isVisible(element: HTMLElement | null | undefined): boolean {
  return Boolean(element) && element!.style.display !== "none";
}

const SMALL_CATALOG = ["gpt-4o", "chatgpt-4o-latest", "gpt-4o-mini", "o3"];

describe("workflow: searchable model field in Preferences", function () {
  this.timeout(30000);
  let api: WorkflowTestApi;
  let preferences: Window | undefined;
  let previous = new Map<string, unknown>();

  let groupId = "";
  let rowSelector = "";
  let settings: Record<string, string | number> = {};

  // Each test gets its own group id and apiKey so the in-memory catalog
  // cache from an earlier test cannot satisfy a later one.
  function useProvider(
    suffix: string,
    options: {
      fields?: Record<string, unknown>;
      models?: string[];
    } = {},
  ): void {
    groupId = `workflow-combobox-${suffix}`;
    rowSelector = `[data-llm-provider-row="${groupId}"]`;
    const models = options.models || ["gpt-saved"];
    settings = {
      modelProviderGroupsMigrationVersion: 3,
      lastUsedModelEntryId: `${groupId}-model-0`,
      modelProviderGroups: JSON.stringify([
        {
          id: groupId,
          authMode: "api_key",
          providerProtocol: "openai_chat_compat",
          presetIdOverride: "openai",
          apiBase: "https://api.openai.com/v1",
          apiKey: `workflow-key-${suffix}`,
          ...options.fields,
          models: models.map((model, index) => ({
            id: `${groupId}-model-${index}`,
            model,
          })),
        },
      ]),
    };
  }

  function applySettings(): void {
    previous = new Map(
      Object.keys(settings).map((key) => [
        key,
        Zotero.Prefs.get(prefix + key, true),
      ]),
    );
    for (const [key, value] of Object.entries(settings))
      Zotero.Prefs.set(prefix + key, value, true);
  }

  function storedModels(): string[] {
    const groups = JSON.parse(
      String(Zotero.Prefs.get(prefix + "modelProviderGroups", true) || "[]"),
    ) as Array<{ id: string; models: Array<{ model: string }> }>;
    const group = groups.find((candidate) => candidate.id === groupId);
    return group ? group.models.map((row) => row.model) : [];
  }

  async function openPreferences(): Promise<Window> {
    preferences = (Zotero.Utilities.Internal as any).openPreferences(
      "llmforzotero-preferences",
    );
    await waitFor(
      () => Boolean(preferences?.document.querySelector(rowSelector)),
      "provider card must render",
    );
    const row = preferences!.document.querySelector(rowSelector)!;
    if (row.getAttribute("data-open") !== "true")
      row.querySelector<HTMLButtonElement>(".llm-pref-row-toggle")!.click();
    // Gecko fires focus events only in the active window, and a test window
    // behind another app cannot take activation on macOS. The focus
    // manager's test mode lets win.focus() raise it the way a click would.
    preferences!.focus();
    await waitFor(
      () => preferences!.document.hasFocus(),
      "Preferences must take focus",
    );
    return preferences!;
  }

  async function closePreferences(): Promise<void> {
    preferences?.close();
    await waitFor(
      () => !preferences || preferences.closed,
      "Preferences must close",
    );
    preferences = undefined;
  }

  function modelRows(win: Window): HTMLElement[] {
    return Array.from(
      win.document.querySelectorAll<HTMLElement>(
        `${rowSelector} .llm-pref-model-row`,
      ),
    ) as HTMLElement[];
  }

  function field(win: Window, index = 0) {
    const row = modelRows(win)[index];
    const options = () =>
      Array.from(
        row.querySelectorAll<HTMLElement>(".llm-pref-model-option"),
      ) as HTMLElement[];
    return {
      row,
      input: row.querySelector<HTMLInputElement>(".llm-pref-input")!,
      chevron: row.querySelector<HTMLButtonElement>(".llm-pref-model-chevron")!,
      list: row.querySelector<HTMLElement>(".llm-pref-model-list")!,
      options: row.querySelector<HTMLElement>(".llm-pref-model-options")!,
      footer: row.querySelector<HTMLElement>(".llm-pref-model-list-footer")!,
      option: (id: string) =>
        options().find((option) => option.dataset.modelId === id),
      customRow: () =>
        row.querySelector<HTMLElement>(
          '.llm-pref-model-option[data-custom="true"]',
        ),
      optionIds: () =>
        options().map((option) => option.dataset.modelId || "<custom>"),
    };
  }

  async function waitForCatalog(win: Window, index = 0): Promise<void> {
    await waitFor(
      () => isVisible(field(win, index).chevron),
      "the model field must offer its catalog once it arrives",
    );
  }

  /** Press and release the left button at the centre of `target`. */
  async function realClick(win: Window, target: HTMLElement): Promise<void> {
    target.scrollIntoView({ block: "center" });
    await Zotero.Promise.delay(50);
    const rect = target.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = win.document.elementFromPoint(x, y);
    assert.isTrue(
      Boolean(hit && (hit === target || target.contains(hit))),
      `the pointer must land on the target, not ${hit?.nodeName}.${(hit as HTMLElement | null)?.className}`,
    );
    win.windowUtils.sendMouseEvent("mousedown", x, y, 0, 1, 0);
    await Zotero.Promise.delay(30);
    win.windowUtils.sendMouseEvent("mouseup", x, y, 0, 1, 0);
    await Zotero.Promise.delay(30);
  }

  function type(input: HTMLInputElement, value: string): void {
    input.value = value;
    input.dispatchEvent(
      new (input.ownerDocument.defaultView as any).InputEvent("input", {
        bubbles: true,
      }),
    );
  }

  function press(input: HTMLInputElement, key: string): KeyboardEvent {
    const event = new (input.ownerDocument.defaultView as any).KeyboardEvent(
      "keydown",
      { key, bubbles: true, cancelable: true },
    ) as KeyboardEvent;
    input.dispatchEvent(event);
    return event;
  }

  const SCROLLBAR_PARTS = [
    "scrollbar",
    "slider",
    "thumb",
    "scrollbarbutton",
    "scrollcorner",
  ];

  /**
   * Press and release the left button 4 px inside the right edge of
   * `scroller`, where a classic scrollbar sits. Fails unless the press hit a
   * scrollbar part, so a missed press cannot pass silently.
   */
  async function pressScrollbar(
    win: Window,
    scroller: HTMLElement,
  ): Promise<string> {
    assert.isAbove(
      scroller.scrollHeight,
      scroller.clientHeight + 1,
      "the element must overflow so it shows a scrollbar",
    );
    assert.isAbove(
      scroller.offsetWidth - scroller.clientWidth,
      4,
      "the scrollbar must take layout space (classic, not overlay)",
    );
    const rect = scroller.getBoundingClientRect();
    const x = rect.right - 4;
    const y = rect.top + rect.height / 2;
    const hits: string[] = [];
    let inside = false;
    const record = (event: Event) => {
      const part = (
        event as unknown as {
          originalTarget?: { localName?: string; parentNode?: Node | null };
        }
      ).originalTarget;
      hits.push(String(part?.localName));
      // Native-anonymous parts: walk parentNode up to the scroller.
      for (let n: Node | null | undefined = part as Node; n; n = n.parentNode)
        if (n === scroller) inside = true;
    };
    win.addEventListener("mousedown", record, true);
    try {
      win.windowUtils.sendMouseEvent("mousedown", x, y, 0, 1, 0);
      await Zotero.Promise.delay(30);
      win.windowUtils.sendMouseEvent("mouseup", x, y, 0, 1, 0);
      await Zotero.Promise.delay(100);
    } finally {
      win.removeEventListener("mousedown", record, true);
    }
    assert.include(
      SCROLLBAR_PARTS,
      hits[0],
      `the press did not hit the scrollbar; it hit <${hits[0]}>`,
    );
    assert.isTrue(
      inside,
      `the hit <${hits[0]}> is not inside the scroller (parentNode walk)`,
    );
    return hits[0];
  }

  /** The nearest ancestor of `node` that scrolls its overflow vertically. */
  function scrollingAncestor(node: Element): HTMLElement {
    const win = node.ownerDocument.defaultView!;
    for (let el = node.parentElement; el; el = el.parentElement) {
      const overflow = win.getComputedStyle(el)?.overflowY;
      if (
        (overflow === "auto" || overflow === "scroll") &&
        el.scrollHeight > el.clientHeight + 1
      )
        return el as HTMLElement;
    }
    throw new Error("no scrolling ancestor");
  }

  const overlayScrollbarsPref = "ui.useOverlayScrollbars";
  let savedOverlayScrollbars: unknown;

  const testModePref = "focusmanager.testmode";
  let savedTestMode: unknown;

  beforeEach(async function () {
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    savedTestMode = Zotero.Prefs.get(testModePref, true);
    Zotero.Prefs.set(testModePref, true, true);
    // macOS overlay scrollbars hide until the pointer moves over them; classic
    // scrollbars can be pressed at a fixed spot.
    savedOverlayScrollbars = Zotero.Prefs.get(overlayScrollbarsPref, true);
    Zotero.Prefs.set(overlayScrollbarsPref, 0, true);
  });

  afterEach(async function () {
    await closePreferences();
    if (savedTestMode === undefined) Zotero.Prefs.clear(testModePref, true);
    else Zotero.Prefs.set(testModePref, savedTestMode as never, true);
    if (savedOverlayScrollbars === undefined)
      Zotero.Prefs.clear(overlayScrollbarsPref, true);
    else
      Zotero.Prefs.set(
        overlayScrollbarsPref,
        savedOverlayScrollbars as never,
        true,
      );
    await api.reset();
    for (const [key, value] of previous) {
      if (value === undefined) Zotero.Prefs.clear(prefix + key, true);
      else
        Zotero.Prefs.set(
          prefix + key,
          value as string | number | boolean,
          true,
        );
    }
  });

  it("filters while typing without saving, and saves a row picked with the pointer", async function () {
    useProvider("pointer-pick");
    applySettings();
    api.configureModelCatalogFetch({
      status: 200,
      body: { data: SMALL_CATALOG.map((id) => ({ id })) },
    });
    const win = await openPreferences();
    await waitForCatalog(win);
    const f = field(win);
    assert.equal(f.input.value, "gpt-saved", "the saved model stays shown");
    assert.isFalse(isVisible(f.list), "the list starts closed");

    await realClick(win, f.input);
    assert.equal(win.document.activeElement, f.input);
    await waitFor(() => isVisible(f.list), "focusing the field opens the list");
    assert.equal(f.input.getAttribute("aria-expanded"), "true");
    assert.deepEqual(
      f.optionIds(),
      ["chatgpt-4o-latest", "gpt-4o", "gpt-4o-mini", "o3"],
      "an empty search shows the whole catalog in sorted order",
    );
    assert.equal(f.footer.textContent, "4 models");

    type(f.input, "MINI");
    assert.deepEqual(f.optionIds(), ["gpt-4o-mini", "<custom>"]);
    assert.equal(f.footer.textContent, "1 of 4 models match");
    const match = f
      .option("gpt-4o-mini")!
      .querySelector(".llm-pref-model-option-match");
    assert.equal(match?.textContent, "mini", "the matching part is marked");
    assert.include(f.customRow()!.textContent || "", 'Use "MINI"');
    assert.deepEqual(
      storedModels(),
      ["gpt-saved"],
      "search text is a draft and is not saved per keystroke",
    );

    await realClick(win, f.option("gpt-4o-mini")!);
    await waitFor(
      () => storedModels()[0] === "gpt-4o-mini",
      "the picked row must be saved",
    );
    assert.equal(f.input.value, "gpt-4o-mini");
    assert.isFalse(isVisible(f.list), "picking closes the list");
    assert.equal(
      win.document.activeElement,
      f.input,
      "the field keeps focus through a pointer pick",
    );
  });

  it("Enter on gpt-4o picks gpt-4o even when chatgpt-4o-latest is listed first", async function () {
    useProvider("enter-exact");
    applySettings();
    api.configureModelCatalogFetch({
      status: 200,
      body: { data: SMALL_CATALOG.map((id) => ({ id })) },
    });
    const win = await openPreferences();
    await waitForCatalog(win);
    const f = field(win);
    f.input.focus();
    await waitFor(() => isVisible(f.list), "focusing the field opens the list");
    type(f.input, "gpt-4o");
    assert.deepEqual(f.optionIds(), [
      "chatgpt-4o-latest",
      "gpt-4o",
      "gpt-4o-mini",
    ]);
    assert.equal(f.footer.textContent, "3 of 4 models match");
    assert.equal(
      f.option("gpt-4o")!.getAttribute("aria-selected"),
      "true",
      "the exact match is the active row",
    );
    assert.equal(
      f.input.getAttribute("aria-activedescendant"),
      f.option("gpt-4o")!.id,
    );
    const enter = press(f.input, "Enter");
    assert.isTrue(enter.defaultPrevented, "Enter is consumed while open");
    await waitFor(
      () => storedModels()[0] === "gpt-4o",
      "Enter must save the exact match",
    );
    assert.isFalse(isVisible(f.list));

    // Arrow keys move the active row; Enter picks it.
    press(f.input, "ArrowDown");
    await waitFor(() => isVisible(f.list), "ArrowDown opens the list");
    type(f.input, "o");
    assert.isNull(
      f.input.getAttribute("aria-activedescendant"),
      "without an exact match no row is active",
    );
    press(f.input, "ArrowDown");
    press(f.input, "ArrowDown");
    assert.equal(f.option("gpt-4o")!.getAttribute("aria-selected"), "true");
    press(f.input, "ArrowUp");
    assert.equal(
      f.option("chatgpt-4o-latest")!.getAttribute("aria-selected"),
      "true",
    );
    press(f.input, "Enter");
    await waitFor(
      () => storedModels()[0] === "chatgpt-4o-latest",
      "Enter must save the active row",
    );
  });

  it("Esc restores the saved model; Use row and Enter keep typed text", async function () {
    useProvider("escape");
    applySettings();
    api.configureModelCatalogFetch({
      status: 200,
      body: { data: SMALL_CATALOG.map((id) => ({ id })) },
    });
    const win = await openPreferences();
    await waitForCatalog(win);
    const f = field(win);
    f.input.focus();
    await waitFor(() => isVisible(f.list), "focusing the field opens the list");

    const escape = press(f.input, "Escape");
    assert.isTrue(escape.defaultPrevented, "Esc is consumed while open");
    assert.isFalse(isVisible(f.list), "Esc closes the list");
    assert.equal(f.input.value, "gpt-saved");

    type(f.input, "zzz-draft");
    assert.isTrue(isVisible(f.list), "typing opens the list again");
    assert.deepEqual(f.optionIds(), ["<custom>"]);
    assert.equal(f.footer.textContent, "0 of 4 models match");
    press(f.input, "Escape");
    assert.equal(f.input.value, "gpt-saved", "Esc restores the saved model");
    assert.deepEqual(storedModels(), ["gpt-saved"]);

    type(f.input, "my-custom-model");
    f.customRow()!.click();
    await waitFor(
      () => storedModels()[0] === "my-custom-model",
      "the Use row saves the typed text",
    );
    assert.isFalse(isVisible(f.list));

    type(f.input, "gpt-4o-typed");
    press(f.input, "Enter");
    await waitFor(
      () => storedModels()[0] === "gpt-4o-typed",
      "Enter with no active row saves the typed text",
    );

    // Esc after a commit restores the new saved value, not the old one.
    type(f.input, "abc");
    press(f.input, "Escape");
    assert.equal(f.input.value, "gpt-4o-typed");

    // An emptied field keeps the saved model, on Enter and on leaving it.
    type(f.input, "");
    press(f.input, "Enter");
    assert.equal(f.input.value, "gpt-4o-typed", "Enter on an empty field");
    type(f.input, "  ");
    f.input.blur();
    await waitFor(
      () => f.input.value === "gpt-4o-typed",
      "leaving an empty field restores the saved model",
    );
    assert.deepEqual(storedModels(), ["gpt-4o-typed"]);
  });

  it("a click below the open list lands and saves the typed text", async function () {
    useProvider("click-below", { models: ["gpt-saved", "o3"] });
    applySettings();
    api.configureModelCatalogFetch({
      status: 200,
      body: { data: SMALL_CATALOG.map((id) => ({ id })) },
    });
    const win = await openPreferences();
    await waitForCatalog(win, 0);
    await waitForCatalog(win, 1);
    const first = field(win, 0);
    const second = field(win, 1);
    await realClick(win, first.input);
    await waitFor(() => isVisible(first.list), "the first list opens");
    type(first.input, "typed-search-text");

    const secondTop = second.input.getBoundingClientRect().top;
    assert.isAbove(
      secondTop,
      first.list.getBoundingClientRect().bottom - 1,
      "the second field sits below the open list",
    );
    let clicks = 0;
    second.input.addEventListener("click", () => (clicks += 1));
    await realClick(win, second.input);

    assert.equal(clicks, 1, "the click must land on the control below");
    assert.equal(win.document.activeElement, second.input);
    assert.isFalse(isVisible(first.list), "the first list closes");
    await waitFor(
      () => storedModels()[0] === "typed-search-text",
      "leaving the field saves the typed text",
    );
    assert.equal(storedModels()[1], "o3");
    assert.equal(first.input.value, "typed-search-text");

    // Leaving with the keyboard saves too.
    type(second.input, "second-typed");
    second.input.blur();
    await waitFor(
      () => storedModels()[1] === "second-typed",
      "blur saves the typed text",
    );
    assert.isFalse(isVisible(second.list));
  });

  it("a press on the list's scrollbar keeps the field focused and the list open", async function () {
    const ids = Array.from(
      { length: 60 },
      (_, index) => `vendor/model-${String(index).padStart(2, "0")}`,
    );
    useProvider("list-scrollbar", { models: ["vendor/model-10"] });
    applySettings();
    api.configureModelCatalogFetch({
      status: 200,
      body: { data: ids.map((id) => ({ id })) },
    });
    const win = await openPreferences();
    await waitForCatalog(win);
    const f = field(win);
    await realClick(win, f.input);
    await waitFor(() => isVisible(f.list), "focusing the field opens the list");
    assert.equal(win.document.activeElement, f.input);

    const hit = await pressScrollbar(win, f.options);
    assert.equal(
      win.document.activeElement,
      f.input,
      `a press on the list's scrollbar <${hit}> keeps the field focused, not #${win.document.activeElement?.id}`,
    );
    assert.isTrue(isVisible(f.list), "the list stays open");
    assert.equal(f.input.getAttribute("aria-expanded"), "true");
    assert.deepEqual(storedModels(), ["vendor/model-10"]);
  });

  it("a press on the pane's scrollbar keeps the draft unsaved; a press on blank pane area saves it", async function () {
    useProvider("pane-scrollbar");
    applySettings();
    api.configureModelCatalogFetch({
      status: 200,
      body: { data: SMALL_CATALOG.map((id) => ({ id })) },
    });
    const win = await openPreferences();
    await waitForCatalog(win);
    const f = field(win);
    await realClick(win, f.input);
    await waitFor(() => isVisible(f.list), "focusing the field opens the list");
    type(f.input, "flash");

    // A short window makes sure the pane overflows and shows its scrollbar.
    const pane = win.document.getElementById("prefs-content") as HTMLElement;
    if (pane.scrollHeight <= pane.clientHeight + 1) {
      win.resizeTo(win.outerWidth, 480);
      await waitFor(
        () => pane.scrollHeight > pane.clientHeight + 1,
        "the Settings pane must overflow",
      );
    }
    assert.equal(
      scrollingAncestor(f.input),
      pane,
      "#prefs-content scrolls the Settings pane",
    );
    const hit = await pressScrollbar(win, pane);
    assert.equal(
      win.document.activeElement,
      f.input,
      `a press on the pane's scrollbar <${hit}> keeps the field focused, not #${win.document.activeElement?.id}`,
    );
    assert.isTrue(isVisible(f.list), "the list stays open");
    assert.equal(f.input.value, "flash", "the draft stays in the field");
    assert.deepEqual(storedModels(), ["gpt-saved"], "the draft is not saved");

    // Control: a press on blank pane area is a real blur and saves the draft.
    f.input.scrollIntoView({ block: "center" });
    await Zotero.Promise.delay(50);
    const rect = pane.getBoundingClientRect();
    const focusable =
      "input, button, select, textarea, a[href], label, menulist, checkbox, radio, [contenteditable], [tabindex]:not(#prefs-content)";
    let point: { x: number; y: number } | null = null;
    for (let y = rect.top + 10; y < rect.bottom - 10 && !point; y += 12)
      for (let x = rect.left + 10; x < rect.right - 30 && !point; x += 12) {
        const hitEl = win.document.elementFromPoint(x, y);
        if (
          hitEl &&
          pane.contains(hitEl) &&
          !hitEl.closest(focusable) &&
          !f.list.contains(hitEl)
        )
          point = { x, y };
      }
    assert.isNotNull(point, "the pane must have a blank spot to press");
    win.windowUtils.sendMouseEvent("mousedown", point!.x, point!.y, 0, 1, 0);
    await Zotero.Promise.delay(30);
    win.windowUtils.sendMouseEvent("mouseup", point!.x, point!.y, 0, 1, 0);
    await waitFor(
      () => storedModels()[0] === "flash",
      "a press on blank pane area saves the draft",
    );
    assert.notEqual(win.document.activeElement, f.input);
    assert.isFalse(isVisible(f.list), "the list closes");
  });

  it("a press on the pane's scrollbar keeps the draft after the chevron closed the list", async function () {
    useProvider("chevron-scrollbar");
    applySettings();
    api.configureModelCatalogFetch({
      status: 200,
      body: { data: SMALL_CATALOG.map((id) => ({ id })) },
    });
    const win = await openPreferences();
    await waitForCatalog(win);
    const f = field(win);
    await realClick(win, f.input);
    await waitFor(() => isVisible(f.list), "focusing the field opens the list");
    type(f.input, "flash");
    await realClick(win, f.chevron);
    await waitFor(() => !isVisible(f.list), "the chevron closes the list");
    assert.equal(win.document.activeElement, f.input);

    const pane = win.document.getElementById("prefs-content") as HTMLElement;
    if (pane.scrollHeight <= pane.clientHeight + 1) {
      win.resizeTo(win.outerWidth, 480);
      await waitFor(
        () => pane.scrollHeight > pane.clientHeight + 1,
        "the Settings pane must overflow",
      );
    }
    const hit = await pressScrollbar(win, pane);
    assert.equal(
      win.document.activeElement,
      f.input,
      `a press on the pane's scrollbar <${hit}> keeps the field focused, not #${win.document.activeElement?.id}`,
    );
    assert.equal(f.input.value, "flash", "the draft stays in the field");
    assert.deepEqual(storedModels(), ["gpt-saved"], "the draft is not saved");
  });

  it("lists a 500-model catalog in full and finds a match mid-ID", async function () {
    const ids = Array.from(
      { length: 500 },
      (_, index) => `vendor/model-${String(index).padStart(3, "0")}-instruct`,
    );
    useProvider("large", { models: ["vendor/model-400-instruct"] });
    applySettings();
    api.configureModelCatalogFetch({
      status: 200,
      body: { data: ids.map((id) => ({ id })) },
    });
    const win = await openPreferences();
    await waitForCatalog(win);
    const f = field(win);
    f.input.focus();
    await waitFor(() => isVisible(f.list), "focusing the field opens the list");
    assert.lengthOf(f.optionIds(), 500, "every model is listed");
    assert.equal(f.footer.textContent, "500 models");
    const saved = f.option("vendor/model-400-instruct")!;
    assert.equal(saved.getAttribute("aria-selected"), "true");
    const listRect = f.options.getBoundingClientRect();
    const savedRect = saved.getBoundingClientRect();
    assert.isAtLeast(savedRect.top, listRect.top - 1);
    assert.isAtMost(
      savedRect.bottom,
      listRect.bottom + 1,
      "the saved model's row is scrolled into view",
    );
    assert.isAtMost(listRect.height, 242, "the list scrolls inside 240px");

    type(f.input, "237-inst");
    assert.deepEqual(f.optionIds(), ["vendor/model-237-instruct", "<custom>"]);
    assert.equal(f.footer.textContent, "1 of 500 models match");
    type(f.input, "model 23 struct");
    assert.lengthOf(
      f.optionIds().filter((id) => id !== "<custom>"),
      15,
      "every word must match: x23 (five) and 230–239 (ten)",
    );
  });

  it("a refresh that lands keeps the open list, the active row, and the typed text", async function () {
    useProvider("refresh-open");
    applySettings();
    api.configureModelCatalogFetch({
      status: 200,
      body: { data: SMALL_CATALOG.map((id) => ({ id })) },
    });
    const win = await openPreferences();
    await waitForCatalog(win);
    const f = field(win);
    f.input.focus();
    await waitFor(() => isVisible(f.list), "focusing the field opens the list");
    type(f.input, "gpt");
    press(f.input, "ArrowDown");
    const activeId = f.optionIds()[0];
    assert.equal(f.option(activeId)!.getAttribute("aria-selected"), "true");

    api.configureModelCatalogFetch({
      status: 200,
      body: { data: [...SMALL_CATALOG, "gpt-5-new"].map((id) => ({ id })) },
    });
    const requestsBefore = api.getModelCatalogRequests().length;
    f.row.querySelector<HTMLButtonElement>(".llm-pref-model-refresh")!.click();
    await waitFor(
      () => Boolean(f.option("gpt-5-new")),
      "the refreshed catalog must reach the open list",
    );
    assert.isAbove(api.getModelCatalogRequests().length, requestsBefore);
    assert.isTrue(isVisible(f.list), "the list stays open");
    assert.equal(f.input.value, "gpt", "the typed text is unchanged");
    assert.equal(
      f.option(activeId)!.getAttribute("aria-selected"),
      "true",
      "the active row stays active",
    );
    assert.deepEqual(storedModels(), ["gpt-saved"], "the draft is not saved");

    // A refresh does not reopen a list the user closed.
    press(f.input, "Escape");
    assert.isFalse(isVisible(f.list));
    f.row.querySelector<HTMLButtonElement>(".llm-pref-model-refresh")!.click();
    await Zotero.Promise.delay(500);
    assert.isFalse(isVisible(f.list), "a refresh leaves a closed list closed");
  });

  it("typing is saved per keystroke without a catalog and becomes a draft once one arrives", async function () {
    useProvider("gate-switch");
    applySettings();
    api.configureModelCatalogFetch({ status: 404 });
    const win = await openPreferences();
    const f = field(win);
    await waitFor(() => {
      const status = f.row.querySelector<HTMLElement>(".llm-pref-hint");
      return (
        isVisible(status) &&
        status!.dataset.error === "true" &&
        !isVisible(f.chevron)
      );
    }, "the 404 catalog leaves the field in manual mode");
    f.input.focus();
    type(f.input, "manual-a");
    assert.equal(storedModels()[0], "manual-a", "manual mode saves at once");
    assert.isNull(
      f.input.getAttribute("role"),
      "no combobox role without a list",
    );

    api.configureModelCatalogFetch({
      status: 200,
      body: { data: SMALL_CATALOG.map((id) => ({ id })) },
    });
    f.row.querySelector<HTMLButtonElement>(".llm-pref-model-refresh")!.click();
    await waitForCatalog(win);
    assert.equal(f.input.getAttribute("role"), "combobox");
    assert.equal(win.document.activeElement, f.input);

    type(f.input, "manual-ab");
    assert.equal(storedModels()[0], "manual-a", "the later text is a draft");
    press(f.input, "Enter");
    await waitFor(
      () => storedModels()[0] === "manual-ab",
      "Enter commits the draft",
    );

    type(f.input, "manual-abc");
    assert.equal(storedModels()[0], "manual-ab");
    f.input.blur();
    await waitFor(
      () => storedModels()[0] === "manual-abc",
      "blur commits the draft",
    );
  });

  it("closing the window with a draft in the field saves the draft", async function () {
    useProvider("close-draft");
    applySettings();
    api.configureModelCatalogFetch({
      status: 200,
      body: { data: SMALL_CATALOG.map((id) => ({ id })) },
    });
    const win = await openPreferences();
    await waitForCatalog(win);
    const f = field(win);
    f.input.focus();
    await waitFor(() => isVisible(f.list), "focusing the field opens the list");
    // Closing a focused window can fire focusout, which commits on its own.
    // Move focus away first and leave the draft in the field, so only the
    // window-close hook can save it.
    f.input.blur();
    f.input.value = "my-new-model";
    assert.deepEqual(
      storedModels(),
      ["gpt-saved"],
      "the draft is not saved yet",
    );
    await closePreferences();
    // The window reports itself closed before its unload handlers finish.
    await waitFor(
      () => storedModels()[0] === "my-new-model",
      "closing the window must save the draft",
    );
  });

  it("SiliconFlow fetches its catalog when the field takes focus", async function () {
    useProvider("siliconflow", {
      fields: {
        presetIdOverride: "siliconflow",
        apiBase: "https://api.siliconflow.cn/v1",
      },
    });
    applySettings();
    api.configureModelCatalogFetch({
      status: 200,
      body: {
        data: [{ id: "Qwen/Qwen3-8B" }, { id: "deepseek-ai/DeepSeek-V3" }],
      },
    });
    const siliconFlowRequests = () =>
      api
        .getModelCatalogRequests()
        .filter((url) => url.startsWith("https://api.siliconflow.cn/"));
    const win = await openPreferences();
    const f = field(win);
    await Zotero.Promise.delay(300);
    assert.isEmpty(siliconFlowRequests(), "no fetch before the field is used");
    assert.isFalse(isVisible(f.chevron));

    await realClick(win, f.input);
    await waitFor(
      () => siliconFlowRequests().length > 0,
      "focus must request the SiliconFlow catalog",
    );
    await waitFor(
      () => isVisible(f.list) && Boolean(f.option("Qwen/Qwen3-8B")),
      "the catalog opens in the focused field, unfiltered",
    );
  });
});
