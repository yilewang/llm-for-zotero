/**
 * A tool may carry one guidance or a list of them. Each item keeps its own
 * `matches` and `instruction`, and every reader (the prompt, load_skill, the
 * MCP description) matches and renders each item alone; a single guidance
 * behaves exactly as before.
 */
import { assert } from "chai";
import { buildAgentInitialMessages } from "../src/agent/model/messageBuilder";
import { createLoadSkillTool } from "../src/agent/tools/read/loadSkill";
import { skillGuidance, toolGuidanceItems } from "../src/agent/tools/guidance";
import type {
  AgentModelMessage,
  AgentToolContext,
  AgentToolDefinition,
  AgentToolGuidance,
} from "../src/agent/types";
import type { AgentSkill } from "../src/agent/skills";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

function messageText(message: AgentModelMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

function toolWith(
  name: string,
  guidance: AgentToolDefinition["guidance"],
): AgentToolDefinition<unknown, unknown> {
  return {
    spec: {
      name,
      description: `Tool ${name}`,
      inputSchema: { type: "object", additionalProperties: false },
      executionClass: "read",
      workCategory: "retrieval",
    },
    guidance,
    validate: (args) => ({ ok: true, value: args }),
    execute: async () => ({}),
  };
}

function skill(id: string): AgentSkill {
  return {
    id,
    description: `Skill ${id}`,
    version: 1,
    contexts: ["any"],
    activation: "auto",
    instruction: `Body of ${id}.`,
    source: "system",
  } as AgentSkill;
}

const ALPHA = skillGuidance("alpha", "Alpha-only rule for the tool.");
const BETA = skillGuidance("beta", "Beta-only rule for the tool.");
const ALWAYS: AgentToolGuidance = {
  matches: () => true,
  instruction: "Always-on single guidance.",
};

async function renderedPrompt(
  tools: AgentToolDefinition<any, any>[],
  matchedSkillIds: string[],
): Promise<string> {
  const messages = await buildAgentInitialMessages(
    resolvedAgentRequest({
      conversationKey: 54_201,
      mode: "agent",
      libraryID: 1,
      userText: "Do the work.",
      model: "test-model",
    }),
    tools,
    matchedSkillIds,
  );
  return messages.map(messageText).join("\n");
}

describe("tool guidance as one item or a list", function () {
  it("turns either shape into a list", function () {
    assert.deepEqual(toolGuidanceItems(undefined), []);
    assert.deepEqual(toolGuidanceItems(ALWAYS), [ALWAYS]);
    assert.deepEqual(toolGuidanceItems([ALPHA, BETA]), [ALPHA, BETA]);
  });

  it("matches a skill guidance by the matched or the forced skill, as note_write does", function () {
    const request = resolvedAgentRequest({
      conversationKey: 54_202,
      mode: "agent",
      userText: "x",
    });
    assert.isFalse(ALPHA.matches(request, { matchedSkillIds: [] }));
    assert.isTrue(ALPHA.matches(request, { matchedSkillIds: ["alpha"] }));
    assert.isFalse(ALPHA.matches(request, { matchedSkillIds: ["beta"] }));
    assert.isTrue(
      ALPHA.matches(
        resolvedAgentRequest({
          conversationKey: 54_202,
          mode: "agent",
          userText: "$alpha x",
          forcedSkillIds: ["alpha"],
        }),
        { matchedSkillIds: [] },
      ),
    );
  });

  it("renders a single guidance in the prompt as before", async function () {
    const prompt = await renderedPrompt([toolWith("one", ALWAYS)], []);
    assert.include(prompt, "Always-on single guidance.");
  });

  it("renders only the list items that match the turn's skills", async function () {
    const tools = [toolWith("many", [ALPHA, BETA])];
    const none = await renderedPrompt(tools, []);
    assert.notInclude(none, ALPHA.instruction);
    assert.notInclude(none, BETA.instruction);
    const alpha = await renderedPrompt(tools, ["alpha"]);
    assert.include(alpha, ALPHA.instruction);
    assert.notInclude(alpha, BETA.instruction);
    const both = await renderedPrompt(tools, ["alpha", "beta"]);
    assert.include(both, ALPHA.instruction);
    assert.include(both, BETA.instruction);
  });

  it("returns only the loaded skill's list item from load_skill, and nothing for a hidden tool", async function () {
    const tools = [toolWith("many", [ALPHA, BETA]), toolWith("one", ALWAYS)];
    const loadSkill = createLoadSkillTool({
      getSkills: () => [skill("alpha"), skill("beta")],
      getShippedInstruction: () => undefined,
      getToolDefinitions: () => tools,
    });
    const request = resolvedAgentRequest({
      conversationKey: 54_203,
      mode: "agent",
      userText: "Do the work.",
    });
    const loaded = (await loadSkill.execute({ id: "alpha" }, {
      request,
    } as unknown as AgentToolContext)) as { toolGuidance?: string };
    assert.include(loaded.toolGuidance || "", ALPHA.instruction);
    assert.notInclude(loaded.toolGuidance || "", BETA.instruction);
    // Always-on guidance is not tied to the skill.
    assert.notInclude(loaded.toolGuidance || "", ALWAYS.instruction);

    const hidden = (await loadSkill.execute({ id: "beta" }, {
      request: resolvedAgentRequest({
        conversationKey: 54_204,
        mode: "agent",
        userText: "Do the work.",
      }),
      isToolVisible: (spec: { name: string }) => spec.name !== "many",
    } as unknown as AgentToolContext)) as { toolGuidance?: string };
    assert.notProperty(hidden, "toolGuidance");
  });
});
