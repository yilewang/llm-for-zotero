---
id: literature-review
description: Structured scientific review with thematic synthesis and citations
version: 13
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
2. **Parts.** In your first step, declare the parts with `task_update`.
   When the user asked for something per paper (summaries, each paper's method, a table with a row per paper), or when the review must account for more than four papers, declare a digest part: `{ taskId:'papers', description:'For the review question "<question>": summarize each paper and judge how it bears on the question', expectedEffect:'digest', scope:true }` (or explicit `targetIds`), and do not also declare a read part over the same papers.
   With nothing attached, choose the papers from `library_retrieve` results without opening them with `paper_read`, then declare the digest part with their `targetIds`.
   The host then analyzes each paper itself inside that call and returns the results; do not read those papers with `paper_read` first.
   Then declare the review (`expectedEffect:'artifact'`) and, only when the user asked to save it, the note (`expectedEffect:'mutation'`, `expectedCapability:'zotero.notes'`).
   For four papers or fewer without a per-paper request, declare a read part (`expectedEffect:'read'`) instead and read them with `paper_read`.
   The host marks each part done from the tools' results.
3. **Read.** With a digest part, write from the results the host returned: each has the answer to the part's description, a relevance line when the description names a question, facets, verified quotes with section labels, gaps, and a handle for `context_read source:'tool_result'` when you need the full record.
   Read a digested paper again only with `paper_read({ mode:'targeted', query:'...' })`: to verify a decisive cross-paper claim, test an apparent contradiction, or close a gap its result names that the review needs; never re-read it in overview or full mode.
   A paper that failed with "No readable text" has no text to read: name it as not read, and do not retry it, read it with `paper_read`, or look for it outside the library.
   If the host reports other digest failures, declare the part again once with `targetIds` of those papers only.
   Then a paper whose digest failed twice may be read with an overview `paper_read` instead; name it as not read only if that read fails too.
   If the part is still open after a Stop and the user says continue, call `task_update` again with the same `taskId` and no description to finish the remaining papers.
   Without a digest part, read the scope's papers with `paper_read`, passing them as `targets` and grouping related papers in one call.
   The host fits each paper's text to the remaining context, and each result reports which papers came back complete, sampled, abstract only, or metadata only.
   When papers come back sampled, read fewer at a time or read their missing sections rather than moving on.
   As you go, note each paper's main claims, methods, and evidence, and its role in the argument: central, supporting, contradictory, theoretical, methodological, or context.
   Use `paper_read({ mode:'targeted', query:'...' })` only to check a decisive claim, test an apparent contradiction against both papers, or find a precise location.
4. **Select.** Decide from each paper's content which papers the review uses.
   Include every paper whose content bears on the question, whatever its field.
   Leave a paper out only when its content does not bear on the question: a relevance of none is a signal, not the decision.
   List each paper you leave out under `excluded` in `submit_document` (or `task_update` for an answer without a document), with a one-sentence reason, and name it by title with that reason in Scope and method, without a citation: a citation means the review uses the paper.
   Never leave a paper out because its text could not be read; name it as not read.
   When the user asked to summarize every paper, every paper keeps its summary in Paper summaries; flag one that does not fit the question instead of dropping it.
5. **Write.** Write one cited document and finish with `submit_document`, as described under Document; pass the `taskId` of the review part.
   When the user asked for summaries, the document opens with a 'Paper summaries' section: one paragraph per paper, in scope order, each from that paper's digest, before the review sections below.
6. **Save.** Save it with `note_write` and the returned `documentId` only when the user asked; do not offer afterward, because the document card owns Copy Markdown, Save Note, Export, and Expand.

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
- Keep PRISMA-style eligibility screening to systematic-review requests; in other reviews, name each excluded paper with its reason.

### Document

Prefer these sections unless the user asks for another structure:

1. Introduction and review question
2. Scope and method
3. Thematic synthesis
4. Agreements, contradictions, and limitations
5. Research gaps and future directions
6. Conclusion
7. Scope and limitations

- Put `[[cite:C1]]` tokens at supported claims and identify each citation source by `libraryID` and `itemKey`; the host binds the evidence your reads produced.
- Cite only papers you read for this review; a direct quotation uses a `[[quote:Q1]]` token whose mapping carries the verbatim text and the evidence IDs the read returned.
- Never hand-format author-year citations or a References section; Zotero's CSL service formats both.
- In Scope and method, name each paper you left out by title, with the reason and without a citation.
- In Scope and limitations, name each paper whose digest failed and the reason the host gave.
- In Scope and limitations, state the coverage: how many papers were read in full, in part, and from metadata only, as `paper_read` reported them, and name any paper that stayed unread.
- State the actual coverage frontier and its limitations, and never imply an exhaustive review from sampled text.
