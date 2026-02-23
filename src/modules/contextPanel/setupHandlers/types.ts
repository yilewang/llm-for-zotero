export type HandlerContext = {
  body: Element;
  getItem: () => Zotero.Item | null;
};
