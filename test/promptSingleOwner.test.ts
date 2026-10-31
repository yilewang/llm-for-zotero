import { assert } from "chai";
import { toolGuidanceItems } from "../src/agent/tools/guidance";
import { MCP_TOOL_DESCRIPTION_NOTES } from "../src/agent/mcp/server";
import { readFileSync } from "node:fs";
import {
  AGENT_PERSONA_INSTRUCTIONS,
  AGENT_SEARCH_TOOL_ROUTES,
} from "../src/agent/model/agentPersona";
import { WHOLE_LIBRARY_SCOPE_RULE } from "../src/agent/context/turnContextEnvelope";
import { BUILTIN_SKILL_FILES } from "../src/agent/skills";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import { CLAUDE_BRIDGE_SEARCH_TOOL_ROUTES } from "../src/agent/externalBackendBridge";
import { CODEX_SEARCH_TOOL_ROUTES } from "../src/codexAppServer/nativeClient";
import { formatMaterialOutcomeRecoveryLines } from "../src/agent/execution/materialOutcomes";

/**
 * Every behavioral prompt rule has one owner. An owner is one tool (its
 * description, model-facing description, and guidance together), the
 * persona (all its sections, the shared contracts it carries and the plugin
 * Agent's search-tool map), one shipped skill file, the message
 * builder's hard-coded prompt sections, the whole-library turn line, or
 * the Claude Code bridge's or Codex's search-tool line, or the turn-start
 * block that names the conversation's unsaved material. A marker phrase
 * distinctive for a rule must appear in exactly the expected owners.
 */
function stubDependency(): never {
  const stub: unknown = new Proxy(function () {}, {
    get: (_target, property) =>
      property === "then" ? undefined : stubDependency(),
    apply: () => undefined,
  });
  return stub as never;
}

function collectOwnerTexts(): Map<string, string> {
  const registry = createBuiltInToolRegistry({
    zoteroGateway: stubDependency(),
    pdfService: stubDependency(),
    pdfPageService: stubDependency(),
    retrievalService: stubDependency(),
  });
  const modelDescriptions = new Map(
    registry.listTools().map((spec) => [spec.name, spec.description]),
  );
  const owners = new Map<string, string>();
  owners.set(
    "persona",
    [...AGENT_PERSONA_INSTRUCTIONS, AGENT_SEARCH_TOOL_ROUTES].join("\n"),
  );
  for (const tool of registry.listToolDefinitions()) {
    owners.set(
      `tool:${tool.spec.name}`,
      [
        tool.spec.description,
        modelDescriptions.get(tool.spec.name) || "",
        ...toolGuidanceItems(tool.guidance).map(
          (guidance) => guidance.instruction,
        ),
      ].join("\n"),
    );
  }
  for (const [filename, content] of Object.entries(BUILTIN_SKILL_FILES)) {
    owners.set(`skill:${filename}`, content);
  }
  // The nothing-attached turn line states the scope; routing stays in the
  // persona's search routing contract.
  owners.set("turnContext:wholeLibrary", WHOLE_LIBRARY_SCOPE_RULE);
  // Each external runtime maps the search families to its own tools.
  owners.set("runtime:claudeBridge", CLAUDE_BRIDGE_SEARCH_TOOL_ROUTES);
  owners.set("runtime:codex", CODEX_SEARCH_TOOL_ROUTES);
  // The block names one document that cites outside papers, so its import
  // line is rendered.
  owners.set(
    "turnRecovery:materialOutcomes",
    formatMaterialOutcomeRecoveryLines([
      {
        materialRef: {
          documentId: "run-1:document:1",
          documentVersion: 1,
          contentHash: "sha256:review",
        },
        materialTitle: "Review",
        runId: "run-1",
        status: "finalized",
        outsidePaperCount: 2,
      },
    ]).join("\n"),
  );
  // MCP clients never see the native guidance; this note is the MCP surface's
  // own owner of the import-by-document rule.
  owners.set(
    "mcp:library_import",
    MCP_TOOL_DESCRIPTION_NOTES.get("library_import") || "",
  );
  owners.set(
    "messageBuilder",
    readFileSync(
      new URL("../src/agent/model/messageBuilder.ts", import.meta.url),
      "utf8",
    ),
  );
  return owners;
}

function ownersOf(owners: Map<string, string>, marker: string): string[] {
  return Array.from(owners.entries())
    .filter(([, text]) => text.includes(marker))
    .map(([owner]) => owner)
    .sort();
}

