---
id: literature-review
description: Structured scientific review with thematic synthesis and citations
version: 8
contexts: paper-set,library-corpus
activation: auto
---

<!--
  SKILL: Literature Review

  This skill activates when you ask for a literature review or synthesis
  (e.g., "conduct a literature review on X", "synthesize the research").

  You can customize:
  - Discovery phase: change how papers are found and selected
  - Review structure: modify sections (intro, themes, gaps, conclusion)
  - Citation format: adjust citation style
  - Depth vs breadth: change how many papers are deep-read vs skimmed

  Your changes are preserved across plugin updates.
  To reset to default, delete this file — it will be recreated on next restart.
-->

## Literature Review — intent and document structure

This skill declares the literature-review intent and preferred structure.
The ordinary workflow is **read → understand → connect → write**, run as a network loop: frame → map → nodes → links → verify → structure → write.
A review is an argument about a body of work, not a catalog of it: faithful nodes, true links between specific papers, structure that emerges from the links, and honest calibration about what was read and verified.
The central ResearchPolicy owns capacity measurement, recovery, and evidence requirements.
Do not invent a paper cap or tool-call budget here.

### Scope and investigation

- Treat an explicitly selected Zotero corpus as the evidence pool, not as a sample.
- For an ordinary review, expand the user's question into explicit subquestions without turning them into eligibility criteria.
  Each subquestion becomes a comparison-frame slot that every core node fills.
- Default to `reviewMode:'narrative'` and `readingStrategy:'adaptive'`.
- Do not choose a fixed number of papers to deep-read.
  The host proposes tiers (core, supporting, peripheral) from relevance and from how many nodes fit in the link view; confirm or override them with `research_update({operation:'set_tiers'})` and a reason.
  Read every accessible paper at the depth its tier buys, and report the actual per-paper coverage.
- Only use formal inclusion/exclusion screening when the user explicitly requests a systematic-review method, PRISMA-style selection, reproducible eligibility decisions, or an equivalent protocol.
- Use `reviewMode:'scoping'` when the goal is to map the breadth, concepts, methods, and gaps in a field rather than construct a focused explanatory argument.
- Missing abstracts, unindexed PDFs, OCR failures, and unreadable files remain unresolved unless metadata is enough to exclude them clearly.
- Preserve contradictions and negative evidence rather than forcing agreement.

### Frame and map

- After Plan approval, call `research_update({operation:'inventory_scope'})` once.
  It returns the comparison frame (identity slots `question`, `approach`, `system` plus one slot per subquestion), every paper's tier and read mode, proposed read groups, and the corpus map.
- Refine the frame with `set_frame` only before the first link pass, adding comparison slots the corpus needs; identity slots are fixed.
- The corpus map (one line per paper) travels in every checkpoint so each node is written with the corpus in view.

### Nodes (reading)

- At each step, read one capacity-sized group (a proposed group, or your own regrouping of the manifest) with `paper_read` in each entry's `readMode`, then immediately persist a claim-based node for every identity in that group with `research_update({operation:'record_papers', ...})` before reading more.
  The group size must follow the actual input and output capacity and the semantic relationships among the papers, never a fixed paper-count threshold.
- Never accumulate multiple unrecorded reading groups in the model transcript.
  After each durable reduction, the host checkpoints away the raw PDF text and supplies the exact remaining reading manifest for the next group.
- When a checkpoint supplies the remaining manifest, do not call inventory_scope again.
  Treat that manifest as authoritative and call `paper_read` for the next group directly.
- When the checkpoint says all papers are durable, do not call inventory_scope again.
  Continue directly with the link pass.
- Build one durable paper understanding for every item as a node: `mainMessage`, `relevance`, `confidence`, every frame slot (write `not_reported` when the paper is silent), `claims[]` each with its kind, the subquestions it answers and the evidence it rests on (never deeper than the read the host verified), `hooks` (constructs, methods, datasets, populations, key quantities), and either `candidateLinks[]` to other corpus papers or `noLinkSeen` with a reason.
  A core node carries at least three claims; supporting and peripheral nodes carry the identity slots and at least one claim.
