---
id: compare-papers
description: Compare multiple papers by theme, methodology, or findings
version: 1
match: /\b(compare|contrast|difference|differ|similarities|similarity)\b.*\b(papers?|articles?|studies|works?)\b/i
match: /\b(papers?|articles?|studies)\b.*\b(compare|contrast|difference|differ|similarities|similarity)\b/i
match: /\bcomparative\s+(analysis|review|study)\b/i
match: /\bhow\s+(does|do|is|are)\b.*\bdiffer\b/i
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

## Comparing Multiple Papers — use targeted reading, not full text

When the user asks to compare two or more papers, do NOT read entire paper contents into context. Full-text reads consume thousands of tokens per paper and can overflow the context window before you synthesize an answer.

### Strategy

**Step 1 — Batch front matter (abstracts + intros):**
Call `read_paper` with a `targets` array listing all papers to compare (up to 6). This returns ~500 tokens per paper in one call, giving you enough to understand each paper's scope, claims, and approach.

**Step 2 — Targeted evidence retrieval:**
Call `search_paper` with a focused question about the comparison dimension the user cares about (e.g. "What methods does this paper use?", "What are the main results?"). This returns the most relevant passages across all papers, globally ranked and deduplicated (~1500 tokens total).

**Step 3 — Deeper follow-up (only if needed):**
If the user asks about a specific aspect not covered by the retrieved evidence, make another `search_paper` call with a more specific question. Avoid `read_paper(chunkIndexes:[...])` unless the user asks for a specific section.

### MinerU cache optimization

Before reading PDFs, check if papers have MinerU cache available (visible in `read_library` results as `mineruCacheDir`). When available, prefer reading `file_io(read, '{mineruCacheDir}/full.md')` — this gives high-quality structured markdown with preserved equations and figures, and is faster than `read_paper`.

### Key rules

- ALWAYS batch papers in the `targets` array — do not call `read_paper` separately for each paper.
- Use `read_paper` first (structured overview), then `search_paper` (focused detail). This two-step approach keeps context small.
- Do NOT use `read_paper(chunkIndexes:[...])` or read full MinerU files for all papers at once — read targeted sections only.
- For 2-3 papers, the total context cost should be ~2000-3000 tokens. For 4-6 papers, ~3000-5000 tokens.
- Synthesize comparisons from the retrieved excerpts. If something is missing, make one more targeted retrieval — don't read everything "just in case".
