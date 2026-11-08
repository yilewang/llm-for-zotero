import type {
  AgentToolDefinition,
  AgentToolInputValidation,
  AgentTraceDetail,
} from "../../types";
import { readOnlyInvocationPlan } from "../../authorization/invocationPlan";
import {
  estimateTextTokens,
  sliceTextToTokenBudget,
} from "../../../utils/modelInputCap";
import { formatPaperDisplayLabel } from "../../../shared/paperDisplayLabels";
import {
  buildChunkIndex,
  scoreChunkBM25,
} from "../../../services/paperContent/pdfContext";
import { tokenizeRetrievalQuery } from "../../../services/retrieval/retrievalTokenizer";
import {
  loadLiteraturePaper,
  normalizeLiteratureReadIdentifier,
  type LiteratureReadIdentifier,
  type LiteratureReadIdentifierKind,
  type LiteratureReadRecord,
} from "../../services/literatureReadService";
import type { ParsedPaperSection } from "../../services/literatureReadParser";
import { fail, ok, validateObject } from "../shared";
import { readTextChunk } from "./textChunk";
import {
  literatureReadFoundPaper,
  outsidePaperId,
  type OutsidePaperHolder,
} from "../../context/outsidePaperRecords";

/**
 * literature_read: reads one outside paper (found by literature_search or
 * named by the user) by DOI, PMID, PMCID or arXiv ID. It returns the full
 * abstract and section outline, query-matched passages, or one section with
 * a lossless textOffset cursor, within a token budget.
 *
 * Reading never imports: there is no path to identifyLiteratureCandidates,
 * no handle record, and no candidate fields in the result.
 */

export const LITERATURE_READ_TOOL_NAME = "literature_read";

type LiteratureReadInput = {
  identifier: LiteratureReadIdentifier;
  query?: string;
  section?: string;
  textOffset: number;
};

const IDENTIFIER_FIELDS: ReadonlyArray<{
  field: LiteratureReadIdentifierKind;
  label: string;
}> = [
  { field: "doi", label: "DOI" },
  { field: "pmid", label: "PMID" },
  { field: "pmcid", label: "PMCID" },
  { field: "arxivId", label: "arXiv ID" },
];

/** The same budget as context_read and past_chat_read. */
const DEFAULT_MAX_TOKENS = 6_000;
/** Room for the result's own fields around the paper text. */
const RESULT_OVERHEAD_TOKENS = 200;
const MAX_QUERY_CHARS = 500;
/** Longest passage a query returns, in characters. */
const PASSAGE_CHARS = 1_200;
const MAX_PASSAGES = 8;

/** Result fields the paper's metadata fills are bounded, so they cannot spend the budget. */
const MAX_LISTED_AUTHORS = 10;
const MAX_AUTHOR_CHARS = 120;
const MAX_TITLE_CHARS = 400;
const MAX_URL_CHARS = 300;
const MAX_LICENSE_CHARS = 200;

const FAILURE_WORDS: Record<string, string> = {
  rate_limited: "rate limited",
  server_error: "the source had a server error",
  timeout: "the request timed out",
  network_error: "the network request failed",
  request_failed: "the request failed",
};

function identifierLabel(identifier: LiteratureReadIdentifier): string {
  const label =
    IDENTIFIER_FIELDS.find((entry) => entry.field === identifier.kind)?.label ||
    identifier.kind;
  return `${label} ${identifier.value}`;
}

