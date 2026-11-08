import type { AgentRunEventRecord } from "../agent/types";
import {
  findInlineCodeSpans,
  maskInlineCode,
  protectInlineCode,
  restoreInlineCode,
} from "./inlineCode";
import { collectPaperSources } from "./paperSources";
import {
  extractInlineSourceTokens,
  inlineSourceLinks,
  looseWebUrlKey,
  translateWebSourceLinks,
} from "./sourceLinks";
import { normalizePublicWebUrl } from "./tavilyClient";
import type {
  WebSourceAnchor,
  WebSourceDisplay,
  WebSourceRecord,
} from "./types";

const MARKER_PREFIX = "<!--llm-web-source:";
const COMPLETE_MARKER_PATTERN = /<!--llm-web-source:([^<>]*?)-->/g;
const SOURCE_ID_PATTERN = /^web_[a-z0-9]+$/;
const ANY_SOURCE_ID_PATTERN = /^(?:web|paper)_[a-z0-9]+$/;
const MARKER_BEFORE_PUNCTUATION_PATTERN =
  /[ \t]*<!--llm-web-source:[^<>]*?-->(?=[,.;:!?)\]，。；：！？）])/g;

const TABLE_ROW_PATTERN = /^\s*\|/;

const VARIANT_MARKER_PATTERN = /<!--\s*llm-web-source\s*:\s*([^<>]*?)\s*-->/gi;
const WRAPPED_MARKER_PATTERN =
  /^`\s*<!--\s*llm-web-source\s*:\s*([^<>]*?)\s*-->\s*`$/i;
const RESIDUAL_MARKER_PATTERN = /<!--\s*llm-web-source/i;
const STREAMING_MARKER_WORD = "llm-web-source:";
/**
 * A marker's sources: "web_3,web_5" or, with the exact words the answer took
 * from each, 'web_3="words from the page",web_5'. A phrase holds no double
 * quote; curly quotes around it are taken too.
 */
export function parseWebSourceMarkerValue(value: string): {
  ids: string[];
  phrases: Record<string, string>;
} {
  const ids: string[] = [];
  const phrases: Record<string, string> = {};
  const entry = /^\s*([^,="“”]*?)\s*(?:=\s*["“]([^"“”]*)["”]?)?\s*(?:,|$)/;
  let rest = value;
  while (rest.trim()) {
    const match = entry.exec(rest);
    if (!match || !match[0]) break;
    const id = match[1].trim();
    const phrase = (match[2] || "").replace(/\s+/g, " ").trim();
    if (id) {
      if (!ids.includes(id)) ids.push(id);
      if (phrase && !phrases[id]) phrases[id] = phrase;
    }
    rest = rest.slice(match[0].length);
  }
  return { ids, phrases };
}

function formatMarkerValue(
  ids: readonly string[],
  phrases: Readonly<Record<string, string>>,
): string {
  return ids
    .map((id) => (phrases[id] ? `${id}="${phrases[id]}"` : id))
    .join(",");
}

function canonicalMarker(rawIds: string): string {
  const parsed = parseWebSourceMarkerValue(rawIds);
  const phrases: Record<string, string> = {};
  const ids = parsed.ids.map((id) => {
    const lower = id.toLowerCase();
    if (parsed.phrases[id]) phrases[lower] = parsed.phrases[id];
    return lower;
  });
  return `${MARKER_PREFIX}${formatMarkerValue(ids, phrases)}-->`;
}

function canonicalizeLine(line: string): string {
  let output = "";
  let cursor = 0;
  const canonicalizeProse = (prose: string) =>
    prose.replace(VARIANT_MARKER_PATTERN, (_found, ids: string) =>
      canonicalMarker(ids),
    );
  for (const span of findInlineCodeSpans(line)) {
    output += canonicalizeProse(line.slice(cursor, span.start));
    const code = line.slice(span.start, span.end);
    // A code span that holds only a marker is the model quoting the marker;
    // a longer span is code and stays as written.
    const wrapped = code.match(WRAPPED_MARKER_PATTERN);
    output += wrapped ? canonicalMarker(wrapped[1]) : code;
    cursor = span.end;
  }
  return output + canonicalizeProse(line.slice(cursor));
}

/**
 * Rewrite marker variants (spaces inside, any letter case, a pair of wrapping
 * backticks) to the canonical marker. Fenced code and longer inline code
 * spans stay as written.
 */
export function canonicalizeWebSourceMarkers(text: string): string {
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
    output += fence
      ? lineWithBreak
      : canonicalizeLine(line) + (hasBreak ? "\n" : "");
  }
  return output;
}

