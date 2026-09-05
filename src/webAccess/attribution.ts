import type { AgentRunEventRecord } from "../agent/types";
import { normalizePublicWebUrl } from "./tavilyClient";
import type {
  WebSourceAnchor,
  WebSourceDisplay,
  WebSourceRecord,
} from "./types";

const MARKER_PREFIX = "<!--llm-web-source:";
const COMPLETE_MARKER_PATTERN = /<!--llm-web-source:([^<>]*?)-->/g;
const SOURCE_ID_PATTERN = /^web_[a-z0-9]+$/;

function findStreamingMarkerStart(line: string): number {
  const completePrefixStart = line.indexOf(MARKER_PREFIX);
  if (completePrefixStart >= 0) return completePrefixStart;
  for (let length = MARKER_PREFIX.length - 1; length > 0; length -= 1) {
    if (line.endsWith(MARKER_PREFIX.slice(0, length))) {
      return line.length - length;
    }
  }
  return -1;
}

export type WebToolExecutionRecord = {
  name: string;
  ok: boolean;
  content?: unknown;
};

export type WebAttributionAssessment =
  | { status: "not_used"; cleanText: string; anchors: [] }
  | {
      status: "valid";
      cleanText: string;
      anchors: WebSourceAnchor[];
    }
  | {
      status: "invalid";
      cleanText: string;
      anchors: [];
      reason: string;
      correctionPrompt: string;
    };

type MarkerOccurrence = {
  start: number;
  end: number;
  value: string;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeOptionalPublicWebUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    return normalizePublicWebUrl(value);
  } catch {
    return undefined;
  }
}

function normalizeSource(value: unknown): WebSourceDisplay | null {
  const source = asObject(value);
  if (!source) return null;
  const sourceId =
    typeof source.sourceId === "string" ? source.sourceId.trim() : "";
  if (!SOURCE_ID_PATTERN.test(sourceId)) return null;
  try {
    const url = normalizePublicWebUrl(source.url);
    const parsed = new URL(url);
    const hostname =
      typeof source.hostname === "string" && source.hostname.trim()
        ? source.hostname.trim().toLowerCase()
        : parsed.hostname.toLowerCase().replace(/^www\./, "");
    const organization =
      typeof source.organization === "string" && source.organization.trim()
        ? source.organization.trim()
        : hostname;
    const title =
      typeof source.title === "string" && source.title.trim()
        ? source.title.trim()
        : hostname;
    const faviconUrl = normalizeOptionalPublicWebUrl(source.faviconUrl);
    return {
      sourceId,
      url,
      hostname,
      organization,
      title,
      ...(faviconUrl ? { faviconUrl } : {}),
    };
  } catch {
    return null;
  }
}

function mergeSource(
  current: WebSourceDisplay,
  incoming: WebSourceDisplay,
): WebSourceDisplay {
  if (current.url !== incoming.url) return current;
  const faviconUrl = current.faviconUrl || incoming.faviconUrl;
  return {
    ...current,
    organization:
      current.organization === current.hostname
        ? incoming.organization
        : current.organization,
    title: current.title === current.hostname ? incoming.title : current.title,
    ...(faviconUrl ? { faviconUrl } : {}),
  };
}

export function collectSuccessfulWebSources(
  records: readonly WebToolExecutionRecord[],
): {
  webToolsRan: boolean;
  sources: Map<string, WebSourceDisplay>;
  invalidSourceIds: Set<string>;
} {
  const sources = new Map<string, WebSourceDisplay>();
  const invalidSourceIds = new Set<string>();
  let webToolsRan = false;
  for (const record of records) {
    if (record.name !== "web_search" && record.name !== "web_read") continue;
    webToolsRan = true;
    if (!record.ok) continue;
    const content = asObject(record.content);
    const candidates =
      record.name === "web_search" ? content?.results : content?.pages;
    if (!Array.isArray(candidates)) continue;
    for (const candidate of candidates) {
      const raw = asObject(candidate);
      const rawId =
        typeof raw?.sourceId === "string" ? raw.sourceId.trim() : "";
      const source = normalizeSource(candidate);
      if (!source) {
        if (rawId) invalidSourceIds.add(rawId);
        continue;
      }
      const current = sources.get(source.sourceId);
      if (current && current.url !== source.url) {
        sources.delete(source.sourceId);
        invalidSourceIds.add(source.sourceId);
        continue;
      }
      if (!invalidSourceIds.has(source.sourceId)) {
        sources.set(
          source.sourceId,
          current ? mergeSource(current, source) : source,
        );
      }
    }
  }
  return { webToolsRan, sources, invalidSourceIds };
}

