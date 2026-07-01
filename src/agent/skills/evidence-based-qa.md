---
id: evidence-based-qa
description: Locate specific passages in selected papers or collections that support a given claim, returning quoted evidence with page and section citations. Not for general questions — use simple-paper-qa for those.
version: 4
contexts: single-paper,paper-set,library-corpus
activation: auto
match: /\b(what method|what approach|what technique|what model|how did they|how does it|what results?|what data|what dataset|what experiment|what metric|what performance|what accuracy|what baseline)\b/i
match: /\b(find|locate|where|which section|which page|quote|passage|excerpt|evidence|proof|support|mention)\b.*\b(papers?|articles?|studies|texts?|documents?)\b/i
match: /\b(does (this|the) paper|do the authors?)\b.*\b(mention|discuss|address|cover|report|describe|analyze|analyse|use|propose|introduce|present|evaluate|compare)\b/i
match: /\b(specific|particular|exact|precise)\b.*\b(result|finding|number|figure|statistic|claim|statement)\b/i
---

<!--
  SKILL: Evidence-Based Q&A

  This skill activates for specific questions about methods, results, or
  evidence in a paper (e.g., "what method did they use?", "find where
  they discuss accuracy").

  You can customize:
  - Retrieval strategy: change how evidence is gathered
  - Tool budget: adjust the number of allowed tool calls
  - Answer format: modify how evidence is presented

  Your changes are preserved across plugin updates.
  To reset to default, delete this file — it will be recreated on next restart.
-->

## Evidence-Based Paper Q&A — read then retrieve, then answer

When the user asks about specific methods, results, data, or needs to locate
a particular claim in a paper or selected collection, use a scoped evidence
approach.

### Recipe

**Step 1 — Gather context:**

- For one selected paper, call `paper_read({ mode:'overview' })` first to understand the paper's structure and main claims.
- For multiple selected papers, call `paper_read({ mode:'targeted', query:'<the specific question>', targets:[...] })` once with explicit `targets`.
- For a selected collection/folder or whole-library evidence question, do not rely on the active-reader paper as an implicit target. Call `library_retrieve({ query:'<the specific question>', intent:'verify', depth:'evidence' })` for exact presence/absence, `intent:'enumerate'` when the user asks which papers contain evidence, or `intent:'summarize'` when the user asks for commonality, themes, comparison, or overview across the scoped pool. Then use `paper_read` only with explicit `targets` if close reading is still needed.
- For bounded selected or collection-scoped multi-paper synthesis, prefer the returned body evidence, paper synthesis digest, and coverage frontier over stopping at metadata or abstracts.

**Step 2 — Targeted retrieval (only if Step 1 is insufficient):**
For a single-paper turn, call `paper_read({ mode:'targeted', query:'<the specific question>' })` with a focused question. For paper sets or collection-selected candidates, call `paper_read({ mode:'targeted', query:'<the specific question>', targets:[...] })` with explicit `targets`. This returns the most relevant passages ranked by relevance.

**Step 3 — Answer from the evidence.**
Do NOT make additional retrieval calls just to decorate the answer.
If bounded multi-paper coverage is still insufficient, make the specific follow-up read needed for the missing paper/dimension, or say what is missing rather than pretending.

Use citations and short quotes to make important paper-specific claims checkable, not to decorate every paragraph.
Cite concrete claims about methods, datasets, results, definitions, equations, limitations, and the authors' own interpretations.
Use short direct quotes when the exact wording matters or when a key point benefits from visible evidence.
For background explanation, synthesis, or your own interpretation, write clearly and cite only the specific paper claim it depends on.
`>` Markdown blockquotes are reserved only for direct original source text.
Verified quote anchors are available only for direct source quotes; use the exact anchor token only when exact wording is useful.
For interpretation, emphasis, examples, or opinion, use normal prose or fenced `text` blocks, never `>` blockquotes.
Do not append a standalone source label or citation-only final line after ordinary summary prose; source labels on their own line belong only after direct blockquotes when no quote anchor is available.
Use verified quote anchors only for direct article evidence; do not use them for publication metadata, DOI links, journal names, or source labels alone.
Paper titles, headings, author lists, journal names, DOI blocks, and source labels are metadata, not direct evidence.
Prefer a readable answer with traceable evidence over repetitive citations or low-information quotes.

If `paper_read` provides quote anchors like `[[quote:Q_x7a2]]`, use those
anchor tokens for direct quotes instead of copying the quote/sourceLabel manually.
Direct quote text must be copied verbatim in the original source language;
never translate quote text to match the user's language.
Put any translation outside the blockquote as explanation.
If no quote anchor is provided for a direct quote, put the provided
`sourceLabel` on the next non-empty line after the blockquote, before any
commentary.
Copy the Source label string exactly.
Do not invent author/year/page/section labels.
Do not write `[[source=...]]`, `section=...`, or `chunk=...`
metadata in the final answer.

### Budget

For one paper, aim for 1–2 tool calls total. `paper_read({ mode:'overview' })` often answers in one call.
For bounded multi-paper library chat, answer quality takes priority over a fixed call count; use `library_retrieve` coverage diagnostics to decide whether enough body evidence was read.
Only exceed the initial retrieval when the ledger or indexing state shows a concrete missing paper, method, result, or section.
