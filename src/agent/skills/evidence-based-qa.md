---
id: evidence-based-qa
description: Locate specific passages in one or more papers that support a given claim, returning quoted evidence with page and section citations. Not for general questions — use simple-paper-qa for those.
version: 1
match: /\b(what method|what approach|what technique|what model|how did they|how does it|what results?|what data|what dataset|what experiment|what metric|what performance|what accuracy|what baseline)\b/i
match: /\b(find|locate|where|which section|which page|quote|passage|excerpt|evidence|proof|support|mention)\b.*\b(paper|article|study|text|document)\b/i
match: /\b(does (this|the) paper|do the authors?)\b.*\b(mention|discuss|address|cover|report|describe|analyze|analyse|use|propose|introduce|present|evaluate|compare)\b/i
match: /\b(specific|particular|exact|precise)\b.*\b(result|finding|number|figure|statistic|claim|statement)\b/i
---

<!--
  SKILL: Evidence-Based Q&A

  This skill activates for specific questions about methods, results, or
  evidence in a paper (e.g., "what method did they use?", "find where
  they discuss accuracy").

  You can customize:
  - Retrieval strategy: change how evidence is gathered
  - Tool budget: adjust the number of allowed tool calls
  - Answer format: modify how evidence is presented

  Your changes are preserved across plugin updates.
  To reset to default, delete this file — it will be recreated on next restart.
-->

## Evidence-Based Paper Q&A — read then retrieve, then answer

When the user asks about specific methods, results, data, or needs to locate
a particular claim in a paper, use a two-step approach.

### Recipe

**Step 1 — Gather context:**

- If `mineruCacheDir` is available: use `file_io(read, '{mineruCacheDir}/full.md')`. Search the text for the relevant section. Answer if found.
- If no MinerU cache: use `read_paper` first to understand the paper's structure.

**Step 2 — Targeted retrieval (only if Step 1 is insufficient):**
Call `search_paper(question:'<the specific question>')` with a focused question. This returns the most relevant passages ranked by relevance.

**Step 3 — Answer from the evidence.**
Do NOT make additional retrieval calls. If the evidence does not fully answer
the question, say what you found and what is missing rather than making
more tool calls.

### Budget

Aim for 1–2 tool calls total. A MinerU read often answers in one call.
A non-MinerU path uses read_paper + search_paper = 2 calls.
Only exceed 2 calls if the paper's indexing is incomplete (check indexingState).
