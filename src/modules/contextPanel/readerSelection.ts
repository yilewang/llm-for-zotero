function pushUniqueDoc(
  docs: Document[],
  seen: Set<Document>,
  doc?: Document | null,
): void {
  if (!doc || seen.has(doc)) return;
  seen.add(doc);
  docs.push(doc);
}

export function collectReaderSelectionDocuments(reader: any): Document[] {
  const docs: Document[] = [];
  const seen = new Set<Document>();
  const readerDoc =
    (reader?._iframeWindow?.document as Document | undefined) ||
    (reader?._iframe?.contentDocument as Document | undefined) ||
    (reader?._window?.document as Document | undefined);
  pushUniqueDoc(docs, seen, readerDoc || null);

  const internalReader = reader?._internalReader;
  const views = [internalReader?._primaryView, internalReader?._secondaryView];
  for (const view of views) {
    if (!view) continue;
    const viewDoc =
      (view._iframeWindow?.document as Document | undefined) ||
      (view._iframe?.contentDocument as Document | undefined);
    pushUniqueDoc(docs, seen, viewDoc || null);
  }
  return docs;
}

export function getSelectionFromDocument(
  doc: Document | null | undefined,
  normalize: (text: string) => string,
): string {
  if (!doc) return "";
  const selected = doc.defaultView?.getSelection?.()?.toString() || "";
  return normalize(selected);
}

export function getFirstSelectionFromReader(
  reader: any,
  normalize: (text: string) => string,
): string {
  const docs = collectReaderSelectionDocuments(reader);
  for (const doc of docs) {
    const text = getSelectionFromDocument(doc, normalize);
    if (text) return text;
  }
  return "";
}