/**
 * Where a still-streaming marker starts on the line's last characters, or -1.
 * Inline code must already be protected; a backtick left in the line opens a
 * code span that has not closed yet.
 */
function findStreamingMarkerStart(line: string): number {
  let start = -1;
  // An unclosed comment cuts the line only when it is becoming a marker; an
  // ordinary comment such as <!-- draft stays visible.
  for (
    let commentStart = line.indexOf("<!--");
    commentStart >= 0 && start < 0;
    commentStart = line.indexOf("<!--", commentStart + 4)
  ) {
    if (line.includes("-->", commentStart + 4)) continue;
    const word = line
      .slice(commentStart + 4)
      .replace(/\s+/g, "")
      .toLowerCase();
    if (
      STREAMING_MARKER_WORD.startsWith(word) ||
      word.startsWith(STREAMING_MARKER_WORD)
    ) {
      start = commentStart;
    }
  }
  if (start < 0) {
    for (let length = 3; length > 0; length -= 1) {
      if (line.endsWith(MARKER_PREFIX.slice(0, length))) {
        start = line.length - length;
        break;
      }
    }
  }
  if (start < 0) return -1;
  // A backtick right before the marker may be its wrapping pair; any other
  // open backtick means the marker-like text is code.
  if (line[start - 1] === "`" && !line.slice(0, start - 1).includes("`")) {
    return start - 1;
  }
  return line.slice(0, start).includes("`") ? -1 : start;
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
      /** Raw values of the markers that could not be placed. */
      dropped: string[];
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
  /** Pages read with web_read, in record order. */
  readSourceIds: string[];
  /** web_search results, in record order. */
  searchSourceIds: string[];
} {
  const sources = new Map<string, WebSourceDisplay>();
  const invalidSourceIds = new Set<string>();
  const readSourceIds: string[] = [];
  const searchSourceIds: string[] = [];
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
        const ids =
          record.name === "web_read" ? readSourceIds : searchSourceIds;
        if (!ids.includes(source.sourceId)) ids.push(source.sourceId);
      }
    }
  }
  // A later record can invalidate an ID that an earlier one listed.
  const valid = (id: string) => sources.has(id) && !invalidSourceIds.has(id);
  return {
    webToolsRan,
    sources,
    invalidSourceIds,
    readSourceIds: readSourceIds.filter(valid),
    searchSourceIds: searchSourceIds.filter(valid),
  };
}

/**
 * Every source a run's tools returned: its web pages (web_search, web_read)
 * and its scholarly papers (literature_search, literature_read), by source
 * id, and every link that names one of them (by looseWebUrlKey).
 */
export type SourceCatalog = {
  sources: Map<string, WebSourceDisplay>;
  linkIds: Map<string, string>;
};

export function buildSourceCatalog(
  records: readonly WebToolExecutionRecord[],
): SourceCatalog {
  const web = collectSuccessfulWebSources(records);
  const papers = collectPaperSources(records);
  const sources = new Map(papers.sources);
  const linkIds = new Map(papers.linkIds);
  for (const [id, source] of web.sources) {
    if (web.invalidSourceIds.has(id)) continue;
    sources.set(id, source);
    // A page the agent opened on the web is that page, even when it is also
    // a paper's landing page.
    const key = looseWebUrlKey(source.url);
    if (key) linkIds.set(key, id);
  }
  return { sources, linkIds };
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
      const searchable = maskInlineCode(line);
      COMPLETE_MARKER_PATTERN.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = COMPLETE_MARKER_PATTERN.exec(searchable))) {
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
    // A blank line inside a table ends it and turns later rows into text.
    if (TABLE_ROW_PATTERN.test(nextLine)) continue;
    const lineStart = normalized.lastIndexOf("\n", marker.start - 1) + 1;
    if (TABLE_ROW_PATTERN.test(normalized.slice(lineStart, marker.start))) {
      continue;
    }
    // A following list marker is already a CommonMark block boundary. Adding
    // a blank line would turn a compact list into a loose one.
    if (/^\s*(?:[-+*]|\d{1,9}[.)])\s+/.test(nextLine)) continue;
    normalized = `${normalized.slice(0, marker.end)}\n${normalized.slice(marker.end)}`;
  }
  return normalized;
}

