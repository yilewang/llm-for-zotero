import { materialRefFromDocument } from "../../documents/workflowMaterial";
import type {
  AgentToolDefinition,
  AgentToolInputValidation,
  AgentToolResult,
} from "../../types";
import { readOnlyInvocationPlan } from "../../authorization/invocationPlan";
import { DirectDocumentFinalizer } from "../../documents/directFinalization";
import type { MaterialRef } from "../../documents/materialRef";
import {
  isOutsideCitationSource,
  type DocumentAssetProvenance,
  type PlanCitationCluster,
  type PlanCitationSource,
  type PlanDocumentAsset,
  type SubmitPlanDocumentInput,
  type ZoteroCitationSource,
} from "../../documents/types";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import type { TaskPaperDocumentCitation } from "../../context/taskPaperLedger";
import { neverSelected } from "../guidance";
import { canShowLiteratureReview } from "../read/reviewLiterature";
import { fail, ok, validateObject } from "../shared";
import { exclusionPaperDecisions } from "./recordPaperDecisions";

/** A citation or quote token. */
const TOKEN = /\[\[(cite|quote):([^\]]+)\]\]/g;
const HEADING = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
/** The underline of a setext heading: `=` for H1, `-` for H2. */
const SETEXT_UNDERLINE = /^\s{0,3}(=+|-+)\s*$/;

type TokenUse = { kind: "cite" | "quote"; id: string; section: string };

/**
 * Every citation and quote token outside code fences, in order, with the
 * heading it sits under. A heading that only repeats the document's title
 * names no section; a token before any other heading has none.
 */
function tokenUses(markdown: string, title = ""): TokenUse[] {
  const uses: TokenUse[] = [];
  const ownTitle = title.trim().toLowerCase();
  let section = "";
  let fence = "";
  let titled = false;
  const lines = String(markdown || "").split(/\r?\n/);
  const enterHeading = (text: string, level1: boolean) => {
    // The document's first H1 is its title, as is any heading repeating it.
    const firstH1 = !titled && level1;
    if (firstH1) titled = true;
    section = firstH1 || text.toLowerCase() === ownTitle ? "" : text;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      // Only a fence of the opening kind, at least as long, closes it.
      if (
        marker &&
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        !line.trim().slice(marker.length).trim()
      )
        fence = "";
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      enterHeading(heading[1].trim(), /^\s{0,3}#\s/.test(line));
      continue;
    }
    // A setext heading: one line of text, then its underline.
    const underline = SETEXT_UNDERLINE.exec(lines[index + 1] || "");
    if (
      underline &&
      line.trim() &&
      !/^\s{0,3}(>|[-*+]\s|\d+[.)]\s)/.test(line) &&
      !SETEXT_UNDERLINE.test(line) &&
      !(index > 0 && lines[index - 1].trim())
    ) {
      enterHeading(line.trim(), underline[1][0] === "=");
      index += 1;
      continue;
    }
    // Comma-joined citation ids count each; the host splits those tokens.
    for (const match of line.matchAll(TOKEN)) {
      if (match[1] === "quote") {
        uses.push({ kind: "quote", id: match[2], section });
        continue;
      }
      for (const id of match[2].split(",")) {
        if (id.trim()) uses.push({ kind: "cite", id: id.trim(), section });
      }
    }
  }
  return uses;
}

function addSection(
  labels: Map<string, string[]>,
  id: string,
  section: string,
): void {
  const held = labels.get(id) || [];
  if (section && !held.includes(section)) held.push(section);
  if (held.length) labels.set(id, held);
}

/**
 * Every heading each citation appears under, in order, by citation id.
 * A heading that only repeats the document's title names no section; a
 * citation used only before any other heading has none.
 */
export function citationSectionLabels(
  markdown: string,
  title = "",
): Map<string, string[]> {
  const labels = new Map<string, string[]>();
  for (const use of tokenUses(markdown, title)) {
    if (use.kind === "cite") addSection(labels, use.id, use.section);
  }
  return labels;
}

/** What a source's Zotero item says about its paper. */
export type CitedSourceItem = {
  /** The item the source's key names (an attachment stays an attachment). */
  itemId?: number;
  title?: string;
  firstCreator?: string;
  year?: string;
};

type QuoteSource = Pick<
  SubmitPlanDocumentInput["quotes"][number],
  "quoteId" | "libraryID" | "itemKey"
