import { readFileSync } from "node:fs";
import { assert } from "chai";
import { buildZoteroEnvironmentManifest } from "../src/codexAppServer/nativeClient";
import {
  buildAgentEvidenceContextBlock,
  clearAgentEvidenceCache,
  commitAgentCacheEvidenceActivities,
} from "../src/agent/context/cacheManagement";
import { buildAgentStableResourceContextBlock } from "../src/agent/context/resourceContextPlan";
import { AGENT_PERSONA_INSTRUCTIONS } from "../src/agent/model/agentPersona";
import { buildAgentInitialMessages } from "../src/agent/model/messageBuilder";
import {
  buildGenericSourceQuoteCitationGuidance,
  buildPaperQuoteCitationGuidance,
} from "../src/modules/contextPanel/paperAttribution";
import { BALANCED_EVIDENCE_GUIDANCE } from "../src/shared/quoteGuidance";
import { DEFAULT_SYSTEM_PROMPT } from "../src/utils/llmDefaults";
import type { AgentRuntimeRequest } from "../src/agent/types";
import type { PaperContextRef } from "../src/shared/types";

const BALANCED_EVIDENCE_PHRASES = [
  "important paper-specific claims checkable",
  "not to decorate every paragraph",
  "repetitive citations or low-information quotes",
  "not use them for publication metadata, DOI links, journal names, or source labels alone",
];

const SOURCE_LABEL_PLACEMENT_PHRASES = [
  "Do not append a standalone source label or citation-only final line",
  "source labels on their own line belong only after direct blockquotes",
];

const DIRECT_QUOTE_SAFETY_PHRASES = [
  "Direct quote text must be copied verbatim in the original source language",
  "Copy the Source label string exactly",
  "Do not invent author/year/page/section labels",
  "[[source=...]]",
  "section=...",
  "chunk=...",
];

function assertBalancedEvidenceGuidance(text: string): void {
  const normalized = text.replace(/\s+/g, " ");
  for (const phrase of BALANCED_EVIDENCE_PHRASES) {
    assert.include(normalized, phrase);
  }
  assertSourceLabelPlacementGuidance(text);
}

function assertSourceLabelPlacementGuidance(text: string): void {
  const normalized = text.replace(/\s+/g, " ");
  for (const phrase of SOURCE_LABEL_PLACEMENT_PHRASES) {
    assert.include(normalized, phrase);
  }
}

function assertDirectQuoteSafety(text: string): void {
  const normalized = text.replace(/\s+/g, " ");
  for (const phrase of DIRECT_QUOTE_SAFETY_PHRASES) {
    assert.include(normalized, phrase);
  }
}

function paper(): PaperContextRef {
  return {
    itemId: 11,
    contextItemId: 12,
    title: "Prompt Paper",
    firstCreator: "Smith",
    year: "2024",
  };
}

function request(): AgentRuntimeRequest {
  const paperContext = paper();
  return {
    conversationKey: 909,
    mode: "agent",
    userText: "Explain the method.",
    activeItemId: paperContext.itemId,
    libraryID: 1,
    selectedPaperContexts: [paperContext],
  };
}

