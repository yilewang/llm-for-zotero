/**
 * What a question got from outside the library, for Task progress: the
 * scholarly papers (literature_search, literature_read) and web pages
 * (web_search, web_read) its run found and read, why it went outside, the
 * sources its answer cites, and whether it searched the library at all.
 *
 * Pure: the live run and the rebuild of a stored conversation both fold a
 * run's events with `buildTaskOutsideTurn`.
 */
import type { AgentEvent, AgentRunEventRecord } from "../../../agent/types";
import { getWebSourceAnchorsFromTrace } from "../../../webAccess/attribution";
import { buildOutsideSearchReasonDetail } from "../../../agent/tools/read/outsideSearchNeed";
import { describePaperSource } from "../../../webAccess/paperSources";
import type {
  WebSourceAnchor,
  WebSourceDisplay,
} from "../../../webAccess/types";
import { collectRunWebSources, webSourceKey } from "../webSourcesData";
import { quoteAroundOffset } from "../../../services/quotes/answerSentence";

export { quoteAroundOffset };

export type TaskOutsideKind = "paper" | "web";

/** How much of a source the agent got. */
export type TaskOutsideCoverage =
  | "none"
  | "snippet"
  | "abstract"
  | "outline"
  | "passages"
  | "parts"
  | "whole";

export type TaskOutsideRead = { label: string; text: string };

/** A sentence of the answer that uses a source. */
export type TaskOutsideQuote = {
  /** The sentence, as plain words. */
  text: string;
  /** Its marker: the index of the answer's source anchor. */
  anchor: number;
  /** The exact words the agent said it took from the source. */
  phrase?: string;
  /** The answer's heading over the sentence ("What is preserved"). */
  section?: string;
};

export type TaskOutsideSource = {
  /** Its row key: the paper's source id, or "web:" and the page's link key. */
  key: string;
  kind: TaskOutsideKind;
  sourceId?: string;
  url: string;
  hostname: string;
  organization: string;
  title: string;
  faviconUrl?: string;
  /** found: only in search results; skimmed: abstract or outline; read. */
  state: "found" | "skimmed" | "read";
  /**
   * A sentence of the answer uses it. A source only listed at the answer's
   * end (the fallback chip) is not counted as used.
   */
  cited: boolean;
  /** The answer's sentences that use it, each with its marker. */
  quotes: TaskOutsideQuote[];
  /** What the agent read, one block each. */
  reads: TaskOutsideRead[];
  /** All the text the agent got, for "What the agent read". */
  agentText: string;
  coverage: TaskOutsideCoverage;
};

export type TaskOutsideTurn = {
  runId: string;
  /** The sources the run found, in the order it met them. */
  sources: TaskOutsideSource[];
  /** Sources the answer cites that an earlier question found. */
  earlier: TaskOutsideSource[];
  /** Why the run searched outside, by kind ("Why outside"). */
  why: Partial<Record<TaskOutsideKind, string>>;
  /** The kinds the run searched, whatever they returned. */
  searched: TaskOutsideKind[];
  /** The run searched the library. */
  librarySearched: boolean;
  /** The answer's text, to find the library papers it names. */
  answer: string;
  /**
   * The answer is web-attributed (its run's final event has web markers):
   * it renders from its own text, so its cited passages are read there.
   */
  webSourced?: true;
};

const WEB_TOOLS = new Set(["web_search", "web_read"]);
const PAPER_TOOLS = new Set(["literature_search", "literature_read"]);
const LIBRARY_SEARCH_TOOLS = new Set(["library_search", "library_retrieve"]);

/** Event kinds a turn's outside sources are folded from. */
export const TASK_OUTSIDE_EVENT_TYPES = [
  "tool_call",
  "tool_result",
  "final",
] as const;

/** Whether a tool's results can hold outside sources. */
export function isOutsideSourceTool(name: string): boolean {
  return WEB_TOOLS.has(name) || PAPER_TOOLS.has(name);
}

/** Whether a run event can change its turn's outside sources. */
export function movesTaskOutside(event: AgentEvent): boolean {
  if (event.type === "final") return true;
  if (event.type !== "tool_call" && event.type !== "tool_result") return false;
  return (
    isOutsideSourceTool(event.name) || LIBRARY_SEARCH_TOOLS.has(event.name)
  );
}

