export type PdfSupport = "native" | "upload" | "image_url" | "vision" | "none";

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
};

export type ProviderParams = {
  model: string;
  protocol?: string;
  authMode?: string;
  apiBase?: string;
};
