import type {
  StructuredCitationItem,
  ZoteroGateway,
} from "../services/zoteroGateway";
import type { ResearchEvidenceRecord } from "./coverageTypes";
import type { ResearchScopeSnapshotItem } from "./coverageTypes";
import {
  citationSourceKey,
  isOutsideBibliographyEntry,
  isOutsideCitationSource,
  type BibliographyEntry,
  type DocumentSpec,
  type FormattedCitationBundle,
  type OutsideCitationSource,
  type OutsidePaperSnapshot,
  type PlanCitationCluster,
  type PlanCitationSource,
  type ZoteroCitationSource,
} from "./types";
import { stripHandwrittenReferences } from "./draftValidation";
import { outsidePaperUri } from "./outsidePaperCitations";
import { ToolInputRejection } from "../tools/execution/failure";
import {
  isQuoteTokenId,
  quoteTokenPattern,
  quoteTokenSource,
} from "../../services/quotes/quoteTokenIds";

const CITATION_TOKEN = quoteTokenPattern("cite");
/** One `[[cite:ID]]` token, without a capture group. */
const CITATION_TOKEN_SOURCE = quoteTokenSource("cite", { capture: false });
const WHOLE_CITATION_TOKEN = new RegExp(`^${CITATION_TOKEN_SOURCE}$`);
const PARENTHETICAL_CITATION = new RegExp(
  `\\(([^()\\r\\n]*${CITATION_TOKEN_SOURCE}[^()\\r\\n]*)\\)`,
  "g",
);
const PARENTHETICAL_CITATION_SLOT = new RegExp(
  `^(.*?)\\s*${quoteTokenSource("cite")}$`,
);
const CITATION_TOKEN_RUN = new RegExp(
  `(\\([^()\\r\\n]*\\)[\\t ]*)?(${CITATION_TOKEN_SOURCE}(?:[\\t ]*${CITATION_TOKEN_SOURCE})*)`,
  "g",
);

export type DocumentCitationEvidence = Pick<
  ResearchEvidenceRecord,
  | "version"
  | "evidenceRef"
  | "observationId"
  | "libraryID"
  | "itemKey"
  | "sourceKind"
> & {
  locator?:
    | ResearchEvidenceRecord["locator"]
    | Readonly<{
        kind: "attachment_text";
        attachmentItemKey: string;
        pageIndex?: number;
        sourceFingerprint?: string;
      }>;
};

/** A citable source: a Zotero item, or an outside paper the run recorded. */
export type DocumentCitationCorpusItem =
  | Pick<ResearchScopeSnapshotItem, "libraryID" | "itemKey">
  | Pick<OutsideCitationSource, "kind" | "paperId">;

function itemByLibraryAndKey(
  libraryID: number,
  itemKey: string,
): Zotero.Item | null {
  const items = Zotero.Items as unknown as {
    getByLibraryAndKey?: (
      libraryID: number,
      itemKey: string,
    ) => Zotero.Item | false | undefined;
  };
  return items.getByLibraryAndKey?.(libraryID, itemKey) || null;
}

function libraryPath(libraryID: number): string {
  if (libraryID === Number(Zotero.Libraries.userLibraryID)) return "library";
  const library = Zotero.Libraries.get(libraryID) as
    | { groupID?: number }
    | undefined;
  return library?.groupID ? `groups/${library.groupID}` : "library";
}

export function buildZoteroItemUri(libraryID: number, itemKey: string): string {
  return `zotero://select/${libraryPath(libraryID)}/items/${itemKey}`;
}

/**
 * The link a cited source opens: a Zotero item or PDF page, or an outside
 * paper's DOI or page, read from the document's outside-paper snapshots.
 */
