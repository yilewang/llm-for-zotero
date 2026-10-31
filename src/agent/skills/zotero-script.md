---
id: zotero-script
description: Write a zotero_script that changes the library, including copying or moving items to another library
version: 1
contexts: any
activation: auto
---

## Zotero scripts

A script is the body of an async function (top-level `await` works) with two globals, `Zotero` and `env`.
`access:'library'` gives a confined Zotero: a read-only facade for `effect:'read'`, and for `effect:'write'` the item and collection API without `DB`, `Prefs`, `HTTP`, `File`, `Utilities`, `Attachments`, `Translate` and the other platform objects.
`access:'privileged'` gives the whole Zotero API except `Zotero.DB`, such as `Zotero.Attachments`, `Zotero.Tags`, `Zotero.Searches`, `Zotero.FullText`, `Zotero.Duplicates` or `Zotero.Translate.Export`; use it only when no semantic tool and no library script can do the job.
The script also has `atob`, `btoa`, `TextEncoder` and `TextDecoder`, and `fetch` with privileged access only.
`IOUtils` and `PathUtils` are not available; with privileged access, `await Zotero.File.getContentsAsync(path)` and `await Zotero.File.putContentsAsync(path, text)` read and write files, for example a result too large for one reply, which `file_io` then reads in pages.

### env

- `env.libraryID`: the active library; `env.access` and `env.effect` echo the call.
- `env.log(msg)`: progress lines only; the log is cut at 8000 characters. Return your data instead: the return value reaches you in full.
- `env.shouldStop()` and `env.remainingMs()`: in a loop over more than a few dozen items, return partial results once `env.shouldStop()` is true. The timeout cannot interrupt a running script, and undo cannot reverse changes it makes after the tool has returned.
- Write scripts only: `env.snapshot(item)` before you change an existing item, `env.recordCreatedItem(itemOrId)` after you save a new item, and `env.addInverse(data)` for a declarative inverse (JSON of kind `library_operations`, `note_html`, `file` or `preference`; functions are refused). A write script that calls none of the three is refused.

### Zotero API

- Items: `await Zotero.Items.getAll(env.libraryID, false, false, false)`, `Zotero.Items.get(id)` (an array of IDs gives an array of items).
- Type: `item.isRegularItem()`, `item.isNote()`, `item.isAttachment()`.
- Fields: `item.getField(name)`, `item.setField(name, value)`; creators: `item.getCreatorsJSON()`, `item.setCreators(array)`.
- Tags: `item.getTags()`, `item.addTag(name)`, `item.removeTag(name)`.
- Children: `item.getNotes()` and `item.getAttachments()` return IDs.
- Collections: `item.getCollections()`, `item.addToCollection(id)`, `item.removeFromCollection(id)`, `Zotero.Collections.getByLibrary(env.libraryID)`, `new Zotero.Collection()` with `libraryID` and `name`.
- Attachments: `att.attachmentLinkMode`, `att.attachmentContentType`, `att.attachmentFilename`, `await att.getFilePathAsync()`, `await att.fileExists()`, `await att.renameAttachmentFile(newName)`.
- Search: `const s = new Zotero.Search({ libraryID: env.libraryID }); s.addCondition(field, operator, value); const ids = await s.search();`.
- Save every changed item with `await item.saveTx()`.

### Undo

Undo of a write script reverses only what the script recorded:

- An item passed to `env.snapshot` returns to its snapshot: item type, fields, creators, tags, collections, parent item, trash state, and a note's HTML.
- An item passed to `env.recordCreatedItem` goes to the trash.
- Each `env.addInverse` entry is replayed.

Undo cannot reverse an erased item, a renamed or moved attachment file, a change to an item the script did not snapshot (the result lists those items in `uncoveredObservedIds`), or any effect of a privileged read script (`access:'privileged'` with `effect:'read'`), which the journal records as irreversible.

### Rules

- Trash, never erase: `env.snapshot(item); item.deleted = true; await item.saveTx();`. Do not call `erase()` or `eraseTx()`.
- Create and edit notes with `note_write`, not here. The one exception is `note.clone()` of an existing note in the copy recipe below.
- `Zotero.DB` is not available: raw SQL sends no change notifications, and undo cannot reverse it.

