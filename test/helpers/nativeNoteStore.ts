/** In-memory native save/readback fixture; effects and persisted objects are observable. */
export function installNativeNoteStore(
  options: { startId?: number; onSave?: (note: any) => void } = {},
) {
  const original = globalThis.Zotero;
  const notes = new Map<number, any>();
  let next = options.startId || 100;
  class Note {
    id = 0;
    key = "";
    libraryID = 1;
    parentID?: number;
    deleted = false;
    html = "";
    stored = "";
    collections: number[] = [];
    dateAdded = "2026-09-07 12:00:00";
    dateModified = this.dateAdded;
    isNote() {
      return true;
    }
    isAttachment() {
      return false;
    }
    getNoteTitle() {
      return "Test note";
    }
    getDisplayTitle() {
      return this.getNoteTitle();
    }
    getField(key: string) {
      return key === "dateAdded"
        ? this.dateAdded
        : key === "dateModified"
          ? this.dateModified
          : "";
    }
    getNote() {
      return this.html;
    }
    setNote(html: string) {
      this.html = html;
    }
    addToCollection(id: number) {
      this.collections.push(id);
    }
    getCollections() {
      return this.collections;
    }
    async loadPrimaryData() {}
    async reload() {
      this.html = this.stored;
    }
    async saveTx() {
      this.id ||= next++;
      this.stored = this.html;
      notes.set(this.id, this);
      options.onSave?.(this);
      return this.id;
    }
  }
  globalThis.Zotero = {
    ...original,
    Item: Note,
    Utilities: {
      ...original?.Utilities,
      generateObjectKey: () => `TEST${next}`,
    },
    Items: {
      get: (id: number) => notes.get(id) || null,
      getByLibraryAndKey: (libraryID: number, key: string) =>
        [...notes.values()].find(
          (n) => n.libraryID === libraryID && n.key === key,
        ) || null,
    },
  } as never;
  return {
    notes,
    restore: () => {
      globalThis.Zotero = original;
    },
  };
}