export function buildPlanCitationSourceUri(
  source: PlanCitationSource,
  outsidePapers: readonly OutsidePaperSnapshot[] = [],
): string {
  if (isOutsideCitationSource(source)) {
    const paper = outsidePapers.find(
      (entry) => entry.paperId === source.paperId,
    );
    const uri = paper && outsidePaperUri(paper);
    if (!uri) {
      throw new Error(`Outside paper ${source.paperId} has no citation link`);
    }
    return uri;
  }
  if (source.locator) {
    return `zotero://open-pdf/${libraryPath(source.libraryID)}/items/${source.locator.attachmentItemKey}?page=${source.locator.pageIndex + 1}`;
  }
  return buildZoteroItemUri(source.libraryID, source.itemKey);
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/(\[|\])/g, "\\$1");
}

function normalizeOutput(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function numberedCitationSources(
  cluster: FormattedCitationBundle["clusters"][number],
  outsidePapers: readonly OutsidePaperSnapshot[] = [],
): string {
  return cluster.sources
    .map(
      (source, index) =>
        `[${index + 1}](${buildPlanCitationSourceUri(source, outsidePapers)})`,
    )
    .join(" ");
}

/** Bind author-year group labels by CSL identity, never by input/source order. */
function linkedCitationGroups(
  gateway: ZoteroGateway,
  bundle: Pick<
    FormattedCitationBundle,
    "clusters" | "style" | "locale" | "outsidePapers"
  >,
): Map<string, string> {
  const groups = bundle.clusters.filter(
    (cluster) =>
      cluster.sources.length > 1 && /^\([^()]+\)$/.test(cluster.text),
  );
  const result = new Map<string, string>();
  if (!groups.length) return result;
  const outsidePapers = bundle.outsidePapers || [];
  const inputs = groups.flatMap((cluster, groupIndex) =>
    cluster.sources.map((source, sourceIndex) => {
      let item: StructuredCitationItem | null = null;
      if (isOutsideCitationSource(source)) {
        const paper = outsidePapers.find(
          (entry) => entry.paperId === source.paperId,
        );
        if (paper) item = { outsideId: paper.csl.id };
      } else {
        const zoteroItem = itemByLibraryAndKey(
          source.libraryID,
          source.itemKey,
        );
        if (zoteroItem)
          item = {
            itemId: Number(zoteroItem.id),
            pageIndex: source.locator?.pageIndex,
          };
      }
      return {
        citationId: `source-${groupIndex}-${sourceIndex}`,
        source,
        group: cluster.citationId,
        item,
      };
    }),
  );
  // Missing sources or unavailable styles leave the original exact links intact.
  if (inputs.some((input) => !input.item)) return result;
  const outsideItems = outsidePapers
    .filter((paper) =>
      inputs.some(
        (input) =>
          input.item &&
          "outsideId" in input.item &&
          input.item.outsideId === paper.csl.id,
      ),
    )
    .map((paper) => paper.csl);
  const formatted = gateway.formatStructuredCitations({
    clusters: inputs.map((input) => ({
      citationId: input.citationId,
      items: [input.item!],
    })),
    ...(outsideItems.length ? { outsideItems } : {}),
    styleId: bundle.style.id,
    locale: bundle.locale,
  });
  const labels = new Map(
    formatted.clusters.map((cluster) => [
      cluster.citationId,
      normalizeOutput(cluster.text).replace(/^\(|\)$/g, ""),
    ]),
  );
  for (const cluster of groups) {
    const members = inputs.filter(
      (input) => input.group === cluster.citationId,
    );
    const byLabel = new Map(
      members.map((input) => [labels.get(input.citationId), input.source]),
    );
    const parts = cluster.text.slice(1, -1).split("; ");
    // Collapsed/numeric styles and ambiguous labels cannot be split by guesswork.
    if (
      byLabel.size !== members.length ||
      parts.length !== members.length ||
      parts.some((part) => !byLabel.has(part))
    )
      continue;
    result.set(
      cluster.citationId,
      `(${parts.map((part) => `[${escapeMarkdownLabel(part)}](${buildPlanCitationSourceUri(byLabel.get(part)!, outsidePapers)})`).join("; ")})`,
    );
  }
  return result;
}

/** Presentation-only binding for previously saved grouped citations. */
export function bindDocumentCitationGroupsForDisplay(params: {
  markdown: string;
  bundle: FormattedCitationBundle;
  gateway: ZoteroGateway;
}): string {
  const outsidePapers = params.bundle.outsidePapers || [];
  const numbered = (cluster: FormattedCitationBundle["clusters"][number]) => {
    try {
      return numberedCitationSources(cluster, outsidePapers);
    } catch {
      // A source without a link was never written as numbered links.
      return null;
    }
  };
  const candidates = params.bundle.clusters.filter((cluster) => {
    const links = cluster.sources.length > 1 && numbered(cluster);
    return (
      Boolean(links) && params.markdown.includes(`${cluster.text} ${links}`)
    );
  });
  if (!candidates.length) return params.markdown;
  const links = linkedCitationGroups(params.gateway, {
    ...params.bundle,
    clusters: candidates,
  });
  let markdown = params.markdown;
  for (const cluster of candidates) {
    const linked = links.get(cluster.citationId);
    if (linked)
      markdown = markdown
        .split(`${cluster.text} ${numbered(cluster)}`)
        .join(linked);
  }
  return markdown;
}

function validateLocator(params: {
  source: ZoteroCitationSource;
  evidence: readonly DocumentCitationEvidence[];
}): void {
  if (!params.source.locator) return;
  const trusted = params.evidence.some(
    (record) =>
      record.version === 2 &&
      Boolean(record.observationId) &&
      params.source.evidenceRefs.includes(record.evidenceRef) &&
      record.libraryID === params.source.libraryID &&
      record.itemKey === params.source.itemKey &&
      record.locator?.attachmentItemKey ===
        params.source.locator?.attachmentItemKey &&
      record.locator?.pageIndex === params.source.locator?.pageIndex &&
      record.locator?.sourceFingerprint ===
        params.source.locator?.sourceFingerprint,
  );
  if (!trusted) {
    throw new ToolInputRejection(
      `Citation locator for ${params.source.itemKey} is not backed by trusted evidence`,
    );
  }
}

/**
 * Citation provenance is a host responsibility once research evidence is
 * durable. Models identify the citable Zotero paper; the host attaches the
 * opaque evidence records for that exact identity. Explicit references remain
 * supported for strict quotes and advanced callers.
 */
export function bindCitationEvidenceRefs(
  clusters: readonly PlanCitationCluster[],
  evidence: readonly DocumentCitationEvidence[],
): PlanCitationCluster[] {
  return clusters.map((cluster) => ({
    ...cluster,
    sources: cluster.sources.map((source) => {
      // An outside paper has no Zotero evidence records to bind.
      if (isOutsideCitationSource(source) || source.evidenceRefs.length)
        return source;
      const evidenceRefs = evidence
        .filter(
          (record) =>
            record.version === 2 &&
            Boolean(record.observationId) &&
            record.libraryID === source.libraryID &&
            record.itemKey === source.itemKey,
        )
        .sort((left, right) => {
          const rank = {
            quote: 4,
            figure: 3,
            body: 2,
            abstract: 1,
            metadata: 0,
          };
          return rank[right.sourceKind] - rank[left.sourceKind];
        })
        .map((record) => record.evidenceRef);
      return { ...source, evidenceRefs: [...new Set(evidenceRefs)] };
    }),
  }));
}

/**
 * Split each `[[cite:A,B,C]]` token into adjacent single tokens
 * `[[cite:A]][[cite:B]][[cite:C]]`, the form consecutive citations take: the
 * chat answer accepts comma-joined ids, so models write them here too. Only a
 * token whose every id is well formed splits; one with an empty id stays as
 * written and is refused as malformed, and an unknown id is refused by name
 * as an unresolved token.
 */
function splitCommaJoinedTokens(markdown: string, repairs: string[]): string {
  return markdown.replace(/\[\[cite:([^\]]*,[^\]]*)\]\]/g, (token, body) => {
    const ids = String(body)
      .split(",")
      .map((id) => id.trim());
    if (!ids.every(isQuoteTokenId)) return token;
    repairs.push(`split comma-joined citation token ${token}`);
    return ids.map((id) => `[[cite:${id}]]`).join("");
  });
}

