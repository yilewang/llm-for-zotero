import type { AgentRunEventRecord } from "../../../agent/types";
import { sanitizeText } from "../textUtils";

type CodexToolActivityPayload = Extract<
  AgentRunEventRecord["payload"],
  { type: "codex_tool_activity" }
>;

export const TOOL_ACTIVITY_VISIBLE_DEDUPE_WINDOW_MS = 8000;

export type CodexToolActivityDedupeInput = Pick<
  CodexToolActivityPayload,
  "phase" | "toolName" | "toolLabel" | "args" | "text" | "codeBlock"
>;

function normalizeDedupeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeDedupeValue(entry));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((normalized, key) => {
        const entry = record[key];
        if (entry !== undefined) {
          normalized[key] = normalizeDedupeValue(entry);
        }
        return normalized;
      }, {});
  }
  return value;
}

function stableDedupeJson(value: unknown): string {
  return JSON.stringify(normalizeDedupeValue(value));
}

function normalizeCodexToolNameForDedupe(name: string | undefined): string {
  const clean = sanitizeText(name || "").trim();
  const mcpMatch = clean.match(/^mcp__[^_]+(?:_[^_]+)*__(.+)$/);
  return mcpMatch?.[1] || clean;
}

function normalizeCodexToolIdentityTextForDedupe(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

function normalizeCodexToolIdentityForDedupe(
  toolName: string | undefined,
  toolLabel: string | undefined,
): string {
  const canonicalName = normalizeCodexToolNameForDedupe(toolName);
  if (canonicalName) {
    return normalizeCodexToolIdentityTextForDedupe(canonicalName);
  }
  return normalizeCodexToolIdentityTextForDedupe(
    sanitizeText(toolLabel || "").trim(),
  );
}

function normalizeCodexToolActivityArgsForDedupe(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const clean = sanitizeText(value).trim();
  if (!/^[{\[]/.test(clean)) return value;
  try {
    return JSON.parse(clean);
  } catch {
    return value;
  }
}

export function getToolActivityVisibleDedupeKey(
  payload: CodexToolActivityDedupeInput,
): string {
  const explicitText = sanitizeText(payload.text || "").trim();
  const toolIdentity = explicitText
    ? ""
    : normalizeCodexToolIdentityForDedupe(payload.toolName, payload.toolLabel);
  return stableDedupeJson({
    phase: payload.phase,
    toolIdentity,
    args: normalizeCodexToolActivityArgsForDedupe(payload.args),
    text: explicitText,
    codeBlock: payload.codeBlock || "",
  });
}

export function hasSameToolActivityVisibleIdentity(
  left: CodexToolActivityDedupeInput,
  right: CodexToolActivityDedupeInput,
): boolean {
  return (
    getToolActivityVisibleDedupeKey(left) ===
    getToolActivityVisibleDedupeKey(right)
  );
}

export function isWithinToolActivityDedupeWindow(
  createdAt: number,
  previousCreatedAt: number,
): boolean {
  return (
    Math.abs(createdAt - previousCreatedAt) <=
    TOOL_ACTIVITY_VISIBLE_DEDUPE_WINDOW_MS
  );
}

export function mergeToolActivityPayload(
  previousPayload: CodexToolActivityPayload,
  nextPayload: CodexToolActivityPayload,
): CodexToolActivityPayload {
  return {
    ...previousPayload,
    ...nextPayload,
    toolName: nextPayload.toolName || previousPayload.toolName,
    toolLabel: nextPayload.toolLabel || previousPayload.toolLabel,
    serverName: nextPayload.serverName || previousPayload.serverName,
    args:
      nextPayload.args !== undefined ? nextPayload.args : previousPayload.args,
    codeBlock: nextPayload.codeBlock || previousPayload.codeBlock,
  };
}
