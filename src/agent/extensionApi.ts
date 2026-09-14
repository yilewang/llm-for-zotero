/**
 * llm-for-zotero — Public Extension API
 * ======================================
 *
 * This module is the single entry point for third-party Zotero plugin authors
 * who want to register custom tools with the llm-for-zotero agent.
 *
 * ## Quick start
 *
 * 1. Wait for the agent to be ready (it initialises during Zotero startup):
 *
 *    ```ts
 *    await Zotero.llmForZotero.ready; // or hook into your plugin's startup
 *    ```
 *
 * 2. Import the types you need **(TypeScript only — types are erased at runtime)**:
 *
 *    ```ts
 *    import type { AgentToolDefinition, AgentToolContext } from
 *      "path/to/llm-for-zotero/src/agent/extensionApi";
 *    import { ok, fail } from
 *      "path/to/llm-for-zotero/src/agent/extensionApi";
 *    ```
 *
 * 3. Register your tool:
 *
 *    ```ts
 *    const { registerTool, getZoteroGateway } = addon.api.agent;
 *
 *    registerTool({
 *      spec: {
 *        name: "my_tool",
 *        description: "A short description the LLM reads to decide when to call this tool.",
 *        inputSchema: {
 *          type: "object",
 *          required: ["query"],
 *          properties: {
 *            query: { type: "string", description: "The user's query" },
 *          },
 *        },
 *        executionClass: "read",       // "read" | "control" | "external_effect"
 *        requiresConfirmation: false,  // set true to show a HITL confirm card
 *      },
 *      validate: (args) => {
 *        if (!args || typeof args !== "object") return fail("Expected an object");
 *        const { query } = args as Record<string, unknown>;
 *        if (typeof query !== "string" || !query.trim()) return fail("query must be a non-empty string");
 *        return ok({ query: query.trim() });
 *      },
 *      execute: async (input, context) => {
 *        const gw = getZoteroGateway();
 *        const libraryID = gw.resolveLibraryID({ request: context.request, item: context.item });
 *        // ... do work ...
 *        return { answer: `Processed: ${input.query} in library ${libraryID}` };
 *      },
 *    });
 *    ```
 *
 * 4. Unregister when your plugin shuts down:
 *
 *    ```ts
 *    addon.api.agent.unregisterTool("my_tool");
 *    ```
 *
 * ## Input schema portability
 *
 * `registerTool` is synchronous, returns no value, and throws before
 * registration when a model-visible tool does not provide a portable
 * object-root input schema.
 * The root must declare `type: "object"` and must not contain `oneOf`, `allOf`,
 * or `anyOf`; those composition keywords may be used inside properties.
 * Enforce cross-field constraints, such as mutually exclusive properties, in
 * the tool's `validate()` function.
 * Internal-only tools are exempt because their schemas are never advertised.
 *
 * ## Tool execution class
 *
 * - `"read"` — the tool only reads data. Read tools may still open a HITL card
 *   when the user needs to review or approve a sensitive step.
 * - `"control"` — the tool changes only internal Plan/approval state or pauses
 *   for user input. Controls are never deduplicated and need no action contract.
 * - `"external_effect"` — the tool modifies external state. Set `requiresConfirmation: true`
 *   and implement `createPendingAction` to show a HITL confirmation card before
 *   executing. External-effect tools must also provide a typed action adapter.
 *
 * Read tools can also pause after execution by implementing
 * `createResultReviewAction` and `resolveResultReview`. This lets the tool
 * deliver results inside a review card before the model sees them.
 *
 * ## Guidance (optional)
 *
 * Add a `guidance` field to tell the agent *when* to prefer your tool:
 *
 * ```ts
 * guidance: {
 *   matches: (request) => request.classifiedIntent?.semantic?.supportTools?.includes("my_tool") === true,
 *   instruction: "Use my_tool for the supporting operation selected by semantic intent.",
 * },
 * ```
 *
 * ## Accessing Zotero data
 *
 * Use `addon.api.agent.getZoteroGateway()` to obtain the shared `ZoteroGateway`
 * instance.  It exposes helpers for items, collections, tags, notes, annotations,
 * metadata editing, and more.
 */

// ── Core type contracts ────────────────────────────────────────────────────────
export type {
  AgentToolDefinition,
  AgentToolContext,
  AgentInheritedApproval,
  AgentToolInputValidation,
  AgentToolGuidance,
  AgentRuntimeRequest,
  AgentPendingAction,
} from "./types";

// ToolSpec lives in types — re-export just the fields authors need
export type { ToolSpec } from "./types";

// ── Validation helpers ─────────────────────────────────────────────────────────
// Use these inside your `validate` function.
export {
  ok,
  fail,
  validateObject,
  normalizePositiveInt,
  normalizePositiveIntArray,
  normalizeStringArray,
} from "./tools/shared";

// ── Zotero integration ─────────────────────────────────────────────────────────
// Import the class for type annotations; obtain the live instance via
// `addon.api.agent.getZoteroGateway()` — do not `new ZoteroGateway()` yourself.
export type { ZoteroGateway } from "./services/zoteroGateway";
export type {
  EditableArticleMetadataSnapshot,
  EditableArticleMetadataField,
  PaperNoteRecord,
  PaperAnnotationRecord,
  RelatedPaperResult,
  DuplicateGroup,
} from "./services/zoteroGateway";

// ── Action API ─────────────────────────────────────────────────────────────────
// Third-party plugins can register custom actions via `addon.api.agent.runAction()`.
// Use these types to implement and annotate your own actions.
export type {
  AgentAction,
  ActionExecutionContext,
  ActionConfirmationMode,
  ActionProgressEvent,
  ActionResult,
} from "./actions/types";
