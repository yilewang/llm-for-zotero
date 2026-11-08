import { assert } from "chai";
import { DeepSeekSearchClient } from "../../src/webAccess/deepseekSearchClient";
import { listOfficialDeepSeekGroups } from "../../src/webAccess/deepseekSearchKey";
import { stringPrefFromContents } from "./liveAgentCredentials";

/**
 * DeepSeek Search as the web search provider, against the real DeepSeek API
 * with the user's own official DeepSeek model profile. It costs a few
 * searches and page fetches ($0.75 per 1,000 successful calls).
 *
 * The profile comes from LLM_FOR_ZOTERO_LIVE_PROFILE_PATH (a prefs.js) or the
 * running Zotero's prefs. The suite seeds only that group, sets the provider
 * to DeepSeek and clears the Tavily key; every pref it touches is restored
 * afterwards. Without an official DeepSeek group the suite is skipped.
 */

declare const Zotero: any;

const PREF_PREFIX = "extensions.zotero.llmforzotero";
const SAVED_PREF_KEYS = [
  "modelProviderGroups",
  "modelProviderGroupsMigrationVersion",
  "outputTokenAutoMigrationNoticePending",
  "lastUsedModelEntryId",
  "webAccessProvider",
  "tavilyApiKey",
];

type ProviderGroup = {
  id: string;
  authMode: string;
  apiBase?: string;
  apiKey?: string;
  providerProtocol?: string;
  models?: Array<{ model?: string }>;
};

function environmentValue(key: string): string {
  try {
    return String(
      (
        globalThis as unknown as {
          Services?: { env?: { get?: (name: string) => string } };
        }
      ).Services?.env?.get?.(key) || "",
    ).trim();
  } catch {
    return "";
  }
}

function intPrefFromContents(contents: string, key: string): number | null {
  const escaped = key.replace(/\./g, "\\.");
  const match = contents.match(
    new RegExp(`user_pref\\("${escaped}",\\s*(\\d+)\\);`),
  );
  return match ? Number(match[1]) : null;
}

function firstOfficialGroup(serialized: string): ProviderGroup | null {
  try {
    const groups = JSON.parse(serialized) as ProviderGroup[];
    return Array.isArray(groups)
      ? listOfficialDeepSeekGroups(groups).find(
          (group) => group.models?.length,
        ) || null
      : null;
  } catch {
    return null;
  }
}

/** The official group and the migration version its JSON was saved under. */
async function readOfficialGroup(): Promise<{
  group: ProviderGroup;
  migrationVersion: number | null;
} | null> {
  const key = (name: string) => `${PREF_PREFIX}.${name}`;
  const profilePath = environmentValue("LLM_FOR_ZOTERO_LIVE_PROFILE_PATH");
  if (profilePath) {
    try {
      const contents = await Zotero.File.getContentsAsync(profilePath);
      if (typeof contents === "string") {
        const group = firstOfficialGroup(
          stringPrefFromContents(contents, key("modelProviderGroups")),
        );
        if (group) {
          return {
            group,
            migrationVersion: intPrefFromContents(
              contents,
              key("modelProviderGroupsMigrationVersion"),
            ),
          };
        }
      }
    } catch {
      // Fall through to the running Zotero's prefs.
    }
  }
  const group = firstOfficialGroup(
    String(Zotero.Prefs.get(key("modelProviderGroups"), true) || ""),
  );
  if (!group) return null;
  const version = Zotero.Prefs.get(
    key("modelProviderGroupsMigrationVersion"),
    true,
  );
  return {
    group,
    migrationVersion: typeof version === "number" ? version : null,
  };
}

