---
id: import-to-library
description: Import cited papers into your Zotero library by DOI
version: 1
match: /\b(add|import|save|get)\b.*\b(to|into)\s*(my\s*)?(library|zotero|collection)\b/i
match: /\b(add|import|save)\b.*\breference\s*(#|no\.?|number)?\s*\d/i
match: /\breference\s*(#|no\.?|number)?\s*\d+\b.*\b(add|import|save|library)\b/i
match: /\bcited\b.*\b(add|import|save)\b/i
match: /\b(add|import)\b.*\b(this|these|that|those)\s*(paper|article|study|studies)\b/i
---

<!--
  SKILL: Import References

  This skill activates when you ask to add papers to your library
  (e.g., "import reference #5", "add this paper to my library").

  You can customize:
  - Resolution strategy: change how DOIs are looked up
  - Import behavior: adjust batch vs single import
  - Target collection: modify default import destination

  Your changes are preserved across plugin updates.
  To reset to default, delete this file — it will be recreated on next restart.
-->

## Importing papers into the Zotero library

When the user wants to add one or more papers to their library — whether from a cited reference, a pasted title, a DOI, or a description — resolve each paper's DOI and import it.

### Identify what the user gave you

| User provides                                                                             | How to resolve                                                                                          |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Reference number(s)** from a paper in context (e.g. "add ref 5, 12, 23")                | Read the References section from the paper (see below), extract each cited reference, then resolve DOIs |
| **Pasted title or citation text** (e.g. a line like "Smith et al. 2020, Neural Networks") | Extract the title, then resolve the DOI                                                                 |
| **DOI, arXiv ID, ISBN, or URL**                                                           | Pass directly to `import_identifiers` — no resolution needed                                            |
| **Vague description** (e.g. "that hippocampal replay paper by Buzsaki")                   | Use `search_literature_online(mode:'search', query:'...', author:'...')` to find it first               |

### Reading the references section from a paper

If the paper has MinerU cache (mineruCacheDir):

1. `file_io(read, '{mineruCacheDir}/manifest.json')` — find the "References" section's charStart/charEnd.
2. `file_io(read, '{mineruCacheDir}/full.md', offset=<charStart>, length=<charEnd - charStart>)` — read just the references.

If no MinerU cache, use `search_paper` with the reference number or `read_paper` and look for the references section.

### Resolving DOIs

For each paper that doesn't already have a DOI:

- Call `search_literature_online(mode:'metadata', title:'<exact title>')` to resolve the DOI from CrossRef/Semantic Scholar.
- If title match fails, try adding the first author: `search_literature_online(mode:'metadata', title:'<title>', author:'<first author>')`.

### Importing

- **Single paper:** `import_identifiers(identifiers:['<DOI>'])`
- **Multiple papers:** `import_identifiers(identifiers:['<DOI1>', '<DOI2>', ...'])` — batch them in one call.
- If the user specified a target collection, include `targetCollectionId`.

### Key rules

- For multiple references, batch-resolve all DOIs first, then import them in a single `import_identifiers` call.
- Show the user what you resolved before importing so they can verify.
- If DOI resolution fails for some papers, import the ones that succeeded and report which ones failed.
