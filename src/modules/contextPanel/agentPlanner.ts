import { callLLM, type ReasoningConfig } from "../../utils/llmClient";
import { formatPaperCitationLabel } from "./paperAttribution";
import type { PaperContextRef } from "./types";
import { sanitizeText } from "./textUtils";
import type { AgentPlannerAction, AgentQueryPlan } from "./agentTypes";
import {
  isLibraryOverviewQuery,
  isLibraryScopedSearchQuery,
} from "./agentContext";

const MAX_AGENT_TRACE_LINES = 4;
const MAX_AGENT_TRACE_LINE_LENGTH = 120;
const MAX_AGENT_PAPERS_TO_READ = 12;

type AgentPlannerContext = {
  question: string;
  conversationMode: "paper" | "open";
  libraryID: number;
  model: string;
  apiBase?: string;
  apiKey?: string;
  reasoning?: ReasoningConfig;
  activePaperContext?: PaperContextRef | null;
  paperContexts?: PaperContextRef[];
  pinnedPaperContexts?: PaperContextRef[];
  recentPaperContexts?: PaperContextRef[];
};

function clampPapersToRead(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(MAX_AGENT_PAPERS_TO_READ, Math.floor(parsed)));
}

function dedupePaperContexts(values: (PaperContextRef | null | undefined)[]): PaperContextRef[] {
  const out: PaperContextRef[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    const key = `${value.itemId}:${value.contextItemId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function questionExplicitlyTargetsLibrary(question: string): boolean {
  return /\b(?:zotero\s+)?(?:library|collection)\b/i.test(question);
}

function normalizeTraceLines(value: unknown, fallback: string[]): string[] {
  const rawLines = Array.isArray(value) ? value : [];
  const lines = rawLines
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => sanitizeText(entry).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((entry) => entry.slice(0, MAX_AGENT_TRACE_LINE_LENGTH))
    .slice(0, MAX_AGENT_TRACE_LINES);
  return lines.length ? lines : fallback;
}

function normalizeSearchQuery(value: unknown): string {
  return sanitizeText(typeof value === "string" ? value : "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function summarizePaperContexts(
  paperContexts: PaperContextRef[] | undefined,
  maxItems: number,
): string {
  const entries = dedupePaperContexts(paperContexts || []);
  if (!entries.length) return "none";
  return entries
    .slice(0, maxItems)
    .map((entry) => `${formatPaperCitationLabel(entry)} - ${entry.title}`)
    .join(" | ");
}

export function findAgentPlanJsonObject(raw: string): string {
  const source = String(raw || "");
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  return "";
}

function getFallbackTraceLines(action: AgentPlannerAction): string[] {
  switch (action) {
    case "library-overview":
      return [
        "This looks like a whole-library request.",
        "I will inspect the active Zotero library before answering.",
      ];
    case "library-search":
      return [
        "This looks like a library search request.",
        "I will search the active Zotero library for relevant papers.",
      ];
    case "existing-paper-contexts":
      return [
        "Existing paper contexts already look relevant.",
        "I will reuse those papers before answering.",
      ];
    case "active-paper":
      return [
        "The current paper looks sufficient for this request.",
        "I will ground the answer on the active paper first.",
      ];
    default:
      return ["No extra Zotero retrieval is needed for this request."];
  }
}

function buildFallbackPlan(params: AgentPlannerContext): AgentQueryPlan {
  const question = sanitizeText(params.question || "");
  const libraryAvailable = Number(params.libraryID) > 0;
  const existingPaperContexts = dedupePaperContexts([
    ...(params.paperContexts || []),
    ...(params.pinnedPaperContexts || []),
    ...(params.recentPaperContexts || []),
  ]);
  const activePaperAvailable = Boolean(params.activePaperContext);

  if (libraryAvailable && isLibraryOverviewQuery(question)) {
    return {
      action: "library-overview",
      maxPapersToRead: 8,
      traceLines: getFallbackTraceLines("library-overview"),
    };
  }
  if (
    existingPaperContexts.length &&
    !questionExplicitlyTargetsLibrary(question)
  ) {
    return {
      action: "existing-paper-contexts",
      maxPapersToRead: Math.min(existingPaperContexts.length, 6),
      traceLines: getFallbackTraceLines("existing-paper-contexts"),
    };
  }
  if (
    libraryAvailable &&
    isLibraryScopedSearchQuery(question, params.conversationMode)
  ) {
    return {
      action: "library-search",
      searchQuery: question,
      maxPapersToRead: 6,
      traceLines: getFallbackTraceLines("library-search"),
    };
  }
  if (activePaperAvailable) {
    return {
      action: "active-paper",
      maxPapersToRead: 1,
      traceLines: getFallbackTraceLines("active-paper"),
    };
  }
  return {
    action: "skip",
    maxPapersToRead: 1,
    traceLines: getFallbackTraceLines("skip"),
  };
}

function normalizeAction(value: unknown): AgentPlannerAction | null {
  switch (sanitizeText(String(value || "")).trim().toLowerCase()) {
    case "skip":
    case "active-paper":
    case "existing-paper-contexts":
    case "library-overview":
    case "library-search":
      return sanitizeText(String(value || "")).trim().toLowerCase() as AgentPlannerAction;
    default:
      return null;
  }
}

function normalizePlan(
  rawPlan: unknown,
  fallback: AgentQueryPlan,
): AgentQueryPlan {
  if (!rawPlan || typeof rawPlan !== "object") return fallback;
  const typed = rawPlan as {
    action?: unknown;
    searchQuery?: unknown;
    maxPapersToRead?: unknown;
    traceLines?: unknown;
  };
  const action = normalizeAction(typed.action) || fallback.action;
  const searchQuery =
    action === "library-search"
      ? normalizeSearchQuery(typed.searchQuery) || fallback.searchQuery || ""
      : "";
  return {
    action,
    searchQuery: searchQuery || undefined,
    maxPapersToRead: clampPapersToRead(
      typed.maxPapersToRead,
      fallback.maxPapersToRead,
    ),
    traceLines: normalizeTraceLines(
      typed.traceLines,
      getFallbackTraceLines(action),
    ),
  };
}

function buildPlannerPrompt(params: AgentPlannerContext): string {
  const libraryAvailable = Number(params.libraryID) > 0 ? "yes" : "no";
  const activePaper = params.activePaperContext
    ? `${formatPaperCitationLabel(params.activePaperContext)} - ${params.activePaperContext.title}`
    : "none";
  const selectedPapers = summarizePaperContexts(params.paperContexts, 4);
  const pinnedPapers = summarizePaperContexts(params.pinnedPaperContexts, 4);
  const recentPapers = summarizePaperContexts(params.recentPaperContexts, 4);
  const question = sanitizeText(params.question || "").trim() || "(empty)";

  return [
    "You are the planning step for a Zotero research assistant.",
    "Do not answer the user's question.",
    "Choose the best retrieval action before the final answer model runs.",
    "",
    "Available actions:",
    '- "skip": no extra Zotero retrieval',
    '- "active-paper": use only the current paper',
    '- "existing-paper-contexts": use already selected/pinned/recent paper contexts',
    '- "library-overview": inspect the active Zotero library as a whole',
    '- "library-search": search the active Zotero library for relevant papers',
    "",
    "Return JSON only with this schema:",
    '{"action":"skip|active-paper|existing-paper-contexts|library-overview|library-search","searchQuery":"string","maxPapersToRead":6,"traceLines":["short public step","short public step"]}',
    "",
    "Rules:",
    "- traceLines are public UI log lines, not hidden reasoning.",
    "- Use 1 to 4 traceLines.",
    "- Each trace line must be concise, factual, and under 120 characters.",
    '- If action is not "library-search", use an empty searchQuery.',
    "- If the user asks about the whole library, all papers, counts, or an overview, prefer library-overview.",
    "- If the request is about the current paper only, prefer active-paper.",
    "- If existing selected/pinned papers are already sufficient, prefer existing-paper-contexts.",
    "",
    `User question: ${question}`,
    `Conversation mode: ${params.conversationMode}`,
    `Active library available: ${libraryAvailable}`,
    `Active paper: ${activePaper}`,
    `Selected paper contexts: ${selectedPapers}`,
    `Pinned paper contexts: ${pinnedPapers}`,
    `Recent paper contexts: ${recentPapers}`,
  ].join("\n");
}

export async function planAgentQuery(
  params: AgentPlannerContext,
): Promise<AgentQueryPlan> {
  const fallback = buildFallbackPlan(params);
  if (!sanitizeText(params.question || "").trim()) {
    return fallback;
  }

  try {
    const raw = await callLLM({
      prompt: buildPlannerPrompt(params),
      model: params.model,
      apiBase: params.apiBase,
      apiKey: params.apiKey,
      reasoning: params.reasoning,
      temperature: 0,
      maxTokens: 500,
    });
    const jsonText = findAgentPlanJsonObject(raw);
    if (!jsonText) return fallback;
    return parseAgentQueryPlan(jsonText, fallback);
  } catch (err) {
    ztoolkit.log("LLM: Agent planner failed, using fallback", err);
    return fallback;
  }
}

export function parseAgentQueryPlan(
  raw: string,
  fallback: AgentQueryPlan,
): AgentQueryPlan {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return normalizePlan(parsed, fallback);
  } catch (_err) {
    return fallback;
  }
}

export function buildFallbackAgentQueryPlan(
  params: AgentPlannerContext,
): AgentQueryPlan {
  return buildFallbackPlan(params);
}
