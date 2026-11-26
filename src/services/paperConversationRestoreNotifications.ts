import { forgetPaperRestoreTargetsForItems } from "../shared/paperConversationRestore";
import { zoteroChangeDispatcher } from "./zoteroChangeDispatcher";
import { positiveIntOrNull } from "../core/values";

let unsubscribe: (() => void) | null = null;

export function registerPaperConversationRestoreNotifications(): void {
  if (unsubscribe) return;
  unsubscribe = zoteroChangeDispatcher.subscribe(
    "paper-restore-selection",
    (change) => {
      if (
        change.type !== "item" ||
        (change.event !== "delete" &&
          change.event !== "trash" &&
          change.event !== "remove")
      ) {
        return;
      }
      const itemIDs = [
        ...new Set(
          change.ids
            .map(positiveIntOrNull)
            .filter((id): id is number => id !== null),
        ),
      ];
      forgetPaperRestoreTargetsForItems(itemIDs);
    },
  );
}

export function unregisterPaperConversationRestoreNotifications(): void {
  unsubscribe?.();
  unsubscribe = null;
}
