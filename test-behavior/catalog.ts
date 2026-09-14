import type { Mode } from "./core";

type Contract = {
  id: string;
  journey: string;
  mode: Mode;
  smoke: boolean;
  dependsOn: string[];
  acceptance: string;
  evidence: string[];
};
const contract = (
  id: string,
  journey: string,
  mode: Mode,
  smoke: boolean,
  acceptance: string,
  dependsOn: string[] = [],
  evidence = [
    "events",
    "receipts",
    "native-before",
    "native-after",
    "native-diff",
  ],
): Contract => ({ id, journey, mode, smoke, acceptance, dependsOn, evidence });

export const catalog: Contract[] = [
  contract(
    "semantic.create-file",
    "semantic",
    "auto",
    false,
    "Create a named destination, carry its verified native identity into a move, preserve unrelated memberships, and complete both steps without execution-model rounds.",
  ),
  contract(
    "semantic.compound-clarified",
    "semantic",
    "auto",
    false,
    "A compound request with an ambiguous source fills that native reference, preserves unrelated membership, and finishes the exact attached summary without rediscovering authority.",
  ),
  contract(
    "semantic.compound-implicit",
    "semantic",
    "auto",
    false,
    "The natural compound request with an implicit source moves the active paper, summarizes its PDF, and attaches the exact finalized summary.",
  ),
  contract(
    "semantic.action-cases",
    "semantic",
    "auto",
    false,
    "Paraphrases, multilingual moves, additive filing, real source clarification, and collection deletion execute with native verification and no execution-model rounds.",
  ),
  contract(
    "semantic.move",
    "semantic",
    "auto",
    false,
    "The exact ordinary move request resolves its implicit source, executes once without execution-model rounds, and verifies native source absence and destination presence.",
  ),
  contract(
    "semantic.compound",
    "semantic",
    "auto",
    false,
    "Move, summarize, and attach a finalized summary note with native evidence.",
  ),
  contract(
    "semantic.compound-revise",
    "semantic",
    "auto",
    false,
    "Replace an interrupted note save with an exact-content file save while retaining the completed move and immutable summary.",
  ),
  contract(
    "semantic.compound-resume",
    "semantic",
    "auto",
    false,
    "Recover a lost note-save response using the same finalized summary and native note, without replaying the move or generation.",
  ),
  contract(
    "semantic.compound-plan",
    "semantic",
    "auto",
    false,
    "Plan, approve, and execute the complete compound workflow with native evidence.",
  ),
  contract(
    "semantic.transport",
    "diagnostic",
    "auto",
    false,
    "Read-only diagnostic: measure one semantic interpretation with the configured reasoning and a 180-second bounded transport; never execute its actions.",
    [],
    ["semantic-transport", "native-before", "native-after"],
  ),
  contract(
    "semantic.filing",
    "library",
    "auto",
    false,
    "Folder, collection, and multilingual filing requests resolve the active paper and preserve all other memberships; repeated filing has a verified already-satisfied receipt.",
  ),

  contract(
    "paper.conversation",
    "paper",
    "auto",
    true,
    "Six real turns on one paper preserve scope and produce evidence-backed answers without confirmations.",
  ),
  contract(
    "paper.child-note",
    "paper",
    "auto",
    true,
    "Exactly one durable child note summarizes all six discussion topics; no placeholders or confirmation.",
    ["paper.conversation"],
  ),
  contract(
    "paper.document-view",
    "paper",
    "auto",
    true,
    "The same saved answer has six interactive, human-readable quote citations in chat, inline document, and larger document view; expansion works without library mutations.",
    ["paper.child-note"],
    [
      "regular-chat-citations",
      "inline-document-html",
      "standalone-document-html",
      "native-before",
      "native-after",
    ],
  ),
  contract(
    "paper.standalone-note",
    "paper",
    "auto",
    false,
    "Exactly one standalone note is filed in the requested collection.",
    ["paper.child-note"],
  ),
  contract(
    "paper.edit-note",
    "paper",
    "auto",
    false,
    "The requested note section changes while the remaining content survives native reload.",
    ["paper.child-note"],
  ),
  contract(
    "paper.obsidian",
    "paper",
    "auto",
    true,
    "The finalized note is written to the exact Markdown path and contains substantive text without confirmation.",
    ["paper.child-note"],
  ),
  contract(
    "paper.figures",
    "paper",
    "auto",
    false,
    "paper_read figures (the analyze_figure pipeline) supplies cropped figures; exported Markdown contains resolvable relative images and provenance.",
  ),
  contract(
    "library.tags",
    "library",
    "yolo",
    true,
    "All three target papers receive exactly the same requested tags; unrelated items remain unchanged.",
  ),
  contract(
    "library.add",
    "library",
    "yolo",
    false,
    "Adding a paper preserves its source and unrelated memberships.",
  ),
  contract(
    "library.move",
    "library",
    "yolo",
    false,
    "Moving removes only the named source membership and preserves unrelated membership.",
    ["library.add"],
  ),
  contract(
    "library.merge",
    "library",
    "auto",
    true,
    "geometry and memory become geometry_memory with the exact union of papers, without item duplication or confirmation.",
  ),
  contract(
    "library.metadata",
    "library",
    "yolo",
    false,
    "Only the requested metadata field changes; native state matches exactly.",
  ),
  contract(
    "library.related",
    "library",
    "yolo",
    false,
    "The requested pair has reciprocal Related links; no unrelated links change.",
  ),
  contract(
    "library.trash",
    "library",
    "yolo",
    false,
    "Only the named fixture paper is moved to trash; it is not permanently erased.",
  ),
  contract(
    "library.restore",
    "library",
    "yolo",
    false,
    "The same item key is restored with original metadata and memberships.",
    ["library.trash"],
  ),
  contract(
    "library.import-five",
    "library",
    "auto",
    false,
    "Explicitly requested top five papers are imported without a confirmation, with five distinct valid identifiers and verified native items.",
  ),
  contract(
    "research.review",
    "research",
    "auto",
    false,
    "One approved plan completes a scoped population-coding review with durable paper checkpoints and a published document; prose quality remains human-reviewed.",
  ),
  ...(["safe", "auto", "yolo"] as const).flatMap((mode) => [
    contract(
      `modes.${mode}.read`,
      "modes",
      mode,
      mode === "auto",
      "Read-only paper inspection produces no confirmation and no native change.",
    ),
    contract(
      `modes.${mode}.note`,
      "modes",
      mode,
      true,
      "Exactly one child note is persisted without confirmation, with a saved-note card linking the exact native note.",
    ),
    contract(
      `modes.${mode}.metadata`,
      "modes",
      mode,
      false,
      `An exact metadata update follows ${mode} authorization and changes no other item.`,
    ),
    contract(
      `modes.${mode}.file`,
      "modes",
      mode,
      false,
      `An exact external file write follows ${mode} authorization and has a verified receipt.`,
    ),
    contract(
      `modes.${mode}.no-write`,
      "modes",
      mode,
      false,
      "An explicit do-not-change request produces no mutations, even if it describes a possible edit.",
    ),
    contract(
      `modes.${mode}.related-review`,
      "modes",
      mode,
      false,
      "Finding relevant papers always displays an import-review card; cancelling imports nothing.",
    ),
  ]),
  contract(
    "recovery.cancel",
    "recovery",
    "safe",
    true,
    "Cancelling a pending Safe write leaves native state unchanged and produces no applied receipt.",
  ),
  contract(
    "recovery.unavailable-figures",
    "recovery",
    "auto",
    false,
    "A metadata-only paper produces an honest unavailable-figure answer, no fabricated figure and no write.",
  ),
];

export function selectSteps(
  tier: string,
  selections: string[] = [],
): Contract[] {
  if (!["full", "smoke"].includes(tier))
    throw new Error(`Unknown tier: ${tier}`);
  const selected = new Set<string>();
  const add = (id: string) => {
    if (selected.has(id)) return;
    const entry = catalog.find((row) => row.id === id);
    if (!entry) throw new Error(`Unknown behavior: ${id}`);
    entry.dependsOn.forEach(add);
    selected.add(id);
  };
  if (selections.length)
    selections.forEach((selection) => {
      const matches = catalog.filter(
        (row) => row.id === selection || row.journey === selection,
      );
      if (!matches.length)
        throw new Error(`Unknown behavior selection: ${selection}`);
      matches.forEach((row) => add(row.id));
    });
  else
    catalog
      .filter((row) => tier === "full" || row.smoke)
      .forEach((row) => add(row.id));
  return catalog.filter((row) => selected.has(row.id));
}
