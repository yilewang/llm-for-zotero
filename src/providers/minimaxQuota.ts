import type { ProviderQuota } from "./types";
import { recordOrEmpty } from "../core/values";

function finite(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

function usedPercent(
  row: Record<string, unknown>,
  period: "interval" | "weekly",
) {
  if (finite(row[`current_${period}_status`]) === 3) return undefined;
  const percent = row[`current_${period}_remaining_percent`];
  if (percent !== undefined && percent !== null) {
    const remaining = finite(percent);
    return remaining !== undefined && remaining >= 0 && remaining <= 100
      ? 100 - remaining
      : undefined;
  }
  const total = finite(row[`current_${period}_total_count`]);
  // MiniMax's official CLI treats count-only legacy responses as remaining.
  // Newer responses can reverse the count semantics, so explicit percentages
  // above always win. A weekly boost changes the display ceiling, not this
  // fraction of the full allowance (e.g. 80% of a boosted plan is 20% used).
  const remaining = finite(row[`current_${period}_usage_count`]);
  return total !== undefined &&
    total > 0 &&
    remaining !== undefined &&
    remaining >= 0 &&
    remaining <= total
    ? 100 * (1 - remaining / total)
    : undefined;
}

/** Exact model, then provider wildcard, then shared general quota; never media. */
function selectModel(
  rows: unknown[],
  model?: string,
): Record<string, unknown> | undefined {
  const records = rows.map(recordOrEmpty);
  const selected = model?.trim().toLowerCase();
  const name = (row: Record<string, unknown>) =>
    typeof row.model_name === "string"
      ? row.model_name.trim().toLowerCase()
      : "";
  if (selected) {
    const exact = records.find((row) => name(row) === selected);
    if (exact) return exact;
    const wildcard = records
      .filter((row) => {
        const pattern = name(row);
        return (
          pattern.length > 1 &&
          pattern.endsWith("*") &&
          selected.startsWith(pattern.slice(0, -1))
        );
      })
      .sort((a, b) => name(b).length - name(a).length)[0];
    if (wildcard) return wildcard;
  }
  return records.find((row) => name(row) === "general");
}

/** Contracts: MiniMax-AI/cli at 06e47c7, see QUOTA.md for pinned sources. */
export function parseMiniMaxQuota(
  value: unknown,
  currency: "USD" | "CNY",
  model?: string,
): ProviderQuota | null {
  const payload = recordOrEmpty(value);
  if (finite(recordOrEmpty(payload.base_resp).status_code) !== 0) return null;
  if ("available_amount" in payload) {
    const amount = finite(payload.available_amount);
    return amount === undefined
      ? null
      : {
          kind: "balance",
          scope: "account",
          balances: [{ currency, amount }],
        };
  }
  if (!Array.isArray(payload.model_remains)) return null;
  const row = selectModel(payload.model_remains, model);
  if (!row) return null;
  const windows = (["interval", "weekly"] as const).flatMap((period) => {
    const used = usedPercent(row, period);
    if (used === undefined) return [];
    const prefix = period === "weekly" ? "weekly_" : "";
    const start = finite(row[`${prefix}start_time`]);
    const end = finite(row[`${prefix}end_time`]);
    const validEnd =
      end !== undefined && end > 0 && Number.isFinite(new Date(end).getTime());
    return [
      {
        usedPercent: used,
        ...(validEnd ? { resetsAt: end / 1000 } : {}),
        ...(validEnd && start !== undefined && start > 0 && end > start
          ? { durationMins: (end - start) / 60000 }
          : {}),
      },
    ];
  });
  return windows.length
    ? { kind: "usage", provider: "minimax", windows }
    : null;
}
