/**
 * The literature-review skill runs a review as an ordinary Agent job: the
 * turn's papers, capacity-sized reads, and one cited document. Plan mode is
 * retired, so the skill names no plan tool, no research-loop operation, and
 * no plan state. The declared parts, digests and their retries belong to
 * task_update, the plugin Agent's own tool, so they live in its guidance and
 * the body names only tools an external runtime can call (#541).
 */
import { assert } from "chai";
import {
  BUILTIN_SKILL_FILES,
  getAllSkills,
  setUserSkills,
} from "../src/agent/skills";
import { parseSkill } from "../src/agent/skills/skillLoader";
import {
  COMPARE_PAPERS_DIGEST_GUIDANCE,
  LITERATURE_REVIEW_DIGEST_GUIDANCE,
  LITERATURE_REVIEW_PARTS_GUIDANCE,
} from "../src/agent/tools/control/taskUpdate";
import { LITERATURE_REVIEW_DIGEST_HANDLE_GUIDANCE } from "../src/agent/tools/read/contextRead";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import { buildAgentInitialMessages } from "../src/agent/model/messageBuilder";
import type { AgentModelMessage, AgentToolContext } from "../src/agent/types";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";
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

/** The moved literature-review rules, as the plugin's Agent receives them. */
const REVIEW_GUIDANCE = [
  LITERATURE_REVIEW_PARTS_GUIDANCE,
  LITERATURE_REVIEW_DIGEST_GUIDANCE,
  LITERATURE_REVIEW_DIGEST_HANDLE_GUIDANCE,
]
  .map((guidance) => guidance.instruction)
  .join("\n");

const PLAN_ONLY_NAMES = [
  "research_update",
  "approve_research_expansion",
  "approve_research_mutation",
  "update_plan",
  "prepare_plan_execution",
  "amend_plan",
  "submit_plan_document",
  "inventory_scope",
  "record_papers",
  "record_edges",
  "list_findings",
  "list_graph",
  "next_screen_batch",
];

