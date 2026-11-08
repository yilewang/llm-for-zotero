import type { AgentRuntimeRequest } from "../../types";
import {
  getTavilyApiKey,
  getAnysearchApiKey,
  getWebAccessProvider,
  isWebAccessConfigured,
} from "../../../webAccess/prefs";
import type { WebAccessProvider } from "../../../webAccess/types";
import { TavilyClient } from "../../../webAccess/tavilyClient";
import { AnysearchClient } from "../../../webAccess/anysearchClient";
import { DeepSeekSearchClient } from "../../../webAccess/deepseekSearchClient";
import { getDeepSeekSearchCredential } from "../../../webAccess/deepseekSearchKey";

export type WebAccessProviderFactory = () => WebAccessProvider;

export function createConfiguredWebAccessProvider(): WebAccessProvider {
  const provider = getWebAccessProvider();
  if (provider === "anysearch") {
    return new AnysearchClient(getAnysearchApiKey());
  }
  if (provider === "deepseek") {
    // An empty key throws here: no other provider is tried instead.
    return new DeepSeekSearchClient(
      getDeepSeekSearchCredential()?.apiKey || "",
    );
  }
  return new TavilyClient(getTavilyApiKey());
}

export function isWebAccessToolAvailable(
  request: AgentRuntimeRequest,
): boolean {
  if (!isWebAccessConfigured()) return false;
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
      'At the exact end of every final-answer paragraph that uses web information, append <!--llm-web-source:SOURCE_ID[,SOURCE_ID...]-->. With each source give the exact words the paragraph relies on, copied word for word from what you read of it (about 5 to 25 words, no double quotes inside): <!--llm-web-source:SOURCE_ID="exact words",SOURCE_ID="exact words"-->. Leave out ="..." for a source you cannot quote word for word; never paraphrase inside it. Use only the sourceId values returned by web_search/web_read. If no web information is used in the final answer, append <!--llm-web-source:none--> once at the end.',
    availableSourceIds: Array.from(new Set(sourceIds)),
  };
}
