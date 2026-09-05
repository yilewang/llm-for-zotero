export type EvidenceChunkKind =
  | "abstract"
  | "introduction"
  | "methods"
  | "results"
  | "discussion"
  | "conclusion"
  | "references"
  | "figure-caption"
  | "table-caption"
  | "appendix"
  | "body"
  | "unknown";

function normalizeText(value: unknown): string {
  return `${value ?? ""}`.replace(/\s+/g, " ").trim().toLowerCase();
}

export function normalizeEvidenceSectionLabel(value?: string): string {
  return normalizeText(value || "")
    .replace(/^#+\s*/, "")
    .replace(/[:.\s-]+$/g, "")
    .trim();
}

export function isFrontMatterSection(sectionLabel?: string): boolean {
  const section = normalizeEvidenceSectionLabel(sectionLabel);
  if (!section) return false;
  return /^(?:abstract|summary|highlights?|in brief|keywords?|title|authors?|article info(?:rmation)?)$/.test(
    section,
  );
}

export function isBodyEvidenceSection(
  sectionLabel?: string,
  chunkKind?: EvidenceChunkKind,
): boolean {
  if (chunkKind === "references") return false;
  if (chunkKind && chunkKind !== "abstract" && chunkKind !== "unknown") {
    return true;
  }
  const section = normalizeEvidenceSectionLabel(sectionLabel);
  if (!section) return chunkKind !== "abstract";
  return !isFrontMatterSection(section);
}

export type WantedEvidenceSection = "methods" | "results" | "limitations";

const SECTION_LABEL_PATTERNS: Record<WantedEvidenceSection, RegExp> = {
  methods:
    /\b(?:method|methods|methodology|approach|protocol|design|implementation|experiment|ablation)\b/,
  results:
    /\b(?:result|results|finding|findings|evaluation|experiment|analysis|discussion)\b/,
  limitations: /\b(?:limitation|discussion|future|caveat|threat)\b/,
};

export function scoreSectionPreference(
  query: string,
  sectionLabel?: string,
  wantedSections?: WantedEvidenceSection[],
): number {
  const normalizedQuery = normalizeText(query);
  const section = normalizeEvidenceSectionLabel(sectionLabel);
  if (!section) return 0;
  // Classifier-provided wanted sections are language-independent: they match
  // on the paper's section label alone, regardless of the query language.
  if (wantedSections?.length) {
    for (const wanted of wantedSections) {
      if (SECTION_LABEL_PATTERNS[wanted]?.test(section)) return 2;
    }
  }
  if (
    /\b(?:method|methods|methodology|approach|protocol|design|implementation|ablation|experiment(?:al)? setup)\b/.test(
      normalizedQuery,
    ) &&
    SECTION_LABEL_PATTERNS.methods.test(section)
  ) {
    return 2;
  }
  if (
    /\b(?:result|results|finding|findings|evidence|effect|outcome|performance)\b/.test(
      normalizedQuery,
    ) &&
    SECTION_LABEL_PATTERNS.results.test(section)
  ) {
    return 2;
  }
  if (
    /\b(?:limitations?|future work|caveat|threat)\b/.test(normalizedQuery) &&
    SECTION_LABEL_PATTERNS.limitations.test(section)
  ) {
    return 2;
  }
  return isFrontMatterSection(section) ? 0 : 0.25;
}

export function queryHasExplicitSectionPreference(
  query: string,
  wantedSections?: WantedEvidenceSection[],
): boolean {
  if (wantedSections?.length) return true;
  return (
    scoreSectionPreference(query, "Methods") >= 2 ||
    scoreSectionPreference(query, "Results") >= 2 ||
    scoreSectionPreference(query, "Limitations") >= 2
  );
}

export function chunkKindFromSectionLabel(
  sectionLabel?: string,
): EvidenceChunkKind {
  const section = normalizeEvidenceSectionLabel(sectionLabel);
  if (/^abstract$/.test(section)) return "abstract";
  if (/\bmethod|methods|methodology|approach|protocol|design\b/.test(section)) {
    return "methods";
  }
  if (/\bresult|finding|evaluation|experiment|analysis\b/.test(section)) {
    return "results";
  }
  if (/\bdiscussion\b/.test(section)) return "discussion";
  if (/\bconclusion\b/.test(section)) return "conclusion";
  if (/\breference|bibliography\b/.test(section)) return "references";
  return section ? "body" : "unknown";
}

export function compareEvidenceCandidatesForQuestion<
  T extends { sectionLabel?: string; chunkIndex?: number },
>(
  query: string,
  getBaseScore?: (candidate: T) => number,
  wantedSections?: WantedEvidenceSection[],
) {
  return (left: T, right: T): number => {
    const preferenceDelta =
      scoreSectionPreference(query, right.sectionLabel, wantedSections) -
      scoreSectionPreference(query, left.sectionLabel, wantedSections);
    if (preferenceDelta !== 0) return preferenceDelta;
    const scoreDelta =
      (getBaseScore?.(right) || 0) - (getBaseScore?.(left) || 0);
    if (scoreDelta !== 0) return scoreDelta;
    return (left.chunkIndex || 0) - (right.chunkIndex || 0);
  };
}
