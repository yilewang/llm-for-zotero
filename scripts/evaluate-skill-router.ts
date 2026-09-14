import { BUILTIN_SKILL_FILES, parseSkill } from "../src/agent/skills/index";
import { detectTurnIntent } from "../src/agent/model/semanticIntentService";
import { resolvedAgentRequest } from "../test/helpers/resolvedAgentRequest";
import { SKILL_ROUTER_SEMANTIC_CORPUS } from "../test/fixtures/skillRouterSemanticCorpus";

const endpoint = process.env.SKILL_ROUTER_EVAL_ENDPOINT?.trim();
const model = process.env.SKILL_ROUTER_EVAL_MODEL?.trim() || "router-eval";
if (!endpoint) {
  throw new Error(
    "Set SKILL_ROUTER_EVAL_ENDPOINT to a real-provider adapter accepting {model,prompt} and returning {text}.",
  );
}

const skills = Object.values(BUILTIN_SKILL_FILES).map(parseSkill);
const totals = new Map<string, { tp: number; fp: number; fn: number }>();
let contextSafetyViolations = 0;

function paper(itemId: number) {
  return {
    itemId,
    contextItemId: itemId + 1000,
    title: `Eval paper ${itemId}`,
  };
}

function addMetric(key: string, tp: number, fp: number, fn: number): void {
  const current = totals.get(key) || { tp: 0, fp: 0, fn: 0 };
  current.tp += tp;
  current.fp += fp;
  current.fn += fn;
  totals.set(key, current);
}

for (const entry of SKILL_ROUTER_SEMANTIC_CORPUS) {
  const selectedPaperContexts =
    entry.context === "single-paper"
      ? [paper(1)]
      : entry.context === "paper-set"
        ? [paper(1), paper(2)]
        : undefined;
  const selectedCollectionContexts =
    entry.context === "library-corpus"
      ? [{ collectionId: 1, libraryID: 1, name: "Evaluation corpus" }]
      : undefined;
  const request = resolvedAgentRequest({
    conversationKey: 1,
    libraryID: 1,
    mode: "agent",
    conversationKind: entry.context === "library-corpus" ? "global" : "paper",
    userText: entry.text,
    selectedPaperContexts,
    selectedCollectionContexts,
    model,
    apiBase: endpoint,
    apiKey: "semantic-eval",
    providerProtocol: "openai_chat_compat",
  });
  const result = await detectTurnIntent(request, skills, {
    llmCall: async ({ prompt }) => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, prompt }),
      });
      if (!response.ok) throw new Error(`Eval adapter HTTP ${response.status}`);
      const payload = (await response.json()) as { text?: unknown };
      if (typeof payload.text !== "string")
        throw new Error("Eval adapter response is missing text");
      return payload.text;
    },
  });
  const actual = new Set(result.skillIds);
  const expected = new Set(entry.expectedSkillIds);
  const tp = [...actual].filter((id) => expected.has(id)).length;
  const fp = [...actual].filter((id) => !expected.has(id)).length;
  const fn = [...expected].filter((id) => !actual.has(id)).length;
  addMetric(`language:${entry.language}`, tp, fp, fn);
  for (const skillId of new Set([...actual, ...expected])) {
    addMetric(
      `skill:${skillId}`,
      actual.has(skillId) && expected.has(skillId) ? 1 : 0,
      actual.has(skillId) && !expected.has(skillId) ? 1 : 0,
      !actual.has(skillId) && expected.has(skillId) ? 1 : 0,
    );
  }
  if (entry.context === "single-paper" && actual.has("compare-papers")) {
    contextSafetyViolations += 1;
  }
  console.log(
    JSON.stringify({
      id: entry.id,
      expected: [...expected],
      actual: [...actual],
    }),
  );
}

let macroPrecision = 0;
let macroRecall = 0;
let languagePrecisionViolation = false;
for (const [key, value] of totals) {
  const precision = value.tp + value.fp ? value.tp / (value.tp + value.fp) : 1;
  const recall = value.tp + value.fn ? value.tp / (value.tp + value.fn) : 1;
  macroPrecision += precision;
  macroRecall += recall;
  if (key.startsWith("language:") && precision < 0.9) {
    languagePrecisionViolation = true;
  }
  console.log(JSON.stringify({ key, ...value, precision, recall }));
}
macroPrecision /= Math.max(1, totals.size);
macroRecall /= Math.max(1, totals.size);
console.log(
  JSON.stringify({ contextSafetyViolations, macroPrecision, macroRecall }),
);
if (
  contextSafetyViolations ||
  languagePrecisionViolation ||
  macroPrecision < 0.95 ||
  macroRecall < 0.85
) {
  process.exitCode = 1;
}
