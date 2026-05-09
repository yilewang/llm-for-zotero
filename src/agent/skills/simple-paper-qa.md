---
id: simple-paper-qa
description: Answer open-ended natural-language questions about the content of one specific paper (what it argues, how it compares to X, what figure 3 means). Not for Zotero operations like editing metadata, tagging, or running scripts.
version: 2
match: /\b(what|who|when|where|which|tell me|explain)\b.*\b(about|paper|article|study|wrote|author|publish|year|journal|abstract|topic|field|contribution|finding|claim|conclusion|argue)\b/i
match: /\bsummar(y|ize|ise)\b/i
match: /\b(what is|what are|what does|what do)\b.*\b(this paper|this article|this study|the paper|the article)\b/i
match: /\b(main|key|central|primary|core)\b.*\b(finding|result|contribution|argument|claim|conclusion|point|idea|theme|message|takeaway)\b/i
match: /\b(tldr|tl;dr|gist|overview|brief)\b/i
---

<!--
  SKILL: Paper Q&A

  This skill activates for general questions about a paper (e.g., "what is
  this paper about?", "summarize this", "who are the authors?").

  You can customize:
  - Reading strategy: change when MinerU vs read_paper is used
  - Escalation rules: adjust when to do deeper retrieval
  - Answer style: modify how responses are structured

  Your changes are preserved across plugin updates.
  To reset to default, delete this file — it will be recreated on next restart.
-->

## Simple Paper Q&A — one read, then answer

When the user asks a general question about a paper (topic, authors, summary,
main findings, conclusions, field, contribution), you usually need only ONE
tool call, then answer.

### Recipe

**Step 1 — Read the paper once:**

- If `mineruCacheDir` is available: use `file_io({ action:'read', filePath:'{mineruCacheDir}/full.md' })`. This gives you the entire parsed paper including abstract, introduction, and conclusions.
- If no MinerU cache: use `read_paper` for the paper. This returns the abstract, authors, and introduction — enough for most general questions.

**Step 2 — Answer immediately.**
Do NOT call `search_paper`, `read_paper({ chunkIndexes:[...] })`, or any other tool unless the
front matter genuinely does not contain the answer. For questions like "what is
this about?", "who are the authors?", "summarize this paper", the front matter
or MinerU markdown is sufficient.

### When to escalate

If (and only if) the user asks about something specific that the front matter
does not cover (a particular experiment, a specific table, a named method, a
result in a specific section), then make ONE targeted `search_paper` call
and answer from that. Do not read the whole paper.
