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
import {
  AGENT_ACTION_CONTRACT,
  PAPER_CITATION_CONTRACT,
  CORE_RESEARCH_CONTRACT,
  RUNTIME_CAPABILITY_CONTEXT,
} from "../src/shared/instructionContracts";
import { BALANCED_EVIDENCE_GUIDANCE } from "../src/shared/quoteGuidance";
import { DEFAULT_SYSTEM_PROMPT } from "../src/utils/llmDefaults";
import type {
  AgentRuntimeRequest,
  AgentRuntimeRequestInput,
} from "../src/agent/types";
import type { PaperContextRef } from "../src/shared/types";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

const BALANCED_EVIDENCE_PHRASES = [
  "important paper-specific claims checkable",
  "not to decorate every paragraph",
  "quote or anchor 1-3 high-signal snippets",
  "After a direct quote, do not merely paraphrase it",
  "source labels on their own line belong only after direct blockquotes",
  "Paper titles, headings, author lists, journal names, DOI blocks, and source labels are metadata, not direct evidence",
];

const DIRECT_QUOTE_SAFETY_PHRASES = [
  "copied verbatim in the original source language",
  "put the sourceLabel on the next non-empty line",
  "Do not invent author/year/page/section labels",
  "[[source=...]]",
  "chunk=...",
];

function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  return text.split(needle).length - 1;
}

