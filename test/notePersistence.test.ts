import { assert } from "chai";
import {
  createFinalizedZoteroNote,
  persistVerifiedNoteHtml,
} from "../src/modules/contextPanel/notePersistence";

describe("finalized Zotero note persistence", function () {
  const globalScope = globalThis as typeof globalThis & {
    Zotero?: {
      Notifier?: {
        Queue: new () => FakeNotifierQueue;
        commit: (queue: FakeNotifierQueue) => Promise<void>;
      };
    };
  };
  const originalZotero = globalScope.Zotero;

  class FakeNotifierQueue {
    readonly events: Array<() => Promise<void>> = [];
  }

  class PersistentNote {
    id = 0;
    libraryID = 1;
    key = "NOTEKEY";
    itemTypeID = 1;
    parentID?: number;
    dateAdded = "";
    dateModified = "";
    version = 0;
    noteHtml = "";
    persistedHtml = "";
    saveCalls = 0;
    skipPersistOnSaveCall = 0;
    returnFalseOnSaveCall = 0;
    observer?: () => Promise<void>;

    setNote(html: string): boolean {
      if (html === this.noteHtml) return false;
      this.noteHtml = html;
      return true;
    }

    getNote(): string {
      return this.noteHtml;
    }

    isNote(): boolean {
      return true;
    }

    isAttachment(): boolean {
      return false;
    }

    getNoteTitle(): string {
      return "Created note";
    }

    getDisplayTitle(): string {
      return "Created note";
    }

    getField(fieldName: string): string {
      if (fieldName === "dateAdded") return this.dateAdded;
      if (fieldName === "dateModified") return this.dateModified;
      if (fieldName === "title") return "Created note";
      return "";
    }

    async saveTx(options?: {
      notifierQueue?: FakeNotifierQueue;
    }): Promise<number | boolean> {
      this.saveCalls += 1;
      const isNew = !this.id;
      if (isNew) this.id = 41;
      if (isNew) this.dateAdded = "2026-08-28 14:30:00";
      this.version += 1;
      this.dateModified = `2026-08-28 14:30:0${this.version}`;
      if (this.saveCalls !== this.skipPersistOnSaveCall) {
        this.persistedHtml = this.noteHtml;
      }
      if (isNew && options?.notifierQueue && this.observer) {
        options.notifierQueue.events.push(this.observer);
      }
      if (!isNew && this.saveCalls === this.returnFalseOnSaveCall) {
        return false;
      }
      return isNew ? this.id : true;
    }

    async reload(): Promise<void> {
      this.noteHtml = this.persistedHtml;
    }
  }

  beforeEach(function () {
    globalScope.Zotero = {
      ...(originalZotero || {}),
      Notifier: {
        Queue: FakeNotifierQueue,
        commit: async (queue) => {
          for (const event of queue.events) await event();
        },
      },
    };
  });

  afterEach(function () {
    globalScope.Zotero = originalZotero;
  });

  it("persists text once and notifies observers only after final content exists", async function () {
    const note = new PersistentNote();
    const observedHtml: string[] = [];
    note.observer = async () => {
      observedHtml.push(note.persistedHtml);
    };

    const result = await createFinalizedZoteroNote({
      note: note as unknown as Zotero.Item,
      initialHtml: "<p>Complete text note</p>",
    });

    assert.equal(result.noteId, 41);
    assert.deepEqual(result.createdNoteReceipt, {
      schemaVersion: 1,
      operation: "created",
      note: {
        itemId: 41,
        libraryID: 1,
        key: "NOTEKEY",
        noteKind: "standalone",
        dateAdded: "2026-08-28 14:30:00",
        dateModified: "2026-08-28 14:30:01",
        version: 1,
      },
    });
    assert.equal(note.saveCalls, 1);
    assert.equal(note.persistedHtml, "<p>Complete text note</p>");
    assert.deepEqual(observedHtml, ["<p>Complete text note</p>"]);
  });

  it("hides useful fallback and final asset writes behind one notification queue", async function () {
    const note = new PersistentNote();
    const observedHtml: string[] = [];
    note.observer = async () => {
      observedHtml.push(note.persistedHtml);
    };

    const result = await createFinalizedZoteroNote({
      note: note as unknown as Zotero.Item,
      initialHtml: "<p>Complete text without the image</p>",
      finalize: async () =>
        '<p>Complete text <img data-attachment-key="A1" /></p>',
    });

    assert.equal(note.saveCalls, 2);
    assert.equal(
      note.persistedHtml,
      '<p>Complete text <img data-attachment-key="A1" /></p>',
    );
    assert.equal(
      result.createdNoteReceipt?.note.dateModified,
      "2026-08-28 14:30:02",
    );
    assert.deepEqual(observedHtml, [
      '<p>Complete text <img data-attachment-key="A1" /></p>',
    ]);
  });

  it("supplies authoritative dateAdded to final rendering without embedding dateModified", async function () {
    const note = new PersistentNote();
    let receivedDateAdded = "";

    const result = await createFinalizedZoteroNote({
      note: note as unknown as Zotero.Item,
      initialHtml: "<p>Useful initial note</p>",
      finalize: async ({ createdNoteMetadata }) => {
        receivedDateAdded = createdNoteMetadata?.system?.dateAdded || "";
        return `<p>Created ${receivedDateAdded}</p>`;
      },
    });

    assert.equal(receivedDateAdded, "2026-08-28 14:30:00");
    assert.equal(note.persistedHtml, "<p>Created 2026-08-28 14:30:00</p>");
    assert.notInclude(
      note.persistedHtml,
      result.createdNoteReceipt?.note.dateModified || "not-present",
    );
  });

  it("keeps the note when dateAdded is unavailable and omits the receipt", async function () {
    class MissingMetadataNote extends PersistentNote {
      getField(fieldName: string): string {
        if (fieldName === "dateAdded") return "";
        return super.getField(fieldName);
      }

      async saveTx(options?: {
        notifierQueue?: FakeNotifierQueue;
      }): Promise<number | boolean> {
        const result = await super.saveTx(options);
        this.dateAdded = "";
        return result;
      }
    }
    const note = new MissingMetadataNote();

    const result = await createFinalizedZoteroNote({
      note: note as unknown as Zotero.Item,
      initialHtml: "<p>Useful note without metadata</p>",
    });

    assert.equal(note.persistedHtml, "<p>Useful note without metadata</p>");
    assert.isUndefined(result.createdNoteReceipt);
    assert.include(
      result.warnings,
      "Authoritative Zotero dateAdded was unavailable for the created note",
    );
  });

  it("detects a silent lost final write and retries after a forced reload", async function () {
    const note = new PersistentNote();
    note.skipPersistOnSaveCall = 2;

    await createFinalizedZoteroNote({
      note: note as unknown as Zotero.Item,
      initialHtml: "<p>Text fallback</p>",
      finalize: async () => "<p>Final note with image</p>",
    });

    assert.equal(note.saveCalls, 3);
    assert.equal(note.persistedHtml, "<p>Final note with image</p>");
  });

  it("treats a false save result as unverified when reload is unavailable", async function () {
    const note = new PersistentNote();
    note.skipPersistOnSaveCall = 2;
    note.returnFalseOnSaveCall = 2;
    (note as PersistentNote & { reload?: undefined }).reload = undefined;

    await createFinalizedZoteroNote({
      note: note as unknown as Zotero.Item,
      initialHtml: "<p>Text fallback</p>",
      finalize: async () => "<p>Final note with image</p>",
    });

    assert.equal(note.saveCalls, 3);
    assert.equal(note.persistedHtml, "<p>Final note with image</p>");
  });

  it("recovers a silently lost append write by reloading and retrying", async function () {
    // The #327 failure class: saveTx neither throws nor persists. Appends to
    // an existing note must verify-and-retry exactly like note creation does.
    const note = new PersistentNote();
    note.id = 41;
    note.noteHtml = "<p>Old</p>";
    note.persistedHtml = "<p>Old</p>";
    note.skipPersistOnSaveCall = 1;

    await persistVerifiedNoteHtml(
      note as unknown as Zotero.Item,
      "<p>Old</p><p>New answer</p>",
    );

    assert.equal(note.saveCalls, 2);
    assert.equal(note.persistedHtml, "<p>Old</p><p>New answer</p>");
  });

  it("throws instead of reporting success when the write never persists", async function () {
    class LossyNote extends PersistentNote {
      async saveTx(): Promise<number | boolean> {
        this.saveCalls += 1;
        return true;
      }
    }
    const note = new LossyNote();
    note.id = 41;
    note.noteHtml = "<p>Old</p>";
    note.persistedHtml = "<p>Old</p>";

    let thrown: unknown;
    try {
      await persistVerifiedNoteHtml(
        note as unknown as Zotero.Item,
        "<p>Old</p><p>New answer</p>",
      );
    } catch (error) {
      thrown = error;
    }

    assert.instanceOf(thrown, Error);
    assert.match((thrown as Error).message, /did not persist/);
  });

  it("keeps useful text and reports a warning when asset finalization throws", async function () {
    const note = new PersistentNote();

    const result = await createFinalizedZoteroNote({
      note: note as unknown as Zotero.Item,
      initialHtml: "<p>Useful text fallback</p>",
      finalize: async () => {
        throw new Error("image import failed");
      },
      log: () => {
        throw new Error("diagnostic logger failed");
      },
    });

    assert.equal(note.saveCalls, 1);
    assert.equal(note.persistedHtml, "<p>Useful text fallback</p>");
    assert.deepEqual(result.warnings, [
      "Note asset finalization failed: image import failed",
    ]);
  });
});
