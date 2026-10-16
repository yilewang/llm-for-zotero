import { assert } from "chai";
import { buildZoteroMcpScopeForRequest } from "../src/agent/externalBackendBridge";
import {
  registerScopedZoteroMcpScope,
  resolveConversationScopeToken,
} from "../src/agent/mcp/server";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

describe("ACP Zotero MCP scope", function () {
  // The scope builder reads the user library id off the host. Suites share one
  // process, so put the stub back the way it was found.
  let previousZotero: unknown;
  before(function () {
    previousZotero = (globalThis as { Zotero?: unknown }).Zotero;
    (globalThis as { Zotero?: unknown }).Zotero = {
      Libraries: { userLibraryID: 1 },
    };
  });
  after(function () {
    if (previousZotero === undefined)
      delete (globalThis as { Zotero?: unknown }).Zotero;
    else (globalThis as { Zotero?: unknown }).Zotero = previousZotero;
  });

  it("keeps the ACP authority and the turn's paper scope through registration", function () {
    const request = resolvedAgentRequest({
      conversationKey: 91_000_001,
      conversationKind: "paper",
      userText: "summarise the methods",
      libraryID: 7,
      turnPaperScope: {
        libraryID: 7,
        conversationKind: "paper",
        papers: [
          {
            roles: ["active", "selected"],
            paper: {
              libraryID: 7,
              itemId: 55,
              contextItemId: 66,
              title: "Scoped Paper",
              mineruCacheDir: "/cache/paper-55",
            },
          },
        ],
      },
    });

    const registered = registerScopedZoteroMcpScope(
      buildZoteroMcpScopeForRequest(request, "", "acp"),
      { token: resolveConversationScopeToken({ conversationKey: 91_000_001 }) },
    );

    const scope = registered.getState();
    assert.isNotNull(scope);
    // The authority is what tells the MCP server this call belongs to an
    // external runtime rather than to its own agent. Losing it is silent and
    // makes the call standalone, which drops the turn's paper scope and the
    // MinerU cache directory from the read grants.
    assert.equal(scope?.runtimeAuthority, "acp");
    assert.isFalse(!scope?.runtimeAuthority);

    // Without the paper, the MCP tools that serve MinerU markdown have no
    // turn to resolve content against.
    assert.equal(scope?.turnPaperScope.papers[0]?.paper.itemId, 55);
    assert.equal(
      scope?.turnPaperScope.papers[0]?.paper.mineruCacheDir,
      "/cache/paper-55",
    );

    registered.clear();
  });

  it("still names the same conversation token on the next turn", function () {
    // The ACP session outlives the turn, so the token has to be stable across
    // turns or the session's MCP server config would point at a dead scope.
    const first = resolveConversationScopeToken({
      conversationKey: 91_000_002,
    });
    const second = resolveConversationScopeToken({
      conversationKey: 91_000_002,
    });
    assert.equal(first, second);
    assert.notEqual(
      first,
      resolveConversationScopeToken({ conversationKey: 91_000_003 }),
    );
  });
});