/**
 * Remove an unfinished marker fragment (such as "<!--llm-web-source:web_")
 * and the rest of its line. Fenced and inline code stay as written.
 */
function stripResidualMarkerFragments(text: string): {
  text: string;
  found: boolean;
} {
  let output = "";
  let found = false;
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
    // Blank out code and complete markers; offsets stay the same.
    const searchable = fence
      ? ""
      : maskInlineCode(line).replace(COMPLETE_MARKER_PATTERN, (marker) =>
          "\u0000".repeat(marker.length),
        );
    const fragment = searchable.search(RESIDUAL_MARKER_PATTERN);
    if (fragment < 0) {
      output += lineWithBreak;
      continue;
    }
    found = true;
    output += line.slice(0, fragment).trimEnd() + (hasBreak ? "\n" : "");
  }
  return { text: output, found };
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

/**
 * Merge several or non-final markers on one line into a single final marker.
 * Lines the contract cannot express (none, empty value) stay unchanged.
 */
function repairMidLineMarkers(text: string): string {
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
    output += fence ? lineWithBreak : repairLine(line) + (hasBreak ? "\n" : "");
  }
  return output;
}

function repairLine(rawLine: string): string {
  const { text: line, spans } = protectInlineCode(rawLine);
  return restoreInlineCode(repairProtectedLine(line), spans);
}

function repairProtectedLine(line: string): string {
  const matches = Array.from(line.matchAll(COMPLETE_MARKER_PATTERN));
  if (!matches.length) return line;
  // Moving a marker out of a table cell would change the row; leave it for the
  // validator to reject.
  if (TABLE_ROW_PATTERN.test(line)) return line;
  const last = matches[matches.length - 1];
  if (
    matches.length === 1 &&
    !line.slice(last.index! + last[0].length).trim()
  ) {
    return line;
  }
  if (matches.some((match) => !match[1].trim() || match[1].trim() === "none")) {
    return line;
  }
  // A space the model put before a marker would otherwise end up before the
  // punctuation that followed it ("page , while").
  const prose = line
    .replace(MARKER_BEFORE_PUNCTUATION_PATTERN, "")
    .replace(
      /([ \t]*)<!--llm-web-source:[^<>]*?-->[ \t]*/g,
      (found, indent: string, offset: number, whole: string) => {
        // Keep a line's indentation; it can place the line inside a list.
        if (!whole.slice(0, offset).trim()) return indent;
        return whole.slice(offset + found.length).trim() ? " " : "";
      },
    );
  if (!prose.trim()) return line;
  const ids: string[] = [];
  const phrases: Record<string, string> = {};
  for (const match of matches) {
    const parsed = parseWebSourceMarkerValue(match[1]);
    for (const id of parsed.ids) {
      if (!ids.includes(id)) ids.push(id);
      if (parsed.phrases[id] && !phrases[id]) phrases[id] = parsed.phrases[id];
    }
  }
  return `${prose.trimEnd()}${MARKER_PREFIX}${formatMarkerValue(ids, phrases)}-->`;
}

/**
 * Place the answer's sources. A link to a known source (a web page or a
 * scholarly paper this run or an earlier question found) becomes a small
 * marker where it was. A marker that ends a paragraph line gets a chip
 * there; any other marker is removed. When this run used the web and its
 * markers are missing or could not all be used, one end chip lists the
 * pages not shown yet. Attribution never rejects the answer.
 */
