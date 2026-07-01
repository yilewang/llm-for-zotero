import { t } from "../../utils/i18n";
import type { ContextSelectionActionResult } from "./contextSelectionActions";
import type { ZoteroToolkit } from "zotero-plugin-toolkit";

type AddItemsAsDefaultContext = (
  items: Zotero.Item[],
) => Promise<ContextSelectionActionResult>;

type ContextSurfaceKind = "embedded" | "standalone";

type ContextSurfaceActionTarget = {
  surfaceKind: ContextSurfaceKind;
  addItemsAsDefaultContext: AddItemsAsDefaultContext;
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
    void drainPendingStandaloneContextItems(target.addItemsAsDefaultContext);
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
    await standaloneTarget.addItemsAsDefaultContext(selectedItems);
    return { dispatched: true, openedStandalone: true };
  }
  pendingStandaloneContextItems.push(selectedItems);
  deps.openStandaloneChat({ initialItem: null });
  return { dispatched: false, openedStandalone: true };
}

export function registerZoteroItemContextMenu(deps: RegisterMenuDeps): void {
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
}

async function drainPendingStandaloneContextItems(
  addItemsAsDefaultContext: AddItemsAsDefaultContext,
): Promise<void> {
  while (pendingStandaloneContextItems.length) {
    const items = pendingStandaloneContextItems.shift();
    if (items?.length) await addItemsAsDefaultContext(items);
  }
}

export async function drainPendingStandaloneContextItemsForTests(
  addItemsAsDefaultContext: AddItemsAsDefaultContext,
): Promise<void> {
  await drainPendingStandaloneContextItems(addItemsAsDefaultContext);
}

export function clearContextSurfaceActionTargetsForTests(): void {
  activeContextSurfaceTargets.clear();
  pendingStandaloneContextItems.length = 0;
}
