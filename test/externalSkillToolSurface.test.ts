/**
 * #541: every text an external runtime receives names only tools it can call.
 *
 * Codex reads each shipped SKILL.md directly (native skill mode), Claude Code
 * gets the body through the `load_skill` MCP result (body plus toolGuidance),
 * and both read every `tools/list` description. A tool name in any of them
 * that the same scope's `tools/list` hides sends the model to a tool it does
 * not have; the reporter's review stopped on `task_update`.
 */
import { assert } from "chai";
import {
  BUILTIN_SKILL_FILES,
  getAllSkills,
  setUserSkills,
} from "../src/agent/skills";
import type { AgentSkill } from "../src/agent/skills";
import { parseSkill } from "../src/agent/skills/skillLoader";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import { toolGuidanceItems } from "../src/agent/tools/guidance";
import { IMPORT_TO_LIBRARY_PAGE_GUIDANCE } from "../src/agent/tools/read/webRead";
import {
  getOrCreateZoteroMcpBearerToken,
  registerMcpServer,
  registerScopedZoteroMcpScope,
  unregisterMcpServer,
  ZOTERO_MCP_ENDPOINT_PATH,
  ZOTERO_MCP_SCOPE_HEADER,
} from "../src/agent/mcp/server";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";

type EndpointReply = [number, string, string];

async function invokeMcpEndpoint(params: {
  body: Record<string, unknown>;
  scopeToken: string;
}): Promise<EndpointReply> {
  const EndpointClass = (
    globalThis.Zotero.Server.Endpoints as Record<string, any>
  )[ZOTERO_MCP_ENDPOINT_PATH];
  assert.isFunction(EndpointClass);
  return new EndpointClass().init({
    method: "POST",
    data: params.body,
    headers: {
      Authorization: `Bearer ${getOrCreateZoteroMcpBearerToken()}`,
      [ZOTERO_MCP_SCOPE_HEADER]: params.scopeToken,
    },
  });
}

/**
 * Exact text in which a hidden tool's name is not an instruction to call it.
 * Each entry names the tool, the one source that carries the text, the exact
 * text, and the reason. The text is removed from that source only; the same
 * text in any other source (a skill body, a load_skill result) still counts.
 */
const ALLOWED_MENTIONS: ReadonlyArray<{
  tool: string;
  source: string;
  text: string;
  reason: string;
}> = [
  {
    tool: "literature_review",
    source: "tools/list submit_document description",
    text: '"literature_review"',
    reason:
      "submit_document's documentKind enum value (a document kind, not the tool) in the input schema its MCP description carries",
  },
  {
    tool: "literature_review",
    source: "tools/list literature_search description",
    text: "The literature_review selection card is not available over MCP",
    reason:
      "the literature_search MCP override says the tool is absent (server.ts MCP_TOOL_DESCRIPTION_OVERRIDES)",
  },
];

