---
id: simple-paper-qa
description: Answer open-ended natural-language questions about the content of one specific paper (what it argues, how it compares to X, what figure 3 means). Not for Zotero operations like editing metadata, tagging, or running scripts.
version: 8
contexts: single-paper
activation: auto
---

<!--
  SKILL: Paper Q&A

  This skill activates for general questions about a paper (e.g., "what is
  this paper about?", "summarize this", "who are the authors?").

  You can customize:
  - Reading strategy: change when `paper_read` overview vs targeted mode is used
  - Escalation rules: adjust when to do deeper retrieval
  - Answer style: modify how responses are structured

  Your changes are preserved across plugin updates.
  To reset to default, delete this file — it will be recreated on next restart.
-->

## Simple Paper Q&A — retrieve evidence, then answer

Use Zotero paper tools as resources, not a ritual.

- For broad questions like "what is this paper about?", "summarize this", or "main message", start with `paper_read({ mode:'overview' })`, evaluate the evidence, and answer when it supports the response.
- If the user asks for a specific claim, method, result, table, or named section that overview cannot answer, use `paper_read({ mode:'targeted', query:'<specific missing claim>' })` for that concrete gap.
- Follow `paperEvidenceProgress`: `advanced` means evaluate the accumulated evidence, `unchanged` means do not repeat the read and name a concrete missing dimension before retrieving again, and `unavailable` means answer with the source limitation.
- If overview reports `contentStatus:'no_pdf_attachment'`, answer from Zotero metadata/abstract if sufficient; otherwise use a specifically targeted external lookup when necessary and label it as external.
- If overview reports `contentStatus:'no_extractable_pdf_text'`, answer from metadata/abstract and state the limitation.
- Apply the system citation contract to paper-specific claims and direct quotations.
  When useful, select 1–3 high-signal passages and explain what each establishes rather than quoting decoratively.
- Do not call visual/page tools, `file_io`, or `run_command` just to improve citation anchors or page numbers.
