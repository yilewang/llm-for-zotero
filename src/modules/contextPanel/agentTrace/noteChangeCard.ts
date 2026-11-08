import { getAgentApi } from "../../../agent";
import { listJournalActions } from "../../../agent/store/changeJournal";
import { readRecoveryText } from "../../../agent/store/journalRecoveryBlobStore";
import type { AgentNoteChangeResultCard } from "../../../agent/types";
import { createDocumentCardLayout } from "../documentCard";
import { normalizeNoteSourceText } from "../../../services/notes/noteRendering";
import { navigatePlanDocumentCitationSource } from "../planDocumentPresentation";
import { renderDiffPreviewField } from "./diffPreviewField";

/**
 * What the change did, and what the reader can do about it.
 *
 * The diff is read back from the journal's recovery payloads rather than
 * recomposed, so what is shown is the state the write actually recorded. A
 * read that fails says so in `status`: the card and the action row both own a
 * pill, and this body writes the outcome into whichever one it was given.
 */
export function renderNoteChangeDetail(
  doc: Document,
  result: AgentNoteChangeResultCard,
  status: HTMLElement,
  options: { readOnly?: boolean } = {},
): HTMLElement {
  const detail = doc.createElement("div");
  const description = doc.createElement("p");
  description.className = "llm-note-review-description";
  description.textContent = result.description;
  const diff = doc.createElement("div");
  diff.className = "llm-plan-markdown llm-agent-action-diff";
  const actions = doc.createElement("div");
  actions.className = "llm-agent-action-row-actions";
  const open = doc.createElement("button");
  open.className = "llm-plan-action";
  open.type = "button";
  open.textContent = "Open note";
  const undo = doc.createElement("button");
  undo.className = "llm-plan-action";
  undo.type = "button";
  undo.textContent = "Undo";
  undo.disabled = result.state !== "applied";
  // A read-only past chat shows the change but cannot undo it: undoing
  // writes the note and the stored chat's journal.
  if (options.readOnly) actions.append(open);
  else actions.append(open, undo);
  detail.append(description, diff, actions);
  const failed = (error: unknown) => {
    status.textContent = error instanceof Error ? error.message : String(error);
    status.dataset.status = "error";
  };
  open.addEventListener("click", (event) => {
    event.preventDefault();
    void navigatePlanDocumentCitationSource({
      libraryID: result.note.libraryID,
      itemKey: result.note.key,
      evidenceRefs: [],
    })
      .then((ok) => {
        if (!ok) throw new Error("Note is unavailable");
      })
      .catch(failed);
  });
  undo.addEventListener("click", (event) => {
    event.preventDefault();
    undo.disabled = true;
    void getAgentApi()
      .undoNoteChange(result)
      .then((outcome) => {
        status.textContent =
          outcome.effect === "partial"
            ? "Partially undone; inspect remaining effects"
            : "Undone";
        status.dataset.status =
          outcome.effect === "partial" ? "error" : "completed";
      })
      .catch(failed);
  });
  void Promise.all([
    readRecoveryText(result.before),
    readRecoveryText(result.after),
    listJournalActions({
      actionId: result.actionId,
      conversationKey: result.conversationKey,
      limit: 1,
    }),
  ])
    .then(([before, after, journalActions]) => {
      if (result.afterVerified === false) {
        const unavailable = doc.createElement("p");
        unavailable.textContent =
          "Native after-state is unavailable. No verified diff can be shown.";
        diff.append(unavailable);
        return;
      }
      diff.append(
        renderDiffPreviewField(doc, {
          type: "diff_preview",
          id: "appliedNoteChanges",
          label: ["failed", "mismatch", "unverified"].includes(result.state)
            ? "Recorded before and after state"
            : "Applied changes",
          before: normalizeNoteSourceText(before),
          after: normalizeNoteSourceText(after),
        }).element,
      );
      if (journalActions[0]?.status === "reverted") {
        status.textContent = "Undone";
        undo.disabled = true;
      }
    })
    .catch(failed);
  return detail;
}

/**
 * What the header says about a note change: what happened to which note, and
 * how sure the panel is that it did.
 *
 * The card and the action card's note mode are the same statement on two
 * surfaces, so the wording is written once here.
 */
export function noteChangeCardHeader(result: AgentNoteChangeResultCard): {
  title: string;
  status: string;
  statusKind: string;
} {
  return {
    title: `${result.state === "unverified" ? "Verification unavailable for" : result.state === "mismatch" ? "Unexpected change to" : result.state === "failed" ? "Change not applied to" : result.state === "proposed" ? "Proposed change to" : result.state === "no_op" ? "No changes to" : "Changed"} ‘${result.title}’`,
    status: {
      proposed: "Awaiting review",
      applied: "Applied",
      failed: "Not applied",
      mismatch: "Needs inspection",
      unverified: "Unverified",
      undone: "Undone",
      no_op: "No changes needed",
    }[result.state],
    statusKind: ["failed", "mismatch", "unverified"].includes(result.state)
      ? "error"
      : result.state === "proposed"
        ? "pending"
        : "completed",
  };
}

export function renderNoteChangeCard(
  doc: Document,
  result: AgentNoteChangeResultCard,
  options: { readOnly?: boolean } = {},
): HTMLElement {
  const card = doc.createElement("section");
  card.className =
    "llm-plan-container llm-note-review-card llm-note-change-card";
  card.dataset.noteId = String(result.note.itemId);
  card.dataset.actionId = result.actionId;
  const layout = createDocumentCardLayout(doc, noteChangeCardHeader(result));
  card.append(
    layout.header,
    renderNoteChangeDetail(doc, result, layout.status, options),
  );
  return card;
}
