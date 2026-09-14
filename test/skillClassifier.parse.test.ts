import { semanticFixture } from "./helpers/semanticIntent";
import { assert } from "chai";
import {
  detectTurnIntent as detectTurnIntentResolved,
  parseClassifiedTurnIntent,
  parseSkillRouterResponse,
  resolvePlanSkillRoutingReceipt,
} from "../src/agent/model/semanticIntentService";
import { resolveSkillRouting as resolveSkillRoutingResolved } from "../src/agent/skills/routing";
import type { AgentSkill } from "../src/agent/skills/skillLoader";
import type { AgentRuntimeRequestInput } from "../src/agent/types";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

const completeOutcome = (text: string) => ({
  text,
  completion: { status: "complete" as const },
});

function normalizeRequest(input: AgentRuntimeRequestInput) {
  return resolvedAgentRequest({
    conversationKey: 1,
    mode: "agent",
    libraryID: 1,
    ...input,
  });
}

async function detectTurnIntent(
  ...args: Parameters<typeof detectTurnIntentResolved>
): ReturnType<typeof detectTurnIntentResolved> {
  return detectTurnIntentResolved(normalizeRequest(args[0]), ...args.slice(1));
}

function resolveSkillRouting(
  ...args: Parameters<typeof resolveSkillRoutingResolved>
): ReturnType<typeof resolveSkillRoutingResolved> {
  return resolveSkillRoutingResolved(
    normalizeRequest(args[0]),
    ...args.slice(1),
  );
}

const SKILLS: AgentSkill[] = [
  {
    id: "write-note",
    description: "Create or edit notes",
    version: 1,

    contexts: ["any"],
    activation: "auto",
    instruction: "",
    source: "system",
  },
  {
    id: "compare-papers",
    description: "Compare two papers",
    version: 1,

    contexts: ["any"],
    activation: "auto",
    instruction: "",
    source: "system",
  },
  {
    id: "analyze-figures",
    description: "Analyze figures",
    version: 1,

    contexts: ["any"],
    activation: "auto",
    instruction: "",
    source: "system",
  },
];

describe("parseSkillRouterResponse", function () {
  it("accepts exact evidence text without model-generated offsets", function () {
    const parsed = parseSkillRouterResponse(
      '{"schemaVersion":1,"taskKind":"read","requestedScopes":["paper-set"],"selections":[{"skillId":"compare-papers","requestedScope":"paper-set","evidenceText":"比较这两篇论文"}],"retrievalIntent":"summarize","wantedSections":[]}',
    );
    assert.equal(parsed?.selections[0]?.evidenceText, "比较这两篇论文");
  });

  it("rejects unknown schema versions and malformed occurrences", function () {
    assert.isNull(
      parseSkillRouterResponse(
        '{"schemaVersion":2,"taskKind":"read","requestedScopes":[],"selections":[],"retrievalIntent":"none","wantedSections":[]}',
      ),
    );
    assert.isNull(
      parseSkillRouterResponse(
        '{"schemaVersion":1,"taskKind":"read","requestedScopes":["single-paper"],"selections":[{"skillId":"x","requestedScope":"single-paper","evidenceText":"x","occurrence":-1}],"retrievalIntent":"none","wantedSections":[]}',
      ),
    );
  });
});

describe("resolveSkillRouting classified context gate", function () {
  const LIBRARY_ANALYSIS_SKILL: AgentSkill = {
    id: "library-analysis",
    description: "Analyze your whole library or collection with statistics",
    version: 1,

    contexts: ["library-corpus"],
    activation: "auto",
    instruction: "",
    source: "system",
  };

  it("accepts a classified library skill over a selected collection", function () {
    const resolution = resolveSkillRouting(
      {
        userText: "总结这个文件夹的研究主题",
        selectedCollectionContexts: [
          { collectionId: 1, name: "C", libraryID: 1 },
        ],
        classifiedIntent: {
          semantic: semanticFixture(),
          retrievalIntent: "summarize",
          wantedSections: [],
        },
        forcedSkillIds: [],
      } as any,
      [LIBRARY_ANALYSIS_SKILL],
      ["library-analysis"],
    );

    assert.include(resolution.matchedSkillIds, "library-analysis");
  });

  it("does not force library-analysis without a selected scope", function () {
    const resolution = resolveSkillRouting(
      {
        userText: "总结这个文件夹的研究主题",
        classifiedIntent: {
          semantic: semanticFixture(),
          retrievalIntent: "summarize",
          wantedSections: [],
        },
        forcedSkillIds: [],
      } as any,
      [LIBRARY_ANALYSIS_SKILL],
      [],
    );

    assert.notInclude(resolution.matchedSkillIds, "library-analysis");
  });
});

