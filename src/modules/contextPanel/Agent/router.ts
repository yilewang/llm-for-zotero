import { callLLM } from "../../../utils/llmClient";
import type {
  AgentToolCall,
  AgentToolName,
  AgentToolTarget,
} from "./ToolInfra/types";
import { sanitizeText } from "../textUtils";
import {
  ROUTER_MODEL_MAX_TOKENS,
  ROUTER_MODEL_TEMPERATURE,
  ROUTER_TRACE_MAX_CHARS,
  SEARCH_INTERNET_DEFAULT_LIMIT,
  SEARCH_INTERNET_MAX_LIMIT,
} from "./config";
import { getToolSpecs } from "./toolBroker";
import type {
  AgentRouterParams,
  RouterDecision,
  RouterContextSummary,
} from "./types";

function findJsonObject(raw: string): string {
  const source = String(raw || "");
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }

    if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        return source.slice(start, i + 1);
      }
    }
  }

  return "";
}

function normalizeTarget(value: unknown): AgentToolTarget | null {
  if (!value || typeof value !== "object") return null;
  const typed = value as { scope?: unknown; index?: unknown };
  const scope = sanitizeText(String(typed.scope || ""))
    .trim()
    .toLowerCase();

  if (scope === "active-paper") {
    return { scope: "active-paper" };
  }

  if (
    scope === "selected-paper" ||
    scope === "pinned-paper" ||
    scope === "recent-paper" ||
    scope === "retrieved-paper"
  ) {
    const index = Math.floor(Number(typed.index));
    if (!Number.isFinite(index) || index < 1) return null;
    return {
      scope,
      index,
    } as AgentToolTarget;
  }

  return null;
}

function normalizeCall(value: unknown): AgentToolCall | null {
  if (!value || typeof value !== "object") return null;
  const typed = value as {
    name?: unknown;
    target?: unknown;
    query?: unknown;
    limit?: unknown;
    depth?: unknown;
  };

  const name = sanitizeText(String(typed.name || ""))
    .trim()
    .toLowerCase();
  if (!name) return null;

  if (name === "list_papers") {
    const query = sanitizeText(String(typed.query || "")).trim();
    const rawLimit = Number(typed.limit || 0);
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.max(1, Math.floor(rawLimit))
        : undefined;
    const rawDepth = sanitizeText(String(typed.depth || ""))
      .trim()
      .toLowerCase();
    if (rawDepth && rawDepth !== "metadata" && rawDepth !== "abstract") {
      return null;
    }
    const depth =
      rawDepth === "abstract" || rawDepth === "metadata"
        ? rawDepth
        : undefined;
    return {
      name: "list_papers",
      query: query || undefined,
      limit,
      depth,
    };
  }

  if (name === "search_internet") {
    const query = sanitizeText(String(typed.query || "")).trim();
    if (!query) return null;
    const rawLimit = Number(typed.limit || 0);
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.max(1, Math.min(SEARCH_INTERNET_MAX_LIMIT, Math.floor(rawLimit)))
        : SEARCH_INTERNET_DEFAULT_LIMIT;
    return {
      name: "search_internet",
      query,
      limit,
    };
  }

  if (name === "search_paper_content") {
    const target = normalizeTarget(typed.target);
    if (!target) return null;
    const query = sanitizeText(String(typed.query || "")).trim();
    if (!query) return null;
    return {
      name: "search_paper_content",
      target,
      query,
    };
  }

  const targetOnlyNames: AgentToolName[] = [
    "read_paper_text",
    "find_claim_evidence",
    "read_references",
    "get_paper_sections",
    "write_note",
    "fix_metadata",
  ];
  if (!targetOnlyNames.includes(name as AgentToolName)) {
    return null;
  }

  const target = normalizeTarget(typed.target);
  if (!target) return null;

  if (name === "find_claim_evidence") {
    const query = sanitizeText(String(typed.query || "")).trim();
    return query
      ? {
          name: "find_claim_evidence",
          target,
          query,
        }
      : {
          name: "find_claim_evidence",
          target,
        };
  }

  if (name === "write_note") {
    const query = sanitizeText(String(typed.query || "")).trim();
    return {
      name: "write_note",
      target,
      query: query || undefined,
    };
  }

  return {
    name: name as AgentToolName,
    target,
  };
}

