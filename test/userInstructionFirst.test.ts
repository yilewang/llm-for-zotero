/**
 * User instructions come first (2026-10-31): every default the prompt rules,
 * skills, tool descriptions and host corrections state (digest first, a
 * review ends in a document, read budgets, outside search) holds only when
 * the user left the choice open. Each rule below states its condition in one
 * clause, and a source limit points to the read scope (`read`, or a
 * whole-sections `paper_read`), never to a full read.
 */
import { assert } from "chai";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import { buildAgentStableResourceContextBlock } from "../src/agent/context/resourceContextPlan";
import { WHOLE_LIBRARY_SCOPE_RULE } from "../src/agent/context/turnContextEnvelope";
import {
  PAPER_CITATION_CONTRACT,
  SEARCH_ROUTING_CONTRACT,
} from "../src/shared/instructionContracts";
import {
  COMPARE_PAPERS_DIGEST_GUIDANCE,
  LITERATURE_REVIEW_PARTS_GUIDANCE,
} from "../src/agent/tools/control/taskUpdate";
import { LIBRARY_RETRIEVE_GUIDANCE } from "../src/agent/tools/read/libraryRetrieve";
import { PAPER_READ_GUIDANCE } from "../src/agent/tools/read/paperRead";
import { createPaperDigestTool } from "../src/agent/tools/read/paperDigest";
import { BUILTIN_SKILL_FILES } from "../src/agent/skills";
import { parseSkill } from "../src/agent/skills/skillLoader";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

const registry = createBuiltInToolRegistry({
  zoteroGateway: {} as never,
  pdfService: {} as never,
  pdfPageService: {} as never,
  retrievalService: {} as never,
});

function modelDescription(name: string): string {
  return registry.listTools().find((tool) => tool.name === name)!.description;
}

function scopedResourceBlock(): string {
  return buildAgentStableResourceContextBlock(
    resolvedAgentRequest({
      conversationKey: 3_101,
      mode: "agent",
      userText: "Using only the abstracts, give me an overview of these papers",
      libraryID: 1,
      selectedPaperContexts: [],
      fullTextPaperContexts: [],
      selectedCollectionContexts: [
        { collectionId: 7, libraryID: 1, name: "Folder" },
      ],
      selectedTagContexts: [
        { name: "review", normalizedName: "review", libraryID: 1 },
      ],
    }),
  );
}

function countOf(text: string, phrase: string): number {
  return text.split(phrase).length - 1;
}

