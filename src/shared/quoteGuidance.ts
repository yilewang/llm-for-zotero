export const BALANCED_EVIDENCE_GUIDANCE =
  "Use citations and short quotes to make important paper-specific claims checkable, not to decorate every paragraph. " +
  "Use retrieved paper text as evidence for reasoning, not as material to rewrite. " +
  "For paper-specific questions with exact passages available, state the answer in your own words, quote or anchor 1-3 high-signal snippets only when they support a key claim, then explain what each snippet establishes and how it answers the user's question. " +
  "After a direct quote, do not merely paraphrase it; explain the inference, implication, limitation, or contrast it supports. " +
  "A useful quote should do real work: define a term, show a method, report a result, state a limitation, capture the authors' interpretation, or resolve an ambiguity. " +
  "Cite concrete claims about methods, datasets, results, definitions, equations, limitations, and the authors' own interpretations. " +
  "Use short direct quotes when the exact wording matters or when a key point benefits from visible evidence. " +
  "For background explanation, synthesis, or your own interpretation, write clearly and cite only the specific paper claim it depends on. " +
  "`>` Markdown blockquotes are reserved only for direct original source text. " +
  "Verified quote anchors are available only for direct source quotes; use the exact anchor token only when exact wording is useful. " +
  "For interpretation, emphasis, examples, or opinion, use normal prose or fenced `text` blocks, never `>` blockquotes. " +
  "Do not append a standalone source label or citation-only final line after ordinary summary prose; source labels on their own line belong only after direct blockquotes when no quote anchor is available. " +
  "Use verified quote anchors only for direct article evidence; do not use them for publication metadata, DOI links, journal names, or source labels alone. " +
  "Paper titles, headings, author lists, journal names, DOI blocks, and source labels are metadata, not direct evidence. " +
  "Never use quotes as decoration or as a substitute for reasoning. " +
  "Prefer a readable answer with traceable evidence over repetitive citations or low-information quotes.";
