import {
  isGlobalPortalItem,
  isPaperPortalItem,
  resolvePaperPortalBaseItem,
} from "../context/portalItems";
import {
  isAnyRuntimeGlobalPortalItem,
  resolveRuntimePaperPortalBaseItem,
  runtimePaperPortalSystemOf,
} from "../context/runtimePortalItems";
import { resolveNoteEditingParentItem } from "./scope";

export function resolveParentItemForNoteTarget(
  item: Zotero.Item,
): Zotero.Item | null {
  if (isGlobalPortalItem(item) || isAnyRuntimeGlobalPortalItem(item)) {
    return null;
  }
  if (isPaperPortalItem(item)) return resolvePaperPortalBaseItem(item);
  const runtime = runtimePaperPortalSystemOf(item);
  if (runtime) return resolveRuntimePaperPortalBaseItem(runtime, item);
  const noteParentItem = resolveNoteEditingParentItem(item);
  if (noteParentItem) return noteParentItem;
  if ((item as any).isNote?.()) return null;
  if (item.isAttachment() && item.parentID) {
    return Zotero.Items.get(item.parentID) || null;
  }
  return item;
}
