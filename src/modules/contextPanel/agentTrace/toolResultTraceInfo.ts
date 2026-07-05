import type {
  AgentRunEventRecord,
  AgentTraceDetail,
} from "../../../agent/types";
import { sanitizeText } from "../textUtils";

type ToolResultPayload = Extract<
  AgentRunEventRecord["payload"],
  { type: "tool_result" }
>;

export type ToolResultTraceInfo = {
  rowSuffix?: string;
  details: AgentTraceDetail[];
};

function compactTraceText(value: unknown): string {
  const raw = typeof value === "string" ? value : `${value ?? ""}`;
  return sanitizeText(raw).replace(/\s+/g, " ").trim();
}

function normalizeTraceDetail(
  label: string,
  value: unknown,
  kind: AgentTraceDetail["kind"] = "text",
): AgentTraceDetail | null {
  const cleanLabel = compactTraceText(label);
  if (!cleanLabel) return null;
  const cleanValue =
    typeof value === "string"
      ? sanitizeText(value).trim()
      : compactTraceText(value);
  if (!cleanValue) return null;
  return {
    label: cleanLabel,
    value: cleanValue,
    ...(kind ? { kind } : {}),
  };
}

function omitLargeTraceString(value: string): string {
  if (/^data:(?:image|application)\//i.test(value) && value.length > 160) {
    const marker = value.slice(0, 96);
    return `${marker}...[omitted ${value.length - marker.length} chars]`;
  }
  return value;
}

function stringifyTraceJson(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    const seen = new WeakSet<object>();
    const json = JSON.stringify(
      value,
      (_key, entry) => {
        if (typeof entry === "string") {
          return omitLargeTraceString(entry);
        }
        if (entry && typeof entry === "object") {
          if (seen.has(entry)) return "[Circular]";
          seen.add(entry);
        }
        return entry;
      },
      2,
    );
    return json && json !== "{}" && json !== "[]" ? json : null;
  } catch {
    return compactTraceText(value);
  }
}

function buildJsonTraceDetail(
  label: string,
  value: unknown,
): AgentTraceDetail | null {
  const json = stringifyTraceJson(value);
  return json ? normalizeTraceDetail(label, json, "json") : null;
}

function pushTraceDetail(
  details: AgentTraceDetail[],
  label: string,
  value: unknown,
  kind: AgentTraceDetail["kind"] = "text",
): void {
  const detail = normalizeTraceDetail(label, value, kind);
  if (detail) details.push(detail);
}

function dedupeTraceDetails(details: AgentTraceDetail[]): AgentTraceDetail[] {
  const seen = new Set<string>();
  const unique: AgentTraceDetail[] = [];
  for (const detail of details) {
    const normalized = normalizeTraceDetail(
      detail.label,
      detail.value,
      detail.kind || "text",
    );
    if (!normalized) continue;
    const key = `${normalized.label}\u0000${normalized.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(normalized);
  }
  return unique;
}

function formatTraceNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function readNumberedTraceLine(
  line: string,
): { lineNumber: number; text: string } | null {
  const match = line.match(/^\s*(\d+)(?:\t|\s+)(.*)$/);
  if (!match) return null;
  const lineNumber = Number.parseInt(match[1] || "", 10);
  if (!Number.isFinite(lineNumber)) return null;
  return {
    lineNumber,
    text: sanitizeText(match[2] || "").trim(),
  };
}

function readTraceResultLineRange(
  content: string,
): { firstLine: number; lastLine: number } | null {
  const numberedLines = content
    .split(/\r?\n/)
    .map(readNumberedTraceLine)
    .filter(
      (
        entry,
      ): entry is {
        lineNumber: number;
        text: string;
      } => Boolean(entry),
    );
  if (!numberedLines.length) return null;
  return {
    firstLine: numberedLines[0].lineNumber,
    lastLine: numberedLines[numberedLines.length - 1].lineNumber,
  };
}

function formatTraceResultLineRange(
  range: { firstLine: number; lastLine: number } | null,
): string | null {
  if (!range) return null;
  if (range.firstLine === range.lastLine) {
    return `Line ${range.firstLine}`;
  }
  return `Lines ${range.firstLine}-${range.lastLine}`;
}

function stripTraceResultLineNumber(line: string): string {
  const numbered = readNumberedTraceLine(line);
  return numbered ? numbered.text : sanitizeText(line || "").trim();
}

function buildTraceResultPreview(content: string): string | null {
  const maxChars = 420;
  const chunks = content
    .split(/\r?\n/)
    .map(stripTraceResultLineNumber)
    .filter(Boolean);
  let preview = "";
  for (const chunk of chunks) {
    const next = preview ? `${preview}\n${chunk}` : chunk;
    if (next.length > maxChars) {
      const remaining = Math.max(0, maxChars - preview.length - 1);
      if (!preview && chunk.length > maxChars) {
        return `${chunk.slice(0, maxChars).trim()}...`;
      }
      if (remaining > 40) {
        preview = `${preview}\n${chunk.slice(0, remaining).trim()}...`;
      }
      break;
    }
    preview = next;
  }
  return preview || null;
}

export function buildToolResultTraceInfo(
  toolName: string,
  result: ToolResultPayload | undefined,
): ToolResultTraceInfo | null {
  if (!result) return null;
  const details: AgentTraceDetail[] = [];
  let rowSuffix: string | undefined;
  if (typeof result.content === "string" && result.content.trim()) {
    const rangeLabel = formatTraceResultLineRange(
      readTraceResultLineRange(result.content),
    );
    if (rangeLabel) {
      pushTraceDetail(details, "Result range", rangeLabel);
      if (toolName === "Read") {
        rowSuffix = rangeLabel.toLowerCase();
      }
    }
    pushTraceDetail(
      details,
      "Result size",
      `${formatTraceNumber(result.content.length)} chars`,
    );
    pushTraceDetail(
      details,
      "Result preview",
      buildTraceResultPreview(result.content),
    );
  } else if (!result.ok) {
    pushTraceDetail(details, "Result", "Tool failed");
  }
  if (!details.length && result.content !== undefined) {
    const detail = buildJsonTraceDetail("Result", result.content);
    if (detail) details.push(detail);
  }
  if (!details.length) return null;
  return {
    rowSuffix,
    details: dedupeTraceDetails(details),
  };
}
