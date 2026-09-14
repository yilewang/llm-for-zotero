import { getAgentApi } from "../../../agent";
import { listJournalActions } from "../../../agent/store/changeJournal";
import { readRecoveryText } from "../../../agent/store/journalRecoveryBlobStore";
import type { AgentNoteChangeResultCard } from "../../../agent/types";
import { createDocumentCardLayout } from "../documentCard";
import { normalizeNoteSourceText } from "../notes";
import { navigatePlanDocumentCitationSource } from "../planDocumentPresentation";
import { renderDiffPreviewField } from "./diffPreviewField";

export function renderNoteChangeCard(
  doc: Document,
  result: AgentNoteChangeResultCard,
): HTMLElement {
  const card = doc.createElement("section");
  card.className =
    "llm-plan-container llm-note-review-card llm-note-change-card";
  card.dataset.noteId = String(result.note.itemId);
  card.dataset.actionId = result.actionId;
  const layout = createDocumentCardLayout(doc, {
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
  });
  const description = doc.createElement("p");
  description.className = "llm-note-review-description";
  description.textContent = result.description;
  const open = doc.createElement("button");
  open.className = "llm-plan-action";
  open.type = "button";
  open.textContent = "Open note";
  const undo = doc.createElement("button");
  undo.className = "llm-plan-action";
  undo.type = "button";
  undo.textContent = "Undo";
  undo.disabled = result.state !== "applied";
  layout.actions.append(open, undo);
  card.append(layout.header, description, layout.content);
  const failed = (error: unknown) => {
    layout.status.textContent =
      error instanceof Error ? error.message : String(error);
    layout.status.dataset.status = "error";
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
        layout.status.textContent =
          outcome.effect === "partial"
            ? "Partially undone; inspect remaining effects"
            : "Undone";
        layout.status.dataset.status =
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
    .then(([before, after, actions]) => {
      if (result.afterVerified === false) {
        const unavailable = doc.createElement("p");
        unavailable.textContent =
          "Native after-state is unavailable. No verified diff can be shown.";
        layout.content.append(unavailable);
        return;
      }
      layout.content.append(
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
      if (actions[0]?.status === "reverted") {
        layout.status.textContent = "Undone";
        undo.disabled = true;
      }
    })
    .catch(failed);
  return card;
}