- Assign one or more descriptive roles such as central evidence, supporting evidence, contradictory evidence, theoretical foundation, methodological contribution, historical context, or tangential context.
- Use `paper_read({ mode:'figures', ... })` only when a figure materially improves the synthesis. A generated figure is never source evidence.
- If the complete source text cannot fit, preserve coverage by allocating less text per paper or by using capacity-sized semantic groups, then synthesize across the durable nodes.

### Links, verification, and structure

- Links phase: call `research_update({operation:'list_findings'})` (compact view) to see every node, then record the explicit typed edge list with `record_edges`: source, target, type (`extends`, `contradicts`, `replicates`, `shares_method`, `shares_construct`, `supplies_theory`, `motivates`, `applies_to`, `refines`), the claim ids the edge rests on, a one-sentence statement, and confidence.
  Candidate links from the node pass are suggestions, not edges.
  Every core node touches an edge or keeps its `noLinkSeen`.
- Verification phase: `advance_phase` to `verification`, then follow `next_work`.
  Contradictions are always verified: read the pair with `paper_read({mode:'targeted', ...})` and a specific query, then decide with `update_edges` (`verified`, `refuted`, or `tentative` with a note).
  Record the questions the corpus raises with `record_questions`; answer or abandon them with `resolve_questions`.
- Structure phase: `advance_phase` to `structure`, call `list_graph`, and record themes with `record_themes` naming the `edgeIds` and `communityId` each theme rests on.
  Themes are communities in the graph; synthesize from the edges, not from juxtaposed summaries.
  Turn the host's structural gaps (isolated nodes, thin subquestions, unresolved contradictions, tentative edges, open questions) into the gaps section.
- Then `advance_phase` to `writing` and call `finalize` with `outcome:'complete'` (`partial` when accessible papers stayed unread).
  Use targeted reads at any phase only to resolve an important uncertainty, check a decisive claim, or obtain a precise location.

### Evidence-based quality checks

- Apply SANRA-style narrative-review checks: explain importance and aims, describe the reviewed scope, support key claims with references, reason from the strength and type of evidence, and present relevant outcome data accurately.
- For scoping reviews, map the breadth, concepts, evidence types, and gaps in line with JBI's purpose for scoping evidence synthesis.
- Keep PRISMA-style eligibility screening and exclusion accounting exclusive to systematic-review requests.

### Document structure

Prefer these sections unless the approved document contract says otherwise:

1. Introduction and review question
2. Scope and method
3. Thematic synthesis (organized by ideas or methods, not a paper-by-paper list)
4. Agreements, contradictions, and limitations
5. Research gaps and future directions
6. Conclusion
7. Scope and limitations

Write the synthesis from `list_graph`: every sentence that relates two papers rests on a recorded edge, verified edges are stated as established and tentative ones with hedged wording, and every paper-specific claim traces to a node claim.
The host audits cross-paper paragraphs against the edge list and appends a verification-and-coverage paragraph from its own records.

In Agent mode, the literature-review outcome is always a document. Finish with `submit_document` whether or not Plan mode is active:

- Write internal citation tokens such as `[[cite:C1]]` and provide item-key/evidence mappings.
- Never hand-format author-year citations or References. Zotero's centralized CSL service resolves both with the approved style and locale.
- Cite only frozen-corpus items backed by persisted evidence. Direct quotations also require strict quote verification.
- Do not ask afterward whether to save a note. The finalized document card owns Copy Markdown, Save Note, Export, and Expand actions.

Outside Plan mode, use the ordinary ResearchPolicy profile, copy the host-issued evidence IDs returned by read tools into every citation mapping, and state the actual coverage frontier and limitations. Never imply exhaustive review from sampled snippets.