describe("prompt rules have a single owner", function () {
  const rules: Array<{
    rule: string;
    marker: string;
    owner: string | string[];
  }> = [
    {
      rule: "paper_read mode selection",
      marker: "mode:'overview'",
      owner: "tool:paper_read",
    },
    {
      rule: "paper_read evidence-progress handling",
      marker: "paperEvidenceProgress",
      owner: "tool:paper_read",
    },
    {
      rule: "paper_read single-fact topK default",
      marker: "topK:3",
      owner: "tool:paper_read",
    },
    {
      rule: "collection scope never reads the active paper implicitly",
      marker: "implicit target",
      owner: "tool:paper_read",
    },
    {
      rule: "library_retrieve body-evidence floor",
      marker: "papersBodyRead",
      owner: "tool:library_retrieve",
    },
    {
      rule: "literature discovery never imports",
      marker: "discovery never imports",
      owner: "tool:literature_search",
    },
    {
      rule: "search names an action, not a source",
      marker: "name an action, not a source",
      owner: "persona",
    },
    {
      rule: "a source the user names is used",
      marker: "use a source the user names",
      owner: "persona",
    },
    {
      rule: "the nearest source that can hold a need comes first",
      marker: "nearest source that can hold it",
      owner: "persona",
    },
    {
      rule: "scholarly and public-fact needs map to search families",
      marker: "distinct needs use both",
      owner: "persona",
    },
    {
      rule: "outside sources are never read with shell commands",
      marker: "never with shell commands",
      owner: "persona",
    },
    {
      rule: "an unreadable outside text is named, not worked around",
      marker: "say what was not read",
      owner: "persona",
    },
    {
      rule: "the selection card answers only a find or recommend request",
      marker: "only when the user asks you to find or recommend papers",
      owner: "persona",
    },
    {
      // The card rule and the workflow:'review' sentence both carry it, so
      // neither sends a nothing-attached find request past relevant library
      // papers (user decision 2a, 2026-10-20).
      rule: "with nothing attached, the card waits for an empty library or a request for outside papers",
      marker:
        "with nothing attached, only if the library holds no relevant papers or the user asks for papers outside it",
      owner: ["persona", "tool:literature_search"],
    },
    {
      rule: "with nothing attached, the library is searched in its own step",
      marker: "search the library first, in a step of its own",
      owner: "persona",
    },
    {
      rule: "with nothing attached, relevant library papers answer, with an offer",
      marker: "offer to search outside",
      owner: "persona",
    },
    {
      rule: "with nothing attached and none relevant, scholarly search runs unasked",
      marker: "search outside without asking",
      owner: "persona",
    },
    {
      // With or without the literature-review skill, and with nothing
      // attached, because Task progress depends on the digest part.
      rule: "a review of more than four papers declares a digest part",
      marker: "more than four papers declares a digest part",
      owner: "tool:task_update",
    },
    {
      // The plugin Agent reads the registry text, MCP clients the same text
      // in tools/list; both belong to the one tool.
      rule: "a literature review is delivered as a document unless the user asks for a chat answer",
      marker:
        "A literature review is delivered with this tool unless the user asks for a chat answer",
      owner: "tool:submit_document",
    },
    {
      // User instructions come first (2026-10-31): each default below holds
      // only when the user left the choice open, and states that in one
      // clause in its one owner.
      rule: "a digest reads the whole text unless the user limits what to read",
      marker:
        "A digest reads each paper's whole text unless its read names a source",
      owner: "tool:task_update",
    },
    {
      rule: "paper_digest reads only what the user limited the reading to",
      marker: "If the user limits what to read, set `read`",
      owner: "tool:paper_digest",
    },
    {
      rule: "paper_read reads only what the user named",
      marker:
        "Otherwise read only what the user named, if they limited the reading",
      owner: "tool:paper_read",
    },
    {
      rule: "library_retrieve needs body evidence unless the user limited the reading",
      marker: "Unless the user limited the reading to titles or abstracts",
      owner: "tool:library_retrieve",
    },
    {
      rule: "outside search without asking yields to a library-only request",
      marker: "unless the user limited the answer to the library",
      owner: "persona",
    },
    {
      rule: "a chat answer keeps its limitations in its sentences unless the user asks",
      marker: "In a chat answer, put any limitation in the sentence",
      owner: "persona",
    },
    {
      rule: "with nothing attached, a candidate is opened when the user says how to read it",
      marker: "unless the user named a paper and how to read it",
      owner: "turnContext:wholeLibrary",
    },
    {
      rule: "a review uses only the papers the user named",
      marker: "when the user named the papers to use, use only those",
      owner: "skill:literature-review.md",
    },
    {
      rule: "a review searches outside unless the user limited it to the library",
      marker: "and the user did not limit it to the library",
      owner: "skill:literature-review.md",
    },
    {
      rule: "a review is written as a document unless the user asked for a chat answer",
      marker:
        "Write one cited document as described under Document, unless the user asked for a chat answer",
      owner: "skill:literature-review.md",
    },
    {
      rule: "a comparison reads what the user asked to read",
      marker: "and when they asked for full reads, read each paper in full",
      owner: "skill:compare-papers.md",
    },
    {
      rule: "sorting reads a full text or every paper only on request",
      marker: "read a full text, or every paper, only when the user asks",
      owner: "skill:reorganize-library.md",
    },
    {
      // The card is offered for a review that needs outside papers, a mixed
      // review included, as skill v17 says (2026-10-29).
      rule: "a review that needs outside papers shows the card",
      marker:
        "or for a literature review that needs papers outside the library, including one that mixes library and outside papers",
      owner: "persona",
    },
    {
      // A later import relinks the document in a new version (maintainer
      // decision, 2026-10-29).
      rule: "a document's outside papers are imported later into a new version",
      marker:
        "imports the outside papers that document cites, then publishes a new version of it that cites the imported items",
      owner: "tool:library_import",
    },
    {
      // A later import request names the document, not the DOIs it cites
      // (live run, 2026-10-29: the Agent imported ten DOIs and the review
      // kept citing them as outside papers).
      rule: "a document's outside papers are imported by documentId, not by DOI",
      marker: "with that document's documentId, not their DOIs",
      owner: "tool:library_import",
    },
    {
      // MCP clients get the same rule as a note on the tool's MCP description.
      rule: "an MCP client imports a document's outside papers by documentId, not by DOI",
      marker: "with its documentId, not their DOIs",
      owner: "mcp:library_import",
    },
    {
      // The turn-start block only points at the call for one document; the
      // rule above says why.
      rule: "an unsaved document that cites outside papers names its import call",
      marker: "if the user asks to import them",
      owner: "turnRecovery:materialOutcomes",
    },
    {
      // The card asks for a review; the skill says how each answer is read
      // and cited (maintainer decision, 2026-10-29). Two markers, one per
      // way of wording the choice.
      rule: "a review's outside papers go through the card's import choice",
      marker: "import and cite",
      owner: "skill:literature-review.md",
    },
    {
      rule: "a review's outside papers go through the card's cite choice",
      marker: "cite them without importing",
      owner: "skill:literature-review.md",
    },
    {
      rule: "a review finds outside papers with the review flag",
      marker: "forLiteratureReview",
      owner: "tool:literature_search",
    },
    {
      rule: "web pages are never cited",
      marker: "web pages are never cited",
      owner: "tool:submit_document",
    },
    {
      rule: "an unclear literature review is answered in chat",
      marker: "If it is unclear whether the answer is a literature review",
      owner: "tool:submit_document",
    },
    {
      rule: "the Claude Code bridge searches the web with its own tools",
      marker: "Claude Code's WebSearch and WebFetch",
      owner: "runtime:claudeBridge",
    },
    {
      rule: "Codex web search follows the user's Codex configuration",
      marker: "when it is in your tool list",
      owner: "runtime:codex",
    },
    {
      rule: "native web search queries default to the user's language",
      marker: "web search queries in the user's language",
      owner: ["runtime:claudeBridge", "runtime:codex"],
    },
    {
      rule: "figure crops come only from paper_read figures mode",
      marker: "figure_crops",
      owner: "skill:analyze-figures.md",
    },
    {
      rule: "failed figure extraction falls back to text",
      marker: "MinerU source images, or placeholders",
      owner: "skill:analyze-figures.md",
    },
  ];

  const owners = collectOwnerTexts();

  it("collects the persona, every tool, every shipped skill, and the message builder", function () {
    assert.isAtLeast(
      Array.from(owners.keys()).filter((key) => key.startsWith("tool:")).length,
      27,
    );
    assert.isAtLeast(
      Array.from(owners.keys()).filter((key) => key.startsWith("skill:"))
        .length,
      7,
    );
    assert.isTrue(owners.has("persona"));
    assert.isTrue(owners.has("messageBuilder"));
    assert.isTrue(owners.has("turnContext:wholeLibrary"));
    assert.isTrue(owners.has("runtime:claudeBridge"));
    assert.isTrue(owners.has("runtime:codex"));
    assert.isTrue(owners.has("turnRecovery:materialOutcomes"));
  });

  it("keeps no routing copy outside the search routing contract", function () {
    for (const marker of [
      "Use external search",
      "both source families",
      "for scholarly discovery",
      "A mixed request may also use",
      "only when the user asks to find, recommend",
      "current or general public evidence",
    ])
      assert.deepEqual(ownersOf(owners, marker), [], marker);
  });

  for (const { rule, marker, owner } of rules) {
    const expected = (Array.isArray(owner) ? [...owner] : [owner]).sort();
    it(`${rule} lives only in ${expected.join(" and ")}`, function () {
      assert.deepEqual(ownersOf(owners, marker), expected, marker);
    });
  }
});
