---
id: compare-papers
description: Compare selected papers or collection papers by theme, methodology, or findings
version: 11
contexts: paper-set,library-corpus
activation: auto
---

## Compare papers

Organize the comparison around the user's question and dimensions that distinguish the papers.
Use comparable definitions, populations, datasets, measurements, and study conditions; explain when reported results cannot be compared directly.
Connect agreements and disagreements to their evidence and limitations rather than listing independent summaries.

For three or more papers, declare a digest part first (`task_update` with `expectedEffect:'digest'` over the papers) whose description names the comparison dimensions, for example "For each paper, report: question, species or system, method, main finding".
Each result returns facets with those labels; they become the comparison's rows.
Read further only for a dimension the results leave open.
When the user asks what the papers have in common, state a commonality only where the facets of each paper support it.

Reuse supplied paper text and the selected-paper evidence ledger.
Read further only for a missing comparison dimension or an important uncertainty, batching explicit paper `targets` when useful.
For a collection or library corpus, use scoped `library_retrieve` and its paper ledger before close-reading identified papers.

A concise comparison still needs evidence at the requested depth.
Preserve the coverage frontier, identify papers or dimensions that remain unsupported, and distinguish body evidence from metadata or abstracts.
