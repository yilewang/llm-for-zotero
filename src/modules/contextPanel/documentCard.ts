/** Shared presentation for generated documents, saved notes and pending edits.
 * Actions belong to the caller: rendering a draft never grants write authority.
 */
export function createDocumentCardLayout(
  doc: Document,
  options: { title: string; status: string; statusKind: string },
) {
  const header = doc.createElement("header");
  header.className = "llm-plan-header llm-plan-document-header";
  const heading = doc.createElement("div");
  heading.className = "llm-plan-heading";
  const title = doc.createElement("span");
  title.className = "llm-plan-title";
  title.textContent = options.title;
  const status = doc.createElement("span");
  status.className = "llm-plan-status";
  status.dataset.status = options.statusKind;
  status.textContent = options.status;
  heading.append(title, status);
  const actions = doc.createElement("div");
  actions.className = "llm-plan-document-actions";
  header.append(heading, actions);
  const content = doc.createElement("article");
  content.className = "llm-plan-markdown llm-plan-document-content";
  return { header, heading, title, status, actions, content };
}
