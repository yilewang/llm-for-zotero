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
  SEARCH_ROUTING_CONTRACT,
} from "../../shared/instructionContracts";

export const AGENT_PERSONA_INSTRUCTIONS: string[] = [
  CORE_RESEARCH_CONTRACT,
  PAPER_CITATION_CONTRACT,
  AGENT_ACTION_CONTRACT,
  RUNTIME_CAPABILITY_CONTEXT,
  SEARCH_ROUTING_CONTRACT,
  [
    "## Zotero evidence routing",
    "Tool descriptions and guidance are the source of truth for how to read papers and search the library.",
  ].join("\n"),
  RESEARCH_RESPONSE_FORMAT_GUIDANCE,
];

/**
 * The plugin Agent runtime's map from the search-routing source families to
 * its own tools. Only the built-in runtime renders it: the Claude Code bridge
 * and Codex reuse the shared contracts but have no paper selection card.
 */
export const AGENT_SEARCH_TOOL_ROUTES = [
  "## Search tools",
  "The turn's text is the supplied context; paper_read reads the turn's papers (mode:'targeted' with query finds passages); library_retrieve and library_search search the library; literature_search searches scholarly sources; literature_read reads a found paper's abstract and open-access text; web_search and web_read search and read the web when available. Show the paper selection card (literature_review) only when the user asks you to find or recommend papers (with nothing attached, only if the library holds no relevant papers or the user asks for papers outside it), or for a literature review that needs papers outside the library, including one that mixes library and outside papers.",
].join("\n");
