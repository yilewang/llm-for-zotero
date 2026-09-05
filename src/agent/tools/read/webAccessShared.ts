import type { AgentRuntimeRequest } from "../../types";
import { getTavilyApiKey, hasTavilyApiKey } from "../../../webAccess/prefs";
import type { WebAccessProvider } from "../../../webAccess/types";
import { TavilyClient } from "../../../webAccess/tavilyClient";

export type WebAccessProviderFactory = () => WebAccessProvider;

export function createConfiguredWebAccessProvider(): WebAccessProvider {
  return new TavilyClient(getTavilyApiKey());
}

export function isWebAccessToolAvailable(
  request: AgentRuntimeRequest,
): boolean {
  if (!hasTavilyApiKey()) return false;
  if (
    request.authMode === "codex_app_server" ||
    request.authMode === "webchat"
  ) {
    return false;
  }
  if (request.providerProtocol === "web_sync") return false;
  return true;
}

export function webCitationInstruction(sourceIds: string[]): {
  markerFormat: string;
  availableSourceIds: string[];
} {
  return {
    markerFormat:
      "At the exact end of every final-answer paragraph that uses web information, append <!--llm-web-source:SOURCE_ID[,SOURCE_ID...]-->. Use only the sourceId values returned by web_search/web_read. If no web information is used in the final answer, append <!--llm-web-source:none--> once at the end.",
    availableSourceIds: Array.from(new Set(sourceIds)),
  };
}