function readSkill(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("quote guidance prompts", function () {
  afterEach(function () {
    clearAgentEvidenceCache();
  });

  it("centralizes the balanced evidence wording for runtime prompts", function () {
    assertBalancedEvidenceGuidance(BALANCED_EVIDENCE_GUIDANCE);
  });

  it("keeps direct chat guidance from requesting dangling source labels", function () {
    assertSourceLabelPlacementGuidance(DEFAULT_SYSTEM_PROMPT);
  });

  it("includes balanced evidence guidance in the core agent persona", function () {
    const text = AGENT_PERSONA_INSTRUCTIONS.join("\n");
    assert.include(text, BALANCED_EVIDENCE_GUIDANCE);
    assertDirectQuoteSafety(text);
  });

  it("includes balanced evidence guidance in Codex native MCP instructions", function () {
    const manifest = buildZoteroEnvironmentManifest({
      scope: {
        conversationKey: 1,
        libraryID: 1,
        kind: "paper",
        paperItemID: 11,
        activeItemId: 11,
        activeContextItemId: 12,
        paperTitle: "Prompt Paper",
      },
      mcpEnabled: true,
      mcpReady: true,
    });

    assertBalancedEvidenceGuidance(manifest);
    assertDirectQuoteSafety(manifest);
  });

  it("includes balanced evidence guidance in stable resource context", function () {
    const text = buildAgentStableResourceContextBlock(request());
    assertBalancedEvidenceGuidance(text);
    assertDirectQuoteSafety(text);
  });

  it("includes balanced evidence guidance in paper and source quote helpers", function () {
    const paperGuidance = buildPaperQuoteCitationGuidance(paper()).join("\n");
    const genericGuidance =
      buildGenericSourceQuoteCitationGuidance().join("\n");

    assertBalancedEvidenceGuidance(paperGuidance);
    assertDirectQuoteSafety(paperGuidance);
    assertBalancedEvidenceGuidance(genericGuidance);
    assertDirectQuoteSafety(genericGuidance);
  });

  it("includes balanced evidence guidance in preserved evidence context", async function () {
    const req = request();
    await commitAgentCacheEvidenceActivities({
      conversationKey: req.conversationKey,
      activities: [
        {
          toolName: "paper_read",
          toolLabel: "Read Paper",
          input: { mode: "targeted", query: "method" },
          content: {
            papers: [
              {
                paperContext: paper(),
                sourceKind: "paper_text",
                passages: [
                  {
                    text: "The method used a controlled task.",
                    sourceLabel: "(Smith, 2024)",
                  },
                ],
              },
            ],
          },
          request: req,
          timestamp: 1,
        },
      ],
    });

    const text = buildAgentEvidenceContextBlock({
      conversationKey: req.conversationKey,
      request: req,
    });

    assertBalancedEvidenceGuidance(text);
    assertDirectQuoteSafety(text);
  });

  it("keeps static skill prompts aligned with balanced evidence guidance", function () {
    const skills = [
      "../src/agent/skills/simple-paper-qa.md",
      "../src/agent/skills/compare-papers.md",
      "../src/agent/skills/evidence-based-qa.md",
      "../src/agent/skills/literature-review.md",
    ];

    for (const skill of skills) {
      const text = readSkill(skill);
      assertBalancedEvidenceGuidance(text);
      assertDirectQuoteSafety(text);
    }
  });

  it("guides figure tasks with MinerU cache through extracted PDF crops", async function () {
    const paperContext: PaperContextRef = {
      ...paper(),
      title: "Figure Paper",
      mineruCacheDir: "/tmp/llm-for-zotero-mineru/12",
    };
    const messages = await buildAgentInitialMessages(
      {
        ...request(),
        userText: "Explain Figure 1.",
        selectedPaperContexts: [paperContext],
      },
      [],
      ["analyze-figures"],
    );
    const text = messages.map((message) => message.content).join("\n");

    assert.include(text, "paper_read({ mode:'figures'");
    assert.include(text, "precise PDF crops");
    assert.include(text, "full.md");
    assert.include(text, "do not read or embed MinerU image paths");
    assert.include(text, "/tmp/llm-for-zotero-mineru/12");
    assert.include(text, "Use `paper_read({ mode:'visual'");
    assert.include(text, "only when the user explicitly asks");
    assert.notInclude(text, "read the extracted image path with `file_io`");
  });

  it("describes figure image support generically without naming specific models", function () {
    const text = readSkill("../src/agent/skills/analyze-figures.md");

    assert.include(text, "Visual models");
    for (const modelName of ["GPT-4o", "Codex", "Claude", "Gemini"]) {
      assert.notInclude(text, modelName);
    }
  });
});
