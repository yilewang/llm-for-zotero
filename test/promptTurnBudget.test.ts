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
 * outside the library only on request (324 tool characters, 2026-10-03),
 * and again by the citation contract saying how to quote a passage that has
 * no ID instead of constructing one, and to copy quoted text with its
 * extraction artifacts (190 characters, 2026-10-09), and again by the
 * agent stop rules' lookup-first route: library_search says to look a named
 * paper up by title or author first, and the library_retrieve guidance tells
 * a candidate from a found paper and a paper's passage absence from its
 * absence from the library (249 characters, 2026-10-13), and again when
 * that guidance said to check a candidate's title and authors against what
 * was asked and to name it with what matches and what does not, after a
 * benchmark run where the shorter rule led to a false "not in your
 * library" for a paper the agent had read (100 characters, 2026-10-13).
 * All three caps were raised again by past_chat_read, the always-listed tool
 * that opens past chats the user attached to the conversation (510 tool
 * characters, 2026-10-18); a turn with nothing attached is otherwise
 * unchanged. Raised again by its query search (the query field and one
 * sentence of description: 133, 99 and 133 characters, 2026-10-18). Raised
 * again by past_chat_search and past_chat_attach, the always-listed tools
 * that find an earlier chat and add it to the user's message (733
 * characters each, 2026-10-19). Raised again by note_write's removeEmbeds field
 * (58 characters, 2026-10-19). Raised on 2026-10-20 by the search-routing
 * branch: the search routing contract, the one owner of when to search
 * which source, with its nothing-attached rule; the plugin Agent's map from
 * source families to its tools, with the selection-card rule; the reason
 * (need and gap) every outside search states; and literature_search's
 * wording of the find (workflow:'review') and answer (workflow:'answer')
 * workflows. Measured against a10986c0, that is 1,204 more fixed prompt and
 * 405 more tool characters, less 21, 5 and 21 turn characters: net growth
 * of 1,588, 1,604 and 1,588, to 39,035, 37,768 and 39,133. Raised for
 * literature_read, the always-listed tool that reads an outside paper's
 * abstract and open-access text instead of shell curl calls, and its clause
 * in the plugin Agent's search-tool map (2026-10-20), to 39,864, 38,597 and 39,962 (+829 each).
 * Raised by the agent-files section, which tells the agent to put a page in
 * the answer as an html block and to save files only when the user wants the
 * file itself, into the chat's own folder (2026-10-22), to 40,269, 39,002 and
 * 40,367 (+405 each; a turn whose paper has a folder adds its path lines).
 * Raised by the preview color sentence (draw SVG and HTML with currentColor
 * and the named theme colors, so they read in light and dark), once in the
 * response format and once in the html page rule (2026-10-25), to 40,715,
 * 39,448 and 40,813 (+446 each).
 * Raised by per-sentence citing (cite the passages that support a sentence
 * before its final punctuation, with an example, and give a sentence without
 * a supporting passage no token) (2026-10-26), to 40,914, 39,647 and 41,012
 * (+199 each).
 * Raised by submit_document's sentence in the model description, that a
 * literature review is always delivered with that tool and other answers stay
 * in chat unless the user asks for a document or a file (130 characters,
 * 2026-10-29), to 41,044, 39,777 and 41,142. Raised by the outside-paper
 * choice (2026-10-29): literature_search's forLiteratureReview field and its
 * sentence that a literature review finds outside papers with it and the
 * card asks whether to import and cite them, and submit_document's sentences
 * that a citation source is a Zotero item or an outside paper's paperId,
 * web pages are never cited, and an unclear literature review is answered
 * in chat (482 tool characters), to 41,519, 40,252 and 41,617. Raised by
 * library_import's kind:'document_citations' (its sentence, enum value and
 * documentId field) and the card rule widened to a literature review that
 * needs outside papers, a mixed one included (2026-10-29), to 41,789, 40,522
 * and 41,887 (+270 each). Lowered when the card's import-or-cite choice was
 * stated only in the skill (2026-10-29), to 41,711, 40,444 and 41,809 (-78
 * each). These turns carry no
 * original_agent execution context, so task_update, and the digest rule in
 * its description, is not listed here; test/directAgentToolSurface.test.ts
 * measures that rule.
 * Raised by record_paper_decisions, the always-listed tool that records the
 * agent's include, exclude or defer decision about papers (2026-10-29), to
 * 42,417, 41,150 and 42,515 (+706 tool characters each). review_coverage
 * reaches Codex and Claude Code over MCP only and adds nothing here.
 * Raised by library_delete's groups field and its clause, so one approval
 * merges several duplicate groups (2026-10-30), to 42,575, 41,308 and 42,673
 * (+158 tool characters each).
 * Raised on 2026-10-31 by the zotero-script skill: zotero_script's model
 * description points to it (90 tool characters) and the skill inventory
 * lists it (140 fixed characters), to 42,805, 41,538 and 42,903 (+230 each).
 * Raised on 2026-10-31 by run_command's and file_io's model descriptions,
 * which now say what each is for and which approval it needs, in one
 * sentence each (352 tool characters), to 43,157, 41,890 and 43,255.
 * Raised on 2026-10-31 by literature_search's source and author rules, moved
 * from never-selected guidance into its description (188 tool characters),
 * to 43,345, 42,078 and 43,443.
 * Raised on 2026-10-31 by 13 tool characters in run_command's and file_io's
 * approval wording, to 43,358, 42,091 and 43,456.
 */
const TURN_BUDGETS: Record<string, number> = {
  global: 43_358,
  paper: 42_091,
  collection: 43_456,
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
  let previousZotero: unknown;
  before(function () {
    previousSkills = getAllSkills();
    previousZotero = (globalThis as { Zotero?: unknown }).Zotero;
    // TURN_BUDGETS are pinned against the macOS runtime platform guidance;
    // pin Zotero.isMac so Linux CI (+12 chars) and Windows (+63 chars) measure
    // the same platform string as macOS.
    (globalThis as { Zotero?: unknown }).Zotero = {
      ...((previousZotero as Record<string, unknown>) || {}),
      isMac: true,
      isWin: false,
    };
    // Measure with the installed skill inventory a real profile renders.
    setUserSkills(loadBundledSkills());
  });
  after(function () {
    setUserSkills(previousSkills);
    (globalThis as { Zotero?: unknown }).Zotero = previousZotero;
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
