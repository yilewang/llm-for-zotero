---
id: analyze-figures
match: /\b(figure|fig\.?|table|diagram|chart|graph|plot|schematic|illustration)\s*\d/i
match: /\banalyze?\b.*\b(figure|fig\.?|table|diagram|image|chart)\b/i
match: /\b(figure|fig\.?|table|diagram)\b.*\b(about|explain|describe|show|mean|depict)\b/i
match: /\b(what|how|why|can you)\b.*\b(figure|fig\.?|table|diagram|chart)\b/i
---

## Analyzing Figures and Tables — use MinerU cache, not raw PDF

When the user asks about a figure, table, or diagram in a paper, use the most efficient path to access it.

### When MinerU cache is available (mineruCacheDir shown in paper context)

This is the fast path — MinerU has already extracted figures as image files.

**Step 1 — Read the markdown:**
Use `file_io(read, '{mineruCacheDir}/full.md')` to get the full parsed content. Search for the figure reference (e.g. `Fig 1`, `Figure 1`, `Table 2`).

**Step 2 — Find the image file:**
In the markdown, figure images appear as `![](images/hashname.png)` or `![](images/hashname.jpg)`. The absolute path is `{mineruCacheDir}/images/hashname.png`.

**Step 3 — Read the image directly:**
Use `inspect_pdf(operation:'read_attachment', target:{contextItemId:<id>})` with the image attachment, OR use `file_io(read, '{mineruCacheDir}/images/hashname.png')` to access the image. Visual models (GPT-4o, Codex, Claude, Gemini) can see images natively — let the model analyze the figure visually.

**Step 4 — Combine with caption text:**
The markdown around the image reference contains the figure caption and surrounding discussion. Use both the image and the text to give a complete answer.

### When MinerU cache is NOT available

Fall back to `inspect_pdf`:
1. `search_pages` with the figure label to find which page(s) contain it
2. `render_pages` to get the page image for visual analysis
3. `retrieve_evidence` for surrounding discussion text

### Key rules
- **NEVER** use OCR tools, Python scripts, Swift, Tesseract, or shell commands to analyze images. Visual models see images directly.
- **NEVER** attempt to install packages (PIL, cv2, etc.) to process images.
- Prefer MinerU cache over raw PDF — it's faster and gives better quality.
- Always include the figure caption and surrounding context in your analysis, not just the image.
- For tables: the MinerU markdown usually contains the table as structured text — read that directly instead of rendering images.