/** A Zotero source's whole identity: its item, evidence and locator. */
function carriedSourceIdentity(source: ZoteroCitationSource): string {
  return JSON.stringify([
    source.libraryID,
    source.itemKey,
    [...source.evidenceRefs],
    source.locator
      ? [
          source.locator.attachmentItemKey,
          source.locator.pageIndex,
          source.locator.sourceFingerprint,
        ]
      : null,
  ]);
}

/** A cluster's cited work before outside papers have CSL ids. */
type ResolvedCitationItem =
  | { itemId: number; pageIndex?: number }
  | { paperId: string };

export async function formatDocumentCitations(params: {
  gateway: ZoteroGateway;
  draftMarkdown: string;
  clusters: readonly PlanCitationCluster[];
  corpus: readonly DocumentCitationCorpusItem[];
  evidence: readonly DocumentCitationEvidence[];
  spec: DocumentSpec;
  requireEvidence?: boolean;
  /**
   * The outside papers the clusters may cite, by paperId. Each one a used
   * cluster cites is formatted from its CSL item and kept in the bundle.
   */
  outsidePapers?: readonly OutsidePaperSnapshot[];
  /**
   * Zotero sources a stored document cited, carried unchanged into a new
   * version of it. Their evidence references and page locators were checked
   * when that document was published, against evidence the current run no
   * longer holds, so an identical source is not checked again.
   */
  carriedSources?: readonly ZoteroCitationSource[];
}): Promise<{
  visibleMarkdown: string;
  citationBundle: FormattedCitationBundle;
  /** Unused citation mappings the host dropped instead of rejecting. */
  repairs: string[];
}> {
  const repairs: string[] = [];
  const draftMarkdown = splitCommaJoinedTokens(
    stripHandwrittenReferences(params.draftMarkdown),
    repairs,
  );
  const corpusKeys = new Set(params.corpus.map(citationSourceKey));
  const carriedSources = new Set(
    (params.carriedSources || []).map(carriedSourceIdentity),
  );
  const evidenceByRef = new Map(
    params.evidence.map((record) => [record.evidenceRef, record]),
  );
  const boundClusters =
    params.requireEvidence === false
      ? [...params.clusters]
      : bindCitationEvidenceRefs(params.clusters, params.evidence);
  const clustersById = new Map<string, PlanCitationCluster>();
  const allResolved = boundClusters.map((cluster) => {
    if (!cluster.citationId.trim() || clustersById.has(cluster.citationId)) {
      throw new ToolInputRejection(
        `Duplicate or empty citation ID: ${cluster.citationId}`,
      );
    }
    if (!cluster.sources.length) {
      throw new ToolInputRejection(
        `Citation ${cluster.citationId} has no sources`,
      );
    }
    const sourceKeys = cluster.sources.map(citationSourceKey);
    if (new Set(sourceKeys).size !== sourceKeys.length) {
      throw new ToolInputRejection(
        `Citation ${cluster.citationId} contains duplicate sources`,
      );
    }
    clustersById.set(cluster.citationId, cluster);
    const items = cluster.sources.flatMap((source): ResolvedCitationItem[] => {
      if (!corpusKeys.has(citationSourceKey(source))) {
        throw new ToolInputRejection(
          `Citation ${cluster.citationId} references an item outside the approved corpus`,
        );
      }
      // An outside paper is in the corpus because the run recorded it; it has
      // no Zotero evidence records, locator or item to check.
      if (isOutsideCitationSource(source)) return [{ paperId: source.paperId }];
      const carried = carriedSources.has(carriedSourceIdentity(source));
      if (
        !carried &&
        params.requireEvidence !== false &&
        !source.evidenceRefs.length
      ) {
        throw new ToolInputRejection(
          `Citation ${cluster.citationId} requires at least one evidence reference`,
        );
      }
      for (const evidenceRef of carried ? [] : source.evidenceRefs) {
        const evidence = evidenceByRef.get(evidenceRef);
        if (
          !evidence ||
          evidence.version !== 2 ||
          !evidence.observationId ||
          evidence.libraryID !== source.libraryID ||
          evidence.itemKey !== source.itemKey
        ) {
          throw new ToolInputRejection(
            `Citation ${cluster.citationId} has an invalid evidence reference`,
          );
        }
      }
      if (!carried && (params.requireEvidence !== false || source.locator)) {
        validateLocator({ source, evidence: params.evidence });
      }
      const item = itemByLibraryAndKey(source.libraryID, source.itemKey);
      if (!item || item.isNote?.()) {
        throw new ToolInputRejection(
          `Citation ${cluster.citationId} does not resolve to a citable Zotero item`,
        );
      }
      return [
        {
          itemId: Number(item.id),
          pageIndex: source.locator?.pageIndex,
        },
      ];
    });
    return { citationId: cluster.citationId, items };
  });

  const tokenIds: string[] = [];
  for (const match of draftMarkdown.matchAll(CITATION_TOKEN)) {
    tokenIds.push(match[1]);
  }
  for (const citationId of tokenIds) {
    if (!clustersById.has(citationId)) {
      throw new ToolInputRejection(
        `Document contains unresolved citation token ${citationId}`,
      );
    }
  }
  // A token the strict form does not match would otherwise ship as literal
  // text while its clusters are dropped as unused.
  for (const [token] of draftMarkdown.matchAll(/\[\[cite:[^\]]*\]\]/g)) {
    if (!WHOLE_CITATION_TOKEN.test(token)) {
      throw new ToolInputRejection(
        `Document contains malformed citation token ${token}; use one [[cite:ID]] token per citation`,
      );
    }
  }
  if (!tokenIds.length && boundClusters.length) {
    throw new ToolInputRejection(
      "Citation mappings were supplied but the document has no citation tokens",
    );
  }
  // A mapping no token uses is dropped: it changes nothing the reader sees.
  for (const citationId of [...clustersById.keys()]) {
    if (!tokenIds.includes(citationId)) {
      clustersById.delete(citationId);
      repairs.push(`dropped unused citation ${citationId}`);
    }
  }
  const clusters = boundClusters.filter((cluster) =>
    clustersById.has(cluster.citationId),
  );
  const resolved = allResolved.filter((cluster) =>
    clustersById.has(cluster.citationId),
  );
  // The outside papers the used clusters cite, numbered ext-1, ext-2, ... in
  // the order the clusters first cite them.
  const outsidePapers: OutsidePaperSnapshot[] = [];
  for (const cluster of clusters) {
    for (const source of cluster.sources) {
      if (
        !isOutsideCitationSource(source) ||
        outsidePapers.some((paper) => paper.paperId === source.paperId)
      )
        continue;
      const paper = params.outsidePapers?.find(
        (entry) => entry.paperId === source.paperId,
      );
      if (!paper) {
        throw new ToolInputRejection(
          `Citation ${cluster.citationId} cites outside paper ${source.paperId}, which has no record to format it from`,
        );
      }
      if (!outsidePaperUri(paper)) {
        throw new ToolInputRejection(
          `Citation ${cluster.citationId} cites outside paper ${source.paperId}, which has no DOI or page to link to`,
        );
      }
      const csl = { ...paper.csl, id: `ext-${outsidePapers.length + 1}` };
      outsidePapers.push({ ...paper, csl });
    }
  }
  const cslIdByPaperId = new Map(
    outsidePapers.map((paper) => [paper.paperId, paper.csl.id]),
  );
  if (!clusters.length) {
    if (params.spec.requiresReferences) {
      throw new ToolInputRejection(
        "The approved document requires References but contains no citations",
      );
    }
    return {
      visibleMarkdown: draftMarkdown,
      citationBundle: {
        clusters: [],
        bibliographyEntries: [],
        style: {
          id: params.spec.citationStyle.styleId,
          title: params.spec.citationStyle.styleTitle,
        },
        locale: params.spec.citationStyle.locale,
      },
      repairs,
    };
  }

  // App readiness does not await the style registry. Native init() joins its
  // existing initialization promise, including any bundled style update.
  await Zotero.Styles?.init?.();
  const formatted = params.gateway.formatStructuredCitations({
    clusters: resolved.map((cluster) => ({
      citationId: cluster.citationId,
      items: cluster.items.map(
        (item): StructuredCitationItem =>
          "paperId" in item
            ? { outsideId: cslIdByPaperId.get(item.paperId)! }
            : item,
      ),
    })),
    ...(outsidePapers.length
      ? { outsideItems: outsidePapers.map((paper) => paper.csl) }
      : {}),
    styleId: params.spec.citationStyle.styleId,
    locale: params.spec.citationStyle.locale,
  });
  const sourceByItemId = new Map<number, ZoteroCitationSource>();
  for (const cluster of clusters) {
    for (const source of cluster.sources) {
      if (isOutsideCitationSource(source)) continue;
      const item = itemByLibraryAndKey(source.libraryID, source.itemKey);
      if (item) sourceByItemId.set(Number(item.id), source);
    }
  }
  const formattedClusters = formatted.clusters.map((cluster) => ({
    citationId: cluster.citationId,
    text: normalizeOutput(cluster.text),
    html: cluster.html,
    sources: clustersById.get(cluster.citationId)!.sources,
  }));
  const clusterById = new Map(
    formattedClusters.map((cluster) => [cluster.citationId, cluster]),
  );
  const groupLinks = linkedCitationGroups(params.gateway, {
    clusters: formattedClusters,
    style: {
      id: params.spec.citationStyle.styleId,
      title: params.spec.citationStyle.styleTitle,
    },
    locale: params.spec.citationStyle.locale,
    outsidePapers,
  });
  const renderCluster = (
    cluster: FormattedCitationBundle["clusters"][number],
    label = cluster.text,
  ) => {
    if (cluster.sources.length !== 1) {
      const linked = groupLinks.get(cluster.citationId);
      if (linked) return label === cluster.text ? linked : linked.slice(1, -1);
      return `${label} ${numberedCitationSources(cluster, outsidePapers)}`;
    }
    return `[${escapeMarkdownLabel(label)}](${buildPlanCitationSourceUri(cluster.sources[0], outsidePapers)})`;
  };
  // Tokens inside a parenthetical reference can stand in for the year in
  // model-authored text, e.g. (Alpha [[cite:a]]; Beta [[cite:b]]). Bind the
  // whole reference only when every literal label exactly matches its CSL
  // author or full label. Unrelated parenthetical prose is left untouched.
  const boundParentheses = draftMarkdown.replace(
    PARENTHETICAL_CITATION,
    (original, body: string) => {
      const rendered: string[] = [];
      for (const part of body.split(/;\s*/)) {
        const slot = part.trim().match(PARENTHETICAL_CITATION_SLOT);
        const cluster = slot && clusterById.get(slot[2]);
        if (!slot || !cluster || !/^\([^()]+\)$/.test(cluster.text))
          return original;
        const label = cluster.text.slice(1, -1);
        const author = label.replace(/, (?:\d{4}[a-z]?|n\.d\.)(?:, .+)?$/, "");
        if (slot[1] && slot[1] !== label && slot[1] !== author) return original;
        rendered.push(renderCluster(cluster, label));
      }
      return `(${rendered.join("; ")})`;
    },
  );
  let visibleMarkdown = boundParentheses.replace(
    CITATION_TOKEN_RUN,
    (_token, literalLabel: string | undefined, tokens: string) => {
      const group = [...tokens.matchAll(CITATION_TOKEN)].map((match) => {
        const cluster = clusterById.get(match[1]);
        if (!cluster) throw new Error(`Citation ${match[1]} was not formatted`);
        return cluster;
      });
      const combinedLabel =
        group.length === 1
          ? group[0].text
          : `(${group.map((cluster) => cluster.text.replace(/^\(|\)$/g, "")).join("; ")})`;
      // A parenthesis may also contain an introductory qualifier ("e.g.,"
      // or a claim ending in a colon). Preserve that prose, replacing only
      // the exact ordered CSL citation suffix with links inside the group.
      const literal = literalLabel?.trim() || "";
      const labels = group.map((cluster) => cluster.text.slice(1, -1));
      const suffix = labels.join("; ");
      if (
        group.every((cluster) => /^\([^()]+\)$/.test(cluster.text)) &&
        literal.startsWith("(") &&
        literal.endsWith(`${suffix})`)
      ) {
        const introduction = literal.slice(1, -suffix.length - 1);
        if (/[,;:]\s+$/.test(introduction)) {
          return `(${introduction}${group.map((cluster, index) => renderCluster(cluster, labels[index])).join("; ")})`;
        }
      }
      // Bind only an exact host-formatted label to its adjacent token group.
      // Neither unrelated parentheses nor separate occurrences are removed.
      const prefix =
        literalLabel?.trim() === combinedLabel ? "" : literalLabel || "";
      return prefix + group.map((cluster) => renderCluster(cluster)).join(" ");
    },
  );
  CITATION_TOKEN.lastIndex = 0;
  if (CITATION_TOKEN.test(visibleMarkdown)) {
    throw new Error("Internal citation tokens remain after serialization");
  }
  CITATION_TOKEN.lastIndex = 0;
  const bibliographyEntries = formatted.bibliographyEntries.map(
    (entry): BibliographyEntry => {
      if ("outsideId" in entry) {
        const paper = outsidePapers.find(
          (candidate) => candidate.csl.id === entry.outsideId,
        );
        if (!paper) {
          throw new Error(
            "A bibliography entry could not be paired with its outside paper",
          );
        }
        return {
          paperId: paper.paperId,
          text: normalizeOutput(entry.text),
          html: entry.html,
        };
      }
      const source = sourceByItemId.get(entry.itemId);
      if (!source) {
        throw new Error(
          "A bibliography entry could not be paired with its Zotero item",
        );
      }
      return {
        libraryID: source.libraryID,
        itemKey: source.itemKey,
        text: normalizeOutput(entry.text),
        html: entry.html,
      };
    },
  );
  if (params.spec.requiresReferences) {
    // One list in the style's order: a Zotero entry selects its item, an
    // outside entry opens its DOI or page.
    const references = bibliographyEntries
      .map(
        (entry) =>
          `- [${escapeMarkdownLabel(entry.text)}](${
            isOutsideBibliographyEntry(entry)
              ? buildPlanCitationSourceUri(
                  { kind: "outside", paperId: entry.paperId, evidenceRefs: [] },
                  outsidePapers,
                )
              : buildZoteroItemUri(entry.libraryID, entry.itemKey)
          })`,
      )
      .join("\n");
    visibleMarkdown = `${visibleMarkdown.trimEnd()}\n\n## References\n\n${references}\n`;
  }
  return {
    visibleMarkdown,
    citationBundle: {
      clusters: formattedClusters,
      bibliographyEntries,
      style: { id: formatted.styleId, title: formatted.styleTitle },
      locale: formatted.locale,
      ...(outsidePapers.length ? { outsidePapers } : {}),
    },
    repairs,
  };
}

/** Compatibility alias for the original Plan-only API. */
export const formatPlanDocumentCitations = formatDocumentCitations;
