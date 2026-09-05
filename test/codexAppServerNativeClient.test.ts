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
  forkCodexAppServerThread,
  isDeniedTrustedZoteroMcpGuardianReviewForTests,
  listCodexAppServerModels,
  NO_CODEX_APP_SERVER_THREAD_TO_COMPACT_MESSAGE,
  resolveCodexNativeApprovalRequest,
  resolveSafeCodexNativeApprovalRequest,
  resetCodexNativePathSafetyStateForTests,
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
import {
  invokeRegisteredZoteroMcpEndpoint,
  registerMcpServer,
  resolveConversationScopeToken,
  unregisterMcpServer,
  ZOTERO_MCP_SCOPE_HEADER,
} from "../src/agent/mcp/server";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { getCodexProfileSignature } from "../src/codexAppServer/constants";
import { getUserSkillsRuntimeRootDir } from "../src/agent/skills/userSkills";
import { PAPER_CITATION_CONTRACT } from "../src/shared/instructionContracts";
import {
  BUILTIN_SKILL_FILES,
  parseSkill,
  setUserSkills,
} from "../src/agent/skills";
import { clearCodexNativeSkillClassifierCache } from "../src/codexAppServer/nativeSkills";

const here = dirname(fileURLToPath(import.meta.url));

function createNativeLifecycleTestProcess(params: {
  newThreadIds: string[];
  requests: Array<{ method: string; params: Record<string, any> }>;
  deltaForTurn?: (turnNumber: number) => string;
  skillsListResult?: unknown;
}): CodexAppServerProcess {
  let turnNumber = 0;
  const threadIds = [...params.newThreadIds];
  const proc = CodexAppServerProcess.forTest({
    stdin: {
      write: (chunk: string) => {
        const request = JSON.parse(chunk) as {
          id: number;
          method: string;
          params?: Record<string, any>;
        };
        const requestParams = request.params || {};
        params.requests.push({ method: request.method, params: requestParams });
        const handleMessage = (
          proc as unknown as {
            handleMessage: (message: Record<string, unknown>) => void;
          }
        ).handleMessage.bind(proc);
        if (
          request.method === "skills/list" &&
          params.skillsListResult !== undefined
        ) {
          setTimeout(
            () =>
              handleMessage({
                id: request.id,
                result: params.skillsListResult,
              }),
            0,
          );
          return;
        }
        if (request.method === "thread/resume") {
          setTimeout(
            () =>
              handleMessage({
                id: request.id,
                result: { thread: { id: requestParams.threadId } },
              }),
            0,
          );
          return;
        }
        if (request.method === "thread/start") {
          const threadId = threadIds.shift() || "thread-native-test";
          setTimeout(
            () =>
              handleMessage({
                id: request.id,
                result: { thread: { id: threadId } },
              }),
            0,
          );
          return;
        }
        if (
          request.method === "thread/archive" ||
          request.method === "thread/name/set" ||
          request.method === "thread/read" ||
          request.method === "thread/inject_items"
        ) {
          setTimeout(() => handleMessage({ id: request.id, result: {} }), 0);
          return;
        }
        if (request.method === "turn/start") {
          turnNumber += 1;
          const turnId = `turn-lifecycle-${turnNumber}`;
          setTimeout(
            () =>
              handleMessage({
                id: request.id,
                result: { turn: { id: turnId } },
              }),
            0,
          );
          const delta = params.deltaForTurn?.(turnNumber) || "";
          if (delta) {
            setTimeout(
              () =>
                handleMessage({
                  method: "item/agentMessage/delta",
                  params: { turnId, delta },
                }),
              2,
            );
          }
          setTimeout(
            () =>
              handleMessage({
                method: "turn/completed",
                params: { turn: { id: turnId, status: "completed" } },
              }),
            5,
          );
        }
      },
    },
    kill: () => {},
  });
  return proc;
}

function installDirectPathTestPrefs(skillMode: "native" | "off" = "off") {
  const originalZotero = (globalThis as any).Zotero;
  (globalThis as any).Zotero = {
    ...(originalZotero || {}),
    debug: () => undefined,
    DataDirectory: { dir: "/tmp/lfz-direct-pdf-skill-data" },
    Profile: { dir: "/tmp/lfz-direct-pdf-skill-profile" },
    Prefs: {
      get: (key: string) => {
        if (key.endsWith(".codexAppServerZoteroMcpToolsEnabled")) return false;
        if (key.endsWith(".codexNativeSkillMode")) return skillMode;
        return undefined;
      },
    },
  };
  return () => {
    (globalThis as any).Zotero = originalZotero;
  };
}

function createDirectPdfSelection(params: {
  itemId: number;
  contextItemId: number;
  title: string;
  name: string;
  absolutePath: string;
}) {
  return {
    paper: {
      itemId: params.itemId,
      contextItemId: params.contextItemId,
      title: params.title,
      attachmentTitle: params.name,
      contentSourceMode: "pdf" as const,
    },
    document: {
      kind: "local_pdf" as const,
      sourceKey: `zotero-pdf:${params.itemId}:${params.contextItemId}` as const,
      itemId: params.itemId,
      contextItemId: params.contextItemId,
      title: params.title,
      name: params.name,
      mimeType: "application/pdf" as const,
      absolutePath: params.absolutePath,
    },
  };
}

