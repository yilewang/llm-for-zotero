---
id: evidence-based-qa
description: Retrieve missing evidence for specific methods, results, or verification questions in selected papers or collections. Clarification or translation of sufficient supplied text needs no retrieval workflow.
version: 13
contexts: single-paper,paper-set,library-corpus
activation: auto
---

## Check a paper-specific question

Use supplied text and prior evidence before retrieving more.
For methods, results, or claims, separate direct statements, inferences, and what the source does not report.
A passage search cannot show a claim is absent from a paper; a title or author lookup can show a paper is not in the library.

Use `paper_read` for missing passages in known papers, batching `targets`.
For a collection or library, use `library_retrieve` there, then close-read papers.
Look a named paper up by title or author with `library_search` first; if that and a topical search find nothing, say it is not in the library or collection searched, listing searches and closest items.

Assess multi-paper answers by paper ledger, body evidence, and coverage frontier.
Follow up on concrete gaps, not a call count; disclose partial or missing evidence.
