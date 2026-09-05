import type {
  AgentConfirmationResolution,
  AgentJournalActionScope,
  AgentPendingAction,
  AgentActionContract,
  AgentActionProgressLedger,
} from "../types";
import type { AgentToolRegistry } from "../tools/registry";
import type { ZoteroGateway } from "../services/zoteroGateway";
import type { ModelProviderAuthMode } from "../../utils/modelProviders";
import type { ProviderProtocol } from "../../utils/providerProtocol";
import type {
  CollectionContextRef,
  PaperContextRef,
  TagContextRef,
} from "../../shared/types";
import type { PaperScopedActionProfile } from "./paperScopeTypes";
import type { ModelProfileOverride } from "../../modelCapabilities";
import type { UtilityLLMParams } from "../../utils/utilityLLM";

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
  profileOverride?: ModelProfileOverride;
  /** Test seam: replaces the actual model call. */
  llmCall?: UtilityLLMParams["llmCall"];
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
export type ActionConfirmationMode =
  | "native_ui"
  | "auto_approve"
  | "mcp_response";

export type ActionProgressEvent =
  | { type: "step_start"; step: string; index: number; total: number }
  | { type: "step_done"; step: string; summary?: string }
  | {
      type: "confirmation_required";
      requestId: string;
      action: AgentPendingAction;
    }
  | { type: "status"; message: string };

export type ActionCheckpoint = {
  /** Absolute next item offset, not a page/event count. */
  cursor: number;
  /** Number of library objects actually changed so far. */
  appliedCount: number;
  totalCount?: number;
  /** Stable action decisions needed to resume with the same behavior. */
  plan?: Record<string, unknown>;
};

export type ActionRequestContext = {
  mode?: "paper" | "library";
  activeItemId?: number;
  selectedPaperContexts?: PaperContextRef[];
  fullTextPaperContexts?: PaperContextRef[];
  selectedCollectionContexts?: CollectionContextRef[];
  selectedTagContexts?: TagContextRef[];
  actionContract?: AgentActionContract;
  actionProgress?: AgentActionProgressLedger;
};

export type ActionExecutionContext = {
  /** The tool registry — used by ActionExecutor to call tools deterministically. */
  registry: AgentToolRegistry;
  /**
   * The conversation these changes belong to.
   *
   * `buildToolContext` used to hard-code `0` here, so every tool an action
   * invoked wrote its undo entry and its journal row under conversation 0 —
   * a key nothing ever queries. A batch job's changes were therefore
   * unrecoverable by both `undo_last_action` and `revert_changes`, while the
   * confirmation card promised the run "can be reverted".
   */
  conversationKey?: number;
  /**
   * Groups this run's journal entries so they can be reverted as a unit.
   * Defaults to the conversation when absent.
   */
  runId?: string;
  /** Durable action shared by every nested write in a composite invocation. */
  journalActionScope?: AgentJournalActionScope;
  /** User-visible tool identity retained across internal action/tool bridges. */
  journalToolName?: string;
  zoteroGateway: ZoteroGateway;
  /** The Zotero library ID to operate on. */
  libraryID: number;
  confirmationMode: ActionConfirmationMode;
  onProgress: (event: ActionProgressEvent) => void;
  /** Awaited after a page has fully landed, before the next page starts. */
  checkpoint?: (checkpoint: ActionCheckpoint) => Promise<void>;
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
  /**
   * Cancels the run. Batched actions call the model once per batch and those
   * batches are sequential, so without this a long queue is unstoppable.
   */
  signal?: AbortSignal;
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
  execute(
    input: TInput,
    ctx: ActionExecutionContext,
  ): Promise<ActionResult<TOutput>>;
}
