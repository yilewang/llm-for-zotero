import { assert } from "chai";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAllSkills, setUserSkills } from "../src/agent/skills/catalog";
import { parseSkill } from "../src/agent/skills/skillLoader";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import { resolveAgentRuntimeRequest } from "../src/agent/context/resolvedAgentRequest";
import {
  renderAgentPromptEnvelope,
  stringifyMessageContent,
} from "../src/agent/model/messageBuilder";

/**
 * Per-turn prompt budget: serialized tools + fixed system prompt + the
 * per-turn user message (dynamic guidance, resource context and request), for
 * the three common turn shapes, with the bundled skill inventory installed. The
 * caps are what this same measurement gives at ff8eaf7e (the commit before the
 * agent tool consolidation), so moving always-on rules into per-turn guidance
 * cannot silently grow a turn. The global and collection caps were raised on
 * purpose by the workflow sentence that asks for a digest part when the work
 * needs one result per paper (274 characters, 2026-10-02), and again by
 * submit_document's excluded list, which records the papers a document
 * leaves out (214 tool characters, 2026-10-02), and again by literature_search
 * saying that its metadata mode proposes changes for the user to approve, so
 * a review never asks to change an item it only reads, and that it searches
 * outside the library only on request (324 tool characters, 2026-10-03).
 */
const TURN_BUDGETS: Record<string, number> = {
  global: 35_474,
  paper: 34_764,
  collection: 35_572,
};

const TURNS: Record<string, Record<string, unknown>> = {
  global: {
    conversationKey: 1,
    mode: "agent",
    userText: "Which papers in my library discuss grid cells?",
    libraryID: 1,
    conversationKind: "global",
  },
  paper: {
    conversationKey: 2,
    mode: "agent",
    userText: "Summarize this paper.",
    libraryID: 1,
    conversationKind: "paper",
    activeItemId: 5,
    selectedPaperContexts: [{ itemId: 5, contextItemId: 6, title: "P" }],
  },
  collection: {
    conversationKey: 3,
    mode: "agent",
    userText: "What methods do the papers in this collection use?",
    libraryID: 1,
    conversationKind: "global",
    selectedCollectionContexts: [
      { collectionId: 9, libraryID: 1, name: "Grid cells" },
    ],
  },
};

async function measureTurn(input: Record<string, unknown>) {
  const registry = createBuiltInToolRegistry({
    zoteroGateway: {} as never,
    pdfService: {} as never,
    pdfPageService: {} as never,
    retrievalService: {} as never,
  });
  const request = resolveAgentRuntimeRequest(input as never);
  const tools = registry.listToolsForRequest(request);
  const toolCharacters = tools
    .map((tool) =>
      [tool.name, tool.description, JSON.stringify(tool.inputSchema)].join(
        "\n",
      ),
    )
    .join("\n\n").length;
  const rendered = await renderAgentPromptEnvelope(
    request,
    registry.listToolDefinitionsForRequest(request),
    [],
  );
  const fixedPrompt = rendered.inventory.fixedPrompt.length;
  // The whole per-turn user message: dynamic tool guidance, permission-mode
  // guidance, resource context and the request itself.
  const turnMessage = stringifyMessageContent(
    rendered.envelope.turnMessage.content,
  ).length;
  return {
    toolCharacters,
    fixedPrompt,
    dynamicGuidance: (rendered.inventory.dynamicGuidance || "").length,
    turnMessage,
    total: toolCharacters + fixedPrompt + turnMessage,
  };
}

/** The bundled skills, as a fresh profile installs them. */
function loadBundledSkills() {
  const dir = join(__dirname, "../src/agent/skills");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => parseSkill(readFileSync(join(dir, name), "utf8")));
}

describe("per-turn prompt budget", function () {
  let previousSkills: ReturnType<typeof getAllSkills>;
  let previousZotero: typeof globalThis.Zotero;
  before(function () {
    previousZotero = globalThis.Zotero;
    // Golden character caps need one reproducible platform fixture: native
    // shell paths and examples otherwise change the prompt with the CI host.
    // Keep the existing caps; do not shorten or omit platform guidance.
    globalThis.Zotero = {
      ...previousZotero,
      isWin: false,
      isMac: true,
    } as never;
    previousSkills = getAllSkills();
    // Measure with the installed skill inventory a real profile renders.
    setUserSkills(loadBundledSkills());
  });
  after(function () {
    setUserSkills(previousSkills);
    globalThis.Zotero = previousZotero;
  });

  for (const [name, input] of Object.entries(TURNS)) {
    it(`keeps a ${name} turn within its pre-consolidation size`, async function () {
      const measured = await measureTurn(input);
      if (process.env.PROMPT_TURN_BUDGET_REPORT) {
        console.log(`PROMPT_TURN_BUDGET ${name} ${JSON.stringify(measured)}`);
      }
      assert.isAtMost(measured.total, TURN_BUDGETS[name], name);
    });
  }
});
