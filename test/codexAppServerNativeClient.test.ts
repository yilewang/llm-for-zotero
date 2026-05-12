import { assert } from "chai";
import {
  buildZoteroEnvironmentManifest,
  resolveCodexNativeApprovalRequest,
  resolveSafeCodexNativeApprovalRequest,
} from "../src/codexAppServer/nativeClient";
import {
  buildCodexNativePriorReadContextBlock,
  clearCodexNativeReadLedger,
  recordCodexNativeReadActivity,
} from "../src/codexAppServer/nativeContextLedger";

describe("Codex app-server native client", function () {
  afterEach(function () {
    clearCodexNativeReadLedger();
  });

  it("auto-approves trusted Zotero MCP approval prompts except self-confirmation", function () {
    const legacyReadDecision = resolveSafeCodexNativeApprovalRequest({
      method: "tool/requestUserInput",
      params: {
        serverName: "llm_for_zotero_profile_1234",
        toolName: "query_library",
        questions: [{ header: "Allow", question: "Use query_library?" }],
      },
    });
    assert.equal(legacyReadDecision?.approved, true);
    assert.deepEqual(legacyReadDecision?.response, { approved: true });

    const legacyWriteDecision = resolveSafeCodexNativeApprovalRequest({
      method: "tool/requestUserInput",
      params: {
        serverName: "llm_for_zotero_profile_1234",
        toolName: "edit_current_note",
        questions: [{ header: "Allow", question: "Use edit_current_note?" }],
      },
    });
    assert.equal(legacyWriteDecision?.approved, true);
    assert.deepEqual(legacyWriteDecision?.response, { approved: true });

    const currentWriteDecision = resolveCodexNativeApprovalRequest({
      method: "item/tool/requestUserInput",
      params: {
        serverName: "llm_for_zotero_profile_1234",
        toolName: "edit_current_note",
        questions: [
          {
            id: "allow",
            header: "Allow",
            question: "Allow llm_for_zotero to use edit_current_note?",
            options: [
              { label: "Allow", description: "Allow trusted access." },
              { label: "Deny", description: "Deny access." },
            ],
          },
        ],
      },
    });
    assert.equal(currentWriteDecision.approved, true);
    assert.deepEqual(currentWriteDecision.response, {
      answers: { allow: { answers: ["Allow"] } },
    });

    const suffixedApprovalDecision = resolveCodexNativeApprovalRequest({
      method: "item/tool/requestUserInput",
      params: {
        serverName: "llm_for_zotero_profile_1234",
        toolName: "edit_current_note",
        questions: [
          {
            id: "mcp_access",
            header: "Allow",
            question: "Allow llm_for_zotero to use edit_current_note?",
            options: [
              { label: "Reject" },
              { label: "Allow once (Recommended)" },
            ],
          },
        ],
      },
    });
    assert.equal(suffixedApprovalDecision.approved, true);
    assert.deepEqual(suffixedApprovalDecision.response, {
      answers: { mcp_access: { answers: ["Allow once (Recommended)"] } },
    });

    const turnApprovalDecision = resolveSafeCodexNativeApprovalRequest({
      method: "turn/approval/request",
      params: {
        serverName: "llm_for_zotero_profile_1234",
        toolName: "edit_current_note",
        message: "Allow llm_for_zotero to use edit_current_note?",
      },
    });
    assert.equal(turnApprovalDecision?.approved, true);
    assert.deepEqual(turnApprovalDecision?.response, { approved: true });

    assert.isNull(
      resolveSafeCodexNativeApprovalRequest({
        method: "tool/requestUserInput",
        params: {
          serverName: "llm_for_zotero_profile_1234",
          toolName: "zotero_confirm_action",
        },
      }),
    );
    const disallowedSelfConfirm = resolveCodexNativeApprovalRequest({
      method: "tool/requestUserInput",
      params: {
        serverName: "llm_for_zotero_profile_1234",
        toolName: "zotero_confirm_action",
      },
    });
    assert.equal(disallowedSelfConfirm.approved, false);
    assert.deepEqual(disallowedSelfConfirm.response, {
      approved: false,
      error:
        "Zotero only auto-approves trusted llm_for_zotero MCP access. " +
        "Built-in Codex approvals are disabled.",
    });
    assert.isNull(
      resolveSafeCodexNativeApprovalRequest({
        method: "tool/requestUserInput",
        params: {
          serverName: "unrelated_mcp",
          toolName: "query_library",
        },
      }),
    );
  });

  it("returns schema-valid denials for current native approval request methods", function () {
    assert.deepEqual(
      resolveCodexNativeApprovalRequest({
        method: "item/commandExecution/requestApproval",
        params: { command: "date" },
      }).response,
      { decision: "decline" },
    );
    assert.deepEqual(
      resolveCodexNativeApprovalRequest({
        method: "item/fileChange/requestApproval",
        params: { path: "/tmp/example.txt" },
      }).response,
      { decision: "decline" },
    );
    assert.deepEqual(
      resolveCodexNativeApprovalRequest({
        method: "item/permissions/requestApproval",
        params: { permissions: ["filesystem.write"] },
      }).response,
      { permissions: {}, scope: "turn" },
    );
    assert.deepEqual(
      resolveCodexNativeApprovalRequest({
        method: "mcpServer/elicitation/request",
        params: { serverName: "other_server", message: "Need input" },
      }).response,
      { action: "decline", content: null, _meta: null },
    );
  });

  it("uses a light Codex-native Zotero resource contract", function () {
    const manifest = buildZoteroEnvironmentManifest({
      scope: {
        conversationKey: 1,
        libraryID: 1,
        kind: "paper",
        paperItemID: 42,
        activeItemId: 42,
        activeContextItemId: 43,
        paperTitle: "Native Paper",
      },
      mcpEnabled: true,
      mcpReady: true,
    });
    assert.include(manifest, "You are Codex");
    assert.include(manifest, "Zotero resources and MCP tools are available when useful");
    assert.include(manifest, "Use tools only when they materially improve the answer");
    assert.include(manifest, "Do not call tools solely to discover page numbers");
    assert.notInclude(manifest, "page N");
    assert.notInclude(manifest, "use shell creatively");
  });

  it("records successful native paper reads for context reuse hints", function () {
    const scope = {
      profileSignature: "profile-ledger-test",
      conversationKey: 6_000_000_010,
      libraryID: 1,
      kind: "paper" as const,
      paperItemID: 42,
      activeContextItemId: 99,
      paperTitle: "Ledger Paper",
    };
    const baseEvent = {
      requestId: "read-1",
      phase: "completed" as const,
      serverName: "llm_for_zotero",
      profileSignature: "profile-ledger-test",
      conversationKey: 6_000_000_010,
      timestamp: 1000,
    };

    recordCodexNativeReadActivity({
      threadId: "thread-ledger",
      scope,
      event: {
        ...baseEvent,
        toolName: "read_paper",
        toolLabel: "Read Paper",
        arguments: {},
        ok: true,
      },
    });
    recordCodexNativeReadActivity({
      threadId: "thread-ledger",
      scope,
      event: {
        ...baseEvent,
        requestId: "read-2",
        toolName: "read_paper",
        toolLabel: "Read Paper",
        arguments: {},
        ok: true,
        timestamp: 1100,
      },
    });
    recordCodexNativeReadActivity({
      threadId: "thread-ledger",
      scope,
      event: {
        ...baseEvent,
        requestId: "search-failed",
        toolName: "search_paper",
        toolLabel: "Search Paper",
        arguments: { question: "failed search" },
        ok: false,
        timestamp: 1200,
      },
    });
    recordCodexNativeReadActivity({
      threadId: "thread-ledger",
      scope,
      event: {
        ...baseEvent,
        requestId: "write-file",
        toolName: "file_io",
        toolLabel: "File I/O",
        arguments: {
          action: "write",
          filePath: "/tmp/llm-for-zotero-mineru/paper/full.md",
        },
        ok: true,
        timestamp: 1300,
      },
    });
    recordCodexNativeReadActivity({
      threadId: "thread-ledger",
      scope,
      event: {
        ...baseEvent,
        requestId: "read-mineru",
        toolName: "file_io",
        toolLabel: "File I/O",
        arguments: {
          action: "read",
          filePath: "/tmp/llm-for-zotero-mineru/paper/full.md",
          offset: 25,
          length: 500,
        },
        ok: true,
        timestamp: 1400,
      },
    });

    const block = buildCodexNativePriorReadContextBlock({
      profileSignature: "profile-ledger-test",
      conversationKey: 6_000_000_010,
      threadId: "thread-ledger",
    });
    assert.include(block, "Already inspected in this Codex thread");
    assert.include(block, "Ledger Paper");
    assert.include(block, "Read Paper");
    assert.include(block, "2x");
    assert.include(block, "Read MinerU full.md");
    assert.include(block, "offset=25");
    assert.notInclude(block, "failed search");
    assert.notInclude(block, "write-file");
  });
});
