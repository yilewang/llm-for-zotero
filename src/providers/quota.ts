import { createAbortController } from "../utils/apiHelpers";
import { detectProviderPreset } from "../utils/providerPresets";
import { parseMiniMaxQuota } from "./minimaxQuota";
import type { ProviderQuota } from "./types";

export type { ProviderQuota } from "./types";

const API_QUOTA_ENDPOINTS = {
  deepseek: "https://api.deepseek.com/user/balance",
  openrouter: "https://openrouter.ai/api/v1/key",
  kimi_cn: "https://api.moonshot.cn/v1/users/me/balance",
  kimi_global: "https://api.moonshot.ai/v1/users/me/balance",
  kimi_code: "https://api.kimi.com/coding/v1/usages",
  glm_cn: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
  glm_global: "https://api.z.ai/api/monitor/usage/quota/limit",
  minimax_global: "https://api.minimax.io/v1/token_plan/remains",
  minimax_cn: "https://api.minimax.cn/v1/token_plan/remains",
  minimax_legacy_cn: "https://api.minimaxi.com/v1/token_plan/remains",
  opencode_go: "https://opencode.ai/zen/go/v1/usage",
} as const;

export type ApiQuotaKind = keyof typeof API_QUOTA_ENDPOINTS;
export type ApiQuotaTarget = {
  kind: ApiQuotaKind;
  apiKey: string;
  model?: string;
};
export type ClaudeQuotaTarget = {
  kind: "claude";
  bridgeUrl: string;
  settingSources: string;
  context: {
    conversationKey: string | number;
    scopeType: "paper" | "open";
    scopeId: string;
    scopeLabel?: string;
  };
};
export type QuotaTarget =
  | ApiQuotaTarget
  | ClaudeQuotaTarget
  | { kind: "codex"; codexPath: string };

export type QuotaSnapshot = {
  quota: ProviderQuota | null;
  checkedAt: number;
};

export function resolveQuotaTarget(
  entry: {
    authMode: string;
    apiBase: string;
    apiKey: string;
    model?: string;
  } | null,
): QuotaTarget | null {
  if (!entry) return null;
  if (entry.authMode === "codex_app_server") {
    return { kind: "codex", codexPath: entry.apiBase };
  }
  if (entry.authMode !== "api_key" || !entry.apiKey.trim()) return null;
  try {
    const url = new URL(entry.apiBase);
    // Never send a proxy's credentials to the upstream provider, even when
    // the selected model or preset has that provider's name.
    if (url.protocol !== "https:" || url.port || url.username || url.password)
      return null;
    for (const kind of Object.keys(API_QUOTA_ENDPOINTS) as ApiQuotaKind[]) {
      if (url.origin === new URL(API_QUOTA_ENDPOINTS[kind]).origin) {
        if (kind === "kimi_code" && !/^\/coding(\/|$)/.test(url.pathname))
          return null;
        // Go's subscription quota does not describe Zen's prepaid balance, so
        // only the paths the Go preset claims select it.
        if (
          kind === "opencode_go" &&
          detectProviderPreset(entry.apiBase) !== "opencode_go"
        )
          return null;
        // GLM plan allowance applies to Coding Plan routes, not PAYG requests.
        if (
          (kind === "glm_cn" || kind === "glm_global") &&
          !/^\/api\/(anthropic|coding\/paas\/v4)(\/|$)/.test(url.pathname)
        )
          return null;
        return {
          kind,
          apiKey: entry.apiKey,
          ...(kind.startsWith("minimax_") && entry.model?.trim()
            ? { model: entry.model.trim() }
            : {}),
        };
      }
    }
  } catch {
    // Unrecognized or local endpoints have no known balance contract.
  }
  return null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function number(value: unknown): number | undefined {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && !value.trim())
  )
    return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Provider contracts and their sources are recorded in src/providers/QUOTA.md. */
