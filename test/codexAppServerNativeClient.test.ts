import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "chai";
import {
  buildCodexNativeScopedMcpScopeForTests,
  buildCodexNativeVisibleTurnContextBlockForTests,
  buildZoteroEnvironmentManifest,
  compactCodexAppServerConversation,
  compactCodexAppServerThread,
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

const here = dirname(fileURLToPath(import.meta.url));

describe("Codex app-server native client", function () {
  afterEach(function () {
    clearCodexNativeReadLedger();
  });

  it("sends native thread compact requests and waits for completion", async function () {
    const processKey = "native-compact-thread-test";
    const originalSpawn = CodexAppServerProcess.spawn;
    const writes: string[] = [];
    let proc!: CodexAppServerProcess;
    proc = CodexAppServerProcess.forTest({
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

  it("prefixes current two-paper context into resumed Codex native turn input", async function () {
    const processKey = "native-visible-context-turn-test";
    const originalSpawn = CodexAppServerProcess.spawn;
    const originalZotero = globalThis.Zotero;
    let proc!: CodexAppServerProcess;
    let turnStartParams: Record<string, unknown> | undefined;

    proc = CodexAppServerProcess.forTest({
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
    const inputText = JSON.stringify(turnStartParams?.input);
    assert.include(inputText, "Zotero context for this turn");
    assert.include(inputText, "Paper 1", inputText);
    assert.include(
      inputText,
      "Statistics of cortical representational drift can enable robust readout",
    );
    assert.include(inputText, "Paper 2");
    assert.include(inputText, "Self-healing codes");
    assert.include(
      inputText,
      "does it make the two papers connected to each other?",
    );
    assert.notInclude(inputText, "SECRET SYSTEM PROMPT");
    assert.notInclude(inputText, "Zotero environment for this turn");
    assert.notInclude(inputText, "Notes directory configuration");
  });

  it("starts native Codex turns from the profile-scoped skills workspace and omits legacy skill injection", async function () {
    const processKey = "native-skills-cwd-turn-test";
    const originalSpawn = CodexAppServerProcess.spawn;
    const originalZotero = globalThis.Zotero;
    let proc!: CodexAppServerProcess;
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

    proc = CodexAppServerProcess.forTest({
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
