import { assert } from "chai";
import {
  BUILTIN_SKILL_FILES,
  getAllSkills,
  parseSkill,
  setUserSkills,
  type AgentSkill,
} from "../src/agent/skills";
import type {
  AgentEvent,
  AgentModelMessage,
  AgentRuntimeRequestInput,
} from "../src/agent/types";
import type {
  AgentModelStep,
  AgentStepParams,
} from "../src/agent/model/adapter";
import { AgentRuntime } from "../src/agent/runtime";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import { NOTE_WRITE_GUIDANCE } from "../src/agent/tools/write/noteWrite";
import type { AgentToolContext } from "../src/agent/types";
import { resolveAgentRuntimeRequest } from "../src/agent/context/resolvedAgentRequest";
import { renderAgentPromptEnvelope } from "../src/agent/model/messageBuilder";
import { installMockDb } from "./helpers/agentRuntimeMockDb";

/**
 * Skill guidance never costs a model request. A turn renders a skill body only
 * when the user forced it or an approved plan pinned it; otherwise the model
 * sees the installed inventory and calls load_skill itself.
 */

const SHIPPED_SKILL_IDS = [
  "analyze-figures",
  "compare-papers",
  "evidence-based-qa",
  "import-to-library",
  "library-analysis",
  "literature-review",
  "reorganize-library",
  "write-note",
];

type ToolkitGlobal = typeof globalThis & { ztoolkit?: unknown };

function promptText(messages: AgentModelMessage[]): string {
  return messages
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("\n"),
    )
    .join("\n");
}

/**
 * Runs one turn against a model that answers on its first request, counting
 * every HTTP request (the utility model's only transport) and every main-model
 * request.
 */
async function runOneTurn(request: Partial<AgentRuntimeRequestInput>): Promise<{
  httpRequests: number;
  httpRequestsBeforeFirstStep: number;
  modelRequests: number;
  prompt: string;
  loadedSkillIds: string[];
  events: AgentEvent[];
}> {
  const scope = globalThis as ToolkitGlobal;
  const originalToolkit = scope.ztoolkit;
  let httpRequests = 0;
  let httpRequestsBeforeFirstStep = -1;
  let modelRequests = 0;
  let prompt = "";
  let loadedSkillIds: string[] = [];
  const events: AgentEvent[] = [];
  scope.ztoolkit = {
    log: () => undefined,
    getGlobal: (name: string) => {
      if (name !== "fetch")
        return (globalThis as Record<string, unknown>)[name];
      return async () => {
        httpRequests += 1;
        throw new Error("no network in unit tests");
      };
    },
  };
  const restoreDb = installMockDb();
  try {
    const runtime = new AgentRuntime({
      registry: new AgentToolRegistry(),
      adapterFactory: () => ({
        getCapabilities: () => ({
          streaming: false,
          toolCalls: true,
          multimodal: false,
        }),
        supportsTools: () => true,
        async runStep(params: AgentStepParams): Promise<AgentModelStep> {
          modelRequests += 1;
          if (modelRequests === 1) {
            httpRequestsBeforeFirstStep = httpRequests;
            prompt = promptText(params.messages);
            loadedSkillIds = (params.request.loadedSkillRecords || []).map(
              (record) => record.id,
            );
          }
          return {
            kind: "final",
            text: "Done.",
            assistantMessage: { role: "assistant", content: "Done." },
          };
        },
      }),
    });
    await runtime.runTurn({
      request: {
        conversationKey: 93_001,
        libraryID: 1,
        mode: "agent",
        userText: "Summarize this paper.",
        // A configured model, so a utility call would really be attempted.
        model: "gpt-5.4",
        apiKey: "test",
        apiBase: "https://example.invalid/v1",
        ...request,
      },
      onEvent: (event) => {
        events.push(event);
      },
    });
  } finally {
    restoreDb();
    scope.ztoolkit = originalToolkit;
  }
  return {
    httpRequests,
    httpRequestsBeforeFirstStep,
    modelRequests,
    prompt,
    loadedSkillIds,
    events,
  };
}

