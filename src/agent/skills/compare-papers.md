---
id: compare-papers
description: Compare selected papers or collection papers by theme, methodology, or findings
version: 13
contexts: paper-set,library-corpus
activation: auto
---

## Compare papers

Organize the comparison around the user's question and dimensions that distinguish the papers.
Use comparable definitions, populations, datasets, measurements, and study conditions; explain when reported results cannot be compared directly.
Connect agreements and disagreements to their evidence and limitations rather than listing independent summaries.

When the user asks what the papers have in common, state a commonality only where the facets of each paper support it.

Reuse supplied paper text and the selected-paper evidence ledger.
Read what the user asked to read: when they limited it (only the abstracts, named sections), read just that, for example with `paper_read` `sections` and no query, and when they asked for full reads, read each paper in full.
Otherwise read further only for a missing comparison dimension or an important uncertainty, batching explicit paper `targets` when useful.
For a collection or library corpus, use scoped `library_retrieve` and its paper ledger before close-reading identified papers.

A concise comparison still needs evidence at the requested depth.
Preserve the coverage frontier, identify papers or dimensions that remain unsupported, and distinguish body evidence from metadata or abstracts.
