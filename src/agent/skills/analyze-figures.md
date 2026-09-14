---
id: analyze-figures
description: Analyze figures, tables, and diagrams from papers
version: 6
contexts: single-paper,visual-input
activation: auto
---

## Analyzing Figures and Tables

Use the figure labels, figure/table kind, supplemental selection, reading depth, and source boundary from the shared semantic intent.
This playbook does not select a task or destination from the wording of the request.

For a resolved figure selection, call `paper_read` in `figures` mode.
The host applies the frozen selection, reuses valid crops, or extracts source-PDF crops when required.
Use the returned paths, captions, confidence, page numbers, and provenance as evidence.
For a resolved table selection, read the table text and surrounding discussion through `paper_read` in `targeted` mode.
For rendered-page intent, use `visual` mode on the resolved pages.

Inspect the complete crop and caption before drawing conclusions about a panel.
Do not infer panel identity from image order.
A model without image capability must limit claims to the caption and surrounding text.
When crop extraction fails, preserve the textual evidence and report that the visual evidence is unavailable.
Do not substitute unrelated source images or invent image placeholders.
User-provided images remain separate evidence inputs.

## Requested persistence

Only the shared semantic result and concrete action contract determine whether the analysis is saved and where.
Finalize requested document material with its host-issued asset identities.
Use the resolved note or file operation to persist it; the host owns image import/export and byte verification.
Preserve finalized material and report any action failure separately.
