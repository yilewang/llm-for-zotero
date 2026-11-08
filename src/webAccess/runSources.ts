import { normalizePublicWebUrl } from "./tavilyClient";
import type { WebSourceRecord } from "./types";
import { clearWebPagesForRun } from "./webPageStore";

const sourcesByRun = new Map<string, Map<string, string>>();
// The highest web_<n> already used in the conversation, per run. Short
// sequential IDs are easy for a model to copy exactly; continuing after the
// transcript's highest number keeps an ID from an earlier turn from naming a
// different page in this run.
const highestNumberByRun = new Map<string, number>();

const SEQUENTIAL_SOURCE_ID_PATTERN = /\bweb_([1-9]\d{0,3})\b/g;

/** The highest web_<n> (n <= 9999) in the messages' content; 0 when none. */
export function highestWebSourceNumber(
  messages: readonly { content?: unknown }[],
): number {
  let highest = 0;
  for (const message of messages) {
    const content =
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content ?? "");
    for (const match of content.matchAll(SEQUENTIAL_SOURCE_ID_PATTERN)) {
      highest = Math.max(highest, Number(match[1]));
    }
  }
  return highest;
}

/** The next new URL in the run gets web_<highestUsed + 1>. */
export function seedWebSourceNumbering(
  runId: string,
  highestUsed: number,
): void {
  highestNumberByRun.set(runId, highestUsed);
}

function getRunSources(runId: string): Map<string, string> {
  let sources = sourcesByRun.get(runId);
  if (!sources) {
    sources = new Map<string, string>();
    sourcesByRun.set(runId, sources);
  }
  return sources;
}

export function registerWebSearchSources(
  runId: string,
  sources: readonly WebSourceRecord[],
): WebSourceRecord[] {
  const runSources = getRunSources(runId);
  return sources.map((source) => {
    const url = normalizePublicWebUrl(source.url);
    let sourceId = runSources.get(url);
    if (!sourceId) {
      const next = (highestNumberByRun.get(runId) || 0) + 1;
      highestNumberByRun.set(runId, next);
      sourceId = `web_${next}`;
      runSources.set(url, sourceId);
    }
    return { ...source, sourceId, url };
  });
}

export function assertWebReadUrlsFromSearch(
  runId: string,
  urls: readonly string[],
): void {
  const runSources = sourcesByRun.get(runId);
  const unknown = urls.filter(
    (url) => !runSources?.has(normalizePublicWebUrl(url)),
  );
  if (unknown.length) {
    throw new Error(
      "web_read accepts only public URLs returned by web_search in this agent run.",
    );
  }
}

export function applyRunSourceIds(
  runId: string,
  sources: readonly WebSourceRecord[],
): WebSourceRecord[] {
  const runSources = sourcesByRun.get(runId);
  return sources.flatMap((source) => {
    const url = normalizePublicWebUrl(source.url);
    const sourceId = runSources?.get(url);
    return sourceId ? [{ ...source, sourceId, url }] : [];
  });
}

export function clearWebSourcesForRun(runId: string): void {
  sourcesByRun.delete(runId);
  highestNumberByRun.delete(runId);
  clearWebPagesForRun(runId);
}
