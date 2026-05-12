---
id: simple-paper-qa
description: Answer open-ended natural-language questions about the content of one specific paper (what it argues, how it compares to X, what figure 3 means). Not for Zotero operations like editing metadata, tagging, or running scripts.
version: 5
match: /\b(what|who|when|where|which|tell me|explain)\b.*\b(about|paper|article|study|wrote|author|publish|year|journal|abstract|topic|field|contribution|finding|claim|conclusion|argue)\b/i
match: /\bsummar(y|ize|ise)\b/i
match: /\b(what is|what are|what does|what do)\b.*\b(this paper|this article|this study|the paper|the article)\b/i
match: /\b(understand|explain|walk me through|help me understand)\b.*\b(paper|ppaer|article|study)\b/i
match: /\b(main|key|central|primary|core)\b.*\b(finding|result|contribution|argument|claim|conclusion|point|idea|theme|message|takeaway)\b/i
match: /\b(tldr|tl;dr|gist|overview|brief)\b/i
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

## Simple Paper Q&A — one read, then answer

Use Zotero paper tools as resources, not a ritual.

- For broad questions like "what is this paper about?", "summarize this", or "main message", call `paper_read({ mode:'overview' })` once, then answer.
- If the user asks for a specific claim, method, result, table, or named section that overview cannot answer, make one focused `paper_read({ mode:'targeted', query:'<specific missing claim>' })` call.
- If overview reports `contentStatus:'no_pdf_attachment'`, answer from Zotero metadata/abstract if sufficient; otherwise one external lookup is allowed and must be labeled as external.
- If overview reports `contentStatus:'no_extractable_pdf_text'`, answer from metadata/abstract and state the limitation.
- When `paper_read` returns exact passages, include 1-3 short blockquotes from those passages when useful for grounding the explanation.
- Do not call visual/page tools, `file_io`, or `run_command` just to improve citation anchors or page numbers. Use the provided `sourceLabel`; the UI can bind citations after rendering.
