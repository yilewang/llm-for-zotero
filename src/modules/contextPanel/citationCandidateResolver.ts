import {
  extractCitationAuthorKey,
  extractCitationYear,
} from "./citationLabelParser";

export type CitationCandidateConfidence = "high" | "medium" | "low" | "none";

export type CitationResolverExtractedLabel = {
  normalizedSourceLabel: string;
  normalizedCitationLabel: string;
  normalizedDisplayCitationLabel: string;
  normalizedCitationKey?: string;
};

export type CitationResolverCandidate<TCandidate> = {
  key: string;
  candidate: TCandidate;
  sourceLabels: string[];
  citationLabels: string[];
  citationKeys: string[];
  isStatic: boolean;
};

export type RankedCitationCandidate<TCandidate> = {
  candidate: TCandidate;
  key: string;
  score: number;
  confidence: CitationCandidateConfidence;
  reason: string;
};

export function rankCitationResolverCandidate<TCandidate>(
  extracted: CitationResolverExtractedLabel,
  candidate: CitationResolverCandidate<TCandidate>,
): RankedCitationCandidate<TCandidate> {
  const extractedKey = extracted.normalizedCitationKey || "";
  if (extractedKey && candidate.citationKeys.includes(extractedKey)) {
    return {
      candidate: candidate.candidate,
      key: candidate.key,
      score: 50,
      confidence: "high",
      reason: "citation-key",
    };
  }
  if (candidate.sourceLabels.includes(extracted.normalizedSourceLabel)) {
    return {
      candidate: candidate.candidate,
      key: candidate.key,
      score: 40,
      confidence: "high",
      reason: "exact-source-label",
    };
  }
  if (
    candidate.citationLabels.some(
      (label) =>
        label === extracted.normalizedCitationLabel ||
        label === extracted.normalizedDisplayCitationLabel,
    )
  ) {
    return {
      candidate: candidate.candidate,
      key: candidate.key,
      score: 40,
      confidence: "high",
      reason: "exact-citation-label",
    };
  }

  const extractedAuthor = extractCitationAuthorKey(
    extracted.normalizedCitationLabel,
  );
  const extractedYear = extractCitationYear(extracted.normalizedCitationLabel);
  const labelMatches = candidate.citationLabels.map((candidateLabel) => ({
    author: extractCitationAuthorKey(candidateLabel),
    year: extractCitationYear(candidateLabel),
  }));
  if (
    labelMatches.some(
      (label) =>
        extractedAuthor &&
        extractedYear &&
        label.author === extractedAuthor &&
        label.year === extractedYear,
    )
  ) {
    return {
      candidate: candidate.candidate,
      key: candidate.key,
      score: 30,
      confidence: "high",
      reason: "author-year",
    };
  }

  const authorMatch = labelMatches.some(
    (label) => extractedAuthor && label.author === extractedAuthor,
  );
  if (authorMatch) {
    return {
      candidate: candidate.candidate,
      key: candidate.key,
      score: 10,
      confidence: "low",
      reason: "author-only",
    };
  }

  const yearMatch = labelMatches.some(
    (label) => extractedYear && label.year === extractedYear,
  );
  if (yearMatch) {
    return {
      candidate: candidate.candidate,
      key: candidate.key,
      score: 5,
      confidence: "low",
      reason: "year-only",
    };
  }

  return {
    candidate: candidate.candidate,
    key: candidate.key,
    score: 0,
    confidence: "none",
    reason: "none",
  };
}

export function rankCitationResolverCandidateForNavigation<TCandidate>(
  extracted: CitationResolverExtractedLabel | null,
  candidate: CitationResolverCandidate<TCandidate>,
): RankedCitationCandidate<TCandidate> {
  if (!extracted) {
    return {
      candidate: candidate.candidate,
      key: candidate.key,
      score: 0,
      confidence: "none",
      reason: "no-citation",
    };
  }
  const ranked = rankCitationResolverCandidate(extracted, candidate);
  if (
    ranked.confidence === "low" &&
    ranked.reason === "author-only" &&
    candidate.isStatic
  ) {
    return {
      ...ranked,
      score: 20,
      confidence: "medium",
      reason: "static-author",
    };
  }
  return ranked;
}

export function buildAutoNavigableCitationCandidateKeys<TCandidate>(params: {
  extractedCitation: CitationResolverExtractedLabel | null;
  candidates: CitationResolverCandidate<TCandidate>[];
}): Set<string> {
  const ranked = params.candidates.map((candidate) =>
    rankCitationResolverCandidateForNavigation(
      params.extractedCitation,
      candidate,
    ),
  );
  const keyMatches = ranked.filter((entry) => entry.reason === "citation-key");
  if (keyMatches.length) {
    return new Set(keyMatches.map((entry) => entry.key));
  }
  const high = ranked.filter((entry) => entry.confidence === "high");
  const allowed = high.length
    ? high
    : ranked.filter((entry) => entry.confidence === "medium");
  if (!high.length && allowed.length !== 1) return new Set();
  return new Set(allowed.map((entry) => entry.key));
}
