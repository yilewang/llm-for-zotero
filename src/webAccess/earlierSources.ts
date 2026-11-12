/**
 * Outside sources that earlier questions of a chat found: the scholarly
 * papers and web pages their tools returned, kept as tool result handles. A
 * follow-up that answers from them, without searching again, still marks
 * them, and the answer's markers point to them.
 */
import { buildSourceCatalog, type SourceCatalog } from "./attribution";

export const EARLIER_SOURCE_TOOL_NAMES = [
  "web_search",
  "web_read",
  "literature_search",
  "literature_read",
] as const;

/** How many earlier papers, and how many earlier web pages, the model sees. */
const EARLIER_SOURCES_SHOWN = 10;

export type EarlierSourceHandle = {
  toolName: string;
  content: unknown;
  createdAt?: number;
};

export function earlierSourceCatalog(
  handles: readonly EarlierSourceHandle[],
): SourceCatalog {
  return buildSourceCatalog(
    [...handles]
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
      .map((handle) => ({
        name: handle.toolName,
        ok: true,
        content: handle.content,
      })),
  );
}

/**
 * The follow-up's note on what earlier questions found, newest last, or
 * nothing when they found no outside sources.
 */
export function buildEarlierSourcesBlock(
  catalog: SourceCatalog,
): string | undefined {
  const all = [...catalog.sources.values()];
  const papers = all
    .filter((source) => source.kind === "paper")
    .slice(-EARLIER_SOURCES_SHOWN);
  const pages = all
    .filter((source) => source.kind !== "paper")
    .slice(-EARLIER_SOURCES_SHOWN);
  if (!papers.length && !pages.length) return undefined;
  const line = (source: (typeof all)[number]) =>
    `- ${source.sourceId}: ${source.title} (${source.organization || source.hostname}) ${source.url}`;
  return [
    "Outside sources earlier questions in this chat found:",
    ...papers.map(line),
    ...pages.map(line),
    'When this answer uses one of them, mark it as you mark this turn\'s sources: append <!--llm-web-source:SOURCE_ID--> at the end of the paragraph that uses it, with the exact words you used from it when you have them word for word (<!--llm-web-source:SOURCE_ID="exact words"-->). You need not search or read again for what they already answer.',
  ].join("\n");
}