describe("shared semantic routing service", function () {
  it("preserves a redacted transport failure detail for diagnosis without authorizing fallback", async function () {
    const result = await detectTurnIntent(
      {
        model: "test",
        apiBase: "https://example.invalid",
        apiKey: "private-fixture-key",
        userText: "File my paper",
      } as any,
      [],
      {
        llmCall: async () => {
          throw new Error(
            "Response incomplete: output limit reached; private-fixture-key",
          );
        },
      },
    );
    assert.isNull(result.classifiedIntent);
    assert.include(result.failureDetail || "", "output limit reached");
    assert.notInclude(result.failureDetail || "", "private-fixture-key");
  });
  it("recovers output exhaustion once within the utility budget", async function () {
    const calls: any[] = [];
    const result = await detectTurnIntent(
      {
        model: "deepseek-v4-flash",
        apiBase: "https://api.deepseek.com",
        apiKey: "fixture",
        userText: "File this paper in Bayesian",
        reasoning: { provider: "deepseek", level: "high" },
      } as any,
      [],
      {
        llmCall: async (params) => {
          calls.push(params);
          if (calls.length === 1)
            return {
              text: "partial",
              completion: { status: "incomplete", reason: "output_limit" },
            };
          return completeOutcome(JSON.stringify(semanticResponseFixture()));
        },
      },
    );
    assert.isFalse(result.degraded);
    assert.lengthOf(calls, 2);
    for (const call of calls) {
      assert.isAtMost(call.outputTokenLimit.tokens, 7000);
      assert.notEqual(call.reasoning?.level, "high");
    }
    assert.equal(
      calls[0].outputTokenLimit.tokens,
      calls[1].outputTokenLimit.tokens,
    );
    assert.equal(result.attempts?.[0].reason, "output_limit");
  });

  it("cannot grant authority after two exhausted completions", async function () {
    let calls = 0;
    const result = await detectTurnIntent(
      {
        model: "test",
        apiBase: "https://example.invalid",
        apiKey: "fixture",
        userText: "Move this paper",
      } as any,
      [],
      {
        llmCall: async () => {
          calls++;
          return {
            text: JSON.stringify(semanticResponseFixture()),
            completion: { status: "incomplete", reason: "output_limit" },
          };
        },
      },
    );
    assert.equal(calls, 2);
    assert.isNull(result.classifiedIntent);
    assert.isEmpty(result.skillIds);
    assert.equal(result.failureReason, "output_limit");
  });

  it("interprets configured skill preferences in the same semantic call", async function () {
    let prompt = "";
    const preference =
      "Store my file notes under /notes/academic and preserve Zotero memberships.";
    await detectTurnIntent(
      {
        model: "test",
        apiBase: "https://example.invalid",
        apiKey: "test",
        userText: "Prepare my note",
      } as any,
      [{ ...SKILLS[0], instruction: preference }],
      {
        llmCall: async (params) => {
          prompt = params.prompt;
          return completeOutcome(JSON.stringify(semanticResponseFixture()));
        },
      },
    );
    assert.include(prompt, preference);
  });
  it("uses semantic evidence to activate a manual skill named in ordinary language", async function () {
    const skill = { ...SKILLS[0], activation: "manual" as const };
    const request = {
      model: "test",
      apiBase: "https://example.invalid",
      apiKey: "test",
      userText: "Please use the write-note skill",
    };
    const result = await detectTurnIntent(request as any, [skill], {
      llmCall: async () =>
        completeOutcome(
          JSON.stringify(
            semanticResponseFixture({
              requestedScopes: ["none"],
              selections: [
                {
                  skillId: skill.id,
                  requestedScope: "none",
                  evidenceText: "use the write-note skill",
                },
              ],
            }),
          ),
        ),
    });
    assert.isFalse(result.degraded);
    assert.deepEqual(result.skillIds, [skill.id]);
    assert.deepEqual(
      resolveSkillRouting(request as any, [skill], result.skillIds)
        .matchedSkillIds,
      [skill.id],
    );
  });
  it("reports interpretation unavailable without a configured transport", async function () {
    const result = await detectTurnIntent(
      { model: "test", apiBase: "", userText: "create a note" } as any,
      [],
    );
    assert.isNull(result.classifiedIntent);
    assert.isTrue(result.degraded);
    assert.equal(result.failureReason, "not_configured");
  });
  it("interprets once for actions and skills, including explicitly selected skills", async function () {
    let calls = 0;
    const result = await detectTurnIntent(
      {
        model: "test",
        apiBase: "https://example.invalid",
        apiKey: "test",
        userText: "Use my selected workflow",
        forcedSkillIds: ["write-note"],
      } as any,
      SKILLS,
      {
        llmCall: async () => {
          calls++;
          return completeOutcome(JSON.stringify(semanticResponseFixture()));
        },
      },
    );
    assert.equal(calls, 1);
    assert.equal(result.routingReceipt?.skills[0].source, "explicit");
    assert.equal(result.classifiedIntent?.semantic?.version, 1);
  });
  it("rejects fabricated skill evidence and cannot downgrade to a keyword route", async function () {
    const result = await detectTurnIntent(
      {
        model: "test",
        apiBase: "https://example.invalid",
        apiKey: "test",
        userText: "Explain the paper",
      } as any,
      SKILLS,
      {
        llmCall: async () =>
          completeOutcome(
            JSON.stringify(
              semanticResponseFixture({
                selections: [
                  {
                    skillId: "write-note",
                    requestedScope: "none",
                    evidenceText: "Create a note",
                  },
                ],
              }),
            ),
          ),
      },
    );
    assert.isNull(result.classifiedIntent);
    assert.isEmpty(result.skillIds);
  });
  it("preserves skill provenance and detects changed plan instructions", async function () {
    const result = await detectTurnIntent(
      {
        model: "test",
        apiBase: "https://example.invalid",
        apiKey: "test",
        userText: "Use my selected workflow",
        forcedSkillIds: ["write-note"],
      } as any,
      SKILLS,
      {
        llmCall: async () =>
          completeOutcome(JSON.stringify(semanticResponseFixture())),
      },
    );
    const receipt = {
      ...result.routingReceipt!,
      skills: result.routingReceipt!.skills.map(
        ({ id, version, instructionHash, source }) => ({
          id,
          version,
          instructionHash,
          source,
        }),
      ),
    };
    assert.deepEqual(
      (await resolvePlanSkillRoutingReceipt(receipt, SKILLS)).skillIds,
      ["write-note"],
    );
    assert.deepEqual(
      (
        await resolvePlanSkillRoutingReceipt(
          receipt,
          SKILLS.map((skill) => ({ ...skill, instruction: "Changed" })),
        )
      ).changedExplicitSkillIds,
      ["write-note"],
    );
  });
});
import { semanticResponseFixture } from "./helpers/semanticIntent";
