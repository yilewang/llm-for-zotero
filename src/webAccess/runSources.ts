import { buildWebSourceId, normalizePublicWebUrl } from "./tavilyClient";
import type { WebSourceRecord } from "./types";

const sourcesByRun = new Map<string, Map<string, string>>();

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
      let salt = 0;
      do {
        sourceId = buildWebSourceId(
          salt ? `${runId}:${url}:${salt}` : `${runId}:${url}`,
        );
        salt += 1;
      } while (Array.from(runSources.values()).includes(sourceId));
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
}