/** A source's row key, for a row or for a marker's source. */
export function outsideSourceKey(source: {
  kind?: string;
  sourceId?: string;
  url: string;
}): string {
  if (source.kind === "paper" && source.sourceId) return source.sourceId;
  return `web:${webSourceKey(source.url)}`;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

const STATE_RANK = { found: 0, skimmed: 1, read: 2 } as const;

const WEB_COVERAGE_LABELS: Partial<Record<TaskOutsideCoverage, string>> = {
  outline: "Outline",
  passages: "Passages that matched",
  parts: "Parts of the page",
  whole: "Whole page",
};

function decodeLink(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

const DOI_PATTERN = /\b(10\.\d{4,9}\/[^\s"<>?#]+)/i;

function cleanDoi(doi: string): string {
  return doi.replace(/[.,;:)\]]+$/, "").toLowerCase();
}

/**
 * The DOI a source is known by: in its link (doi.org or a publisher's path),
 * else written in its title as "doi: 10.…". Empty when neither holds one.
 */
export function sourceDoi(source: { url?: string; title?: string }): string {
  const url = decodeLink(source.url || "");
  const inUrl = DOI_PATTERN.exec(url);
  if (inUrl) return cleanDoi(inUrl[1]);
  const inTitle = /\bdoi:?\s*(10\.\d{4,9}\/[^\s"<>]+)/i.exec(
    source.title || "",
  );
  return inTitle ? cleanDoi(inTitle[1]) : "";
}

/** An Elsevier article's PII from its link (ScienceDirect, Cell), else "". */
export function sourcePii(url: string | undefined): string {
  const match = /\bpii[/=](S?[\dX()-]{12,30})/i.exec(decodeLink(url || ""));
  if (!match) return "";
  const pii = match[1].replace(/[^\dX]/gi, "").toUpperCase();
  return pii.length >= 15 ? pii : "";
}

/** The answer's last heading before an offset, as plain words; else "". */
export function answerSectionAt(text: string, offset: number): string {
  const headings = text
    .slice(0, Math.max(0, offset))
    .match(/^#{1,6}[ \t]+.+$/gm);
  if (!headings) return "";
  return headings[headings.length - 1]
    .replace(/^#{1,6}[ \t]+/, "")
    .replace(/[ \t]+#+[ \t]*$/, "")
    .replace(/[*_`]+/g, "")
    .trim();
}

function sameLink(left: string, right: string): boolean {
  const plain = (url: string) =>
    decodeLink(url)
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\/(?:www\.)?/, "")
      .replace(/[/#]+$/, "");
  return !!left && !!right && plain(left) === plain(right);
}

/**
 * The answer's own links to sources: a link to a source's page, or to its
 * DOI, makes the sentence around it a quote of that source. Links the
 * markers already counted add nothing new.
 */
function linkQuotes(answer: string, sources: readonly TaskOutsideSource[]) {
  const links = /\[([^\]]*)\]\((https?:\/\/[^\s)]+)(?:\s+"([^"]*)")?\)/g;
  let match: RegExpExecArray | null;
  while ((match = links.exec(answer))) {
    const url = match[2];
    const doi = sourceDoi({ url });
    const source =
      sources.find((entry) => sameLink(entry.url, url)) ||
      (doi ? sources.find((entry) => sourceDoi(entry) === doi) : undefined);
    if (!source) continue;
    const quote = quoteAroundOffset(answer, match.index);
    if (!quote) continue;
    source.cited = true;
    if (source.quotes.some((known) => known.text === quote)) continue;
    const phrase = match[3]?.trim();
    const section = answerSectionAt(answer, match.index);
    source.quotes.push({
      text: quote,
      anchor: -1,
      ...(phrase ? { phrase } : {}),
      ...(section ? { section } : {}),
    });
  }
}

function webSources(
  events: readonly { payload: AgentEvent }[],
): TaskOutsideSource[] {
  const results = events.filter(
    ({ payload }) =>
      payload.type === "tool_result" && WEB_TOOLS.has(payload.name),
  );
  return collectRunWebSources(results).map((entry) => {
    const coverage: TaskOutsideCoverage = entry.coverage;
    const state =
      coverage === "outline"
        ? "skimmed"
        : entry.read && coverage !== "none" && coverage !== "snippet"
          ? "read"
          : "found";
    const reads: TaskOutsideRead[] =
      state === "found" || !entry.agentText
        ? []
        : [
            {
              label: WEB_COVERAGE_LABELS[coverage] || "Page",
              text: oneLine(
                entry.agentText.replace(/\[(?:\.\.\.|…)\]/g, " … "),
                400,
              ),
            },
          ];
    return {
      key: outsideSourceKey({ url: entry.url }),
      kind: "web",
      url: entry.url,
      hostname: entry.hostname,
      organization: entry.organization,
      title: entry.title,
      ...(entry.faviconUrl ? { faviconUrl: entry.faviconUrl } : {}),
      state,
      cited: false,
      quotes: [],
      reads,
      agentText: entry.agentText,
      coverage,
    };
  });
}

function paperSources(
  events: readonly { payload: AgentEvent }[],
): TaskOutsideSource[] {
  const byKey = new Map<string, TaskOutsideSource>();
  const add = (
    display: WebSourceDisplay | null,
    found: { snippet?: string; reads?: TaskOutsideRead[]; read?: boolean },
  ) => {
    if (!display) return;
    const key = outsideSourceKey({ ...display, kind: "paper" });
    let row = byKey.get(key);
    if (!row) {
      row = {
        key,
        kind: "paper",
        sourceId: display.sourceId,
        url: display.url,
        hostname: display.hostname,
        organization: display.organization || display.hostname,
        title: display.title,
        ...(display.faviconUrl ? { faviconUrl: display.faviconUrl } : {}),
        state: "found",
        cited: false,
        quotes: [],
        reads: [],
        agentText: "",
        coverage: "none",
      };
      byKey.set(key, row);
    } else if (row.title === row.hostname && display.title) {
      row.title = display.title;
    }
    if (found.snippet && !row.agentText) {
      row.agentText = found.snippet;
      row.coverage = "snippet";
    }
    for (const read of found.reads || []) {
      if (row.reads.some((known) => known.text === read.text)) continue;
      row.reads.push(read);
      const deep = read.label !== "Abstract";
      const next = deep ? "read" : "skimmed";
      if (STATE_RANK[next] > STATE_RANK[row.state]) row.state = next;
      const coverage: TaskOutsideCoverage = deep ? "passages" : "abstract";
      if (row.coverage !== "passages") row.coverage = coverage;
    }
    if (row.reads.length) {
      row.agentText = row.reads
        .map((read) => `${read.label}\n\n${read.text}`)
        .join("\n\n");
    }
  };
  for (const { payload } of events) {
    if (payload.type !== "tool_result" || !payload.ok) continue;
    const content = asObject(payload.content);
    if (!content) continue;
    if (
      payload.name === "literature_search" &&
      Array.isArray(content.results)
    ) {
      for (const entry of content.results) {
        const raw = asObject(entry);
        if (!raw) continue;
        add(describePaperSource(raw), {
          snippet: readText(raw.abstract) || readText(raw.snippet),
        });
      }
    } else if (payload.name === "literature_read") {
      const paper = asObject(content.paper);
      if (!paper) continue;
      const fullText = asObject(content.fullText);
      const reads: TaskOutsideRead[] = [];
      const abstract = readText(content.abstract);
      if (abstract)
        reads.push({ label: "Abstract", text: oneLine(abstract, 600) });
      if (Array.isArray(content.passages)) {
        for (const entry of content.passages) {
          const passage = asObject(entry);
          const text = readText(passage?.text);
          if (text)
            reads.push({
              label: readText(passage?.section) || "Passage",
              text: oneLine(text, 600),
            });
        }
      }
      const section = asObject(content.section);
      const sectionText = readText(content.text);
      if (sectionText) {
        const label = [readText(section?.number), readText(section?.title)]
          .filter(Boolean)
          .join(" ");
        reads.push({
          label: label || "Section",
          text: oneLine(sectionText, 600),
        });
      }
      add(
        describePaperSource(paper, [fullText?.landingUrl, fullText?.pdfUrl]),
        { reads },
      );
    }
  }
  return [...byKey.values()];
}

function anchorSourceRow(source: WebSourceDisplay): TaskOutsideSource {
  const kind: TaskOutsideKind = source.kind === "paper" ? "paper" : "web";
  return {
    key: outsideSourceKey({ ...source, kind }),
    kind,
    sourceId: source.sourceId,
    url: source.url,
    hostname: source.hostname,
    organization: source.organization || source.hostname,
    title: source.title || source.hostname,
    ...(source.faviconUrl ? { faviconUrl: source.faviconUrl } : {}),
    state: "found",
    cited: false,
    quotes: [],
    reads: [],
    agentText: "",
    coverage: "none",
  };
}

/**
 * One run's outside sources, from its events in order; null when the run
 * neither searched the library or outside nor cited an outside source.
 */
export function buildTaskOutsideTurn(
  runId: string,
  events: readonly { payload: AgentEvent }[],
): TaskOutsideTurn | null {
  const why: TaskOutsideTurn["why"] = {};
  const searched = new Set<TaskOutsideKind>();
  let librarySearched = false;
  let final: Extract<AgentEvent, { type: "final" }> | null = null;
  for (const { payload } of events) {
    if (payload.type === "tool_call") {
      if (LIBRARY_SEARCH_TOOLS.has(payload.name)) librarySearched = true;
      const kind: TaskOutsideKind | null = WEB_TOOLS.has(payload.name)
        ? "web"
        : PAPER_TOOLS.has(payload.name)
          ? "paper"
          : null;
      if (!kind) continue;
      if (payload.name === "web_search" || payload.name === "literature_search")
        searched.add(kind);
      const reason = buildOutsideSearchReasonDetail(payload.args);
      if (reason && !why[kind]) why[kind] = reason.value;
    } else if (payload.type === "final") {
      final = payload;
    }
  }
  const sources = [...paperSources(events), ...webSources(events)];
  for (const source of sources) {
    if (source.kind === "paper") searched.add("paper");
    else searched.add("web");
  }
  const earlier: TaskOutsideSource[] = [];
  const anchors: readonly WebSourceAnchor[] = final?.webSourceAnchors || [];
  for (const [index, anchor] of anchors.entries()) {
    const quote =
      final && anchor.placement !== "end"
        ? quoteAroundOffset(final.text || "", anchor.offset)
        : "";
    const section = quote
      ? answerSectionAt(final?.text || "", anchor.offset)
      : "";
    for (const source of anchor.sources || []) {
      const key = outsideSourceKey({
        ...source,
        kind: source.kind === "paper" ? "paper" : "web",
      });
      let row =
        sources.find((entry) => entry.key === key) ||
        earlier.find((entry) => entry.key === key);
      if (!row) {
        row = anchorSourceRow(source);
        earlier.push(row);
      }
      if (!quote) continue;
      row.cited = true;
      if (row.quotes.some((known) => known.text === quote)) continue;
      const phrase = anchor.phrases?.[source.sourceId]?.trim();
      row.quotes.push({
        text: quote,
        anchor: index,
        ...(phrase ? { phrase } : {}),
        ...(section ? { section } : {}),
      });
    }
  }
  // Earlier questions' sources only listed at this answer's end add nothing.
  for (let index = earlier.length - 1; index >= 0; index--)
    if (!earlier[index].cited) earlier.splice(index, 1);
  const answer = final?.text || "";
  linkQuotes(answer, sources);
  if (
    !sources.length &&
    !earlier.length &&
    !searched.size &&
    !librarySearched &&
    !answer.trim()
  )
    return null;
  return {
    runId,
    sources,
    earlier,
    why,
    searched: [...searched],
    librarySearched,
    answer,
    // As the chat decides it for the answer's render.
    ...(getWebSourceAnchorsFromTrace(events as AgentRunEventRecord[]).length
      ? { webSourced: true as const }
      : {}),
  };
}
