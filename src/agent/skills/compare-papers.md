---
id: compare-papers
description: Compare multiple papers by theme, methodology, or findings
version: 3
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

- If the user names a comparison dimension such as methods, results, limitations, theory, data, or figures, start with one batched targeted read:
  `paper_read({ mode:'targeted', query:'methods methodology method section', targets:[...] })`
- For broad requests like "compare these papers" with no dimension, call `paper_read({ mode:'overview', targets:[...] })` once, then answer or make one focused targeted call if a specific gap remains.
- For method-section requests, do not call overview first unless the targeted result is clearly insufficient.
- Do not call visual/page tools, `file_io`, or `run_command` just to improve citation anchors or page numbers. Use the provided `sourceLabel`; the UI can bind citations after rendering.
- Stop after the first useful batched result when it covers the selected papers. Make at most one follow-up `paper_read({ mode:'targeted', ... })` for a concrete missing dimension.