### Copy or move items to another library

Never call `item.moveToLibrary()`: it erases the original permanently, and it drops attachments it cannot move without telling you.
Run this recipe as one `access:'privileged'`, `effect:'write'` script, with the three constants set first.

```javascript
const sourceItemIds = [];
const targetLibraryID = 0;
const move = false;

const target = Zotero.Libraries.get(targetLibraryID);
if (!target || !target.editable)
  throw new Error("The target library is not editable.");
const LM = Zotero.Attachments;
const results = [];
for (const id of sourceItemIds) {
  if (env.shouldStop()) break;
  const item = Zotero.Items.get(id);
  if (!item || !item.isRegularItem()) {
    results.push({ id, error: "not a regular item" });
    continue;
  }
  const copy = item.clone(targetLibraryID);
  await copy.saveTx();
  env.recordCreatedItem(copy);
  const result = {
    id,
    copyId: copy.id,
    notes: [],
    attachments: [],
    skipped: [],
    trashed: false,
  };
  for (const note of Zotero.Items.get(item.getNotes())) {
    const noteCopy = note.clone(targetLibraryID);
    noteCopy.parentID = copy.id;
    await noteCopy.saveTx();
    env.recordCreatedItem(noteCopy);
    result.notes.push(noteCopy.id);
    if (note.getAttachments().length)
      result.skipped.push({
        id: note.id,
        title: note.getNoteTitle(),
        reason: "images embedded in this note were not copied",
      });
  }
  for (const att of Zotero.Items.get(item.getAttachments())) {
    const mode = att.attachmentLinkMode;
    const title = att.getField("title");
    const skip = (reason) => result.skipped.push({ id: att.id, title, reason });
    if (mode === LM.LINK_MODE_LINKED_URL) {
      const linkCopy = att.clone(targetLibraryID);
      linkCopy.parentID = copy.id;
      await linkCopy.saveTx();
      env.recordCreatedItem(linkCopy);
      result.attachments.push(linkCopy.id);
      continue;
    }
    if (mode === LM.LINK_MODE_LINKED_FILE && !target.allowsLinkedFiles) {
      skip("linked file: the target library does not allow linked files");
      continue;
    }
    if (!target.filesEditable) {
      skip("the target library does not allow files");
      continue;
    }
    const path = await att.getFilePathAsync();
    if (!path) {
      skip("the file is missing on this computer");
      continue;
    }
    const fileCopy =
      mode === LM.LINK_MODE_LINKED_FILE
        ? await LM.linkFromFile({ file: path, parentItemID: copy.id, title })
        : await LM.importFromFile({
            file: path,
            libraryID: targetLibraryID,
            parentItemID: copy.id,
            title,
          });
    env.recordCreatedItem(fileCopy);
    result.attachments.push(fileCopy.id);
  }
  const saved = Zotero.Items.get(copy.id);
  let verified =
    Boolean(saved) &&
    saved.libraryID === targetLibraryID &&
    saved.getNotes().length === result.notes.length &&
    saved.getAttachments().length === result.attachments.length;
  for (const attId of result.attachments) {
    const attCopy = Zotero.Items.get(attId);
    if (
      attCopy.attachmentLinkMode !== LM.LINK_MODE_LINKED_URL &&
      !(await attCopy.fileExists())
    )
      verified = false;
  }
  result.verified = verified;
  if (move && verified) {
    env.snapshot(item);
    item.deleted = true;
    await item.saveTx();
    result.trashed = true;
  }
  results.push(result);
}
return results;
```

The copy keeps the item's fields, creators and tags; it gets no collections and no related items, and it keeps no link to the original.
Child notes are copied unchanged; images embedded in a note are not, and the note is listed in `skipped`.
Stored files are imported into the target library, a web snapshot as its main file only; a linked file is linked again only if the target allows linked files (a group library does not); web links are copied.
PDF annotations are not copied.
Name every entry in `skipped` to the user with its reason.
For a move, the script trashes an original only after it verified the copy; anything skipped stays with the original in the trash.
Before a move, check with a read script which attachments would be skipped, and tell the user.
Undo of the script trashes every copy and restores each trashed original.