export function assessWebAttribution(
  text: string,
  records: readonly WebToolExecutionRecord[],
  options: {
    /** Sources earlier questions of the chat found; follow-ups cite them. */
    earlier?: SourceCatalog;
  } = {},
): WebAttributionAssessment {
  const collected = collectSuccessfulWebSources(records);
  const own = buildSourceCatalog(records);
  const known = new Map(options.earlier?.sources || []);
  const linkIds = new Map(options.earlier?.linkIds || []);
  for (const [id, source] of own.sources) known.set(id, source);
  for (const [key, id] of own.linkIds) linkIds.set(key, id);
  const canonicalText = canonicalizeWebSourceMarkers(text);
  const inlined = known.size
    ? inlineSourceLinks(canonicalText, linkIds)
    : {
        text: canonicalText,
        tokens: [] as string[][],
        phrases: [] as Record<string, string>[],
      };
  const usesSources = collected.webToolsRan || known.size > 0;
  const repairedText = usesSources
    ? repairMidLineMarkers(
        translateWebSourceLinks(inlined.text, collected.sources),
      )
    : inlined.text;
  const initialMarkers = collectMarkersOutsideFences(repairedText);
  const declaredText = usesSources
    ? preserveDeclaredParagraphBoundaries(repairedText, initialMarkers)
    : repairedText;
  const residual = stripResidualMarkerFragments(declaredText);
  const normalizedText = residual.text;
  const markers = collectMarkersOutsideFences(normalizedText);
  if (!usesSources) {
    return {
      status: "not_used",
      cleanText: stripOccurrences(normalizedText, markers),
      anchors: [],
    };
  }

  const soleNone =
    markers.length === 1 &&
    markers[0].value === "none" &&
    !normalizedText.slice(markers[0].end).trim();
  const anchors: WebSourceAnchor[] = [];
  const dropped: string[] = [];
  const endIds: string[] = [];
  let incomplete = residual.found;
  const markerLines = new Set<number>();
  const isKnown = (id: string) =>
    ANY_SOURCE_ID_PATTERN.test(id) &&
    !collected.invalidSourceIds.has(id) &&
    known.has(id);
  for (const [index, marker] of markers.entries()) {
    const lineStart = normalizedText.lastIndexOf("\n", marker.start - 1) + 1;
    const lineEndRaw = normalizedText.indexOf("\n", marker.end);
    const lineEnd = lineEndRaw < 0 ? normalizedText.length : lineEndRaw;
    const firstOnLine = !markerLines.has(lineStart);
    markerLines.add(lineStart);
    // A none marker is removed; next to citations it adds nothing to the
    // end chip.
    if (marker.value === "none") continue;
    const { ids, phrases } = parseWebSourceMarkerValue(marker.value);
    const placed = ids.filter(isKnown);
    if (placed.length < ids.length || !ids.length) incomplete = true;
    const placeable =
      firstOnLine &&
      !normalizedText.slice(marker.end, lineEnd).trim() &&
      Boolean(normalizedText.slice(lineStart, marker.start).trim()) &&
      !TABLE_ROW_PATTERN.test(normalizedText.slice(lineStart, marker.start)) &&
      placed.length > 0;
    if (!placeable) {
      incomplete = true;
      dropped.push(marker.value);
      endIds.push(...placed);
      continue;
    }
    const placedPhrases = phrasesFor(placed, phrases);
    anchors.push({
      offset: cleanOffsetForMarker(marker, markers.slice(0, index)),
      sources: placed.map((id) => known.get(id)!),
      ...(placedPhrases ? { phrases: placedPhrases } : {}),
    });
  }
  const strippedText = stripOccurrences(normalizedText, markers);
  // The inline tokens come out last: every offset so far counts them.
  const extracted = extractInlineSourceTokens(
    strippedText,
    inlined.tokens,
    inlined.phrases,
  );
  for (const anchor of anchors)
    anchor.offset = extracted.mapOffset(anchor.offset);
  for (const entry of extracted.inline) {
    const ids = entry.ids.filter((id) => known.has(id));
    const sources = ids.map((id) => known.get(id)!);
    const inlinePhrases = phrasesFor(ids, entry.phrases);
    if (sources.length)
      anchors.push({
        offset: entry.offset,
        sources,
        placement: "inline",
        ...(inlinePhrases ? { phrases: inlinePhrases } : {}),
      });
  }
  anchors.sort((left, right) => left.offset - right.offset);
  const cleanText = soleNone ? extracted.text.trimEnd() : extracted.text;
  foldRepeatedLineSources(anchors, cleanText);
  if (collected.webToolsRan && !soleNone && (!anchors.length || incomplete)) {
    const shown = new Set(
      anchors.flatMap((anchor) =>
        anchor.sources.map((source) => source.sourceId),
      ),
    );
    const fallbackIds = collected.readSourceIds.length
      ? collected.readSourceIds
      : collected.searchSourceIds;
    const sources = Array.from(new Set([...endIds, ...fallbackIds]))
      .filter((id) => !shown.has(id) && known.has(id))
      .map((id) => known.get(id)!);
    if (sources.length) {
      anchors.push({ offset: cleanText.length, sources, placement: "end" });
    }
  }
  if (!collected.webToolsRan && !anchors.length) {
    return { status: "not_used", cleanText, anchors: [] };
  }
  return { status: "valid", cleanText, anchors, dropped };
}

