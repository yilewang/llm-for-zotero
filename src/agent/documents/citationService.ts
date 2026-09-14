import type { ZoteroGateway } from "../services/zoteroGateway";
import type { ResearchEvidenceRecord } from "../research/types";
import type { ResearchScopeSnapshotItem } from "../research/types";
import type {
  DocumentSpec,
  FormattedCitationBundle,
  PlanCitationCluster,
  PlanCitationSource,
} from "./types";
import { stripHandwrittenReferences } from "./draftValidation";
import { ToolInputRejection } from "../tools/execution/failure";

const CITATION_TOKEN = /\[\[cite:([A-Za-z0-9._:-]+)\]\]/g;

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

export type DocumentCitationCorpusItem = Pick<
  ResearchScopeSnapshotItem,
  "libraryID" | "itemKey"
>;

function sourceKey(source: Pick<PlanCitationSource, "libraryID" | "itemKey">) {
  return `${source.libraryID}:${source.itemKey}`;
}

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

export function buildPlanCitationSourceUri(source: PlanCitationSource): string {
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
): string {
  return cluster.sources
    .map(
      (source, index) =>
        `[${index + 1}](${buildPlanCitationSourceUri(source)})`,
    )
    .join(" ");
}

/** Bind author-year group labels by CSL identity, never by input/source order. */
function linkedCitationGroups(
  gateway: ZoteroGateway,
  bundle: Pick<FormattedCitationBundle, "clusters" | "style" | "locale">,
): Map<string, string> {
  const groups = bundle.clusters.filter(
    (cluster) =>
      cluster.sources.length > 1 && /^\([^()]+\)$/.test(cluster.text),
  );
  const result = new Map<string, string>();
  if (!groups.length) return result;
  const inputs = groups.flatMap((cluster, groupIndex) =>
    cluster.sources.map((source, sourceIndex) => ({
      citationId: `source-${groupIndex}-${sourceIndex}`,
      source,
      group: cluster.citationId,
      item: itemByLibraryAndKey(source.libraryID, source.itemKey),
    })),
  );
  // Missing sources or unavailable styles leave the original exact links intact.
  if (inputs.some((input) => !input.item)) return result;
  const formatted = gateway.formatStructuredCitations({
    clusters: inputs.map((input) => ({
      citationId: input.citationId,
      items: [
        {
          itemId: Number(input.item!.id),
          pageIndex: input.source.locator?.pageIndex,
        },
      ],
    })),
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
      `(${parts.map((part) => `[${escapeMarkdownLabel(part)}](${buildPlanCitationSourceUri(byLabel.get(part)!)})`).join("; ")})`,
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
  const candidates = params.bundle.clusters.filter(
    (cluster) =>
      cluster.sources.length > 1 &&
      params.markdown.includes(
        `${cluster.text} ${numberedCitationSources(cluster)}`,
      ),
  );
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
        .split(`${cluster.text} ${numberedCitationSources(cluster)}`)
        .join(linked);
  }
  return markdown;
}

function validateLocator(params: {
  source: PlanCitationSource;
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
      if (source.evidenceRefs.length) return source;
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

export async function formatDocumentCitations(params: {
  gateway: ZoteroGateway;
  draftMarkdown: string;
  clusters: readonly PlanCitationCluster[];
  corpus: readonly DocumentCitationCorpusItem[];
  evidence: readonly DocumentCitationEvidence[];
  spec: DocumentSpec;
  requireEvidence?: boolean;
}): Promise<{
  visibleMarkdown: string;
  citationBundle: FormattedCitationBundle;
}> {
  const draftMarkdown = stripHandwrittenReferences(params.draftMarkdown);
  const corpusKeys = new Set(params.corpus.map(sourceKey));
  const evidenceByRef = new Map(
    params.evidence.map((record) => [record.evidenceRef, record]),
  );
  const clusters =
    params.requireEvidence === false
      ? [...params.clusters]
      : bindCitationEvidenceRefs(params.clusters, params.evidence);
  const clustersById = new Map<string, PlanCitationCluster>();
  const resolved = clusters.map((cluster) => {
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
    const sourceKeys = cluster.sources.map(sourceKey);
    if (new Set(sourceKeys).size !== sourceKeys.length) {
      throw new ToolInputRejection(
        `Citation ${cluster.citationId} contains duplicate sources`,
      );
    }
    clustersById.set(cluster.citationId, cluster);
    const items = cluster.sources.map((source) => {
      if (!corpusKeys.has(sourceKey(source))) {
        throw new ToolInputRejection(
          `Citation ${cluster.citationId} references an item outside the approved corpus`,
        );
      }
      if (params.requireEvidence !== false && !source.evidenceRefs.length) {
        throw new ToolInputRejection(
          `Citation ${cluster.citationId} requires at least one evidence reference`,
        );
      }
      for (const evidenceRef of source.evidenceRefs) {
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
      if (params.requireEvidence !== false || source.locator) {
        validateLocator({ source, evidence: params.evidence });
      }
      const item = itemByLibraryAndKey(source.libraryID, source.itemKey);
      if (!item || item.isNote?.()) {
        throw new ToolInputRejection(
          `Citation ${cluster.citationId} does not resolve to a citable Zotero item`,
        );
      }
      return {
        itemId: Number(item.id),
        pageIndex: source.locator?.pageIndex,
      };
    });
    return { citationId: cluster.citationId, items };
  });

  const tokenIds: string[] = [];
  for (const match of draftMarkdown.matchAll(CITATION_TOKEN)) {
    tokenIds.push(match[1]);
  }
  if (!tokenIds.length && clusters.length) {
    throw new ToolInputRejection(
      "Citation mappings were supplied but the document has no citation tokens",
    );
  }
  for (const citationId of tokenIds) {
    if (!clustersById.has(citationId)) {
      throw new ToolInputRejection(
        `Document contains unresolved citation token ${citationId}`,
      );
    }
  }
  for (const citationId of clustersById.keys()) {
    if (!tokenIds.includes(citationId)) {
      throw new ToolInputRejection(
        `Citation ${citationId} is not used in the document`,
      );
    }
  }
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
    };
  }

  // App readiness does not await the style registry. Native init() joins its
  // existing initialization promise, including any bundled style update.
  await Zotero.Styles?.init?.();
  const formatted = params.gateway.formatStructuredCitations({
    clusters: resolved,
    styleId: params.spec.citationStyle.styleId,
    locale: params.spec.citationStyle.locale,
  });
  const sourceByItemId = new Map<number, PlanCitationSource>();
  for (const cluster of clusters) {
    for (const source of cluster.sources) {
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
  });
  const renderCluster = (
    cluster: FormattedCitationBundle["clusters"][number],
    label = cluster.text,
  ) => {
    if (cluster.sources.length !== 1) {
      const linked = groupLinks.get(cluster.citationId);
      if (linked) return label === cluster.text ? linked : linked.slice(1, -1);
      return `${label} ${numberedCitationSources(cluster)}`;
    }
    return `[${escapeMarkdownLabel(label)}](${buildPlanCitationSourceUri(cluster.sources[0])})`;
  };
  // Tokens inside a parenthetical reference can stand in for the year in
  // model-authored text, e.g. (Alpha [[cite:a]]; Beta [[cite:b]]). Bind the
  // whole reference only when every literal label exactly matches its CSL
  // author or full label. Unrelated parenthetical prose is left untouched.
  const boundParentheses = draftMarkdown.replace(
    /\(([^()\r\n]*\[\[cite:[A-Za-z0-9._:-]+\]\][^()\r\n]*)\)/g,
    (original, body: string) => {
      const rendered: string[] = [];
      for (const part of body.split(/;\s*/)) {
        const slot = part
          .trim()
          .match(/^(.*?)\s*\[\[cite:([A-Za-z0-9._:-]+)\]\]$/);
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
    /(\([^()\r\n]*\)[\t ]*)?(\[\[cite:[A-Za-z0-9._:-]+\]\](?:[\t ]*\[\[cite:[A-Za-z0-9._:-]+\]\])*)/g,
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
  const bibliographyEntries = formatted.bibliographyEntries.map((entry) => {
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
  });
  if (params.spec.requiresReferences) {
    const references = bibliographyEntries
      .map(
        (entry) =>
          `- [${escapeMarkdownLabel(entry.text)}](${buildZoteroItemUri(entry.libraryID, entry.itemKey)})`,
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
    },
  };
}

/** Compatibility alias for the original Plan-only API. */
export const formatPlanDocumentCitations = formatDocumentCitations;
