import type { AgentSkill } from "../skills/skillLoader";
import type { AgentRuntimeRequest } from "../types";
import { resolveSkillRequestContext } from "../skills/contextEligibility";
import { sha256Text } from "../store/journalRecoveryBlobStore";
import { canonicalJson } from "../services/libraryMutation/canonicalJson";
import {
  SKILL_ROUTER_SCHEMA_VERSION,
  type SkillRequestedScope,
  type SkillRouterResponseV1,
  type SkillRouterSelection,
  type PlanSkillRoutingReceipt,
  type ValidatedSkillActivation,
} from "../skills/routingTypes";
import {
  VALID_RETRIEVAL_INTENTS,
  VALID_PAPER_TARGET_INTENTS,
  VALID_EXTERNAL_SEARCH_INTENTS,
  VALID_WANTED_SECTIONS,
} from "./semanticIntentSchema";
import { extractJsonObject } from "./semanticJson";

const VALID_REQUESTED_SCOPES = new Set<SkillRequestedScope>([
  "none",
  "single-paper",
  "paper-set",
  "library-corpus",
  "note",
  "visual-input",
]);
const VALID_TASK_KINDS = new Set(["read", "write", "mixed"]);

export function parseSkillRouterResponse(
  raw: string,
): SkillRouterResponseV1 | null {
  const record = extractJsonObject(raw);
  if (!record || record.schemaVersion !== SKILL_ROUTER_SCHEMA_VERSION)
    return null;
  if (
    typeof record.taskKind !== "string" ||
    !VALID_TASK_KINDS.has(record.taskKind)
  )
    return null;
  if (
    !Array.isArray(record.requestedScopes) ||
    !Array.isArray(record.selections)
  )
    return null;
  const requestedScopes = record.requestedScopes.filter(
    (value): value is SkillRequestedScope =>
      typeof value === "string" &&
      VALID_REQUESTED_SCOPES.has(value as SkillRequestedScope),
  );
  if (requestedScopes.length !== record.requestedScopes.length) return null;
  const selections: SkillRouterSelection[] = [];
  for (const value of record.selections) {
    if (!value || typeof value !== "object") return null;
    const selection = value as Record<string, unknown>;
    if (
      typeof selection.skillId !== "string" ||
      typeof selection.requestedScope !== "string" ||
      !VALID_REQUESTED_SCOPES.has(
        selection.requestedScope as SkillRequestedScope,
      ) ||
      typeof selection.evidenceText !== "string" ||
      !selection.evidenceText
    )
      return null;
    if (
      selection.occurrence !== undefined &&
      (!Number.isInteger(selection.occurrence) ||
        Number(selection.occurrence) < 0)
    )
      return null;
    selections.push({
      skillId: selection.skillId,
      requestedScope: selection.requestedScope as SkillRequestedScope,
      evidenceText: selection.evidenceText,
      ...(selection.occurrence === undefined
        ? {}
        : { occurrence: Number(selection.occurrence) }),
    });
  }
  const retrievalIntent =
    typeof record.retrievalIntent === "string" &&
    VALID_RETRIEVAL_INTENTS.has(record.retrievalIntent)
      ? (record.retrievalIntent as SkillRouterResponseV1["retrievalIntent"])
      : null;
  if (!retrievalIntent) return null;
  const paperTargetIntent =
    typeof record.paperTargetIntent === "string" &&
    VALID_PAPER_TARGET_INTENTS.has(record.paperTargetIntent)
      ? (record.paperTargetIntent as NonNullable<
          SkillRouterResponseV1["paperTargetIntent"]
        >)
      : undefined;
  const externalSearchIntent =
    typeof record.externalSearchIntent === "string" &&
    VALID_EXTERNAL_SEARCH_INTENTS.has(record.externalSearchIntent)
      ? (record.externalSearchIntent as NonNullable<
          SkillRouterResponseV1["externalSearchIntent"]
        >)
      : undefined;
  const deliverableIntent = ["chat", "document", "unspecified"].includes(
    String(record.deliverableIntent),
  )
    ? (record.deliverableIntent as NonNullable<
        SkillRouterResponseV1["deliverableIntent"]
      >)
    : undefined;
  const documentKinds = new Set([
    "research_brief",
    "literature_review",
    "comparison",
    "report",
    "guide",
    "custom",
  ]);
  const documentKind = documentKinds.has(String(record.documentKind))
    ? (record.documentKind as NonNullable<
        SkillRouterResponseV1["documentKind"]
      >)
    : undefined;
  if (deliverableIntent === "document" && !documentKind) return null;
  const wantedSections = Array.isArray(record.wantedSections)
    ? record.wantedSections.filter(
        (value): value is "methods" | "results" | "limitations" =>
          typeof value === "string" && VALID_WANTED_SECTIONS.has(value),
      )
    : [];
  return {
    schemaVersion: 1,
    taskKind: record.taskKind as SkillRouterResponseV1["taskKind"],
    queryLanguage:
      typeof record.queryLanguage === "string"
        ? record.queryLanguage.trim().toLowerCase().slice(0, 12) || undefined
        : undefined,
    requestedScopes,
    selections,
    retrievalIntent,
    deliverableIntent,
    documentKind,
    paperTargetIntent,
    externalSearchIntent,
    wantedSections,
  };
}

