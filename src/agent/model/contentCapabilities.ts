import type {
  AgentContentInputCapabilities,
  AgentModelCapabilities,
} from "../types";

export function normalizeAgentContentInputs(
  contentInputs?: Partial<AgentContentInputCapabilities> | null,
): AgentContentInputCapabilities {
  return {
    images: Boolean(contentInputs?.images),
    pdfDocuments: Boolean(contentInputs?.pdfDocuments),
    nativeFiles: Boolean(contentInputs?.nativeFiles),
  };
}

export function hasAgentContentInputs(
  contentInputs: AgentContentInputCapabilities,
): boolean {
  return (
    contentInputs.images ||
    contentInputs.pdfDocuments ||
    contentInputs.nativeFiles
  );
}

export function buildAgentModelCapabilities(params: {
  streaming: boolean;
  toolCalls: boolean;
  contentInputs?: Partial<AgentContentInputCapabilities> | null;
  fileInputs: boolean;
  reasoning: boolean;
}): AgentModelCapabilities {
  const contentInputs = normalizeAgentContentInputs(params.contentInputs);
  return {
    streaming: params.streaming,
    toolCalls: params.toolCalls,
    contentInputs,
    multimodal: hasAgentContentInputs(contentInputs),
    fileInputs: params.fileInputs,
    reasoning: params.reasoning,
  };
}

export function resolveCapabilitiesContentInputs(
  capabilities: AgentModelCapabilities,
): AgentContentInputCapabilities {
  if (capabilities.contentInputs) {
    return normalizeAgentContentInputs(capabilities.contentInputs);
  }
  return {
    images: capabilities.multimodal,
    pdfDocuments: capabilities.fileInputs,
    nativeFiles: capabilities.fileInputs,
  };
}
