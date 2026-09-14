import {
  tokenizeRetrievalQuery,
  tokenizeRetrievalText,
} from "../../modules/contextPanel/retrievalTokenizer";

/**
 * Host relevance of every corpus paper to the approved question, from the
 * metadata the host already holds (title, abstract, tags). One BM25 document
 * per paper; scores are normalized to [0, 1] so tiers can compare them.
 * This ranks candidates for tiering; it never decides what the model reads.
 */

export type RelevanceInput = Readonly<{
  identity: string;
  title: string;
  abstract?: string;
  tags?: readonly string[];
}>;

export function rankCorpusRelevance(params: {
  papers: readonly RelevanceInput[];
  question: string;
  subquestions: readonly string[];
}): Map<string, number> {
  const documents = params.papers.map((paper) => {
    const tokens = tokenizeRetrievalText(
      [paper.title, paper.abstract || "", ...(paper.tags || [])].join("\n"),
      { fallbackToUnfilteredIfEmpty: true },
    );
    const tf = new Map<string, number>();
    for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1);
    return { identity: paper.identity, tf, length: tokens.length };
  });
  const docFreq = new Map<string, number>();
  for (const document of documents) {
    for (const term of document.tf.keys()) {
      docFreq.set(term, (docFreq.get(term) || 0) + 1);
    }
  }
  const total = documents.length;
  const avgLength =
    total > 0
      ? documents.reduce((sum, document) => sum + document.length, 0) / total
      : 0;
  const terms = new Set([
    ...tokenizeRetrievalQuery(params.question),
    ...params.subquestions.flatMap((subquestion) =>
      tokenizeRetrievalQuery(subquestion),
    ),
  ]);
  const k1 = 1.2;
  const b = 0.75;
  const raw = new Map<string, number>();
  for (const document of documents) {
    let score = 0;
    for (const term of terms) {
      const tf = document.tf.get(term) || 0;
      if (!tf || !document.length) continue;
      const df = docFreq.get(term) || 0;
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
      const norm =
        (tf * (k1 + 1)) /
        (tf + k1 * (1 - b + (b * document.length) / (avgLength || 1)));
      score += idf * norm;
    }
    raw.set(document.identity, score);
  }
  const maximum = Math.max(0, ...raw.values());
  return new Map(
    [...raw.entries()].map(([identity, score]) => [
      identity,
      maximum > 0 ? Number((score / maximum).toFixed(4)) : 0,
    ]),
  );
}
