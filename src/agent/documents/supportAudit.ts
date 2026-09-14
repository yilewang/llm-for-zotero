import type { PlanCitationCluster } from "./types";

/**
 * A valid citation is not a supported claim. This deterministic audit checks
 * that every paragraph of the synthesis that cites two or more papers rests
 * on recorded relationships: each cited paper must be connected by a valid
 * edge to another paper cited in the same paragraph.
 */

const CITATION_TOKEN = /\[\[cite:([A-Za-z0-9._:-]+)\]\]/g;
const EXEMPT_HEADING =
  /\b(introduction|background|scope|limitation|limitations|conclusion|conclusions|reference|references|method|methods|coverage|verification|summary|abstract)\b/i;

export type SupportAuditEdge = Readonly<{
  source: string;
  target: string;
  status: string;
  lifecycle?: string;
}>;

export type UnsupportedParagraph = Readonly<{
  heading: string;
  excerpt: string;
  papers: readonly string[];
  unlinked: readonly string[];
}>;

export type SupportAuditResult = Readonly<{
  crossPaperParagraphs: number;
  supported: number;
  unsupported: readonly UnsupportedParagraph[];
}>;

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function auditCrossPaperSupport(params: {
  markdown: string;
  clusters: readonly PlanCitationCluster[];
  edges: readonly SupportAuditEdge[];
}): SupportAuditResult {
  const papersByCitation = new Map(
    params.clusters.map((cluster) => [
      cluster.citationId,
      cluster.sources.map((source) => `${source.libraryID}:${source.itemKey}`),
    ]),
  );
  const connected = new Map<string, Set<string>>();
  for (const edge of params.edges) {
    if (edge.lifecycle === "invalidated") continue;
    if (edge.status === "refuted" || edge.status === "merged") continue;
    for (const [a, b] of [
      [edge.source, edge.target],
      [edge.target, edge.source],
    ]) {
      const set = connected.get(a) || new Set<string>();
      set.add(b);
      connected.set(a, set);
    }
  }
  let heading = "";
  let exempt = false;
  let crossPaperParagraphs = 0;
  let supported = 0;
  const unsupported: UnsupportedParagraph[] = [];
  for (const block of params.markdown.split(/\n\s*\n/)) {
    const lines = block
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) continue;
    const headingMatch = /^#{1,6}\s+(.+?)\s*$/.exec(lines[0]);
    if (headingMatch) {
      heading = headingMatch[1];
      exempt = EXEMPT_HEADING.test(heading);
      lines.shift();
      if (!lines.length) continue;
    }
    if (exempt) continue;
    if (lines.every((line) => /^(?:[-*+]|\d+[.)])\s/.test(line))) continue;
    const text = lines.join(" ");
    const papers = new Set<string>();
    for (const match of text.matchAll(CITATION_TOKEN)) {
      for (const paper of papersByCitation.get(match[1]) || [])
        papers.add(paper);
    }
    if (papers.size < 2) continue;
    crossPaperParagraphs += 1;
    const unlinked = [...papers].filter((paper) => {
      const neighbours = connected.get(paper);
      return (
        !neighbours ||
        ![...papers].some((other) => other !== paper && neighbours.has(other))
      );
    });
    if (!unlinked.length) {
      supported += 1;
      continue;
    }
    unsupported.push({
      heading,
      excerpt: normalize(text.replace(CITATION_TOKEN, "")).slice(0, 160),
      papers: [...papers],
      unlinked,
    });
  }
  return { crossPaperParagraphs, supported, unsupported };
}

export function describeUnsupportedParagraphs(
  unsupported: readonly UnsupportedParagraph[],
): string {
  return unsupported
    .map(
      (entry, index) =>
        `${index + 1}. Under "${entry.heading || "(no heading)"}": "${entry.excerpt}" cites ${entry.papers.join(", ")}; no recorded relationship links ${entry.unlinked.join(", ")} to another paper cited there.`,
    )
    .join("\n");
}