describe("live DeepSeek web search", function () {
  this.timeout(300_000);

  let group: ProviderGroup | null = null;
  const previousPrefs = new Map<string, unknown>();

  before(async function () {
    const official = await readOfficialGroup();
    if (!official) this.skip();
    group = official!.group;
    for (const name of SAVED_PREF_KEYS) {
      previousPrefs.set(name, Zotero.Prefs.get(`${PREF_PREFIX}.${name}`, true));
    }
    Zotero.Prefs.set(
      `${PREF_PREFIX}.modelProviderGroups`,
      JSON.stringify([group]),
      true,
    );
    if (official!.migrationVersion !== null) {
      Zotero.Prefs.set(
        `${PREF_PREFIX}.modelProviderGroupsMigrationVersion`,
        official!.migrationVersion,
        true,
      );
    }
    Zotero.Prefs.set(`${PREF_PREFIX}.webAccessProvider`, "deepseek", true);
    Zotero.Prefs.set(`${PREF_PREFIX}.tavilyApiKey`, "", true);
  });

  after(function () {
    for (const [name, value] of previousPrefs) {
      if (value === undefined) {
        Zotero.Prefs.clear(`${PREF_PREFIX}.${name}`, true);
      } else {
        Zotero.Prefs.set(`${PREF_PREFIX}.${name}`, value, true);
      }
    }
  });

  it("searches and fetches with the profile key", async function () {
    const client = new DeepSeekSearchClient(String(group!.apiKey));
    const search = await client.search({
      query: "Zotero reference manager",
      maxResults: 5,
    });
    assert.equal(search.provider, "deepseek");
    assert.isNotEmpty(search.results, "DeepSeek returned search results");
    for (const result of search.results) {
      assert.match(result.url, /^https?:\/\//);
      assert.isNotEmpty(result.title);
    }
    // A site may refuse DeepSeek's fetcher; one readable page is enough.
    const read = await client.read({
      urls: search.results.slice(0, 3).map((result) => result.url),
    });
    assert.equal(read.provider, "deepseek");
    assert.isNotEmpty(
      read.pages,
      `no page was fetched: ${JSON.stringify(read.failedResults)}`,
    );
    assert.isNotEmpty(read.pages[0].content?.trim() || "");
  });

  it("answers an Agent turn through DeepSeek search when DeepSeek is chosen", async function () {
    const api = Zotero.LLMForZotero?.api?.agent;
    assert.isOk(api, "agent API must be installed");
    const requested = environmentValue("LLM_FOR_ZOTERO_LIVE_MODEL");
    const model =
      group!.models?.find((entry) => entry.model === requested)?.model ||
      String(group!.models?.[0]?.model || "");
    assert.isNotEmpty(model, "the DeepSeek profile has a model");
    const reasoningLevel = environmentValue("LLM_FOR_ZOTERO_LIVE_REASONING");
    const toolCalls: string[] = [];
    const searchProviders: string[] = [];
    const failedSearches: string[] = [];
    // A DeepSeek result closes with the turn's outside-search note.
    let resultsWithoutNextStep = 0;
    const searchedSourceIds = new Set<string>();
    let anchoredSourceIds: string[] = [];

    const result = await api.runTurn(
      {
        conversationKey: Math.floor(Math.random() * 1_000_000) + 1_300_000,
        mode: "agent",
        conversationKind: "global",
        userText:
          "Search the web for the latest stable Zotero version listed on the official Zotero website, then answer with the version number and the source URL.",
        libraryID: Zotero.Libraries.userLibraryID,
        model,
        apiBase: group!.apiBase,
        apiKey: group!.apiKey,
        providerProtocol: group!.providerProtocol,
        ...(reasoningLevel
          ? { reasoning: { provider: "deepseek", level: reasoningLevel } }
          : {}),
      },
      (event: any) => {
        if (event?.type === "tool_call" && event.name) {
          toolCalls.push(String(event.name));
        }
        if (event?.type === "tool_result" && event.name === "web_search") {
          searchProviders.push(String(event.content?.provider || ""));
          // A result without a provider is a failed call; keep it for the message.
          if (!event.content?.provider)
            failedSearches.push(JSON.stringify(event).slice(0, 1500));
          else if (typeof event.content?.nextStep !== "string")
            resultsWithoutNextStep++;
          for (const source of event.content?.results || []) {
            if (source?.sourceId) searchedSourceIds.add(source.sourceId);
          }
        }
        if (event?.type === "final" && Array.isArray(event.webSourceAnchors)) {
          anchoredSourceIds = event.webSourceAnchors.flatMap((anchor: any) =>
            (anchor?.sources || []).map((source: any) =>
              String(source?.sourceId || ""),
            ),
          );
        }
      },
    );

    const trail = toolCalls.join(" → ") || "(none)";
    assert.equal(result?.kind, "completed", `run outcome; tools: ${trail}`);
    assert.include(toolCalls, "web_search", trail);
    assert.isNotEmpty(searchProviders, "web_search returned a result");
    assert.deepEqual(
      Array.from(new Set(searchProviders)),
      ["deepseek"],
      `every web_search ran on DeepSeek; failed calls: ${failedSearches.join("\n")}`,
    );
    assert.equal(
      resultsWithoutNextStep,
      0,
      "every DeepSeek web_search result carries nextStep",
    );
    assert.isNotEmpty(
      anchoredSourceIds,
      `the answer carries web source markers: ${String(result?.text || "").slice(0, 600)}`,
    );
    assert.isTrue(
      anchoredSourceIds.some((sourceId) => searchedSourceIds.has(sourceId)),
      `an anchor cites a DeepSeek search result: ${anchoredSourceIds.join(", ")}`,
    );
  });
});
