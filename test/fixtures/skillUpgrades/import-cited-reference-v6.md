---
id: import-to-library
description: Import cited papers into your Zotero library by DOI
version: 6
contexts: any
activation: auto
---

## Import references

Resolve the requested papers and destination before calling `library_import`.
For numbered references, inspect the source paper's bibliography with `paper_read`; a reference number is meaningful only within that paper.
For a title or citation, use `literature_search` metadata lookup and check title, authors, year, and version before accepting the match.
For an ambiguous description, search for candidates and clarify if multiple matches remain plausible.

Pass supplied DOI, arXiv ID, or ISBN directly to `library_import({ kind:'identifiers', identifiers:[...] })`.
Never pass a page URL: open it with `web_read` if needed, take its DOI or arXiv ID, and import that identifier.
Resolve missing identifiers, batch the resolved papers, and include `targetCollectionId` when the user specified a collection.
Follow the host's existing action policy without adding a separate approval ritual.
Report verified imports, duplicates, unresolved references, and failures from the tool results; do not replace a failed match with a different paper.
