/** Native save/readback seam for tool fixtures that previously stubbed the whole write. */
export function nativeNoteGateway<T extends Record<string, any>>(
  gateway: T,
): T {
  const snapshot = gateway.getActiveNoteSnapshot?.();
  if (!snapshot || gateway.getItem) return gateway;
  let memory = snapshot.html;
  let stored = memory;
  const note = {
    id: snapshot.noteId,
    key: `TEST${snapshot.noteId}`,
    libraryID: snapshot.libraryID,
    isNote: () => true,
    getNoteTitle: () => snapshot.title,
    getNote: () => memory,
    setNote: (html: string) => {
      memory = html;
    },
    reload: async () => {
      memory = stored;
    },
    saveTx: async () => {
      await gateway.onNativeSave?.({
        content: memory,
        expectedOriginalHtml: snapshot.html,
      });
      stored = memory;
      return true;
    },
  };
  return {
    ...gateway,
    getItem: (id: number) => (id === note.id ? note : null),
  };
}