function collectMarkersOutsideFences(text: string): MarkerOccurrence[] {
  const markers: MarkerOccurrence[] = [];
  let offset = 0;
  let fence: { character: "`" | "~"; length: number } | null = null;
  for (const lineWithBreak of text.match(/[^\n]*(?:\n|$)/g) || []) {
    if (!lineWithBreak) continue;
    const line = lineWithBreak.endsWith("\n")
      ? lineWithBreak.slice(0, -1)
      : lineWithBreak;
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const token = fenceMatch[1];
      const character = token[0] as "`" | "~";
      if (!fence) {
        fence = { character, length: token.length };
      } else if (
        fence.character === character &&
        token.length >= fence.length
      ) {
        fence = null;
      }
      offset += lineWithBreak.length;
      continue;
    }
    if (!fence) {
      COMPLETE_MARKER_PATTERN.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = COMPLETE_MARKER_PATTERN.exec(line))) {
        markers.push({
          start: offset + match.index,
          end: offset + match.index + match[0].length,
          value: match[1].trim(),
        });
      }
    }
    offset += lineWithBreak.length;
  }
  return markers;
}

function stripOccurrences(
  text: string,
  markers: readonly MarkerOccurrence[],
): string {
  let clean = "";
  let cursor = 0;
  for (const marker of markers) {
    clean += text.slice(cursor, marker.start);
    cursor = marker.end;
  }
  return clean + text.slice(cursor);
}

function preserveDeclaredParagraphBoundaries(
  text: string,
  markers: readonly MarkerOccurrence[],
): string {
  let normalized = text;
  for (const marker of [...markers].reverse()) {
    const after = normalized.slice(marker.end);
    if (!after.startsWith("\n") || after.startsWith("\n\n")) continue;
    const nextLine = after.slice(1).split("\n", 1)[0] || "";
    if (!nextLine.trim()) continue;
    // A following list marker is already a CommonMark block boundary. Adding
    // a blank line would turn a compact list into a loose one.
    if (/^\s*(?:[-+*]|\d{1,9}[.)])\s+/.test(nextLine)) continue;
    normalized = `${normalized.slice(0, marker.end)}\n${normalized.slice(marker.end)}`;
  }
  return normalized;
}

