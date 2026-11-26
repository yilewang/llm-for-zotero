import type { MaterialRef } from "../documents/materialRef";
import type { AgentExecutionContext, AgentRunEventRecord } from "../types";
import { ExecutionCheckpointFold } from "./checkpointEvents";
import type { ExecutionCheckpoint } from "./types";
import { recordOrNull } from "../../core/values";

function requiredText(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${label} must be a non-empty string`);
  return normalized;
}

export function materialRefKey(reference: MaterialRef): string {
  return `${requiredText(reference.documentId, "Material document ID")}:${reference.documentVersion}:${requiredText(reference.contentHash, "Material content hash")}`;
}

export function ordinaryExecutionTaskId(
  executionId: string,
  modelTaskId: string,
): string {
  const owner = requiredText(executionId, "Execution ID");
  const raw = requiredText(modelTaskId, "Task ID");
  const prefix = `${owner}:task:`;
  const local = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(local)) {
    throw new Error(
      "Task IDs must use 1-128 letters, numbers, dots, underscores, or hyphens",
    );
  }
  return `${prefix}${local}`;
}

export function createEmptyExecutionCheckpoint(
  context: AgentExecutionContext,
  now = Date.now(),
): ExecutionCheckpoint {
  return {
    version: 1,
    executionId: context.executionId,
    conversationKey: context.conversationKey,
    conversationGeneration: context.conversationGeneration,
    tasks: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** Refuse a checkpoint that another execution owns or a newer build wrote. */
export function assertCheckpointOwner(
  checkpoint: ExecutionCheckpoint,
  context: AgentExecutionContext,
): void {
  if (checkpoint.version !== 1) {
    throw new Error("Unsupported execution checkpoint version");
  }
  if (
    checkpoint.executionId !== context.executionId ||
    checkpoint.conversationKey !== context.conversationKey ||
    checkpoint.conversationGeneration !== context.conversationGeneration
  ) {
    throw new Error("Execution checkpoint belongs to another execution");
  }
}

/**
 * Collect only explicit journal-reference fields from a persisted tool result.
 * The traversal lets composite tools expose per-item actions without copying
 * their journal payloads into the execution checkpoint.
 */
export function collectJournalActionIds(value: unknown): string[] {
  const actionIds = new Set<string>();
  const seen = new Set<object>();
  let visited = 0;
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > 12 || visited >= 10_000 || !candidate) return;
    if (typeof candidate !== "object") return;
    if (seen.has(candidate)) return;
    seen.add(candidate);
    visited += 1;
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry, depth + 1);
      return;
    }
    const entry = candidate as Record<string, unknown>;
    if (typeof entry.actionId === "string" && entry.actionId.trim()) {
      actionIds.add(entry.actionId.trim());
    }
    if (Array.isArray(entry.actionIds)) {
      for (const actionId of entry.actionIds) {
        if (typeof actionId === "string" && actionId.trim()) {
          actionIds.add(actionId.trim());
        }
      }
    }
    for (const nested of Object.values(entry)) visit(nested, depth + 1);
  };
  visit(value, 0);
  return [...actionIds];
}

/** Narrow an untrusted persisted payload to the one material identity. */
export function parseMaterialRef(value: unknown): MaterialRef | null {
  const candidate = recordOrNull(value);
  if (
    !candidate ||
    typeof candidate.documentId !== "string" ||
    !Number.isSafeInteger(candidate.documentVersion) ||
    Number(candidate.documentVersion) < 1 ||
    typeof candidate.contentHash !== "string"
  ) {
    return null;
  }
  return {
    documentId: candidate.documentId,
    documentVersion: Number(candidate.documentVersion),
    contentHash: candidate.contentHash,
  };
}

/**
 * A run's ledger as its stored events last proved it: the whole ledgers and
 * the deltas between them, folded in order (`checkpointEvents.ts`).
 */
export function latestExecutionCheckpoint(
  events: readonly AgentRunEventRecord[],
): ExecutionCheckpoint | undefined {
  const fold = new ExecutionCheckpointFold();
  for (const event of events) fold.apply(event.payload);
  return fold.latest;
}
