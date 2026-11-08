---
id: reorganize-library
description: Sort papers into folders or tags
version: 1
contexts: paper-set,library-corpus
activation: auto
---

## Sort papers into folders or tags

Place each paper from its metadata first: title, authors, year, venue, abstract and existing tags.
List them with `library_search` using the scope's filter (`collectionId` or `unfiled`) and `include:['abstract']`, paged with `limit` and `offset`, or with `library_retrieve` and `depth:'metadata'`.
Do not list them with a `zotero_script`: Zotero's own top-level item list also returns annotations and other items that cannot be filed.
Read further only for a paper its metadata cannot place, such as one without an abstract, or when the user's criterion lives in the body, such as the recording method used: then read that paper's relevant section with a targeted `paper_read`, not its full text, and never read every paper by default.

Before creating, moving or tagging anything, show the proposed grouping in the chat: each folder's or tag's name, its paper count, and two or three example titles.
Reuse an existing collection or tag that fits rather than creating a duplicate.
Ask once with `request_user_input` only when the user's intent is unclear; otherwise continue after the proposal, without asking again before each batch.

Declare the changes with `task_update` as one part: `expectedEffect:'mutation'`, `expectedCapability:'zotero.collections'` for folders or `'zotero.tags'` for tags, and `scope:true` when the turn's paper scope is exactly the papers to sort, or their `targetIds` otherwise.
Declare no read part for the survey: metadata and abstracts never complete a part that reads papers.

For folders, create each new folder with `library_update` `kind:'collection'` and `action:'create'`, with `parentCollectionId` for a subfolder.
Then move the papers in batches of a few dozen, one `library_update` call per batch: `kind:'collections'`, `action:'add'`, one `assignments` entry (`itemId`, `targetCollectionId`) per paper, and `mode:'move'` with `from` when the papers leave a folder.
For tags, add them in the same batches: `kind:'tags'`, `action:'add'`, one `assignments` entry (`itemId`, `tags`) per paper.
Give each paper one folder unless the user asked otherwise.
Do not repeat a batch the user declined, or papers it left untouched in a review; continue with the other batches.

Report from the receipts how many papers each folder or tag received, and which papers did not change and why.
