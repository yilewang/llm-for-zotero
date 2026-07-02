---
id: literature-review
description: Structured scientific review with thematic synthesis and citations
version: 3
contexts: paper-set,library-corpus
activation: auto
match: /\b(literature review|lit review|review of (the )?literature)\b/i
match: /\b(conduct|write|create|generate|draft)\b.*\b(review|synthesis|survey)\b.*\b(on|about|regarding|of)\b/i
match: /\bconduct a literature review\b/i
match: /\b(review|synthesize|survey)\b.*\b(research|papers?|studies|findings?|literature)\b/i
---

<!--
  SKILL: Literature Review

  This skill activates when you ask for a literature review or synthesis
  (e.g., "conduct a literature review on X", "synthesize the research").

  You can customize:
  - Discovery phase: change how papers are found and selected
  - Review structure: modify sections (intro, themes, gaps, conclusion)
  - Citation format: adjust citation style
  - Depth vs breadth: change how many papers are deep-read vs skimmed

  Your changes are preserved across plugin updates.
  To reset to default, delete this file — it will be recreated on next restart.
-->

## Literature Review — structured scientific review workflow

When the user asks for a literature review, follow this three-phase workflow. The goal is a well-structured scientific review with inline citations, thematic synthesis, and identified research gaps.

### Phase 1 — Paper Discovery (1-2 tool calls)

Identify the corpus of papers to review:

- **Papers already in context**: If the user has pinned or selected papers (visible in `selectedPaperContexts` or `fullTextPaperContexts`), use those directly. No discovery step needed. Treat a selected finite corpus as the user's requested evidence pool, not as a sample to skim.
- **Topic search**: If the user provides a topic or keywords and wants evidence from their Zotero library, use `library_retrieve({ query:'<topic>', queryVariants:[...], intent:'enumerate', depth:'metadata'|'evidence' })` to search metadata/abstracts/indexed text broadly when translation, acronyms, notation variants, or terminology equivalents would improve recall. Use `intent:'summarize', depth:'evidence'` for method or theme taxonomies.
- **Collection**: If the user names a collection, use `library_search({ entity:'collections', mode:'search', text:'<collection name>' })` to resolve it, then `library_retrieve({ scope:{ collectionIds:[<collectionId>] }, query:'<review topic>', queryVariants:[...], intent:'enumerate', depth:'metadata'|'evidence' })` when variants would help. Use `intent:'summarize'` for collection-grounded taxonomies.
- **Whole library**: If the user wants a review across their entire library, use `zotero_script({ mode:'read', description:'Summarize candidate papers for a literature review', script:'...' })` to aggregate candidates in Zotero's runtime (same pattern as `library-analysis`).

For newly discovered corpora, cap the review set at **15-20 papers** unless the user explicitly asks for exhaustive coverage. If more match, select the most relevant based on title/abstract relevance to the topic. Use `library_read` to retrieve metadata (title, authors, year, abstract, publicationTitle) for all discovered papers.
Do not apply this cap to papers the user already selected or pinned.

### Phase 2 — Selective Deep Reading (2-5 tool calls)

For selected or pinned corpora up to roughly 25 papers, prefer bounded evidence coverage across every readable paper before writing the synthesis.
Use `library_retrieve({ query:'<review focus>', intent:'summarize', depth:'evidence' })` or the selected-paper evidence ledger so the answer is grounded in body snippets and the paper synthesis digest, not just abstracts.

For newly discovered or large corpora, deep-read the most relevant papers and use the `library_retrieve` frontier to report what remains sampled.
If `library_retrieve` already returned good evidence snippets, use those before calling `paper_read`.

1. Use `paper_read({ mode:'overview', targets:[...] })` for selected papers.
2. For targeted claims: `paper_read({ mode:'targeted', query:'...', targets:[...] })` with focused questions (e.g., "What methods were used?", "What were the key findings?").
3. Use `paper_read({ mode:'figures', query:'...' })` only when figures are directly relevant; reserve `mode:'visual'` for explicit page/layout inspection.

For bounded selected corpora, prioritize body-evidence coverage over shallow breadth.
For large discovered corpora, use staged breadth first and report the frontier before making exhaustive claims.

When deep-reading papers with MinerU cache, note any key figures (result plots, comparison tables, architecture diagrams). Consider including select figures in the final review when they illustrate important findings that are hard to convey with text alone.

### Phase 3 — Synthesis and Writing

Write the review directly in the chat response. Use this structure:

1. **Introduction** (1-2 paragraphs)
   - State the review topic and its significance
   - Describe the scope: how many papers, what time range, what databases/collections

2. **Thematic Sections** (2-4 sections)
   - Group papers by theme, methodology, or approach — **never** list papers one by one
   - Each section should synthesize findings across multiple papers
   - Use inline citations: `(Author, Year)` format, e.g., `(Smith et al., 2023)`
   - Highlight agreements, contradictions, and methodological differences

3. **Research Gaps and Future Directions** (1 paragraph)
   - Identify what is missing from the reviewed literature
   - Suggest directions for future research

4. **Conclusion** (1 paragraph)
   - Summarize the key takeaways

5. **References**
   - List all cited papers in alphabetical order
   - Format: `Author(s). (Year). Title. *Journal*, Volume(Issue), Pages.`

If key figures from deep-read papers would strengthen a thematic point, first call `paper_read({ mode:'figures', query:'<figure request>' })` and embed the extracted PDF crop paths it returns.
Treat `paper_read({ mode:'figures' })` as the authority for figure crop cache reuse/regeneration.
Use its returned crop paths/artifacts as-is and do not inspect or validate `figure_crops` metadata before analysis or writing.
Place figures within the thematic sections they relate to, not in a separate section.
Do not embed MinerU source image paths.

### Citation rules

- Use citations and short quotes to make important paper-specific claims checkable, not to decorate every paragraph.
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
- Use `(Author, Year)` for single-author papers, `(Author & Author, Year)` for two, `(Author et al., Year)` for three or more.
- The citation label should match the Zotero item metadata (use `creators` and `date` fields).
- Do NOT invent citations or cite papers not in the user's library.
- If a deep-read passage provides a quote anchor like `[[quote:Q_x7a2]]`, use that anchor token for the direct quote.
  Direct quote text must be copied verbatim in the original source language; never translate quote text to match the user's language.
  Put any translation outside the blockquote as explanation.
  If no quote anchor is provided, put the source label on the next non-empty line after the blockquote.
- Copy the Source label string exactly.
- Do not invent author/year/page/section labels.
- Do not write `[[source=...]]`, `section=...`, or `chunk=...` metadata in the final answer.

### After writing

- Ask the user if they want the review saved as a Zotero note: `note_write({ mode:'create', content:'...', target:'standalone' })`.
- If saving, convert the markdown to the Zotero note HTML format.

### Key rules

- Budget: prefer one `library_retrieve` call over many `paper_read` calls for broad collection/library search, but do not enforce a fixed call count when a bounded selected corpus needs deeper evidence coverage.
- Preserve coverage wording from `library_retrieve`: sampled snippets support evidence summaries, but only complete metadata/indexed/searchable-text coverage can support exhaustive folder-level claims. Use `paperMatches` before manually inferring from snippets.
- Do NOT dump all paper content into context. Use the paper synthesis digest, body snippets, and coverage frontier as the working evidence layer.
- Do NOT produce a per-paper summary list — synthesize thematically.
- If a discovered review covers >25 papers, stage the work and report the frontier instead of pretending every paper was deeply read.
- If fewer than 3 papers match the topic, tell the user and offer to search online with `literature_search`.
