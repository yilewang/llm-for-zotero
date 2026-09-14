import { readFileSync } from "node:fs";
import { assert } from "chai";
import { AGENT_PERSONA_INSTRUCTIONS } from "../src/agent/model/agentPersona";
import { buildInstructionInventory } from "../src/agent/model/instructionInventory";
import {
  AGENT_ACTION_CONTRACT,
  CORE_RESEARCH_CONTRACT,
  PAPER_CITATION_CONTRACT,
  RESEARCH_RESPONSE_FORMAT_GUIDANCE,
  RUNTIME_CAPABILITY_CONTEXT,
} from "../src/shared/instructionContracts";
import { DEFAULT_SYSTEM_PROMPT } from "../src/utils/llmDefaults";
import { estimateTextTokens } from "../src/utils/modelInputCap";

const STOCK_SKILL_WORKFLOW_MARKERS: Record<string, string[]> = {
  "analyze-figures.md": [
    "shared semantic intent",
    "When crop extraction fails",
    "Requested persistence",
  ],
  "compare-papers.md": [
    "targeted first when the dimension is known",
    "selected-paper evidence ledger",
    "coverage frontier",
  ],
  "evidence-based-qa.md": [
    "read then retrieve, then answer",
    "Targeted retrieval",
    "Use the evidence frontier rather than a call count",
  ],
  "import-cited-reference.md": [
    "Identify what the user gave you",
    "Reading the references section from a paper",
    "Resolving DOIs",
  ],
  "library-analysis.md": [
    "### Strategy",
    'Example: "give me an overview of my library"',
    "Zotero.Items.getAll",
  ],
  "literature-review.md": [
    "central ResearchPolicy owns capacity measurement",
    "one durable paper understanding for every item",
    "Finish with `submit_document`",
  ],
  "simple-paper-qa.md": [
    "Follow `paperEvidenceProgress`",
    "contentStatus:'no_pdf_attachment'",
    "contentStatus:'no_extractable_pdf_text'",
  ],
  "write-note.md": [
    "## Note template",
    "Checklist before writing the note",
    "host exports verified assets",
    "USER CUSTOMIZATIONS COME FIRST",
  ],
};

function readSkill(filename: string): string {
  return readFileSync(
    new URL(`../src/agent/skills/${filename}`, import.meta.url),
    "utf8",
  );
}

describe("instruction harness inventory", function () {
  it("requires a numerical grounding check across the shared research routes", function () {
    for (const prompt of [
      DEFAULT_SYSTEM_PROMPT,
      AGENT_PERSONA_INSTRUCTIONS.join("\n"),
    ]) {
      assert.include(prompt, "reported values from your own calculations");
      assert.include(prompt, "units and percentage conversions");
      assert.include(prompt, "do not assume a chance baseline");
      assert.include(
        prompt,
        "class counts, ceilings or causality from accuracy alone",
      );
      assert.include(
        prompt,
        "Label inferences and correct unsupported earlier claims",
      );
      assert.include(prompt, "Missing information stays unknown");
      assert.include(prompt, "labeling a guess does not supply evidence");
    }
  });
  it("keeps discovery selection distinct from explicit imports in the fixed persona", function () {
    const prompt = AGENT_PERSONA_INSTRUCTIONS.join("\n");
    assert.include(
      prompt,
      "literature_review to present discovery results (its selection card appears in safe mode or when the user asks to choose; discovery never imports on its own in any mode)",
    );
    assert.include(prompt, "library_import only for explicit import requests");
    assert.notInclude(prompt, "only for imports, note saving");
  });
  it("keeps the shared semantic contracts provider-neutral", function () {
    const contracts = [
      CORE_RESEARCH_CONTRACT,
      PAPER_CITATION_CONTRACT,
      AGENT_ACTION_CONTRACT,
      RUNTIME_CAPABILITY_CONTEXT,
    ].join("\n");

    assert.notMatch(
      contracts,
      /\b(OpenAI|Anthropic|Claude|Gemini|Google|DeepSeek|MiniMax|Ollama|Codex)\b/i,
    );
  });

  it("assembles the required contracts without a percentage target", function () {
    const persona = AGENT_PERSONA_INSTRUCTIONS.join("\n");

    for (const contract of [
      CORE_RESEARCH_CONTRACT,
      PAPER_CITATION_CONTRACT,
      AGENT_ACTION_CONTRACT,
      RUNTIME_CAPABILITY_CONTEXT,
      RESEARCH_RESPONSE_FORMAT_GUIDANCE,
    ]) {
      assert.include(persona, contract);
    }
    assert.include(DEFAULT_SYSTEM_PROMPT, CORE_RESEARCH_CONTRACT);
    assert.include(DEFAULT_SYSTEM_PROMPT, PAPER_CITATION_CONTRACT);
    assert.include(DEFAULT_SYSTEM_PROMPT, RESEARCH_RESPONSE_FORMAT_GUIDANCE);
    assert.include(CORE_RESEARCH_CONTRACT, "concise but thorough");
    assert.include(
      RUNTIME_CAPABILITY_CONTEXT,
      "verify required output before claiming success",
    );
    assert.include(
      RESEARCH_RESPONSE_FORMAT_GUIDANCE,
      "Use tables for structured comparisons, not by default",
    );
  });

  it("preserves stock skill workflows without imposing a size ceiling", function () {
    for (const [filename, markers] of Object.entries(
      STOCK_SKILL_WORKFLOW_MARKERS,
    )) {
      const skill = readSkill(filename);
      assert.isAbove(estimateTextTokens(skill), 0, `${filename} is empty`);
      for (const marker of markers) {
        assert.include(skill, marker, `${filename} lost ${marker}`);
      }
    }
  });

  it("reports fixed, tool, skill, stable, and turn surfaces separately", function () {
    const inventory = buildInstructionInventory({
      fixed: "fixed behavior",
      tools: [
        {
          spec: {
            name: "demo_tool",
            description: "Demonstrate a tool.",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
            },
          },
          validate: () => ({ ok: true, value: {} }),
          execute: async () => ({ content: {} }),
        },
      ],
      matchedSkills: ["skill workflow"],
      dynamicGuidance: "turn-specific rule",
      stableResource: "stable evidence",
      turnResource: "current resource evidence",
      providerMessages: [
        { role: "system", content: "fixed behavior" },
        { role: "user", content: "current resource evidence" },
      ],
    });

    assert.isAbove(inventory.fixedTokens, 0);
    assert.isAbove(inventory.toolTokens, 0);
    assert.isAbove(inventory.matchedSkillTokens, 0);
    assert.isAbove(inventory.dynamicGuidanceTokens, 0);
    assert.isAbove(inventory.stableResourceTokens, 0);
    assert.isAbove(inventory.turnResourceTokens, 0);
    assert.equal(
      inventory.categorizedTotalTokens,
      inventory.fixedTokens +
        inventory.toolTokens +
        inventory.matchedSkillTokens +
        inventory.dynamicGuidanceTokens +
        inventory.stableResourceTokens +
        inventory.turnResourceTokens,
    );
    assert.isAbove(inventory.providerBoundTokens, 0);
    assert.match(inventory.promptHash, /^fnv1a32-[0-9a-f]{8}$/);
  });
});