describe("literature-review skill", function () {
  const raw = BUILTIN_SKILL_FILES["literature-review.md"];
  const skill = parseSkill(raw);

  it("runs the review with ordinary tools and names no plan tool or plan state", function () {
    for (const tool of [
      "library_search",
      "paper_read",
      "submit_document",
      "note_write",
    ]) {
      assert.include(skill.instruction, `\`${tool}`, tool);
    }
    // MCP hides both; their steps live in the tools' own guidance (#541).
    assert.notInclude(raw, "task_update");
    assert.notInclude(raw, "context_read");
    assert.include(REVIEW_GUIDANCE, "`task_update`");
    for (const name of PLAN_ONLY_NAMES) assert.notInclude(raw, name, name);
    assert.notMatch(
      raw,
      /plan mode|approved plan|plan approval|approved (?:document )?contract/i,
    );
  });

  it("leaves reading capacity to paper_read and asks for an honest coverage line", function () {
    assert.notMatch(
      skill.instruction,
      /\b\d+\s+(?:papers?|items|groups?)\b/i,
      "no hard-coded paper count or group size",
    );
    assert.include(
      skill.instruction,
      "read in full, in part, and from metadata only",
    );
    assert.include(skill.instruction, "never imply an exhaustive review");
  });

  it("counts a paper as read in full only when its reader read every character, as Task progress shows Full", function () {
    assert.include(
      skill.instruction,
      "A paper was read in full only when its reader read every character of its text: a digest whose text line says Full, or a `paper_read` read in mode `full` that came back complete; any other read of its text, a digest of named parts such as the abstract included, counts as in part.",
    );
    assert.notInclude(skill.instruction, "as `paper_read` reported them");
  });

  it("saves the review as a note only when the user asked", function () {
    assert.match(
      skill.instruction,
      /`note_write`[^\n]*only when the user asked/,
    );
  });

  it("reads the papers with paper_read unless the tool guidance gives the host's route", function () {
    const text = skill.instruction;
    // A complete path for any number of papers with MCP-visible tools.
    assert.include(
      text,
      "otherwise read the scope's papers with `paper_read`, passing them as `targets` and grouping related papers in one call.",
    );
    // The body defers only the first read; the rules after it apply to every read.
    assert.include(
      text,
      "2. **Read.** When the tools hand the papers to the host, write from its results and skip the first read below; otherwise read the scope's papers with `paper_read`",
    );
    assert.include(
      text,
      "As you go, note each paper's main claims, methods, and evidence, and its role in the argument",
    );
    assert.notInclude(text, "instead of this step");
    assert.include(
      LITERATURE_REVIEW_PARTS_GUIDANCE.instruction,
      "when task_update is available, these parts hand the papers to the host in place of the skill's first read",
    );
  });

  it("hands per-paper work to a host digest part and never pages the same papers", function () {
    const text = REVIEW_GUIDANCE;
    assert.include(text, "expectedEffect:'digest'");
    assert.include(
      text,
      "do not also declare a read part over the same papers",
    );
    // task_update's description owns the digest-or-read choice, the
    // nothing-attached path and the no-pre-read rule (they hold with or
    // without the skill), so the skill guidance no longer repeats them.
    assert.notInclude(text, "do not read those papers");
    assert.notInclude(text, "write from the results");
    assert.notInclude(text, "With nothing attached, choose the papers");
    // Each digest result names how much of the text the reader read.
    assert.include(
      LITERATURE_REVIEW_DIGEST_GUIDANCE.instruction,
      "gaps, a text line that says whether it read the whole text, and a handle to the digest record.",
    );
    // A digested paper is read again only by a targeted read: a decisive
    // claim, a contradiction, or a gap its result names; in full mode only
    // when the user asks for the whole text.
    assert.include(
      text,
      "Read a digested paper again only with `paper_read({ mode:'targeted', query:'...' })`: to verify a decisive cross-paper claim, test an apparent contradiction, or close a gap its result names that the review needs; never re-read it in overview mode, or in full mode unless the user asks for its whole text.",
    );
    // Papers outside the library are found through the selection card,
    // which asks to import and cite them or cite them without importing
    // (maintainer decision, 2026-10-29; it replaces D2's never-review-from-
    // outside-abstracts rule of 2026-10-20).
    assert.include(
      skill.instruction,
      "When the review needs papers outside the library (nothing relevant is attached or in the library, or the library misses important work) and the user did not limit it to the library, find them with `literature_search`; the selection card asks the user to import and cite them or to cite them without importing, also for a review that mixes library and outside papers.",
    );
    assert.notInclude(skill.instruction, "outside abstracts");
    // A paper with no text is named as not read: no retry, read or search.
    assert.include(
      text,
      'A paper that failed with "No readable text" has no text to read: name it as not read, and do not retry it, read it with `paper_read`, or look for it outside the library.',
    );
    // A paper the host could not digest twice is read, not left unread.
    assert.include(
      text,
      "a paper whose digest failed twice may be read with an overview `paper_read` instead",
    );
    assert.notInclude(text, "a paper that still fails is named as not read");
    assert.include(text, "same `taskId` and no description");
  });

  it("ships as version 20", function () {
    assert.equal(skill.version, 20);
  });

  it("reads and cites a chosen outside paper by paperId, an imported one by item key", function () {
    const text = skill.instruction;
    assert.include(
      text,
      'With "Cite without importing", or where no selection card can be shown, read each chosen paper with `literature_read` and cite it by `paperId`; with "Import and cite", read the imported items with `paper_read` and cite them by `libraryID` and `itemKey`.',
    );
    assert.include(
      text,
      "identify each citation source by `libraryID` and `itemKey`, or an outside paper by its `paperId`",
    );
    assert.include(
      text,
      "Never hand-format author-year citations or a References section",
    );
    // #541: MCP-visible skill text names only MCP-visible tools.
    assert.notInclude(text, "literature_review");
    assert.notMatch(text, /web_(search|read)/);
  });

  it("asks the digest for the review question's per-paper result", function () {
    const text = REVIEW_GUIDANCE;
    assert.include(
      text,
      `{ taskId:'papers', description:'For the review question "<question>": summarize each paper and judge how it bears on the question', expectedEffect:'digest', scope:true }`,
    );
    // A per-paper request still triggers a digest part here; the paper-count
    // trigger lives in task_update's description.
    assert.include(
      text,
      "When the user asked for something per paper (summaries, each paper's method, a table with a row per paper), declare a digest part, and do not also declare a read part over the same papers.",
    );
    assert.notInclude(text, "more than four papers");
    assert.notInclude(text, "four papers or fewer");
    assert.notInclude(text, "The host then analyzes each paper itself");
    assert.notInclude(text, "returns the summaries");
    assert.include(
      text,
      "a relevance line when the description names a question, facets, verified quotes with section labels, gaps",
    );
  });

  it("treats a folder as the source boundary and lets the agent select papers by content, with reasons", function () {
    const text = skill.instruction;
    assert.include(
      text,
      "A selected folder, tag or paper set is the source boundary: each paper in it is a candidate, and none is relevant only because it is there.",
    );
    assert.notInclude(text, "evidence pool, not as a sample");
    // Select sits between Read and Write.
    assert.match(
      text,
      /2\. \*\*Read\.\*\*[\s\S]*3\. \*\*Select\.\*\*[\s\S]*4\. \*\*Write\.\*\*[\s\S]*5\. \*\*Save\.\*\*/,
    );
    for (const rule of [
      "Include every paper whose content bears on the question, whatever its field; when the user named the papers to use, use only those.",
      "a relevance of none is a signal, not the decision",
      "List each paper you leave out under `excluded` in `submit_document`, with a one-sentence reason",
      "Never leave a paper out because its text could not be read; name it as not read.",
      "every paper keeps its summary in Paper summaries; flag one that does not fit the question instead of dropping it",
      "name it by title with that reason in Scope and method, without a citation: a citation means the review uses the paper",
      "In Scope and method, name each paper you left out by title, with the reason and without a citation.",
      "In narrative and scoping reviews, include papers by their relevance to the question and name each excluded paper with its reason.",
    ]) {
      assert.include(text, rule, rule);
    }
    assert.notInclude(text, "they are not eligibility criteria");
    assert.notInclude(
      text,
      "exclusion accounting to systematic-review requests",
    );
    // Scope and method owns the PRISMA and exclusion rule; Quality checks
    // no longer repeats it (2026-10-20, to fit the skill body budget).
    assert.notInclude(text, "in other reviews, name each excluded paper");
    // An answer without a document lists exclusions on task_update.
    assert.include(
      REVIEW_GUIDANCE,
      "List each paper you leave out of an answer without a document under `excluded` in `task_update`, with a one-sentence reason.",
    );
  });

  it("puts the per-paper summaries into the submitted document", function () {
    const text = skill.instruction;
    assert.include(text, "'Paper summaries' section");
    assert.include(
      REVIEW_GUIDANCE,
      "Pass the `taskId` of the review part to `submit_document`.",
    );
    assert.include(
      REVIEW_GUIDANCE,
      "In the 'Paper summaries' section, write each paper's paragraph from that paper's digest.",
    );
    assert.include(
      REVIEW_GUIDANCE,
      "name each paper whose digest failed and the reason the host gave",
    );
    assert.notInclude(text, "digest failed");
  });
});

