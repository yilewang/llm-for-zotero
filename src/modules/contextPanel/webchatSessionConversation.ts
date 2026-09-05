import { conversationRepository } from "../../core/conversations/repository";
import { findWebchatSessionPaperConversationKey } from "../../utils/chatStore";

declare const ztoolkit: any;

export type WebChatSessionConversationResult = {
  conversationKey: number;
  sessionVersion?: number;
  reused: boolean;
};

export type WebChatSessionConversationRepository = Pick<
  typeof conversationRepository,
  "getCatalogEntry" | "createCatalogEntry"
>;

function normalizePositiveInt(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

// The find-then-create below is not atomic, and webchat-mode entry can fire
// concurrently (rapid model toggles, the same paper open in two windows).
// Deduplicating in-flight resolutions per paper keeps one session row per
// paper instead of racing two creates.
const inFlightResolutions = new Map<
  string,
  Promise<WebChatSessionConversationResult | null>
>();

/**
 * Resolve the local anchor row for a webchat session on a paper.
 *
 * Webchat conversations live on the provider site; the local row only gives
 * the panel a conversation key while the session is active. It is created
 * flagged (hidden from history, swept at startup) and reused across mode
 * entries so repeated webchat use never accumulates catalog rows. A user's
 * blank normal draft is never claimed for this — webchat must not hide or
 * consume conversations the user created.
 */
export async function resolveWebChatSessionConversation(params: {
  repository?: WebChatSessionConversationRepository;
  libraryID: number;
  paperItemID: number;
  findExistingSessionKey?: (
    libraryID: number,
    paperItemID: number,
  ) => Promise<number | null>;
}): Promise<WebChatSessionConversationResult | null> {
  const libraryID = normalizePositiveInt(params.libraryID);
  const paperItemID = normalizePositiveInt(params.paperItemID);
  if (!libraryID || !paperItemID) return null;
  const inFlightKey = `${libraryID}:${paperItemID}`;
  const inFlight = inFlightResolutions.get(inFlightKey);
  if (inFlight) return inFlight;
  const resolution = resolveWebChatSessionConversationUncoalesced({
    ...params,
    libraryID,
    paperItemID,
  });
  inFlightResolutions.set(inFlightKey, resolution);
  try {
    return await resolution;
  } finally {
    inFlightResolutions.delete(inFlightKey);
  }
}

async function resolveWebChatSessionConversationUncoalesced(params: {
  repository?: WebChatSessionConversationRepository;
  libraryID: number;
  paperItemID: number;
  findExistingSessionKey?: (
    libraryID: number,
    paperItemID: number,
  ) => Promise<number | null>;
}): Promise<WebChatSessionConversationResult | null> {
  const repository = params.repository || conversationRepository;
  const findExistingSessionKey =
    params.findExistingSessionKey || findWebchatSessionPaperConversationKey;
  const { libraryID, paperItemID } = params;

  try {
    const existingKey = normalizePositiveInt(
      await findExistingSessionKey(libraryID, paperItemID),
    );
    if (existingKey) {
      const existing = await repository.getCatalogEntry({
        system: "upstream",
        kind: "paper",
        conversationKey: existingKey,
      });
      if (
        existing &&
        normalizePositiveInt(existing.paperItemID) === paperItemID &&
        normalizePositiveInt(existing.libraryID) === libraryID
      ) {
        return {
          conversationKey: existingKey,
          sessionVersion: existing.sessionVersion,
          reused: true,
        };
      }
    }
  } catch (err) {
    try {
      ztoolkit?.log?.("LLM: Failed to reuse webchat session conversation", err);
    } catch (_error) {
      void _error;
    }
  }

  const created = await repository.createCatalogEntry({
    system: "upstream",
    kind: "paper",
    libraryID,
    paperItemID,
    webchatSession: true,
  });
  const createdKey = normalizePositiveInt(created?.conversationKey);
  if (!createdKey) return null;
  return {
    conversationKey: createdKey,
    sessionVersion: created?.sessionVersion,
    reused: false,
  };
}
