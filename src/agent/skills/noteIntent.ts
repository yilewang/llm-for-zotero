import type { AgentRuntimeRequest } from "../types";
export const WRITE_NOTE_SKILL_ID = "write-note";
export function requestsNoteAction(
  request: Pick<AgentRuntimeRequest, "classifiedIntent">,
): boolean {
  return Boolean(
    request.classifiedIntent?.actionIntents.some(
      (action) => action.capability === "zotero.notes",
    ),
  );
}
