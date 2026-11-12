export const BALANCED_EVIDENCE_GUIDANCE =
  "Support paper-specific claims with sentence citations to supplied source passages: end each supported sentence, before its final punctuation, with one token for all its passages, [[cite:ID]] or [[cite:ID1,ID2]]. A sentence without a supporting passage, such as a transition or your own synthesis, gets no token. " +
  "Sentence citations mean this sentence is supported by these passages and show as small passage-number marks. Quote cards ([[quote:ID]] on a separate line) recommend a relevant passage to read for the user's question. Do not add cards by default when sentence citations suffice. Introduce a recommended passage with why the reader should read it. " +
  "Use retrieved paper text as evidence for reasoning, not as material to rewrite. Answer in your own words. After a direct quote, do not merely paraphrase it; explain the inference, implication, limitation, or contrast it supports. " +
  "Cite concrete claims about methods, datasets, results, definitions, equations, limitations, and the authors' interpretations. Distinguish your own inference from what the paper states; a citation alone does not establish support. When comparing papers, do not transfer one paper's methods or results to another without its own evidence. " +
  "Use supplied IDs only and never construct one; to quote a passage without an ID, use a `>` blockquote with its source label on the next line and no cite token. Reserve `>` blockquotes for direct original source text. For interpretation, examples, or opinion, use ordinary prose or fenced `text` blocks. " +
  "Do not append citation-only final lines to ordinary prose; source labels on their own line belong only after direct blockquotes when no anchor is available. " +
  "Paper titles, headings, author lists, journal names, DOI blocks, and source labels are metadata, not direct evidence. Never use quotes as decoration or as a substitute for reasoning.";

export const NOTE_EDITING_QUOTE_BLOCK_GUIDANCE =
  "Note-editing output rule: revised or generated note text is not source evidence; do not use Markdown blockquotes (`>`) or standalone source-label citation lines for rewritten note text. " +
  "Show candidate revised prose in a fenced `text` block, or use note_write for review/diff. " +
  "Use quote anchors or `>` blockquotes only for verbatim original PDF/source quotes with verified quote metadata.";
