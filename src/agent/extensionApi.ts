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
 *        mutability: "read",           // "read" | "write"
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
 * ## Tool mutability
 *
 * - `"read"` — the tool only reads data; no confirmation card is shown.
 * - `"write"` — the tool modifies Zotero data. Set `requiresConfirmation: true`
 *   and implement `createPendingAction` to show a HITL confirmation card before
 *   executing.
 *
 * ## Guidance (optional)
 *
 * Add a `guidance` field to tell the agent *when* to prefer your tool:
 *
 * ```ts
 * guidance: {
 *   matches: (request) => /\bmy keyword\b/i.test(request.userText),
 *   instruction: "Use my_tool when the user mentions 'my keyword'.",
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