function resolveEvidenceSpan(
  message: string,
  evidenceText: string,
  occurrence = 0,
): { text: string; start: number; end: number } | null {
  let start = -1;
  let from = 0;
  for (let index = 0; index <= occurrence; index++) {
    start = message.indexOf(evidenceText, from);
    if (start < 0) return null;
    from = start + evidenceText.length;
  }
  return { text: evidenceText, start, end: start + evidenceText.length };
}

function isScopeCompatible(
  skill: AgentSkill,
  scope: SkillRequestedScope,
): boolean {
  if (skill.contexts.includes("any")) return true;
  return scope !== "none" && skill.contexts.includes(scope);
}

async function hashInstruction(skill: AgentSkill): Promise<string> {
  return `sha256:${await sha256Text(skill.instruction)}`;
}

export async function hashSkillManifest(
  skills: ReadonlyArray<AgentSkill>,
): Promise<string> {
  const canonical = skills
    .map((skill) => ({
      id: skill.id,
      version: skill.version,
      description: skill.description,
      contexts: [...skill.contexts].sort(),
      activation: skill.activation,
      supersedes: [...(skill.supersedes || [])].sort(),
      instruction: skill.instruction,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return `sha256:${await sha256Text(canonicalJson(canonical))}`;
}

export async function validateSkillRouterSelections(params: {
  response: SkillRouterResponseV1;
  request: AgentRuntimeRequest;
  skills: ReadonlyArray<AgentSkill>;
}): Promise<ValidatedSkillActivation[]> {
  const byId = new Map(params.skills.map((skill) => [skill.id, skill]));
  const available = new Set(
    resolveSkillRequestContext(params.request).availableContexts,
  );
  const requested = new Set(params.response.requestedScopes);
  const validated: ValidatedSkillActivation[] = [];
  for (const selection of params.response.selections) {
    const skill = byId.get(selection.skillId);
    if (!skill || !requested.has(selection.requestedScope)) continue;
    if (!isScopeCompatible(skill, selection.requestedScope)) continue;
    if (
      !skill.contexts.includes("any") &&
      !available.has(selection.requestedScope as never)
    )
      continue;
    const evidence = resolveEvidenceSpan(
      params.request.userText || "",
      selection.evidenceText,
      selection.occurrence || 0,
    );
    if (!evidence) continue;
    validated.push({
      id: skill.id,
      source: "automatic",
      requestedScope: selection.requestedScope,
      evidence,
      version: skill.version,
      instructionHash: await hashInstruction(skill),
    });
  }
  return validated;
}

export async function buildExplicitActivations(
  request: AgentRuntimeRequest,
  skills: ReadonlyArray<AgentSkill>,
): Promise<ValidatedSkillActivation[]> {
  const forced = new Set(request.forcedSkillIds || []);
  const available = resolveSkillRequestContext(request).availableContexts;
  const fallbackScope: SkillRequestedScope =
    available.find((context) => context !== "any") || "none";
  return Promise.all(
    skills
      .filter((skill) => forced.has(skill.id))
      .map(async (skill) => ({
        id: skill.id,
        source: "explicit" as const,
        requestedScope: fallbackScope,
        version: skill.version,
        instructionHash: await hashInstruction(skill),
      })),
  );
}

export function reduceValidatedActivations(
  activations: ValidatedSkillActivation[],
  skills: ReadonlyArray<AgentSkill>,
): ValidatedSkillActivation[] {
  const explicit = activations.filter((entry) => entry.source === "explicit");
  const explicitIds = new Set(explicit.map((entry) => entry.id));
  const automatic = activations.filter((entry) => entry.source === "automatic");
  const superseded = new Set<string>();
  const skillsById = new Map(skills.map((skill) => [skill.id, skill]));
  for (const activation of automatic) {
    for (const id of skillsById.get(activation.id)?.supersedes || []) {
      if (!explicitIds.has(id)) superseded.add(id);
    }
  }
  const seen = new Set<string>();
  const reducedAutomatic = automatic
    .filter((entry) => !superseded.has(entry.id))
    .sort(
      (left, right) =>
        (left.evidence?.start ?? Number.MAX_SAFE_INTEGER) -
          (right.evidence?.start ?? Number.MAX_SAFE_INTEGER) ||
        left.id.localeCompare(right.id),
    )
    .filter((entry) => {
      const key = `${entry.id}\u0000${entry.requestedScope}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 3);
  return [...explicit, ...reducedAutomatic];
}

export async function resolvePlanSkillRoutingReceipt(
  receipt: PlanSkillRoutingReceipt | undefined,
  skills: ReadonlyArray<AgentSkill>,
): Promise<{
  skillIds: string[];
  changedAutomaticSkillIds: string[];
  changedExplicitSkillIds: string[];
}> {
  if (!receipt) {
    return {
      skillIds: [],
      changedAutomaticSkillIds: [],
      changedExplicitSkillIds: [],
    };
  }
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  const skillIds: string[] = [];
  const changedAutomaticSkillIds: string[] = [];
  const changedExplicitSkillIds: string[] = [];
  for (const routed of receipt.skills) {
    const current = byId.get(routed.id);
    const unchanged = Boolean(
      current &&
      current.version === routed.version &&
      (await hashInstruction(current)) === routed.instructionHash,
    );
    if (unchanged) {
      skillIds.push(routed.id);
    } else if (routed.source === "explicit") {
      changedExplicitSkillIds.push(routed.id);
    } else {
      changedAutomaticSkillIds.push(routed.id);
    }
  }
  return { skillIds, changedAutomaticSkillIds, changedExplicitSkillIds };
}
