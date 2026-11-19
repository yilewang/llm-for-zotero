import {
  readObservationSourceKey,
  readObservationSourceKeys,
} from "../context/readObservation";
import type { AgentToolContext, AgentToolDefinition } from "../types";

/** How the model reaches what a sized view left out. */
export const MODEL_VIEW_HANDLE_NOTICE =
  "This result is sized to the request; omitted counts what it left out. context_read source:'tool_result' with this handle pages the exact stored result, which lists the rows shown here first: read a row path from offset = the number of rows shown.";

/** A document evidence ref as a result carries it beside its rows. */
type EvidenceRef = Record<string, unknown>;

/** A tool's sized view of a successful result, before it is stored. */
export type SizedModelView = {
  /** The view, with the evidence refs of the rows it keeps. */
  content: Record<string, unknown>;
  /**
   * The whole result, with every evidence ref, the rows shown first: what a
   * runtime that can store it keeps for paging.
   */
  stored: unknown;
};

/**
 * The view `toolDefinition.buildModelView` makes of `result`, or null when
 * the tool sends this result whole. The evidence refs follow the rows: the
 * view carries the refs of the rows it shows, and `omitted` counts the rest
 * beside the rows it left out.
 */
export function buildSizedModelView(params: {
  toolDefinition: Pick<AgentToolDefinition<any, any>, "buildModelView">;
  toolName: string;
  input: unknown;
  result: unknown;
  context: AgentToolContext;
  documentEvidenceRefs?: readonly EvidenceRef[];
}): SizedModelView | null {
  const view = params.toolDefinition.buildModelView?.(
    params.input as never,
    params.result as never,
    params.context,
  );
  if (!view) return null;
  const refs = params.documentEvidenceRefs || [];
  const shown = refs.length
    ? readObservationSourceKeys({
        toolName: params.toolName,
        input: params.input,
        result: view.content,
      })
    : new Set<string>();
  const keptRefs = refs.filter((ref) =>
    shown.has(readObservationSourceKey(ref)),
  );
  const omittedRefs = refs.filter(
    (ref) => !shown.has(readObservationSourceKey(ref)),
  );
  const stored = view.stored ?? params.result;
  const omitted = {
    ...((view.content.omitted as Record<string, number> | undefined) || {}),
    ...(omittedRefs.length ? { documentEvidenceRefs: omittedRefs.length } : {}),
  };
  return {
    content: {
      ...view.content,
      ...(keptRefs.length ? { documentEvidenceRefs: keptRefs } : {}),
      ...(Object.keys(omitted).length ? { omitted } : {}),
    },
    stored:
      refs.length && stored && typeof stored === "object"
        ? { ...stored, documentEvidenceRefs: [...keptRefs, ...omittedRefs] }
        : stored,
  };
}

/**
 * The view the model reads of a result its tool sizes, for every runtime
 * that can page a stored result: the plugin Agent and an MCP client of a
 * conversation. `storeResult` keeps the whole result, with every evidence
 * ref, under a tool-result handle of the conversation, which context_read
 * pages; the view carries the handle. Undefined, when the tool sends this
 * result whole or nothing could store it: the caller then sends the whole
 * result, so no row is out of reach.
 */
export async function buildPagedModelView(params: {
  toolDefinition: Pick<AgentToolDefinition<any, any>, "buildModelView">;
  toolName: string;
  input: unknown;
  result: unknown;
  context: AgentToolContext;
  documentEvidenceRefs?: readonly EvidenceRef[];
  storeResult: (stored: unknown) => Promise<string | undefined>;
}): Promise<Record<string, unknown> | undefined> {
  const view = buildSizedModelView(params);
  if (!view) return undefined;
  const handle = await params.storeResult(view.stored);
  if (!handle) return undefined;
  return {
    ...view.content,
    toolResultHandle: handle,
    toolResultHandleNotice: MODEL_VIEW_HANDLE_NOTICE,
  };
}