function stripAllowedMentions(source: string, text: string): string {
  let stripped = text;
  for (const { source: allowedSource, text: allowed } of ALLOWED_MENTIONS) {
    if (allowedSource !== source) continue;
    stripped = stripped.split(allowed).join(" ");
  }
  return stripped;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("every text an external runtime receives names only tools it can call (#541)", function () {
  const originalZotero = globalThis.Zotero;
  let installedSkills: AgentSkill[] = [];

  beforeEach(async function () {
    const prefStore = new Map<string, unknown>();
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      DB: new ChangeJournalTestDb(),
      Prefs: {
        get: (key: string) =>
          key === "httpServer.port" ? 24680 : prefStore.get(key),
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      },
      Libraries: { userLibraryID: 1 },
      getActiveZoteroPane: () => undefined,
      Items: { get: () => null },
      Server: { Endpoints: {} },
    } as unknown as typeof Zotero;
    await initAgentChangeJournal();
    installedSkills = [...getAllSkills()];
    setUserSkills(Object.values(BUILTIN_SKILL_FILES).map(parseSkill));
  });

  afterEach(function () {
    unregisterMcpServer();
    setUserSkills(installedSkills);
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
  });

  // Both embedded runtimes set requestInteraction and their reader backend
  // on every turn that has a Zotero MCP scope (externalBackendBridge.ts for
  // Claude Code, codexAppServer/nativeClient.ts for Codex), so both scopes
  // carry them; the backend lists paper_digest, which the skill names.
  const SCOPES = [
    {
      label: "Codex",
      runtimeAuthority: "codex" as const,
      exhaustiveReadBackend: "codex_responses" as const,
    },
    {
      label: "Claude Code",
      runtimeAuthority: "claude" as const,
      exhaustiveReadBackend: "claude_bridge" as const,
    },
  ];

  for (const { label, runtimeAuthority, exhaustiveReadBackend } of SCOPES) {
    it(`names only listed tools in skill bodies, load_skill results, and tool descriptions (${label})`, async function () {
      const registry = createBuiltInToolRegistry({
        zoteroGateway: {} as never,
        pdfService: {} as never,
        pdfPageService: {} as never,
        retrievalService: {} as never,
      });
      registerMcpServer({
        toolRegistry: registry,
        zoteroGateway: {} as never,
      });
      const scope = registerScopedZoteroMcpScope({
        conversationKey: 54_101,
        libraryID: 1,
        kind: "global",
        runtimeAuthority,
        exhaustiveReadBackend,
        requestInteraction: async () => ({ approved: false }),
      });
      try {
        const listed = JSON.parse(
          (
            await invokeMcpEndpoint({
              scopeToken: scope.token,
              body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
            })
          )[2],
        ).result.tools as Array<{ name: string; description: string }>;
        const listedNames = new Set(listed.map((tool) => tool.name));
        // The issue's own premise: task_update stays internal.
        assert.notInclude([...listedNames], "task_update");
        assert.include([...listedNames], "load_skill");
        assert.include([...listedNames], "request_user_input");
        assert.include([...listedNames], "paper_digest");

        const texts: Array<{ source: string; text: string }> = [];
        for (const [file, raw] of Object.entries(BUILTIN_SKILL_FILES)) {
          texts.push({ source: `${file} (as Codex reads it)`, text: raw });
        }
        for (const raw of Object.values(BUILTIN_SKILL_FILES)) {
          const id = parseSkill(raw).id;
          const reply = JSON.parse(
            (
              await invokeMcpEndpoint({
                scopeToken: scope.token,
                body: {
                  jsonrpc: "2.0",
                  id: 2,
                  method: "tools/call",
                  params: { name: "load_skill", arguments: { id } },
                },
              })
            )[2],
          );
          const content = JSON.parse(reply.result.content[0].text);
          assert.isTrue(content.ok, JSON.stringify(content));
          assert.isTrue(content.result.found, id);
          texts.push({
            source: `load_skill ${id}`,
            text: [content.result.instructions, content.result.toolGuidance]
              .filter(Boolean)
              .join("\n\n"),
          });
        }
        for (const tool of listed) {
          texts.push({
            source: `tools/list ${tool.name} description`,
            text: tool.description,
          });
        }

        const registryNames = registry
          .listToolDefinitions()
          .map((tool) => tool.spec.name);
        const hidden: string[] = [];
        for (const { source, text } of texts) {
          const searchable = stripAllowedMentions(source, text);
          for (const name of registryNames) {
            if (listedNames.has(name)) continue;
            if (new RegExp(`\\b${escapeRegExp(name)}\\b`).test(searchable)) {
              hidden.push(`${source} names ${name}`);
            }
          }
        }
        assert.deepEqual(hidden, []);

        // Skill-tied guidance lives on MCP-hidden tools, so none of it
        // reaches a tools/list description (MCP appends guidance unmatched).
        for (const name of ["task_update", "context_read"]) {
          const items = toolGuidanceItems(registry.getTool(name)?.guidance);
          assert.isNotEmpty(items, name);
          for (const { instruction } of items) {
            for (const tool of listed) {
              assert.notInclude(tool.description, instruction, tool.name);
            }
          }
        }
      } finally {
        scope.clear();
      }
    });
  }

  it("moves the import skill's web_read page step into web_read's guidance", function () {
    const body = parseSkill(
      BUILTIN_SKILL_FILES["import-cited-reference.md"],
    ).instruction;
    assert.include(
      body,
      "Never pass a page URL: open the page if needed, take its DOI or arXiv ID, and import that identifier.",
    );
    const registry = createBuiltInToolRegistry({
      zoteroGateway: {} as never,
      pdfService: {} as never,
      pdfPageService: {} as never,
      retrievalService: {} as never,
    });
    assert.deepEqual(
      toolGuidanceItems(registry.getTool("web_read")?.guidance),
      [IMPORT_TO_LIBRARY_PAGE_GUIDANCE],
    );
    assert.include(
      IMPORT_TO_LIBRARY_PAGE_GUIDANCE.instruction,
      "open the page with `web_read` if needed, take its DOI or arXiv ID, and import that identifier",
    );
    const request = { forcedSkillIds: [] } as never;
    assert.isTrue(
      IMPORT_TO_LIBRARY_PAGE_GUIDANCE.matches(request, {
        matchedSkillIds: ["import-to-library"],
      }),
    );
    assert.isFalse(
      IMPORT_TO_LIBRARY_PAGE_GUIDANCE.matches(request, { matchedSkillIds: [] }),
    );
  });

  it("keeps every allowlisted mention exact: each still occurs in a text it excuses", async function () {
    const registry = createBuiltInToolRegistry({
      zoteroGateway: {} as never,
      pdfService: {} as never,
      pdfPageService: {} as never,
      retrievalService: {} as never,
    });
    registerMcpServer({ toolRegistry: registry, zoteroGateway: {} as never });
    const scope = registerScopedZoteroMcpScope({
      conversationKey: 54_102,
      libraryID: 1,
      kind: "global",
      runtimeAuthority: "codex",
      requestInteraction: async () => ({ approved: false }),
    });
    try {
      const listed = JSON.parse(
        (
          await invokeMcpEndpoint({
            scopeToken: scope.token,
            body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
          })
        )[2],
      ).result.tools as Array<{ name: string; description: string }>;
      for (const { tool, source, text, reason } of ALLOWED_MENTIONS) {
        const carrier = listed.find(
          (entry) => `tools/list ${entry.name} description` === source,
        );
        assert.isDefined(carrier, `${tool}: no ${source}`);
        assert.include(carrier!.description, text, `${tool}: ${reason}`);
      }
    } finally {
      scope.clear();
    }
  });
});
