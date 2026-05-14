export type PdfSupport = "native" | "upload" | "vision" | "none";

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
};

export type ProviderPromptCacheKind =
  | "none"
  | "automatic_prefix"
  | "explicit_blocks"
  | "explicit_resource"
  | "opaque";

export type ProviderPromptCacheProvider =
  | "openai"
  | "deepseek"
  | "anthropic"
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
  supportsAnthropicCacheControl?: boolean;
  supportsExplicitResource?: boolean;
};
