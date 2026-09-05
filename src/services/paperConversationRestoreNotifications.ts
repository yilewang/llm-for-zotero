import { forgetPaperRestoreTargetsForItems } from "../shared/paperConversationRestore";
import { zoteroChangeDispatcher } from "./zoteroChangeDispatcher";

let unsubscribe: (() => void) | null = null;

function normalizePositiveInt(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

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
            .map(normalizePositiveInt)
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
