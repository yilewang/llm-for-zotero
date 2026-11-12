/**
 * The web pages one agent run found and read, from its events (no DOM).
 *
 * The run's pages are the ones web_search found and web_read read. A page
 * the answer cites (its markers) is "cited". The text the agent got for a
 * page (the web_read page text, or else the search snippet) is kept for
 * "What the agent read" (Task progress, `taskProgress/outside.ts`).
 */
import type { AgentRunEventRecord } from "../../agent/types";
import { looseWebUrlKey } from "../../webAccess/sourceLinks";
import { normalizePublicWebUrl } from "../../webAccess/tavilyClient";

export type WebSourceListEntry = {
  url: string;
  hostname: string;
  organization: string;
  title: string;
  faviconUrl?: string;
  /** The agent opened the page with web_read. */
  read: boolean;
  /** The answer cites it (it is behind one of the answer's markers). */
  cited: boolean;
  /** The page text the agent read; else the search snippet; else "". */
  agentText: string;
  /**
   * How much of the page the agent got: a search snippet, the outline only,
   * passages matching its question, some parts, or the whole page.
   */
  coverage: WebSourceCoverage;
};

export type WebSourceCoverage =
  | "none"
  | "snippet"
  | "outline"
  | "passages"
  | "parts"
  | "whole";

/** What web_read gave the agent of one page, over the run. */
type PageReads = {
  passages: string[];
  pieces: { start: number; end: number; text: string }[];
  outline: string[];
  totalChars: number;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** The key two URLs of one page share (scheme, www., hash, utm_* ignored). */
export function webSourceKey(url: string): string {
  return looseWebUrlKey(url) || url;
}

function toEntry(raw: unknown): WebSourceListEntry | null {
  const source = asObject(raw);
  if (!source) return null;
  let url: string;
  try {
    url = normalizePublicWebUrl(source.url);
  } catch {
    return null;
  }
  const hostname = readText(source.hostname).toLowerCase() || hostnameOf(url);
  const faviconUrl = readText(source.faviconUrl);
  return {
    url,
    hostname,
    organization: readText(source.organization) || hostname,
    title: readText(source.title) || hostname,
    ...(faviconUrl ? { faviconUrl } : {}),
    read: false,
    cited: false,
    agentText: "",
    coverage: "none",
  };
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function recordPageRead(reads: PageReads, record: Record<string, unknown>) {
  const content = readText(record.content);
  const total = readNumber(record.totalChars);
  if (total !== null) reads.totalChars = Math.max(reads.totalChars, total);
  const mode = readText(record.readMode) || "passages";
  if (mode === "outline") {
    if (!reads.outline.length && Array.isArray(record.outline)) {
      for (const entry of record.outline) {
        const heading = readText(asObject(entry)?.heading);
        const level = readNumber(asObject(entry)?.level) || 1;
        if (heading) reads.outline.push(`${"  ".repeat(level - 1)}${heading}`);
      }
    }
    return;
  }
  if (!content) return;
  const range = asObject(record.range);
  const start = readNumber(range?.start);
  const end = readNumber(range?.end);
  if (start !== null && end !== null) {
    reads.pieces.push({ start, end, text: content });
  } else if (!reads.passages.includes(content)) {
    reads.passages.push(content);
  }
}

/** The agent's text for a page, and how much of the page that was. */
function summarizePageReads(reads: PageReads): {
  text: string;
  coverage: WebSourceCoverage;
} {
  const pieces = [...reads.pieces].sort(
    (a, b) => a.start - b.start || b.end - a.end,
  );
  const kept: typeof pieces = [];
  let covered = 0;
  let reach = 0;
  for (const piece of pieces) {
    if (kept.length && piece.end <= reach) continue;
    kept.push(piece);
    covered += piece.end - Math.max(piece.start, reach);
    reach = Math.max(reach, piece.end);
  }
  const parts = [...reads.passages, ...kept.map((piece) => piece.text)];
  if (parts.length) {
    const whole =
      kept.length > 0 &&
      reads.totalChars > 0 &&
      covered >= reads.totalChars * 0.98;
    return {
      text: parts.join("\n\n[...]\n\n"),
      coverage: whole ? "whole" : kept.length ? "parts" : "passages",
    };
  }
  if (reads.outline.length) {
    return { text: reads.outline.join("\n\n"), coverage: "outline" };
  }
  return { text: "", coverage: "none" };
}

/** One run's pages, in the order the run first met them. */
export function collectRunWebSources(
  events: readonly Pick<AgentRunEventRecord, "payload">[],
): WebSourceListEntry[] {
  const byKey = new Map<string, WebSourceListEntry>();
  const snippets = new Map<string, string>();
  const readsByKey = new Map<string, PageReads>();
  const add = (raw: unknown, read: boolean) => {
    const entry = toEntry(raw);
    if (!entry) return;
    const key = webSourceKey(entry.url);
    const current = byKey.get(key);
    const record = asObject(raw);
    const content = readText(record?.content);
    const snippet = readText(record?.snippet);
    if (current) {
      if (current.title === current.hostname) current.title = entry.title;
      if (current.organization === current.hostname)
        current.organization = entry.organization;
      if (!current.faviconUrl && entry.faviconUrl)
        current.faviconUrl = entry.faviconUrl;
    } else {
      byKey.set(key, entry);
    }
    const target = byKey.get(key)!;
    if (read && record) {
      target.read = true;
      let reads = readsByKey.get(key);
      if (!reads) {
        reads = { passages: [], pieces: [], outline: [], totalChars: 0 };
        readsByKey.set(key, reads);
      }
      recordPageRead(reads, record);
    }
    if (!snippets.has(key) && (snippet || (!read && content))) {
      snippets.set(key, snippet || content);
    }
  };
  for (const { payload } of events) {
    if (payload?.type === "tool_result" && payload.ok) {
      const content = asObject(payload.content);
      if (payload.name === "web_search" && Array.isArray(content?.results)) {
        for (const result of content.results) add(result, false);
      } else if (payload.name === "web_read" && Array.isArray(content?.pages)) {
        for (const page of content.pages) add(page, true);
      }
    } else if (payload?.type === "final") {
      for (const anchor of payload.webSourceAnchors || []) {
        for (const source of anchor.sources || []) {
          const key = webSourceKey(source.url);
          if (!byKey.has(key)) add(source, false);
          const entry = byKey.get(key);
          if (entry) entry.cited = true;
        }
      }
    }
  }
  for (const [key, entry] of byKey) {
    const reads = readsByKey.get(key);
    const summary = reads
      ? summarizePageReads(reads)
      : { text: "", coverage: "none" as const };
    entry.agentText = summary.text;
    entry.coverage = summary.coverage;
    if (!entry.agentText && snippets.has(key)) {
      entry.agentText = snippets.get(key) || "";
      entry.coverage = "snippet";
    }
  }
  return [...byKey.values()];
}
