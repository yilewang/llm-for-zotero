import { assert } from "chai";
import { config, version } from "../package.json";
import type { PluginUpdateDeps } from "../src/modules/pluginUpdate";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

function getWorkflowTestApi(): WorkflowTestApi {
  const api = (Zotero as any).LLMForZotero?.api?.workflowTest;
  assert.isOk(api, "workflow test API should be installed");
  return api as WorkflowTestApi;
}

describe("workflow: plugin update indicator", function () {
  this.timeout(90000);

  const LAST_SEEN_PREF = `${config.prefsPrefix}.lastSeenVersion`;
  const NOTES_MARKER = "Fake release highlight";
  let api: WorkflowTestApi;
  let fixture: WorkflowTestFixture | null = null;
  let installCalls = 0;
  let available: { version: string } | null = null;
  let originalLastSeen: unknown;

  const deps: PluginUpdateDeps = {
    checkForUpdate: async () =>
      available ? { version: available.version, handle: {} } : null,
    installUpdate: () => {
      installCalls++;
    },
    fetchReleases: async (page) =>
      page > 1
        ? []
        : [
            {
              version,
              body: `## v${version}\n\n### Changes\n\n${NOTES_MARKER}. First line.\nSecond line.\n`,
              publishedAt: "2026-10-16T12:00:00Z",
              htmlUrl: `https://example.invalid/v${version}`,
            },
            {
              version: "0.0.1",
              body: "- Older release\n",
              publishedAt: "2026-01-01T12:00:00Z",
              htmlUrl: "https://example.invalid/v0.0.1",
            },
          ],
  };

  function standaloneDoc(): Document {
    const win = (Zotero as any).LLMForZotero?.data?.standaloneWindow as
      | Window
      | undefined;
    assert.isOk(win && !win.closed, "standalone window is open");
    return win!.document;
  }

  async function until(
    check: () => boolean,
    message: string,
    timeoutMs = 15000,
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

  const button = () =>
    standaloneDoc().getElementById(
      "llm-standalone-update-btn",
    ) as HTMLButtonElement | null;
  const popover = () =>
    standaloneDoc().querySelector(
      ".llm-standalone-update-popover",
    ) as HTMLElement | null;
  const notes = () =>
    standaloneDoc().querySelector(
      ".llm-standalone-release-notes",
    ) as HTMLElement | null;

  async function openStandalone(): Promise<void> {
    await api.openStandaloneForItem(fixture!.parentItemId);
    await until(() => Boolean(button()), "update button is rendered");
  }

  before(function () {
    originalLastSeen = Zotero.Prefs.get(LAST_SEEN_PREF, true);
  });

  beforeEach(async function () {
    api = getWorkflowTestApi();
    await api.reset();
    installCalls = 0;
    available = null;
    api.setPluginUpdateDeps(deps);
    Zotero.Prefs.set(LAST_SEEN_PREF, version, true);
    fixture = await api.createPaperWithPdfFixture({
      title: "Workflow Update Indicator Paper",
      pdfTitle: "Workflow Update Indicator PDF",
    });
  });

  afterEach(async function () {
    await api.closeStandalone();
    api.setPluginUpdateDeps(null);
    if (fixture) await api.cleanupFixture(fixture);
    fixture = null;
    await api.reset();
  });

  after(function () {
    Zotero.Prefs.set(
      LAST_SEEN_PREF,
      typeof originalLastSeen === "string" ? originalLastSeen : "",
      true,
    );
  });

  it("shows the version, release notes, update confirm and the updated badge", async function () {
    await openStandalone();
    const doc = standaloneDoc();

    // Up to date: version pill inside the sidebar footer row.
    assert.equal(button()!.textContent!.trim(), `v${version}`);
    assert.isOk(button()!.closest(".llm-standalone-footer-row"));

    // What's new: a centred window, one block per release.
    button()!.click();
    await until(
      () => Boolean(notes()?.textContent?.includes(NOTES_MARKER)),
      "release notes are rendered in the window",
    );
    const blocks = notes()!.querySelectorAll(
      ".llm-standalone-release-notes-release",
    );
    assert.equal(blocks.length, 2, "one block per release");
    const current = blocks[0] as HTMLElement;
    assert.equal(current.dataset.version, version);
    assert.include(current.textContent!, `v${version}`);
    assert.isOk(
      current.querySelector(".llm-standalone-release-notes-installed"),
      "the running version is marked installed",
    );
    assert.isNotOk(
      blocks[1].querySelector(".llm-standalone-release-notes-installed"),
    );
    assert.equal(
      current.querySelectorAll("li").length,
      2,
      "plain lines become bullet points",
    );
    assert.notInclude(
      current.querySelector(".llm-standalone-update-notes")!.textContent!,
      `v${version}`,
      "a heading that only repeats the version is hidden",
    );
    const win = doc.defaultView as any;
    const panelRect = notes()!
      .querySelector(".llm-standalone-release-notes-panel")!
      .getBoundingClientRect();
    assert.isAtMost(
      Math.abs(panelRect.left + panelRect.width / 2 - win.innerWidth / 2),
      2,
      "the window is centred",
    );

    // Esc closes.
    doc.dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await until(() => !notes(), "window closes on Esc");

    // The close button closes.
    button()!.click();
    await until(() => Boolean(notes()), "window opens again");
    (
      notes()!.querySelector(
        '[data-release-notes-action="close"]',
      ) as HTMLElement
    ).click();
    await until(() => !notes(), "window closes on the close button");

    // A click on the dimmed area closes; a click inside the window does not.
    button()!.click();
    await until(
      () => Boolean(notes()?.textContent?.includes(NOTES_MARKER)),
      "window opens a third time",
    );
    notes()!
      .querySelector(".llm-standalone-release-notes-panel")!
      .dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true }));
    await Zotero.Promise.delay(100);
    assert.isOk(notes(), "a click inside the window keeps it open");
    notes()!.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true }));
    await until(() => !notes(), "window closes on a click on the dimmed area");

    // Update available: icon only, with a tooltip.
    available = { version: "99.0.0" };
    // The next check is on a timer; the window reopens to run one now.
    await api.closeStandalone();
    await openStandalone();
    await until(
      () => button()!.dataset.state === "available",
      "update available state shows",
    );
    assert.equal(button()!.textContent!.trim(), "");
    assert.equal(button()!.title, "Update to v99.0.0");

    button()!.click();
    await until(() => Boolean(popover()), "confirm popover opens");
    assert.include(popover()!.textContent!, "Update to v99.0.0?");
    (
      popover()!.querySelector('[data-update-action="cancel"]') as HTMLElement
    ).click();
    await until(() => !popover(), "Not now closes the popover");
    assert.equal(installCalls, 0, "Not now does not install");

    button()!.click();
    await until(() => Boolean(popover()), "confirm popover opens again");
    (
      popover()!.querySelector('[data-update-action="confirm"]') as HTMLElement
    ).click();
    await until(
      () => button()!.dataset.state === "updating",
      "spinner state shows",
    );
    assert.equal(installCalls, 1);
    assert.equal(button()!.textContent!.trim(), "");
    assert.isTrue(button()!.disabled);

    // Just updated: an older stored version shows the badge until clicked.
    available = null;
    await api.closeStandalone();
    Zotero.Prefs.set(LAST_SEEN_PREF, "0.0.1", true);
    await openStandalone();
    await until(
      () => button()!.dataset.state === "updated",
      "updated badge shows",
    );
    assert.include(button()!.textContent!, `v${version}`);
    button()!.click();
    await until(
      () => Boolean(notes()?.textContent?.includes(NOTES_MARKER)),
      "release notes open from the updated badge",
    );
    assert.equal(button()!.dataset.state, "current");
    assert.equal(button()!.textContent!.trim(), `v${version}`);
    assert.equal(Zotero.Prefs.get(LAST_SEEN_PREF, true), version);
  });
});
