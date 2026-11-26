import {
  getRegisteredConversationScope,
  type ConversationRegistryRow,
  type RegistryConversationKind,
} from "./conversationRegistry";
import type { ConversationSystem } from "./types";

export type ConversationRef = {
  conversationID: string;
  legacyConversationKey: number;
  system: ConversationSystem;
  kind: RegistryConversationKind;
  libraryID: number;
  paperItemID?: number;
  profileSignature?: string;
};

function normalizePositiveInt(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeConversationRefFromRegistry(
  row: ConversationRegistryRow | null | undefined,
): ConversationRef | null {
  if (!row?.valid) return null;
  const conversationID = normalizeText(row.conversationID);
  const legacyConversationKey = normalizePositiveInt(row.conversationKey);
  const libraryID = normalizePositiveInt(row.libraryID);
  const paperItemID = normalizePositiveInt(row.paperItemID);
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
  const profileSignature = normalizeText(row.profileSignature);
  if (profileSignature) {
    ref.profileSignature = profileSignature;
  }
  return ref;
}

export async function resolveConversationRefForKey(
  conversationKey: number,
): Promise<ConversationRef | null> {
  const normalizedKey = normalizePositiveInt(conversationKey);
  if (!normalizedKey) return null;
  return normalizeConversationRefFromRegistry(
    await getRegisteredConversationScope(normalizedKey),
  );
}