>;

/**
 * The sources a finalized document cites, one entry per source of every
 * cluster it uses, for the Task progress rows.
 *
 * `clusters` are the finalized document's: the ones its tokens use after the
 * host's repairs, including a citation a downgraded quote added or reused.
 * `markdown` is the submitted draft, which places each token: a downgraded
 * quote counts where its token sat, under the cluster that now cites it. A
 * paper only a verified quote cites counts too, under the quote's id. An
 * outside paper is left out: Task progress lists Zotero papers.
 */
export function documentCitedSources(params: {
  markdown: string;
  title?: string;
  clusters: readonly PlanCitationCluster[];
  quotes?: readonly QuoteSource[];
  verifiedQuotes?: readonly QuoteSource[];
  itemOf?: (libraryID: number, itemKey: string) => CitedSourceItem | undefined;
}): TaskPaperDocumentCitation[] {
  const uses = tokenUses(params.markdown, params.title);
  const labels = new Map<string, string[]>();
  const used = new Set<string>();
  const cites = (cluster: PlanCitationCluster, quote: QuoteSource) =>
    cluster.sources.some(
      (source) =>
        !isOutsideCitationSource(source) &&
        source.libraryID === quote.libraryID &&
        source.itemKey === quote.itemKey,
    );
  const quotesById = new Map(
    (params.quotes || []).map((quote) => [quote.quoteId, quote]),
  );
  const verified = new Map(
    (params.verifiedQuotes || []).map((quote) => [quote.quoteId, quote]),
  );
  const verifiedUses: TokenUse[] = [];
  for (const use of uses) {
    if (use.kind === "cite") {
      used.add(use.id);
      addSection(labels, use.id, use.section);
      continue;
    }
    if (verified.has(use.id)) {
      verifiedUses.push(use);
      continue;
    }
    // A downgraded quote is cited by the citation the host added for it,
    // else the one it reused: the paper's own, single-source first.
    const quote = quotesById.get(use.id);
    if (!quote) continue;
    const cluster =
      params.clusters.find(
        (candidate) => candidate.citationId === `cite-${use.id}`,
      ) ||
      params.clusters.find(
        (candidate) =>
          candidate.sources.length === 1 && cites(candidate, quote),
      ) ||
      params.clusters.find((candidate) => cites(candidate, quote));
    if (!cluster) continue;
    used.add(cluster.citationId);
    addSection(labels, cluster.citationId, use.section);
  }
  const out: TaskPaperDocumentCitation[] = [];
  const entryFor = (
    citationId: string,
    source: { libraryID: number; itemKey: string },
    sections: readonly string[],
  ) => {
    const entry: TaskPaperDocumentCitation = {
      citationId,
      libraryID: source.libraryID,
      itemKey: source.itemKey,
    };
    const item = params.itemOf?.(source.libraryID, source.itemKey);
    if (item?.itemId) entry.itemId = item.itemId;
    if (item?.title) entry.title = item.title;
    if (item?.firstCreator) entry.firstCreator = item.firstCreator;
    if (item?.year) entry.year = item.year;
    if (sections.length) entry.sectionLabel = sections[0];
    if (sections.length > 1) entry.sectionLabels = [...sections];
    return entry;
  };
  const cited = new Set<string>();
  for (const cluster of params.clusters) {
    if (!used.has(cluster.citationId)) continue;
    const sections = labels.get(cluster.citationId) || [];
    for (const source of cluster.sources) {
      if (isOutsideCitationSource(source)) continue;
      cited.add(`${source.libraryID}:${source.itemKey}`);
      out.push(entryFor(cluster.citationId, source, sections));
    }
  }
  const quoteSections = new Map<string, string[]>();
  for (const use of verifiedUses)
    addSection(quoteSections, use.id, use.section);
  for (const use of verifiedUses) {
    const quote = verified.get(use.id)!;
    const paper = `${quote.libraryID}:${quote.itemKey}`;
    if (cited.has(paper)) continue;
    cited.add(paper);
    out.push(entryFor(quote.quoteId, quote, quoteSections.get(use.id) || []));
  }
  return out;
}

type ZoteroItemLike = {
  id?: number;
  parentItem?: ZoteroItemLike | false | null;
  firstCreator?: string;
  getField?: (field: string) => unknown;
};