export function parseApiQuota(
  kind: ApiQuotaKind,
  value: unknown,
  model?: string,
): ProviderQuota | null {
  if (kind.startsWith("minimax_")) {
    return parseMiniMaxQuota(
      value,
      kind === "minimax_global" ? "USD" : "CNY",
      model,
    );
  }
  const payload = record(value);
  if (kind === "opencode_go") {
    const usage = record(payload.usage);
    const windows = (["rolling", "weekly", "monthly"] as const).flatMap(
      (period) => {
        const row = record(usage[period]);
        const usedPercent = number(row.percent);
        if (
          (row.status !== "ok" && row.status !== "rate-limited") ||
          usedPercent === undefined ||
          usedPercent < 0 ||
          usedPercent > 100
        )
          return [];
        const resetsAt =
          typeof row.resetsAt === "string"
            ? Date.parse(row.resetsAt) / 1000
            : NaN;
        // The response names periods but supplies no window durations.
        return [
          {
            period,
            usedPercent,
            ...(Number.isFinite(resetsAt) && resetsAt > 0 ? { resetsAt } : {}),
          },
        ];
      },
    );
    return windows.length
      ? { kind: "usage", provider: "opencode", windows }
      : null;
  }
  if (kind === "kimi_code") {
    const rows = [
      { detail: payload.usage, durationMins: 10080 },
      ...(Array.isArray(payload.limits) ? payload.limits : []).map((raw) => {
        const row = record(raw);
        const window = record(row.window);
        const duration = number(window.duration);
        const unit = typeof window.timeUnit === "string" ? window.timeUnit : "";
        const factor = unit.includes("MINUTE")
          ? 1
          : unit.includes("HOUR")
            ? 60
            : unit.includes("DAY")
              ? 1440
              : undefined;
        return {
          detail: row.detail ?? row,
          durationMins:
            duration !== undefined && factor !== undefined
              ? duration * factor
              : undefined,
        };
      }),
    ];
    const windows = rows.flatMap(({ detail, durationMins }) => {
      const row = record(detail);
      const limit = number(row.limit);
      const remaining = number(row.remaining);
      const used =
        number(row.used) ??
        (limit !== undefined && remaining !== undefined
          ? limit - remaining
          : undefined);
      // Missing counters and zero/unknown limits are unavailable, never 0% used.
      if (limit === undefined || limit <= 0 || used === undefined || used < 0)
        return [];
      const reset =
        row.resetTime ?? row.resetAt ?? row.reset_at ?? row.reset_time;
      const resetsAt =
        typeof reset === "string" ? Date.parse(reset) / 1000 : NaN;
      return [
        {
          usedPercent: Math.min(100, (used / limit) * 100),
          ...(durationMins !== undefined && durationMins > 0
            ? { durationMins }
            : {}),
          ...(Number.isFinite(resetsAt) && resetsAt > 0 ? { resetsAt } : {}),
        },
      ];
    });
    return windows.length ? { kind: "usage", provider: "kimi", windows } : null;
  }
  if (kind === "glm_cn" || kind === "glm_global") {
    if (
      payload.success === false ||
      (payload.code !== undefined && number(payload.code) !== 200)
    )
      return null;
    const limits = record(payload.data).limits;
    const windows = (Array.isArray(limits) ? limits : []).flatMap((raw) => {
      const row = record(raw);
      const usedPercent = number(row.percentage);
      // TIME_LIMIT is the separate MCP allowance. Do not present it as chat usage.
      if (
        row.type !== "TOKENS_LIMIT" ||
        usedPercent === undefined ||
        usedPercent < 0
      )
        return [];
      return [{ usedPercent: Math.min(100, usedPercent) }];
    });
    return windows.length ? { kind: "usage", provider: "glm", windows } : null;
  }
  if (kind === "kimi_cn" || kind === "kimi_global") {
    // Kimi's regional keys and currencies are independent; never fall back
    // across regions or reconstruct available_balance from cash/vouchers.
    if (payload.status !== true || payload.code !== 0) return null;
    const amount = number(record(payload.data).available_balance);
    return amount === undefined
      ? null
      : {
          kind: "balance",
          scope: "account",
          balances: [{ currency: kind === "kimi_cn" ? "CNY" : "USD", amount }],
        };
  }
  if (kind === "deepseek") {
    const balances = (
      Array.isArray(payload.balance_infos) ? payload.balance_infos : []
    ).flatMap((raw) => {
      const row = record(raw);
      const amount = number(row.total_balance);
      return amount !== undefined &&
        (row.currency === "USD" || row.currency === "CNY")
        ? [{ currency: row.currency, amount }]
        : [];
    });
    return balances.length
      ? { kind: "balance", scope: "account", balances }
      : null;
  }
  const data = record(payload.data);
  const amount = number(data.limit_remaining);
  // A null limit is unlimited key spending, not an account balance of zero.
  return amount !== undefined && number(data.limit) !== undefined
    ? { kind: "balance", scope: "key", balances: [{ currency: "USD", amount }] }
    : null;
}

