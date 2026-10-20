import type { AntigravityQuotaTarget, ProviderQuota } from "../providers/quota";
import { readAgyUsage } from "./agyProcess";

type Window = Extract<ProviderQuota, { kind: "usage" }>["windows"][number];

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The `/usage` command's data, from the json or stream-json output. */
function findUsageData(raw: string): Record<string, unknown> | null {
  const candidates: unknown[] = [];
  try {
    candidates.push(JSON.parse(raw));
  } catch {
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim().startsWith("{")) continue;
      try {
        candidates.push(JSON.parse(line));
      } catch {
        /* not a JSON line */
      }
    }
  }
  for (const candidate of candidates) {
    const command = record(record(candidate).command);
    const data = record(command.data);
    if (Array.isArray(data.groups)) return data;
  }
  return null;
}

/**
 * Which `/usage` group the model draws on: Gemini models share one
 * allowance, Claude and GPT models another. "" when it cannot be told,
 * as for agy's own default model.
 */
function groupForModel(model: string): "gemini" | "3p" | "" {
  const slug = model.trim().toLowerCase();
  if (!slug || slug === "default") return "";
  if (slug.startsWith("gemini")) return "gemini";
  if (/^(claude|gpt|o\d)/.test(slug)) return "3p";
  return "";
}

function groupKind(group: Record<string, unknown>): "gemini" | "3p" | "" {
  const buckets = Array.isArray(group.buckets) ? group.buckets : [];
  const ids = buckets.map((bucket) => String(record(bucket).id ?? ""));
  if (ids.some((id) => id.startsWith("gemini"))) return "gemini";
  if (ids.some((id) => id.startsWith("3p"))) return "3p";
  const name = String(group.name ?? "").toLowerCase();
  if (name.includes("gemini")) return "gemini";
  if (/claude|gpt/.test(name)) return "3p";
  return "";
}

/**
 * agy 1.4.2 `/usage` data: `groups[]` of `{name, buckets[]}`, each bucket
 * `{id, window: "weekly" | "5h", remaining_fraction, reset_time}`. Every
 * bucket becomes a window; those of the group the model does not use are
 * listed but left out of the headline.
 */
export function parseAntigravityQuota(
  raw: string,
  model: string,
): ProviderQuota | null {
  const data = findUsageData(raw);
  if (!data) return null;
  const selected = groupForModel(model);
  const windows: Window[] = [];
  for (const value of data.groups as unknown[]) {
    const group = record(value);
    const label = typeof group.name === "string" ? group.name.trim() : "";
    const kind = groupKind(group);
    const buckets = Array.isArray(group.buckets) ? group.buckets : [];
    for (const bucketValue of buckets) {
      const bucket = record(bucketValue);
      const remaining = Number(bucket.remaining_fraction);
      if (
        bucket.remaining_fraction === null ||
        bucket.remaining_fraction === undefined ||
        !Number.isFinite(remaining)
      )
        continue;
      const usedPercent = Math.min(100, Math.max(0, (1 - remaining) * 100));
      const windowName = String(bucket.window ?? bucket.id ?? "");
      const hours = /^(\d+)h\b/.exec(windowName) ?? /-(\d+)h$/.exec(windowName);
      const resetsAt =
        typeof bucket.reset_time === "string"
          ? Date.parse(bucket.reset_time) / 1000
          : NaN;
      windows.push({
        usedPercent,
        ...(label ? { label } : {}),
        ...(/weekly/i.test(windowName)
          ? { period: "weekly" as const }
          : hours
            ? { durationMins: Number(hours[1]) * 60 }
            : {}),
        ...(Number.isFinite(resetsAt) && resetsAt > 0 ? { resetsAt } : {}),
        ...(selected && kind && kind !== selected ? { secondary: true } : {}),
      });
    }
  }
  return windows.length
    ? { kind: "usage", provider: "antigravity", windows }
    : null;
}

export async function readAntigravityQuota(
  target: AntigravityQuotaTarget,
): Promise<ProviderQuota | null> {
  return parseAntigravityQuota(
    await readAgyUsage(target.binaryPath || undefined),
    target.model,
  );
}