describe("Codex app-server native client", function () {
  it("renders exact original PDF paths and identities in selection order", function () {
    const first = createDirectPdfSelection({
      itemId: 10,
      contextItemId: 12,
      title: 'First "quoted" paper',
      name: "first.pdf",
      absolutePath: '/Users/example/Papers/First "quoted" paper.pdf',
    });
    const second = createDirectPdfSelection({
      itemId: 20,
      contextItemId: 22,
      title: "Second paper",
      name: "second.pdf",
      absolutePath: "C:\\\\Research\\\\论文\\\\second.pdf",
    });
    const third = createDirectPdfSelection({
      itemId: 30,
      contextItemId: 32,
      title: "UNC paper",
      name: "third.pdf",
      absolutePath: "\\\\server\\share\\third.pdf",
    });

    const context = buildCodexNativeVisibleTurnContextBlockForTests({
      scope: {
        conversationKey: 6_000_000_040,
        libraryID: 1,
        kind: "global",
      },
      skillContext: {
        pdfPaperContexts: [first.paper, second.paper, third.paper],
        localDocuments: [first.document, second.document, third.document],
      },
    });

    const firstLine = `1. paperKey=1:10:12, sourceKey=${first.document.sourceKey}, title=${JSON.stringify(first.document.title)}, name=${JSON.stringify(first.document.name)}, path=${JSON.stringify(first.document.absolutePath)}`;
    const secondLine = `2. paperKey=1:20:22, sourceKey=${second.document.sourceKey}, title=${JSON.stringify(second.document.title)}, name=${JSON.stringify(second.document.name)}, path=${JSON.stringify(second.document.absolutePath)}`;
    const thirdLine = `3. paperKey=1:30:32, sourceKey=${third.document.sourceKey}, title=${JSON.stringify(third.document.title)}, name=${JSON.stringify(third.document.name)}, path=${JSON.stringify(third.document.absolutePath)}`;
    assert.include(context, firstLine);
    assert.include(context, secondLine);
    assert.include(context, thirdLine);
    assert.isBelow(context.indexOf(firstLine), context.indexOf(secondLine));
    assert.isBelow(context.indexOf(secondLine), context.indexOf(thirdLine));
    assert.include(context, "Read exactly these paths");
    assert.notInclude(context, "raw_pdf_read");
  });

  it("uses exact direct paths on an ephemeral PDF thread and rebuilds a clean thread", async function () {
    const processKey = "native-direct-pdf-clean-rebuild";
    const requests: Array<{
      method: string;
      params: Record<string, any>;
    }> = [];
    const proc = createNativeLifecycleTestProcess({
      newThreadIds: ["thread-pdf-ephemeral", "thread-clean-persistent"],
      requests,
      deltaForTurn: (turn) => (turn === 1 ? "pdf answer" : "clean answer"),
    });
    const originalSpawn = CodexAppServerProcess.spawn;
    const restorePrefs = installDirectPathTestPrefs("native");
    let storedThreadId: string | undefined = "thread-prior-persistent";
    const persistedThreadIds: string[] = [];
    let clearCount = 0;
    CodexAppServerProcess.spawn = async () => proc;
    const first = createDirectPdfSelection({
      itemId: 10,
      contextItemId: 11,
      title: "PDF A",
      name: "paper-a.pdf",
      absolutePath: "/Users/example/Papers/PDF A/paper-a.pdf",
    });
    const second = createDirectPdfSelection({
      itemId: 20,
      contextItemId: 21,
      title: "PDF B",
      name: "paper-b.pdf",
      absolutePath: "/Users/example/Papers/PDF B/paper-b.pdf",
    });

    try {
      const pdfResult = await runCodexAppServerNativeTurn({
        scope: {
          profileSignature: "profile-direct-pdf-clean-rebuild",
          conversationKey: 6_000_000_041,
          libraryID: 1,
          kind: "global",
          title: "Direct PDF test",
        },
        model: "gpt-5.6",
        messages: [
          { role: "user", content: "Earlier question" },
          { role: "assistant", content: "Earlier answer" },
          { role: "user", content: "Compare the selected PDFs" },
        ],
        processKey,
        hooks: {
          loadProviderSessionId: async () => storedThreadId,
          clearProviderSessionId: async () => {
            clearCount += 1;
            storedThreadId = undefined;
          },
          persistProviderSessionId: async (threadId) => {
            persistedThreadIds.push(threadId);
            storedThreadId = threadId;
          },
        },
        skillContext: {
          pdfPaperContexts: [first.paper, second.paper],
          localDocuments: [first.document, second.document],
        },
      });
      assert.equal(pdfResult.threadId, "thread-pdf-ephemeral");
      assert.isFalse(pdfResult.resumed);
      assert.equal(clearCount, 1);
      assert.deepEqual(persistedThreadIds, []);

      await runCodexAppServerNativeTurn({
        scope: {
          profileSignature: "profile-direct-pdf-clean-rebuild",
          conversationKey: 6_000_000_041,
          libraryID: 1,
          kind: "global",
          title: "Direct PDF test",
        },
        model: "gpt-5.6",
        messages: [
          { role: "user", content: "Earlier question" },
          { role: "assistant", content: "Earlier answer" },
          { role: "user", content: "Compare the selected PDFs" },
          { role: "assistant", content: "The comparison is complete." },
          { role: "user", content: "Now answer without a PDF" },
        ],
        processKey,
        hooks: {
          loadProviderSessionId: async () => storedThreadId,
          clearProviderSessionId: async () => {
            clearCount += 1;
            storedThreadId = undefined;
          },
          persistProviderSessionId: async (threadId) => {
            persistedThreadIds.push(threadId);
            storedThreadId = threadId;
          },
        },
      });
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      destroyCachedCodexAppServerProcess(processKey, proc);
      restorePrefs();
    }

    const threadStarts = requests.filter(
      (request) => request.method === "thread/start",
    );
    assert.lengthOf(threadStarts, 2);
    assert.equal(threadStarts[0].params.ephemeral, true);
    assert.equal(threadStarts[0].params.sandbox, "read-only");
    assert.equal(threadStarts[0].params.config?.features?.shell_tool, true);
    assert.notProperty(threadStarts[0].params, "runtimeWorkspaceRoots");
    assert.include(
      threadStarts[0].params.developerInstructions,
      JSON.stringify(first.document.absolutePath),
    );
    assert.include(
      threadStarts[0].params.developerInstructions,
      JSON.stringify(second.document.absolutePath),
    );
    assert.isBelow(
      threadStarts[0].params.developerInstructions.indexOf(
        JSON.stringify(first.document.absolutePath),
      ),
      threadStarts[0].params.developerInstructions.indexOf(
        JSON.stringify(second.document.absolutePath),
      ),
    );
    assert.include(
      threadStarts[0].params.developerInstructions,
      "Raw PDF transport policy",
    );
    assert.notInclude(
      threadStarts[0].params.developerInstructions,
      "raw_pdf_read",
    );
    assert.equal(threadStarts[1].params.ephemeral, false);
    assert.equal(threadStarts[1].params.sandbox, "read-only");
    assert.equal(threadStarts[1].params.config?.features?.shell_tool, false);
    assert.notInclude(
      threadStarts[1].params.developerInstructions,
      first.document.absolutePath,
    );
    assert.notInclude(
      threadStarts[1].params.developerInstructions,
      second.document.absolutePath,
    );
    assert.deepEqual(persistedThreadIds, ["thread-clean-persistent"]);
    assert.isFalse(
      requests.some((request) => request.method === "skills/list"),
    );
    assert.isFalse(
      requests.some((request) => request.method === "thread/resume"),
    );
    const injectedHistory = requests.filter(
      (request) => request.method === "thread/inject_items",
    );
    assert.lengthOf(injectedHistory, 2);
    assert.include(
      JSON.stringify(injectedHistory[0].params.items),
      "Earlier question",
    );
    assert.include(
      JSON.stringify(injectedHistory[0].params.items),
      "Earlier answer",
    );
    assert.notInclude(
      JSON.stringify(injectedHistory[1].params.items),
      first.document.absolutePath,
    );
    assert.notInclude(
      JSON.stringify(injectedHistory[1].params.items),
      second.document.absolutePath,
    );
    assert.deepEqual(
      requests
        .filter((request) => request.method === "turn/start")
        .map((request) => request.params.sandboxPolicy),
      [
        { type: "readOnly", networkAccess: false },
        { type: "readOnly", networkAccess: false },
      ],
    );
    assert.isTrue(
      requests.some(
        (request) =>
          request.method === "thread/archive" &&
          request.params.threadId === "thread-prior-persistent",
      ),
    );
  });

  it("keeps A and B paths isolated across consecutive PDF turns", async function () {
    const processKey = "native-direct-pdf-a-b-isolation";
    const requests: Array<{
      method: string;
      params: Record<string, any>;
    }> = [];
    const proc = createNativeLifecycleTestProcess({
      newThreadIds: ["thread-pdf-a", "thread-pdf-b"],
      requests,
    });
    const originalSpawn = CodexAppServerProcess.spawn;
    const restorePrefs = installDirectPathTestPrefs();
    CodexAppServerProcess.spawn = async () => proc;
    const pdfA = createDirectPdfSelection({
      itemId: 100,
      contextItemId: 101,
      title: "PDF A",
      name: "same.pdf",
      absolutePath: "/Users/example/A/same.pdf",
    });
    const pdfB = createDirectPdfSelection({
      itemId: 200,
      contextItemId: 201,
      title: "PDF B",
      name: "same.pdf",
      absolutePath: "/Users/example/B/same.pdf",
    });
    const hooks = {
      loadProviderSessionId: async () => undefined,
      persistProviderSessionId: async () => {
        throw new Error("An ephemeral PDF thread must not be persisted");
      },
    };

    try {
      const resultA = await runCodexAppServerNativeTurn({
        scope: {
          profileSignature: "profile-direct-pdf-a-b-isolation",
          conversationKey: 6_000_000_042,
          libraryID: 1,
          kind: "global",
        },
        model: "gpt-5.6",
        messages: [{ role: "user", content: "Read A" }],
        processKey,
        hooks,
        skillContext: {
          pdfPaperContexts: [pdfA.paper],
          localDocuments: [pdfA.document],
        },
      });
      const resultB = await runCodexAppServerNativeTurn({
        scope: {
          profileSignature: "profile-direct-pdf-a-b-isolation",
          conversationKey: 6_000_000_042,
          libraryID: 1,
          kind: "global",
        },
        model: "gpt-5.6",
        messages: [
          { role: "user", content: "Read A" },
          { role: "assistant", content: "A read is complete." },
          { role: "user", content: "Read B" },
        ],
        processKey,
        hooks,
        skillContext: {
          pdfPaperContexts: [pdfB.paper],
          localDocuments: [pdfB.document],
        },
      });
      assert.equal(resultA.threadId, "thread-pdf-a");
      assert.equal(resultB.threadId, "thread-pdf-b");
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      destroyCachedCodexAppServerProcess(processKey, proc);
      restorePrefs();
    }

    const starts = requests.filter(
      (request) => request.method === "thread/start",
    );
    assert.lengthOf(starts, 2);
    assert.equal(starts[0].params.ephemeral, true);
    assert.equal(starts[1].params.ephemeral, true);
    assert.include(
      starts[0].params.developerInstructions,
      JSON.stringify(pdfA.document.absolutePath),
    );
    assert.notInclude(
      starts[0].params.developerInstructions,
      pdfB.document.absolutePath,
    );
    assert.include(
      starts[1].params.developerInstructions,
      JSON.stringify(pdfB.document.absolutePath),
    );
    assert.notInclude(
      starts[1].params.developerInstructions,
      pdfA.document.absolutePath,
    );
    assert.isTrue(
      starts.every(
        (request) => request.params.config?.features?.shell_tool === true,
      ),
    );
    assert.isTrue(
      starts.every((request) => !("runtimeWorkspaceRoots" in request.params)),
    );
  });

  it("keeps automatic skill routing off on a PDF turn without an explicit skill", async function () {
    setUserSkills([parseSkill(BUILTIN_SKILL_FILES["simple-paper-qa.md"])]);
    const processKey = "native-direct-pdf-no-automatic-skill";
    const requests: Array<{
      method: string;
      params: Record<string, any>;
    }> = [];
    const proc = createNativeLifecycleTestProcess({
      newThreadIds: ["thread-pdf-no-automatic-skill"],
      requests,
    });
    const originalSpawn = CodexAppServerProcess.spawn;
    const restorePrefs = installDirectPathTestPrefs("native");
    const activatedSkills: string[] = [];
    CodexAppServerProcess.spawn = async () => proc;
    const pdf = createDirectPdfSelection({
      itemId: 290,
      contextItemId: 291,
      title: "Automatic skill candidate",
      name: "paper.pdf",
      absolutePath: "/Users/example/Papers/Automatic Candidate/paper.pdf",
    });

    try {
      await runCodexAppServerNativeTurn({
        scope: {
          profileSignature: "profile-direct-pdf-no-automatic-skill",
          conversationKey: 6_000_000_042,
          libraryID: 1,
          kind: "global",
        },
        model: "gpt-5.6",
        messages: [
          {
            role: "user",
            content: "Summarize the selected paper.",
          },
        ],
        processKey,
        hooks: {
          loadProviderSessionId: async () => undefined,
          persistProviderSessionId: async () => {
            throw new Error("An ephemeral PDF thread must not be persisted");
          },
        },
        skillContext: {
          pdfPaperContexts: [pdf.paper],
          localDocuments: [pdf.document],
        },
        onSkillActivated: (skillId) => activatedSkills.push(skillId),
      });
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      destroyCachedCodexAppServerProcess(processKey, proc);
      restorePrefs();
    }

    assert.isFalse(
      requests.some((request) => request.method === "skills/list"),
    );
    const threadStart = requests.find(
      (request) => request.method === "thread/start",
    );
    assert.notProperty(threadStart?.params || {}, "cwd");
    const turnStart = requests.find(
      (request) => request.method === "turn/start",
    );
    assert.notProperty(turnStart?.params || {}, "cwd");
    const turnInput = turnStart?.params.input as Record<string, unknown>[];
    assert.isFalse(turnInput.some((input) => input.type === "skill"));
    assert.deepEqual(activatedSkills, []);
  });

  it("activates only an explicitly selected skill on a PDF turn", async function () {
    setUserSkills([
      parseSkill(BUILTIN_SKILL_FILES["write-note.md"]),
      parseSkill(BUILTIN_SKILL_FILES["simple-paper-qa.md"]),
    ]);
    const processKey = "native-direct-pdf-explicit-skill";
    const requests: Array<{
      method: string;
      params: Record<string, any>;
    }> = [];
    const originalSpawn = CodexAppServerProcess.spawn;
    const restorePrefs = installDirectPathTestPrefs("native");
    const expectedCwd = getUserSkillsRuntimeRootDir();
    const writeNoteSkillPath = `${expectedCwd}/.agents/skills/write-note/SKILL.md`;
    const listedWriteNoteSkillPath =
      process.platform === "darwin"
        ? writeNoteSkillPath.replace(/^\/tmp\//, "/private/tmp/")
        : writeNoteSkillPath;
    const simplePaperQaSkillPath = `${expectedCwd}/.agents/skills/simple-paper-qa/SKILL.md`;
    const proc = createNativeLifecycleTestProcess({
      newThreadIds: ["thread-pdf-explicit-skill"],
      requests,
      skillsListResult: {
        data: [
          {
            cwd: expectedCwd,
            errors: [],
            skills: [
              {
                name: "write-note",
                path: "/tmp/unrelated-skills/write-note/SKILL.md",
                enabled: true,
              },
              {
                name: "write-note",
                path: listedWriteNoteSkillPath,
                enabled: true,
              },
              {
                name: "simple-paper-qa",
                path: simplePaperQaSkillPath,
                enabled: true,
              },
            ],
          },
        ],
      },
    });
    const activatedSkills: string[] = [];
    let diagnostics: { skillIds: string[] } | undefined;
    CodexAppServerProcess.spawn = async () => proc;
    const pdf = createDirectPdfSelection({
      itemId: 300,
      contextItemId: 301,
      title: "Explicit skill PDF",
      name: "paper.pdf",
      absolutePath: "/Users/example/Papers/Explicit Skill/paper.pdf",
    });

    try {
      await runCodexAppServerNativeTurn({
        scope: {
          profileSignature: "profile-direct-pdf-explicit-skill",
          conversationKey: 6_000_000_043,
          libraryID: 1,
          kind: "global",
        },
        model: "gpt-5.6",
        messages: [
          {
            role: "user",
            content: "Summarize the selected raw PDF and write a note.",
          },
        ],
        processKey,
        hooks: {
          loadProviderSessionId: async () => undefined,
          persistProviderSessionId: async () => {
            throw new Error("An ephemeral PDF thread must not be persisted");
          },
        },
        skillContext: {
          forcedSkillIds: ["write-note"],
          pdfPaperContexts: [pdf.paper],
          localDocuments: [pdf.document],
        },
        onSkillActivated: (skillId) => activatedSkills.push(skillId),
        onDiagnostics: (value) => {
          diagnostics = value;
        },
      });
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      destroyCachedCodexAppServerProcess(processKey, proc);
      restorePrefs();
    }

    const skillsListRequests = requests.filter(
      (request) => request.method === "skills/list",
    );
    assert.lengthOf(skillsListRequests, 1);
    assert.deepEqual(skillsListRequests[0].params.cwds, [expectedCwd]);
    const threadStart = requests.find(
      (request) => request.method === "thread/start",
    );
    assert.equal(threadStart?.params.ephemeral, true);
    assert.equal(threadStart?.params.cwd, expectedCwd);
    const turnStart = requests.find(
      (request) => request.method === "turn/start",
    );
    assert.equal(turnStart?.params.cwd, expectedCwd);
    const turnInput = turnStart?.params.input as Record<string, unknown>[];
    assert.include(JSON.stringify(turnInput), "$write-note");
    assert.deepEqual(turnInput[0], {
      type: "skill",
      name: "write-note",
      path: listedWriteNoteSkillPath,
    });
    assert.isFalse(
      turnInput.some(
        (input) => input.type === "skill" && input.name === "simple-paper-qa",
      ),
    );
    assert.deepEqual(activatedSkills, ["write-note"]);
    assert.deepEqual(diagnostics?.skillIds, ["write-note"]);
  });

  it("fails a PDF turn when an explicitly selected native skill cannot be loaded", async function () {
    setUserSkills([parseSkill(BUILTIN_SKILL_FILES["write-note.md"])]);
    const processKey = "native-direct-pdf-missing-explicit-skill";
    const requests: Array<{
      method: string;
      params: Record<string, any>;
    }> = [];
    const proc = createNativeLifecycleTestProcess({
      newThreadIds: ["thread-must-not-start"],
      requests,
      skillsListResult: { data: [] },
    });
    const originalSpawn = CodexAppServerProcess.spawn;
    const restorePrefs = installDirectPathTestPrefs("native");
    CodexAppServerProcess.spawn = async () => proc;
    const pdf = createDirectPdfSelection({
      itemId: 310,
      contextItemId: 311,
      title: "Missing explicit skill PDF",
      name: "paper.pdf",
      absolutePath: "/Users/example/Papers/Missing Skill/paper.pdf",
    });
    let error: unknown;

    try {
      await runCodexAppServerNativeTurn({
        scope: {
          profileSignature: "profile-direct-pdf-missing-explicit-skill",
          conversationKey: 6_000_000_044,
          libraryID: 1,
          kind: "global",
        },
        model: "gpt-5.6",
        messages: [
          {
            role: "user",
            content: "$write-note\n\nAnalyze the selected raw PDF.",
          },
        ],
        processKey,
        hooks: {
          loadProviderSessionId: async () => undefined,
          persistProviderSessionId: async () => {
            throw new Error("An ephemeral PDF thread must not be persisted");
          },
        },
        skillContext: {
          forcedSkillIds: ["write-note"],
          pdfPaperContexts: [pdf.paper],
          localDocuments: [pdf.document],
        },
      });
    } catch (caught) {
      error = caught;
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      destroyCachedCodexAppServerProcess(processKey, proc);
      restorePrefs();
    }

    assert.instanceOf(error, Error);
    assert.include((error as Error).message, "write-note");
    assert.isTrue(requests.some((request) => request.method === "skills/list"));
    assert.isFalse(
      requests.some((request) => request.method === "thread/start"),
    );
  });

  it("fails a PDF turn when a persisted explicit skill selection is stale", async function () {
    setUserSkills([]);
    const processKey = "native-direct-pdf-stale-explicit-skill";
    const requests: Array<{
      method: string;
      params: Record<string, any>;
    }> = [];
    const proc = createNativeLifecycleTestProcess({
      newThreadIds: ["thread-must-not-start"],
      requests,
    });
    const originalSpawn = CodexAppServerProcess.spawn;
    const restorePrefs = installDirectPathTestPrefs("native");
    CodexAppServerProcess.spawn = async () => proc;
    const pdf = createDirectPdfSelection({
      itemId: 320,
      contextItemId: 321,
      title: "Stale explicit skill PDF",
      name: "paper.pdf",
      absolutePath: "/Users/example/Papers/Stale Skill/paper.pdf",
    });
    let error: unknown;

    try {
      await runCodexAppServerNativeTurn({
        scope: {
          profileSignature: "profile-direct-pdf-stale-explicit-skill",
          conversationKey: 6_000_000_045,
          libraryID: 1,
          kind: "global",
        },
        model: "gpt-5.6",
        messages: [
          {
            role: "user",
            content: "Analyze the selected raw PDF.",
          },
        ],
        processKey,
        hooks: {
          loadProviderSessionId: async () => undefined,
          persistProviderSessionId: async () => {
            throw new Error("An ephemeral PDF thread must not be persisted");
          },
        },
        skillContext: {
          forcedSkillIds: ["removed-custom-skill"],
          pdfPaperContexts: [pdf.paper],
          localDocuments: [pdf.document],
        },
      });
    } catch (caught) {
      error = caught;
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      destroyCachedCodexAppServerProcess(processKey, proc);
      restorePrefs();
    }

    assert.instanceOf(error, Error);
    assert.include((error as Error).message, "removed-custom-skill");
    assert.isFalse(
      requests.some((request) => request.method === "skills/list"),
    );
    assert.isFalse(
      requests.some((request) => request.method === "thread/start"),
    );
  });

  it("preserves a free-form skill marker on a PDF turn without fabricating a skill path", async function () {
    const processKey = "native-direct-pdf-free-form-skill-marker";
    const requests: Array<{
      method: string;
      params: Record<string, any>;
    }> = [];
    const proc = createNativeLifecycleTestProcess({
      newThreadIds: ["thread-pdf-free-form-skill-marker"],
      requests,
    });
    const originalSpawn = CodexAppServerProcess.spawn;
    const restorePrefs = installDirectPathTestPrefs("native");
    CodexAppServerProcess.spawn = async () => proc;
    const pdf = createDirectPdfSelection({
      itemId: 330,
      contextItemId: 331,
      title: "Free-form skill marker PDF",
      name: "paper.pdf",
      absolutePath: "/Users/example/Papers/Free Marker/paper.pdf",
    });

    try {
      await runCodexAppServerNativeTurn({
        scope: {
          profileSignature: "profile-direct-pdf-free-form-skill-marker",
          conversationKey: 6_000_000_046,
          libraryID: 1,
          kind: "global",
        },
        model: "gpt-5.6",
        messages: [
          {
            role: "user",
            content: "$external-pdf-workflow\n\nAnalyze the raw PDF.",
          },
        ],
        processKey,
        hooks: {
          loadProviderSessionId: async () => undefined,
          persistProviderSessionId: async () => {
            throw new Error("An ephemeral PDF thread must not be persisted");
          },
        },
        skillContext: {
          pdfPaperContexts: [pdf.paper],
          localDocuments: [pdf.document],
        },
      });
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      destroyCachedCodexAppServerProcess(processKey, proc);
      restorePrefs();
    }

    assert.isFalse(
      requests.some((request) => request.method === "skills/list"),
    );
    const turnStart = requests.find(
      (request) => request.method === "turn/start",
    );
    const turnInput = turnStart?.params.input as Record<string, unknown>[];
    assert.include(JSON.stringify(turnInput), "$external-pdf-workflow");
    assert.isFalse(turnInput.some((input) => input.type === "skill"));
  });

  afterEach(function () {
    resetCodexNativePathSafetyStateForTests();
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

  it("forks a thread with the target conversation's scope header, not the source's", async function () {
    const processKey = "native-fork-scope-header";
    const originalSpawn = CodexAppServerProcess.spawn;
    const originalZotero = (globalThis as { Zotero?: unknown }).Zotero;
    const prefStore = new Map<string, unknown>();
    const writes: string[] = [];
    const proc = CodexAppServerProcess.forTest({
      stdin: {
        write: (chunk: string) => {
          writes.push(chunk);
          const request = JSON.parse(chunk) as {
            id: number;
            method: string;
            params?: Record<string, any>;
          };
          if (request.method !== "thread/fork") return;
          void (async () => {
            const servers = request.params?.config?.mcp_servers as Record<
              string,
              { http_headers?: Record<string, string> }
            >;
            const serverConfig = Object.values(servers || {})[0];
            const response = await invokeRegisteredZoteroMcpEndpoint({
              method: "POST",
              data: {
                jsonrpc: "2.0",
                id: 1,
                method: "tools/list",
                params: {},
              },
              headers: serverConfig?.http_headers,
            });
            const responseBody = JSON.parse(response?.[2] || "{}");
            const handleMessage = (
              proc as unknown as {
                handleMessage: (msg: Record<string, unknown>) => void;
              }
            ).handleMessage.bind(proc);
            if (responseBody.error) {
              handleMessage({ id: request.id, error: responseBody.error });
              return;
            }
            handleMessage({
              id: request.id,
              result: { thread: { id: "thread-forked" } },
            });
          })();
        },
      },
      kill: () => {},
    });
    CodexAppServerProcess.spawn = async () => proc;
    (globalThis as { Zotero?: unknown }).Zotero = {
      Prefs: {
        get: (key: string) => prefStore.get(key),
        set: (key: string, value: unknown) => prefStore.set(key, value),
      },
      Profile: { dir: "/tmp/lfz-fork-scope-profile" },
      DataDirectory: { dir: "/tmp/lfz-fork-scope-data" },
      Server: { Endpoints: {} },
    };
    registerMcpServer({
      toolRegistry: new AgentToolRegistry(),
      zoteroGateway: {} as never,
    });

    try {
      const threadId = await forkCodexAppServerThread({
        threadId: "thread-source",
        targetConversationKey: 6_000_000_311,
        processKey,
        codexPath: "codex",
      });
      assert.equal(threadId, "thread-forked");

      const forkRequest = writes
        .map(
          (chunk) =>
            JSON.parse(chunk) as {
              method: string;
              params: Record<string, any>;
            },
        )
        .find((entry) => entry.method === "thread/fork");
      assert.equal(forkRequest?.params.threadId, "thread-source");

      const servers = forkRequest?.params.config?.mcp_servers as Record<
        string,
        { http_headers?: Record<string, string> }
      >;
      const serverConfig = Object.values(servers || {})[0];
      const sentScopeToken =
        serverConfig?.http_headers?.[ZOTERO_MCP_SCOPE_HEADER];
      const profileSignature = getCodexProfileSignature();
      assert.equal(
        sentScopeToken,
        resolveConversationScopeToken({
          profileSignature,
          conversationKey: 6_000_000_311,
        }),
      );
      assert.notEqual(
        sentScopeToken,
        resolveConversationScopeToken({
          profileSignature,
          conversationKey: 6_000_000_310,
        }),
      );
    } finally {
      unregisterMcpServer();
      CodexAppServerProcess.spawn = originalSpawn;
      destroyCachedCodexAppServerProcess(processKey, proc, {
        codexPath: "codex",
      });
      (globalThis as { Zotero?: unknown }).Zotero = originalZotero;
    }
  });

  it("overrides the inherited MCP server while tools are disabled", async function () {
    const processKey = "native-fork-disabled-scope-header";
    const originalSpawn = CodexAppServerProcess.spawn;
    const originalZotero = (globalThis as { Zotero?: unknown }).Zotero;
    const prefStore = new Map<string, unknown>();
    const writes: string[] = [];
    const proc = CodexAppServerProcess.forTest({
      stdin: {
        write: (chunk: string) => {
          writes.push(chunk);
          const request = JSON.parse(chunk) as { id: number; method: string };
          if (request.method !== "thread/fork") return;
          setTimeout(() => {
            (
              proc as unknown as {
                handleMessage: (msg: Record<string, unknown>) => void;
              }
            ).handleMessage({
              id: request.id,
              result: { thread: { id: "thread-forked-disabled" } },
            });
          }, 0);
        },
      },
      kill: () => {},
    });
    CodexAppServerProcess.spawn = async () => proc;
    (globalThis as { Zotero?: unknown }).Zotero = {
      Prefs: {
        get: (key: string) =>
          key.endsWith(".codexAppServerZoteroMcpToolsEnabled")
            ? false
            : prefStore.get(key),
        set: (key: string, value: unknown) => prefStore.set(key, value),
      },
      Profile: { dir: "/tmp/lfz-fork-disabled-scope-profile" },
      DataDirectory: { dir: "/tmp/lfz-fork-disabled-scope-data" },
      Server: { Endpoints: {} },
    };

    try {
      const threadId = await forkCodexAppServerThread({
        threadId: "thread-source",
        targetConversationKey: 6_000_000_313,
        processKey,
        codexPath: "codex",
      });
      assert.equal(threadId, "thread-forked-disabled");

      const forkRequest = writes
        .map(
          (chunk) =>
            JSON.parse(chunk) as {
              method: string;
              params: Record<string, any>;
            },
        )
        .find((entry) => entry.method === "thread/fork");
      const servers = forkRequest?.params.config?.mcp_servers as Record<
        string,
        {
          enabled?: boolean;
          required?: boolean;
          http_headers?: Record<string, string>;
        }
      >;
      const serverConfig = Object.values(servers || {})[0];
      assert.equal(serverConfig?.enabled, false);
      assert.notProperty(serverConfig || {}, "required");
      assert.equal(
        serverConfig?.http_headers?.[ZOTERO_MCP_SCOPE_HEADER],
        resolveConversationScopeToken({
          profileSignature: getCodexProfileSignature(),
          conversationKey: 6_000_000_313,
        }),
      );
    } finally {
      unregisterMcpServer();
      CodexAppServerProcess.spawn = originalSpawn;
      destroyCachedCodexAppServerProcess(processKey, proc, {
        codexPath: "codex",
      });
      (globalThis as { Zotero?: unknown }).Zotero = originalZotero;
    }
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
    assert.include(manifest, "Zotero MCP is ready");
    assert.include(manifest, "facts or actions absent from context");
    assert.include(manifest, PAPER_CITATION_CONTRACT);
    assert.equal(manifest.split(PAPER_CITATION_CONTRACT).length - 1, 1);
    assert.include(manifest, "verified quote anchors like [[quote:Q_x7a2]]");
    assert.include(
      manifest,
      "Do not call additional tools solely to discover quotes or page numbers",
    );
    assert.notInclude(manifest, "page N");
    assert.notInclude(manifest, "use shell creatively");
  });

  it("replaces ordinary paper retrieval guidance for raw PDF turns", function () {
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
      rawPdfMode: true,
      skillInstructionBlock:
        "Skill: simple-paper-qa\nCall paper_read overview.",
    });

    assert.notInclude(
      manifest,
      "Paper content: use paper_read overview for broad single-paper summaries",
    );
    assert.include(manifest, "Skill: simple-paper-qa");
    assert.match(
      manifest,
      /Raw PDF transport policy[\s\S]*Do not use `paper_read`[\s\S]*$/,
    );
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
    assert.include(block, '"these papers"');
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
    assert.equal(threadResumeParams?.sandbox, "read-only");
    assert.notProperty(threadResumeParams || {}, "persistExtendedHistory");
    assert.notProperty(threadResumeParams || {}, "permissions");
    assert.notProperty(threadResumeParams || {}, "runtimeWorkspaceRoots");
    assert.deepEqual(turnStartParams?.sandboxPolicy, {
      type: "readOnly",
      networkAccess: false,
    });
    assert.notProperty(turnStartParams || {}, "persistExtendedHistory");
    assert.notProperty(turnStartParams || {}, "permissions");
    assert.notProperty(turnStartParams || {}, "runtimeWorkspaceRoots");
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

  it("preserves explicit native skill text alongside structured skill input", async function () {
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
    assert.include(turnStartText, "$write-note");
  });

  it("does not duplicate an explicit skill marker when structured resolution falls back", async function () {
    setUserSkills([parseSkill(BUILTIN_SKILL_FILES["write-note.md"])]);
    const processKey = "native-explicit-skill-fallback-dedupe";
    const requests: Array<{
      method: string;
      params: Record<string, any>;
    }> = [];
    const proc = createNativeLifecycleTestProcess({
      newThreadIds: ["thread-explicit-skill-fallback"],
      requests,
      skillsListResult: { data: [] },
    });
    const originalSpawn = CodexAppServerProcess.spawn;
    const restorePrefs = installDirectPathTestPrefs("native");
    CodexAppServerProcess.spawn = async () => proc;

    try {
      await runCodexAppServerNativeTurn({
        scope: {
          profileSignature: "profile-native-explicit-skill-fallback",
          conversationKey: 6_000_000_034,
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
      destroyCachedCodexAppServerProcess(processKey, proc);
      restorePrefs();
    }

    assert.isTrue(requests.some((request) => request.method === "skills/list"));
    const turnStart = requests.find(
      (request) => request.method === "turn/start",
    );
    const turnStartText = JSON.stringify(turnStart?.params.input);
    assert.equal(turnStartText.split("$write-note").length - 1, 1);
  });

  it("applies a fallback skill marker to the current turn when legacy history contains an older marker", async function () {
    setUserSkills([parseSkill(BUILTIN_SKILL_FILES["write-note.md"])]);
    const processKey = "native-explicit-skill-fallback-current-turn";
    const requests: Array<{
      method: string;
      params: Record<string, any>;
    }> = [];
    const proc = createNativeLifecycleTestProcess({
      newThreadIds: ["thread-explicit-skill-fallback-current-turn"],
      requests,
      skillsListResult: { data: [] },
    });
    proc.setInjectItemsSupport("unsupported");
    const originalSpawn = CodexAppServerProcess.spawn;
    const restorePrefs = installDirectPathTestPrefs("native");
    CodexAppServerProcess.spawn = async () => proc;

    try {
      await runCodexAppServerNativeTurn({
        scope: {
          profileSignature: "profile-native-explicit-skill-fallback-history",
          conversationKey: 6_000_000_035,
          libraryID: 1,
          kind: "global",
        },
        model: "gpt-5.5",
        messages: [
          { role: "user", content: "$write-note\n\nEarlier request." },
          { role: "assistant", content: "Earlier response." },
          { role: "user", content: "Current request." },
        ],
        skillContext: { forcedSkillIds: ["write-note"] },
        hooks: {
          loadProviderSessionId: async () => undefined,
          persistProviderSessionId: async () => undefined,
        },
        processKey,
      });
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      destroyCachedCodexAppServerProcess(processKey, proc);
      restorePrefs();
    }

    const turnStart = requests.find(
      (request) => request.method === "turn/start",
    );
    const textInputs = (turnStart?.params.input || []).filter(
      (entry: Record<string, unknown>) => entry.type === "text",
    );
    const currentUserInput = textInputs.at(-1)?.text as string;
    assert.include(currentUserInput, "User:\nCurrent request.");
    assert.equal(currentUserInput.split("$write-note").length - 1, 1);
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
    assert.notInclude(source, "raw_pdf_read");
    assert.notInclude(source, "stageCodexRawPdfCapability");
    assert.notInclude(source, "isolatedRawPdfMode");
    assert.notInclude(source, "runtimeWorkspaceRoots");
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

    assert.deepEqual(scope.turnPaperScope?.papers, [
      {
        paper: { ...selectedPaper, libraryID: 1 },
        roles: ["selected"],
      },
      {
        paper: { ...fullTextPaper, libraryID: 1, citationKey: undefined },
        roles: ["full_text"],
      },
      {
        paper: { ...pinnedPaper, libraryID: 1, citationKey: undefined },
        roles: ["pinned"],
      },
    ]);
    assert.deepEqual(scope.turnPaperScope?.collections, [
      { collectionId: 9, libraryID: 1, name: "Native Collection" },
    ]);
    assert.deepEqual(scope.turnPaperScope?.tags, [
      {
        name: "Stable",
        normalizedName: "stable",
        libraryID: 1,
        scope: undefined,
        includeAutomatic: undefined,
      },
    ]);
    assert.equal(scope.model, "gpt-5.5");
    assert.equal(scope.codexPath, "/tmp/codex-native");
    assert.equal(scope.exhaustiveReadBackend, "codex_responses");
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
