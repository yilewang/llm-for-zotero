export type PdfContext = {
  title: string;
  chunks: string[];
  chunkMeta: PdfChunkMeta[];
  chunkStats: ChunkStat[];
  docFreq: Record<string, number>;
  avgChunkLength: number;
  fullLength: number;
  embeddings?: number[][];
  embeddingCacheKey?: string;
  embeddingPromise?: Promise<number[][] | null>;
  embeddingPromiseKey?: string;
  embeddingFailureKey?: string;
  /** Embedded-image index state; present only while image embedding is on. */
  imageIndex?: {
    extraction?: Promise<
      import("../retrieval/imageStore").EmbeddedImageRecord[] | null
    >;
    vectors?: number[][];
    vectorsKey?: string;
    failureKey?: string;
  };
  /** MinerU only: per-chunk page span derived from section pages. */
  chunkPageSpans?: Array<{ start: number; end: number } | undefined>;
  sourceType?:
    | "mineru"
    | "zotero-worker"
    | "zotero-fulltext-cache"
    | "attachment-markdown"
    | "attachment-html"
    | "attachment-txt"
    | "attachment-docx";
};

export type PdfChunkKind =
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

export type DocumentReferenceConfidence = "high" | "medium" | "low";

export type DocumentReferenceEvidence = {
  kind: "figure" | "table";
  id: string;
  panel?: string;
  confidence: DocumentReferenceConfidence;
  provenance: string[];
  pageStart?: number;
  pageEnd?: number;
};

export type PdfChunkMeta = {
  chunkIndex: number;
  text: string;
  normalizedText: string;
  sectionLabel?: string;
  /** Position of the enclosing section in the manifest's section list. */
  sectionIndex?: number;
  /** Heading chain down to the chunk, e.g. `2 Algorithm › 2.1 Weak form`. */
  sectionPath?: string;
  /** Markdown heading depth of the enclosing section: `#` → 1, `##` → 2. */
  sectionLevel?: number;
  chunkKind: PdfChunkKind;
  /**
   * Where {@link chunkKind} came from: `manifest` when the section heading
   * names a standard section, `heuristic` when the chunk text decided it.
   */
  kindSource?: "manifest" | "heuristic";
  anchorText?: string;
  leadingNoiseRemoved?: boolean;
  sourceType?: PdfContext["sourceType"];
  sourceStart?: number;
  sourceEnd?: number;
  sourceFingerprint?: string;
  pageStart?: number;
  pageEnd?: number;
  references?: DocumentReferenceEvidence[];
};

/** Structure rule that put a candidate in the final set. */
export type RetrievalStructureRule =
  | "heading_match"
  | "section_cap"
  | "neighbour"
  | "section_diverse_fallback";

/**
 * Why a chunk is in the retrieved set, in the terms the ranker used: its two
 * input ranks, the bounded section prior applied to them, and the structure
 * rule that reserved or back-filled its slot.
 */
export type RetrievalExplanation = {
  /** Retrieval signal only; neither lexical nor semantic ranking establishes claim support. */
  querySignal?: "lexical" | "semantic" | "none";
  /** 1-based BM25 rank over the whole document. */
  bm25Rank: number;
  /** 1-based embedding rank, absent when embeddings did not run. */
  embeddingRank?: number;
  /**
   * Rank shift applied to the fused rank: `-2` for a boosted section kind,
   * `0` for neutral kinds and for demoted chunks, whose place is described by
   * {@link demoted} instead of by a shift.
   */
  priorShift: number;
  /**
   * Set when the chunk sorts behind every other chunk of its document
   * (references, captions, appendix, short chunks, reference lists). It stays
   * a candidate: a reference-locked read can still pull it back.
   */
  demoted?: true;
  structureRule?: RetrievalStructureRule;
  kindSource?: "manifest" | "heuristic";
};

export type PaperContextCandidate = {
  paperKey: string;
  itemId: number;
  contextItemId: number;
  title: string;
  citationKey?: string;
  firstCreator?: string;
  year?: string;
  chunkIndex: number;
  chunkText: string;
  sectionLabel?: string;
  /** Position of the enclosing section in the document's section list. */
  sectionIndex?: number;
  /** Heading chain down to the chunk, e.g. `2 Algorithm › 2.1 Weak form`. */
  sectionPath?: string;
  chunkKind?: PdfChunkKind;
  anchorText?: string;
  leadingNoiseRemoved?: boolean;
  sourceStart?: number;
  sourceEnd?: number;
  sourceFingerprint?: string;
  pageStart?: number;
  pageEnd?: number;
  estimatedTokens: number;
  bm25Score: number;
  embeddingScore: number;
  hybridScore: number;
  evidenceScore: number;
  matchedQueryVariant?: string;
  matchedQueryVariants?: string[];
  referenceConfidence?: DocumentReferenceConfidence;
  /** Ranking explanation; set by `buildPaperRetrievalCandidates`. */
  why?: RetrievalExplanation;
};

/** One section of a document, as an outline read reports it. */
export type DocumentOutlineSection = {
  /** Stable handle for the section (`s0`, `s1`, …), usable as a read filter. */
  sectionId: string;
  /** Heading of the section, e.g. `2.2 Kinematic condition`. */
  title: string;
  /** Markdown heading depth: `#` → 1, `##` → 2. */
  level: number;
  /** Heading chain down to the section, e.g. `2 Algorithm › 2.1 Weak form`. */
  path: string;
  /** First and last chunk index of the section, inclusive. */
  chunkIndexes: [number, number];
  /** Total characters of the section's chunks. */
  chars: number;
};

/**
 * How much structure a parse yielded.
 *
 * Structurally identical to `MineruManifestStructure`, restated here because
 * this module sits below the MinerU cache and importing its types would close
 * an import cycle. `buildDocumentOutline` takes the manifest type, so the
 * compiler still checks the two agree wherever an outline is built.
 */
export type DocumentStructureHealth = {
  version: number;
  headingCounts: { h1: number; h2: number; h3: number };
  sectionsBuilt: number;
  labelledChars: number;
};

/**
 * The section list of one document: what an `outline` read returns, and the
 * compact address book a targeted read carries so the next call can name a
 * section instead of guessing query words.
 */
export type DocumentOutline = {
  sections: DocumentOutlineSection[];
  totalChunks: number;
  /** Parse health, when the MinerU manifest records it. */
  structure?: DocumentStructureHealth;
};

export type ChunkStat = {
  index: number;
  length: number;
  tf: Record<string, number>;
  uniqueTerms: string[];
};
