import { ToolInputRejection } from "../tools/execution/failure";
import { validateObject } from "../tools/shared";
import type { ResearchCorpusItem, ResearchCriterion } from "./types";

export const SCREENING_STATUSES = new Set<
  ResearchCorpusItem["screeningStatus"]
>([
  "pending",
  "candidate",
  "included",
  "excluded",
  "unresolved",
  "unreadable",
  "missing",
]);
export const NARRATIVE_ROLES = [
  "central_evidence",
  "supporting_evidence",
  "contradictory_evidence",
  "theoretical_foundation",
  "methodological_contribution",
  "historical_context",
  "tangential_context",
  "unresolved",
] as const;
export function isCriterionCompleteScreeningDecision(params: {
  entry: ResearchCorpusItem;
  criteria: readonly ResearchCriterion[];
  totalItems: number;
  deepReadPlanned: number;
}): boolean {
  const { entry, criteria } = params;
  if (entry.screeningStatus === "missing") return true;
  if (!criteria.length) {
    return !["pending", "candidate"].includes(entry.screeningStatus);
  }
  const results = criteria.map(
    (criterion) => entry.criterionResults[criterion.id],
  );
  if (results.some((result) => !result)) return false;
  if (["unresolved", "unreadable"].includes(entry.screeningStatus)) {
    return results.includes("unknown");
  }
  if (entry.screeningStatus === "included") {
    return criteria.every((criterion) => {
      const result = entry.criterionResults[criterion.id];
      return criterion.kind === "include"
        ? result === "met"
        : result === "not_met";
    });
  }
  if (entry.screeningStatus === "excluded") {
    const criteriaExcludePaper = criteria.some((criterion) => {
      const result = entry.criterionResults[criterion.id];
      return (
        (criterion.kind === "include" && result === "not_met") ||
        (criterion.kind === "exclude" && result === "met")
      );
    });
    if (criteriaExcludePaper) return true;

    // In a bounded deep-reading plan, screening is also a relative ranking:
    // papers can satisfy every absolute criterion while still falling outside
    // the strongest subset selected for body reading. Preserve that honest
    // distinction instead of forcing the model to falsify criterion results.
    return (
      params.deepReadPlanned > 0 &&
      params.deepReadPlanned < params.totalItems &&
      Boolean(entry.decisionReason?.trim())
    );
  }
  return true;
}
export function getTerminalScreeningDecisionError(params: {
  screeningStatus: ResearchCorpusItem["screeningStatus"];
  criterionResults: Readonly<Record<string, "met" | "not_met" | "unknown">>;
  decisionReason?: string;
  criteria: readonly ResearchCriterion[];
  totalItems: number;
  deepReadPlanned: number;
}): string | undefined {
  if (["pending", "candidate", "missing"].includes(params.screeningStatus)) {
    return undefined;
  }
  const entry = {
    screeningStatus: params.screeningStatus,
    criterionResults: params.criterionResults,
    decisionReason: params.decisionReason,
  } as ResearchCorpusItem;
  if (
    isCriterionCompleteScreeningDecision({
      entry,
      criteria: params.criteria,
      totalItems: params.totalItems,
      deepReadPlanned: params.deepReadPlanned,
    })
  ) {
    return undefined;
  }
  const rendered = params.criteria
    .map(
      (criterion) =>
        `${criterion.id} (${criterion.kind})=${
          params.criterionResults[criterion.id] || "missing"
        }`,
    )
    .join(", ");
  if (params.screeningStatus === "included") {
    return `screeningStatus "included" is inconsistent with criterionResults: include criteria must be "met" and exclude criteria must be "not_met". Received ${rendered}`;
  }
  if (params.screeningStatus === "excluded") {
    return `screeningStatus "excluded" needs an include criterion marked "not_met", an exclude criterion marked "met", or an explicit decisionReason for relative ranking within a bounded deep-read subset. Received ${rendered}`;
  }
  return `screeningStatus "${params.screeningStatus}" requires at least one criterion marked "unknown". Received ${rendered}`;
}
export function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ToolInputRejection(`${label} must be a non-empty string`);
  }
  return value.trim();
}
export function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value))
    throw new ToolInputRejection(`${label} must be an array`);
  return value.map((entry, index) => string(entry, `${label}[${index}]`));
}
export function positiveInt(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new ToolInputRejection(`${label} must be a positive integer`);
  }
  return Number(value);
}
export function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80);
}
export function parseCriterionResults(
  value: unknown,
  allowed: Set<string>,
  label: string,
): Record<string, "met" | "not_met" | "unknown"> {
  if (!validateObject<Record<string, unknown>>(value)) {
    throw new ToolInputRejection(`${label} must be an object`);
  }
  const out: Record<string, "met" | "not_met" | "unknown"> = {};
  for (const [criterionId, result] of Object.entries(value)) {
    if (!allowed.has(criterionId)) {
      throw new ToolInputRejection(
        `${label} references unknown criterion ${criterionId}`,
      );
    }
    if (!new Set(["met", "not_met", "unknown"]).has(String(result))) {
      throw new ToolInputRejection(`${label}.${criterionId} is invalid`);
    }
    out[criterionId] = result as "met" | "not_met" | "unknown";
  }
  return out;
}
