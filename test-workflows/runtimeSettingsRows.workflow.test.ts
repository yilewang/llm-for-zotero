import { assert } from "chai";

/**
 * Settings → Agent → Runtimes: Original Agent is always listed; the other
 * runtimes are listed once added, and Remove takes one off again.
 */
describe("workflow: runtime rows in Settings", function () {
  this.timeout(60000);

  const PREFIX = "extensions.zotero.llmforzotero";
  const PREFS = [
    "enableCodexAppServerMode",
    "enableClaudeCodeMode",
    "enableAntigravityMode",
    "addedRuntimeSystems",
  ];
  let saved: Record<string, unknown> = {};
  let prefsWin: any = null;

  const delay = (ms: number) => Zotero.Promise.delay(ms);
  const pref = (name: string) => Zotero.Prefs.get(`${PREFIX}.${name}`, true);

  async function until(check: () => boolean, message: () => string) {
    // Switching Antigravity on first prepares its storage.
    for (let i = 0; i < 300 && !check(); i++) await delay(50);
    assert.isTrue(check(), message());
  }

  async function openAgentSettings(): Promise<Document> {
    prefsWin = (
      Zotero.Utilities.Internal as unknown as {
        openPreferences: (pane: string) => Window;
      }
    ).openPreferences("llmforzotero-preferences");
    let doc: Document | null = null;
    for (let i = 0; i < 100; i++) {
      doc = prefsWin.document;
      if (doc?.querySelector?.("#llmforzotero-add-runtime")) break;
      await delay(100);
    }
    assert.isOk(
      doc?.querySelector("#llmforzotero-add-runtime"),
      "Settings rendered the Add runtime button",
    );
    return doc!;
  }

  const row = (doc: Document, name: string) =>
    doc.querySelector(`[data-llm-agent-row="${name}"]`) as HTMLElement;
  const listed = (doc: Document, name: string) => !row(doc, name).hidden;

  beforeEach(function () {
    saved = Object.fromEntries(PREFS.map((name) => [name, pref(name)]));
  });

  afterEach(async function () {
    prefsWin?.close();
    prefsWin = null;
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) Zotero.Prefs.clear(`${PREFIX}.${name}`, true);
      else Zotero.Prefs.set(`${PREFIX}.${name}`, value as never, true);
    }
    await delay(200);
  });

  it("lists only Original Agent at first, adds a runtime, and removes it", async function () {
    for (const name of PREFS.slice(0, 3))
      Zotero.Prefs.set(`${PREFIX}.${name}`, false, true);
    Zotero.Prefs.set(`${PREFIX}.addedRuntimeSystems`, "", true);
    const doc = await openAgentSettings();

    assert.isTrue(listed(doc, "original"), "Original Agent is listed");
    for (const name of ["codex", "claude", "antigravity"])
      assert.isFalse(listed(doc, name), `${name} is not listed yet`);

    (doc.querySelector("#llmforzotero-add-runtime") as HTMLElement).click();
    const menu = doc.querySelector(
      "#llmforzotero-add-runtime-menu",
    ) as HTMLElement;
    assert.isFalse(menu.hidden, "the add menu opens");
    const offered = Array.from(
      menu.querySelectorAll("[data-runtime-system]"),
    ).map((item) => (item as HTMLElement).dataset.runtimeSystem);
    assert.deepEqual(offered, ["codex", "claude_code", "antigravity"]);

    (
      menu.querySelector('[data-runtime-system="antigravity"]') as HTMLElement
    ).click();
    await until(
      () =>
        pref("enableAntigravityMode") === true &&
        listed(doc, "antigravity") &&
        pref("addedRuntimeSystems") === "antigravity",
      () =>
        `adding lists Antigravity and switches it on: ${JSON.stringify({
          enabled: pref("enableAntigravityMode"),
          added: pref("addedRuntimeSystems"),
          listed: listed(doc, "antigravity"),
          status: doc.querySelector("#llmforzotero-antigravity-status")
            ?.textContent,
        })}`,
    );
    assert.isTrue(menu.hidden, "the add menu closes");

    (
      row(doc, "antigravity").querySelector(
        ".llm-pref-row-remove",
      ) as HTMLElement
    ).click();
    await until(
      () =>
        pref("enableAntigravityMode") === false &&
        !listed(doc, "antigravity") &&
        pref("addedRuntimeSystems") === "",
      () =>
        `removing switches Antigravity off and unlists it: ${JSON.stringify({
          enabled: pref("enableAntigravityMode"),
          added: pref("addedRuntimeSystems"),
          listed: listed(doc, "antigravity"),
        })}`,
    );
  });

  it("keeps a runtime that was already switched on listed", async function () {
    Zotero.Prefs.set(`${PREFIX}.addedRuntimeSystems`, "", true);
    Zotero.Prefs.set(`${PREFIX}.enableCodexAppServerMode`, false, true);
    Zotero.Prefs.set(`${PREFIX}.enableAntigravityMode`, false, true);
    Zotero.Prefs.set(`${PREFIX}.enableClaudeCodeMode`, true, true);
    const doc = await openAgentSettings();
    assert.isTrue(listed(doc, "claude"), "Claude Code stays listed");
    assert.isFalse(listed(doc, "codex"));
    assert.equal(
      pref("addedRuntimeSystems"),
      "claude_code",
      "it joins the list, so switching it off later keeps its row",
    );
  });
});
