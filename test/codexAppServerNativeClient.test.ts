import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "chai";
import {
  buildCodexNativeApprovalPendingAction,
  buildCodexNativeApprovalResponseFromResolution,
  buildCodexNativeScopedMcpScopeForTests,
  buildCodexNativeVisibleTurnContextBlockForTests,
  buildZoteroEnvironmentManifest,
  compactCodexAppServerConversation,
  compactCodexAppServerThread,
  isDeniedTrustedZoteroMcpGuardianReviewForTests,
  listCodexAppServerModels,
  NO_CODEX_APP_SERVER_THREAD_TO_COMPACT_MESSAGE,
  resolveCodexNativeApprovalRequest,
  resolveSafeCodexNativeApprovalRequest,
  runCodexAppServerNativeTurn,
} from "../src/codexAppServer/nativeClient";
import {
  buildCodexNativePriorReadContextBlock,
  clearCodexNativeReadLedger,
  recordCodexNativeReadActivity,
} from "../src/codexAppServer/nativeContextLedger";
import {
  CodexAppServerProcess,
  destroyCachedCodexAppServerProcess,
} from "../src/utils/codexAppServerProcess";
import { getUserSkillsRuntimeRootDir } from "../src/agent/skills/userSkills";
import {
  BUILTIN_SKILL_FILES,
  parseSkill,
  setUserSkills,
} from "../src/agent/skills";
import { clearCodexNativeSkillClassifierCache } from "../src/codexAppServer/nativeSkills";

const here = dirname(fileURLToPath(import.meta.url));