describe("compare-papers skill", function () {
  it("builds a comparison of three or more papers from a host digest part", function () {
    const body = parseSkill(
      BUILTIN_SKILL_FILES["compare-papers.md"],
    ).instruction;
    assert.notInclude(body, "task_update");
    assert.include(
      body,
      "state a commonality only where the facets of each paper support it",
    );
    const text = COMPARE_PAPERS_DIGEST_GUIDANCE.instruction;
    assert.include(text, "expectedEffect:'digest'");
    // "Before reading", not "first": with nothing attached the whole-library
    // rule puts library_retrieve before the digest part (2026-10-31).
    assert.include(
      text,
      "Before reading, declare the digest part whose description names the comparison dimensions",
    );
    assert.notInclude(text, "first");
    // The digest description names the dimensions; the facets come back
    // with those labels and become the comparison's rows.
    assert.include(text, "whose description names the comparison dimensions");
    assert.include(
      text,
      "Each result returns facets with those labels; they become the comparison's rows.",
    );
    assert.notInclude(text, "returned digests");
  });
});

function messageText(message: AgentModelMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

/** A plugin Agent turn: task_update is offered only to the Original Agent. */
function originalAgentRequest(userText: string, forcedSkillIds?: string[]) {
  return resolvedAgentRequest({
    conversationKey: 54_301,
    mode: "agent",
    userText,
    libraryID: 1,
    model: "test-model",
    ...(forcedSkillIds ? { forcedSkillIds } : {}),
    executionContext: {
      version: 1,
      executionId: "execution-541",
      conversationKey: 54_301,
      conversationGeneration: 0,
      chatLibraryID: 1,
      permissionOwner: "original_agent",
      workspaceSnapshot: { selectedPapers: [], selectedCollections: [] },
      configuredAccess: { libraryIDs: [1], outputDirectories: [] },
    },
  });
}

describe("the plugin's Agent keeps the moved part and digest rules (#541)", function () {
  const registry = createBuiltInToolRegistry({
    zoteroGateway: {} as never,
    pdfService: {} as never,
    pdfPageService: {} as never,
    retrievalService: {} as never,
  });

  async function promptFor(skillId: string): Promise<string> {
    const request = originalAgentRequest("Review these papers.");
    const messages = await buildAgentInitialMessages(
      request,
      registry.listToolDefinitionsForRequest(request),
      [skillId],
    );
    return messages.map(messageText).join("\n");
  }

  it("renders the task_update digest guidance with literature-review active", async function () {
    const prompt = await promptFor("literature-review");
    assert.include(prompt, LITERATURE_REVIEW_PARTS_GUIDANCE.instruction);
    assert.include(prompt, LITERATURE_REVIEW_DIGEST_GUIDANCE.instruction);
    assert.include(
      prompt,
      LITERATURE_REVIEW_DIGEST_HANDLE_GUIDANCE.instruction,
    );
    assert.notInclude(prompt, COMPARE_PAPERS_DIGEST_GUIDANCE.instruction);
  });

  it("renders the digest step with compare-papers active", async function () {
    const prompt = await promptFor("compare-papers");
    assert.include(prompt, COMPARE_PAPERS_DIGEST_GUIDANCE.instruction);
    assert.notInclude(prompt, LITERATURE_REVIEW_PARTS_GUIDANCE.instruction);
  });

  it("renders the guidance for a forced $literature-review turn", async function () {
    const request = originalAgentRequest(
      "$literature-review\n\nReview these papers.",
      ["literature-review"],
    );
    const messages = await buildAgentInitialMessages(
      request,
      registry.listToolDefinitionsForRequest(request),
      [],
    );
    const prompt = messages.map(messageText).join("\n");
    assert.include(prompt, LITERATURE_REVIEW_PARTS_GUIDANCE.instruction);
  });

  it("returns the guidance with a mid-turn load_skill of literature-review", async function () {
    const installed = [...getAllSkills()];
    setUserSkills(Object.values(BUILTIN_SKILL_FILES).map(parseSkill));
    const request = originalAgentRequest("Review these papers.");
    const loaded = (await registry
      .getTool("load_skill")!
      .execute({ id: "literature-review" }, {
        request,
      } as unknown as AgentToolContext)
      .finally(() => setUserSkills(installed))) as { toolGuidance?: string };
    assert.include(
      loaded.toolGuidance || "",
      LITERATURE_REVIEW_PARTS_GUIDANCE.instruction,
    );
    assert.include(
      loaded.toolGuidance || "",
      LITERATURE_REVIEW_DIGEST_GUIDANCE.instruction,
    );
  });
});

/**
 * A literature review gets a digest part and a document whether or not the
 * skill is active, so the rules live in the tool descriptions, which every
 * turn carries, and not in the skill or its guidance.
 */
const DIGEST_RULE =
  "A literature review or synthesis of more than four papers declares a digest part, not a reasoning or read part: scope:true for the attached papers, or targetIds for papers you chose. The host analyzes each paper inside that call, so do not read those papers with paper_read first; write from the results it returns. A literature review of four papers or fewer declares a read part over their targetIds, unless the user asked for something per paper.";
const DOCUMENT_RULE =
  "A literature review is delivered with this tool unless the user asks for a chat answer; other answers stay in chat unless the user asks for a document or a file.";
/** What a document may cite, for the plugin Agent and MCP clients alike. */
const CITATION_SOURCE_RULE =
  "A citation source is a Zotero item (libraryID, itemKey) or the paperId of an outside paper literature_search or literature_read returned in this run; web pages are never cited. If it is unclear whether the answer is a literature review, answer in chat.";

describe("every literature review declares a digest part and ends in a document, with or without the skill", function () {
  const registry = createBuiltInToolRegistry({
    zoteroGateway: {} as never,
    pdfService: {} as never,
    pdfPageService: {} as never,
    retrievalService: {} as never,
  });

  it("puts the digest rule in task_update's description, which a turn without the skill carries", function () {
    const request = originalAgentRequest(
      "Write a short literature review of the papers in my library on representational drift, with citations.",
    );
    const listed = registry
      .listToolsForRequest(request)
      .find((tool) => tool.name === "task_update");
    assert.exists(listed);
    assert.include(listed!.description, DIGEST_RULE);
    assert.include(
      registry.getTool("task_update")!.spec.description,
      DIGEST_RULE,
    );
    assert.notInclude(REVIEW_GUIDANCE, "more than four papers");
  });

  it("puts the document rule in submit_document's description for the plugin Agent", function () {
    const request = originalAgentRequest("Write a short literature review.");
    const listed = registry
      .listToolsForRequest(request)
      .find((tool) => tool.name === "submit_document");
    assert.exists(listed);
    assert.include(listed!.description, DOCUMENT_RULE);
    assert.include(listed!.description, CITATION_SOURCE_RULE);
    // The skill points at its Document section and no longer restates when
    // to finish with the tool.
    const body = parseSkill(
      BUILTIN_SKILL_FILES["literature-review.md"],
    ).instruction;
    assert.include(
      body,
      "4. **Write.** Deliver the review in the form the user asked for; when they named none, write one cited document as described under Document.",
    );
    assert.notInclude(body, "finish with `submit_document`");
  });

  describe("over MCP", function () {
    const originalZotero = globalThis.Zotero;
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
    });
    afterEach(function () {
      unregisterMcpServer();
      (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
        originalZotero;
    });

    it("gives Codex and Claude Code the document rule in tools/list", async function () {
      registerMcpServer({ toolRegistry: registry, zoteroGateway: {} as never });
      const scope = registerScopedZoteroMcpScope({
        conversationKey: 54_302,
        libraryID: 1,
        kind: "global",
        runtimeAuthority: "codex",
        requestInteraction: async () => ({ approved: false }),
      });
      const EndpointClass = (
        globalThis.Zotero.Server.Endpoints as Record<string, any>
      )[ZOTERO_MCP_ENDPOINT_PATH];
      const reply = await new EndpointClass().init({
        method: "POST",
        data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
        headers: {
          Authorization: `Bearer ${getOrCreateZoteroMcpBearerToken()}`,
          [ZOTERO_MCP_SCOPE_HEADER]: scope.token,
        },
      });
      const tools = JSON.parse(reply[2]).result.tools as Array<{
        name: string;
        description: string;
      }>;
      const submit = tools.find((tool) => tool.name === "submit_document");
      assert.exists(submit);
      assert.include(submit!.description, DOCUMENT_RULE);
      assert.include(submit!.description, CITATION_SOURCE_RULE);
      // The guidance MCP clients read with the description.
      assert.include(
        submit!.description,
        "Identify each citation source by libraryID and itemKey, or an outside paper by paperId;",
      );
      // No card over MCP: a review cites outside papers without importing.
      const search = tools.find((tool) => tool.name === "literature_search");
      assert.include(
        search!.description,
        "Outside papers a literature review cites are cited by paperId without importing, unless the user asks to import them (then library_import).",
      );
      assert.notInclude(search!.description, "forLiteratureReview");
    });
  });
});
