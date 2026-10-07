/**
 * The synchronous mount core every full panel mount shares.
 *
 * Order is load-bearing: setupHandlers reads the panel registration and,
 * through the panel root, the standalone marker and host binding that a
 * caller writes in beforeRegister. Async tails (conversation load, shortcut
 * render, chat refresh) stay with each caller because they differ per site.
 */
import { retainClaudeRuntimeForBody } from "../../claudeCode/runtimeRetention";
import { buildUI } from "./buildUI";
import { setupHandlers, type SetupHandlersHooks } from "./setupHandlers";
import { activeContextPanelRawItems, activeContextPanels } from "./state";

export type PanelShellMount = {
  body: Element;
  /** Item the UI is built for. */
  renderItem: Zotero.Item | null | undefined;
  /** Runs after the UI exists and before the panel is registered. */
  beforeRegister?: (panelRoot: HTMLElement | null) => void;
  /** Registered as the panel's mounted-item getter; it may be live. */
  getMountedItem: () => Zotero.Item | null;
  rawItem: Zotero.Item | null;
  /**
   * Item whose Claude runtime this mount retains explicitly. Omit it when
   * the caller relies on setupHandlers' own retention; null still retains.
   */
  retainFor?: Zotero.Item | null;
  /** Item handed to setupHandlers. */
  setupItem: Zotero.Item | null | undefined;
  hooks?: SetupHandlersHooks;
};

type PanelShellDeps = {
  buildUI: (body: Element, item?: Zotero.Item | null) => void;
  retainClaudeRuntimeForBody: (
    body: Element,
    item: Zotero.Item | null,
  ) => Promise<void>;
  setupHandlers: (
    body: Element,
    item?: Zotero.Item | null,
    hooks?: SetupHandlersHooks,
  ) => void;
};

const defaultDeps: PanelShellDeps = {
  buildUI,
  retainClaudeRuntimeForBody,
  setupHandlers,
};

/**
 * Builds the panel, registers it, and wires its handlers. Returns the panel
 * root that buildUI created, if any.
 *
 * The second parameter is a test seam only; production callers omit it.
 */
export function mountPanelShell(
  mount: PanelShellMount,
  deps: PanelShellDeps = defaultDeps,
): HTMLElement | null {
  const { body } = mount;
  deps.buildUI(body, mount.renderItem);
  const panelRoot = body.querySelector("#llm-main") as HTMLElement | null;
  mount.beforeRegister?.(panelRoot);
  activeContextPanels.set(body, mount.getMountedItem);
  activeContextPanelRawItems.set(body, mount.rawItem);
  if (mount.retainFor !== undefined) {
    void deps.retainClaudeRuntimeForBody(body, mount.retainFor);
  }
  deps.setupHandlers(body, mount.setupItem, mount.hooks);
  return panelRoot;
}
