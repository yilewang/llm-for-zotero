import type {
  AgentConfirmationResolution,
  AgentPendingAction,
  AgentPendingField,
} from "../../../agent/types";
import { createDocumentCardLayout } from "../documentCard";
import {
  parseSanitizedRenderedHtml,
  renderRenderedMarkdownInto,
} from "../renderedMarkdown";
import { normalizeNoteSourceText } from "../notes";

type ContentField = Extract<AgentPendingField, { type: "textarea" }>;
type DiffField = Extract<AgentPendingField, { type: "diff_preview" }>;

export function getNoteReviewContent(
  action: AgentPendingAction,
): ContentField | undefined {
  if (
    action.mode !== "review" ||
    !["note_write", "edit_current_note"].includes(action.toolName)
  )
    return;
  return action.fields.find(
    (field): field is ContentField =>
      field.type === "textarea" && field.id === "content",
  );
}

export function renderNoteReviewCard(params: {
  doc: Document;
  pending: { requestId: string; action: AgentPendingAction };
  field: ContentField;
  confirmActionId: string;
  cancelActionId: string;
  resolve: (resolution: AgentConfirmationResolution) => void;
  renderChanges: (field: DiffField) => {
    element: HTMLElement;
    update: (value: string) => void;
  };
}): HTMLDivElement {
  const { doc, pending, field } = params;
  const card = doc.createElement("div");
  card.className =
    "llm-agent-hitl-card llm-plan-container llm-note-review-card";
  card.dataset.requestId = pending.requestId;
  const {
    header,
    actions,
    content: preview,
    status,
  } = createDocumentCardLayout(doc, {
    title: pending.action.title,
    status: "Awaiting approval",
    statusKind: "awaiting_approval",
  });
  preview.classList.add("llm-note-review-preview");
  const description = doc.createElement("p");
  description.className = "llm-note-review-description";
  description.textContent =
    pending.action.description || "Review the note before saving.";
  const edit = doc.createElement("button");
  edit.type = "button";
  edit.className = "llm-plan-action llm-note-review-edit";
  edit.textContent = "Edit";
  edit.setAttribute("aria-label", "Edit note content");
  edit.setAttribute("aria-expanded", "false");
  actions.appendChild(edit);
  const editor = doc.createElement("textarea");
  editor.className = "llm-note-review-editor";
  editor.setAttribute("aria-label", field.label || "Note content");
  editor.value = field.value || "";
  editor.spellcheck = true;
  editor.hidden = true;
  card.append(header, description, preview, editor);

  // Updates retain the existing live diff renderer. Appends expose the current
  // note separately: the editable payload is only the addition, never the base.
  const diff = pending.action.fields.find(
    (entry): entry is DiffField => entry.type === "diff_preview",
  );
  let updateChanges: ((value: string) => void) | undefined;
  if (diff) {
    const details = doc.createElement("details");
    details.className = "llm-note-review-changes";
    details.open = diff.sourceFieldId === field.id;
    const summary = doc.createElement("summary");
    summary.textContent =
      diff.sourceFieldId === field.id ? "Show changes" : "Current note";
    details.appendChild(summary);
    if (diff.sourceFieldId === field.id) {
      const changes = params.renderChanges(diff);
      details.appendChild(changes.element);
      updateChanges = changes.update;
    } else {
      const before = doc.createElement("article");
      before.className = "llm-plan-markdown";
      renderRenderedMarkdownInto(before, diff.before || "", doc);
      details.appendChild(before);
    }
    card.appendChild(details);
  }
  const footer = doc.createElement("div");
  footer.className = "llm-plan-actions llm-note-review-actions";
  const cancel = doc.createElement("button");
  cancel.type = "button";
  cancel.className = "llm-plan-action";
  cancel.dataset.kind = "cancel";
  cancel.textContent = pending.action.cancelLabel || "Cancel";
  const approve = doc.createElement("button");
  approve.type = "button";
  approve.className = "llm-plan-action llm-plan-approve";
  approve.dataset.kind = "save";
  approve.textContent = pending.action.confirmLabel || "Approve";
  footer.append(cancel, approve);
  card.appendChild(footer);
  let settled = false;
  const refresh = () => {
    if (field.contentFormat === "html") {
      preview.replaceChildren(parseSanitizedRenderedHtml(editor.value, doc));
      preview.classList.add("llm-rendered-markdown");
    } else {
      renderRenderedMarkdownInto(preview, editor.value, doc);
    }
    updateChanges?.(normalizeNoteSourceText(editor.value));
    approve.disabled = settled || !editor.value.trim();
  };
  edit.addEventListener("click", () => {
    if (settled) return;
    editor.hidden = !editor.hidden;
    preview.hidden = !editor.hidden;
    edit.textContent = editor.hidden ? "Edit" : "Preview";
    edit.setAttribute(
      "aria-label",
      editor.hidden ? "Edit note content" : "Preview note content",
    );
    edit.setAttribute("aria-expanded", editor.hidden ? "false" : "true");
    if (editor.hidden) refresh();
    else editor.focus();
  });
  editor.addEventListener("input", () => {
    approve.disabled = settled || !editor.value.trim();
  });
  const settle = (approved: boolean) => {
    if (settled || (approved && !editor.value.trim())) return;
    settled = true;
    refresh();
    editor.hidden = true;
    preview.hidden = false;
    for (const button of [edit, cancel, approve]) button.disabled = true;
    editor.disabled = true;
    status.textContent = approved ? "Approved" : "Cancelled";
    status.dataset.status = approved ? "approved" : "cancelled";
    params.resolve({
      approved,
      actionId: approved ? params.confirmActionId : params.cancelActionId,
      ...(approved ? { data: { content: editor.value } } : {}),
    });
  };
  cancel.addEventListener("click", () => settle(false));
  approve.addEventListener("click", () => settle(true));
  refresh();
  return card;
}
