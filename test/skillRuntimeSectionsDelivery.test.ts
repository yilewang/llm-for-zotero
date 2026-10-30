/**
 * Each runtime reads only its own runtime sections of a skill body
 * (runtimeSections.ts): the plugin's own Agent none, Claude Code the
 * `claude_code` section, Codex the `codex` section. No delivered text holds
 * a marker. No shipped skill has a runtime section yet, so these tests
 * install a fixture skill that has one per runtime.
 *
 * In Codex's native skill mode Codex reads a SKILL.md from disk itself; it
 * reads the Codex-only copy the projection writes (codexSkillProjection.ts),
 * whose registration and selection codexSkillProjectionProtocol.test.ts
 * covers.
 */
import { assert } from "chai";
import {
  BUILTIN_SKILL_FILES,
  getAllSkills,
  setUserSkills,
} from "../src/agent/skills";
import type { AgentSkill } from "../src/agent/skills";
import { parseSkill } from "../src/agent/skills/skillLoader";
import { hasSkillRuntimeMarker } from "../src/agent/skills/runtimeSections";
import { syncCodexSkillProjections } from "../src/agent/skills/codexSkillProjection";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import { buildAgentInitialMessages } from "../src/agent/model/messageBuilder";
import { buildCodexNativeSkillInstructionBlock } from "../src/codexAppServer/nativeSkills";
import {
  getOrCreateZoteroMcpBearerToken,
  registerMcpServer,
  registerScopedZoteroMcpScope,
  unregisterMcpServer,
  ZOTERO_MCP_ENDPOINT_PATH,
  ZOTERO_MCP_SCOPE_HEADER,
} from "../src/agent/mcp/server";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import type { AgentModelMessage, AgentToolContext } from "../src/agent/types";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";
import {
  CLAUDE_SECTION_NAME as CLAUDE_NAME,
  CODEX_SECTION_NAME as CODEX_NAME,
  RUNTIME_SECTION_SKILL_ID as SKILL_ID,
  RUNTIME_SECTION_SKILL_RAW,
} from "./helpers/runtimeSectionSkillFixture";

/** Body lines outside every runtime section: each runtime reads them. */
const SHARED_LINES = [
  "Read the papers the user names and answer from them.",
  "Cite every claim you take from a paper.",
];

function newRegistry() {
  return createBuiltInToolRegistry({
    zoteroGateway: {} as never,
    pdfService: {} as never,
    pdfPageService: {} as never,
    retrievalService: {} as never,
  });
}

function messageText(message: AgentModelMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

function originalAgentRequest() {
  return resolvedAgentRequest({
    conversationKey: 54_401,
    mode: "agent",
    userText: "Review these papers.",
    libraryID: 1,
    model: "test-model",
    executionContext: {
      version: 1,
      executionId: "execution-b4",
      conversationKey: 54_401,
      conversationGeneration: 0,
      chatLibraryID: 1,
      permissionOwner: "original_agent",
      workspaceSnapshot: { selectedPapers: [], selectedCollections: [] },
      configuredAccess: { libraryIDs: [1], outputDirectories: [] },
    },
  });
}

async function mcpCall(
  scopeToken: string,
  body: Record<string, unknown>,
): Promise<any> {
  const EndpointClass = (
    globalThis.Zotero.Server.Endpoints as Record<string, any>
  )[ZOTERO_MCP_ENDPOINT_PATH];
  const reply = await new EndpointClass().init({
    method: "POST",
    data: body,
    headers: {
      Authorization: `Bearer ${getOrCreateZoteroMcpBearerToken()}`,
      [ZOTERO_MCP_SCOPE_HEADER]: scopeToken,
    },
  });
  return JSON.parse(reply[2]);
}

/** What an external runtime reads over MCP: load_skill and tools/list. */
async function externalTexts(
  runtimeAuthority: "claude" | "codex",
): Promise<{ skill: string; tools: string }> {
  registerMcpServer({
    toolRegistry: newRegistry(),
    zoteroGateway: {} as never,
  });
  const scope = registerScopedZoteroMcpScope({
    conversationKey: runtimeAuthority === "claude" ? 54_402 : 54_403,
    libraryID: 1,
    kind: "global",
    runtimeAuthority,
    requestInteraction: async () => ({ approved: false }),
  });
  try {
    const loaded = await mcpCall(scope.token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "load_skill", arguments: { id: SKILL_ID } },
    });
    const content = JSON.parse(loaded.result.content[0].text);
    assert.isTrue(content.result.found, JSON.stringify(content));
    const listed = await mcpCall(scope.token, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    return {
      skill: [content.result.instructions, content.result.toolGuidance]
        .filter(Boolean)
        .join("\n\n"),
      tools: (listed.result.tools as Array<{ description: string }>)
        .map((tool) => tool.description)
        .join("\n\n"),
    };
  } finally {
    scope.clear();
    unregisterMcpServer();
  }
}

