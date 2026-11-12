import type { RuntimeAccountQuota } from "../runtime.js";

type UsageQuery = {
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<unknown>;
  close(): void;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** SDK 0.3.220 get_usage: utilization is already a percentage, not a fraction. */
export function normalizeAccountQuota(
  value: unknown,
): RuntimeAccountQuota | null {
  const payload = record(value);
  if (payload.rate_limits_available !== true) return null;
  const limits = record(payload.rate_limits);
  const windows = (
    [
      ["five_hour", 300],
      ["seven_day", 10080],
    ] as const
  ).flatMap(([key, durationMins]) => {
    const row = record(limits[key]);
    const usedPercent = row.utilization;
    if (
      typeof usedPercent !== "number" ||
      !Number.isFinite(usedPercent) ||
      usedPercent < 0
    )
      return [];
    const reset =
      typeof row.resets_at === "string"
        ? Date.parse(row.resets_at) / 1000
        : NaN;
    return [
      {
        usedPercent: Math.min(100, usedPercent),
        durationMins,
        ...(Number.isFinite(reset) && reset > 0 ? { resetsAt: reset } : {}),
      },
    ];
  });
  return windows.length ? { windows } : null;
}

/** No prompt is consumed. Always close the metadata process, including on timeout. */
export async function probeAccountQuota(
  createQuery: (prompt: AsyncIterable<never>) => UsageQuery,
  timeoutMs = 8000,
): Promise<RuntimeAccountQuota | null> {
  let session: UsageQuery | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopInput!: () => void;
  const stopped = new Promise<void>((resolve) => {
    stopInput = resolve;
  });
  // Keep the control channel open without ever submitting a user message.
  const prompt = (async function* (): AsyncGenerator<never> {
    await stopped;
  })();
  try {
    session = createQuery(prompt);
    const read =
      session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof read !== "function") return null;
    const value = await Promise.race([
      read.call(session),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    return normalizeAccountQuota(value);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try {
      session?.close();
    } catch {
      /* Optional telemetry must not affect chat. */
    }
    stopInput();
  }
}
