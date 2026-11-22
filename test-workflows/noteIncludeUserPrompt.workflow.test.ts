import "./hostSurfaceBootstrap";
import { assert } from "chai";
import { config } from "../package.json";
import {
  createNoteFromAssistantText,
  createStandaloneNoteFromAssistantText,
} from "../src/modules/contextPanel/notes";

// The key Settings › Customization writes.
const PREF = `${config.prefsPrefix}.noteIncludeUserPrompt`;
const PROMPT = "Extract the participants and findings under fixed headings.";
const ANSWER = "# Participants\n\nTwelve graduate students.";

async function waitFor(
  check: () => boolean,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await Zotero.Promise.delay(50);
  }
  assert.isTrue(check(), message);
}

async function openPreferences(): Promise<Window> {
  const win = (Zotero.Utilities.Internal as any).openPreferences(
    `${config.addonRef}-preferences`,
  ) as Window;
  // The library index status is filled by the settings script, so once it
  // shows, the script has also set up the checkboxes.
  await waitFor(
    () =>
      Boolean(
        win.document
          ?.querySelector(`#${config.addonRef}-library-text-index-status`)
          ?.textContent?.trim(),
      ),
    20000,
    "the settings script ran",
  );
  return win;
}

async function closePreferences(win: Window): Promise<void> {
  const components = (globalThis as any).Components;
  const mediator = components.classes[
    "@mozilla.org/appshell/window-mediator;1"
  ].getService(components.interfaces.nsIWindowMediator);
  win.close();
  await waitFor(
    () =>
      win.closed && !mediator.getEnumerator("zotero:pref").hasMoreElements(),
    10000,
    "preferences close",
  );
}

describe("workflow: saving a response as a note can leave out the prompt", function () {
  this.timeout(60000);

  let parent: Zotero.Item | null = null;
  const created: number[] = [];

  beforeEach(async function () {
    parent = new Zotero.Item("journalArticle");
    parent.libraryID = Zotero.Libraries.userLibraryID;
    parent.setField("title", "Prompt setting destination");
    await parent.saveTx();
  });

  afterEach(async function () {
    Zotero.Prefs.clear(PREF, true);
    for (const id of created.splice(0)) {
      const note = Zotero.Items.get(id);
      if (note) await note.eraseTx();
    }
    if (parent) {
      await parent.eraseTx();
      parent = null;
    }
  });

  function noteHtml(noteId: number | undefined): string {
    assert.isOk(noteId, "note id");
    created.push(noteId!);
    const note = Zotero.Items.get(noteId!);
    assert.isOk(note, "note should exist");
    return (note as Zotero.Item).getNote();
  }

  it("includes the prompt by default", async function () {
    assert.equal(Zotero.Prefs.get(PREF, true), true);
    const result = await createNoteFromAssistantText(
      parent!,
      ANSWER,
      "workflow-model",
      undefined,
      { queryText: PROMPT },
    );
    const html = noteHtml(result.noteId);
    assert.include(html, PROMPT);
    assert.include(html, "Twelve graduate students.");
  });

  it("saves only the response to an item note when the setting is off", async function () {
    Zotero.Prefs.set(PREF, false, true);
    const result = await createNoteFromAssistantText(
      parent!,
      ANSWER,
      "workflow-model",
      undefined,
      { queryText: PROMPT },
    );
    const html = noteHtml(result.noteId);
    assert.notInclude(html, PROMPT);
    assert.notInclude(html, "User query:");
    assert.include(html, "Twelve graduate students.");
    // The response leads the note, so Zotero titles it from the response.
    assert.equal(
      (Zotero.Items.get(result.noteId!) as Zotero.Item).getNoteTitle(),
      "Participants",
    );
  });

  it("saves only the response to a standalone note when the setting is off", async function () {
    Zotero.Prefs.set(PREF, false, true);
    const result = await createStandaloneNoteFromAssistantText(
      Zotero.Libraries.userLibraryID,
      ANSWER,
      "workflow-model",
      undefined,
      undefined,
      undefined,
      PROMPT,
    );
    const html = noteHtml(result.noteId);
    assert.notInclude(html, PROMPT);
    assert.include(html, "Twelve graduate students.");
  });

  it("the Customization tab's checkbox turns the setting off and on", async function () {
    const win = await openPreferences();
    try {
      const panel = win.document.querySelector(
        `#${config.addonRef}-pref-panel-customization`,
      ) as HTMLElement;
      const box = panel.querySelector(
        `#${config.addonRef}-note-include-user-prompt`,
      ) as HTMLInputElement | null;
      assert.isOk(box, "the checkbox sits in the Customization tab");
      assert.isTrue(box!.checked, "on by default");
      box!.click();
      assert.equal(Zotero.Prefs.get(PREF, true), false);
      box!.click();
      assert.equal(Zotero.Prefs.get(PREF, true), true);
    } finally {
      await closePreferences(win);
    }
  });
});