describe("runtime sections reach only their own runtime", function () {
  const originalZotero = globalThis.Zotero;
  let installed: AgentSkill[] = [];

  beforeEach(async function () {
    const prefs = new Map<string, unknown>();
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      DB: new ChangeJournalTestDb(),
      Prefs: {
        get: (key: string) =>
          key === "httpServer.port" ? 24680 : prefs.get(key),
        set: (key: string, value: unknown) => {
          prefs.set(key, value);
        },
      },
      Libraries: { userLibraryID: 1 },
      getActiveZoteroPane: () => undefined,
      Items: { get: () => null },
      Server: { Endpoints: {} },
    } as unknown as typeof Zotero;
    await initAgentChangeJournal();
    installed = [...getAllSkills()];
    setUserSkills([
      ...Object.values(BUILTIN_SKILL_FILES).map(parseSkill),
      parseSkill(RUNTIME_SECTION_SKILL_RAW),
    ]);
  });

  afterEach(function () {
    setUserSkills(installed);
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
  });

  it("ships no skill with a runtime section, so the mechanism is dormant", function () {
    // A shipped skill that adds one makes Codex write its own copies
    // (codexSkillProjection.ts); update this test when one does.
    for (const [file, raw] of Object.entries(BUILTIN_SKILL_FILES))
      assert.isFalse(hasSkillRuntimeMarker(raw), file);
    assert.isTrue(hasSkillRuntimeMarker(RUNTIME_SECTION_SKILL_RAW));
  });

  it("gives the plugin's own Agent no section", async function () {
    const registry = newRegistry();
    const request = originalAgentRequest();
    const prompt = (
      await buildAgentInitialMessages(
        request,
        registry.listToolDefinitionsForRequest(request),
        [SKILL_ID],
      )
    )
      .map(messageText)
      .join("\n");
    const loaded = (await registry
      .getTool("load_skill")!
      .execute({ id: SKILL_ID }, {
        request,
      } as unknown as AgentToolContext)) as {
      instructions: string;
      toolGuidance?: string;
    };
    for (const [label, text] of [
      ["prompt", prompt],
      ["load_skill", `${loaded.instructions}\n${loaded.toolGuidance || ""}`],
    ]) {
      for (const line of SHARED_LINES) assert.include(text, line, label);
      assert.notInclude(text, CLAUDE_NAME, label);
      assert.notInclude(text, CODEX_NAME, label);
      // review_coverage is MCP-only: the plugin Agent must not be told to use it.
      assert.notInclude(text, "review_coverage", label);
      assert.isFalse(hasSkillRuntimeMarker(text), label);
    }
  });

  it("gives Claude Code its section and not Codex's", async function () {
    const { skill, tools } = await externalTexts("claude");
    for (const line of SHARED_LINES) assert.include(skill, line);
    assert.include(skill, `\`${CLAUDE_NAME}\` subagent`);
    assert.include(skill, "`review_coverage`");
    assert.notInclude(skill, CODEX_NAME);
    assert.notInclude(tools, CODEX_NAME);
    assert.isFalse(hasSkillRuntimeMarker(skill));
    assert.isFalse(hasSkillRuntimeMarker(tools));
  });

  it("gives Codex its section and not Claude Code's", async function () {
    const { skill, tools } = await externalTexts("codex");
    const block = buildCodexNativeSkillInstructionBlock([SKILL_ID]);
    for (const [label, text] of [
      ["load_skill", skill],
      ["instruction block", block],
    ]) {
      for (const line of SHARED_LINES) assert.include(text, line, label);
      assert.include(
        text,
        "These skill instructions explicitly ask for sub-agents",
        label,
      );
      assert.include(text, `\`${CODEX_NAME}\``, label);
      assert.include(text, "`review_coverage`", label);
      assert.notInclude(text, CLAUDE_NAME, label);
      assert.isFalse(hasSkillRuntimeMarker(text), label);
    }
    assert.notInclude(tools, CLAUDE_NAME);
    assert.isFalse(hasSkillRuntimeMarker(tools));
  });

  it("gives Codex's native mode a file with its section and not Claude Code's", async function () {
    const canonical = `/skills/${SKILL_ID}/SKILL.md`;
    const files: Record<string, string> = {
      [canonical]: RUNTIME_SECTION_SKILL_RAW,
    };
    const result = await syncCodexSkillProjections({
      canonicalDir: "/skills",
      projectionDir: "/codex-skills",
      io: {
        // Only the canonical folder exists; no copy was written before.
        exists: async (path) => path === "/skills",
        read: async (path) => {
          if (!(path in files)) throw new Error("missing");
          return new TextEncoder().encode(files[path]);
        },
        write: async (path, data) => {
          files[path] = new TextDecoder().decode(data);
          return data.length;
        },
        makeDirectory: async () => undefined,
        getChildren: async () => [`/skills/${SKILL_ID}`],
        remove: async () => undefined,
      },
    });
    assert.deepEqual(
      result.projections.map((entry) => entry.skillId),
      [SKILL_ID],
    );
    const projected = files[`/codex-skills/${SKILL_ID}/SKILL.md`];
    for (const line of SHARED_LINES) assert.include(projected, line);
    assert.include(projected, `\`${CODEX_NAME}\``);
    assert.include(projected, "`review_coverage`");
    assert.notInclude(projected, CLAUDE_NAME);
    assert.isFalse(hasSkillRuntimeMarker(projected));
    assert.equal(
      parseSkill(projected).version,
      parseSkill(RUNTIME_SECTION_SKILL_RAW).version,
    );
  });
});