function normalizeTrace(value: unknown): string {
  const normalized = sanitizeText(String(value || ""))
    .replace(/\s+/g, " ")
    .trim();
  const maxChars = ROUTER_TRACE_MAX_CHARS;
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1).trimEnd()}\u2026`;
}

function buildFallbackStop(reason: string): RouterDecision {
  return {
    decision: "stop",
    trace: "Stopping router due to invalid planner output.",
    stopReason: reason,
  };
}

function recoverCallFromParsedObject(parsed: Record<string, unknown>): AgentToolCall | null {
  const direct = normalizeCall(parsed);
  if (direct) return direct;

  const wrapperCandidates: unknown[] = [
    parsed.call,
    parsed.toolCall,
    parsed.tool_call,
    parsed.tool,
    parsed.action,
    parsed.nextAction,
    parsed.next_action,
  ];

  for (const wrapper of wrapperCandidates) {
    const normalized = normalizeCall(wrapper);
    if (normalized) return normalized;
    if (!wrapper || typeof wrapper !== "object") continue;
    const nested = wrapper as Record<string, unknown>;
    const nestedCall = normalizeCall(nested.call);
    if (nestedCall) return nestedCall;
  }

  return null;
}

export function parseRouterDecision(raw: string): RouterDecision {
  const jsonText = findJsonObject(raw);
  if (!jsonText) {
    return buildFallbackStop("No JSON object returned.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return buildFallbackStop("Invalid JSON returned.");
  }

  if (!parsed || typeof parsed !== "object") {
    return buildFallbackStop("Invalid planner shape.");
  }

  const typed = parsed as {
    decision?: unknown;
    trace?: unknown;
    stopReason?: unknown;
    call?: unknown;
  };

  const decision = sanitizeText(String(typed.decision || ""))
    .trim()
    .toLowerCase();
  const trace = normalizeTrace(typed.trace) || "No router trace provided.";
  const stopReason =
    sanitizeText(String(typed.stopReason || "")).trim() || undefined;

  if (decision === "stop") {
    return {
      decision: "stop",
      trace,
      stopReason,
    };
  }

  const recoveredCall = recoverCallFromParsedObject(
    parsed as Record<string, unknown>,
  );
  const isToolCallDecision =
    decision === "tool_call" ||
    decision === "tool" ||
    decision === "call" ||
    decision === "action" ||
    (!decision && Boolean(recoveredCall));

  if (!isToolCallDecision) {
    return buildFallbackStop("Unknown router decision.");
  }

  const call = normalizeCall(typed.call) || recoveredCall;
  if (!call) {
    return buildFallbackStop("Invalid tool call shape.");
  }

  const spec = getToolSpecs().find((entry) => entry.name === call.name);
  if (!spec || !spec.validate(call)) {
    return buildFallbackStop("Tool call failed validation.");
  }

  return {
    decision: "tool_call",
    trace,
    call,
    stopReason,
  };
}

function buildContextBlock(summary: RouterContextSummary): string {
  return [
    `Step ${summary.iterationIndex + 1} of ${summary.maxIterations}`,
    `Remaining budget tokens: ~${summary.remainingBudgetTokens}`,
    `Conversation mode: ${summary.conversationMode}`,
    `Library available: ${summary.libraryAvailable ? "yes" : "no"}`,
    "",
    "Policy hints:",
    ...(summary.policyHints.length
      ? summary.policyHints.map((line) => `- ${line}`)
      : ["- none"]),
    "",
    "Context descriptors:",
    ...(summary.contextDescriptors.length
      ? summary.contextDescriptors.map((line) => `- ${line}`)
      : ["- none"]),
    "",
    "Recent conversation summary:",
    ...(summary.recentConversationSummary.length
      ? summary.recentConversationSummary.map((line) => `- ${line}`)
      : ["- none"]),
    "",
    "Recent tool logs:",
    ...(summary.recentToolLogs.length
      ? summary.recentToolLogs.map((line) => `- ${line}`)
      : ["- none"]),
    "",
    "Available targets:",
    ...(summary.availableTargets.length
      ? summary.availableTargets.map((line) => `- ${line}`)
      : ["- none"]),
    "",
    "Available tools:",
    ...summary.availableTools.flatMap((tool) => [
      `- ${tool.name}: ${tool.description}`,
      `  inputSchema: ${JSON.stringify(tool.inputSchema)}`,
      `  example: ${tool.callExample}`,
    ]),
  ].join("\n");
}

function buildRouterPrompt(params: AgentRouterParams): string {
  const question =
    sanitizeText(params.summary.question || "").trim() || "(empty)";
  return [
    params.promptPack.routerPrompt,
    "",
    "User question:",
    question,
    "",
    buildContextBlock(params.summary),
  ].join("\n");
}

export async function runAgentRouterStep(
  params: AgentRouterParams,
): Promise<RouterDecision> {
  const question = sanitizeText(params.summary.question || "").trim();
  if (!question) {
    return {
      decision: "stop",
      trace: "Stopping because question is empty.",
      stopReason: "empty_question",
    };
  }

  try {
    const raw = await callLLM({
      prompt: buildRouterPrompt(params),
      model: params.model,
      apiBase: params.apiBase,
      apiKey: params.apiKey,
      signal: params.signal,
      temperature: ROUTER_MODEL_TEMPERATURE,
      maxTokens: ROUTER_MODEL_MAX_TOKENS,
    });

    return parseRouterDecision(raw);
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") {
      throw err;
    }
    ztoolkit.log("LLM: agent router step failed", err);
    return {
      decision: "stop",
      trace: "Stopping because router call failed.",
      stopReason: "router_error",
    };
  }
}
