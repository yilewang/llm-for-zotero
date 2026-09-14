import type { AgentRuntimeRequest } from "./types";
export type WriteNoteDestination = "none" | "zotero" | "file" | "both";
export function noteDestinationForRequest(
  request: Pick<AgentRuntimeRequest, "classifiedIntent">,
): WriteNoteDestination {
  return request.classifiedIntent?.semantic?.noteDestination || "none";
}
