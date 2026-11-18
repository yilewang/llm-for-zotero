import {
  readObservationSourceKey,
  readObservationSourceKeys,
} from "../context/readObservation";
import type { AgentToolContext, AgentToolDefinition } from "../types";

/** A document evidence ref as a result carries it beside its rows. */
type EvidenceRef = Record<string, unknown>;

/**
 * A tool's sized view of a successful result, as every runtime sends it: the
 * plugin agent and the MCP server build it here, then each says where the
 * rest is (a tool-result handle, or a narrower call).
 */
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
