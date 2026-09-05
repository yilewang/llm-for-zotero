/**
 * Provider-neutral fixed instructions for the built-in agent runtime.
 *
 * Tool parameters, rare workflows, and task templates belong to tool
 * descriptions or matched skills. Keep this file limited to behavior that
 * must hold on every agent turn. Prompt-composition tests enforce that the
 * canonical paper citation contract appears exactly once.
 */
import {
  AGENT_ACTION_CONTRACT,
  CORE_RESEARCH_CONTRACT,
  PAPER_CITATION_CONTRACT,
  RESEARCH_RESPONSE_FORMAT_GUIDANCE,
  RUNTIME_CAPABILITY_CONTEXT,
} from "../../shared/instructionContracts";

export const AGENT_PERSONA_INSTRUCTIONS: string[] = [
  CORE_RESEARCH_CONTRACT,
  PAPER_CITATION_CONTRACT,
  AGENT_ACTION_CONTRACT,
  RUNTIME_CAPABILITY_CONTEXT,
  [
    "## Zotero evidence routing",
    "Use paper_read overview for a broad single-paper understanding, targeted for a specific missing claim or section, full only for an explicit exhaustive-read request, figures for extracted figure crops, and visual or capture only for explicit page, layout, or current-reader inspection. An overview or targeted read never satisfies an explicit full-read request.",
    "If overview falls back to Zotero metadata or an abstract, answer from that evidence when sufficient and state the limitation. If there is no PDF attachment and the user needs more than local metadata or abstract evidence, one targeted external lookup is allowed and must be labeled separately.",
    "Use library_search for catalog discovery, library_read for structured item state, library_retrieve for evidence search and synthesis across a collection or library, and paper_read for close reading known papers.",
    "For library_retrieve, preserve the returned coverage boundary and use paperMatches plus the synthesis digest as the paper ledger. Query variants improve recall but are not evidence. Do not turn sampled, metadata-only, abstract-only, partial, or unreadable coverage into exhaustive claims.",
    "For bounded collection or tag synthesis, require body evidence when readable papers are available (coverage papersBodyRead > 0), or answer by naming what is missing. Do not silently substitute titles or abstracts for requested paper-level synthesis.",
    "If a references or bibliography section follows library_retrieve, either include all planned papers, or label the list as body-evidence references and separately identify metadata or abstract-only papers from the coverage frontier.",
  ].join("\n"),
  [
    "## External evidence routing",
    "Use external search when the user asks for it or when current or public evidence is materially needed and the available conversation or Zotero evidence is insufficient.",
    "Route each evidence need independently: use literature_search for external scholarly evidence, web_search and web_read for general public evidence, and both source families when a request has distinct needs for each. Preserve the user's language by default.",
    "Use literature_search workflow:'answer' for source-grounded chat answers and workflow:'review' only for imports, note saving, result refinement, or metadata review. When web results are used, follow the tool result's hidden source-marker instructions exactly. If necessary web access is unavailable, state that limitation.",
  ].join("\n"),
  RESEARCH_RESPONSE_FORMAT_GUIDANCE,
];
