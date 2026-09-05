import { assert } from "chai";
import { AGENT_PERSONA_INSTRUCTIONS } from "../src/agent/model/agentPersona";
import { buildAgentInitialMessages } from "../src/agent/model/messageBuilder";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import type {
  AgentRuntimeRequest,
  AgentRuntimeRequestInput,
  AgentToolDefinition,
} from "../src/agent/types";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

function registry() {
  return createBuiltInToolRegistry({
    zoteroGateway: {} as never,
    pdfService: {} as never,
    pdfPageService: {} as never,
    retrievalService: {} as never,
  });
}

function request(
  userText: string,
  externalSearchIntent?: NonNullable<
    AgentRuntimeRequestInput["classifiedIntent"]
  >["externalSearchIntent"],
): AgentRuntimeRequest {
  return resolvedAgentRequest({
    conversationKey: Math.floor(Math.random() * 1_000_000),
    mode: "agent",
    userText,
    libraryID: 1,
    ...(externalSearchIntent
      ? {
          classifiedIntent: {
            retrievalIntent: "none",
            externalSearchIntent,
            wantedSections: [],
            actionIntents: [],
          },
        }
      : {}),
  });
}

function guidanceTools(): {
  web: AgentToolDefinition<any, any>;
  literature: AgentToolDefinition<any, any>;
} {
  const tools = registry();
  const web = tools.getTool("web_search");
  const literature = tools.getTool("literature_search");
  assert.exists(web);
  assert.exists(literature);
  return { web: web!, literature: literature! };
}

function guidanceMatches(
  tool: AgentToolDefinition<any, any>,
  value: AgentRuntimeRequest,
): boolean {
  return tool.guidance?.matches(value) || false;
}

function userMessageText(
  messages: Awaited<ReturnType<typeof buildAgentInitialMessages>>,
): string {
  const content = messages[messages.length - 1]?.content;
  return typeof content === "string" ? content : "";
}

describe("external search guidance routing", function () {
  it("routes every classified intent independently of the user language", function () {
    const { web, literature } = guidanceTools();
    const cases = [
      {
        intent: "none" as const,
        text: "Explique la diferencia entre correlación y causalidad.",
        web: false,
        literature: false,
      },
      {
        intent: "web" as const,
        text: "¿Quién ocupa actualmente este cargo?",
        web: true,
        literature: false,
      },
      {
        intent: "literature" as const,
        text: "查找有关表征漂移的最新论文。",
        web: false,
        literature: true,
      },
      {
        intent: "both" as const,
        text: "查找相关论文，并与当前官方文档进行比较。",
        web: true,
        literature: true,
      },
    ];

    for (const entry of cases) {
      const value = request(entry.text, entry.intent);
      assert.equal(guidanceMatches(web, value), entry.web);
      assert.equal(guidanceMatches(literature, value), entry.literature);
    }
  });

  it("uses narrow English fallback matching when classification is absent", function () {
    const { web, literature } = guidanceTools();
    const cases = [
      {
        text: "Search the web for the latest Zotero release notes",
        web: true,
        literature: false,
      },
      {
        text: "Find recent papers about representational drift",
        web: false,
        literature: true,
      },
      {
        text: "Find recent papers and verify the official documentation online",
        web: true,
        literature: true,
      },
      {
        text: "Summarize the current paper",
        web: false,
        literature: false,
      },
      {
        text: "Improve this product documentation paragraph",
        web: false,
        literature: false,
      },
      {
        text: "Explain the difference between correlation and causation",
        web: false,
        literature: false,
      },
    ];

    for (const entry of cases) {
      const value = request(entry.text);
      assert.equal(
        guidanceMatches(web, value),
        entry.web,
        `web fallback for: ${entry.text}`,
      );
      assert.equal(
        guidanceMatches(literature, value),
        entry.literature,
        `literature fallback for: ${entry.text}`,
      );
    }
  });

  it("injects one or both guidance blocks from classified multilingual intent", async function () {
    const { web, literature } = guidanceTools();
    const webInstruction = web.guidance!.instruction;
    const literatureInstruction = literature.guidance!.instruction;

    const webOnly = userMessageText(
      await buildAgentInitialMessages(
        request("¿Cuál es la versión estable más reciente?", "web"),
        [web, literature],
        [],
      ),
    );
    assert.include(webOnly, webInstruction);
    assert.notInclude(webOnly, literatureInstruction);

    const both = userMessageText(
      await buildAgentInitialMessages(
        request("查找论文并核对当前官方文档。", "both"),
        [web, literature],
        [],
      ),
    );
    assert.include(both, webInstruction);
    assert.include(both, literatureInstruction);

    const none = userMessageText(
      await buildAgentInitialMessages(
        request("Explique este concepto.", "none"),
        [web, literature],
        [],
      ),
    );
    assert.notInclude(none, webInstruction);
    assert.notInclude(none, literatureInstruction);
  });

  it("keeps the evidence-necessity and composability rules in the persona", function () {
    const persona = AGENT_PERSONA_INSTRUCTIONS.join("\n");
    assert.include(persona, "Use external search when");
    assert.include(persona, "both source families");
    assert.include(persona, "Preserve the user's language");
    assert.include(persona, "If necessary web access is unavailable");
    assert.notInclude(persona, "Start with basic depth");
    assert.notInclude(persona, "focused lookup");
    assert.notInclude(persona, "exploratory or ambiguous discovery");
  });
});
