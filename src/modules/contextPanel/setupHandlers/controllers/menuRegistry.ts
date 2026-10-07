/** The panel menus whose closers live in one registry per panel setup. */
export type MenuId =
  | "response"
  | "prompt"
  | "export"
  | "history"
  | "historyNew"
  | "historyRow"
  | "slash"
  | "model"
  | "reasoning"
  | "retryModel";

/** Menus that close, in this order, before the model menu opens. */
export const MENUS_CLOSED_BY_MODEL_MENU: readonly MenuId[] = [
  "slash",
  "retryModel",
  "reasoning",
  "prompt",
  "historyNew",
  "history",
];

/** Menus that close, in this order, before the reasoning menu opens. */
export const MENUS_CLOSED_BY_REASONING_MENU: readonly MenuId[] = [
  "slash",
  "retryModel",
  "model",
  "prompt",
  "historyNew",
  "history",
];

/** Menus that close, in this order, before the retry-model menu opens. */
export const MENUS_CLOSED_BY_RETRY_MODEL_MENU: readonly MenuId[] = [
  "slash",
  "response",
  "export",
  "prompt",
  "historyNew",
  "history",
  "model",
  "reasoning",
];

export type MenuRegistry = {
  /** Registering an id again replaces its closer and its open probe. */
  register(id: MenuId, close: () => void, isOpen?: () => boolean): void;
  /** Does nothing if no closer is registered for `id`. */
  close(id: MenuId): void;
  /** Closes the menus in the given order. */
  closeMany(ids: readonly MenuId[]): void;
  /** False if `id` has no registered open probe. */
  isOpen(id: MenuId): boolean;
  /** A thunk that calls whatever closer is registered when it runs. */
  closer(id: MenuId): () => void;
};

export function createMenuRegistry(): MenuRegistry {
  const entries = new Map<
    MenuId,
    { close: () => void; isOpen?: () => boolean }
  >();
  const close = (id: MenuId): void => {
    entries.get(id)?.close();
  };
  return {
    register: (id, closeMenu, isOpen) => {
      entries.set(id, { close: closeMenu, isOpen });
    },
    close,
    closeMany: (ids) => {
      for (const id of ids) close(id);
    },
    isOpen: (id) => Boolean(entries.get(id)?.isOpen?.()),
    closer: (id) => () => close(id),
  };
}
