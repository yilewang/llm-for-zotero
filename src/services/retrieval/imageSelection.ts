import { parseDocumentReferences } from "../../shared/documentReferences";
import { cosineSimilarity } from "./similarity";

/** Figure pages may sit this many pages before or after the citing text. */
export const IMAGE_PAGE_WINDOW = 2;
/** Upper bound on images returned by one read across all papers. */
export const MAX_IMAGES_PER_READ = 6;
/** Cosine similarities are floats; "at the threshold" must still pass. */
const SIMILARITY_EPSILON = 1e-9;

export type ImageSelectionReason =
  | "figure_label"
  | "page_window"
  | "outstanding";

export type ImageSelectionCandidate = {
  imageId: string;
  pageIndex: number;
  label?: string;
  vector: number[];
};

export type HitChunk = {
  text: string;
  /** 0-based, inclusive. */
  pageStart?: number;
  pageEnd?: number;
  /** Cosine similarity between the query and this chunk; 0 when unknown. */
  embeddingScore?: number;
};

export type SelectedImage<T> = {
  image: T;
  score: number;
  why: ImageSelectionReason;
};

function referenceKey(text: string): string | null {
  const reference = parseDocumentReferences(text)[0];
  return reference ? `${reference.kind}:${reference.id}` : null;
}

/** Lowest hit-chunk similarity, or null when the outstanding rule is off. */
function minimumTextSimilarity(hitChunks: HitChunk[]): number | null {
  const scores = hitChunks
    .map((entry) => entry.embeddingScore)
    .filter((value): value is number => Number.isFinite(value));
  if (!scores.length || scores.every((value) => value === 0)) return null;
  const minimum = Math.min(...scores);
  return minimum > 0 ? minimum : null;
}

/**
 * Images the text evidence vouches for (figure label or nearby page) or that
 * clearly stand out (similarity ≥ outstandingPercent of the weakest hit
 * chunk), best first, at most `topK`.
 */
export function selectRetrievalImages<
  T extends ImageSelectionCandidate,
>(params: {
  images: T[];
  queryEmbedding: number[];
  hitChunks: HitChunk[];
  topK: number;
  outstandingPercent: number;
  pageWindow?: number;
  onDiagnostics?: (details: {
    minimumTextSimilarity: number | null;
    threshold: number | null;
    scores: Array<{ imageId: string; score: number }>;
  }) => void;
}): SelectedImage<T>[] {
  if (
    params.topK <= 0 ||
    !params.images.length ||
    !params.queryEmbedding.length
  ) {
    return [];
  }
  const window = params.pageWindow ?? IMAGE_PAGE_WINDOW;
  const mentioned = new Set<string>();
  for (const entry of params.hitChunks) {
    for (const reference of parseDocumentReferences(entry.text)) {
      mentioned.add(`${reference.kind}:${reference.id}`);
    }
  }
  const minimum = minimumTextSimilarity(params.hitChunks);
  const threshold =
    minimum !== null && params.outstandingPercent > 0
      ? (minimum * params.outstandingPercent) / 100
      : null;

  const scored = params.images.map((image) => ({
    image,
    score: cosineSimilarity(params.queryEmbedding, image.vector),
  }));
  params.onDiagnostics?.({
    minimumTextSimilarity: minimum,
    threshold,
    scores: scored.map((entry) => ({
      imageId: entry.image.imageId,
      score: entry.score,
    })),
  });

  const selected: SelectedImage<T>[] = [];
  for (const { image, score } of scored) {
    const labelKey = image.label ? referenceKey(image.label) : null;
    const nearHit = params.hitChunks.some(
      (entry) =>
        entry.pageStart !== undefined &&
        entry.pageEnd !== undefined &&
        entry.pageEnd >= image.pageIndex - window &&
        entry.pageStart <= image.pageIndex + window,
    );
    const why: ImageSelectionReason | null =
      labelKey && mentioned.has(labelKey)
        ? "figure_label"
        : nearHit
          ? "page_window"
          : threshold !== null && score >= threshold - SIMILARITY_EPSILON
            ? "outstanding"
            : null;
    if (why) selected.push({ image, score, why });
  }
  return selected.sort((a, b) => b.score - a.score).slice(0, params.topK);
}

/**
 * MinerU chunks only carry their section's first page. For page matching,
 * a chunk spans from its section's page to the next section's page (the last
 * section runs to the final page). Pages are 0-based.
 */
export function computeSectionPageSpans(
  chunkMeta: Array<{ sectionIndex?: number }>,
  sections: Array<{ page?: number }>,
  totalPages: number | undefined,
): Array<{ start: number; end: number } | undefined> {
  return chunkMeta.map((meta) => {
    const index = meta.sectionIndex;
    if (index === undefined) return undefined;
    const start = sections[index]?.page;
    if (start === undefined) return undefined;
    let end: number | undefined;
    for (let next = index + 1; next < sections.length; next += 1) {
      const page = sections[next]?.page;
      if (page !== undefined) {
        end = page;
        break;
      }
    }
    if (end === undefined) {
      end = totalPages !== undefined && totalPages > 0 ? totalPages - 1 : start;
    }
    return { start, end: Math.max(start, end) };
  });
}