function hasResidualMarkerOutsideFences(text: string): boolean {
  let fence: { character: "`" | "~"; length: number } | null = null;
  for (const lineWithBreak of text.match(/[^\n]*(?:\n|$)/g) || []) {
    if (!lineWithBreak) continue;
    const line = lineWithBreak.endsWith("\n")
      ? lineWithBreak.slice(0, -1)
      : lineWithBreak;
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const token = fenceMatch[1];
      const character = token[0] as "`" | "~";
      if (!fence) fence = { character, length: token.length };
      else if (fence.character === character && token.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (
      !fence &&
      line.replace(COMPLETE_MARKER_PATTERN, "").includes(MARKER_PREFIX)
    ) {
      return true;
    }
  }
  return false;
}

function cleanOffsetForMarker(
  marker: MarkerOccurrence,
  priorMarkers: readonly MarkerOccurrence[],
): number {
  const removedBefore = priorMarkers
    .filter((prior) => prior.start < marker.start)
    .reduce((sum, prior) => sum + prior.end - prior.start, 0);
  return marker.start - removedBefore;
}

function buildCorrectionPrompt(
  reason: string,
  sourceIds: readonly string[],
): string {
  const available = sourceIds.length ? sourceIds.join(", ") : "none";
  return [
    "Correct the web attribution in your final answer.",
    reason,
    `Available successful source IDs: ${available}.`,
    "At the exact end of each prose paragraph that uses web information, append <!--llm-web-source:SOURCE_ID[,SOURCE_ID...]-->.",
    "Use only the listed IDs, do not place markers inside code fences, and do not add a sources footer.",
    "If the answer uses no web information, append <!--llm-web-source:none--> once at the very end instead.",
  ].join("\n");
}

function invalidAssessment(
  text: string,
  markers: readonly MarkerOccurrence[],
  reason: string,
  sourceIds: readonly string[],
): WebAttributionAssessment {
  return {
    status: "invalid",
    cleanText: stripOccurrences(text, markers),
    anchors: [],
    reason,
    correctionPrompt: buildCorrectionPrompt(reason, sourceIds),
  };
}

export function assessWebAttribution(
  text: string,
  records: readonly WebToolExecutionRecord[],
): WebAttributionAssessment {
  const collected = collectSuccessfulWebSources(records);
  const initialMarkers = collectMarkersOutsideFences(text);
  const normalizedText = collected.webToolsRan
    ? preserveDeclaredParagraphBoundaries(text, initialMarkers)
    : text;
  const markers = collectMarkersOutsideFences(normalizedText);
  if (!collected.webToolsRan) {
    return {
      status: "not_used",
      cleanText: stripOccurrences(normalizedText, markers),
      anchors: [],
    };
  }
  const sourceIds = Array.from(collected.sources.keys());
  if (hasResidualMarkerOutsideFences(normalizedText)) {
    return invalidAssessment(
      normalizedText,
      markers,
      "A web source marker is incomplete or malformed.",
      sourceIds,
    );
  }
  if (!markers.length) {
    return invalidAssessment(
      normalizedText,
      markers,
      "The answer omitted the required paragraph-level web source markers.",
      sourceIds,
    );
  }

  const anchors: WebSourceAnchor[] = [];
  let sawNone = false;
  const markerLines = new Set<number>();
  for (const [index, marker] of markers.entries()) {
    const lineStart = normalizedText.lastIndexOf("\n", marker.start - 1) + 1;
    const lineEndRaw = normalizedText.indexOf("\n", marker.end);
    const lineEnd = lineEndRaw < 0 ? normalizedText.length : lineEndRaw;
    if (normalizedText.slice(marker.end, lineEnd).trim()) {
      return invalidAssessment(
        normalizedText,
        markers,
        "Each marker must be the final content on its paragraph line.",
        sourceIds,
      );
    }
    if (markerLines.has(lineStart)) {
      return invalidAssessment(
        normalizedText,
        markers,
        "Each paragraph may contain only one web source marker.",
        sourceIds,
      );
    }
    markerLines.add(lineStart);
    if (marker.value === "none") {
      sawNone = true;
      if (markers.length !== 1 || normalizedText.slice(marker.end).trim()) {
        return invalidAssessment(
          normalizedText,
          markers,
          "The none marker may appear only once, at the end of the answer.",
          sourceIds,
        );
      }
      continue;
    }
    if (!normalizedText.slice(lineStart, marker.start).trim()) {
      return invalidAssessment(
        normalizedText,
        markers,
        "Each marker must follow paragraph text on the same line.",
        sourceIds,
      );
    }
    if (sawNone) {
      return invalidAssessment(
        normalizedText,
        markers,
        "The none marker cannot be combined with source citations.",
        sourceIds,
      );
    }
    const ids = Array.from(
      new Set(marker.value.split(",").map((value) => value.trim())),
    );
    if (!ids.length || ids.some((id) => !SOURCE_ID_PATTERN.test(id))) {
      return invalidAssessment(
        normalizedText,
        markers,
        "A web source marker contains an invalid source ID.",
        sourceIds,
      );
    }
    if (
      ids.some(
        (id) =>
          collected.invalidSourceIds.has(id) || !collected.sources.has(id),
      )
    ) {
      return invalidAssessment(
        normalizedText,
        markers,
        "A web source marker cites an unknown, unsafe, or failed result.",
        sourceIds,
      );
    }
    anchors.push({
      offset: cleanOffsetForMarker(marker, markers.slice(0, index)),
      sources: ids.map((id) => collected.sources.get(id)!),
    });
  }
  if (sawNone && anchors.length) {
    return invalidAssessment(
      normalizedText,
      markers,
      "The none marker cannot be combined with source citations.",
      sourceIds,
    );
  }
  return {
    status: "valid",
    cleanText: sawNone
      ? stripOccurrences(normalizedText, markers).trimEnd()
      : stripOccurrences(normalizedText, markers),
    anchors,
  };
}

/** Remove complete and still-streaming markers without touching code fences. */
export function stripWebSourceMarkersForDisplay(text: string): string {
  let output = "";
  let fence: { character: "`" | "~"; length: number } | null = null;
  for (const lineWithBreak of text.match(/[^\n]*(?:\n|$)/g) || []) {
    if (!lineWithBreak) continue;
    const hasBreak = lineWithBreak.endsWith("\n");
    const line = hasBreak ? lineWithBreak.slice(0, -1) : lineWithBreak;
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const token = fenceMatch[1];
      const character = token[0] as "`" | "~";
      if (!fence) fence = { character, length: token.length };
      else if (fence.character === character && token.length >= fence.length) {
        fence = null;
      }
      output += lineWithBreak;
      continue;
    }
    if (fence) {
      output += lineWithBreak;
      continue;
    }
    const markerStart = findStreamingMarkerStart(line);
    let cleanLine = line;
    if (markerStart >= 0) cleanLine = line.slice(0, markerStart);
    cleanLine = cleanLine.replace(COMPLETE_MARKER_PATTERN, "");
    output += cleanLine + (hasBreak ? "\n" : "");
  }
  return output;
}

export function getWebSourceAnchorsFromTrace(
  events: readonly AgentRunEventRecord[],
): WebSourceAnchor[] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const payload = events[index]?.payload;
    if (payload?.type === "final" && payload.webSourceAnchors?.length) {
      return payload.webSourceAnchors;
    }
  }
  return [];
}
