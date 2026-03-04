/**
 * agentStep.ts
 *
 * One iteration of the ReAct loop: build a context snapshot, call the LLM once,
 * and parse the response into an AgentStepDecision (stop | tool call).
 *
 * Unlike the old two-call planner/continuation design, there is no hardcoded
 * routing logic — the model sees its full context and decides what to do next.
 */

import { callLLM, type ReasoningConfig } from "../../../utils/llmClient";
import { getAgentToolDefinitions } from "./Tools/registry";
import { formatPaperContextReferenceLabel } from "../paperAttribution";
import { isLibraryOverviewQuery, isLibraryScopedSearchQuery } from "./context";
import { sanitizeText } from "../textUtils";
import {
  MAX_AGENT_TRACE_LINES,
  MAX_AGENT_TRACE_LINE_LENGTH,
} from "./config";
import type { AgentStepContext, AgentStepDecision, AgentExecutedStep } from "./types";
import type { AgentToolCall, AgentToolTarget } from "./Tools/types";
import type { PaperContextRef } from "../types";

// ──────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────

function dedupePaperContexts(
  values: (PaperContextRef | null | undefined)[],
): PaperContextRef[] {
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

function formatPaperTargetLine(
  scope: string,
  index: number,
  paper: PaperContextRef,
): string {
  const label = formatPaperContextReferenceLabel(paper);
  return `- ${scope}#${index}: ${label || paper.title}`;
}

function buildAvailableTargetLines(ctx: AgentStepContext): string[] {
  const lines: string[] = [];

  const selected = dedupePaperContexts(ctx.selectedPaperContexts);
  for (const [i, paper] of selected.entries()) {
    lines.push(formatPaperTargetLine("selected-paper", i + 1, paper));
  }

  const pinned = dedupePaperContexts(ctx.pinnedPaperContexts);
  for (const [i, paper] of pinned.entries()) {
    lines.push(formatPaperTargetLine("pinned-paper", i + 1, paper));
  }

  const recent = dedupePaperContexts(ctx.recentPaperContexts);
  for (const [i, paper] of recent.entries()) {
    lines.push(formatPaperTargetLine("recent-paper", i + 1, paper));
  }

  const retrieved = dedupePaperContexts(ctx.retrievedPaperContexts);
  for (const [i, paper] of retrieved.entries()) {
    lines.push(formatPaperTargetLine("retrieved-paper", i + 1, paper));
  }

  if (ctx.activePaperContext) {
    const label = formatPaperContextReferenceLabel(ctx.activePaperContext);
    lines.push(`- active-paper: ${label || ctx.activePaperContext.title}`);
  }

  return lines.length ? lines : ["- (none yet)"];
}

function buildExecutedStepsLines(steps: AgentExecutedStep[]): string[] {
  if (!steps.length) return ["- none"];
  return steps.map((s) => `- ${s.summary}`);
}

function buildHistorySummaryLines(ctx: AgentStepContext): string[] {
  const lines = (ctx.historySummaryLines || [])
    .map((line) => sanitizeText(line).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-8)
    .map((line) => `- ${line}`);
  return lines.length ? lines : ["- none"];
}

function buildContextHint(ctx: AgentStepContext): string {
  const question = sanitizeText(ctx.question || "").trim();
  const hints: string[] = [];
  if (ctx.libraryID > 0) {
    if (isLibraryOverviewQuery(question)) {
      hints.push("Hint: this question asks about the whole library — consider calling list_papers.");
    } else if (isLibraryScopedSearchQuery(question, ctx.conversationMode)) {
      hints.push("Hint: this looks like a paper discovery question — use search_internet to search Semantic Scholar, or list_papers if the user explicitly wants to search their own Zotero library.");
    }
  }
  return hints.join("\n");
}

function buildToolDescriptionLines(): string[] {
  const lines = ["Available tools:"];
  for (const def of getAgentToolDefinitions()) {
    lines.push(`- "${def.name}": ${def.plannerDescription}`);
    lines.push(`  Example: ${def.callExample}`);
  }
  lines.push("");
  lines.push("Target scopes for paper tools:");
  lines.push(
    "  active-paper | selected-paper#N | pinned-paper#N | recent-paper#N | retrieved-paper#N",
  );
  lines.push(
    "  (retrieved-paper#N becomes available after list_papers has been called)",
  );
  return lines;
}

function buildStepPrompt(ctx: AgentStepContext): string {
  const question = sanitizeText(ctx.question || "").trim() || "(empty)";
  const hint = buildContextHint(ctx);

  return [
    "You are the retrieval agent for a Zotero research assistant.",
    "Do NOT answer the user's question. Decide only the next retrieval step.",
    "The main LLM already has access to: paper metadata (title, authors, abstract, year), selected text, and conversation history.",
    "Only retrieve additional content when the question requires specific quoted passages, data, or references not already present in that context.",
    "",
    ...buildToolDescriptionLines(),
    "",
    "Return JSON only — one of:",
    '  Stop:  {"decision":"stop","traceLines":["Sufficient evidence retrieved — ready to answer."]}',
    '  Tool:  {"decision":"tool","call":{<tool JSON>},"traceLines":["Reading evidence from the active paper."]}',
    "",
    "Rules:",
    "- If you already have enough context to answer without any tool — stop immediately.",
    "- Stop as soon as enough grounding exists to answer the question.",
    "- Never repeat a tool call that already appears in \"Steps taken so far\". If a tool shows \"complete\" in the steps, choose stop instead.",
    "- Use find_claim_evidence only when you need specific quoted evidence. For general or conceptual questions already covered by paper context, stop instead.",
    "- Prefer read_references when the user asks what a paper cites.",
    "- Use write_note when the user explicitly asks to write, create, or save a note for a paper. Always populate the query field with the note content instruction extracted from the user's request, stripping agent-directive phrases like 'into the note' or 'save to Zotero'. Example: user says 'write one sentence key point into the note' → query: \"write one sentence key point\". If no specific format is requested, omit query. write_note is a terminal action — call it at most once per request, then stop.",
    "- If the user asks to save/write the previous or last assistant answer into a note and `Previous assistant answer available` is yes, call write_note once and stop.",
    "- Use search_paper_content when the user asks to find or locate a specific term, phrase, or passage within a paper.",
    "- Use get_paper_sections to inspect a paper's structure before targeted retrieval.",
    "- Use search_internet when the user wants to discover or find academic papers (e.g. 'find papers on X', 'search for papers about X', 'what papers exist on X'). This searches Semantic Scholar on the internet. Prefer this over list_papers for open-ended paper discovery questions.",
    "- Use list_papers only when the user explicitly refers to their own Zotero library or collection (e.g. 'in my library', 'do I have papers on', 'search my Zotero'). Also use it to load retrieved-paper#N targets.",
    "- Call list_papers before using retrieved-paper#N targets (they don't exist yet otherwise).",
    "- Use fix_metadata when the user asks to fix, complete, fill in, or update the metadata of a paper (e.g. 'fix the metadata', 'fill in missing fields', 'the author is missing', 'add the abstract'). fix_metadata is a terminal action — call it at most once per request, then stop.",
    "- traceLines: exactly 1 short action line (\u2264 80 chars). State what you are doing or why you are stopping. No multi-sentence reasoning.",
    "",
    `Step ${ctx.iterationIndex + 1} of ${ctx.maxIterations}`,
    `Remaining context budget: ~${ctx.remainingBudgetTokens} tokens`,
    `User question: ${question}`,
    `Conversation mode: ${ctx.conversationMode}`,
    `Library available: ${ctx.libraryID > 0 ? "yes" : "no"}`,
    `Previous assistant answer available: ${ctx.previousAssistantAnswerAvailable ? "yes" : "no"}`,
    ctx.previousAssistantAnswerPreview
      ? `Previous assistant answer preview: ${ctx.previousAssistantAnswerPreview}`
      : "",
    hint,
    "",
    "Recent conversation summary:",
    ...buildHistorySummaryLines(ctx),
    "",
    "Available targets:",
    ...buildAvailableTargetLines(ctx),
    "",
    "Steps taken so far:",
    ...buildExecutedStepsLines(ctx.executedSteps),
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

// ──────────────────────────────────────────────
//  JSON extraction & parsing
// ──────────────────────────────────────────────

/** Extract the first complete JSON object from raw model output. */
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

function normalizeTraceLines(value: unknown): string[] {
  const rawLines = Array.isArray(value) ? value : [];
  return rawLines
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => sanitizeText(entry).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((entry) => entry.slice(0, MAX_AGENT_TRACE_LINE_LENGTH))
    .slice(0, MAX_AGENT_TRACE_LINES);
}

function normalizeToolTarget(value: unknown): AgentToolTarget | null {
  if (!value || typeof value !== "object") return null;
  const typed = value as { scope?: unknown; index?: unknown };
  const scope = sanitizeText(String(typed.scope || "")).trim().toLowerCase();
  switch (scope) {
    case "active-paper":
      return { scope: "active-paper" };
    case "selected-paper":
    case "pinned-paper":
    case "recent-paper":
    case "retrieved-paper": {
      const index = Math.floor(Number(typed.index));
      if (!Number.isFinite(index) || index < 1) return null;
      return { scope, index } as AgentToolTarget;
    }
    default:
      return null;
  }
}

function normalizeToolCall(value: unknown): AgentToolCall | null {
  if (!value || typeof value !== "object") return null;
  const typed = value as {
    name?: unknown;
    target?: unknown;
    query?: unknown;
    limit?: unknown;
  };
  const name = sanitizeText(String(typed.name || ""))
    .trim()
    .toLowerCase();

  if (name === "list_papers") {
    const query = sanitizeText(String(typed.query || "")).trim();
    const rawLimit = Number(typed.limit || 0);
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.max(1, Math.min(12, Math.floor(rawLimit)))
        : 6;
    return { name: "list_papers", query: query || undefined, limit };
  }

  const targetOnlyTools = ["read_paper_text", "find_claim_evidence", "read_references", "get_paper_sections", "write_note", "fix_metadata"] as const;
  if (targetOnlyTools.includes(name as (typeof targetOnlyTools)[number])) {
    const target = normalizeToolTarget(typed.target);
    if (!target) return null;
    const call: AgentToolCall = {
      name: name as (typeof targetOnlyTools)[number],
      target,
    };
    // write_note accepts an optional query as a topic focus
    if (name === "write_note") {
      const query = sanitizeText(String(typed.query || "")).trim();
      if (query) (call as AgentToolCall).query = query;
    }
    return call;
  }

  if (name === "search_paper_content") {
    const target = normalizeToolTarget(typed.target);
    if (!target) return null;
    const query = sanitizeText(String(typed.query || "")).trim();
    if (!query) return null;
    return { name: "search_paper_content", target, query };
  }

  if (name === "search_internet") {
    const query = sanitizeText(String(typed.query || "")).trim();
    if (!query) return null;
    const rawLimit = Number(typed.limit || 0);
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.max(1, Math.min(10, Math.floor(rawLimit)))
        : 6;
    return { name: "search_internet", query, limit };
  }

  return null;
}

function buildFallbackStopDecision(): AgentStepDecision {
  return {
    type: "stop",
    traceLines: ["Stopping — planner returned an unrecognised response."],
  };
}

/** Parse an LLM response string into an AgentStepDecision. */
export function parseAgentStepDecision(raw: string): AgentStepDecision {
  const jsonText = findAgentPlanJsonObject(raw);
  if (!jsonText) return buildFallbackStopDecision();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return buildFallbackStopDecision();
  }

  if (!parsed || typeof parsed !== "object") return buildFallbackStopDecision();
  const typed = parsed as { decision?: unknown; call?: unknown; traceLines?: unknown };
  const decision = sanitizeText(String(typed.decision || "")).trim().toLowerCase();
  const traceLines = normalizeTraceLines(typed.traceLines);

  if (decision === "stop") {
    return { type: "stop", traceLines };
  }

  if (decision === "tool") {
    const call = normalizeToolCall(typed.call);
    if (!call) return buildFallbackStopDecision();
    return { type: "tool", call, traceLines };
  }

  return buildFallbackStopDecision();
}

// ──────────────────────────────────────────────
//  Exported runner
// ──────────────────────────────────────────────

export async function runAgentStep(ctx: AgentStepContext): Promise<AgentStepDecision> {
  const fallback = buildFallbackStopDecision();
  const question = sanitizeText(ctx.question || "").trim();
  if (!question) return fallback;

  try {
    const raw = await callLLM({
      prompt: buildStepPrompt(ctx),
      model: ctx.model,
      apiBase: ctx.apiBase,
      apiKey: ctx.apiKey,
      // reasoning is intentionally omitted: the agent step emits a tiny JSON
      // decision (~100 tokens) and does not benefit from extended thinking.
      // Passing a reasoning config here causes API errors with thinking models
      // because the required budget_tokens (≥1024) exceeds maxTokens (500),
      // and Anthropic thinking requires temperature=1 rather than 0.
      temperature: 0,
      maxTokens: 500,
    });
    return parseAgentStepDecision(raw);
  } catch (err) {
    ztoolkit.log("LLM: Agent step planner failed, stopping", err);
    return fallback;
  }
}

export type { AgentStepContext, AgentStepDecision, AgentExecutedStep };
export type AgentStepRunnerFn = (ctx: AgentStepContext) => Promise<AgentStepDecision>;

// Re-export the LLM params for callers that build them externally
export type AgentStepLLMParams = Pick<
  AgentStepContext,
  "model" | "apiBase" | "apiKey" | "reasoning"
>;
