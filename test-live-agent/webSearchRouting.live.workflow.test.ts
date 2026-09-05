import { assert } from "chai";
import { hasTavilyApiKey } from "../src/webAccess/prefs";
import {
  resolveLiveAgentCredentials,
  type LiveAgentCredentials,
} from "./liveAgentCredentials";

declare const Zotero: any;

describe("live multilingual external-search routing", function () {
  this.timeout(240000);

  let creds: LiveAgentCredentials | null = null;

  type ToolCall = {
    name: string;
    args: Record<string, unknown>;
  };

  function callNames(calls: ToolCall[]): string[] {
    return calls.map((call) => call.name);
  }

  function assertDepth(
    calls: ToolCall[],
    toolName: "web_search" | "web_read",
    expected: "basic" | "advanced",
  ): void {
    const matching = calls.filter((call) => call.name === toolName);
    assert.isNotEmpty(matching, calls.map((call) => call.name).join(" → "));
    assert.deepEqual(
      matching.map((call) => call.args.depth),
      matching.map(() => expected),
      JSON.stringify(matching),
    );
  }

  async function runTurn(userText: string) {
    const api = Zotero.LLMForZotero?.api?.agent;
    assert.isOk(api, "agent API must be installed");
    assert.isOk(creds, "model credentials must be resolved before a live turn");
    const toolCalls: ToolCall[] = [];
    const conversationKey = Math.floor(Math.random() * 1_000_000) + 1_200_000;

    const result = await api.runTurn(
      {
        conversationKey,
        mode: "agent",
        conversationKind: "global",
        userText,
        libraryID: Zotero.Libraries.userLibraryID,
        model: creds?.model,
        apiBase: creds?.apiBase,
        apiKey: creds?.apiKey,
        providerProtocol: creds?.providerProtocol,
        ...(creds?.reasoningLevel
          ? {
              reasoning: {
                provider: "deepseek",
                level: creds.reasoningLevel,
              },
            }
          : {}),
      },
      (event: any) => {
        if (event?.type === "tool_call" && event.name) {
          const rawArgs = event.arguments ?? event.args;
          toolCalls.push({
            name: String(event.name),
            args:
              rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
                ? rawArgs
                : {},
          });
        }
      },
    );

    assert.notEqual(
      result?.kind,
      "fallback",
      `agent fell back instead of running: ${result?.kind === "fallback" ? result.reason : ""}`,
    );
    return toolCalls;
  }

  before(async function () {
    creds = await resolveLiveAgentCredentials();
    if (!creds || !hasTavilyApiKey()) this.skip();
  });

  it("answers a stable conceptual question without external search", async function () {
    const calls = await runTurn(
      "Explain in two sentences how a median differs from a mean.",
    );
    const names = callNames(calls);

    assert.notInclude(names, "web_search", names.join(" → "));
    assert.notInclude(names, "web_read", names.join(" → "));
    assert.notInclude(names, "literature_search", names.join(" → "));
  });

  it("infers basic depth for a narrow English lookup and page read", async function () {
    const calls = await runTurn(
      "Find the latest stable Zotero version currently listed on the official Zotero website. Search the web, then read the returned official Zotero page before answering with the version and URL.",
    );

    assertDepth(calls, "web_search", "basic");
    assertDepth(calls, "web_read", "basic");
  });

  it("infers advanced depth for a broad English comparison", async function () {
    const calls = await runTurn(
      "Compare the current official search behavior, limits, and pricing across Tavily, Exa, and Perplexity. Search the web broadly, then read the strongest returned documentation pages and synthesize the differences across all three services.",
    );

    assertDepth(calls, "web_search", "advanced");
    assertDepth(calls, "web_read", "advanced");
  });

  it("infers basic depth for a narrow Chinese lookup and page read", async function () {
    const calls = await runTurn(
      "请查明 Zotero 官方网站目前列出的最新稳定版本号。先搜索网页，然后阅读搜索返回的 Zotero 官方页面，最后给出版本号和链接。",
    );

    assertDepth(calls, "web_search", "basic");
    assertDepth(calls, "web_read", "basic");
    const names = callNames(calls);
    assert.notInclude(names, "literature_search", names.join(" → "));
  });

  it("uses literature search for non-English scholarly discovery", async function () {
    const calls = await runTurn(
      "Busca en la literatura académica dos artículos recientes sobre la deriva representacional neuronal y cita las fuentes.",
    );
    const names = callNames(calls);

    assert.include(names, "literature_search", names.join(" → "));
    assert.notInclude(names, "web_search", names.join(" → "));
  });

  it("infers advanced depth for a broad Spanish comparison", async function () {
    const calls = await runTurn(
      "Compara el comportamiento de búsqueda, los límites y los precios actuales documentados oficialmente por Tavily, Exa y Perplexity. Busca ampliamente en la web, lee las mejores páginas de documentación devueltas y sintetiza las diferencias entre los tres servicios.",
    );

    assertDepth(calls, "web_search", "advanced");
    assertDepth(calls, "web_read", "advanced");
  });

  it("uses both sources for distinct scholarly and current-documentation needs", async function () {
    const calls = await runTurn(
      "查找两篇关于检索增强生成的最新学术论文，并查阅目前 Tavily 官方文档中 search depth 的说明，然后比较论文方法与产品文档中的检索设置。",
    );
    const names = callNames(calls);

    assert.include(names, "literature_search", names.join(" → "));
    assert.include(names, "web_search", names.join(" → "));
  });
});
