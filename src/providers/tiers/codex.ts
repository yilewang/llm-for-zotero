import type { ProviderCapabilities, ProviderParams } from "../types";

/**
 * Tier 5 — Codex / ChatGPT auth.
 *
 * Uses the Responses API format. The current app-server/plugin transport
 * does not expose a stable full-PDF turn-input contract, so PDF mode is
 * disabled here. Users can still attach explicit page captures as images.
 */

export function matches(params: ProviderParams): boolean {
  const auth = (params.authMode || "").toLowerCase();
  const proto = (params.protocol || "").toLowerCase();
  return auth === "codex_auth" || auth === "codex_app_server" || proto === "codex_responses";
}

export const capabilities: Omit<ProviderCapabilities, "multimodal"> = {
  tier: "codex",
  label: "Codex / ChatGPT",
  pdf: "none",
  images: true,
};
