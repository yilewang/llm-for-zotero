import "./hostSurfaceBootstrap";
import { assert } from "chai";
import { LiteratureSearchService } from "../src/agent/services/literatureSearchService";
import { getOpenAlexApiKey, setOpenAlexApiKey } from "../src/webAccess/prefs";
import type { AgentToolContext } from "../src/agent/types";

/**
 * Optional OpenAlex API key: the literature search service sends it only as
 * an Authorization header, never in the URL, and sends no mailto parameter.
 */
describe("workflow: OpenAlex API key", function () {
  this.timeout(30000);
  const KEY = "workflow-openalex-key-0123";
  type Seen = { url: string; headers: Record<string, string> };

  async function runSearch(): Promise<Seen[]> {
    const seen: Seen[] = [];
    globalThis.fetch = (async (
      url: string,
      init?: { headers?: Record<string, string> },
    ) => {
      seen.push({ url: String(url), headers: { ...(init?.headers || {}) } });
      return { ok: true, status: 200, json: async () => ({ results: [] }) };
    }) as unknown as typeof fetch;
    const gateway = {
      resolveMetadataItem: () => null,
      getEditableArticleMetadata: () => null,
      getCollectionSummary: () => null,
    };
    const service = new LiteratureSearchService(gateway as never);
    await service.execute(
      { mode: "search", query: "openalex key fixture", source: "openalex" },
      {} as AgentToolContext,
    );
    return seen;
  }

  it("sends the key as a Bearer header only, and nothing when no key is set", async function () {
    const originalFetch = globalThis.fetch;
    const originalKey = getOpenAlexApiKey();
    try {
      setOpenAlexApiKey(KEY);
      const withKey = await runSearch();
      const openAlex = withKey.filter((entry) =>
        entry.url.startsWith("https://api.openalex.org/"),
      );
      assert.isAbove(openAlex.length, 0, "an OpenAlex request was made");
      for (const entry of openAlex) {
        assert.equal(entry.headers.Authorization, `Bearer ${KEY}`);
        assert.notInclude(entry.url, KEY);
        assert.notInclude(entry.url, "api_key");
        assert.notInclude(entry.url, "mailto");
      }

      setOpenAlexApiKey("");
      const withoutKey = (await runSearch()).filter((entry) =>
        entry.url.startsWith("https://api.openalex.org/"),
      );
      assert.isAbove(withoutKey.length, 0, "an OpenAlex request was made");
      for (const entry of withoutKey) {
        assert.notProperty(entry.headers, "Authorization");
        assert.notInclude(entry.url, "mailto");
      }
    } finally {
      globalThis.fetch = originalFetch;
      setOpenAlexApiKey(originalKey);
    }
  });
});