function phrasesFor(
  ids: readonly string[],
  phrases: Readonly<Record<string, string>>,
): Record<string, string> | null {
  const kept: Record<string, string> = {};
  for (const id of ids) if (phrases[id]) kept[id] = phrases[id];
  return Object.keys(kept).length ? kept : null;
}

/**
 * A source a line already shows with an inline marker (its link) and that
 * the line's end marker repeats, to give its exact words, is shown once: the
 * words go to the inline marker, and an end marker left with no source goes.
 */
function foldRepeatedLineSources(
  anchors: WebSourceAnchor[],
  text: string,
): void {
  const lineOf = (offset: number) => text.lastIndexOf("\n", offset - 1) + 1;
  for (let index = anchors.length - 1; index >= 0; index -= 1) {
    const anchor = anchors[index];
    if (anchor.placement) continue;
    const line = lineOf(anchor.offset);
    const inline = anchors.filter(
      (other) =>
        other.placement === "inline" &&
        other.offset <= anchor.offset &&
        lineOf(other.offset) === line,
    );
    if (!inline.length) continue;
    anchor.sources = anchor.sources.filter((source) => {
      const owner = inline.find((other) =>
        other.sources.some((known) => known.sourceId === source.sourceId),
      );
      if (!owner) return true;
      const phrase = anchor.phrases?.[source.sourceId];
      if (phrase && !owner.phrases?.[source.sourceId])
        owner.phrases = { ...owner.phrases, [source.sourceId]: phrase };
      return false;
    });
    if (anchor.phrases) {
      const kept = phrasesFor(
        anchor.sources.map((source) => source.sourceId),
        anchor.phrases,
      );
      if (kept) anchor.phrases = kept;
      else delete anchor.phrases;
    }
    if (!anchor.sources.length) anchors.splice(index, 1);
  }
}

/** Remove complete and still-streaming markers without touching code fences. */
export function stripWebSourceMarkersForDisplay(rawText: string): string {
  const text = canonicalizeWebSourceMarkers(rawText);
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
    // Remove complete markers wherever they sit; only an unfinished marker,
    // which can only be the end of the streamed text, cuts the line.
    const { text: prose, spans } = protectInlineCode(line);
    let cleanLine = prose
      .replace(MARKER_BEFORE_PUNCTUATION_PATTERN, "")
      .replace(COMPLETE_MARKER_PATTERN, "");
    const markerStart = findStreamingMarkerStart(cleanLine);
    if (markerStart >= 0) cleanLine = cleanLine.slice(0, markerStart);
    output += restoreInlineCode(cleanLine, spans) + (hasBreak ? "\n" : "");
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
