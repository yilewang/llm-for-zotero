import { config } from "../constants";
import type { AgentPromptPack } from "./types";

const ROUTER_PROMPT_FILE = "agent-router.txt";
const RESPONDER_PROMPT_FILE = "agent-responder.txt";
const PROMPTS_BASE_PATH = "src/modules/contextPanel/Agent/prompts";

const DEFAULT_ROUTER_PROMPT = [
  "You are the router for a Zotero agentic workflow.",
  "Decide the next action only. Do not answer the user directly.",
  "Use the provided tool set and available targets.",
  "Return strict JSON only:",
  '{"decision":"stop","trace":"short reason","stopReason":"optional"}',
  "or",
  '{"decision":"tool_call","trace":"short action","call":{...}}',
  "Rules:",
  "- Stop as soon as sufficient grounded context exists.",
  "- Never repeat tool calls already marked complete in prior tool logs.",
  "- For library-level requests, use metadata first, then abstract only if metadata is insufficient.",
  "- Do not call deep paper tools unless the user explicitly asks for deep or paper-specific analysis.",
  "- Use write_note/fix_metadata only when user explicitly asks for write/fix actions.",
  "- When user asks to write/save the previous or last answer into note, call write_note.",
  "- Keep trace short and concrete.",
].join("\n");

const DEFAULT_RESPONDER_PROMPT = [
  "You are the final responder for a Zotero assistant.",
  "Use grounded retrieval results and tool outputs to answer clearly.",
  "If a ui action is pending, explicitly tell the user what to do next.",
  "For note review: tell the user to review the panel and click Save to Zotero.",
  "For metadata review: tell the user to review proposed fields and click Accept.",
  "For ambiguous library-level questions, answer broadly first and offer an optional follow-up deep dive sentence.",
  "Do not use opaque references like 'paper 1/2/3' unless you also show the explicit mapping in the same answer.",
  "Prefer human-readable references (author-year and/or title).",
  "Do not fabricate paper content or tool outcomes.",
].join("\n");

let cachedPromptPack: AgentPromptPack | null = null;

async function loadPromptFile(fileName: string): Promise<string> {
  const uri = `chrome://${config.addonRef}/${PROMPTS_BASE_PATH}/${fileName}`;
  const fetchFn = ztoolkit.getGlobal("fetch") as typeof fetch;
  const response = await fetchFn(uri);
  if (!response.ok) {
    throw new Error(`Failed to load prompt file: ${fileName}`);
  }
  return (await response.text()).trim();
}

export async function loadAgentPromptPack(
  forceReload = false,
): Promise<AgentPromptPack> {
  if (cachedPromptPack && !forceReload) {
    return cachedPromptPack;
  }

  let routerPrompt = "";
  let responderPrompt = "";
  let source: AgentPromptPack["source"] = "file";

  try {
    routerPrompt = await loadPromptFile(ROUTER_PROMPT_FILE);
  } catch {
    routerPrompt = DEFAULT_ROUTER_PROMPT;
    source = "fallback";
  }

  try {
    responderPrompt = await loadPromptFile(RESPONDER_PROMPT_FILE);
  } catch {
    responderPrompt = DEFAULT_RESPONDER_PROMPT;
    source = "fallback";
  }

  if (!routerPrompt) {
    routerPrompt = DEFAULT_ROUTER_PROMPT;
    source = "fallback";
  }
  if (!responderPrompt) {
    responderPrompt = DEFAULT_RESPONDER_PROMPT;
    source = "fallback";
  }

  cachedPromptPack = {
    routerPrompt,
    responderPrompt,
    source,
  };

  return cachedPromptPack;
}

export function resetAgentPromptPackCache(): void {
  cachedPromptPack = null;
}
