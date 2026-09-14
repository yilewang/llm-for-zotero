import type { ResearchQualityReport } from "../research/types";
import type { DocumentCoverageItem } from "./types";

/**
 * Honest calibration the host owns: what was read, how deeply, which
 * relationships were verified. Appended to the model's scope-and-limitations
 * section, or written as that section when the model omitted it, instead of
 * rejecting a good document over a heading.
 */

function count<T>(items: readonly T[], predicate: (item: T) => boolean) {
  return items.filter(predicate).length;
}

export function buildVerificationSummary(params: {
  coverageItems: readonly DocumentCoverageItem[];
  report?: ResearchQualityReport;
}): string {
  const items = params.coverageItems;
  const lines: string[] = [];
  if (items.length) {
    const body = count(items, (item) => item.evidenceDepth === "body");
    const abstract = count(items, (item) => item.evidenceDepth === "abstract");
    const metadata = count(items, (item) => item.evidenceDepth === "metadata");
    const none = count(items, (item) => item.evidenceDepth === "none");
    const depth = [
      body ? `${body} at full-text depth` : "",
      abstract ? `${abstract} at abstract depth` : "",
      metadata ? `${metadata} from metadata only` : "",
      none ? `${none} unread` : "",
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(
      `Coverage: ${items.length} papers in the approved scope (${depth}).`,
    );
  }
  const report = params.report;
  if (report) {
    lines.push(
      `Relationships: ${report.edges} recorded between papers, ${report.edgesVerified} verified against source text, ${report.edgesTentative} tentative, ${report.edgesRefuted} refuted; ${report.contradictions} contradictions surfaced.`,
    );
    lines.push(
      `Claims: ${report.claims} evidence-bound claims across ${report.nodes} papers, ${report.claimsWithLocators} with host-verified locators.`,
    );
  }
  return lines.join("\n");
}

const LIMITATION_HEADING = /\blimit(?:ation|ations|s)\b/i;
const SCOPE_HEADING = /\bscope\b/i;

function isReferencesHeading(entry: {
  match: RegExpExecArray | null;
}): boolean {
  return entry.match?.[2].trim().toLowerCase() === "references";
}

/**
 * Insert the summary under the limitations (or scope) heading, or add a
 * "Scope and limitations" section before References when neither exists.
 */
export function ensureCoverageSection(params: {
  markdown: string;
  summary: string;
}): string {
  if (!params.summary.trim()) return params.markdown;
  const block = `\n\n${params.summary.trim()}`;
  const lines = params.markdown.split(/\r?\n/);
  const headingLines = lines
    .map((line, index) => ({
      line,
      index,
      match: /^(#{1,6})\s+(.+?)\s*$/.exec(line),
    }))
    .filter((entry) => entry.match);
  // The section that discloses scope and limitations together is the home
  // for calibration; a limitations heading elsewhere (for example
  // "Agreements, contradictions, and limitations") comes second.
  const target =
    headingLines.find(
      (entry) =>
        SCOPE_HEADING.test(entry.match![2]) &&
        LIMITATION_HEADING.test(entry.match![2]),
    ) ||
    headingLines.find((entry) => LIMITATION_HEADING.test(entry.match![2])) ||
    headingLines.find((entry) => SCOPE_HEADING.test(entry.match![2]));
  if (target) {
    const depth = target.match![1].length;
    // The section ends at the next heading of the same or a higher level,
    // or at References whatever its level: a review often writes its
    // sections as H1 and the bibliography as H2.
    const nextIndex = headingLines.find(
      (entry) =>
        entry.index > target.index &&
        (entry.match![1].length <= depth || isReferencesHeading(entry)),
    )?.index;
    const end = nextIndex ?? lines.length;
    let insertAt = end;
    while (insertAt > target.index + 1 && !lines[insertAt - 1].trim())
      insertAt -= 1;
    const before = lines.slice(0, insertAt).join("\n");
    const after = lines.slice(insertAt).join("\n");
    return `${before}${block}${after ? `\n\n${after.replace(/^\n+/, "")}` : ""}`;
  }
  const referencesLine = headingLines.find(isReferencesHeading);
  const sectionLevels = headingLines
    .slice(1)
    .map((entry) => entry.match![1].length);
  const level = sectionLevels.length
    ? Math.max(2, Math.min(...sectionLevels))
    : 2;
  const section = `${"#".repeat(level)} Scope and limitations${block}`;
  if (referencesLine) {
    const before = lines
      .slice(0, referencesLine.index)
      .join("\n")
      .replace(/\n+$/, "");
    const after = lines.slice(referencesLine.index).join("\n");
    return `${before}\n\n${section}\n\n${after}`;
  }
  return `${params.markdown.replace(/\n+$/, "")}\n\n${section}\n`;
}
