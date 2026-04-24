import type { AgentPendingAction, AgentConfirmationResolution } from "../types";
import type { AgentToolRegistry } from "../tools/registry";
import type { ZoteroGateway } from "../services/zoteroGateway";
import type { LibraryQueryService } from "../services/libraryQueryService";
import type { LibraryReadService } from "../services/libraryReadService";
import type { LibraryMutationService } from "../services/libraryMutationService";
import type { LiteratureSearchService } from "../services/literatureSearchService";
import type { ModelProviderAuthMode } from "../../utils/modelProviders";
import type { ProviderProtocol } from "../../utils/providerProtocol";
import type {
  CollectionContextRef,
  PaperContextRef,
} from "../../shared/types";
import type { PaperScopedActionProfile } from "./paperScope";

/**
 * LLM credentials that an action can use to call the model directly
 * (e.g. to propose per-item tag or collection suggestions).  When absent,
 * actions fall back to non-AI behavior.
 */
export type ActionLLMConfig = {
  model: string;
  apiBase: string;
  apiKey?: string;
  authMode?: ModelProviderAuthMode;
  providerProtocol?: ProviderProtocol;
};

/**
 * How confirmations (HITL) are handled when an action's tool calls require user approval.
 *
 * - `"native_ui"`: The action pauses and emits a `confirmation_required` progress event.
 *   The caller opens Zotero's native UI dialog and resolves it via `requestConfirmation`.
 * - `"auto_approve"`: All confirmations are automatically approved without user interaction.
 *   Useful for trusted batch operations.
 * - `"mcp_response"`: The action pauses and the confirmation card is returned in the MCP
 *   response body so an external agent can handle it.
 */
export type ActionConfirmationMode = "native_ui" | "auto_approve" | "mcp_response";

export type ActionProgressEvent =
  | { type: "step_start"; step: string; index: number; total: number }
  | { type: "step_done"; step: string; summary?: string }
  | { type: "confirmation_required"; requestId: string; action: AgentPendingAction }
  | { type: "status"; message: string };

export type ActionServices = {
  queryService: LibraryQueryService;
  readService: LibraryReadService;
  mutationService: LibraryMutationService;
  literatureSearchService: LiteratureSearchService;
};

export type ActionRequestContext = {
  mode?: "paper" | "library";
  activeItemId?: number;
  selectedPaperContexts?: PaperContextRef[];
  fullTextPaperContexts?: PaperContextRef[];
  selectedCollectionContexts?: CollectionContextRef[];
};

export type ActionExecutionContext = {
  /** The tool registry — used by ActionExecutor to call tools deterministically. */
  registry: AgentToolRegistry;
  zoteroGateway: ZoteroGateway;
  services: ActionServices;
  /** The Zotero library ID to operate on. */
  libraryID: number;
  confirmationMode: ActionConfirmationMode;
  onProgress: (event: ActionProgressEvent) => void;
  /**
   * Request confirmation from the user.  Called by ActionExecutor when a tool
   * requires HITL and confirmationMode is `"native_ui"` or `"mcp_response"`.
   * Returns the user's resolution (approved + optional data).
   */
  requestConfirmation: (
    requestId: string,
    action: AgentPendingAction,
  ) => Promise<AgentConfirmationResolution>;
  /**
   * Optional LLM credentials.  When present, actions can call `callLLM()` to
   * generate per-item suggestions (tags, collections, etc.).  When absent,
   * actions must fall back to non-AI behavior so they still work in contexts
   * (e.g. the MCP server) where no user-side model is configured.
   */
  llm?: ActionLLMConfig;
  /** Optional chat-context refs forwarded from the compose UI. */
  requestContext?: ActionRequestContext;
};

export type ActionResult<TOutput = unknown> =
  | { ok: true; output: TOutput }
  | { ok: false; error: string };

export interface AgentAction<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  /** Chat modes this action is available in. If omitted, available in all modes. */
  modes?: Array<"paper" | "library">;
  /** Optional shared scope behavior for paper-scoped slash actions. */
  paperScopeProfile?: PaperScopedActionProfile;
  inputSchema: object;
  execute(input: TInput, ctx: ActionExecutionContext): Promise<ActionResult<TOutput>>;
}
