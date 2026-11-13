/**
 * Whether a document still has an open window. A closed chat window's nodes
 * can still report `isConnected`, but writing markup into their document
 * crashes Zotero.
 */
export function isLiveDocument(doc: Document | null | undefined): boolean {
  const win = doc?.defaultView;
  return Boolean(win) && !win!.closed;
}

/**
 * Whether a panel body can still be drawn into: it is in its document, and
 * that document has an open window. Streaming and refresh paths check this
 * instead of `isConnected` alone.
 */
export function isLivePanelBody(body: Element): boolean {
  return body.isConnected && isLiveDocument(body.ownerDocument);
}
