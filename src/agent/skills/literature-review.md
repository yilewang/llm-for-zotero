---
id: literature-review
description: Structured scientific review with thematic synthesis and citations
version: 1
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

- **Papers already in context**: If the user has pinned or selected papers (visible in `selectedPaperContexts` or `fullTextPaperContexts`), use those directly. No discovery step needed.
- **Topic search**: If the user provides a topic or keywords, use `query_library(query:'<topic>')` to find matching papers in their library.
- **Collection**: If the user names a collection, use `zotero_script(mode:'read')` to iterate items in that collection.
- **Whole library**: If the user wants a review across their entire library, use `zotero_script(mode:'read')` to get all items (same pattern as `library-analysis`).

Cap the corpus at **15-20 papers**. If more match, select the most relevant based on title/abstract relevance to the topic. Use `read_library` to retrieve metadata (title, authors, year, abstract, publicationTitle) for all discovered papers.

### Phase 2 — Selective Deep Reading (2-5 tool calls)

Do **NOT** read every paper in full. Abstracts from Phase 1 are sufficient for most.

Deep-read only the **3-5 most relevant papers** to the review topic:

1. If MinerU cache is available: `file_io(read, '{mineruCacheDir}/full.md')` — best quality, gets full text with figures.
2. Otherwise: `read_paper` for structured metadata + abstract.
3. For targeted claims: `search_paper` with focused questions (e.g., "What methods were used?", "What were the key findings?").

Prioritize breadth over depth — it is better to include 15 papers with abstract-level understanding than 5 papers with full-text reads.

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

If key figures from deep-read papers would strengthen a thematic point, embed them: `![Figure caption](file:///{mineruCacheDir}/images/filename.png)`. Place figures within the thematic sections they relate to, not in a separate section.

### Citation rules

- Every factual claim must have an inline citation.
- Use `(Author, Year)` for single-author papers, `(Author & Author, Year)` for two, `(Author et al., Year)` for three or more.
- The citation label should match the Zotero item metadata (use `creators` and `date` fields).
- Do NOT invent citations or cite papers not in the user's library.

### After writing

- Ask the user if they want the review saved as a Zotero note: `edit_current_note(mode:'create', content:'...', target:'standalone')`.
- If saving, convert the markdown to the Zotero note HTML format.

### Key rules

- Budget: aim for **4-8 tool calls** total across all phases.
- Do NOT dump all paper content into context — use abstracts first, deep-read selectively.
- Do NOT produce a per-paper summary list — synthesize thematically.
- If the review covers >10 papers, prioritize breadth (abstracts) over depth (full reads).
- If fewer than 3 papers match the topic, tell the user and offer to search online with `search_literature_online`.
