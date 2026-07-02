import { t } from "../../utils/i18n";
import type { ContextSelectionActionResult } from "./contextSelectionActions";
import type { ZoteroToolkit } from "zotero-plugin-toolkit";

type AddItemsAsDefaultContext = (
  items: Zotero.Item[],
) => Promise<ContextSelectionActionResult>;
type AfterItemsAsDefaultContextAdded = (
  result: ContextSelectionActionResult,
  items: Zotero.Item[],
) => Promise<void> | void;
type PrepareItemsAsDefaultContextTarget = () =>
  | Promise<boolean | void>
  | boolean
  | void;

type ContextSurfaceKind = "embedded" | "standalone";

type ContextSurfaceActionTarget = {
  surfaceKind: ContextSurfaceKind;
  addItemsAsDefaultContext: AddItemsAsDefaultContext;
  afterItemsAsDefaultContextAdded?: AfterItemsAsDefaultContextAdded;
  prepareItemsAsDefaultContextTarget?: PrepareItemsAsDefaultContextTarget;
};

type OpenStandaloneChat = (options?: {
  initialItem?: Zotero.Item | null;
}) => void;

type RegisterMenuDeps = {
  ztoolkit: Pick<ZoteroToolkit, "Menu">;
  getSelectedItems: () => Zotero.Item[];
  openStandaloneChat: OpenStandaloneChat;
};

type DispatchDeps = {
  openStandaloneChat: OpenStandaloneChat;
};

const MENU_ID = "llmforzotero-add-items-as-context";
const MENU_SEPARATOR_BEFORE_ID = "llmforzotero-add-items-as-context-before";
const MENU_SEPARATOR_AFTER_ID = "llmforzotero-add-items-as-context-after";
const activeContextSurfaceTargets = new Map<
  Element,
  ContextSurfaceActionTarget
>();
const pendingStandaloneContextItems: Zotero.Item[][] = [];

function getConnectedContextSurfaceTarget(
  surfaceKind?: ContextSurfaceKind,
): ContextSurfaceActionTarget | null {
  for (const [body, target] of Array.from(
    activeContextSurfaceTargets.entries(),
  ).reverse()) {
    if (!(body as Element).isConnected) {
      activeContextSurfaceTargets.delete(body);
      continue;
    }
    if (!surfaceKind || target.surfaceKind === surfaceKind) return target;
  }
  return null;
}

export function registerContextSurfaceActionTarget(
  body: Element,
  target: ContextSurfaceActionTarget,
): () => void {
  activeContextSurfaceTargets.set(body, target);
  if (target.surfaceKind === "standalone") {
    void drainPendingStandaloneContextItems(target);
  }
  return () => {
    if (activeContextSurfaceTargets.get(body) === target) {
      activeContextSurfaceTargets.delete(body);
    }
  };
}

export async function dispatchZoteroItemsAsContext(
  items: Zotero.Item[],
  deps: DispatchDeps,
): Promise<{ dispatched: boolean; openedStandalone: boolean }> {
  const selectedItems = items.filter(Boolean);
  if (!selectedItems.length) {
    return { dispatched: false, openedStandalone: false };
  }
  const standaloneTarget = getConnectedContextSurfaceTarget("standalone");
  if (standaloneTarget) {
    deps.openStandaloneChat({ initialItem: null });
    const preparedTarget =
      await prepareStandaloneContextTarget(standaloneTarget);
    if (!preparedTarget) {
      return { dispatched: false, openedStandalone: true };
    }
    const result =
      await preparedTarget.addItemsAsDefaultContext(selectedItems);
    await preparedTarget.afterItemsAsDefaultContextAdded?.(
      result,
      selectedItems,
    );
    return { dispatched: true, openedStandalone: true };
  }
  pendingStandaloneContextItems.push(selectedItems);
  deps.openStandaloneChat({ initialItem: null });
  return { dispatched: false, openedStandalone: true };
}

export function registerZoteroItemContextMenu(deps: RegisterMenuDeps): void {
  deps.ztoolkit.Menu?.register?.("item", {
    tag: "menuseparator",
    id: MENU_SEPARATOR_BEFORE_ID,
  });
  deps.ztoolkit.Menu?.register?.("item", {
    tag: "menuitem",
    id: MENU_ID,
    label: t("Add Items as Context to LLM-for-Zotero"),
    commandListener: () => {
      const items = deps.getSelectedItems();
      void dispatchZoteroItemsAsContext(items, {
        openStandaloneChat: deps.openStandaloneChat,
      });
    },
  });
  deps.ztoolkit.Menu?.register?.("item", {
    tag: "menuseparator",
    id: MENU_SEPARATOR_AFTER_ID,
  });
}

async function drainPendingStandaloneContextItems(
  fallbackTarget: ContextSurfaceActionTarget,
): Promise<void> {
  while (pendingStandaloneContextItems.length) {
    const items = pendingStandaloneContextItems.shift();
    if (items?.length) {
      const target =
        getConnectedContextSurfaceTarget("standalone") || fallbackTarget;
      const preparedTarget = await prepareStandaloneContextTarget(target);
      if (!preparedTarget) continue;
      const result = await preparedTarget.addItemsAsDefaultContext(items);
      await preparedTarget.afterItemsAsDefaultContextAdded?.(result, items);
    }
  }
}

async function prepareStandaloneContextTarget(
  target: ContextSurfaceActionTarget,
): Promise<ContextSurfaceActionTarget | null> {
  if (target.surfaceKind !== "standalone") return target;
  const prepared = await target.prepareItemsAsDefaultContextTarget?.();
  if (prepared === false) return null;
  return getConnectedContextSurfaceTarget("standalone") || target;
}

export async function drainPendingStandaloneContextItemsForTests(
  addItemsAsDefaultContext: AddItemsAsDefaultContext,
): Promise<void> {
  await drainPendingStandaloneContextItems({
    surfaceKind: "standalone",
    addItemsAsDefaultContext,
  });
}

export function clearContextSurfaceActionTargetsForTests(): void {
  activeContextSurfaceTargets.clear();
  pendingStandaloneContextItems.length = 0;
}
