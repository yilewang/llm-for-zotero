---
id: literature-review
description: Structured scientific review with thematic synthesis and citations
version: 17
contexts: paper-set,library-corpus
activation: auto
---

## Literature Review — read the papers, then write one cited document

A review is an argument about a body of work, not a catalog of it: a faithful account of each paper, true relationships between specific papers, a structure that emerges from those relationships, and honest calibration about what was read.
`paper_read` owns reading capacity; do not invent a paper cap, a group size, or a tool-call budget.

### Workflow

1. **Scope.** The host states the turn's papers or collection in the context.
   If only a collection or a search is named, list its papers once with `library_search` and work from that list.
   A selected folder, tag or paper set is the source boundary: each paper in it is a candidate, and none is relevant only because it is there.
   When the review needs papers outside the library (nothing relevant is attached or in the library, or the library misses important work), find them with `literature_search`; the selection card asks the user to import and cite them or to cite them without importing, also for a review that mixes library and outside papers.
   With "Cite without importing", or where no selection card can be shown, read each chosen paper with `literature_read` and cite it by `paperId`; with "Import and cite", read the imported items with `paper_read` and cite them by `libraryID` and `itemKey`.
2. **Read.** When the tools hand the papers to the host, write from its results and skip the first read below; otherwise read the scope's papers with `paper_read`, passing them as `targets` and grouping related papers in one call.
   Each result reports which papers came back complete, sampled, abstract only, or metadata only.
   When papers come back sampled, read fewer at a time or read their missing sections rather than moving on.
   As you go, note each paper's main claims, methods, and evidence, and its role in the argument: central, supporting, contradictory, theoretical, methodological, or context.
   When a paper's own text shows it reviews or pools other studies, cite it for the field's overview or a pooled result, and cite the primary study for a specific finding when you have it.
   Use `paper_read({ mode:'targeted', query:'...' })` only to check a decisive claim, test an apparent contradiction against both papers, or find a precise location.
3. **Select.** Decide from each paper's content which papers the review uses.
   Include every paper whose content bears on the question, whatever its field.
   Leave a paper out only when its content does not bear on the question: a relevance of none is a signal, not the decision.
   List each paper you leave out under `excluded` in `submit_document`, with a one-sentence reason, and name it by title with that reason in Scope and method, without a citation: a citation means the review uses the paper.
   Never leave a paper out because its text could not be read; name it as not read.
   When the user asked to summarize every paper, every paper keeps its summary in Paper summaries; flag one that does not fit the question instead of dropping it.
4. **Write.** Write one cited document as described under Document.
   When the user asked for summaries, the document opens with a 'Paper summaries' section: one paragraph per paper, in scope order, before the review sections below.
5. **Save.** Save it with `note_write` and the returned `documentId` only when the user asked; do not offer afterward, because the document card owns Copy Markdown, Save Note, Export, and Expand.

### Scope and method

- Expand the question into explicit subquestions and read every paper against them.
- Write a narrative review by default; write a scoping review when the goal is to map the breadth, concepts, methods, and gaps of a field.
- In narrative and scoping reviews, include papers by their relevance to the question and name each excluded paper with its reason.
  Use formal PRISMA-style screening only when the user asks for a systematic-review method, PRISMA-style selection, or reproducible eligibility decisions, and then report each paper's decision and its reason.
- Missing abstracts, unindexed PDFs, OCR failures, and unreadable files stay unresolved unless metadata alone clearly excludes the paper; report the depth actually reached.
- Preserve contradictions and negative evidence rather than forcing agreement.

### Synthesis

- Organize by ideas, methods, or findings, not paper by paper.
- A sentence that relates two papers rests on what you read in both: state what the text supports as established, and hedge what you could not verify.
- Every paper-specific claim traces to that paper's text.
- Turn what the reading left open (isolated papers, thinly covered subquestions, unresolved contradictions, open questions) into the research gaps.
- Use `paper_read({ mode:'figures', ... })` only when a figure materially improves the synthesis; a generated figure is never source evidence.

### Quality checks

- Apply SANRA-style narrative-review checks: explain importance and aims, describe the reviewed scope, support key claims with references, reason from the strength and type of evidence, and present outcome data accurately.
- For scoping reviews, map the breadth, concepts, evidence types, and gaps in line with JBI's purpose for scoping evidence synthesis.

### Document

Prefer these sections unless the user asks for another structure:

1. Introduction and review question
2. Scope and method
3. Thematic synthesis
4. Agreements, contradictions, and limitations
5. Research gaps and future directions
6. Conclusion
7. Scope and limitations

- Put `[[cite:C1]]` tokens at supported claims and identify each citation source by `libraryID` and `itemKey`, or an outside paper by its `paperId`; the host binds the evidence your reads produced.
- Cite only papers you read for this review; a direct quotation uses a `[[quote:Q1]]` token whose mapping carries the verbatim text and the evidence IDs the read returned.
- Never hand-format author-year citations or a References section; Zotero's CSL service formats both.
- In Scope and method, name each paper you left out by title, with the reason and without a citation.
- In Scope and limitations, state the coverage: how many papers were read in full, in part, and from metadata only, as `paper_read` reported them, and name any paper that stayed unread.
- State the actual coverage frontier and its limitations, and never imply an exhaustive review from sampled text.
