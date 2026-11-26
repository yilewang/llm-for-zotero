import {
  getRegisteredConversationScope,
  type ConversationRegistryRow,
  type RegistryConversationKind,
} from "./conversationRegistry";
import type { ConversationSystem } from "./types";
import { positiveIntOrZero, trimmedString } from "../core/values";

export type ConversationRef = {
  conversationID: string;
  legacyConversationKey: number;
  system: ConversationSystem;
  kind: RegistryConversationKind;
  libraryID: number;
  paperItemID?: number;
  profileSignature?: string;
};

export function normalizeConversationRefFromRegistry(
  row: ConversationRegistryRow | null | undefined,
): ConversationRef | null {
  if (!row?.valid) return null;
  const conversationID = trimmedString(row.conversationID);
  const legacyConversationKey = positiveIntOrZero(row.conversationKey);
  const libraryID = positiveIntOrZero(row.libraryID);
  const paperItemID = positiveIntOrZero(row.paperItemID);
  if (!conversationID || !legacyConversationKey || !libraryID) return null;
  if (row.kind === "paper" && !paperItemID) return null;
  const ref: ConversationRef = {
    conversationID,
    legacyConversationKey,
    system: row.system,
    kind: row.kind,
    libraryID,
  };
  if (row.kind === "paper") {
    ref.paperItemID = paperItemID;
  }
  const profileSignature = trimmedString(row.profileSignature);
  if (profileSignature) {
    ref.profileSignature = profileSignature;
  }
  return ref;
}

export async function resolveConversationRefForKey(
  conversationKey: number,
): Promise<ConversationRef | null> {
  const normalizedKey = positiveIntOrZero(conversationKey);
  if (!normalizedKey) return null;
  return normalizeConversationRefFromRegistry(
    await getRegisteredConversationScope(normalizedKey),
  );
}
