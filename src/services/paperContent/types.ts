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
  /**
   * The section structure of a chaptered plain PDF (bookmarks, else numbered
   * headings that open pages). Absent for papers and every other source.
   */
  documentStructure?: PdfDocumentStructure;
  /**
   * An unchaptered plain PDF's pages, in order (entry `i` is PDF page
   * `i + 1`), each with its size and first text line, when the text splits
   * into exactly the PDF's pages. Only a chat's load computes it, and
   * chunkMeta stays as it was, so retrieval and the library index read the
   * paper as before.
   */
  textPages?: Array<{ tokens: number; firstLine: string }>;
  /**
   * An unchaptered plain PDF's sections by its bookmarks alone
   * (`bookmarkSectionTree`), when it has usable ones: the map a chat shows
   * when the whole text does not fit, and what its section ids read. Only a
   * chat's load computes it; chunkMeta stays as it was.
   */
  bookmarkSections?: Pick<PdfDocumentStructure, "pageCount" | "sections">;
  sourceType?:
    | "mineru"
    | "zotero-worker"
    | "zotero-fulltext-cache"
    | "attachment-markdown"
    | "attachment-html"
    | "attachment-txt"
    | "attachment-docx";
};

/** One section of a chaptered plain PDF's text, in document order. */
export type DocumentStructureSection = {
  title: string;
  /** 1 for a top-level section. */
  level: number;
  /** Index of the enclosing section in the same list. */
  parentIndex?: number;
  /** Text offsets: own text `[charStart, ownCharEnd)`, with subsections to `charEnd`. */
  charStart: number;
  ownCharEnd: number;
  charEnd: number;
  /** 0-based PDF page indexes of the section with its subsections. */
  pageStart: number;
  pageEnd: number;
  /** Size of the section with its subsections, and of its own text. */
  chars: number;
  ownChars: number;
  tokens: number;
};

/** A chaptered plain PDF's structure, as its chunks carry it. */
export type PdfDocumentStructure = {
  source: "bookmarks" | "headings";
  /** The PDF's page count. */
  pageCount: number;
  /** Sections with their heading chain and the chunks they overlap. */
  sections: Array<
    DocumentStructureSection & {
      /** Heading chain down to the section, e.g. `Chapter 2 › 2.1 Origins`. */
      path: string;
      /** First and last chunk the section (with subsections) overlaps. */
      chunkStart: number;
      chunkEnd: number;
    }
  >;
  /**
   * The chunk metadata as it was before the structure was applied: what the
   * library text index stores, so index rows do not depend on who loaded
   * the text first.
   */
  plainChunkMeta: PdfChunkMeta[];
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
  /**
   * The standard section the chunk lies in, as its heading reads
   * (`Materials and methods` for a chunk under its `Data analysis`
   * subsection). Absent in front matter, back matter, and text that follows
   * an introduction without a Results heading.
   */
  enclosingSection?: string;
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
  /** The standard section the chunk lies in; see `PdfChunkMeta`. */
  enclosingSection?: string;
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
  /** First and last chunk index of the section with its subsections, inclusive. */
  chunkIndexes: [number, number];
  /** Characters of the section with its subsections. */
  chars: number;
  /** Characters of the section's own text, before its first subsection. */
  ownChars: number;
  /** Estimated tokens of the section with its subsections. */
  tokens: number;
  /** Pages from 1, as paper_read's `pages` input counts them, when known. */
  pageStart?: number;
  pageEnd?: number;
  /** The enclosing section, when there is one. */
  parentId?: string;
  /** The sections directly under this one, in document order. */
  childIds: string[];
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
  /**
   * The document has chapters (`PdfContext.documentStructure`): its map is
   * read instead of its whole text.
   */
  chaptered?: true;
  /** The PDF's page count, when the map knows it. */
  pageCount?: number;
  /** Parse health, when the MinerU manifest records it. */
  structure?: DocumentStructureHealth;
};

export type ChunkStat = {
  index: number;
  length: number;
  tf: Record<string, number>;
  uniqueTerms: string[];
};
