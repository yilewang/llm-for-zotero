/**
 * From the reader a user picked to the `ReaderChoice` the resolver takes.
 *
 * The request carries only the selection (an entry ID or a model name, never
 * a credential). The model entry is looked up here, when a paper is read, so
 * a deleted or WebChat entry reads as "Same as main" and no key travels in a
 * request, a scope or a trace.
 */
import type { ReaderSelection } from "../../shared/readerSelection";
import {
  getModelEntryById,
  type RuntimeModelEntry,
} from "../../utils/modelProviders";
import {
  defaultReaderRoute,
  type ReaderChoice,
  type ReaderRequest,
} from "./resolveReader";

/** Where an API reader entry is looked up; a test seam. */
export type ReaderEntryLookup = (entryId: string) => RuntimeModelEntry | null;

/**
 * Whether a model entry can be a reader. WebChat has no API to call, and a
 * Codex app-server entry runs only inside the Codex conversation: the plain
 * completion route throws for it, so neither is offered or used.
 */
export function isReaderApiEntry(
  entry: Pick<RuntimeModelEntry, "authMode"> & {
    catalogAvailability?: string;
  },
): boolean {
  return (
    entry.authMode !== "webchat" &&
    entry.authMode !== "codex_app_server" &&
    entry.catalogAvailability !== "saved-unavailable"
  );
}

/**
 * The reader to use, or undefined for Same as main.
 *
 * - An entry selection becomes a call to that entry's own provider, from any
 *   runtime; an entry that is gone, or one a reader cannot use (WebChat,
 *   Codex app-server), is Same as main.
 * - A model selection names the runtime's own model: Codex Responses in
 *   Codex, the bridge in Claude Code. The plugin Agent has no such models.
 */
export function readerChoiceFromSelection(params: {
  selection: ReaderSelection | null | undefined;
  request: ReaderRequest;
  lookupEntry?: ReaderEntryLookup;
}): ReaderChoice | undefined {
  const { selection, request } = params;
  if (!selection) return undefined;
  if (selection.kind === "entry") {
    const entry = (params.lookupEntry || getModelEntryById)(selection.entryId);
    if (!entry || !isReaderApiEntry(entry)) return undefined;
    const model = entry.model.trim();
    if (!model) return undefined;
    return {
      route: "turn_model",
      model,
      apiBase: entry.apiBase,
      apiKey: entry.apiKey,
      authMode: entry.authMode,
      providerProtocol: entry.providerProtocol,
      profileOverride: entry.advanced?.profileOverride,
    };
  }
  const model = selection.model.trim();
  if (!model) return undefined;
  const route = defaultReaderRoute(request);
  if (route === "codex_responses") return { route, model };
  if (route === "claude_bridge") return { route, model };
  return undefined;
}
