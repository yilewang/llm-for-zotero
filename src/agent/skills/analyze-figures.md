---
id: analyze-figures
description: Analyze figures, tables, and diagrams from papers
version: 2
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

## Analyzing Figures and Tables — use MinerU cache, not raw PDF

When the user asks about a figure, table, or diagram in a paper, use the most efficient path to access it.

### When MinerU cache is available (mineruCacheDir shown in paper context)

This is the fast path — MinerU has already extracted figures as image files.

**Step 1 — Read the manifest:**
Use `file_io(read, '{mineruCacheDir}/manifest.json')` to see all sections with their figure lists, page numbers, and charStart/charEnd ranges.

**Step 2 — Find the figure in the manifest:**
The manifest lists figures per section with labels (e.g. "Fig. 1"), image paths, captions, and page numbers. Locate the target figure and note which section it belongs to.

**Step 3 — Read the section text:**
Use `file_io(read, '{mineruCacheDir}/full.md', offset=<charStart>, length=<charEnd - charStart>)` to read just the section containing the figure. This gives you the caption and surrounding discussion.

**Step 4 — Read the image directly:**
Use `file_io(read, '{mineruCacheDir}/<figure_path>')` to load the image. The path comes from the manifest's figure entry. Visual models (GPT-4o, Codex, Claude, Gemini) can see images natively — let the model analyze the figure visually.

**Step 5 — Combine image + text:**
Use both the image and the section text (caption + discussion) to give a complete answer.

### When MinerU cache is NOT available

Fall back to PDF tools:

1. `view_pdf_pages` with the figure label to find which page(s) contain it and get the page image for visual analysis
2. `search_paper` for surrounding discussion text

### Key rules

- **NEVER** use OCR tools, Python scripts, Swift, Tesseract, or shell commands to analyze images. Visual models see images directly.
- **NEVER** attempt to install packages (PIL, cv2, etc.) to process images.
- Prefer MinerU cache over raw PDF — it's faster and gives better quality.
- Always include the figure caption and surrounding context in your analysis, not just the image.
- For tables: the MinerU markdown usually contains the table as structured text — read that directly instead of rendering images.

### Saving figure analysis to notes

When the user asks to save your figure analysis to a note (e.g., "save it", "put that in a note", "create a note", "write to obsidian"), the Write Note skill handles the full workflow. Key rules:

- **Always embed the analyzed figure image** in the note — mandatory, not optional. A note explaining Figure 2 must show Figure 2.
- Place the image at the start of the relevant section, before the explanation text.
- If you analyzed multiple figures, embed all of them.
- If MinerU cache was not available (you used `view_pdf_pages` instead), the figure image cannot be embedded — mention this.