describe("Codex app-server native client", function () {
  afterEach(function () {
    clearCodexNativeReadLedger();
    clearCodexNativeSkillClassifierCache();
    setUserSkills([]);
  });

  it("sends native thread compact requests and waits for completion", async function () {
    const processKey = "native-compact-thread-test";
    const originalSpawn = CodexAppServerProcess.spawn;
    const writes: string[] = [];
    const proc = CodexAppServerProcess.forTest({
      stdin: {
        write: (chunk: string) => {
          writes.push(chunk);
          const request = JSON.parse(chunk) as {
            id: number;
            method: string;
          };
          if (request.method === "thread/compact/start") {
            setTimeout(() => {
              (
                proc as unknown as {
                  handleMessage: (msg: Record<string, unknown>) => void;
                }
              ).handleMessage({ id: request.id, result: {} });
            }, 0);
            setTimeout(() => {
              (
                proc as unknown as {
                  handleMessage: (msg: Record<string, unknown>) => void;
                }
              ).handleMessage({
                method: "thread/compacted",
                params: { thread: { id: "thread-compact" } },
              });
            }, 0);
          }
        },
      },
      kill: () => {},
    });
    CodexAppServerProcess.spawn = async () => proc;

    try {
      await compactCodexAppServerThread({
        threadId: "thread-compact",
        processKey,
        timeoutMs: 100,
      });
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      destroyCachedCodexAppServerProcess(processKey, proc);
    }

    const compactRequest = writes
      .map((chunk) => JSON.parse(chunk) as { method: string; params: unknown })
      .find((entry) => entry.method === "thread/compact/start");
    assert.deepEqual(compactRequest?.params, { threadId: "thread-compact" });
  });

  it("fails conversation compaction clearly when no stored thread exists", async function () {
    let caught: unknown;
    try {
      await compactCodexAppServerConversation({
        conversationKey: 6_000_000_020,
        hooks: { loadProviderSessionId: async () => "" },
        processKey: "native-compact-missing-thread-test",
        timeoutMs: 10,
      });
    } catch (error) {
      caught = error;
    }

    assert.instanceOf(caught, Error);
    assert.equal(
      (caught as Error).message,
      NO_CODEX_APP_SERVER_THREAD_TO_COMPACT_MESSAGE,
    );
  });

  it("requests paged Codex app-server models", async function () {
    const processKey = "native-model-list-test";
    const originalSpawn = CodexAppServerProcess.spawn;
    const writes: string[] = [];
    const proc = CodexAppServerProcess.forTest({
      stdin: {
        write: (chunk: string) => {
          writes.push(chunk);
          const request = JSON.parse(chunk) as {
            id: number;
            method: string;
          };
          if (request.method === "model/list") {
            setTimeout(() => {
              (
                proc as unknown as {
                  handleMessage: (msg: Record<string, unknown>) => void;
                }
              ).handleMessage({
                id: request.id,
                result: { data: [], nextCursor: null },
              });
            }, 0);
          }
        },
      },
      kill: () => {},
    });
    CodexAppServerProcess.spawn = async () => proc;

    try {
      const result = await listCodexAppServerModels({
        processKey,
        codexPath: "codex",
        includeHidden: true,
        cursor: "cursor-1",
        limit: 50,
      });
      assert.deepEqual(result, { data: [], nextCursor: null });
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      destroyCachedCodexAppServerProcess(processKey, proc, {
        codexPath: "codex",
      });
    }

    const modelListRequest = writes
      .map((chunk) => JSON.parse(chunk) as { method: string; params: unknown })
      .find((entry) => entry.method === "model/list");
    assert.deepEqual(modelListRequest?.params, {
      includeHidden: true,
      cursor: "cursor-1",
      limit: 50,
    });
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

  it("rejects spoofed Zotero MCP approval payloads", function () {
    assert.isNull(
      resolveSafeCodexNativeApprovalRequest({
        method: "tool/requestUserInput",
        params: {
          serverName: "evil_mcp",
          toolName: "library_search",
          message: "Allow llm_for_zotero to use library_search?",
        },
      }),
    );
    assert.isNull(
      resolveSafeCodexNativeApprovalRequest({
        method: "tool/requestUserInput",
        params: {
          message:
            "This string mentions llm_for_zotero and library_search but has no structured server.",
        },
      }),
    );
    assert.isNull(
      resolveSafeCodexNativeApprovalRequest({
        method: "tool/requestUserInput",
        params: {
          serverName: "llm_for_zotero_profile_1234",
          toolName: "unknown_tool",
        },
      }),
    );
    assert.isNull(
      resolveSafeCodexNativeApprovalRequest({
        method: "item/tool/requestUserInput",
        params: {
          serverName: "llm_for_zotero_profile_1234",
          toolName: "library_search",
          questions: [
            {
              id: "allow",
              question: "Allow library_search?",
              options: [{ label: "Reject" }, { label: "Deny" }],
            },
          ],
        },
      }),
    );

    const scopedDecision = resolveSafeCodexNativeApprovalRequest({
      method: "tool/requestUserInput",
      params: {
        serverName: "llm_for_zotero_profile_1234",
        toolName: "library_search",
        scopeToken: "scope-token-123",
      },
    });
    assert.equal(scopedDecision?.approved, true);
    assert.equal(
      scopedDecision?.target,
      "llm_for_zotero_profile_1234/library_search",
    );
  });

  it("does not override guardian denials with spoofed Zotero MCP markers", function () {
    assert.isFalse(
      isDeniedTrustedZoteroMcpGuardianReviewForTests({
        review: { status: "denied" },
        action: {
          type: "mcp_tool_call",
          server: "evil_mcp",
          tool_name: "library_search",
          rationale: "mentions llm_for_zotero",
        },
      }),
    );
    assert.isTrue(
      isDeniedTrustedZoteroMcpGuardianReviewForTests({
        review: { status: "denied" },
        action: {
          type: "mcp_tool_call",
          server: "llm_for_zotero_profile_1234",
          tool_name: "library_search",
        },
      }),
    );
    assert.isFalse(
      isDeniedTrustedZoteroMcpGuardianReviewForTests({
        review: { status: "denied" },
        action: {
          type: "mcp_tool_call",
          server: "llm_for_zotero_profile_1234",
          tool_name: "run_command",
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

  it("builds native Codex approval cards and turn-scoped approval responses", function () {
    const commandRequest = {
      method: "item/commandExecution/requestApproval",
      params: {
        command: "npm test",
        cwd: "/repo/example",
      },
    };

    const commandAction = buildCodexNativeApprovalPendingAction(commandRequest);

    assert.equal(commandAction.toolName, "codex_native_approval");
    assert.equal(commandAction.mode, "approval");
    assert.equal(commandAction.confirmLabel, "Approve once");
    assert.equal(commandAction.cancelLabel, "Deny");
    assert.include(commandAction.title, "command");
    assert.include(JSON.stringify(commandAction.fields), "npm test");
    assert.include(JSON.stringify(commandAction.fields), "/repo/example");
    assert.deepEqual(
      buildCodexNativeApprovalResponseFromResolution(commandRequest, {
        approved: true,
        actionId: "approve",
      }),
      { decision: "accept" },
    );
    assert.deepEqual(
      buildCodexNativeApprovalResponseFromResolution(commandRequest, {
        approved: false,
        actionId: "deny",
      }),
      { decision: "decline" },
    );

    const permissionRequest = {
      method: "item/permissions/requestApproval",
      params: {
        cwd: "/repo/example",
        reason: "Need to read a sibling package.",
        permissions: {
          fileSystem: {
            read: ["/repo/shared"],
            write: null,
          },
          network: null,
        },
      },
    };

    assert.deepEqual(
      buildCodexNativeApprovalResponseFromResolution(permissionRequest, {
        approved: true,
        actionId: "approve",
      }),
      {
        permissions: {
          fileSystem: {
            read: ["/repo/shared"],
            write: null,
          },
        },
        scope: "turn",
      },
    );
    assert.deepEqual(
      buildCodexNativeApprovalResponseFromResolution(permissionRequest, {
        approved: false,
        actionId: "deny",
      }),
      { permissions: {}, scope: "turn" },
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
    assert.include(
      manifest,
      "Zotero resources and MCP tools are available when useful",
    );
    assert.include(
      manifest,
      "Use tools only when they materially improve the answer",
    );
    assert.include(manifest, "quote anchors like [[quote:Q_x7a2]]");
    assert.include(
      manifest,
      "Do not call tools solely to discover quotes or page numbers",
    );
    assert.notInclude(manifest, "page N");
    assert.notInclude(manifest, "use shell creatively");
  });

  it("renders selected tag resources in Codex native visible context", function () {
    const block = buildCodexNativeVisibleTurnContextBlockForTests({
      scope: {
        conversationKey: 1,
        libraryID: 1,
        libraryName: "My Library",
        kind: "global",
      },
      skillContext: {
        selectedTagContexts: [
          {
            name: "Stable",
            normalizedName: "stable",
            libraryID: 1,
          },
          {
            name: "Untagged",
            libraryID: 1,
            scope: "untagged",
          },
        ],
      },
    });

    assert.include(block, "Zotero context for this turn");
    assert.include(block, "Library scope");
    assert.include(block, "Tag 1");
    assert.include(block, "Tag 2");
    assert.include(block, 'name="Stable"');
    assert.include(block, 'scope="untagged"');
    assert.include(block, 'source="selected resource pool"');
    assert.notInclude(block, "Collection 1");
  });

  it("renders selected note-edit resources in Codex native visible context", function () {
    const block = buildCodexNativeVisibleTurnContextBlockForTests({
      scope: {
        conversationKey: 3703,
        libraryID: 1,
        libraryName: "My Library",
        kind: "paper",
        paperItemID: 3612,
        activeItemId: 3612,
        paperTitle: "Ajemian et al., 2013",
        activeNoteId: 3703,
        activeNoteTitle: "Ajemian et al., 2013 - MD",
        activeNoteKind: "item",
        activeNoteParentItemId: 3612,
      },
      skillContext: {
        selectedTexts: ["Panel A illustrates the stability problem."],
        selectedTextSources: ["note-edit"],
        selectedTextNoteContexts: [
          {
            libraryID: 1,
            noteItemKey: "NOTEKEY",
            noteItemId: 3703,
            parentItemId: 3612,
            noteKind: "item",
            title: "Ajemian et al., 2013 - MD",
          },
        ],
      },
    });

    assert.include(block, 'scope="paper"');
    assert.include(block, "Selected text notes:");
    assert.include(block, "noteId=3703");
    assert.include(block, 'noteKind="item"');
    assert.include(block, "parentItemId=3612");
  });

  it("renders pinned papers and selected collections in visible context", function () {
    const block = buildCodexNativeVisibleTurnContextBlockForTests({
      scope: {
        conversationKey: 1,
        libraryID: 1,
        libraryName: "My Library",
        kind: "paper",
        paperTitle: "Active Drift Paper",
        paperContext: {
          itemId: 10,
          contextItemId: 11,
          title: "Active Drift Paper",
          firstCreator: "Micou",
          year: "2026",
        },
      },
      skillContext: {
        selectedPaperContexts: [
          {
            itemId: 10,
            contextItemId: 11,
            title: "Active Drift Paper",
            firstCreator: "Micou",
            year: "2026",
          },
        ],
        pinnedPaperContexts: [
          {
            itemId: 20,
            contextItemId: 21,
            title: "Self-healing codes",
            firstCreator: "Rule",
            year: "2022",
          },
        ],
        selectedCollectionContexts: [
          { collectionId: 8, libraryID: 1, name: "Representation Drift" },
        ],
        selectedTagContexts: [
          {
            name: "Learning",
            normalizedName: "learning",
            libraryID: 1,
          },
        ],
      },
    });

    assert.include(block, "Paper 1");
    assert.include(block, 'title="Active Drift Paper"');
    assert.include(block, "Paper 2");
    assert.include(block, 'title="Self-healing codes"');
    assert.include(block, "Collection 1");
    assert.include(block, 'name="Representation Drift"');
    assert.include(block, "Tag 1");
    assert.include(block, 'name="Learning"');
    assert.include(block, '"the second paper"');
  });

  it("puts current two-paper context in developer instructions without user-prefix duplication", async function () {
    const processKey = "native-visible-context-turn-test";
    const originalSpawn = CodexAppServerProcess.spawn;
    const originalZotero = globalThis.Zotero;
    let threadResumeParams: Record<string, unknown> | undefined;
    let turnStartParams: Record<string, unknown> | undefined;

    const proc = CodexAppServerProcess.forTest({
      stdin: {
        write: (chunk: string) => {
          const request = JSON.parse(chunk) as {
            id: number;
            method: string;
            params?: Record<string, unknown>;
          };
          const handleMessage = (
            proc as unknown as {
              handleMessage: (msg: Record<string, unknown>) => void;
            }
          ).handleMessage.bind(proc);
          if (request.method === "thread/resume") {
            threadResumeParams = request.params;
            setTimeout(
              () =>
                handleMessage({
                  id: request.id,
                  result: { thread: { id: "thread-visible" } },
                }),
              0,
            );
            return;
          }
          if (request.method === "turn/start") {
            turnStartParams = request.params;
            setTimeout(
              () =>
                handleMessage({
                  id: request.id,
                  result: { turn: { id: "turn-visible" } },
                }),
              0,
            );
            setTimeout(
              () =>
                handleMessage({
                  method: "turn/completed",
                  params: {
                    turn: { id: "turn-visible", status: "completed" },
                  },
                }),
              5,
            );
            return;
          }
          if (request.method === "thread/read") {
            setTimeout(
              () => handleMessage({ id: request.id, result: { turns: [] } }),
              0,
            );
          }
        },
      },
      kill: () => {},
    });
    CodexAppServerProcess.spawn = async () => proc;
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      Prefs: {
        get: (key: string) =>
          key.endsWith(".codexAppServerZoteroMcpToolsEnabled")
            ? false
            : undefined,
      },
    };

    try {
      await runCodexAppServerNativeTurn({
        scope: {
          profileSignature: "profile-visible-test",
          conversationKey: 6_000_000_030,
          libraryID: 1,
          libraryName: "My Library",
          kind: "paper",
          paperItemID: 10,
          paperTitle:
            "Statistics of cortical representational drift can enable robust readout",
        },
        model: "gpt-5.5",
        messages: [
          {
            role: "system",
            content: "SECRET SYSTEM PROMPT: do not show in chat trace.",
          },
          {
            role: "user",
            content: "does it make the two papers connected to each other?",
          },
        ],
        skillContext: {
          selectedPaperContexts: [
            {
              itemId: 10,
              contextItemId: 11,
              title:
                "Statistics of cortical representational drift can enable robust readout",
              firstCreator: "Micou",
              year: "2026",
            },
          ],
          pinnedPaperContexts: [
            {
              itemId: 20,
              contextItemId: 21,
              title:
                "Self-healing codes: How stable neural populations can track continually reconfiguring neural representations",
              firstCreator: "Rule",
              year: "2022",
            },
          ],
        },
        hooks: {
          loadProviderSessionId: async () => "thread-visible",
          persistProviderSessionId: async () => undefined,
        },
        processKey,
      });
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
        originalZotero;
      destroyCachedCodexAppServerProcess(processKey, proc);
    }

    assert.isOk(turnStartParams);
    const developerInstructions = String(
      threadResumeParams?.developerInstructions || "",
    );
    const inputText = JSON.stringify(turnStartParams?.input);
    assert.include(developerInstructions, "Zotero context for this turn");
    assert.include(developerInstructions, "Paper 1", developerInstructions);
    assert.include(
      developerInstructions,
      "Statistics of cortical representational drift can enable robust readout",
    );
    assert.include(developerInstructions, "Paper 2");
    assert.include(developerInstructions, "Self-healing codes");
    assert.include(
      inputText,
      "does it make the two papers connected to each other?",
    );
    assert.notInclude(inputText, "Zotero context for this turn");
    assert.notInclude(inputText, "Paper 1");
    assert.notInclude(inputText, "Paper 2");
    assert.notInclude(inputText, "SECRET SYSTEM PROMPT");
    assert.notInclude(inputText, "Zotero environment for this turn");
    assert.notInclude(inputText, "Notes directory configuration");
  });

  it("prefixes visible context only when developer instructions are unsupported", async function () {
    const processKey = "native-visible-context-fallback-test";
    const originalSpawn = CodexAppServerProcess.spawn;
    const originalZotero = globalThis.Zotero;
    const originalToolkit = (
      globalThis as typeof globalThis & { ztoolkit?: unknown }
    ).ztoolkit;
    const threadResumeParams: Record<string, unknown>[] = [];
    let turnStartParams: Record<string, unknown> | undefined;

    const proc = CodexAppServerProcess.forTest({
      stdin: {
        write: (chunk: string) => {
          const request = JSON.parse(chunk) as {
            id: number;
            method: string;
            params?: Record<string, unknown>;
          };
          const handleMessage = (
            proc as unknown as {
              handleMessage: (msg: Record<string, unknown>) => void;
            }
          ).handleMessage.bind(proc);
          if (request.method === "thread/resume") {
            threadResumeParams.push(request.params || {});
            if (threadResumeParams.length === 1) {
              setTimeout(
                () =>
                  handleMessage({
                    id: request.id,
                    error: {
                      message:
                        "invalid params: unknown field developerInstructions",
                    },
                  }),
                0,
              );
              return;
            }
            setTimeout(
              () =>
                handleMessage({
                  id: request.id,
                  result: { thread: { id: "thread-visible-fallback" } },
                }),
              0,
            );
            return;
          }
          if (request.method === "turn/start") {
            turnStartParams = request.params;
            setTimeout(
              () =>
                handleMessage({
                  id: request.id,
                  result: { turn: { id: "turn-visible-fallback" } },
                }),
              0,
            );
            setTimeout(
              () =>
                handleMessage({
                  method: "turn/completed",
                  params: {
                    turn: {
                      id: "turn-visible-fallback",
                      status: "completed",
                    },
                  },
                }),
              5,
            );
            return;
          }
          if (request.method === "thread/read") {
            setTimeout(
              () => handleMessage({ id: request.id, result: { turns: [] } }),
              0,
            );
          }
        },
      },
      kill: () => {},
    });
    CodexAppServerProcess.spawn = async () => proc;
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      Prefs: {
        get: (key: string) =>
          key.endsWith(".codexAppServerZoteroMcpToolsEnabled")
            ? false
            : undefined,
      },
    };
    (globalThis as typeof globalThis & { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };

    try {
      await runCodexAppServerNativeTurn({
        scope: {
          profileSignature: "profile-visible-fallback-test",
          conversationKey: 6_000_000_031,
          libraryID: 1,
          kind: "paper",
          paperItemID: 10,
          paperTitle: "Fallback Context Paper",
        },
        model: "gpt-5.5",
        messages: [{ role: "user", content: "summarize the context" }],
        skillContext: {
          selectedPaperContexts: [
            {
              itemId: 10,
              contextItemId: 11,
              title: "Fallback Context Paper",
              firstCreator: "Micou",
              year: "2026",
            },
          ],
        },
        hooks: {
          loadProviderSessionId: async () => "thread-visible-fallback",
          persistProviderSessionId: async () => undefined,
        },
        processKey,
      });
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
        originalZotero;
      (globalThis as typeof globalThis & { ztoolkit?: unknown }).ztoolkit =
        originalToolkit;
      destroyCachedCodexAppServerProcess(processKey, proc);
    }

    assert.lengthOf(threadResumeParams, 2);
    assert.isString(threadResumeParams[0].developerInstructions);
    assert.notProperty(threadResumeParams[1], "developerInstructions");
    const inputText = JSON.stringify(turnStartParams?.input);
    assert.include(inputText, "Zotero context for this turn");
    assert.include(inputText, "Fallback Context Paper");
    assert.equal(inputText.split("Zotero context for this turn").length - 1, 1);
  });

  it("passes configured native approvals reviewer to thread and turn requests", async function () {
    const processKey = "native-approvals-reviewer-test";
    const originalSpawn = CodexAppServerProcess.spawn;
    const originalZotero = globalThis.Zotero;
    let threadStartParams: Record<string, unknown> | undefined;
    let turnStartParams: Record<string, unknown> | undefined;

    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      DataDirectory: { dir: "/tmp/lfz-native-reviewer-data" },
      Profile: { dir: "/tmp/lfz-native-reviewer-profile" },
      Prefs: {
        get: (key: string) => {
          if (key.endsWith(".codexAppServerZoteroMcpToolsEnabled"))
            return false;
          if (key.endsWith(".codexAppServerApprovalsReviewer")) {
            return "auto_review";
          }
          return undefined;
        },
      },
    };

    const proc = CodexAppServerProcess.forTest({
      stdin: {
        write: (chunk: string) => {
          const request = JSON.parse(chunk) as {
            id: number;
            method: string;
            params?: Record<string, unknown>;
          };
          const handleMessage = (
            proc as unknown as {
              handleMessage: (msg: Record<string, unknown>) => void;
            }
          ).handleMessage.bind(proc);
          if (request.method === "thread/start") {
            threadStartParams = request.params;
            setTimeout(
              () =>
                handleMessage({
                  id: request.id,
                  result: { thread: { id: "thread-reviewer" } },
                }),
              0,
            );
            return;
          }
          if (request.method === "turn/start") {
            turnStartParams = request.params;
            setTimeout(
              () =>
                handleMessage({
                  id: request.id,
                  result: { turn: { id: "turn-reviewer" } },
                }),
              0,
            );
            setTimeout(
              () =>
                handleMessage({
                  method: "turn/completed",
                  params: {
                    turn: { id: "turn-reviewer", status: "completed" },
                  },
                }),
              5,
            );
            return;
          }
          if (request.method === "thread/read") {
            setTimeout(
              () => handleMessage({ id: request.id, result: { turns: [] } }),
              0,
            );
          }
        },
      },
      kill: () => {},
    });
    CodexAppServerProcess.spawn = async () => proc;

    try {
      await runCodexAppServerNativeTurn({
        scope: {
          profileSignature: "profile-native-reviewer-test",
          conversationKey: 6_000_000_034,
          libraryID: 1,
          kind: "global",
        },
        model: "gpt-5.5",
        messages: [{ role: "user", content: "Run a safe check." }],
        hooks: {
          loadProviderSessionId: async () => undefined,
          persistProviderSessionId: async () => undefined,
        },
        processKey,
      });
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
        originalZotero;
      destroyCachedCodexAppServerProcess(processKey, proc);
    }

    assert.equal(threadStartParams?.approvalPolicy, "on-request");
    assert.equal(threadStartParams?.approvalsReviewer, "auto_review");
    assert.equal(turnStartParams?.approvalPolicy, "on-request");
    assert.equal(turnStartParams?.approvalsReviewer, "auto_review");
  });

  it("submits automatic skill matches as structured native Codex skill inputs", async function () {
    setUserSkills([
      parseSkill(BUILTIN_SKILL_FILES["simple-paper-qa.md"]),
      parseSkill(BUILTIN_SKILL_FILES["evidence-based-qa.md"]),
    ]);
    const processKey = "native-auto-skill-input-test";
    const originalSpawn = CodexAppServerProcess.spawn;
    const originalZotero = globalThis.Zotero;
    let skillsListParams: Record<string, unknown> | undefined;
    let threadStartParams: Record<string, unknown> | undefined;
    let turnStartParams: Record<string, unknown> | undefined;
    const activatedSkills: string[] = [];

    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      DataDirectory: { dir: "/tmp/lfz-native-auto-skill-data" },
      Profile: { dir: "/tmp/lfz-native-auto-skill-profile" },
      Prefs: {
        get: (key: string) =>
          key.endsWith(".codexAppServerZoteroMcpToolsEnabled")
            ? false
            : undefined,
      },
    };
    const expectedCwd = getUserSkillsRuntimeRootDir();
    const skillPath = `${expectedCwd}/.agents/skills/evidence-based-qa/SKILL.md`;

    const proc = CodexAppServerProcess.forTest({
      stdin: {
        write: (chunk: string) => {
          const request = JSON.parse(chunk) as {
            id: number;
            method: string;
            params?: Record<string, unknown>;
          };
          const handleMessage = (
            proc as unknown as {
              handleMessage: (msg: Record<string, unknown>) => void;
            }
          ).handleMessage.bind(proc);
          if (request.method === "skills/list") {
            skillsListParams = request.params;
            setTimeout(
              () =>
                handleMessage({
                  id: request.id,
                  result: {
                    data: [
                      {
                        cwd: expectedCwd,
                        errors: [],
                        skills: [
                          {
                            name: "evidence-based-qa",
                            path: skillPath,
                            enabled: true,
                            description: "",
                            scope: "local",
                          },
                        ],
                      },
                    ],
                  },
                }),
              0,
            );
            return;
          }
          if (request.method === "thread/start") {
            threadStartParams = request.params;
            setTimeout(
              () =>
                handleMessage({
                  id: request.id,
                  result: { thread: { id: "thread-auto-skill" } },
                }),
              0,
            );
            return;
          }
          if (request.method === "turn/start") {
            turnStartParams = request.params;
            setTimeout(
              () =>
                handleMessage({
                  id: request.id,
                  result: { turn: { id: "turn-auto-skill" } },
                }),
              0,
            );
            setTimeout(
              () =>
                handleMessage({
                  method: "turn/completed",
                  params: {
                    turn: { id: "turn-auto-skill", status: "completed" },
                  },
                }),
              5,
            );
            return;
          }
          if (request.method === "thread/read") {
            setTimeout(
              () => handleMessage({ id: request.id, result: { turns: [] } }),
              0,
            );
          }
        },
      },
      kill: () => {},
    });
    CodexAppServerProcess.spawn = async () => proc;

    try {
      await runCodexAppServerNativeTurn({
        scope: {
          profileSignature: "profile-native-auto-skill-test",
          conversationKey: 6_000_000_032,
          libraryID: 1,
          kind: "paper",
          paperItemID: 10,
          activeContextItemId: 11,
          paperTitle: "Native Skills Paper",
        },
        model: "gpt-5.5",
        messages: [
          {
            role: "user",
            content: "what method did they use in this paper",
          },
        ],
        hooks: {
          loadProviderSessionId: async () => undefined,
          persistProviderSessionId: async () => undefined,
        },
        onSkillActivated: (skillId) => activatedSkills.push(skillId),
        processKey,
      });
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
        originalZotero;
      destroyCachedCodexAppServerProcess(processKey, proc);
    }

    assert.deepEqual(skillsListParams?.cwds, [expectedCwd]);
    const input = turnStartParams?.input as Record<string, unknown>[];
    assert.deepEqual(input[0], {
      type: "skill",
      name: "evidence-based-qa",
      path: skillPath,
    });
    const turnStartText = JSON.stringify(turnStartParams);
    assert.include(turnStartText, "what method did they use in this paper");
    assert.notInclude(turnStartText, "$evidence-based-qa");
    assert.notInclude(turnStartText, "$simple-paper-qa");
    assert.notInclude(
      JSON.stringify(threadStartParams),
      "LLM-for-Zotero skills active for this turn",
    );
    assert.notInclude(
      turnStartText,
      "LLM-for-Zotero skills active for this turn",
    );
    assert.deepEqual(activatedSkills, ["evidence-based-qa"]);
  });

  it("converts explicit native skill text into structured skill input without duplication", async function () {
    setUserSkills([parseSkill(BUILTIN_SKILL_FILES["write-note.md"])]);
    const processKey = "native-explicit-skill-input-test";
    const originalSpawn = CodexAppServerProcess.spawn;
    const originalZotero = globalThis.Zotero;
    let turnStartParams: Record<string, unknown> | undefined;

    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      DataDirectory: { dir: "/tmp/lfz-native-explicit-skill-data" },
      Profile: { dir: "/tmp/lfz-native-explicit-skill-profile" },
      Prefs: {
        get: (key: string) =>
          key.endsWith(".codexAppServerZoteroMcpToolsEnabled")
            ? false
            : undefined,
      },
    };
    const expectedCwd = getUserSkillsRuntimeRootDir();
    const skillPath = `${expectedCwd}/.agents/skills/write-note/SKILL.md`;

    const proc = CodexAppServerProcess.forTest({
      stdin: {
        write: (chunk: string) => {
          const request = JSON.parse(chunk) as {
            id: number;
            method: string;
            params?: Record<string, unknown>;
          };
          const handleMessage = (
            proc as unknown as {
              handleMessage: (msg: Record<string, unknown>) => void;
            }
          ).handleMessage.bind(proc);
          if (request.method === "skills/list") {
            setTimeout(
              () =>
                handleMessage({
                  id: request.id,
                  result: {
                    data: [
                      {
                        cwd: expectedCwd,
                        errors: [],
                        skills: [
                          {
                            name: "write-note",
                            path: skillPath,
                            enabled: true,
                            description: "",
                            scope: "local",
                          },
                        ],
                      },
                    ],
                  },
                }),
              0,
            );
            return;
          }
          if (request.method === "thread/start") {
            setTimeout(
              () =>
                handleMessage({
                  id: request.id,
                  result: { thread: { id: "thread-explicit-skill" } },
                }),
              0,
            );
            return;
          }
          if (request.method === "turn/start") {
            turnStartParams = request.params;
            setTimeout(
              () =>
                handleMessage({
                  id: request.id,
                  result: { turn: { id: "turn-explicit-skill" } },
                }),
              0,
            );
            setTimeout(
              () =>
                handleMessage({
                  method: "turn/completed",
                  params: {
                    turn: { id: "turn-explicit-skill", status: "completed" },
                  },
                }),
              5,
            );
            return;
          }
          if (request.method === "thread/read") {
            setTimeout(
              () => handleMessage({ id: request.id, result: { turns: [] } }),
              0,
            );
          }
        },
      },
      kill: () => {},
    });
    CodexAppServerProcess.spawn = async () => proc;

    try {
      await runCodexAppServerNativeTurn({
        scope: {
          profileSignature: "profile-native-explicit-skill-test",
          conversationKey: 6_000_000_033,
          libraryID: 1,
          kind: "global",
        },
        model: "gpt-5.5",
        messages: [{ role: "user", content: "$write-note\n\nDraft a note." }],
        skillContext: { forcedSkillIds: ["write-note"] },
        hooks: {
          loadProviderSessionId: async () => undefined,
          persistProviderSessionId: async () => undefined,
        },
        processKey,
      });
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
        originalZotero;
      destroyCachedCodexAppServerProcess(processKey, proc);
    }

    const input = turnStartParams?.input as Record<string, unknown>[];
    assert.deepEqual(input[0], {
      type: "skill",
      name: "write-note",
      path: skillPath,
    });
    const turnStartText = JSON.stringify(turnStartParams);
    assert.include(turnStartText, "Draft a note.");
    assert.notInclude(turnStartText, "$write-note");
  });

  it("starts native Codex turns from the profile-scoped skills workspace and omits legacy skill injection", async function () {
    const processKey = "native-skills-cwd-turn-test";
    const originalSpawn = CodexAppServerProcess.spawn;
    const originalZotero = globalThis.Zotero;
    let threadStartParams: Record<string, unknown> | undefined;
    let turnStartParams: Record<string, unknown> | undefined;

    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      DataDirectory: { dir: "/tmp/lfz-native-skills-data" },
      Profile: { dir: "/tmp/lfz-native-skills-profile" },
      Prefs: {
        get: (key: string) =>
          key.endsWith(".codexAppServerZoteroMcpToolsEnabled")
            ? false
            : undefined,
      },
    };
    const expectedCwd = getUserSkillsRuntimeRootDir();

    const proc = CodexAppServerProcess.forTest({
      stdin: {
        write: (chunk: string) => {
          const request = JSON.parse(chunk) as {
            id: number;
            method: string;
            params?: Record<string, unknown>;
          };
          const handleMessage = (
            proc as unknown as {
              handleMessage: (msg: Record<string, unknown>) => void;
            }
          ).handleMessage.bind(proc);
          if (request.method === "thread/start") {
            threadStartParams = request.params;
            setTimeout(
              () =>
                handleMessage({
                  id: request.id,
                  result: { thread: { id: "thread-skills-cwd" } },
                }),
              0,
            );
            return;
          }
          if (request.method === "turn/start") {
            turnStartParams = request.params;
            setTimeout(
              () =>
                handleMessage({
                  id: request.id,
                  result: { turn: { id: "turn-skills-cwd" } },
                }),
              0,
            );
            setTimeout(
              () =>
                handleMessage({
                  method: "turn/completed",
                  params: {
                    turn: { id: "turn-skills-cwd", status: "completed" },
                  },
                }),
              5,
            );
            return;
          }
          if (request.method === "thread/read") {
            setTimeout(
              () => handleMessage({ id: request.id, result: { turns: [] } }),
              0,
            );
          }
        },
      },
      kill: () => {},
    });
    CodexAppServerProcess.spawn = async () => proc;

    try {
      await runCodexAppServerNativeTurn({
        scope: {
          profileSignature: "profile-native-skills-cwd-test",
          conversationKey: 6_000_000_031,
          libraryID: 1,
          kind: "global",
        },
        model: "gpt-5.5",
        messages: [{ role: "user", content: "$write-note\n\nDraft a note." }],
        hooks: {
          loadProviderSessionId: async () => undefined,
          persistProviderSessionId: async () => undefined,
        },
        processKey,
      });
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
        originalZotero;
      destroyCachedCodexAppServerProcess(processKey, proc);
    }

    assert.equal(threadStartParams?.cwd, expectedCwd);
    assert.equal(turnStartParams?.cwd, expectedCwd);
    assert.include(String(threadStartParams?.cwd), "/agent-runtime/");
    const threadStartText = JSON.stringify(threadStartParams);
    const turnStartText = JSON.stringify(turnStartParams);
    assert.notInclude(
      threadStartText,
      "LLM-for-Zotero skills active for this turn",
    );
    assert.notInclude(
      turnStartText,
      "LLM-for-Zotero skills active for this turn",
    );
  });

  it("does not contain the removed Codex native resource lifecycle states", function () {
    const source = readFileSync(
      resolve(here, "../src/codexAppServer/nativeClient.ts"),
      "utf8",
    );

    assert.notInclude(source, "thin-followup");
    assert.notInclude(source, "resources-delta");
    assert.notInclude(source, "resources-changed");
    assert.notInclude(source, "CodexNativeLifecycle");
  });

  it("builds Codex native scoped MCP payload with canonical paper contexts", function () {
    const selectedPaper = {
      itemId: 11,
      contextItemId: 12,
      title: "Selected Native Paper",
      attachmentTitle: "Selected Native PDF",
      citationKey: "nativeSelected2026",
      firstCreator: "Ng",
      year: "2026",
      contentSourceMode: "mineru" as const,
      mineruCacheDir: "/tmp/mineru-cache/native-selected",
    };
    const fullTextPaper = {
      itemId: 21,
      contextItemId: 22,
      title: "Full Text Native Paper",
      attachmentTitle: "Full Text Native PDF",
      firstCreator: "Lee",
      year: "2025",
      contentSourceMode: "markdown" as const,
      mineruCacheDir: "/tmp/mineru-cache/native-full-text",
    };
    const pinnedPaper = {
      itemId: 31,
      contextItemId: 32,
      title: "Pinned Native Paper",
      attachmentTitle: "Pinned Native PDF",
      firstCreator: "Chen",
      year: "2024",
      contentSourceMode: "text" as const,
      mineruCacheDir: "/tmp/mineru-cache/native-pinned",
    };

    const scope = buildCodexNativeScopedMcpScopeForTests({
      scope: {
        conversationKey: 1,
        libraryID: 1,
        kind: "global",
      },
      profileSignature: "profile-native-paper-scope",
      userText: "read these papers",
      model: "gpt-5.5",
      codexPath: "/tmp/codex-native",
      reasoning: { provider: "openai", level: "high" },
      skillContext: {
        selectedPaperContexts: [selectedPaper],
        fullTextPaperContexts: [fullTextPaper],
        pinnedPaperContexts: [pinnedPaper],
        selectedCollectionContexts: [
          { collectionId: 9, libraryID: 1, name: "Native Collection" },
        ],
        selectedTagContexts: [
          { name: "Stable", normalizedName: "stable", libraryID: 1 },
        ],
      },
    });

    assert.deepEqual(scope.selectedPaperContexts, [selectedPaper]);
    assert.deepEqual(scope.fullTextPaperContexts, [fullTextPaper]);
    assert.deepEqual(scope.pinnedPaperContexts, [pinnedPaper]);
    assert.deepEqual(scope.selectedCollectionContexts, [
      { collectionId: 9, libraryID: 1, name: "Native Collection" },
    ]);
    assert.deepEqual(scope.selectedTagContexts, [
      { name: "Stable", normalizedName: "stable", libraryID: 1 },
    ]);
    assert.equal(scope.model, "gpt-5.5");
    assert.equal(scope.codexPath, "/tmp/codex-native");
    assert.deepEqual(scope.reasoning, {
      provider: "openai",
      level: "high",
    });
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