describe("skill routing without a model call", function () {
  let installedSkills: AgentSkill[] = [];

  beforeEach(function () {
    installedSkills = [...getAllSkills()];
    setUserSkills(
      Object.values(BUILTIN_SKILL_FILES).map((raw) => parseSkill(raw)),
    );
  });

  afterEach(function () {
    setUserSkills(installedSkills);
  });

  it("answers an ordinary single-paper turn with one model request and no skill block", async function () {
    const turn = await runOneTurn({
      selectedPaperContexts: [
        { itemId: 10, contextItemId: 11, title: "Paper" },
      ],
    });

    assert.equal(turn.httpRequestsBeforeFirstStep, 0, "no utility request");
    assert.equal(turn.httpRequests, 0);
    assert.equal(turn.modelRequests, 1);
    assert.deepEqual(turn.loadedSkillIds, []);
    assert.notInclude(turn.prompt, "### Skill:");
    assert.notInclude(turn.prompt, "Active skills for this turn");
    assert.isFalse(
      turn.events.some(
        (event) =>
          event.type === "provider_event" &&
          event.providerType === "agent_skill_selection",
      ),
    );
    assert.isFalse(
      turn.events.some(
        (event) =>
          event.type === "status" && event.text.startsWith("Skill activated"),
      ),
    );
  });

  it("renders the write-note block for a forced $write-note turn", async function () {
    const turn = await runOneTurn({
      userText: "$write-note\n\nSave a summary of this paper as a note.",
      forcedSkillIds: ["write-note"],
      selectedPaperContexts: [
        { itemId: 10, contextItemId: 11, title: "Paper" },
      ],
    });

    assert.equal(turn.httpRequests, 0);
    assert.equal(turn.modelRequests, 1);
    assert.deepEqual(turn.loadedSkillIds, ["write-note"]);
    assert.include(turn.prompt, "### Skill: write-note");
    assert.include(turn.prompt, "Activation: explicit slash selection");
    assert.notInclude(turn.prompt, "### Skill: evidence-based-qa");
  });

  it("lists the shipped skills, without the retired one, as a load_skill inventory", async function () {
    setUserSkills([
      ...getAllSkills(),
      parseSkill(
        [
          "---",
          "id: slash-only",
          "description: A workflow the user applies only from the slash menu",
          "version: 1",
          "activation: manual",
          "---",
          "Slash-only instructions.",
        ].join("\n"),
      ),
    ]);
    const request = resolveAgentRuntimeRequest({
      conversationKey: 1,
      mode: "agent",
      userText: "Summarize this paper.",
      libraryID: 1,
    });
    const rendered = await renderAgentPromptEnvelope(request, [], []);
    const line = rendered.inventory.fixedPrompt
      .split("\n")
      .find((entry) => entry.startsWith("Installed skill inventory"));
    assert.isString(line);
    assert.include(line, "call load_skill");
    assert.notInclude(line, "automatic selection");
    // Skills are multi-step playbooks; an ordinary paper question needs none.
    assert.include(line, "workflow playbooks for multi-step tasks");
    assert.include(line, "ordinary paper questions need no skill");
    const inventory = JSON.parse(
      (line as string).slice((line as string).indexOf("["), line!.length),
    ) as Array<Record<string, unknown>>;
    assert.deepEqual(
      inventory.map((entry) => entry.id),
      SHIPPED_SKILL_IDS,
    );
    for (const entry of inventory) {
      assert.deepEqual(Object.keys(entry), ["id", "description"]);
    }
    assert.notInclude(line, "simple-paper-qa");
    assert.notInclude(line, "slash-only");
  });

  it("points note_write at the write-note skill in its model-facing description", function () {
    const registry = createBuiltInToolRegistry({
      zoteroGateway: {} as never,
      pdfService: {} as never,
      pdfPageService: {} as never,
      retrievalService: {} as never,
    });
    const noteWrite = registry
      .listTools()
      .find((tool) => tool.name === "note_write");
    assert.isDefined(noteWrite);
    assert.match(
      noteWrite!.description,
      / First call load_skill\('write-note'\)\.$/,
    );
  });

  describe("load_skill returns the tool guidance tied to the skill", function () {
    function loadSkillIn(
      request: ReturnType<typeof resolveAgentRuntimeRequest>,
    ) {
      const registry = createBuiltInToolRegistry({
        zoteroGateway: {} as never,
        pdfService: {} as never,
        pdfPageService: {} as never,
        retrievalService: {} as never,
      });
      const tool = registry.getTool("load_skill")!;
      const context = { request } as unknown as AgentToolContext;
      return async () =>
        (await tool.execute({ id: "write-note" }, context)) as Record<
          string,
          unknown
        >;
    }

    it("appends NOTE_WRITE_GUIDANCE when write-note is loaded on an ordinary turn, once per turn", async function () {
      const request = resolveAgentRuntimeRequest({
        conversationKey: 1,
        mode: "agent",
        userText: "Save a summary of this paper as a note.",
        libraryID: 1,
      });
      const load = loadSkillIn(request);
      const first = await load();
      assert.isTrue(first.found);
      assert.isString(first.toolGuidance);
      assert.match(
        first.toolGuidance as string,
        /^Tool guidance for this skill:\n\n/,
      );
      assert.include(
        first.toolGuidance as string,
        NOTE_WRITE_GUIDANCE.instruction,
      );
      const again = await load();
      assert.notProperty(again, "toolGuidance");
    });

    it("does not repeat guidance the system prompt already rendered on a $write-note turn", async function () {
      const request = resolveAgentRuntimeRequest({
        conversationKey: 1,
        mode: "agent",
        userText: "$write-note\n\nSave a summary of this paper as a note.",
        forcedSkillIds: ["write-note"],
        libraryID: 1,
      });
      const result = await loadSkillIn(request)();
      assert.isTrue(result.found);
      assert.notProperty(result, "toolGuidance");
    });

    it("omits guidance for tools the calling client cannot see (MCP profile)", async function () {
      const registry = createBuiltInToolRegistry({
        zoteroGateway: {} as never,
        pdfService: {} as never,
        pdfPageService: {} as never,
        retrievalService: {} as never,
      });
      const request = resolveAgentRuntimeRequest({
        conversationKey: 1,
        mode: "agent",
        userText: "Save a note.",
        libraryID: 1,
      });
      const result = (await registry
        .getTool("load_skill")!
        .execute({ id: "write-note" }, {
          request,
          // Both tools the write-note guidance lives on are MCP-hidden.
          isToolVisible: (spec: { name: string }) =>
            !["note_write", "context_read"].includes(spec.name),
        } as unknown as AgentToolContext)) as Record<string, unknown>;
      assert.isTrue(result.found);
      assert.notProperty(result, "toolGuidance");
    });

    it("adds nothing for a skill no tool guidance is tied to", async function () {
      const registry = createBuiltInToolRegistry({
        zoteroGateway: {} as never,
        pdfService: {} as never,
        pdfPageService: {} as never,
        retrievalService: {} as never,
      });
      const request = resolveAgentRuntimeRequest({
        conversationKey: 1,
        mode: "agent",
        userText: "Compare these papers.",
        libraryID: 1,
      });
      const result = (await registry
        .getTool("load_skill")!
        .execute({ id: "compare-papers" }, {
          request,
        } as unknown as AgentToolContext)) as Record<string, unknown>;
      assert.isTrue(result.found);
      assert.notProperty(result, "toolGuidance");
    });
  });
  it("returns guidance that became applicable after the render, once", async function () {
    const registry = createBuiltInToolRegistry({
      zoteroGateway: {} as never,
      pdfService: {} as never,
      pdfPageService: {} as never,
      retrievalService: {} as never,
    });
    const request = resolveAgentRuntimeRequest({
      conversationKey: 1,
      mode: "agent",
      userText: "Compare these papers.",
      libraryID: 1,
    });
    const rendered = await renderAgentPromptEnvelope(
      request,
      registry.listToolDefinitionsForRequest(request),
      [],
    );
    // What the runtime records after rendering.
    request.deliveredToolGuidance = [
      ...rendered.inventory.toolGuidanceInstructions,
    ];
    assert.notInclude(
      request.deliveredToolGuidance,
      NOTE_WRITE_GUIDANCE.instruction,
    );
    // Loading the note skill mid-turn makes the note guidance applicable.
    const loadSkill = registry.getTool("load_skill")!;
    const context = { request } as unknown as AgentToolContext;
    const first = (await loadSkill.execute(
      { id: "write-note" },
      context,
    )) as Record<string, unknown>;
    assert.include(
      first.toolGuidance as string,
      NOTE_WRITE_GUIDANCE.instruction,
    );
    const second = (await loadSkill.execute(
      { id: "write-note" },
      context,
    )) as Record<string, unknown>;
    assert.notProperty(second, "toolGuidance");
  });
});
