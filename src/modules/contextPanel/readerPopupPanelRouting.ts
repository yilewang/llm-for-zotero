type ReaderTabID = string | number | null | undefined;

type ZoteroDeckElement = Element & {
  selectedPanel?: Element | null;
  selectedIndex?: number;
};

export type ReaderPopupPanelTarget = {
  body: Element;
  root: HTMLDivElement;
};

export type ResolveReaderPopupPanelTargetInput = {
  preferredDocument?: Document | null;
  documents: Iterable<Document>;
  tabID: ReaderTabID;
};

function normalizeReaderTabID(tabID: ReaderTabID): string {
  if (typeof tabID !== "string" && typeof tabID !== "number") return "";
  return `${tabID}`.trim();
}

function getDeckChildren(deck: Element): Element[] {
  return Array.from(deck.children).filter(
    (child): child is Element => child.nodeType === 1,
  );
}

/**
 * Zotero retains one item-details pane per reader tab inside a XUL deck.
 * Inactive deck children remain connected and can still report client rects,
 * so tab identity is the only reliable way to select the active reader pane.
 */
export function getReaderContextPanelForTab(
  doc: Document,
  tabID: ReaderTabID,
): Element | null {
  const deck = doc.getElementById(
    "zotero-context-pane-item-deck",
  ) as ZoteroDeckElement | null;
  if (!deck) return null;

  const children = getDeckChildren(deck);
  const normalizedTabID = normalizeReaderTabID(tabID);
  if (normalizedTabID) {
    const matchingTab = children.find(
      (child) => child.getAttribute("data-tab-id") === normalizedTabID,
    );
    if (matchingTab) return matchingTab;
    return null;
  }

  const selectedPanel = deck.selectedPanel;
  if (selectedPanel && deck.contains(selectedPanel)) {
    return selectedPanel;
  }

  const selectedIndex = Number(deck.selectedIndex);
  if (
    Number.isInteger(selectedIndex) &&
    selectedIndex >= 0 &&
    selectedIndex < children.length
  ) {
    return children[selectedIndex];
  }
  return null;
}

export function isPanelInReaderContextForTab(
  root: Element,
  tabID: ReaderTabID,
): boolean {
  const readerPanel = getReaderContextPanelForTab(root.ownerDocument, tabID);
  return Boolean(
    readerPanel && (readerPanel === root || readerPanel.contains(root)),
  );
}

function getPanelTarget(
  doc: Document,
  tabID: ReaderTabID,
): ReaderPopupPanelTarget | null {
  const readerPanel = getReaderContextPanelForTab(doc, tabID);
  if (!readerPanel) return null;
  const root = (
    readerPanel.matches?.("#llm-main")
      ? readerPanel
      : readerPanel.querySelector?.("#llm-main")
  ) as HTMLDivElement | null;
  if (!root) return null;
  return {
    body: root.parentElement || root,
    root,
  };
}

function dedupeDocuments(
  documents: Iterable<Document>,
  preferredDocument?: Document | null,
): Document[] {
  const result: Document[] = [];
  const seen = new Set<Document>();
  const push = (doc?: Document | null) => {
    if (!doc || seen.has(doc)) return;
    seen.add(doc);
    result.push(doc);
  };
  push(preferredDocument);
  for (const doc of documents) push(doc);
  return result;
}

/**
 * Resolve the exact LLM panel owned by the reader that raised a popup.
 * Known tab IDs never fall back to a merely visible or selected panel, and
 * the standalone chat window, which has no reader deck, is never a target.
 */
export function resolveReaderPopupPanelTarget(
  input: ResolveReaderPopupPanelTargetInput,
): ReaderPopupPanelTarget | null {
  const documents = dedupeDocuments(input.documents, input.preferredDocument);
  const normalizedTabID = normalizeReaderTabID(input.tabID);
  if (normalizedTabID) {
    const matches = documents
      .map((doc) => getPanelTarget(doc, normalizedTabID))
      .filter((target): target is ReaderPopupPanelTarget => Boolean(target));
    const uniqueRoots = new Set(matches.map((target) => target.root));
    return uniqueRoots.size === 1 ? matches[0] : null;
  }

  if (input.preferredDocument) {
    const preferred = getPanelTarget(input.preferredDocument, null);
    if (preferred) return preferred;
  }

  const matches = documents
    .filter((doc) => doc !== input.preferredDocument)
    .map((doc) => getPanelTarget(doc, null))
    .filter((target): target is ReaderPopupPanelTarget => Boolean(target));
  const uniqueRoots = new Set(matches.map((target) => target.root));
  return uniqueRoots.size === 1 ? matches[0] : null;
}
