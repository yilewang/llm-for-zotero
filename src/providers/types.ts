export type PdfSupport =
  | "file_upload"
  | "inline_base64_pdf"
  | "native_inline_pdf"
  | "provider_upload"
  | "vision_pages"
  | "none"
  | "error";

export type ProviderFamily =
  | "native_openai"
  | "native_gemini"
  | "native_anthropic"
  | "kimi_qwen"
  | "third_party"
  | "copilot"
  | "codex";

export type ProviderCapabilities = {
  providerFamily: ProviderFamily;
  label: string;
  pdf: PdfSupport;
  images: boolean;
  multimodal: boolean;
  fileInputs: boolean;
};

export type ProviderParams = {
  model: string;
  protocol?: string;
  authMode?: string;
  apiBase?: string;
};