function fingerprintText(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function assertCanonicalCitationContract(text: string): void {
  assert.equal(countOccurrences(text, PAPER_CITATION_CONTRACT), 1);
  for (const phrase of [
    ...BALANCED_EVIDENCE_PHRASES,
    ...DIRECT_QUOTE_SAFETY_PHRASES,
  ]) {
    assert.include(text.replace(/\s+/g, " "), phrase);
  }
}

function paper(itemId = 11): PaperContextRef {
  return {
    itemId,
    contextItemId: itemId + 1,
    title: `Prompt Paper ${itemId}`,
    firstCreator: "Smith",
    year: "2024",
  };
}

function request(
  overrides: Partial<AgentRuntimeRequestInput> = {},
): AgentRuntimeRequest {
  const paperContext = paper();
  return resolvedAgentRequest({
    conversationKey: 909,
    mode: "agent",
    userText: "Explain the method.",
    activeItemId: paperContext.itemId,
    libraryID: 1,
    conversationKind: "paper",
    selectedPaperContexts: [paperContext],
    fullTextPaperContexts: [paperContext, paper(21)],
    ...overrides,
  });
}

function readSkill(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("quote guidance prompts", function () {
  afterEach(function () {
    clearAgentEvidenceCache();
  });

  it("preserves the proven evidence wording inside one canonical contract", function () {
    assert.include(PAPER_CITATION_CONTRACT, BALANCED_EVIDENCE_GUIDANCE);
    assert.equal(fingerprintText(PAPER_CITATION_CONTRACT), "fnv1a32-61855269");
    assertCanonicalCitationContract(PAPER_CITATION_CONTRACT);
  });

  it("includes the canonical contract once in direct chat and the agent persona", function () {
    assertCanonicalCitationContract(DEFAULT_SYSTEM_PROMPT);
    assert.include(DEFAULT_SYSTEM_PROMPT, CORE_RESEARCH_CONTRACT);

    const persona = AGENT_PERSONA_INSTRUCTIONS.join("\n");
    assertCanonicalCitationContract(persona);
    assert.include(persona, CORE_RESEARCH_CONTRACT);
  });

  it("includes the canonical contract once in an assembled multi-paper agent request", async function () {
    const messages = await buildAgentInitialMessages(request(), [], []);
    const text = messages.map((message) => message.content).join("\n");

    assertCanonicalCitationContract(text);
    assert.equal(countOccurrences(text, BALANCED_EVIDENCE_GUIDANCE), 1);
  });

  it("includes the canonical contract once in Codex native MCP instructions", function () {
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

    assertCanonicalCitationContract(manifest);
    for (const contract of [
      CORE_RESEARCH_CONTRACT,
      AGENT_ACTION_CONTRACT,
      RUNTIME_CAPABILITY_CONTEXT,
    ]) {
      assert.include(manifest, contract);
    }
  });

  it("keeps paper, source, stable-context, and cache helpers data-only", async function () {
    const req = request();
    const helperText = [
      buildAgentStableResourceContextBlock(req),
      buildPaperQuoteCitationGuidance(paper()).join("\n"),
      buildGenericSourceQuoteCitationGuidance().join("\n"),
    ].join("\n");

    assert.notInclude(helperText, BALANCED_EVIDENCE_GUIDANCE);
    assert.notInclude(helperText, PAPER_CITATION_CONTRACT);
    assert.include(helperText, "sourceLabel");

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

    const cached = buildAgentEvidenceContextBlock({
      conversationKey: req.conversationKey,
      request: req,
    });
    assert.notInclude(cached, BALANCED_EVIDENCE_GUIDANCE);
    assert.include(
      cached,
      "citation data governed by the system citation contract",
    );
  });

  it("keeps stock skills free of the shared citation policy", function () {
    const skills = [
      "../src/agent/skills/simple-paper-qa.md",
      "../src/agent/skills/compare-papers.md",
      "../src/agent/skills/evidence-based-qa.md",
      "../src/agent/skills/literature-review.md",
      "../src/agent/skills/analyze-figures.md",
      "../src/agent/skills/library-analysis.md",
      "../src/agent/skills/import-cited-reference.md",
      "../src/agent/skills/write-note.md",
    ];

    for (const skill of skills) {
      const text = readSkill(skill);
      assert.notInclude(text, BALANCED_EVIDENCE_GUIDANCE);
      assert.notInclude(text, PAPER_CITATION_CONTRACT);
    }
  });

  it("injects figure guidance only for figure intent or the matched figure skill", async function () {
    const paperContext: PaperContextRef = {
      ...paper(),
      title: "Figure Paper",
      mineruCacheDir: "/tmp/llm-for-zotero-mineru/12",
    };
    const plainRequest = request({
      userText: "Explain the main result.",
      selectedPaperContexts: [paperContext],
      fullTextPaperContexts: [],
    });
    const unmatched = await buildAgentInitialMessages(plainRequest, [], []);
    const conceptualGraphQuestion = await buildAgentInitialMessages(
      request({
        userText: "Explain graph neural networks and image representations.",
        selectedPaperContexts: [paperContext],
        fullTextPaperContexts: [],
      }),
      [],
      [],
    );
    const intentMatched = await buildAgentInitialMessages(
      request({
        userText: "Explain Figure 1.",
        selectedPaperContexts: [paperContext],
        fullTextPaperContexts: [],
      }),
      [],
      [],
    );
    const matched = await buildAgentInitialMessages(
      plainRequest,
      [],
      ["analyze-figures"],
    );

    for (const messages of [unmatched, conceptualGraphQuestion]) {
      const unmatchedText = messages
        .map((message) => message.content)
        .join("\n");
      assert.notInclude(unmatchedText, "Available MinerU cache directories");
      assert.notInclude(unmatchedText, "For figure workflows");
      assert.notInclude(unmatchedText, "paper_read({ mode:'figures'");
    }
    for (const messages of [intentMatched, matched]) {
      const matchedText = messages.map((message) => message.content).join("\n");
      assert.include(matchedText, "paper_read({ mode:'figures'");
      assert.include(matchedText, "precise PDF crops");
      assert.include(matchedText, "/tmp/llm-for-zotero-mineru/12");
    }
  });

  it("describes image support generically without naming model vendors", function () {
    const text = readSkill("../src/agent/skills/analyze-figures.md");

    assert.include(text, "Visual models");
    for (const modelName of ["GPT-4o", "Codex", "Claude", "Gemini"]) {
      assert.notInclude(text, modelName);
    }
  });
});
