---
id: compare-papers
description: Compare selected papers or collection papers by theme, methodology, or findings
version: 7
contexts: paper-set,library-corpus
activation: auto
match: /\b(compare|contrast|difference|differ|similarities|similarity)\b.*\b(papers?|articles?|studies|works?)\b/i
match: /\b(papers?|articles?|studies)\b.*\b(compare|contrast|difference|differ|similarities|similarity)\b/i
match: /\bcomparative\s+(analysis|review|study)\b/i
match: /\bhow\s+(does|do|is|are)\b.*\bdiffer\b/i
match: /\bcompare\b.*\b(methods?|methodology|sections?|approach|results?|limitations?)\b/i
---

<!--
  SKILL: Compare Papers

  This skill activates when you ask to compare multiple papers
  (e.g., "compare these two papers", "what are the differences?").

  You can customize:
  - Comparison dimensions: change what aspects are compared
  - Reading depth: adjust how deeply each paper is read
  - Output format: modify the comparison structure

  Your changes are preserved across plugin updates.
  To reset to default, delete this file — it will be recreated on next restart.
-->

## Comparing Multiple Papers — targeted first when the dimension is known

Use Zotero paper tools as resources, not a ritual. Batch selected papers in `targets`.

A selected Zotero collection/folder is also a valid comparison corpus. In collection/library chat, never rely on the active-reader paper as an implicit target. If explicit paper targets are not already selected, first use `library_retrieve` scoped to the selected collection/library to map the comparison evidence, then call `paper_read` only with explicit `targets` when close reading is needed.
For bounded selected or collection-scoped comparison pools, overview is the answer style, not the read depth.
Prefer body-evidence coverage and the returned paper synthesis digest before writing the comparison.

- If the user names a comparison dimension such as methods, results, limitations, theory, data, or figures, start with one batched targeted read:
  `paper_read({ mode:'targeted', query:'methods methodology method section', targets:[...] })`
- If the corpus is a selected collection/folder and the dimension is known, prefer one scoped `library_retrieve({ query:'methods methodology method section', intent:'summarize', depth:'evidence' })` before selecting explicit paper targets for deeper comparison.
- For broad requests like "compare these papers" with no dimension, use bounded evidence coverage first: `library_retrieve({ query:'compare these papers', intent:'summarize', depth:'evidence' })` for collection/library chat, or the selected-paper evidence ledger when it is already supplied.
  Then synthesize from the paper digest and snippets.
- For method-section requests, do not call overview first unless the targeted result is clearly insufficient.
- Apply the system citation contract to paper-specific claims and any direct quotations.
  Keep the comparison readable and use only high-signal evidence that supports a concrete contrast.
- Stop after the evidence ledger covers the selected papers at the needed depth, or explicitly report the coverage frontier. Make follow-up `paper_read({ mode:'targeted', ... })` calls only for concrete missing dimensions or papers that the ledger marks as insufficient.