/** Codex account/rateLimits/read: prefer the named Codex bucket when present. */
export function parseCodexQuota(value: unknown): ProviderQuota | null {
  const payload = record(value);
  const buckets = record(payload.rateLimitsByLimitId);
  const bucket = Object.keys(buckets).length
    ? record(buckets.codex)
    : record(payload.rateLimits);
  const windows = [bucket.primary, bucket.secondary].flatMap((raw) => {
    const row = record(raw);
    const usedPercent = number(row.usedPercent);
    if (usedPercent === undefined || usedPercent < 0) return [];
    const durationMins = number(row.windowDurationMins);
    const resetsAt = number(row.resetsAt);
    return [
      {
        usedPercent: Math.min(100, usedPercent),
        ...(durationMins !== undefined && durationMins > 0
          ? { durationMins }
          : {}),
        ...(resetsAt !== undefined && resetsAt > 0 ? { resetsAt } : {}),
      },
    ];
  });
  return windows.length ? { kind: "usage", windows } : null;
}

export async function readApiQuota(
  target: ApiQuotaTarget,
): Promise<ProviderQuota | null> {
  const controller = createAbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const endpoint =
      target.kind.startsWith("minimax_") && target.apiKey.startsWith("sk-api-")
        ? new URL("/account/query_balance", API_QUOTA_ENDPOINTS[target.kind])
            .href
        : API_QUOTA_ENDPOINTS[target.kind];
    const response = await fetch(endpoint, {
      headers: {
        Authorization:
          target.kind === "glm_cn" || target.kind === "glm_global"
            ? target.apiKey
            : `Bearer ${target.apiKey}`,
        Accept: "application/json",
      },
      signal: controller.signal,
      redirect: "error",
      credentials: "omit",
    });
    if (!response.ok) return null;
    return parseApiQuota(target.kind, await response.json(), target.model);
  } finally {
    clearTimeout(timer);
  }
}

/** Memory-only, bounded cache. Credentials never enter DOM, preferences or logs. */
export function createQuotaReader(
  read: (target: QuotaTarget) => Promise<ProviderQuota | null>,
  now = Date.now,
) {
  const cache = new Map<
    string,
    {
      pending: Promise<QuotaSnapshot>;
      startedAt: number;
      settled: boolean;
      refresh: boolean;
    }
  >();
  return (target: QuotaTarget, refresh = false): Promise<QuotaSnapshot> => {
    const key = JSON.stringify(target);
    const previous = cache.get(key);
    const age = previous ? now() - previous.startedAt : Infinity;
    // A completed turn invalidates even a recent read from before that turn.
    // Concurrent refreshes share their own request, never the pre-turn read.
    if (
      previous &&
      ((!previous.settled && (!refresh || previous.refresh)) ||
        (!refresh && age < 60000))
    ) {
      return previous.pending;
    }
    const entry = {
      startedAt: now(),
      settled: false,
      refresh,
      pending: Promise.resolve()
        .then(() => read(target))
        .then(
          (quota) => ({ quota, checkedAt: now() }),
          () => ({ quota: null, checkedAt: now() }),
        )
        .finally(() => {
          entry.settled = true;
        }),
    };
    cache.delete(key);
    cache.set(key, entry);
    if (cache.size > 32) cache.delete(cache.keys().next().value!);
    return entry.pending;
  };
}