function fieldOf(item: ZoteroItemLike, field: string): string | undefined {
  try {
    const value = item.getField?.(field);
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The item a source names and its paper's record, when Zotero is there to
 * ask. An attachment keeps its own id; its title, creator and year are its
 * parent paper's.
 */
export function zoteroCitedSourceItem(
  libraryID: number,
  itemKey: string,
): CitedSourceItem | undefined {
  try {
    const items = (
      globalThis as {
        Zotero?: {
          Items?: {
            getByLibraryAndKey?: (
              libraryID: number,
              key: string,
            ) => ZoteroItemLike | false | undefined;
          };
        };
      }
    ).Zotero?.Items;
    const item = items?.getByLibraryAndKey?.(libraryID, itemKey);
    if (!item) return undefined;
    const paper = item.parentItem || item;
    const out: CitedSourceItem = {};
    const id = Number(item.id);
    if (Number.isInteger(id) && id > 0) out.itemId = id;
    const title = fieldOf(paper, "title");
    if (title) out.title = title;
    const creator =
      typeof paper.firstCreator === "string" && paper.firstCreator.trim()
        ? paper.firstCreator.trim()
        : undefined;
    if (creator) out.firstCreator = creator;
    const year = /\d{4}/.exec(fieldOf(paper, "date") || "")?.[0];
    if (year) out.year = year;
    return out;
  } catch {
    return undefined;
  }
}

/** Papers the document leaves out, as `item:<id>`, and why. */
type DocumentExclusion = { targetIds: string[]; reason: string };

type SubmitPlanDocumentResult = {
  documentId: string;
  contentHash: string;
  materialRef: MaterialRef;
  visibleMarkdown: string;
  /** Format repairs the host made instead of rejecting; omitted when none. */
  repairs?: string[];
  /** The papers the call leaves out, as the host reads them; omitted when none. */
  excluded?: DocumentExclusion[];
};

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return Number(value);
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = nonNegativeInteger(value, label);
  if (parsed < 1) throw new Error(`${label} must be positive`);
  return parsed;
}

function parseSource(value: unknown, label: string): PlanCitationSource {
  if (!validateObject<Record<string, unknown>>(value)) {
    throw new Error(`${label} must be an object`);
  }
  const zotero = value.libraryID !== undefined || value.itemKey !== undefined;
  if (value.paperId !== undefined) {
    if (zotero) {
      throw new Error(
        `${label} names either a Zotero item (libraryID and itemKey) or an outside paper (paperId), not both`,
      );
    }
    if (
      value.locator !== undefined ||
      (Array.isArray(value.evidenceRefs) && value.evidenceRefs.length)
    ) {
      throw new Error(
        `${label} is an outside paper: it takes no evidenceRefs or locator`,
      );
    }
    return {
      kind: "outside",
      paperId: requiredString(value.paperId, `${label}.paperId`),
      evidenceRefs: [],
    };
  }
  if (!zotero) {
    throw new Error(
      `${label} needs libraryID and itemKey (a Zotero item) or paperId (an outside paper)`,
    );
  }
  const evidenceRefs = Array.isArray(value.evidenceRefs)
    ? value.evidenceRefs.map((entry, index) =>
        requiredString(entry, `${label}.evidenceRefs[${index}]`),
      )
    : [];
  let locator: ZoteroCitationSource["locator"];
  if (value.locator !== undefined) {
    if (!validateObject<Record<string, unknown>>(value.locator)) {
      throw new Error(`${label}.locator must be an object`);
    }
    if (value.locator.kind !== "pdf_page") {
      throw new Error(`${label}.locator.kind must be pdf_page`);
    }
    locator = {
      kind: "pdf_page",
      attachmentItemKey: requiredString(
        value.locator.attachmentItemKey,
        `${label}.locator.attachmentItemKey`,
      ),
      pageIndex: nonNegativeInteger(
        value.locator.pageIndex,
        `${label}.locator.pageIndex`,
      ),
      sourceFingerprint: requiredString(
        value.locator.sourceFingerprint,
        `${label}.locator.sourceFingerprint`,
      ),
    };
  }
  return {
    libraryID: positiveInteger(value.libraryID, `${label}.libraryID`),
    itemKey: requiredString(value.itemKey, `${label}.itemKey`),
    evidenceRefs,
    ...(locator ? { locator } : {}),
  };
}

function parseCitation(value: unknown, index: number): PlanCitationCluster {
  const label = `citations[${index}]`;
  if (!validateObject<Record<string, unknown>>(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (!Array.isArray(value.sources) || !value.sources.length) {
    throw new Error(`${label}.sources must not be empty`);
  }
  return {
    citationId: requiredString(value.citationId, `${label}.citationId`),
    sources: value.sources.map((source, sourceIndex) =>
      parseSource(source, `${label}.sources[${sourceIndex}]`),
    ),
  };
}

function parseQuote(
  value: unknown,
  index: number,
): SubmitPlanDocumentInput["quotes"][number] {
  const label = `quotes[${index}]`;
  if (!validateObject<Record<string, unknown>>(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (!Array.isArray(value.evidenceRefs) || !value.evidenceRefs.length) {
    throw new Error(`${label}.evidenceRefs must not be empty`);
  }
  return {
    quoteId: requiredString(value.quoteId, `${label}.quoteId`),
    text: requiredString(value.text, `${label}.text`),
    libraryID: positiveInteger(value.libraryID, `${label}.libraryID`),
    itemKey: requiredString(value.itemKey, `${label}.itemKey`),
    attachmentItemKey: requiredString(
      value.attachmentItemKey,
      `${label}.attachmentItemKey`,
    ),
    evidenceRefs: value.evidenceRefs.map((entry, evidenceIndex) =>
      requiredString(entry, `${label}.evidenceRefs[${evidenceIndex}]`),
    ),
  };
}

function parseAssetProvenance(
  value: unknown,
  label: string,
): DocumentAssetProvenance {
  if (!validateObject<Record<string, unknown>>(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (value.origin === "extracted") {
    return {
      origin: "extracted",
      libraryID: positiveInteger(value.libraryID, `${label}.libraryID`),
      itemKey: requiredString(value.itemKey, `${label}.itemKey`),
      attachmentItemKey: requiredString(
        value.attachmentItemKey,
        `${label}.attachmentItemKey`,
      ),
      sourceFingerprint: requiredString(
        value.sourceFingerprint,
        `${label}.sourceFingerprint`,
      ),
      pageIndex: nonNegativeInteger(value.pageIndex, `${label}.pageIndex`),
      extractionToolVersion: requiredString(
        value.extractionToolVersion,
        `${label}.extractionToolVersion`,
      ),
    };
  }
  if (value.origin === "generated") {
    if (!Array.isArray(value.evidenceRefs)) {
      throw new Error(`${label}.evidenceRefs must be an array`);
    }
    return {
      origin: "generated",
      generator: requiredString(value.generator, `${label}.generator`),
      generatorVersion: requiredString(
        value.generatorVersion,
        `${label}.generatorVersion`,
      ),
      evidenceRefs: value.evidenceRefs.map((entry, index) =>
        requiredString(entry, `${label}.evidenceRefs[${index}]`),
      ),
    };
  }
  throw new Error(`${label}.origin must be extracted or generated`);
}

function parseAsset(value: unknown, index: number): PlanDocumentAsset {
  const label = `assets[${index}]`;
  if (!validateObject<Record<string, unknown>>(value)) {
    throw new Error(`${label} must be an object`);
  }
  const optionalDimension = (entry: unknown, field: string) =>
    entry === undefined
      ? undefined
      : positiveInteger(entry, `${label}.${field}`);
  return {
    assetId: requiredString(value.assetId, `${label}.assetId`),
    contentHash: requiredString(value.contentHash, `${label}.contentHash`),
    mimeType: requiredString(value.mimeType, `${label}.mimeType`),
    byteLength: positiveInteger(value.byteLength, `${label}.byteLength`),
    width: optionalDimension(value.width, "width"),
    height: optionalDimension(value.height, "height"),
    caption: requiredString(value.caption, `${label}.caption`),
    durablePath: requiredString(value.durablePath, `${label}.durablePath`),
    provenance: parseAssetProvenance(value.provenance, `${label}.provenance`),
  };
}

/**
 * The call's input: the document, the declared part it fulfils, and the
 * papers it leaves out. The part and the exclusions bind the outcome ledger
 * only; they are not document content.
 */
type SubmitDocumentToolInput = SubmitPlanDocumentInput & {
  taskId?: string;
  excluded?: DocumentExclusion[];
};

/** A paper's Zotero id as models write one: `12` or `item:12`. */
const ITEM_ID = /^(?:item:)?([1-9]\d*)$/;

function parseExclusion(value: unknown, index: number): DocumentExclusion {
  const label = `excluded[${index}]`;
  if (!validateObject<Record<string, unknown>>(value)) {
    throw new Error(`${label} must be an object`);
  }
  const named = Array.isArray(value.targetIds)
    ? value.targetIds.map((entry) => String(entry).trim()).filter(Boolean)
    : [];
  if (!named.length) {
    throw new Error(
      `${label} needs targetIds: the papers the document leaves out`,
    );
  }
  const notIds = named.filter((entry) => !ITEM_ID.test(entry));
  if (notIds.length) {
    throw new Error(
      `${label}.targetIds take Zotero item ids (12 or item:12), and these are not: ${notIds
        .map((entry) => JSON.stringify(entry))
        .join(", ")}`,
    );
  }
  const reason = typeof value.reason === "string" ? value.reason.trim() : "";
  if (!reason) {
    throw new Error(
      `${label} needs a reason: why the document leaves them out`,
    );
  }
  return {
    targetIds: [
      ...new Set(named.map((entry) => `item:${ITEM_ID.exec(entry)![1]}`)),
    ],
    reason,
  };
}

/** The papers the document leaves out; none when the list is absent or empty. */
function parseExclusions(value: unknown): DocumentExclusion[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("excluded must be an array");
  return value.map(parseExclusion);
}

function validateSubmitPlanDocument(
  args: unknown,
): AgentToolInputValidation<SubmitDocumentToolInput> {
  try {
    if (!validateObject<Record<string, unknown>>(args)) {
      return fail("submit_document expects an object");
    }
    // A list the model left out (models often omit an empty assets list) is
    // empty: rejecting it made the model resend the whole document only to
    // add []. A list given in another shape is still refused.
    const lists = {
      citations: args.citations ?? [],
      quotes: args.quotes ?? [],
      assets: args.assets ?? [],
      groundingIssues: args.groundingIssues ?? [],
    };
    if (
      !Array.isArray(lists.citations) ||
      !Array.isArray(lists.quotes) ||
      !Array.isArray(lists.assets) ||
      !Array.isArray(lists.groundingIssues)
    ) {
      return fail(
        "citations, quotes, assets, and groundingIssues must be arrays",
      );
    }
    if (
      args.groundingReviewed !== "passed" &&
      args.groundingReviewed !== "passed_with_limitations"
    ) {
      return fail("groundingReviewed must record the completed model review");
    }
    const documentKinds = new Set([
      "research_brief",
      "literature_review",
      "comparison",
      "report",
      "guide",
      "custom",
    ]);
    if (
      args.documentKind !== undefined &&
      !documentKinds.has(String(args.documentKind))
    ) {
      return fail("documentKind is not supported");
    }
    if (
      args.integrityPolicy !== undefined &&
      args.integrityPolicy !== "authored" &&
      args.integrityPolicy !== "research_grounded"
    ) {
      return fail("integrityPolicy is not supported");
    }
    const excluded = parseExclusions(args.excluded);
    return ok({
      documentKind:
        args.documentKind as SubmitPlanDocumentInput["documentKind"],
      integrityPolicy:
        args.integrityPolicy as SubmitPlanDocumentInput["integrityPolicy"],
      title: requiredString(args.title, "title"),
      markdown: requiredString(args.markdown, "markdown"),
      citations: lists.citations.map(parseCitation),
      quotes: lists.quotes.map(parseQuote),
      assets: lists.assets.map(parseAsset),
      groundingReviewed: args.groundingReviewed,
      groundingIssues: lists.groundingIssues.map((entry, index) =>
        requiredString(entry, `groundingIssues[${index}]`),
      ),
      ...(typeof args.taskId === "string" && args.taskId.trim()
        ? { taskId: args.taskId.trim() }
        : {}),
      ...(excluded.length ? { excluded } : {}),
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export function createSubmitDocumentTool(
  gateway: ZoteroGateway,
): AgentToolDefinition<SubmitDocumentToolInput, SubmitPlanDocumentResult> {
  const directFinalizer = new DirectDocumentFinalizer(gateway);
  return {
    spec: {
      name: "submit_document",
      description:
        "Finalize an Agent document. Use internal [[cite:C1]] tokens in Markdown and provide Zotero item mappings; research-grounded documents also require the host-issued evidence IDs returned by read tools. This tool validates and persists the exact authored content, which becomes the visible answer. The host repairs unused quotes, unverifiable quotes, and missing required headings, and lists the repairs in the result; it rejects only unresolved tokens, fabricated evidence, and quotes the open PDF does not contain. List papers the document leaves out under excluded, with the reason.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: [
          "title",
          "markdown",
          "citations",
          "quotes",
          "assets",
          "groundingReviewed",
          "groundingIssues",
        ],
        properties: {
          taskId: {
            type: "string",
            description:
              "The id of the declared part this document fulfils, when parts were declared. Name it so the host ticks the right part.",
          },
          excluded: {
            type: "array",
            description: "Papers left out, by id (12 or item:12).",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["targetIds", "reason"],
              properties: {
                targetIds: { type: "array", items: { type: "string" } },
                reason: { type: "string" },
              },
            },
          },
          documentKind: {
            type: "string",
            enum: [
              "research_brief",
              "literature_review",
              "comparison",
              "report",
              "guide",
              "custom",
            ],
            description: "Document shape.",
          },
          integrityPolicy: {
            type: "string",
            enum: ["authored", "research_grounded"],
            description:
              "Use research_grounded when the document makes claims from retrieved literature evidence.",
          },
          title: { type: "string" },
          markdown: { type: "string" },
          citations: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["citationId", "sources"],
              properties: {
                citationId: { type: "string" },
                sources: {
                  type: "array",
                  minItems: 1,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      libraryID: { type: "number" },
                      itemKey: { type: "string" },
                      paperId: {
                        type: "string",
                        description:
                          "An outside paper's paperId from literature_search or literature_read in this run",
                      },
                      evidenceRefs: {
                        type: "array",
                        items: { type: "string" },
                      },
                      locator: {
                        type: "object",
                        additionalProperties: false,
                        required: [
                          "kind",
                          "attachmentItemKey",
                          "pageIndex",
                          "sourceFingerprint",
                        ],
                        properties: {
                          kind: { type: "string", enum: ["pdf_page"] },
                          attachmentItemKey: { type: "string" },
                          pageIndex: { type: "number" },
                          sourceFingerprint: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          quotes: {
            type: "array",
            description:
              "Strict direct-quote mappings for [[quote:Q1]] tokens. Use [] when the document has no direct quotations; the host verifies each quote against an open PDF.js source and persists the location certificate.",
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "quoteId",
                "text",
                "libraryID",
                "itemKey",
                "attachmentItemKey",
                "evidenceRefs",
              ],
              properties: {
                quoteId: { type: "string" },
                text: { type: "string" },
                libraryID: { type: "number" },
                itemKey: { type: "string" },
                attachmentItemKey: { type: "string" },
                evidenceRefs: {
                  type: "array",
                  minItems: 1,
                  items: { type: "string" },
                },
              },
            },
          },
          assets: {
            type: "array",
            description:
              "Copy the selected figures' documentAsset objects returned by paper_read. The host renders their images, captions and provenance; do not also put Markdown image links in markdown. Use [] only when the document has no figures.",
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "assetId",
                "contentHash",
                "mimeType",
                "byteLength",
                "width",
                "height",
                "caption",
                "durablePath",
                "provenance",
              ],
              properties: {
                assetId: { type: "string" },
                contentHash: { type: "string" },
                mimeType: { type: "string" },
                byteLength: { type: "integer", minimum: 1 },
                width: { type: "integer", minimum: 1 },
                height: { type: "integer", minimum: 1 },
                caption: { type: "string" },
                durablePath: { type: "string" },
                provenance: {
                  anyOf: [
                    {
                      type: "object",
                      additionalProperties: false,
                      required: [
                        "origin",
                        "libraryID",
                        "itemKey",
                        "attachmentItemKey",
                        "sourceFingerprint",
                        "pageIndex",
                        "extractionToolVersion",
                      ],
                      properties: {
                        origin: { type: "string", enum: ["extracted"] },
                        libraryID: { type: "integer", minimum: 1 },
                        itemKey: { type: "string" },
                        attachmentItemKey: { type: "string" },
                        sourceFingerprint: { type: "string" },
                        pageIndex: { type: "integer", minimum: 0 },
                        extractionToolVersion: { type: "string" },
                      },
                    },
                    {
                      type: "object",
                      additionalProperties: false,
                      required: [
                        "origin",
                        "generator",
                        "generatorVersion",
                        "evidenceRefs",
                      ],
                      properties: {
                        origin: { type: "string", enum: ["generated"] },
                        generator: { type: "string" },
                        generatorVersion: { type: "string" },
                        evidenceRefs: {
                          type: "array",
                          items: { type: "string" },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
          groundingReviewed: {
            type: "string",
            enum: ["passed", "passed_with_limitations"],
          },
          groundingIssues: {
            type: "array",
            items: { type: "string" },
            description:
              "Non-authoritative grounding-review concerns. Required to be non-empty when groundingReviewed is passed_with_limitations.",
          },
        },
      },
      executionClass: "control",
      workCategory: "generation",
    },
    /**
     * The document card already shows the reader what a call submitted, so a
     * row for each call would report the trace's own plumbing.
     */
    presentation: { hiddenInTrace: true },
    guidance: {
      // The model description in registry.ts says when a document is
      // required (a literature review); this guidance is selected for no turn,
      // and the instruction reaches MCP clients through that description.
      matches: neverSelected,
      instruction:
        "Use submit_document to publish authored content as a durable document. Finish the requested work and call submit_document once; to save the document, pass its returned documentId to the save tool instead of reconstructing its content. Write complete Markdown with natural headings. Put [[cite:C1]] tokens at supported claims; citations are required for a literature review and optional for other authored documents. Identify each citation source by libraryID and itemKey, or an outside paper by paperId; the host binds its durable research evidence, so omit evidenceRefs unless a strict quote or page locator requires a specific record. Record grounding concerns in groundingIssues. The host replaces any draft References section with a Zotero CSL bibliography. Never place internal citation tokens outside this terminal submission. When parts were declared, pass the taskId of the part this document fulfils.",
    },
    validate: validateSubmitPlanDocument,
    planInvocation: () =>
      readOnlyInvocationPlan({
        domains: [],
        reason:
          "This host-owned control submits an already prepared workflow document.",
      }),
    // The toolExecution host reads the part and the exclusions from the
    // validated input onto the material's outcome evidence.
    execute: async ({ taskId: _part, excluded, ...input }, context) => {
      const { document, repairs } = await directFinalizer.finalize({
        request: context.request,
        runId:
          context.runId ||
          (() => {
            throw new Error("Direct document run identity is unavailable");
          })(),
        input,
        outsidePaperChoiceAvailable: canShowLiteratureReview(context),
      });
      const materialRef = materialRefFromDocument(document);
      // Each paper left out is the agent's exclude decision, recorded as
      // record_paper_decisions records one (taskPaperLedgerRecorder.ts).
      const paperDecisions = exclusionPaperDecisions(
        excluded || [],
        context.request.libraryID,
        gateway,
      );
      return {
        // The model reads the reference from the payload; the host reads it
        // from the typed result and announces it as a run event.
        content: {
          documentId: document.documentId,
          contentHash: document.contentHash,
          materialRef,
          visibleMarkdown: document.visibleMarkdown,
          ...(repairs.length ? { repairs } : {}),
          // What the host records as left out, as it reads the ids.
          ...(excluded?.length ? { excluded } : {}),
        },
        materialRef,
        materialKind:
          document.version === 2 ? document.documentKind : undefined,
        materialTitle: document.title,
        // The finalized clusters, which include the citations the host's
        // repairs added; the draft only places the tokens.
        materialCitedSources: documentCitedSources({
          markdown: input.markdown,
          title: document.title,
          clusters: document.citationBundle.clusters,
          quotes: input.quotes,
          verifiedQuotes: document.verifiedQuotes,
          itemOf: zoteroCitedSourceItem,
        }),
        ...(paperDecisions.length ? { paperDecisions } : {}),
      };
    },
    resolveTerminalResult: (_input, result: AgentToolResult) => {
      if (!validateObject<Record<string, unknown>>(result.content)) return null;
      const documentId =
        typeof result.content.documentId === "string"
          ? result.content.documentId
          : "";
      const finalText =
        typeof result.content.visibleMarkdown === "string"
          ? result.content.visibleMarkdown
          : "";
      if (!documentId || !finalText) return null;
      return {
        finalText,
        documentId,
        providerTranscript: "tool_only",
      };
    },
  };
}
