import type { ModelInputMode } from "../shared/types";

/** Account allowance is independent of locally recorded conversation tokens. */
export type ProviderQuota =
  | {
      kind: "balance";
      scope: "account" | "key";
      balances: Array<{ currency: string; amount: number }>;
    }
  | {
      kind: "usage";
      provider?:
        | "codex"
        | "claude"
        | "glm"
        | "kimi"
        | "minimax"
        | "opencode"
        | "antigravity";
      windows: Array<{
        usedPercent: number;
        /** Which allowance the window counts, when a plan has several. */
        label?: string;
        /** Listed in the tooltip but left out of the headline percentage. */
        secondary?: boolean;
        period?: "rolling" | "weekly" | "monthly";
        durationMins?: number;
        resetsAt?: number;
      }>;
    };

export type PdfSupport = "native" | "local_path" | "upload" | "vision" | "none";

export type ProviderTier =
  | "native"
  | "server_upload"
  | "third_party"
  | "copilot"
  | "codex";

export type ProviderCapabilities = {
  tier: ProviderTier;
  label: string;
  pdf: PdfSupport;
  images: boolean;
  multimodal: boolean;
  promptCache: ProviderPromptCacheCapability;
};

export type ProviderParams = {
  model: string;
  protocol?: string;
  authMode?: string;
  apiBase?: string;
  inputMode?: ModelInputMode | "auto" | string;
};

export type ProviderPromptCacheKind =
  | "none"
  | "automatic_prefix"
  | "explicit_blocks"
  | "opaque";

export type ProviderPromptCacheProvider =
  | "openai"
  | "deepseek"
  | "anthropic"
  | "minimax"
  | "gemini"
  | "kimi"
  | "codex"
  | "unknown";

export type ProviderPromptCacheTelemetry =
  | "none"
  | "openai_cached_tokens"
  | "deepseek_hit_miss"
  | "anthropic_read_write"
  | "gemini_cached_content"
  | "kimi_cached_tokens"
  | "opaque";

export type ProviderPromptCacheCapability = {
  kind: ProviderPromptCacheKind;
  provider: ProviderPromptCacheProvider;
  label: string;
  telemetry: ProviderPromptCacheTelemetry;
  stablePrefix: boolean;
  supportsPromptCacheKey?: boolean;
  supportsRetentionHint?: boolean;
  supportsAnthropicBlockCacheControl?: boolean;
  supportsAnthropicToolCacheControl?: boolean;
  supportsAnthropicRequestCacheControl?: boolean;
  supportsAnthropicCacheTtl1h?: boolean;
};
