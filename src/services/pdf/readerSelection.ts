function pushUniqueDoc(
  docs: Document[],
  seen: Set<Document>,
  doc?: Document | null,
): void {
  if (!doc || seen.has(doc)) return;
  seen.add(doc);
  docs.push(doc);
}

function readFirstDocument(
  getters: Array<() => Document | null | undefined>,
): Document | null {
  for (const getter of getters) {
    try {
      const doc = getter();
      if (doc) return doc;
    } catch {
      // Reader documents can become dead wrappers when a long-lived tab reloads.
    }
  }
  return null;
}

export function collectReaderSelectionDocuments(reader: any): Document[] {
  const docs: Document[] = [];
  const seen = new Set<Document>();
  const readerDoc = readFirstDocument([
    () => reader?._iframeWindow?.document as Document | undefined,
    () => reader?._iframe?.contentDocument as Document | undefined,
    () => reader?._window?.document as Document | undefined,
  ]);
  pushUniqueDoc(docs, seen, readerDoc);

  let internalReader: any = null;
  try {
    internalReader = reader?._internalReader;
  } catch {
    internalReader = null;
  }
  const views = [internalReader?._primaryView, internalReader?._secondaryView];
  for (const view of views) {
    if (!view) continue;
    const viewDoc = readFirstDocument([
      () => view._iframeWindow?.document as Document | undefined,
      () => view._iframe?.contentDocument as Document | undefined,
    ]);
    pushUniqueDoc(docs, seen, viewDoc);
  }
  return docs;
}

export function getSelectionFromDocument(
  doc: Document | null | undefined,
  normalize: (text: string) => string,
): string {
  if (!doc) return "";
  try {
    const selected = doc.defaultView?.getSelection?.()?.toString() || "";
    return normalize(selected);
  } catch {
    return "";
  }
}

type ReaderSelectionPopup = {
  annotation?: { text?: unknown } | null;
};

function readSelectionPopup(
  getter: () => ReaderSelectionPopup | null | undefined,
): ReaderSelectionPopup | null {
  try {
    return getter() || null;
  } catch {
    return null;
  }
}

export function getSelectionPopupTextFromReader(
  reader: any,
  normalize: (text: string) => string,
): string {
  let internalReader: any = null;
  try {
    internalReader = reader?._internalReader;
  } catch {
    return "";
  }
  if (!internalReader) return "";

  let state: any = null;
  try {
    state = internalReader._state;
  } catch {
    state = null;
  }
  const primaryFirst =
    internalReader._lastViewPrimary !== false && state?.primary !== false;
  const primaryCandidates: Array<() => ReaderSelectionPopup | null> = [
    () => state?.primaryViewSelectionPopup || null,
    () => internalReader._primaryView?._selectionPopup || null,
  ];
  const secondaryCandidates: Array<() => ReaderSelectionPopup | null> = [
    () => state?.secondaryViewSelectionPopup || null,
    () => internalReader._secondaryView?._selectionPopup || null,
  ];
  const candidates = primaryFirst
    ? [...primaryCandidates, ...secondaryCandidates]
    : [...secondaryCandidates, ...primaryCandidates];

  for (const getter of candidates) {
    const popup = readSelectionPopup(getter);
    const text = popup?.annotation?.text;
    if (typeof text !== "string") continue;
    const normalized = normalize(text);
    if (normalized) return normalized;
  }
  return "";
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
  return getSelectionPopupTextFromReader(reader, normalize);
}
