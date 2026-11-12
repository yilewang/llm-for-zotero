export type Llm4ZoteroAgentEvent =
  | {
      type: "provider_event";
      providerType: string;
      sessionId?: string;
      payload: Record<string, unknown>;
      ts: number;
    }
  | { type: "status"; text: string }
  | { type: "reasoning"; round: number; summary?: string; details?: string }
  | { type: "tool_call"; callId: string; name: string; args: unknown }
  | {
      type: "tool_result";
      callId: string;
      name: string;
      ok: boolean;
      content: unknown;
      artifacts?: unknown[];
    }
  | {
      type: "tool_error";
      callId: string;
      name: string;
      error: string;
      round: number;
    }
  | { type: "confirmation_required"; requestId: string; action: unknown }
  | {
      type: "confirmation_resolved";
      requestId: string;
      approved: boolean;
      actionId?: string;
      data?: unknown;
    }
  | { type: "message_delta"; text: string }
  | { type: "message_rollback"; length: number; text: string }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      cacheCreationInputTokens?: number;
      cacheReadInputTokens?: number;
      contextTokens: number;
      contextWindow?: number;
      contextWindowIsAuthoritative?: boolean;
      percentage?: number;
      sessionId?: string;
      model?: string;
    }
  | { type: "context_compacted"; automatic?: boolean }
  | {
      // The run's step list, whole: the plugin shows it in Task progress.
      type: "codex_progress";
      itemId: string;
      text: string;
      status?: "running" | "completed";
      steps: Array<{ content: string; status?: string }>;
      runtime?: "codex" | "claude";
    }
  | { type: "fallback"; reason: string }
  | { type: "final"; text: string };

export type Llm4ZoteroMcpServersConfig = Record<
  string,
  Record<string, unknown>
>;

export interface Llm4ZoteroRunTurnRequest {
  conversationKey: string | number;
  userText: string;
  providerSessionId?: string;
  allowedTools?: string[];
  scopeType?: "paper" | "open" | "folder" | "tag" | "tagset" | "custom";
  scopeId?: string;
  scopeLabel?: string;
  runtimeRequest?: Record<string, unknown>;
  mcpServers?: Llm4ZoteroMcpServersConfig;
  metadata?: Record<string, unknown>;
}

export interface Llm4ZoteroRuntimeRetentionRequest {
  conversationKey: string | number;
  providerSessionId?: string;
  scopeType?: "paper" | "open" | "folder" | "tag" | "tagset" | "custom";
  scopeId?: string;
  scopeLabel?: string;
  mountId: string;
  retain: boolean;
  probeId?: string;
}

export interface Llm4ZoteroSessionInvalidationRequest {
  conversationKey: string | number;
  scopeType?: "paper" | "open" | "folder" | "tag" | "tagset" | "custom";
  scopeId?: string;
  scopeLabel?: string;
  metadata?: Record<string, unknown>;
}

export type Llm4ZoteroToolMutability = "read" | "write";
export type Llm4ZoteroToolRiskLevel = "low" | "medium" | "high";
export type Llm4ZoteroToolSource = "claude-runtime" | "zotero-bridge" | "mcp";

export interface Llm4ZoteroToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  mutability: Llm4ZoteroToolMutability;
  riskLevel: Llm4ZoteroToolRiskLevel;
  requiresConfirmation: boolean;
  source: Llm4ZoteroToolSource;
}

export interface Llm4ZoteroRunActionRequest {
  conversationKey: string | number;
  toolName: string;
  args?: unknown;
  approved?: boolean;
  scopeType?: "paper" | "open" | "folder" | "tag" | "tagset" | "custom";
  scopeId?: string;
  scopeLabel?: string;
  activeItemId?: number;
  libraryID?: number;
  contextEnvelope?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface Llm4ZoteroRunActionParams {
  request: Llm4ZoteroRunActionRequest;
  onEvent?: (event: Llm4ZoteroAgentEvent) => void | Promise<void>;
  onStart?: (runId: string) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface Llm4ZoteroRunTurnParams {
  request: Llm4ZoteroRunTurnRequest;
  onEvent?: (event: Llm4ZoteroAgentEvent) => void | Promise<void>;
  onStart?: (runId: string) => void | Promise<void>;
  signal?: AbortSignal;
}

export type Llm4ZoteroRunTurnOutcome =
  | {
      kind: "completed";
      runId: string;
      text: string;
      usedFallback: false;
    }
  | {
      kind: "fallback";
      runId: string;
      reason: string;
      usedFallback: true;
    };
