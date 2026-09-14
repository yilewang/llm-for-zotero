import type { ClassifiedTurnIntent } from "../types";
import { parseActionIntents } from "./actionIntent";
import { parseSemanticDecisions } from "./semanticDecisions";

export const VALID_RETRIEVAL_INTENTS = new Set([
  "enumerate",
  "verify",
  "summarize",
  "none",
]);
export const VALID_PAPER_TARGET_INTENTS = new Set([
  "active",
  "added",
  "all_visible",
  "unspecified",
]);
export const VALID_EXTERNAL_SEARCH_INTENTS = new Set([
  "none",
  "web",
  "literature",
  "both",
]);
export const VALID_WANTED_SECTIONS = new Set([
  "methods",
  "results",
  "limitations",
]);

/** Decode the complete semantic decision schema; missing decisions grant no defaults. */
export function parseClassifiedTurnIntent(
  raw: string,
): ClassifiedTurnIntent | null {
  if (!raw) return null;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as {
    retrievalIntent?: unknown;
    paperTargetIntent?: unknown;
    externalSearchIntent?: unknown;
    deliverableIntent?: unknown;
    documentKind?: unknown;
    wantedSections?: unknown;
    queryLanguage?: unknown;
    writeDisposition?: unknown;
    actionIntents?: unknown;
  };
  const retrievalIntent =
    typeof record.retrievalIntent === "string"
      ? record.retrievalIntent.trim()
      : "";
  if (!VALID_RETRIEVAL_INTENTS.has(retrievalIntent)) return null;
  const paperTargetIntent =
    typeof record.paperTargetIntent === "string" &&
    VALID_PAPER_TARGET_INTENTS.has(record.paperTargetIntent.trim())
      ? (record.paperTargetIntent.trim() as NonNullable<
          ClassifiedTurnIntent["paperTargetIntent"]
        >)
      : undefined;
  const externalSearchIntent =
    typeof record.externalSearchIntent === "string" &&
    VALID_EXTERNAL_SEARCH_INTENTS.has(record.externalSearchIntent.trim())
      ? (record.externalSearchIntent.trim() as NonNullable<
          ClassifiedTurnIntent["externalSearchIntent"]
        >)
      : undefined;
  const deliverableIntent = ["chat", "document", "unspecified"].includes(
    String(record.deliverableIntent),
  )
    ? (record.deliverableIntent as NonNullable<
        ClassifiedTurnIntent["deliverableIntent"]
      >)
    : undefined;
  if (!paperTargetIntent || !externalSearchIntent || !deliverableIntent)
    return null;
  const documentKind = [
    "research_brief",
    "literature_review",
    "comparison",
    "report",
    "guide",
    "custom",
  ].includes(String(record.documentKind))
    ? (record.documentKind as NonNullable<ClassifiedTurnIntent["documentKind"]>)
    : undefined;
  if (deliverableIntent === "document" && !documentKind) return null;
  if (
    !Array.isArray(record.wantedSections) ||
    !record.wantedSections.every(
      (value) => typeof value === "string" && VALID_WANTED_SECTIONS.has(value),
    )
  )
    return null;
  const wantedSections =
    record.wantedSections as ClassifiedTurnIntent["wantedSections"];
  const queryLanguage =
    typeof record.queryLanguage === "string" && record.queryLanguage.trim()
      ? record.queryLanguage.trim().toLowerCase().slice(0, 12)
      : undefined;
  const actionIntents = parseActionIntents(record.actionIntents);
  if (
    !Array.isArray(record.actionIntents) ||
    record.actionIntents.length !== actionIntents.length
  )
    return null;
  if (
    !["none", "required", "uncertain"].includes(String(record.writeDisposition))
  )
    return null;
  if (
    record.writeDisposition === "none" &&
    actionIntents.some((action) => action.operation !== "read_full")
  )
    return null;

  let writeDisposition = record.writeDisposition as NonNullable<
    ClassifiedTurnIntent["writeDisposition"]
  >;
  if (writeDisposition === "required" && !actionIntents.length) {
    // "Write a literature review" is a document deliverable produced by
    // submit_document, not a library write. A required disposition with no
    // library action can only mean the model conflated the two; keep the
    // interpretation and record that nothing writes to the library.
    if (deliverableIntent !== "document") return null;
    writeDisposition = "none";
  }
  return {
    retrievalIntent: retrievalIntent as ClassifiedTurnIntent["retrievalIntent"],
    ...(paperTargetIntent ? { paperTargetIntent } : {}),
    ...(externalSearchIntent ? { externalSearchIntent } : {}),
    ...(deliverableIntent ? { deliverableIntent } : {}),
    ...(documentKind ? { documentKind } : {}),
    wantedSections,
    queryLanguage,
    writeDisposition,
    actionInterpretationSource: "semantic",
    actionIntents,
  };
}

/** Stored interpretations are decoded, never reconstructed from historical prose. */
export function decodeStoredSemanticIntent(
  value: unknown,
): ClassifiedTurnIntent {
  if (!value || typeof value !== "object")
    throw new Error("Stored semantic intent is unavailable");
  const record = value as ClassifiedTurnIntent;
  const semantic = record.semantic;
  const parsed = parseClassifiedTurnIntent(JSON.stringify(value));
  const decisions = parseSemanticDecisions({ decisions: semantic });
  if (
    !parsed ||
    !decisions ||
    semantic?.version !== 1 ||
    typeof semantic.id !== "string" ||
    !Number.isSafeInteger(semantic.revision) ||
    semantic.revision < 1 ||
    typeof semantic.inputDigest !== "string"
  ) {
    throw new Error("Stored semantic intent is invalid");
  }
  return {
    ...parsed,
    semantic: {
      ...decisions,
      version: 1,
      id: semantic.id,
      revision: semantic.revision,
      inputDigest: semantic.inputDigest,
      provenance: semantic.provenance,
    },
  };
}
