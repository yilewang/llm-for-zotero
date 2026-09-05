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
    "When MinerU cache is available",
    "If figure extraction fails or returns no crops",
    "Saving figure analysis to notes",
  ],
  "compare-papers.md": [
    "targeted first when the dimension is known",
    "selected-paper evidence ledger",
    "coverage frontier",
  ],
  "evidence-based-qa.md": [
    "read then retrieve, then answer",
    "Targeted retrieval",
    "### Budget",
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
    "Phase 1 — Paper Discovery",
    "Phase 2 — Selective Deep Reading",
    "Phase 3 — Synthesis and Writing",
  ],
  "simple-paper-qa.md": [
    "one read, then answer",
    "contentStatus:'no_pdf_attachment'",
    "contentStatus:'no_extractable_pdf_text'",
  ],
  "write-note.md": [
    "## Note template",
    "Checklist before writing the note",
    "Worked example",
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