export function validateLiteratureReadInput(
  args: unknown,
): AgentToolInputValidation<LiteratureReadInput> {
  if (!validateObject<Record<string, unknown>>(args)) {
    return fail("literature_read expects an object input");
  }
  const given = IDENTIFIER_FIELDS.filter(({ field }) => {
    const value = args[field];
    return (
      (typeof value === "string" && value.trim()) || typeof value === "number"
    );
  });
  if (given.length !== 1) {
    return fail(
      given.length
        ? `Give exactly one identifier, not ${given.map((entry) => entry.field).join(" and ")}.`
        : "Give exactly one of doi, pmid, pmcid or arxivId, copied from a literature_search result or named by the user.",
    );
  }
  const { field, label } = given[0];
  const identifier = normalizeLiteratureReadIdentifier(field, args[field]);
  if (!identifier) {
    return fail(`${field} is not a valid ${label}: ${String(args[field])}`);
  }
  let query: string | undefined;
  if (args.query !== undefined) {
    query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query || query.length > MAX_QUERY_CHARS) {
      return fail(`query must be a text of 1 to ${MAX_QUERY_CHARS} characters`);
    }
  }
  let section: string | undefined;
  if (args.section !== undefined) {
    section =
      typeof args.section === "string" || typeof args.section === "number"
        ? String(args.section).trim()
        : "";
    if (!section) return fail("section must be an outline number or title");
  }
  if (
    args.textOffset !== undefined &&
    (!Number.isSafeInteger(args.textOffset) || Number(args.textOffset) < 0)
  ) {
    return fail("textOffset must be a nonnegative integer");
  }
  const textOffset = Number(args.textOffset || 0);
  if (textOffset && (!section || query)) {
    return fail("textOffset continues a section: give it with section only");
  }
  return ok({
    identifier,
    ...(query ? { query } : {}),
    ...(section ? { section } : {}),
    textOffset,
  });
}

// --- result shaping --------------------------------------------------------

