import type { ClaudeQuotaTarget, ProviderQuota } from "../providers/quota";
import { createAbortController } from "../utils/apiHelpers";
import { claudeBridgeFetch } from "./bridgeProcess";

export function parseClaudeQuota(payload: unknown): ProviderQuota | null {
  const raw = payload as { quota?: { windows?: unknown } } | null;
  if (!Array.isArray(raw?.quota?.windows)) return null;
  const windows = raw.quota.windows.flatMap((value: unknown) => {
    if (!value || typeof value !== "object") return [];
    const row = value as Record<string, unknown>;
    if (
      typeof row.usedPercent !== "number" ||
      !Number.isFinite(row.usedPercent) ||
      row.usedPercent < 0
    )
      return [];
    return [
      {
        usedPercent: Math.min(100, row.usedPercent),
        ...(typeof row.durationMins === "number" &&
        Number.isFinite(row.durationMins) &&
        row.durationMins > 0
          ? { durationMins: row.durationMins }
          : {}),
        ...(typeof row.resetsAt === "number" &&
        Number.isFinite(row.resetsAt) &&
        row.resetsAt > 0
          ? { resetsAt: row.resetsAt }
          : {}),
      },
    ];
  });
  return windows.length ? { kind: "usage", provider: "claude", windows } : null;
}

export async function readClaudeQuota(
  target: ClaudeQuotaTarget,
): Promise<ProviderQuota | null> {
  const base = target.bridgeUrl.trim().replace(/\/+$/, "");
  if (!base) return null;
  const query = new URLSearchParams({
    settingSources: target.settingSources,
    conversationKey: String(target.context.conversationKey),
    scopeType: target.context.scopeType,
    scopeId: target.context.scopeId,
  });
  if (target.context.scopeLabel)
    query.set("scopeLabel", target.context.scopeLabel);
  const controller = createAbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await claudeBridgeFetch(`${base}/account-quota?${query}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
      redirect: "error",
      credentials: "omit",
    });
    // Older bridges return 404; SDKs/accounts without usage support return null.
    return response.ok ? parseClaudeQuota(await response.json()) : null;
  } finally {
    clearTimeout(timeout);
  }
}
