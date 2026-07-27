---
id: analyze-figures
description: Analyze figures, tables, and diagrams from papers
version: 5
contexts: single-paper
activation: auto
match: /\b(figure|fig\.?|table|diagram|chart|graph|plot|schematic|illustration)\s*\d/i
match: /\banalyze?\b.*\b(figure|fig\.?|table|diagram|image|chart)\b/i
match: /\b(figure|fig\.?|table|diagram)\b.*\b(about|explain|describe|show|mean|depict)\b/i
match: /\b(what|how|why|can you)\b.*\b(figure|fig\.?|table|diagram|chart)\b/i
---

## Analyzing Figures and Tables

### Figures and diagrams

When MinerU cache is available, call:

`paper_read({ mode:'figures', query:'<figure label or all figures>' })`

This resolves the requested label against MinerU's figure blocks and returns
the original MinerU image path, caption, page number, mapping confidence, and
an image artifact. Use the returned `imagePath` and artifact directly.

Do not recrop the source PDF. Do not substitute rendered PDF pages, OCR,
shell image processing, or package installation for the mapped MinerU image.

Read the complete caption and surrounding discussion before answering. For a
panel request such as Figure 1b, inspect the whole mapped Figure 1 image and
focus the explanation on panel b without treating it as the whole figure.

If MinerU has no image mapped to the requested label, switch to text-only mode.
State that the MinerU image mapping is unavailable and base the
answer only on the caption, legend, and surrounding paper text.

### Tables

Use:

`paper_read({ mode:'targeted', query:'<table label and surrounding discussion>' })`

MinerU normally represents tables as structured text, so table questions do
not use the figure-image path.

### Key rules

- MinerU figure images are the visual source of truth for paper figures.
- `paper_read({ mode:'figures' })` is the interface for resolving labels to
  MinerU image artifacts.
- Always combine the image with its caption and surrounding context.
- Inspect the complete mapped image for compound figures.
- Do not make visual claims when no image artifact was returned.
- User-provided images can still be inspected normally.

### Saving figure analysis to notes

- Embed the MinerU `imagePath` returned by `paper_read({ mode:'figures' })`.
- Place the image before the corresponding explanation.
- If multiple figures were analyzed, embed each returned image.
- If no mapped image is available, write a text-only note and state that the
  explanation relies on the caption and surrounding text.