function clip(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** The paper's metadata with a bounded size: the first authors and a count. */
function boundedPaper(paper: LiteratureReadRecord["paper"]) {
  const { authors, ...rest } = paper;
  const bounded: Record<string, unknown> = { ...rest };
  for (const [field, max] of [
    ["title", MAX_TITLE_CHARS],
    ["url", MAX_URL_CHARS],
    ["license", MAX_LICENSE_CHARS],
    ["doi", MAX_URL_CHARS],
  ] as const) {
    if (typeof bounded[field] === "string") {
      bounded[field] = clip(bounded[field] as string, max);
    }
  }
  bounded.authors = authors
    .slice(0, MAX_LISTED_AUTHORS)
    .map((name) => clip(name, MAX_AUTHOR_CHARS));
  if (authors.length > MAX_LISTED_AUTHORS) bounded.authorCount = authors.length;
  return bounded;
}

function sourceLabelOf(record: LiteratureReadRecord): string {
  return formatPaperDisplayLabel({
    title: clip(record.paper.title, MAX_TITLE_CHARS),
    firstCreator: clip(record.firstCreator, MAX_AUTHOR_CHARS),
    year: record.paper.year ? String(record.paper.year) : undefined,
  });
}

function linkOf(record: LiteratureReadRecord): string | undefined {
  return clip(record.paper.url || record.fullText.landingUrl, MAX_URL_CHARS);
}

function fullTextNote(record: LiteratureReadRecord): string | undefined {
  const { status, reason } = record.fullText;
  if (status === "open_access") return undefined;
  if (status === "abstract_only") {
    return "No open-access full text was found; answer from the abstract.";
  }
  if (status === "pdf_only") {
    return "Only a PDF link is open; this tool does not read PDFs. Answer from the abstract and give the link.";
  }
  if (reason === "not_found") return "No paper with this identifier was found.";
  if (reason && FAILURE_WORDS[reason]) {
    return `The paper text is unavailable right now (${FAILURE_WORDS[reason]}). Answer from the abstract and evidence you already have; do not retry this paper by shell, sleep or repeated calls.`;
  }
  return "No readable text was found; answer from the evidence you already have.";
}

function sectionSubtree(
  sections: ParsedPaperSection[],
  index: number,
): ParsedPaperSection[] {
  const root = sections[index];
  const subtree = [root];
  for (let next = index + 1; next < sections.length; next += 1) {
    if (sections[next].level <= root.level) break;
    subtree.push(sections[next]);
  }
  return subtree;
}

function sectionText(sections: ParsedPaperSection[]): string {
  return sections
    .map((section) =>
      [`## ${section.number} ${section.title}`, ...section.paragraphs].join(
        "\n\n",
      ),
    )
    .join("\n\n");
}

function findSection(sections: ParsedPaperSection[], wanted: string): number {
  const key = wanted.replace(/\.$/, "").toLowerCase();
  const byNumber = sections.findIndex(
    (section) => section.number.toLowerCase() === key,
  );
  if (byNumber >= 0) return byNumber;
  const title = (section: ParsedPaperSection) =>
    section.title.toLowerCase().replace(/\s+/g, " ");
  const exact = sections.findIndex((section) => title(section) === key);
  if (exact >= 0) return exact;
  return sections.findIndex((section) => title(section).includes(key));
}

function outlineOf(sections: ParsedPaperSection[], maxTokens: number) {
  const outline: Array<{ number: string; title: string; characters: number }> =
    [];
  let used = 0;
  sections.forEach((section, index) => {
    const entry = {
      number: section.number,
      title: section.title,
      characters: sectionText(sectionSubtree(sections, index)).length,
    };
    const cost = estimateTextTokens(JSON.stringify(entry)) + 1;
    if (used + cost > maxTokens) return;
    used += cost;
    outline.push(entry);
  });
  return {
    sections: outline,
    ...(outline.length < sections.length
      ? { omittedSections: sections.length - outline.length }
      : {}),
  };
}

/** Paragraphs grouped into passages of at most PASSAGE_CHARS. */
function passageChunks(sections: ParsedPaperSection[]) {
  const chunks: Array<{ section: string; text: string }> = [];
  for (const section of sections) {
    const label = `${section.number} ${section.title}`;
    let current = "";
    const push = () => {
      if (current) chunks.push({ section: label, text: current });
      current = "";
    };
    for (const paragraph of section.paragraphs) {
      let rest = paragraph;
      while (rest.length > PASSAGE_CHARS) {
        push();
        const cut = rest.lastIndexOf(" ", PASSAGE_CHARS);
        const at = cut > PASSAGE_CHARS / 2 ? cut : PASSAGE_CHARS;
        chunks.push({ section: label, text: rest.slice(0, at).trim() });
        rest = rest.slice(at).trim();
      }
      if (current && current.length + rest.length + 1 > PASSAGE_CHARS) push();
      current = current ? `${current} ${rest}` : rest;
    }
    push();
  }
  return chunks;
}

function rankPassages(
  sections: ParsedPaperSection[],
  query: string,
  maxTokens: number,
) {
  const chunks = passageChunks(sections);
  const terms = tokenizeRetrievalQuery(query);
  const index = buildChunkIndex(chunks.map((chunk) => chunk.text));
  const ranked = index.chunkStats
    .map((stat) => ({
      stat,
      score: scoreChunkBM25(
        stat,
        terms,
        index.docFreq,
        chunks.length,
        index.avgChunkLength,
      ),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);
  const passages: Array<{ section: string; text: string }> = [];
  let used = 0;
  for (const { stat } of ranked) {
    if (passages.length >= MAX_PASSAGES) break;
    const passage = chunks[stat.index];
    const cost = estimateTextTokens(JSON.stringify(passage)) + 2;
    if (used + cost > maxTokens) continue;
    used += cost;
    passages.push(passage);
  }
  return { passages, totalMatches: ranked.length };
}

export function buildLiteratureReadResult(
  record: LiteratureReadRecord,
  input: Pick<LiteratureReadInput, "query" | "section" | "textOffset">,
  maxTokens = DEFAULT_MAX_TOKENS,
  holder?: OutsidePaperHolder,
): Record<string, unknown> {
  const sourceLabel = sourceLabelOf(record);
  const link = linkOf(record);
  const note = fullTextNote(record);
  const paper = boundedPaper(record.paper);
  // The paperId a document cites the paper by, read from the fields the
  // result shows, as the host's record of the run's outside papers reads it:
  // the id the run already gave this paper, when an earlier call returned it.
  const paperId = literatureReadFoundPaper(paper, record.fullText)
    ? outsidePaperId(
        paper,
        [
          clip(record.fullText.landingUrl, MAX_URL_CHARS),
          clip(record.fullText.pdfUrl, MAX_URL_CHARS),
        ],
        holder,
      )
    : undefined;
  const base: Record<string, unknown> = {
    source: record.source,
    paper: paperId ? { ...paper, paperId } : paper,
    sourceLabel,
    fullText: {
      ...record.fullText,
      ...(record.fullText.pdfUrl
        ? { pdfUrl: clip(record.fullText.pdfUrl, MAX_URL_CHARS) }
        : {}),
      ...(record.fullText.landingUrl
        ? { landingUrl: clip(record.fullText.landingUrl, MAX_URL_CHARS) }
        : {}),
      ...(note ? { note } : {}),
    },
    citation: `In a chat answer, cite this outside paper as ${sourceLabel}${link ? ` with its link ${link}, and give the link a title holding the exact words you used from it, copied word for word from what you read (about 5 to 25 words, no double quotes inside): [${sourceLabel}](${link} "exact words")` : ""}. It is not in the Zotero library, so in chat it has no [[cite:]] or [[quote:]] anchors; in a submit_document document, cite it by its paperId.`,
  };
  let remaining =
    maxTokens -
    estimateTextTokens(JSON.stringify(base)) -
    RESULT_OVERHEAD_TOKENS;
  const sections = record.sections;
  const withAbstract = () => {
    const abstract = sliceTextToTokenBudget(
      record.abstract,
      Math.max(1, remaining),
    );
    remaining -= estimateTextTokens(abstract);
    return { ...base, abstract };
  };
  const withOutline = (result: Record<string, unknown>) =>
    sections.length
      ? { ...result, ...outlineOf(sections, Math.max(0, remaining)) }
      : result;

  if (!input.query && !input.section) return withOutline(withAbstract());
  if (!sections.length) {
    return {
      ...withAbstract(),
      ...(input.query ? { passages: [] } : {}),
      error:
        "This paper has no open-access full text to search or read by section; the abstract is all there is.",
    };
  }
  let scope = sections;
  let sectionIndex = -1;
  if (input.section) {
    sectionIndex = findSection(sections, input.section);
    if (sectionIndex < 0) {
      return withOutline({
        ...base,
        error: `No section matches "${input.section}". Use a number or title from sections.`,
      });
    }
    scope = sectionSubtree(sections, sectionIndex);
  }
  if (input.query) {
    const { passages, totalMatches } = rankPassages(
      scope,
      input.query,
      Math.max(0, remaining),
    );
    return {
      ...base,
      query: input.query,
      passages,
      totalMatches,
      ...(passages.length
        ? {}
        : {
            hint: "No passage contains these words. Try other words, or read a section from the outline.",
          }),
    };
  }
  const root = sections[sectionIndex];
  const chunk = readTextChunk(
    sectionText(scope),
    input.textOffset,
    Math.max(64, remaining),
  );
  return {
    ...base,
    section: { number: root.number, title: root.title },
    text: chunk.text,
    textOffset: chunk.textOffset,
    totalChars: chunk.totalChars,
    ...(chunk.nextTextOffset !== undefined
      ? { nextTextOffset: chunk.nextTextOffset }
      : {}),
  };
}

// --- presentation ------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function argIdentifier(args: unknown): LiteratureReadIdentifier | null {
  const validated = validateLiteratureReadInput(args);
  return validated.ok ? validated.value.identifier : null;
}

function identifierHref(identifier: LiteratureReadIdentifier): string {
  if (identifier.kind === "doi") return `https://doi.org/${identifier.value}`;
  if (identifier.kind === "arxivId") {
    return `https://arxiv.org/abs/${identifier.value}`;
  }
  if (identifier.kind === "pmid") {
    return `https://europepmc.org/article/MED/${identifier.value}`;
  }
  return `https://europepmc.org/article/PMC/${identifier.value}`;
}

function buildTraceDetails(
  args: unknown,
  content: unknown,
): AgentTraceDetail[] {
  const details: AgentTraceDetail[] = [];
  const identifier = argIdentifier(args);
  const input = asRecord(args);
  if (typeof input.query === "string" && input.query.trim()) {
    details.push({ label: "Query", value: input.query.trim() });
  }
  if (input.section !== undefined) {
    details.push({ label: "Section", value: String(input.section) });
  }
  const result = asRecord(content);
  const paper = asRecord(result.paper);
  const title = typeof paper.title === "string" ? paper.title : "";
  if (identifier) {
    const href =
      (typeof paper.url === "string" && paper.url) ||
      identifierHref(identifier);
    const label =
      typeof result.sourceLabel === "string"
        ? result.sourceLabel.replace(/^\(|\)$/g, "")
        : "";
    details.push({
      label: "Paper",
      value:
        title && label ? `${label}, ${title}` : identifierLabel(identifier),
      timeline: { icon: "paper", href },
    });
  }
  return details;
}

function successSummary(content: unknown): string {
  const result = asRecord(content);
  const label = String(result.sourceLabel || "the paper");
  const fullText = asRecord(result.fullText);
  if (fullText.status === "unavailable") {
    return `Could not read ${label}`;
  }
  if (Array.isArray(result.passages)) {
    const count = result.passages.length;
    return `Read ${count} passage${count === 1 ? "" : "s"} from ${label}`;
  }
  const section = asRecord(result.section);
  if (typeof result.text === "string" && section.number) {
    return `Read section ${String(section.number)} of ${label}`;
  }
  if (fullText.status === "open_access") {
    return `Read the abstract and outline of ${label}`;
  }
  return `Read the abstract of ${label}`;
}

export function createLiteratureReadTool(): AgentToolDefinition<
  LiteratureReadInput,
  unknown
> {
  return {
    spec: {
      name: LITERATURE_READ_TOOL_NAME,
      description:
        "Read one outside paper found by literature_search or named by the user: its full abstract and, if open access, its full text (a PDF-only paper gives its link). Give exactly one of doi, pmid, pmcid or arxivId. No query or section: abstract and section outline; query: best-matching passages; section (outline number or title): that section, continued with textOffset=nextTextOffset. Never imports. Use it instead of shell or curl.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          doi: { type: "string" },
          pmid: { type: "string" },
          pmcid: { type: "string" },
          arxivId: { type: "string" },
          query: { type: "string" },
          section: { type: "string" },
          textOffset: { type: "integer" },
        },
      },
      executionClass: "read",
      workCategory: "retrieval",
    },
    presentation: {
      label: "Read Outside Paper",
      traceIcon: "library",
      mergeResultIntoCallTrace: true,
      buildTraceDetails: ({ args, content }) =>
        buildTraceDetails(args, content),
      summaries: {
        onCall: ({ args }) => {
          const identifier = argIdentifier(args);
          return identifier
            ? `Reading outside paper (${identifierLabel(identifier)})`
            : "Reading outside paper";
        },
        onSuccess: ({ content }) => successSummary(content),
        onError: "Reading the outside paper failed",
      },
    },
    validate: validateLiteratureReadInput,
    planInvocation: (input) =>
      readOnlyInvocationPlan({
        domains: ["network"],
        effects: ["read", "egress"],
        targets: [identifierLabel(input.identifier)],
        reason:
          "Europe PMC, PubMed Central, arXiv or OpenAlex receives the paper identifier and returns its public abstract and open-access text without changing Zotero.",
      }),
    execute: async (input, context) =>
      buildLiteratureReadResult(
        await loadLiteraturePaper(input.identifier),
        input,
        undefined,
        context.request,
      ),
  };
}