describe("user instructions come first", function () {
  describe("delivery", function () {
    it("delivers a literature review as a document unless the user asks for a chat answer", function () {
      const description = modelDescription("submit_document");
      assert.include(
        description,
        "A literature review is delivered with this tool unless the user asks for a chat answer;",
      );
      assert.notInclude(description, "always delivered");
    });

    it("declares a review's artifact part only when the user did not ask for a chat answer", function () {
      assert.include(
        LITERATURE_REVIEW_PARTS_GUIDANCE.instruction,
        "Then declare the review (`expectedEffect:'artifact'`) unless the user asked for a chat answer,",
      );
    });

    it("writes the review's document unless the user asked for a chat answer", function () {
      const body = parseSkill(
        BUILTIN_SKILL_FILES["literature-review.md"],
      ).instruction;
      assert.include(
        body,
        "4. **Write.** Write one cited document as described under Document, unless the user asked for a chat answer; then answer in chat.",
      );
    });

    it("keeps limitations inside a chat answer's sentences unless the user asks for a separate section", function () {
      assert.include(
        PAPER_CITATION_CONTRACT,
        "In a chat answer, put any limitation in the sentence that makes the claim it qualifies:",
      );
      assert.include(
        PAPER_CITATION_CONTRACT,
        "and no closing caveat sentence, unless the user asks for a limitations section.",
      );
    });
  });

  describe("what to read", function () {
    it("names the read scope for a digest when the user limits the source", function () {
      const description = registry.getTool("task_update")!.spec.description;
      assert.include(
        description,
        "A digest reads each paper's whole text unless its read names a source; when the user limits what to read (abstracts, sections, pages, notes), set read to that, e.g. {source:'abstract'}.",
      );
    });

    it("gives a review's digest part the user's read limit and drops the take-priority override", function () {
      const text = LITERATURE_REVIEW_PARTS_GUIDANCE.instruction;
      assert.notInclude(text, "take priority");
      assert.include(
        text,
        "when the user limited what to read, add that `read`, e.g. `read:{ source:'abstract' }` or `read:{ source:'sections', sections:['abstract','results'] }`.",
      );
    });

    it("compares through a digest unless the user asked for full reads, with the user's read limit", function () {
      const text = COMPARE_PAPERS_DIGEST_GUIDANCE.instruction;
      assert.notInclude(text, "take priority");
      assert.include(
        text,
        "Compare papers: when task_update is available and there are three or more papers, compare through a digest part instead of reading the papers with `paper_read`, unless the user asked for full reads.",
      );
      assert.include(
        text,
        "When the user limited what to read, give the part that `read`, e.g. `read:{ source:'abstract' }`.",
      );
    });

    it("lets a collection or tag digest carry the user's read limit, and the abstracts ground an abstracts-only answer", function () {
      const text = scopedResourceBlock();
      assert.equal(
        countOf(
          text,
          "whose description states that per-paper result, with read:{ source:'abstract' } or read:{ source:'sections', sections:[...] } when the user limited what to read;",
        ),
        2,
      );
      assert.equal(
        countOf(
          text,
          "Ground final content claims in library_retrieve snippets or paper_read results, or in the abstracts when the user limited the answer to them.",
        ),
        2,
      );
      // The abstracts come with citation ids through the read scope, not
      // through a catalog listing.
      assert.notInclude(text, "include:['abstract']");
    });

    it("reads only what the user named with paper_read", function () {
      assert.include(
        PAPER_READ_GUIDANCE.instruction,
        "Otherwise read only what the user named, if they limited the reading (only the abstract, named sections), or choose the paper_read mode from the evidence the answer needs:",
      );
    });

    it("asks library_retrieve for body evidence unless the user limited the reading to titles or abstracts", function () {
      assert.include(
        LIBRARY_RETRIEVE_GUIDANCE.instruction,
        "Unless the user limited the reading to titles or abstracts, for bounded collection or tag synthesis, require body evidence",
      );
    });

    it("tells Codex and Claude Code to pass the user's read limit to paper_digest", function () {
      const tool = createPaperDigestTool({} as never);
      assert.include(
        tool.spec.description,
        "If the user limits what to read, set `read`, e.g. {source:'abstract'}",
      );
    });

    it("lets the skills read only what the user asked to read", function () {
      const review = parseSkill(
        BUILTIN_SKILL_FILES["literature-review.md"],
      ).instruction;
      assert.include(
        review,
        "Read only what the user asked to read: when they limited it (only the abstracts, named sections), read just that, for example with `paper_read` `sections` and no query.",
      );
      const compare = parseSkill(
        BUILTIN_SKILL_FILES["compare-papers.md"],
      ).instruction;
      assert.include(
        compare,
        "Read what the user asked to read: when they limited it (only the abstracts, named sections), read just that, for example with `paper_read` `sections` and no query, and when they asked for full reads, read each paper in full.",
      );
      assert.include(
        compare,
        "Otherwise read further only for a missing comparison dimension",
      );
      const reorganize = parseSkill(
        BUILTIN_SKILL_FILES["reorganize-library.md"],
      ).instruction;
      assert.include(
        reorganize,
        "then read that paper's relevant section with a targeted `paper_read`; read a full text, or every paper, only when the user asks.",
      );
      assert.notInclude(reorganize, "not its full text");
    });
  });

  describe("scope", function () {
    it("lets the skill decide only what the request leaves open", function () {
      const text = scopedResourceBlock();
      assert.equal(
        countOf(
          text,
          "load it with load_skill before you declare any part; its rules decide what the request leaves open, and the user's explicit instructions on sources, depth, scope and delivery come first.",
        ),
        2,
      );
      assert.notInclude(text, "its rules decide the parts.");
    });

    it("keeps reviews within the collection or tag unless the user asks to go beyond it", function () {
      const text = scopedResourceBlock();
      for (const scope of ["collection", "tag"]) {
        assert.include(
          text,
          `Reviews and summaries stay within the ${scope} unless the user asks to go beyond it;`,
          scope,
        );
      }
    });

    it("opens a candidate with nothing attached when the user named a paper and how to read it", function () {
      assert.include(
        WHOLE_LIBRARY_SCOPE_RULE,
        "without opening candidates with paper_read unless the user named a paper and how to read it;",
      );
    });

    it("declares the parts before reading, and with nothing attached after library_retrieve chose the papers", function () {
      const text = LITERATURE_REVIEW_PARTS_GUIDANCE.instruction;
      assert.include(
        text,
        "Declare the parts with `task_update` before reading; with nothing attached, after `library_retrieve` has chosen the papers.",
      );
      assert.notInclude(text, "In your first step");
      // The nothing-attached line agrees: no digest part in the first step.
      assert.include(WHOLE_LIBRARY_SCOPE_RULE, "not in your first step");
    });

    it("searches outside the library unasked only when the user did not limit the answer to it", function () {
      assert.include(
        SEARCH_ROUTING_CONTRACT,
        "search outside without asking, unless the user limited the answer to the library.",
      );
      const body = parseSkill(
        BUILTIN_SKILL_FILES["literature-review.md"],
      ).instruction;
      assert.include(
        body,
        "or the library misses important work) and the user did not limit it to the library, find them with `literature_search`;",
      );
    });

    it("uses only the papers the user named for the review", function () {
      const body = parseSkill(
        BUILTIN_SKILL_FILES["literature-review.md"],
      ).instruction;
      assert.include(
        body,
        "Include every paper whose content bears on the question, whatever its field; when the user named the papers to use, use only those.",
      );
    });
  });
});
