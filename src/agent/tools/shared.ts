import type {
  AgentToolInputValidation,
} from "../types";
import type {
  ChatAttachment,
  PaperContextRef,
} from "../../shared/types";

export type NoteSaveTarget = "item" | "standalone";

export function validateObject<T extends Record<string, unknown>>(
  value: unknown,
): value is T {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function ok<T>(value: T): AgentToolInputValidation<T> {
  return { ok: true, value };
}

export function fail<T>(error: string): AgentToolInputValidation<T> {
  return { ok: false, error };
}

export function normalizePositiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

export function normalizePositiveIntArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const out = value
    .map((entry) => normalizePositiveInt(entry))
    .filter((entry): entry is number => Number.isFinite(entry));
  if (!out.length) return null;
  return Array.from(new Set(out));
}

export function normalizeStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
  if (!out.length) return null;
  return Array.from(new Set(out));
}

export function normalizeToolPaperContext(
  value: Record<string, unknown> | null | undefined,
): PaperContextRef | null {
  if (!value || typeof value !== "object") return null;
  const itemId = normalizePositiveInt(value.itemId);
  const contextItemId = normalizePositiveInt(value.contextItemId);
  if (!itemId || !contextItemId) return null;
  return {
    itemId,
    contextItemId,
    title:
      typeof value.title === "string" && value.title.trim()
        ? value.title.trim()
        : `Paper ${itemId}`,
    attachmentTitle:
      typeof value.attachmentTitle === "string" && value.attachmentTitle.trim()
        ? value.attachmentTitle.trim()
        : undefined,
    citationKey:
      typeof value.citationKey === "string" && value.citationKey.trim()
        ? value.citationKey.trim()
        : undefined,
    firstCreator:
      typeof value.firstCreator === "string" && value.firstCreator.trim()
        ? value.firstCreator.trim()
        : undefined,
    year:
      typeof value.year === "string" && value.year.trim()
        ? value.year.trim()
        : undefined,
    mineruCacheDir:
      typeof value.mineruCacheDir === "string" && value.mineruCacheDir.trim()
        ? value.mineruCacheDir.trim()
        : undefined,
  };
}

/**
 * Reusable JSON Schema fragment for PaperContextRef objects.
 * Use this in tool inputSchemas instead of opaque `additionalProperties: true`.
 */
export const PAPER_CONTEXT_REF_SCHEMA = {
  type: "object" as const,
  description:
    "Paper reference from Zotero context. Use itemId and contextItemId from the context summary.",
  required: ["itemId", "contextItemId"] as const,
  properties: {
    itemId: {
      type: "number" as const,
      description: "Zotero parent item ID",
    },
    contextItemId: {
      type: "number" as const,
      description: "Zotero attachment/context item ID",
    },
    title: { type: "string" as const },
    mineruCacheDir: {
      type: "string" as const,
      description:
        "Optional MinerU cache directory for this paper. Prefer file_io on manifest.json/full.md under this path before raw PDF tools.",
    },
  },
  additionalProperties: false,
};

export function findAttachment(
  attachments: ChatAttachment[] | undefined,
  args: { attachmentId?: string; name?: string },
): ChatAttachment | null {
  const list = Array.isArray(attachments) ? attachments : [];
  if (args.attachmentId) {
    const byId = list.find((entry) => entry.id === args.attachmentId);
    if (byId) return byId;
  }
  if (args.name) {
    const byName = list.find((entry) => entry.name === args.name);
    if (byName) return byName;
  }
  return null;
}
