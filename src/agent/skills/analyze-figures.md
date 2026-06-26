---
id: analyze-figures
description: Analyze figures, tables, and diagrams from papers
version: 4
contexts: single-paper
activation: auto
match: /\b(figure|fig\.?|table|diagram|chart|graph|plot|schematic|illustration)\s*\d/i
match: /\banalyze?\b.*\b(figure|fig\.?|table|diagram|image|chart)\b/i
match: /\b(figure|fig\.?|table|diagram)\b.*\b(about|explain|describe|show|mean|depict)\b/i
match: /\b(what|how|why|can you)\b.*\b(figure|fig\.?|table|diagram|chart)\b/i
---

<!--
  SKILL: Analyze Figures

  This skill activates when you ask about a specific figure, table, or
  diagram in a paper (e.g., "explain Figure 2", "what does Table 1 show?").

  You can customize:
  - Analysis depth: change how the agent interprets visual content
  - MinerU vs PDF fallback: adjust which path is preferred
  - Note saving: modify how figure analyses are saved to notes

  Your changes are preserved across plugin updates.
  To reset to default, delete this file — it will be recreated on next restart.
-->

## Analyzing Figures and Tables — use extracted PDF crops

When the user asks about a figure, table, or diagram in a paper, use the most efficient path to access it.

### When MinerU cache is available (mineruCacheDir shown in paper context)

This is the semantic fast path — MinerU has already extracted labels, captions, page hints, and surrounding text.
The visual evidence should come from precise crops extracted from the source PDF.

**Step 1 — Extract the requested figure(s):**
Use `paper_read({ mode:'figures', query:'<figure/table label or all figures>' })` to obtain precise PDF crop paths, captions, page numbers, confidence, warnings, and provenance.

**Step 2 — Read the caption and surrounding text when needed:**
Use `manifest.json` and `full.md` section offsets only for captions and surrounding discussion.
Do not read MinerU image paths as the figure visual artifact.

**Step 3 — Interpret the extracted crop:**
For Figure 1, Fig. 1b, or any panel request, inspect the whole extracted figure crop plus the full caption/figure text before answering.
Panel suffixes and captions are hints only; do not assume image order proves panel identity.
If the user asks only for Figure 1b, focus the explanation on the requested panel evidence but do not imply one panel represents the whole Figure 1.

### When MinerU cache is NOT available

Figure extraction is not available.
Say that MinerU cache is required for figure extraction.
Use rendered PDF pages only if the user explicitly asks for raw page/layout inspection.

1. `paper_read({ mode:'targeted', query:'<figure/table label and surrounding discussion>' })` for captions/surrounding text
2. `paper_read({ mode:'visual', query:'<page/layout request>' })` only for explicit rendered page inspection

### Key rules

- **NEVER** use OCR tools, Python scripts, Swift, Tesseract, or shell commands to analyze images. Visual models see images directly.
- **NEVER** attempt to install packages (PIL, cv2, etc.) to process images.
- Use MinerU as the semantic index, not as the source of final figure images.
- Use extracted PDF crops for figure/image questions.
- Always include the figure caption and surrounding context in your analysis, not just the image.
- For compound figures, inspect the whole extracted figure crop and the complete figure text before drawing conclusions.
- Text-only models can use ordered paths, captions, section text, and page hints, but must not make unsupported visual claims.
- For tables: the MinerU markdown usually contains the table as structured text — read that directly instead of rendering images.

### Saving figure analysis to notes

When the user asks to save your figure analysis to a note (e.g., "save it", "put that in a note", "create a note", "write to obsidian"), the Write Note skill handles the full workflow. Key rules:

- **Always embed the analyzed figure image** in the note — mandatory, not optional. A note explaining Figure 2 must show Figure 2.
- Embed extracted PDF crop paths returned by `paper_read({ mode:'figures' })`.
- Do not embed MinerU source image paths.
- Place the image at the start of the relevant section, before the explanation text.
- If you analyzed multiple figures, embed all of them.
- If `paper_read({ mode:'figures' })` returns `no_figures`, `mineru_required`, `error`, zero figures, or no image artifact, do not call `note_write` for that figure note and do not create a text-only substitute.
- In that failure state, tell the user that no extracted PDF crop is available.
