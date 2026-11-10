import type { AgentSavedNoteResultCard } from "../../../agent/types";
import { createDocumentCardLayout } from "../documentCard";
import { parseSanitizedRenderedHtml } from "../renderedMarkdown";
import {
  navigatePlanDocumentCitationSource,
  planDocumentCitationSourceHref,
} from "../planDocumentPresentation";

/**
 * The action contract a classifier-era run recorded. No run records one now;
 * a stored trace is read for its intent only.
 */
type StoredActionContract = {
  intent?: { semantic?: unknown; deliverableIntent?: string };
};

export function savedNoteIsPrimaryOutcome(
  events: readonly import("../../../agent/types").AgentEvent[],
  hasPlan: boolean,
): boolean {
  const event = [...events]
    .reverse()
    .find(
      (event) =>
        event.type === "provider_event" &&
        event.providerType === "agent_action_contract",
    );
  const contract =
    event?.type === "provider_event"
      ? (event.payload?.contract as StoredActionContract | undefined)
      : undefined;
  return (
    !hasPlan &&
    Boolean(contract?.intent?.semantic) &&
    contract?.intent?.deliverableIntent === "chat"
  );
}

/** The note's own body, as Zotero stores it, with its title lifted out. */
export function renderNativeNotePreview(
  doc: Document,
  result: AgentSavedNoteResultCard,
  target: HTMLElement,
): string {
  const fragment = parseSanitizedRenderedHtml(result.bodyHtml, doc);
  const modelLabel = (
    Array.from(fragment.querySelectorAll("p > strong")) as Element[]
  ).find((node) => node.textContent?.trim() === "Model response:");
  const following = modelLabel?.parentElement?.nextElementSibling;
  const preceding = modelLabel?.parentElement?.previousElementSibling;
  // Current exports put content first so Zotero uses its heading as the title.
  // Existing metadata-first notes retain their native HTML and preview path.
  const responseBody =
    following?.tagName.toLowerCase() === "div" ? following : preceding;
  const source =
    responseBody?.tagName.toLowerCase() === "div" &&
    /Written by LLM-for-Zotero\./.test(fragment.textContent || "")
      ? responseBody
      : fragment;
  // Question-first notes lead with a heading that holds the user's question.
  // It is the card title, and the answer body below it may open with its own
  // headings that must stay in the preview.
  const leading = fragment.firstElementChild;
  const leadingQuestion =
    modelLabel && leading && /^h[1-6]$/i.test(leading.tagName) ? leading : null;
  if (leadingQuestion && source !== fragment) {
    const questionTitle = leadingQuestion.textContent?.trim() || result.title;
    target.classList.add("llm-rendered-markdown");
    target.append(...(Array.from(source.childNodes) as Node[]));
    return questionTitle;
  }
  const title = source.querySelector("h1, h2, h3, h4, h5, h6");
  const displayTitle = title?.textContent?.trim() || result.title;
  if (title === source.firstElementChild) title?.remove();
  target.classList.add("llm-rendered-markdown");
  target.append(...(Array.from(source.childNodes) as Node[]));
  return displayTitle;
}

/** Where the note lives, as the citation navigator addresses it. */
function noteCitationSource(result: AgentSavedNoteResultCard) {
  return {
    libraryID: result.note.libraryID,
    itemKey: result.note.key,
    evidenceRefs: [],
  };
}

/**
 * Open the saved note in Zotero, reporting a note that is gone through `status`.
 *
 * The card's destination link and the action row's button are the same act, so
 * the lookup, the navigation and the failure message are written once here.
 */
function openSavedNote(
  result: AgentSavedNoteResultCard,
  status: HTMLElement,
): void {
  const source = noteCitationSource(result);
  void (async () => {
    const note = Zotero.Items.getByLibraryAndKey(
      source.libraryID,
      source.itemKey,
    );
    if (
      !note ||
      !note.isNote() ||
      note.deleted ||
      !(await navigatePlanDocumentCitationSource(source))
    )
      throw new Error("Note is unavailable");
    Zotero.getMainWindow()?.focus();
  })().catch(() => {
    status.textContent = "Note is unavailable";
    status.dataset.status = "error";
  });
}

/** The saved note as an action row opens it: what it says, and the way in. */
export function renderSavedNoteDetail(
  doc: Document,
  result: AgentSavedNoteResultCard,
  status: HTMLElement,
): HTMLElement {
  const detail = doc.createElement("div");
  const preview = doc.createElement("div");
  preview.className = "llm-plan-markdown llm-note-preview";
  renderNativeNotePreview(doc, result, preview);
  const actions = doc.createElement("div");
  actions.className = "llm-agent-action-row-actions";
  const open = doc.createElement("button");
  open.className = "llm-plan-action";
  open.type = "button";
  open.textContent = "Open note";
  open.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openSavedNote(result, status);
  });
  actions.append(open);
  detail.append(preview, actions);
  return detail;
}

/** A saved outcome, outside the activity disclosure and without approval controls. */
export function renderSavedNoteCard(
  doc: Document,
  result: AgentSavedNoteResultCard,
): HTMLElement {
  const card = doc.createElement("section");
  card.className = "llm-plan-container llm-saved-note-card";
  card.dataset.noteId = String(result.note.itemId);
  const { header, content, status, title } = createDocumentCardLayout(doc, {
    title: result.title,
    status: "Saved",
    statusKind: "completed",
  });
  const destination = doc.createElement("a");
  destination.className = "llm-saved-note-destination";
  destination.textContent = `Open note in ${result.destination} ↗`;
  destination.href = planDocumentCitationSourceHref(noteCitationSource(result));
  destination.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openSavedNote(result, status);
  });
  title.textContent = renderNativeNotePreview(doc, result, content);
  card.append(header, destination, content);
  return card;
}
