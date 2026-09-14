import type { AgentSavedNoteResultCard } from "../../../agent/types";
import { createDocumentCardLayout } from "../documentCard";
import { parseSanitizedRenderedHtml } from "../renderedMarkdown";
import {
  navigatePlanDocumentCitationSource,
  planDocumentCitationSourceHref,
} from "../planDocumentPresentation";

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
      ? (event.payload?.contract as
          | import("../../../agent/contracts/types").AgentActionContract
          | undefined)
      : undefined;
  return (
    !hasPlan &&
    Boolean(contract?.intent?.semantic) &&
    contract?.intent?.deliverableIntent === "chat"
  );
}

function renderNativeNotePreview(
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
  const title = source.querySelector("h1, h2, h3, h4, h5, h6");
  const displayTitle = title?.textContent?.trim() || result.title;
  if (title === source.firstElementChild) title?.remove();
  target.classList.add("llm-rendered-markdown");
  target.append(...(Array.from(source.childNodes) as Node[]));
  return displayTitle;
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
  const source = {
    libraryID: result.note.libraryID,
    itemKey: result.note.key,
    evidenceRefs: [],
  };
  const destination = doc.createElement("a");
  destination.className = "llm-saved-note-destination";
  destination.textContent = `Open note in ${result.destination} ↗`;
  destination.href = planDocumentCitationSourceHref(source);
  destination.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
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
  });
  title.textContent = renderNativeNotePreview(doc, result, content);
  card.append(header, destination, content);
  return card;
}
