import { assert } from "chai";
import {
  describeCodexZoteroMcpFailure,
  formatCodexZoteroMcpError,
} from "../src/codexAppServer/mcpErrors";
import { initI18n } from "../src/utils/i18n";

describe("Codex Zotero MCP errors", function () {
  const originalZotero = (globalThis as { Zotero?: unknown }).Zotero;
  const debugMessages: string[] = [];

  beforeEach(function () {
    debugMessages.length = 0;
    (globalThis as { Zotero?: unknown }).Zotero = {
      locale: "en-US",
      Prefs: { get: () => "en-US" },
      debug: (message: string) => debugMessages.push(message),
    };
    initI18n();
  });

  after(function () {
    (globalThis as { Zotero?: unknown }).Zotero = originalZotero;
    initI18n();
  });

  it("classifies a loopback MCP HTTP 502 as proxy interception", function () {
    const failure = describeCodexZoteroMcpFailure(
      new Error(
        "MCP server llm_for_zotero failed for http://127.0.0.1:24680/llm-for-zotero/mcp: HTTP 502 Bad Gateway",
      ),
    );

    assert.equal(failure?.kind, "proxy_intercepted");
    assert.include(failure?.userMessage || "", "proxy or VPN likely");
    assert.include(failure?.userMessage || "", "External OpenAI traffic");
  });

  it("classifies loopback transport and authorization failures separately", function () {
    assert.equal(
      describeCodexZoteroMcpFailure(
        new Error(
          "MCP server llm_for_zotero failed to connect to http://[::1]:24680/llm-for-zotero/mcp: ECONNREFUSED",
        ),
      )?.kind,
      "endpoint_unreachable",
    );
    assert.equal(
      describeCodexZoteroMcpFailure(
        new Error(
          "MCP server llm_for_zotero at http://localhost:24680/llm-for-zotero/mcp returned HTTP 401 Unauthorized",
        ),
      )?.kind,
      "authorization_failed",
    );
  });

  it("keeps unknown Zotero MCP failures neutral and ignores unrelated provider errors", function () {
    const unknown = describeCodexZoteroMcpFailure(
      new Error(
        "Zotero MCP handshake failed with an unexpected protocol reply",
      ),
    );
    assert.equal(unknown?.kind, "unknown");
    assert.equal(
      unknown?.userMessage,
      "Zotero MCP connection failed: Zotero MCP handshake failed with an unexpected protocol reply",
    );
    assert.isNull(
      describeCodexZoteroMcpFailure(
        new Error("OpenAI provider request failed: HTTP 502 Bad Gateway"),
      ),
    );
    assert.isNull(
      describeCodexZoteroMcpFailure(
        new Error(
          "A different provider at http://localhost:11434 returned HTTP 502 Bad Gateway",
        ),
      ),
    );
    assert.isNull(
      describeCodexZoteroMcpFailure(
        new Error(
          "[llm-for-zotero] OpenAI provider request failed: HTTP 502 Bad Gateway",
        ),
      ),
    );
  });

  it("logs redacted technical details while returning concise guidance", function () {
    const message = formatCodexZoteroMcpError(
      new Error(
        'llm_for_zotero at localhost returned HTTP 401 Unauthorized, "Authorization":"Bearer secret-token-value-123456789", "X-LLM-For-Zotero-Scope":"scope-token-value-123456789"',
      ),
      "connection test",
    );

    assert.include(message, "Install/update Zotero MCP config");
    assert.lengthOf(debugMessages, 1);
    assert.include(debugMessages[0], "authorization_failed");
    assert.include(debugMessages[0], "[redacted]");
    assert.notInclude(debugMessages[0], "secret-token-value-123456789");
    assert.notInclude(debugMessages[0], "scope-token-value-123456789");
  });

  it("provides Simplified Chinese guidance for each classified category", function () {
    (globalThis as { Zotero?: unknown }).Zotero = {
      locale: "zh-CN",
      Prefs: { get: () => "zh-CN" },
      debug: () => {},
    };
    initI18n();

    const proxy = describeCodexZoteroMcpFailure(
      new Error("llm_for_zotero localhost HTTP 502"),
    );
    const unreachable = describeCodexZoteroMcpFailure(
      new Error("llm_for_zotero localhost ECONNREFUSED"),
    );
    const unauthorized = describeCodexZoteroMcpFailure(
      new Error("llm_for_zotero localhost HTTP 401 Unauthorized"),
    );
    const unknown = describeCodexZoteroMcpFailure(
      new Error("llm_for_zotero localhost unexpected response"),
    );

    assert.include(proxy?.userMessage || "", "代理或 VPN");
    assert.include(unreachable?.userMessage || "", "请保持 Zotero 运行");
    assert.include(
      unauthorized?.userMessage || "",
      "安装/更新 Zotero MCP 配置",
    );
    assert.include(unknown?.userMessage || "", "Zotero MCP 连接失败");
  });
});
