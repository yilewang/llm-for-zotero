import type { PanelDomRefs } from "./domRefs";

type StatusLevel = "ready" | "warning" | "error" | "sending";

export type HandlerContext = {
  body: Element;
  getItem: () => Zotero.Item | null;
};

export type SetupHandlersContext = HandlerContext & {
  refs: PanelDomRefs;
  getConversationKey: (item: Zotero.Item) => number;
  setStatusMessage: (message: string, level: StatusLevel) => void;
  refreshChatPreservingScroll: () => void;
  refreshGlobalHistoryHeader: () => void | Promise<void>;
  logError: (message: string, ...args: unknown[]) => void;
};
